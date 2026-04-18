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
 *   GET  /session/:id/state   → sess.stateMachine.toJSON() (100% SM data)
 *   DELETE /session/:id       → cleanup
 */

import * as vscode from 'vscode';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { AiSession } from '../../../../src/ai/session';
import { buildSystemPromptBase } from '../../../../src/ai/prompts';
import { buildNavigationPrompt } from '../../../../src/ai/smPrompts';

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
    };
  }> = [];

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

      // GET /tools — list registered lineage tools
      if (method === 'GET' && url === '/tools') {
        const tools = vscode.lm.tools
          .filter(t => t.tags.includes('lineage'))
          .map(t => t.name);
        return respond(res, 200, { tools });
      }

      // GET /prompts — system + mode prompts + tool descriptions
      if (method === 'GET' && url.startsWith('/prompts')) {
        const sess = getSession();
        const schemaCtx = (sess.filter?.schemas?.length ?? 0) > 0
          ? `Working context: user has schema(s) [${sess.filter!.schemas.join(', ')}] selected.\n` +
            `Default all searches, SQL generation, and analysis to these schemas.\n` +
            `If answering the question requires objects from other schemas, ask the user first.\n\n`
          : '';
        const tpl = sess.outputTemplates;
        const system = schemaCtx + buildSystemPromptBase(25) +
          `   summary: ${tpl.summary}\n` +
          `   sections: ${tpl.sections}\n` +
          `   notes: ${tpl.notes}\n` +
          `   highlights: ${tpl.highlights}\n` +
          `   description (fallback): ${tpl.description}`;

        // Tool descriptions from registered tools
        const toolDescs: Record<string, string> = {};
        for (const t of vscode.lm.tools) {
          if (t.tags.includes('lineage') && t.description) {
            toolDescs[t.name] = t.description;
          }
        }

        return respond(res, 200, {
          system,
          ct_mode_columns: buildNavigationPrompt('column_trace'),
          bb_mode: buildNavigationPrompt('blackboard'),
          tool_descriptions: toolDescs,
        });
      }

      // POST /session — reset session for new test
      if (method === 'POST' && url === '/session') {
        const sess = getSession();
        sess.resetExploration();
        sess.hopLog = [];
        proxyLog.length = 0; // reset proxy-level timing log
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

      // GET /session/:id/state — full SM state dump (100% data from RAM)
      if (method === 'GET' && url.startsWith('/session/') && url.endsWith('/state')) {
        const sess = getSession();
        const sm = sess.stateMachine;
        // For classic-only tests (no SM), return what we have (empty SM state is OK)
        return respond(res, 200, {
          sm_state: sm ? sm.toJSON() : null,
          hop_log: proxyLog, // proxy-level log has timing + token stats
          session_hop_log: sess.hopLog, // extension's log (no timing)
          result_graph: sess.resultGraph,
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
            hint: `Valid tools: ${vscode.lm.tools.filter(t => t.tags.includes('lineage')).map(t => t.name).join(', ')}`,
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

        console.log(`[proxy:tool] ${tool} → ${durationMs}ms, in=${inputBytes}b/~${inputTokens}t, out=${outputBytes}b/~${outputTokens}t${isError ? ` ERROR=${errorType}` : ''}`);

        // Push to proxy-level log for state endpoint
        const meta = { durationMs, inputBytes, outputBytes, inputTokens, outputTokens, isError, errorType };
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
