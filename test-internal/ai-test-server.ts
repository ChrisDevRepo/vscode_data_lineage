/**
 * HTTP test bridge — exposes all 12 AI tools over HTTP for external testing.
 * Claude Code (or any HTTP client) can act as the AI agent, calling tools
 * and making decisions instead of VS Code Copilot Chat.
 *
 * Usage:
 *   npx tsx test-internal/ai-test-server.ts [dacpac-path] [--port=3271] [--verbose]
 *
 * Flags:
 *   --port=N    Listen port (default: 3271)
 *   --verbose   Show debug-level SM logs (column validation, guard decisions, prune cascades)
 *               Default: only info + warn shown (hop progress, verdicts, errors)
 *   DEBUG=sm    Env-var alternative to --verbose
 *
 * Console log format:
 *   [tool] lineage_xxx (session=s_abc123)  | origin=... | focus=...
 *     [s_abc123][tool_short] SM message at info/warn level
 *     → Xms  outcome summary (scope, hop, chain, INLINE, ERROR)
 *
 * Defaults:
 *   dacpac: test/AdventureWorks.dacpac
 *   port:   3271
 *   host:   127.0.0.1 (localhost only)
 *
 * Endpoints:
 *   GET  /health              → { status, model: { nodes, edges, schemas } }
 *   GET  /tools               → array of 12 tool names
 *   GET  /prompts[?sessionId] → { system, ct_mode_columns, ct_mode_deps, bb_mode, tool_descriptions }
 *                               system includes schema context if session has active filter
 *                               ct_mode_columns = Type 3 (with columns), ct_mode_deps = Type 2 (no columns)
 *   POST /tool                → { tool, input, sessionId? } → { result, _meta }
 *   POST /session             → { sessionId }
 *   POST /filter              → { sessionId?, schemas[], types[] }
 *   DELETE /session/:id       → { deleted: true }
 *
 * Deletable: remove this file + test-internal/dispatcher.ts. No src/ modifications needed.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { extractDacpac } from '../src/engine/dacpacExtractor.js';
import { loadRules } from '../src/engine/sqlBodyParser.js';
import type { ParseRulesConfig } from '../src/engine/sqlBodyParser.js';
import type { DatabaseModel } from '../src/engine/types.js';
import { ColumnStore } from '../src/engine/columnStore.js';
import { populateColumnStore } from '../src/engine/modelBuilder.js';
import { buildBareGraph } from '../src/ai/graphUtils.js';
import { dispatchTool } from './dispatcher.js';
import { buildSystemPromptBase } from '../src/ai/prompts.js';
import { buildCtPrompt, buildCtDepPrompt, buildBbPrompt } from '../src/ai/smPrompts.js';
import type { ColumnTraceState } from '../src/ai/columnTraceState.js';
import type { BlackboardState } from '../src/ai/blackboardState.js';
import type { SerializedFilterState } from '../src/engine/projectStore.js';
import type Graph from 'graphology';

// ─── Prompt helpers ─────────────────────────────────────────────────────────

const TEMPLATE_KEYS = ['summary', 'title', 'intro', 'closing', 'description', 'sections', 'highlights', 'notes'] as const;
type TemplateKey = typeof TEMPLATE_KEYS[number];

/** Mirrors extension.ts system prompt assembly: schema context + base rules + aiOutputTemplates. */
function buildBridgeSystemPrompt(filter: SerializedFilterState | null, templates: Record<TemplateKey, string>): string {
  const schemaCtx = (filter?.schemas?.length ?? 0) > 0
    ? `Working context: user has schema(s) [${filter!.schemas.join(', ')}] selected.\n` +
      `Default all searches, SQL generation, and analysis to these schemas.\n` +
      `If answering the question requires objects from other schemas, ask the user first.\n\n`
    : '';
  return (
    schemaCtx +
    buildSystemPromptBase(25) +
    `   summary: ${templates.summary}\n` +
    `   sections: ${templates.sections}\n` +
    `   notes: ${templates.notes}\n` +
    `   highlights: ${templates.highlights}\n` +
    `   description (fallback): ${templates.description}`
  );
}

// ─── Logging ────────────────────────────────────────────────────────────────

/** Show SM-internal logs? Set --verbose flag or DEBUG=sm env var. */
const VERBOSE = process.argv.includes('--verbose') || process.env['DEBUG'] === 'sm';

/**
 * Creates a LogFn for a specific session/tool call.
 * info + warn always shown. debug shown only with --verbose.
 * trace always suppressed (too noisy).
 */
function makeSessionLog(sessionId: string, toolName: string) {
  const prefix = `[${sessionId.slice(0, 12)}][${toolName.replace('lineage_', '')}]`;
  return (level: 'info' | 'debug' | 'warn' | 'trace', msg: string) => {
    if (level === 'trace') return;
    if (level === 'debug' && !VERBOSE) return;
    const tag = level === 'warn' ? `${prefix}[WARN]` : prefix;
    console.log(`  ${tag} ${msg}`);
  };
}

/** Concise input summary for console — avoids printing full DDL or long strings. */
function abbreviateInput(tool: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  if (input.origin)       parts.push(`origin=${input.origin}`);
  if (input.query)        parts.push(`query="${input.query}"`);
  if (input.id)           parts.push(`id=${input.id}`);
  if (input.pattern)      parts.push(`pattern="${input.pattern}"`);
  if (input.type)         parts.push(`type=${input.type}`);
  const QUESTION_PREVIEW_LEN = 60;
  if (input.question)     parts.push(`question="${String(input.question).slice(0, QUESTION_PREVIEW_LEN)}"`);
  if (input.focus_node_id) parts.push(`focus=${input.focus_node_id}`);
  if (Array.isArray(input.columns) && input.columns.length)
    parts.push(`columns=[${(input.columns as string[]).join(', ')}]`);
  if (input.direction)    parts.push(`dir=${input.direction}`);
  if (Array.isArray(input.verdicts))
    parts.push(`verdicts=${input.verdicts.length}`);
  if (Array.isArray(input.ids))
    parts.push(`ids=${input.ids.length}`);
  return parts.length ? ` | ${parts.join(' | ')}` : '';
}

/** Concise result summary — error or key numeric/status fields. */
function abbreviateResult(tool: string, result: Record<string, unknown>): string {
  if (!result || typeof result !== 'object') return '';
  const HINT_PREVIEW_LEN = 80;
  if (result['error']) return ` ERROR: ${result['error']}${result['hint'] ? ' — ' + String(result['hint']).slice(0, HINT_PREVIEW_LEN) : ''}`;

  const parts: string[] = [];
  // CT
  if (result['ok'] === true && result['scopeSize'] !== undefined)
    parts.push(`scope=${result['scopeSize']}`);
  if (result['hop'] !== undefined)
    parts.push(`hop=${result['hop']} frontier=${result['frontier_remaining'] ?? '?'}`);
  if (result['trace_status'] === 'in_progress')
    parts.push(`neighbors=${(result['neighbors'] as unknown[] | undefined)?.length ?? '?'}`);
  if (result['status'] === 'complete' && result['stats'])
    parts.push(`DONE hops=${(result['stats'] as Record<string, unknown>)['hops']} chain=${(result['chain'] as unknown[] | undefined)?.length ?? '?'}`);
  // BB
  if (result['bb_mode'])
    parts.push(`focus=${(result['focus_node'] as Record<string, unknown> | undefined)?.['id'] ?? '?'} agenda=${result['agenda_remaining'] ?? '?'}`);
  if (result['status'] === 'inline')
    parts.push(`INLINE scope=${result['scope_size']}`);
  // classic
  if (result['results'] && Array.isArray(result['results']))
    parts.push(`hits=${result['results'].length}`);
  if (result['nodes'] && Array.isArray(result['nodes']))
    parts.push(`nodes=${result['nodes'].length} edges=${(result['edges'] as unknown[] | undefined)?.length ?? '?'}`);
  if (result['success'] === false && result['errors'])
    parts.push(`INVALID ${(result['errors'] as string[]).join('; ').slice(0, 100)}`);
  if (result['success'] === true)
    parts.push(`OK`);

  return parts.length ? ` ${parts.join(' | ')}` : '';
}

// ─── CLI args ───────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let dacpacPath = resolve(ROOT, 'test/AdventureWorks.dacpac');
let port = 3271;

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--port=')) {
    port = parseInt(arg.slice(7), 10);
  } else if (!arg.startsWith('--')) {
    dacpacPath = resolve(arg);
  }
}

// ─── Session management ─────────────────────────────────────────────────────

interface Session {
  id: string;
  columnTraceState: { current: ColumnTraceState | null };
  blackboardState: { current: BlackboardState | null };
  filter: SerializedFilterState | null;
  lastAccess: number;
  timeout: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function createSession(id: string): Session {
  const session: Session = {
    id,
    columnTraceState: { current: null },
    blackboardState: { current: null },
    filter: null,
    lastAccess: Date.now(),
    timeout: setTimeout(() => destroySession(id), SESSION_TTL_MS),
  };
  sessions.set(id, session);
  console.log(`[session] created: ${id}`);
  return session;
}

function destroySession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  clearTimeout(s.timeout);
  sessions.delete(id);
  console.log(`[session] destroyed: ${id}`);
  return true;
}

function touchSession(s: Session): void {
  s.lastAccess = Date.now();
  clearTimeout(s.timeout);
  s.timeout = setTimeout(() => destroySession(s.id), SESSION_TTL_MS);
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

// ─── Startup ────────────────────────────────────────────────────────────────

async function main() {
  // 1. Load parse rules
  const rulesYaml = readFileSync(resolve(ROOT, 'assets/defaultParseRules.yaml'), 'utf-8');
  loadRules(yaml.load(rulesYaml) as ParseRulesConfig);

  // 2. Extract dacpac
  if (!existsSync(dacpacPath)) {
    console.error(`Dacpac not found: ${dacpacPath}`);
    process.exit(1);
  }
  console.log(`Loading dacpac: ${dacpacPath}`);
  const t0 = Date.now();
  const buffer = readFileSync(dacpacPath);
  const model: DatabaseModel = await extractDacpac(buffer.buffer as ArrayBuffer);

  // 3. Build graph
  const graph: Graph = buildBareGraph(model);

  // 4. Populate column store
  const columnStore = new ColumnStore();
  populateColumnStore(model, columnStore);

  const loadMs = Date.now() - t0;
  const schemas = model.schemas.map(s => s.name).join(', ');
  console.log(`Model loaded in ${loadMs}ms: ${model.nodes.length} nodes, ${model.edges.length} edges, schemas: [${schemas}]`);

  // 5. Load tool descriptions from package.json (single source of truth)
  const pkgJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as {
    contributes: { languageModelTools: Array<{ name: string; modelDescription?: string }> }
  };
  const TOOL_DEFS: Record<string, string> = Object.fromEntries(
    pkgJson.contributes.languageModelTools
      .filter(t => t.name.startsWith('lineage_') && t.modelDescription)
      .map(t => [t.name, t.modelDescription as string])
  );
  const TOOL_NAMES = [
    ...Object.keys(TOOL_DEFS),
    'lineage_submit_batch_hop',       // inline batch CT
    'lineage_submit_batch_findings',  // inline batch BB
  ];

  // 6. Load AI output templates — same YAML + extraction logic as extension.ts loadAiOutputTemplates()
  const rawTemplates = yaml.load(
    readFileSync(resolve(ROOT, 'assets/aiOutputTemplates.yaml'), 'utf-8')
  ) as Record<string, { instruction?: string }>;
  const loadedTemplates: Record<TemplateKey, string> = {} as Record<TemplateKey, string>;
  for (const key of TEMPLATE_KEYS) {
    loadedTemplates[key] = rawTemplates?.[key]?.instruction?.trim() ?? '';
  }

  // 7. Create default session
  createSession('default');

  // 8. Route handler
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    try {
      // GET /health
      if (method === 'GET' && url === '/health') {
        return respond(res, 200, {
          status: 'ok',
          model: {
            nodes: model.nodes.length,
            edges: model.edges.length,
            schemas: model.schemas.length,
            schemaNames: model.schemas.map(s => s.name),
          },
          sessions: sessions.size,
          dacpac: dacpacPath,
        });
      }

      // GET /tools
      if (method === 'GET' && url === '/tools') {
        return respond(res, 200, { tools: TOOL_NAMES });
      }

      // GET /prompts — system + mode prompts + tool descriptions
      // ?sessionId=xxx injects that session's active filter into schema context (default: 'default')
      // ct_mode_columns = CT_MODE_PROMPT (Type 3, with columns)
      // ct_mode_deps    = CT_DEP_MODE_PROMPT (Type 2, dependency only, no columns)
      if (method === 'GET' && url.startsWith('/prompts')) {
        const qsId = url.includes('?')
          ? new URLSearchParams(url.split('?')[1]).get('sessionId') ?? 'default'
          : 'default';
        const promptSession = sessions.get(qsId);
        return respond(res, 200, {
          system: buildBridgeSystemPrompt(promptSession?.filter ?? null, loadedTemplates),
          ct_mode_columns: buildCtPrompt(),
          ct_mode_deps: buildCtDepPrompt(),
          bb_mode: buildBbPrompt(),
          tool_descriptions: TOOL_DEFS,
        });
      }

      // POST /session
      if (method === 'POST' && url === '/session') {
        const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        createSession(id);
        return respond(res, 201, { sessionId: id });
      }

      // DELETE /session/:id
      if (method === 'DELETE' && url.startsWith('/session/')) {
        const id = decodeURIComponent(url.slice('/session/'.length));
        const deleted = destroySession(id);
        return respond(res, deleted ? 200 : 404, { deleted });
      }

      // POST /filter — set session-level user filter (simulates VS Code schema/type filter)
      if (method === 'POST' && url === '/filter') {
        const body = await readBody(req);
        const { sessionId = 'default', schemas, types } = JSON.parse(body) as {
          sessionId?: string; schemas?: string[]; types?: string[];
        };
        let session = sessions.get(sessionId);
        if (!session) session = createSession(sessionId);
        session.filter = {
          schemas: schemas ?? [],
          types: types ?? [],
          searchTerm: '',
          hideIsolated: false,
          focusSchemas: [],
          showExternalRefs: false,
          externalRefTypes: [],
        };
        console.log(`[filter] session=${sessionId} schemas=[${session.filter.schemas.join(', ')}] types=[${session.filter.types.join(', ')}]`);
        return respond(res, 200, { sessionId, filter: session.filter });
      }

      // POST /tool — core dispatch
      if (method === 'POST' && url === '/tool') {
        const body = await readBody(req);
        let parsed: { tool?: string; input?: Record<string, unknown>; sessionId?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          return respond(res, 400, { error: 'invalid_json', hint: 'Body must be valid JSON.' });
        }

        const { tool, input = {}, sessionId = 'default' } = parsed;
        if (!tool || typeof tool !== 'string') {
          return respond(res, 400, { error: 'missing_tool', hint: 'Body must include "tool" (string).' });
        }
        if (!TOOL_NAMES.includes(tool)) {
          return respond(res, 400, { error: 'unknown_tool', tool, hint: `Valid tools: ${TOOL_NAMES.join(', ')}` });
        }

        // Resolve or auto-create session
        let session = sessions.get(sessionId);
        if (!session) {
          session = createSession(sessionId);
        }
        touchSession(session);

        // Log tool input (abbreviated) — SM tools show more detail, stateless tools show key fields
        const inputPreview = abbreviateInput(tool, input);
        console.log(`[tool] ${tool} (session=${sessionId.slice(0, 12)})${inputPreview}`);

        // Dispatch — pass SM logger so internal hop/verdict/guard decisions appear in console
        const smLog = makeSessionLog(sessionId, tool);
        const t1 = Date.now();
        const resultJson = dispatchTool(
          tool,
          input,
          model,
          graph,
          session.columnTraceState,
          columnStore,
          session.blackboardState,
          session.filter,
          smLog,
        );
        const durationMs = Date.now() - t1;

        let result: unknown;
        try {
          result = JSON.parse(resultJson);
        } catch {
          result = resultJson;
        }

        // Log result summary (error or key outcome fields)
        const resultPreview = abbreviateResult(tool, result as Record<string, unknown>);
        console.log(`  → ${durationMs}ms${resultPreview}`);
        return respond(res, 200, {
          result,
          _meta: { tool, sessionId, durationMs },
        });
      }

      // 404
      respond(res, 404, { error: 'not_found', hint: 'Endpoints: GET /health, GET /tools, GET /prompts, POST /tool, POST /session, POST /filter, DELETE /session/:id' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[error] ${method} ${url}: ${msg}`);
      respond(res, 500, { error: 'internal_error', message: msg });
    }
  });

  // 9. Listen
  server.listen(port, '127.0.0.1', () => {
    console.log(`\nAI Test Bridge ready at http://127.0.0.1:${port}`);
    console.log(`  GET  /health   — model stats`);
    console.log(`  GET  /tools    — list tool names`);
    console.log(`  GET  /prompts  — system (with schema ctx) + ct_mode_columns/ct_mode_deps/bb_mode`);
    console.log(`  POST /tool     — { tool, input, sessionId? }`);
    console.log(`  POST /session  — create new session`);
    console.log(`  Ctrl+C to stop\n`);
  });
}

main().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
