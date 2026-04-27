/**
 * Tool Proxy — lightweight HTTP bridge running inside the VS Code extension host.
 *
 * Replaces the 462-line ai-test-server.ts + 355-line dispatcher.ts with a thin
 * pass-through to vscode.lm.invokeTool(). Same endpoint API — Claude Code agents
 * call it the same way. Zero tool routing logic.
 *
 * Endpoints:
 *   GET  /health              → model stats from session
 *   GET  /tools               → list registered lineage tool names
 *   GET  /prompts[?sessionId] → system + mode prompts + tool descriptions
 *   POST /tool                → { tool, input, sessionId? } → vscode.lm.invokeTool()
 *   POST /session             → create/reset session → { sessionId }
 *   POST /filter              → { schemas[], types[] } → set filter on session
 *   POST /gate                → { sessionId, approved } → harness equivalent of the
 *                                user typing "yes"/"no" in chat. Calls the REAL
 *                                sess.enterExploring() (approve) — same method
 *                                lineageParticipant.ts runs on user yes-reply.
 *   GET  /session/:id/state   → sess.stateMachine.toJSON() (100% SM data)
 *   DELETE /session/:id       → cleanup
 */

import * as vscode from 'vscode';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { AiSession } from '../../../../src/ai/session';
import { buildGeneralSystemPrompt } from '../../../../src/ai/prompts';
import { buildModeBlock } from '../../../../src/ai/smPrompts';
import { PendingGateSchema } from '../../../../src/ai/sessionPhase';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolProxyConfig {
  getSession: () => AiSession;
  port?: number;
}

export interface ToolProxyHandle {
  port: number;
  close: () => Promise<void>;
}

// ─── HTTP utilities ─────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: object): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

// ─── Tool proxy ─────────────────────────────────────────────────────────────

export function startToolProxy(config: ToolProxyConfig): Promise<ToolProxyHandle> {
  const { getSession, port = 3271 } = config;

  // Proxy-level call log — captures timing + token stats that sess.hopLog doesn't have
  const proxyLog: Array<{
    tool: string;
    input: any;
    output: any;
    timestamp: string;
    _meta: {
      durationMs: number;
      inputBytes: number;
      outputBytes: number;
      inputTokens: number;
      outputTokens: number;
      isError: boolean;
      errorType: string | null;
      errorMessage: string | null;
    };
  }> = [];

  // Phase A5 — gate audit: every gate envelope emitted by start_exploration is
  // captured here so extract.py can write `<test-id>.gate.md`. Cleared on
  // POST /session (handled below).
  let gateLog: Array<{ ts: string; type: string; detail: unknown; emit: string | null }> = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
      // GET /health
      if (method === 'GET' && url === '/health') {
        const sess = getSession();
        const m = sess.model;
        return respond(res, 200, {
          status: m ? 'ok' : 'no_model',
          model: m ? {
            nodes: m.nodes.length,
            edges: m.edges.length,
            schemas: m.schemas.length,
            schemaNames: m.schemas.map(s => s.name),
          } : null,
          project: sess.projectName,
        });
      }

      // GET /tools — list registered lineage tools (incl. presentation-tagged)
      if (method === 'GET' && url === '/tools') {
        const tools = vscode.lm.tools
          .filter(t => t.tags.includes('lineage') || t.tags.includes('lineage-presentation'))
          .map(t => t.name);
        return respond(res, 200, { tools });
      }

      // GET /prompts — system + mode prompts + tool descriptions
      if (method === 'GET' && url.startsWith('/prompts')) {
        const sess = getSession();
        const m = sess.model;
        const dbPlatform = m?.dbPlatform || 'SQL Server';
        const filterSchemas = sess.filter?.schemas ?? [];
        const totalSchemaCount = m?.schemas.length ?? 0;
        const totalNodes = m?.nodes.length ?? 0;
        const visibleNodes = filterSchemas.length > 0 && m
          ? m.nodes.filter(n => (filterSchemas as string[]).includes(n.schema)).length
          : totalNodes;
        // Eval agents drive the active exploration phase — the harness never
        // sees discovery or synthesis. The phase label in the system prompt
        // mirrors what production injects via buildStageSystemPrompt('active').
        const system = buildGeneralSystemPrompt(
          'active', dbPlatform, filterSchemas, totalSchemaCount, visibleNodes, totalNodes,
        );

        // Tool descriptions + inputSchema from registered tools. Real VS Code chat
        // sees both because `vscode.lm.registerTool` registers the schema with
        // the LM. Eval agents only see what we deliver via this endpoint, so
        // without inputSchema they have to guess parameter names (observed:
        // Haiku guessed `nodeId` instead of `origin`, causing every
        // start_exploration to crash on `params.origin.toLowerCase()`).
        const toolDescs: Record<string, { description: string; inputSchema?: unknown }> = {};
        for (const t of vscode.lm.tools) {
          const isLineage = t.tags.includes('lineage') || t.tags.includes('lineage-presentation');
          if (isLineage && t.description) {
            toolDescs[t.name] = {
              description: t.description,
              ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
            };
          }
        }

        return respond(res, 200, {
          system,
          ct_mode_columns: buildModeBlock(false, ['SAMPLE_COL']),
          bb_mode: buildModeBlock(false),
          tool_descriptions: toolDescs,
        });
      }

      // POST /session — reset session for new test
      if (method === 'POST' && url === '/session') {
        const sess = getSession();
        sess.resetExploration();
        sess.hopLog = [];
        proxyLog.length = 0; // reset proxy-level timing log
        gateLog = []; // Phase A5 — gate audit log resets per session
        sess.regenerateSessionId();
        return respond(res, 201, { sessionId: sess.id });
      }

      // POST /filter — set schema/type filter
      if (method === 'POST' && url === '/filter') {
        const body = await readBody(req);
        const { schemas, types } = JSON.parse(body) as {
          schemas?: string[]; types?: string[];
        };
        const sess = getSession();
        sess.filter = {
          schemas: schemas ?? [],
          types: types ?? [],
          searchTerm: '',
          hideIsolated: false,
          focusSchemas: [],
          showExternalRefs: false,
          externalRefTypes: [],
          exclusionPatterns: [],
        };
        console.log(`[proxy:filter] schemas=[${sess.filter.schemas.join(', ')}]`);
        return respond(res, 200, { sessionId: sess.id, filter: sess.filter });
      }

      // POST /gate — resolve action_required{gate:'confirm_sm_start'}.
      // Harness equivalent of the user typing "yes"/"no" in chat; mirrors
      // lineageParticipant.ts:248-270 exactly — same enterExploring() call on
      // the real AiSession. "no" leaves phase=awaiting_gate (matches the
      // production "paused" branch); the agent can still redirect via a new
      // question which would reset the session.
      if (method === 'POST' && url === '/gate') {
        const body = await readBody(req);
        let parsed: { sessionId?: string; approved?: boolean };
        try {
          parsed = JSON.parse(body);
        } catch {
          return respond(res, 400, { error: 'invalid_json', hint: 'Body must be {sessionId, approved}.' });
        }
        const { approved } = parsed;
        if (typeof approved !== 'boolean') {
          return respond(res, 400, { error: 'missing_approved', hint: 'Body must include "approved" (boolean).' });
        }
        const sess = getSession();
        if (sess.phase.kind !== 'awaiting_gate') {
          return respond(res, 409, {
            error: 'no_pending_gate',
            phase: sess.phase.kind,
            hint: '/gate only applies when the session is awaiting_gate (start_exploration returned action_required).',
          });
        }
        if (approved) {
          sess.enterExploring();
          console.log(`[proxy:gate] session=${sess.id.slice(0, 12)} approved=true → phase=exploring`);
        } else {
          console.log(`[proxy:gate] session=${sess.id.slice(0, 12)} approved=false → phase=awaiting_gate (paused)`);
        }
        return respond(res, 200, { ok: true, phase: sess.phase.kind });
      }

      // Phase A5 — GET /session/:id/gates — gate audit log for the session.
      // extract.py renders these into <test-id>.gate.md.
      if (method === 'GET' && url.startsWith('/session/') && url.endsWith('/gates')) {
        return respond(res, 200, { gates: gateLog });
      }

      // Phase A6 — GET /session/:id/perf — proxy-level performance summary
      // synthesized from proxyLog. Mirrors src/ai/diagnostics.PerformanceDiagnostics
      // shape without needing to call PerformanceCollector.finalize() (which is
      // destructive: it logs the summary line). Read-only view for extract.py.
      if (method === 'GET' && url.startsWith('/session/') && url.endsWith('/perf')) {
        const sess = getSession();
        const totalRounds = proxyLog.length;
        const totalLatency = proxyLog.reduce((s, e) => s + e._meta.durationMs, 0);
        const totalIn = proxyLog.reduce((s, e) => s + e._meta.inputTokens, 0);
        const totalOut = proxyLog.reduce((s, e) => s + e._meta.outputTokens, 0);
        const errorCount = proxyLog.filter(e => e._meta.isError).length;
        return respond(res, 200, {
          summary: {
            model: sess.modelName || 'unknown',
            mode: sess.stateMachine ? (sess.stateMachine.columnAspect ? 'column_trace' : 'blackboard') : 'idle',
            totalRounds,
            totalLatencyMs: totalLatency,
            totalTokensIn: totalIn,
            totalTokensOut: totalOut,
            errorCount,
          },
          rounds: proxyLog.map((e, i) => ({
            round: i + 1,
            tool: e.tool,
            tokensIn: e._meta.inputTokens,
            tokensOut: e._meta.outputTokens,
            latencyMs: e._meta.durationMs,
            isError: e._meta.isError,
            errorType: e._meta.errorType,
          })),
        });
      }

      // GET /session/:id/state — full SM state dump (100% data from RAM)
      if (method === 'GET' && url.startsWith('/session/') && url.endsWith('/state')) {
        const sess = getSession();
        const sm = sess.stateMachine;
        const m = sess.model;
        // Expose project + filter alongside SM so eval reports can render
        // "Test case" header (source dacpac, schema/type filter) without an
        // extra round-trip to /health and without re-reading agent.json.
        return respond(res, 200, {
          sm_state: sm ? sm.toJSON() : null,
          hop_log: proxyLog, // proxy-level log has timing + token stats
          session_hop_log: sess.hopLog, // extension's log (no timing)
          result_graph: sess.resultGraph,
          project: sess.projectName,
          filter: sess.filter ? {
            schemas: sess.filter.schemas ?? [],
            types: sess.filter.types ?? [],
          } : null,
          model_summary: m ? { nodes: m.nodes.length, edges: m.edges.length, schemas: m.schemas.length } : null,
          gates: gateLog, // Phase A5 — fallback for clients not using /gates
          session_phase: sess.phase.kind, // Phase A5b — sess.phase.kind is the canonical phase string;
                                            // sm.toJSON() omits it (returns SM internals only).
                                            // Without this, eval clients had to infer phase from `gates` array.
        });
      }

      // DELETE /session/:id — cleanup
      if (method === 'DELETE' && url.startsWith('/session/')) {
        const sess = getSession();
        sess.resetExploration();
        sess.hopLog = [];
        return respond(res, 200, { deleted: true });
      }

      // POST /shutdown — graceful exit (writes signal file then exits)
      if (method === 'POST' && url === '/shutdown') {
        respond(res, 200, { shutting_down: true });
        setTimeout(() => {
          const signalDir = process.env.EVAL_SIGNAL_DIR;
          if (signalDir) {
            try {
              const signalFile = require('path').join(signalDir, 'eval-done.signal');
              require('fs').writeFileSync(signalFile, 'shutdown requested');
              console.log('[proxy] Shutdown signal written:', signalFile);
            } catch (err) {
              console.error('[proxy] Failed to write signal:', err);
            }
          }
        }, 100);
        return;
      }

      // POST /tool — THE CORE: pass-through to vscode.lm.invokeTool()
      if (method === 'POST' && url === '/tool') {
        const body = await readBody(req);
        const inputBytes = Buffer.byteLength(body, 'utf8');
        let parsed: { tool?: string; input?: Record<string, unknown>; sessionId?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          return respond(res, 400, { error: 'invalid_json' });
        }

        const { tool, input = {} } = parsed;
        if (!tool || typeof tool !== 'string') {
          return respond(res, 400, { error: 'missing_tool' });
        }

        // Verify tool exists
        const registered = vscode.lm.tools.find(t => t.name === tool);
        if (!registered) {
          return respond(res, 400, {
            error: 'unknown_tool',
            tool,
            hint: `Valid tools: ${vscode.lm.tools.filter(t => t.tags.includes('lineage') || t.tags.includes('lineage-presentation')).map(t => t.name).join(', ')}`,
          });
        }

        const t0 = Date.now();
        console.log(`[proxy:tool] ${tool}`);

        // THE ENTIRE TOOL ROUTING — one line, zero duplication
        const result = await vscode.lm.invokeTool(tool, {
          input,
          toolInvocationToken: undefined as any,
        }, new vscode.CancellationTokenSource().token);

        const durationMs = Date.now() - t0;
        const text = (result.content[0] as vscode.LanguageModelTextPart).value;
        const outputBytes = Buffer.byteLength(text, 'utf8');

        let resultObj: unknown;
        try {
          resultObj = JSON.parse(text);
        } catch {
          resultObj = text;
        }

        // Token estimation (4 chars ~ 1 token, rough but consistent)
        const inputTokens = Math.ceil(inputBytes / 4);
        const outputTokens = Math.ceil(outputBytes / 4);

        // Detect rejections (tool returned error)
        const isError = typeof resultObj === 'object' && resultObj !== null &&
          ('error' in resultObj || ((resultObj as any).success === false));
        const errorType = isError ? ((resultObj as any).error || 'tool_error_other') : null;
        // Phase A4 — preserve the full error message body. Prior code kept only
        // the enum tag (errorType); the human-readable detail (e.g. validation
        // hint, failing field, suggested fix) was discarded. Now both flow
        // through to extract.py's errors-detailed.json artifact.
        let errorMessage: string | null = null;
        if (isError) {
          if (typeof resultObj === 'object' && resultObj !== null) {
            const ro = resultObj as any;
            errorMessage = ro.message ?? ro.hint ?? ro.detail ?? ro.reason ?? null;
            if (!errorMessage) {
              try { errorMessage = JSON.stringify(resultObj); } catch { errorMessage = String(resultObj); }
            }
          } else if (typeof resultObj === 'string') {
            errorMessage = resultObj;
          }
        }

        // Phase transition for action_required envelopes. Production `lineageParticipant.ts`
        // calls `sess.enterGate()` after the hop-loop surfaces a `gate` exit; the eval proxy
        // bypasses that layer, so we mirror the transition here. Without this, a subsequent
        // POST /gate would see `phase: idle` and reject. The gate envelope is parsed by the
        // same Zod schema the participant uses — any structural drift fails fast.
        if (errorType === 'action_required' && (resultObj as any).gate) {
          const parsed = PendingGateSchema.safeParse(resultObj);
          if (parsed.success) {
            getSession().enterGate(parsed.data);
            console.log(`[proxy:tool] ${tool} emitted gate=${parsed.data.gate} → phase=awaiting_gate`);
            // Phase A5 — capture the gate envelope for the audit log so
            // extract.py can render it into <test-id>.gate.md.
            gateLog.push({
              ts: new Date().toISOString(),
              type: parsed.data.gate,
              detail: (parsed.data as any).detail ?? (resultObj as any).detail ?? null,
              emit: (parsed.data as any).emit ?? (resultObj as any).emit ?? null,
            });
          }
        }

        console.log(`[proxy:tool] ${tool} → ${durationMs}ms, in=${inputBytes}b/~${inputTokens}t, out=${outputBytes}b/~${outputTokens}t${isError ? ` ERROR=${errorType}` : ''}`);

        // Push to proxy-level log for state endpoint
        const meta = { durationMs, inputBytes, outputBytes, inputTokens, outputTokens, isError, errorType, errorMessage };
        const toolShortName = tool.replace(/^lineage_/, '');
        proxyLog.push({
          tool: toolShortName,
          input,
          output: resultObj,
          timestamp: new Date().toISOString(),
          _meta: meta,
        });

        return respond(res, 200, {
          result: resultObj,
          _meta: { tool, ...meta },
        });
      }

      // 404
      respond(res, 404, { error: 'not_found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[proxy:error] ${method} ${url}: ${msg}`);
      respond(res, 500, { error: 'internal_error', message: msg });
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[proxy] Tool proxy ready at http://127.0.0.1:${port}`);
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}
