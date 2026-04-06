/**
 * HTTP test bridge — exposes all 12 AI tools over HTTP for external testing.
 * Claude Code (or any HTTP client) can act as the AI agent, calling tools
 * and making decisions instead of VS Code Copilot Chat.
 *
 * Usage:
 *   npx tsx test-internal/ai-test-server.ts [dacpac-path] [--port=3271]
 *
 * Defaults:
 *   dacpac: test/AdventureWorks.dacpac
 *   port:   3271
 *   host:   127.0.0.1 (localhost only)
 *
 * Endpoints:
 *   GET  /health              → { status, model: { nodes, edges, schemas } }
 *   GET  /tools               → array of 12 tool names
 *   POST /tool                → { tool, input, sessionId? } → { result, _meta }
 *   POST /session             → { sessionId }
 *   DELETE /session/:id       → { deleted: true }
 *
 * Deletable: remove this single file to undo. No src/ modifications.
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
import { dispatchTool } from './chatLoopTestHarness.js';
import type { ColumnTraceState } from '../src/ai/columnTraceState.js';
import type { BlackboardState } from '../src/ai/blackboardState.js';
import type { SerializedFilterState } from '../src/engine/projectStore.js';
import type Graph from 'graphology';

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

// ─── Prompts (identical to VS Code Copilot Chat) ───────────────────────────

const SYSTEM_PROMPT =
  'SQL lineage data provider. Answer ONLY from loaded database model using provided tools.\n' +
  'Budget: 25 rounds.\n\n' +
  'RULES:\n' +
  '1. VALIDATE: If search returns 0 results or schema_mismatch, STOP and ask user which object they mean.\n' +
  '   For all other decisions (DDL delivery, scope size, analysis approach): self-decide and proceed.\n' +
  '2. NEVER fabricate IDs. Only use IDs returned by tools.\n' +
  '3. For column questions: start_column_trace directly (it discovers scope internally). For other complex questions: search → BFS.\n' +
  '   When tracing columns: provide INPUT column names, not output. Track renames.\n' +
  '   Prefer trace over prune when uncertain.\n' +
  '   For broad exploration (business rules, documentation, patterns, investigations):\n' +
  '   use start_exploration to explore objects hop-by-hop with persistent memory.\n' +
  '4. OUTPUT: enrich_view when graph aids understanding (lineage path, data flow).\n' +
  '   Chat text otherwise (explain, SQL, list, compare). Default: text.\n' +
  '5. VIEW OUTPUT — fields form a layered hierarchy (headline → callouts → captions → article).\n' +
  '   Badges (5-8 key nodes) are numbered anchors. Notes caption each badged node.\n' +
  '   summary: One-line graph purpose (~120 chars, max 300). Shown in the info card.\n' +
  '   description: The detailed answer -- structured markdown with ## headings. Each heading covers one or more steps. Under each heading, explain business logic -- formulas, column mappings, WHY it matters. Supported: ## headings, **bold**, `code`, lists, | tables |, LaTeX ($inline$, ```math blocks). Not supported: mermaid, HTML, LaTeX \\begin environments.\n' +
  '   badges: Numbered navigation anchors on nodes you analyzed. Format: "1 Source", "3 FX Convert". Badge every node in your description. For large sets: group under shared step numbers.\n' +
  '   highlights: Glow 2-3 critical nodes only. Pick ONE scheme: Lineage (source/transform/target) or Diagnostic (good/warn/fail).\n' +
  '   notes: One-line caption under each step node. First line visible, rest on hover via \\n.';

const CT_MODE_PROMPT =
  'COLUMN TRACE MODE: For each hop, read the focus node DDL. ' +
  'Verdict each neighbor: trace (provide INPUT column names in the "columns" field — track renames), prune, or pass. ' +
  'Write notes about what you found. Prefer trace over prune when uncertain. ' +
  'If revisitable nodes are listed: use verdict "revisit" to re-expand a previously pruned branch (max 3 per trace). ' +
  'The sub_question field contains your own question from the previous hop — answer it.\n' +
  'FIELD MAPPING: focus_node_id = focus_node.id from the hop context. neighbor_id = id field from each neighbor.\n' +
  'COLUMN FIELD: use "columns" (not columns_to_trace) — array of INPUT column names to track into this neighbor.\n' +
  'COLUMN LINEAGE RULE: Read the SELECT expression that produces the target column in the DDL. ' +
  'Trace every column reference in that expression — formula operands, COALESCE options, CASE WHEN result values (THEN/ELSE), JOIN value columns. ' +
  'Prune columns that appear only in row-selection clauses (WHERE conditions, JOIN ON keys, HAVING filters) — they route which row is chosen, not what the value is. ' +
  'Multi-input formulas: trace ALL inputs — omitting one branch produces incomplete lineage. When uncertain whether a column computes the value or routes rows: trace.\n' +
  'TABLE NODES: When the focus node is a table (no DDL body), tables store data — they do not transform columns. ' +
  'Trace through ALL upstream neighbors (they INSERT INTO this table). Prune only downstream neighbors that SELECT from it.\n' +
  'VERDICT ALL NEIGHBORS: Submit a verdict for every neighbor — skipped neighbors are silently lost.';

const BB_MODE_PROMPT =
  'EXPLORATION MODE: The state machine presents nodes one at a time with full DDL and metadata.\n' +
  'For each node:\n' +
  '1. Read the DDL/columns carefully\n' +
  '2. Record detailed findings (what you discovered — business rules, transforms, patterns) (~500 chars)\n' +
  '3. Write a one-line summary (~100 chars) — shown in your working memory for ALL future hops\n' +
  '4. badge_label (2-4 words) — step label for the enriched view, e.g. "4 INIT" or "7 Rate Impute"\n' +
  '5. note_caption (1 line) — what this node does in this flow, e.g. "Entry point — TRUNCATEs and reloads from staging"\n' +
  '6. Generate sub-questions for neighbors you want to investigate (boosts their priority)\n' +
  '7. prune_ids: remove from agenda (scope=in_scope only). add_ids: add to agenda (scope=available).\n\n' +
  'NEIGHBOR SCOPE — evaluate ALL neighbors, then act per tier:\n' +
  '- scope=in_scope: on your agenda — will be visited. Can prune via prune_ids.\n' +
  '- scope=available + in_filter=true: in model but not on agenda — add via add_ids if relevant\n' +
  '- scope=available + in_filter=false: in model but outside user filter — ask user in text\n' +
  '- scope=external: referenced in DDL but not in loaded model — note as external reference\n' +
  '- scope=visited/pruned: already processed\n' +
  'prune_ids only works on scope=in_scope. add_ids only works on scope=available.\n\n' +
  'PROGRESS: After each submit_findings call, emit ONE line: "Hop N · [node_name] → verdict · ~Y nodes remaining".\n\n' +
  'EARLY COMPLETION: Set complete:true when you can answer the question. Visit all relevant nodes — do not skip nodes to finish faster.\n' +
  'Your working memory shows ALL summaries and ALL pending questions — use them to stay on track.\n' +
  'The current_task field contains your own question from a previous hop — answer it.';

// ─── Tool definitions — verbatim modelDescription from package.json ─────────
// These are the EXACT strings Copilot Chat sees per tool. Do not summarize.

const TOOL_DEFS: Record<string, string> = {
  lineage_get_context:
    "Returns schemas, stats, active filter, saved views. If objects[] present: full dataset with DDL, columns, FKs, edges — answer directly. Otherwise: use schema names in other tools' schemas[] filters.",
  lineage_search_objects:
    "Search objects by name or column name (substring or mode='regex' for multi-pattern). Returns IDs for BFS/detail. Results with match='column' matched a column inside the object, not the object name. Use schemas[] to narrow scope. For DDL body content search, use search_ddl instead. If 0 results: try search_ddl for DDL body matches before telling the user nothing was found. If 0 results with schemas[]: check schema_mismatch field — object may exist in another schema.",
  lineage_get_object_detail:
    "Full metadata for ONE object: columns, FKs, neighbors (up/dn), DDL. Use for single-object questions ('what does spX do?'). For multi-object lineage, use run_bfs_trace instead.",
  lineage_run_bfs_trace:
    "PRIMARY tool for lineage questions. Two modes:\n- Level mode (default): id + upstream_hops + downstream_hops → explore by depth\n- Path mode: id + target → all nodes on paths between start and end\nReturns nodes with DDL, columns, and edges. The result graph is automatically stored — use enrich_view to annotate it. Use prune_node_ids in enrich_view to remove irrelevant nodes. Use schemas[] on large models.",
  lineage_run_analysis:
    "Graph-wide structural analysis. Use for: 'most connected objects' or 'biggest nodes' (type=hubs), 'isolated tables with no dependencies' (type=orphans), 'deepest dependency chains' or 'longest paths' (type=longest-path), 'circular dependencies' (type=cycles), 'disconnected groups' (type=islands), 'external or cross-database references' (type=external-refs). Returns ranked groups of node IDs with summary.",
  lineage_search_ddl:
    "Regex search across SP/view/function DDL bodies. Returns matching lines with context. Use for pattern-based DDL search; for simple keyword name search use search_objects instead.",
  lineage_get_ddl_batch:
    "Batch DDL fetch for known IDs. Use ONLY for objects not already in a BFS result — BFS includes DDL by default. Returns DDL for scriptable objects, type-only for tables.",
  lineage_enrich_view:
    "Enrich the stored result graph from your last trace/BFS/exploration. The node set is already stored — you provide presentation: name (mandatory), summary (mandatory), optional description/badges/notes/highlight_groups. Use prune_node_ids to remove irrelevant nodes. Only provide node_ids if you haven't run any trace or BFS (discovery-only mode). Fields are a layered hierarchy: badges (5-8 key nodes, numbered) are navigation anchors; notes caption each badged node; description references step numbers under ## headings with business logic. BAD: 14 badges on all nodes, essay description. GOOD: 6 badges on key nodes, description with '## FX Conversion (step 4)\\n`spConvertFX` reads DimRate.Rate…'.",
  lineage_start_column_trace:
    "Start a hop-by-hop lineage trace. Call as first action — origin is optional.\n\nReturns: scope preview + first hop context with focus node DDL + neighbor list.\n\nAfter receiving: read DDL, verdict each neighbor:\n- trace: follow this path. Provide columns_to_trace (INPUT columns) + question.\n- prune: cut branch and descendants. Explain why.\n- pass: data passes through unchanged, children queued automatically.\nThen call lineage_submit_hop_analysis. Repeat until all paths exhausted.\n\ncolumns_to_trace must be INPUT columns:\n  SP computes ListPrice = CostPrice * (1+MarkupPct) → [CostPrice, MarkupPct]\nIf no columns provided (concept-level trace): omit columns_to_trace from verdicts.",
  lineage_submit_hop_analysis:
    "Submit your analysis of the current hop and receive the next hop's data.\n\nInput:\n- focus_node_id: from the hop context\n- notes: free-form text — your findings for this focus node (what you observed in the DDL)\n- verdicts: array — per neighbor:\n  - neighbor_id: exact ID from the neighbors list\n  - verdict: trace | prune | pass\n  - columns_to_trace: for trace — the INPUT column names to trace upstream (not the output column name)\n  - summary: one-line description of what happens at this node\n  - question: for trace — what to look for at this neighbor (specific, not vague)\n\nVerdicts:\n- trace: follow this path — neighbor carries the traced column or is relevant to the analysis\n- prune: cut this branch — neighbor and all descendants removed from the graph\n- pass: data passes through unchanged (staging table, simple view) — children queued automatically\n- revisit: re-expand a previously pruned node (listed in revisitable field, max 3 per trace)\n\nIMPORTANT — columns_to_trace must be INPUT columns:\n  BAD: SP computes ListPrice = CostPrice * (1+MarkupPct) → [ListPrice]\n  GOOD: → [CostPrice, MarkupPct]\n\nBAD question: \"check this node\"\nGOOD question: \"Does vwSalesData transform Amount or pass it through from staging?\"\n\nReturns: next hop context OR complete result with full chain when all paths exhausted.\nIf you receive invalid_columns error: re-read the DDL and correct the column name, then resubmit.",
  lineage_start_exploration:
    "Start a broad exploration of database objects. Use for questions about business rules, documentation, SQL patterns, or investigations across many objects.\n\nProvide an origin node — the state machine runs BFS to build the exploration map, seeds the agenda, and returns the first hop.\n\nscope_direction controls what BFS finds — ALWAYS specify it:\n- 'upstream': \"what are the sources / what feeds into X?\" — reverse BFS, finds ancestors only (inbound edges). Use for tables, views.\n- 'downstream': \"what does X affect / what reads from X?\" — forward BFS, finds descendants only (outbound edges). Use for impact analysis.\n- 'bidirectional': full connected context — all edges. Only suitable for SPs/functions or when graph is small. Tables/views with high degree will REJECT without explicit direction.\nIf you omit scope_direction on a highly-connected node the SM will return scope_too_broad and require you to resubmit with a direction. The user's active schema filter is applied as a BFS boundary — exploration stays within filtered schemas.\n\nReturns: scope map (nodes + edges) + first hop context with focus node DDL + neighbors.\n\nAfter receiving: analyze the focus node DDL/columns. Record your findings:\n- findings: detailed analysis (~500 chars) — stored permanently in long-term memory\n- summary: one-line digest (~100 chars) — shown in working memory for all future hops\n- questions: sub-questions for neighbors you want to investigate (boosts their agenda priority)\n- prune_ids: neighbor node IDs to prune (utility functions, unrelated objects). Cascades downstream.\n\nThe state machine manages your memory:\n- Long-term: full findings stored per node (never lost)\n- Working: ALL summaries + ALL pending questions returned each hop\n- Checklist: noted/total/open counts\n\ncurrent_task: your own question from a previous hop — answer it.\n\nDo NOT use for column-level tracing — use start_column_trace instead.",
  lineage_submit_findings:
    "Submit your analysis of the current exploration hop and receive the next node's data.\n\nProvide:\n- verdict (required): 'relevant' = useful findings, 'noted' = acknowledged but not critical, 'irrelevant' = unrelated to the question (all downstream nodes automatically pruned from exploration)\n- findings: detailed analysis (~500-3000 chars) — stored permanently in memory\n- summary: one-line digest (~100 chars) — shown in working memory for ALL future hops\n- questions: sub-questions for nodes to investigate next (boosts their agenda priority)\n- prune_ids: neighbor node IDs to remove from agenda. ONLY for neighbors with scope=in_scope — other scopes rejected. Each prune cascades — the node and all nodes only reachable through it are removed. Diamond-safe: fork nodes stay. NOTE: direct neighbors of origin cannot be cascade-pruned.\n- add_ids: neighbor node IDs to add to exploration agenda. For neighbors with scope=available that are relevant to your investigation. The node is auto-expanded into scope and queued at high priority.\n- complete: set true when you have enough findings to answer the user's question. The SM validates this before accepting: if any direct neighbor of the origin node is unvisited, complete is REJECTED and those nodes are reinjected as mandatory. Check working_memory.remaining_agenda to see what is still open — if it contains SPs or source tables directly connected to the origin, do NOT set complete:true.\n\nIf response contains complete_rejected.nodes — those direct neighbors MUST be visited or declared irrelevant before complete:true will be accepted. Do not repeat complete:true until you have processed all of them.\n\nThe cascade_if_irrelevant field in the hop context shows how many nodes would be pruned if you mark this node irrelevant. Check it before deciding.\n\nBAD findings: \"This SP does stuff with data\"\nGOOD findings: \"Joins Orders with OrderDetails on OrderID, applies WHERE Status='Active', computes TotalAmount = Qty * UnitPrice\"\nBAD summary: \"spBuildSalesReport\"\nGOOD summary: \"Aggregates active orders into revenue totals by region\"\n\nResponse includes: next hop context OR complete result when agenda is empty OR early_complete result when complete=true.\n\nWorking memory in each response shows:\n- user_question: your original investigation question (goal anchor — stay focused)\n- all_summaries: ALL your one-line summaries from every noted node (never truncated)\n- pending_questions: ALL open sub-questions (your checklist)\n- remaining_agenda: nodes still to visit — check this BEFORE setting complete:true. If SPs or source tables appear here, you are not done.\n- checklist: { noted, total, open, coveragePct }\n\ncurrent_task: your own question for the new focus node — answer it.",
};

const TOOL_NAMES = Object.keys(TOOL_DEFS);

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

  // 5. Create default session
  createSession('default');

  // 6. Route handler
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

      // GET /prompts — system + mode prompts + tool descriptions (identical to VS Code Copilot Chat)
      if (method === 'GET' && url === '/prompts') {
        return respond(res, 200, {
          system: SYSTEM_PROMPT,
          ct_mode: CT_MODE_PROMPT,
          bb_mode: BB_MODE_PROMPT,
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

        // Dispatch
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
        );
        const durationMs = Date.now() - t1;

        let result: unknown;
        try {
          result = JSON.parse(resultJson);
        } catch {
          result = resultJson;
        }

        console.log(`[tool] ${tool} (session=${sessionId}) → ${durationMs}ms`);
        return respond(res, 200, {
          result,
          _meta: { tool, sessionId, durationMs },
        });
      }

      // 404
      respond(res, 404, { error: 'not_found', hint: 'Endpoints: GET /health, GET /tools, POST /tool, POST /session, DELETE /session/:id' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[error] ${method} ${url}: ${msg}`);
      respond(res, 500, { error: 'internal_error', message: msg });
    }
  });

  // 7. Listen
  server.listen(port, '127.0.0.1', () => {
    console.log(`\nAI Test Bridge ready at http://127.0.0.1:${port}`);
    console.log(`  GET  /health   — model stats`);
    console.log(`  GET  /tools    — list tool names`);
    console.log(`  POST /tool     — { tool, input, sessionId? }`);
    console.log(`  POST /session  — create new session`);
    console.log(`  Ctrl+C to stop\n`);
  });
}

main().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
