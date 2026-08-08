const vscode = require('vscode');
const path = require('node:path');

const VENDOR = 'lineage-test';
const MODEL_ID = 'lineage-deterministic-v1';
let requests = [];

// ── Lane mode ────────────────────────────────────────────────────────────────
//
// `LINEAGE_MODEL_LANE=scripted` (or unset — the tracked `ai-backend` label never sets it) keeps
// EVERY line below byte-for-byte as it was: the deterministic script answers and no
// network call happens. Any other lane resolves a real provider from the generic donor variables
// (`URI`/`MODEL`/`API`, see internal-testing/live-provider/aiProvider.js) and proxies each
// generation to it.
const MODEL_LANE = process.env.LINEAGE_MODEL_LANE || 'scripted';
const IS_LIVE_LANE = MODEL_LANE !== 'scripted';

// ── Live-lane modules ────────────────────────────────────────────────────────
//
// The credentialed half of this fixture — the module that reads an API key, builds a request body
// and calls `fetch` — lives in `internal-testing/live-provider/`, the gitignored tree that is cut
// before production. Nothing under it may be required at load time: the tracked scripted
// `ai-backend` label loads this file on a clean checkout where that tree does not exist, so a
// top-level require would break the optional check.
/** Directory the live-lane modules are resolved from, for the missing-module message. */
const LIVE_PROVIDER_DIR = path.resolve(__dirname, '../../../internal-testing/live-provider');

/**
 * Resolves a live-lane module at the point of use.
 *
 * @remarks
 * Live lanes only, and a missing module is FATAL — never a fall back to the scripted answers. A
 * live lane that quietly returns canned data is a false measurement, which is the exact failure
 * mode this harness exists to eliminate.
 *
 * @param {string} name
 * @param {() => unknown} load
 */
function requireLiveModule(name, load) {
  if (!IS_LIVE_LANE) {
    throw new Error(
      `[t1t7] ${name} is a live-lane module and must never load in lane '${MODEL_LANE}'.`,
    );
  }
  try {
    return load();
  } catch (err) {
    throw new Error(
      `[t1t7] lane '${MODEL_LANE}' is live but its provider module could not be loaded: expected `
      + `${path.join(LIVE_PROVIDER_DIR, `${name}.js`)}. That tree is gitignored and absent from a `
      + `clean checkout — live lanes run only from internal-testing/.vscode-test.mjs. `
      + `Underlying error: ${err && err.message}`,
    );
  }
}

/** The credentialed proxy. Live lanes only. */
function liveProxy() {
  return requireLiveModule(
    'liveProxy',
    () => require('../../../internal-testing/live-provider/liveProxy'),
  );
}

/** The donor lane helper (URI-derived provider kind, redaction). Live lanes only. */
function aiProvider() {
  return requireLiveModule(
    'aiProvider',
    () => require('../../../internal-testing/live-provider/aiProvider'),
  );
}

/** Resolved live configuration for this lane, or `null` in the scripted lane. */
let liveConfig = null;
/**
 * Provider behaviours observed during the run (empty tool arguments, id-less tool calls, transport
 * retries). REPORTED by the suite teardown, never worked around: a real model that misbehaves is a
 * finding about the model/runtime pair, not something a test fixture should shim away.
 */
const quirks = [];

// ── Case scripting state ─────────────────────────────────────────────────────
//
// `null` reproduces the ORIGINAL fixed-sequence behavior byte-for-byte (structured_output ->
// discovery/null, one lineage_search_objects round-trip keyed on 'search-001', one
// lineage_present_result keyed on 'scripted-call-001', else 'SCRIPTED_RUNTIME_COMPLETE').
// tests/integration/ai-backend.test.ts asserts against exactly that sequence and never calls
// `lineageTestModel.setCase`, so the legacy path must stay byte-identical when no case is active.
let activeCase = null;
/** Monotonic per-active-hop counter, reset on every setCase/reset so callIds stay unique per turn. */
let hopSeq = 0;
/**
 * CT column-chain assignment: normalized node id -> the real column name this fixture is tracing
 * on that node. Populated breadth-first as each hop stages `upstream_columns` references onto its
 * own upstream neighbors (see the active-hop branch below for why this is the only way a non-origin
 * node's `column_flow.out_col` can ever be schema-valid).
 */
let ctColumnAssignment = new Map();

/**
 * The T1-T7 scripted scenario matrix (donor: ai-embedded-chat-langgraph.test.ts,
 * `git show donor/testing13:tests/integration/ai-embedded-chat-langgraph.test.ts`).
 *
 * @remarks
 * `entry`/`targetColumns` feed the `structured_output` entry-detector reply (src/ai/agent/state.ts
 * EntryDetectionSchema). T6 sets `entry: null` because its donor prompt is a leading `/trace`
 * command — `detectSlashRoute` (src/ai/agent/slashCommands.ts) pins the route deterministically and
 * the graph never calls the entry-detector model, so the fixture must never see a `structured_output`
 * tool for that case (if it does, something upstream regressed and the fixture answers 'discovery'
 * defensively rather than hanging).
 *
 * Each case's `origin`/`targetColumns`/query params are overridable via the second `setCase`
 * argument (`{ origin, query, schemas, targetColumns, ... }`) — the caller's synthetic
 * DatabaseModel/graph is the source of truth for which node ids actually resolve, and this fixture
 * has no access to it.
 */
const DEFAULT_CASES = {
  T1: {
    entry: 'discovery',
    kind: 'discovery-tool',
    tool: 'lineage_get_context',
    buildInput: () => ({}),
  },
  T2: {
    entry: 'discovery',
    kind: 'discovery-tool',
    tool: 'lineage_search_objects',
    buildInput: (cfg) => ({ query: cfg.query ?? '', schemas: cfg.schemas ?? ['ai'] }),
  },
  T3: {
    entry: 'discovery',
    kind: 'discovery-tool',
    tool: 'lineage_search_ddl',
    buildInput: (cfg) => ({ query: cfg.query ?? 'raworderimport' }),
  },
  T4: {
    entry: 'discovery',
    kind: 'discovery-tool',
    tool: 'lineage_get_scope_bundle',
    origin: '[ai].[RawOrderImport]',
    buildInput: (cfg) => ({ origin: cfg.origin, upstream_depth: 1, downstream_depth: 1 }),
  },
  T5: {
    entry: 'discovery',
    kind: 'discovery-tool',
    tool: 'lineage_get_scope_bundle',
    origin: '[ai].[spImportOrders]',
    buildInput: (cfg) => ({ origin: cfg.origin, upstream_depth: 'all', downstream_depth: 1 }),
  },
  T6: {
    entry: null, // pinned by the '/trace' slash command — no entry-detector call for this case
    kind: 'sm',
    mode: 'bb',
    origin: '[ai].[FactSalesReport]',
    classification: 'business',
    direction: 'upstream',
    depth: 'all',
  },
  T7: {
    entry: 'column_trace',
    kind: 'sm',
    mode: 'ct',
    origin: '[ai].[FactSalesReport]',
    targetColumns: ['TotalRevenue'],
    classification: 'business',
    direction: 'upstream',
    depth: 'all',
  },
};

function normalizePart(part) {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', value: part.value };
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return { type: 'tool-call', callId: part.callId, name: part.name, input: part.input };
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return { type: 'tool-result', callId: part.callId, content: part.content.map(normalizePart) };
  }
  return { type: part?.constructor?.name ?? typeof part };
}

/**
 * Whether a prior tool call issued under `callId` has come back to the model — either shape.
 *
 * @remarks
 * An ACCEPTED tool observation carries back as a user-role `<runtime_tool_context>` text block
 * (see `renderObservationsContext`, tests/integration/ai-backend.test.ts documents the same
 * check); a REJECTED one carries as a native assistant tool-call + tool-result pair
 * (`renderRejectionExchange`, toolAttempt.ts:589). Checking only one shape lets a case's tool call
 * re-emit forever until the provider-call breaker trips.
 */
function resultObservedFor(request, callId) {
  return request.messages
    .flatMap((message) => message.content)
    .some((part) => (part.type === 'tool-result' && part.callId === callId)
      || (part.type === 'text' && typeof part.value === 'string' && part.value.includes(callId)));
}

/** Concatenated text of every user-role message in the request, most recent last. */
function userText(request) {
  return request.messages
    .filter((message) => message.role === 1 /* vscode.LanguageModelChatMessageRole.User */)
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.value)
    .join('\n');
}

/** Case/bracket-insensitive node-id comparison key (mirrors smCompleteness.ts's normalizeSqlName). */
function normalizeNodeId(id) {
  return typeof id === 'string' ? id.replace(/\[|\]/g, '').toLowerCase() : '';
}

/**
 * Extracts and parses the last `<hop_context>...</hop_context>` JSON block, or null.
 *
 * @remarks
 * `buildWorkerHopMessage` (src/ai/agent/stagePrompts.ts) precedes the real `<hop_context>` TAG with a
 * plain-prose SENTENCE that also mentions the literal string `<hop_context>`
 * ("Use ONLY node ids that appear in <hop_context> for route_requests."). A tag-only regex greedily
 * (non-greedily, but still) matches that mention as the opening tag and captures everything up to
 * the real closing tag as its "body" — which is not valid JSON and always fails to parse. The
 * capture group here additionally requires the body to start with `{`, which only the real tag
 * (immediately followed by the JSON object) satisfies.
 */
function latestHopContext(request) {
  const text = userText(request);
  const matches = [...text.matchAll(/<hop_context>\s*(\{[\s\S]*?\})\s*<\/hop_context>/g)];
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]);
  } catch {
    return null;
  }
}

/** Extracts and parses the last standalone-JSON user message that looks like the SM completion envelope. */
function latestEnvelope(request) {
  const userMessages = request.messages
    .filter((message) => message.role === 1)
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text');
  for (let i = userMessages.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(userMessages[i].value);
      if (parsed && typeof parsed === 'object' && parsed.result && typeof parsed.result === 'object') {
        return parsed;
      }
    } catch {
      // not JSON — keep scanning older user messages
    }
  }
  return null;
}

/**
 * Parses every JSON object carried back to the model this turn, walking into native
 * `tool-result` parts (`renderRejectionExchange`, toolAttempt.ts:589) as well as top-level text.
 * A REJECTED submit_findings rides as a native assistant tool-call + tool-result pair whose
 * result content is `JSON.stringify({code, reason, hint, detail, ...})` — this is how the
 * fixture reads that `detail` array back, rather than regexing the flattened prose (fragile:
 * `reason` strings can themselves contain brackets/quotes).
 */
function collectResultJson(request) {
  const out = [];
  const visit = (parts) => {
    for (const part of parts) {
      if (part.type === 'text' && typeof part.value === 'string') {
        try { out.push(JSON.parse(part.value)); } catch { /* prose, not a result payload */ }
      } else if (part.type === 'tool-result' && Array.isArray(part.content)) {
        visit(part.content);
      }
    }
  };
  for (const message of request.messages) visit(message.content);
  return out;
}

/**
 * Looks up the `available_columns` list a PRIOR rejection reported for `nodeId`, if any.
 *
 * @remarks
 * `validateColumnFlow` (src/ai/sm/columnTracer.ts) rejects an `upstream_columns` entry whose
 * `col` is not real (`bad_contributor_col` / rendered code `contributor_col_not_on_source`) and
 * includes the actual valid column set in `detail[].available_columns` — this is the ONE
 * ground-truth source for a stored-procedure neighbor's real inbound-source columns (its own
 * `HopNeighbor.cols` is not that set; procedures don't have "columns" the way tables/views do).
 */
function priorAvailableColumns(request, nodeId) {
  const key = normalizeNodeId(nodeId);
  for (const obj of collectResultJson(request)) {
    const detail = obj && Array.isArray(obj.detail) ? obj.detail : null;
    if (!detail) continue;
    for (const entry of detail) {
      if (entry && typeof entry.id === 'string' && normalizeNodeId(entry.id) === key
        && Array.isArray(entry.available_columns) && entry.available_columns.length > 0) {
        return entry.available_columns;
      }
    }
  }
  return null;
}

/**
 * Reads the CURRENT hop's `column_chain_incomplete` rejection, if any — the engine's own
 * declaration of which real columns this exact focus node must account for.
 *
 * @remarks
 * Fallback only: the per-hop `<column_trace>` block (`readDeclaredActiveColumns`) is the primary
 * channel and normally makes this unnecessary. When a hop renders no such block, this rejection's
 * `detail.unaccounted` (`buildIncompleteRejection`, smCompleteness.ts) is the ground truth, IF it
 * rides back as a native tool-call/tool-result pair (`renderRejectionExchange`, toolAttempt.ts:589)
 * the way every other rejection this fixture reads (`priorAvailableColumns`) does.
 *
 * The key is `code`, not `error`: the engine emits `{error:'column_chain_incomplete', hint, detail}`
 * (`buildIncompleteRejection`), but `readToolError` (toolErrorEnvelope.ts) renames `error` to `code`
 * before `renderRejectionExchange` puts `{code, reason, hint, detail, issuePaths}` on the wire.
 */
function priorUnaccountedColumns(request) {
  for (const obj of collectResultJson(request)) {
    if (obj && obj.code === 'column_chain_incomplete' && obj.detail && Array.isArray(obj.detail.unaccounted)
      && obj.detail.unaccounted.length > 0) {
      return obj.detail.unaccounted;
    }
  }
  return null;
}

/**
 * Builds one CT `column_flow` array for the current hop.
 *
 * @remarks
 * `NavigationEngine.getHopContext()` never serializes `active_columns` into anything the model
 * (or this fixture) can read — the `working_memory.column_aspect` it assembles is dead: nothing
 * downstream (`buildActiveHopInstruction`/`buildWorkerHopMessage`) renders it into the per-hop
 * prompt (src/ai/sm/smBase.ts). So this fixture cannot directly observe which columns are
 * "active" at a hop the way a reasoning model reading real DDL would. What IS knowable
 * structurally:
 *
 * - The origin's traced columns are GUARANTEED real+active — CT `start_exploration` hard-rejects
 *   (`unknown_columns`) before hop 1 otherwise.
 * - `ColumnTracer.determineActiveColumnsForCandidate` derives a non-origin node's active columns
 *   from the "spine" — accumulated `column_flow` edges whose `from_node` is that candidate. A
 *   node the fixture has not yet referenced via some earlier hop's `upstream_columns` has an
 *   empty spine and (barring a same-named column coincidence) an empty active set, so any
 *   `out_col` submitted for it is rejected as `bad_out_col`.
 *
 * `NavigationEngine.init()` ALSO independently computes each CT-scope node's real "active" output
 * column(s) up front. That set IS handed to the model before the fact: `buildCurrentTaskBlock`
 * (src/ai/prompting/prompts.ts) renders it into every CT hop's `<current_task>` as
 * `<column_trace>  Active columns: [...]`, which `readDeclaredActiveColumns` reads. Using it is
 * what a compliant model does, so the fixture does the same — no probe, no rejection.
 * `priorUnaccountedColumns` remains as a fallback for a hop that renders no such block, and
 * `ctColumnAssignment` still remembers any column name guessed for a node while naming it as some
 * OTHER hop's `upstream_columns` contributor.
 *
 * The first guess at a contributor column (`HopNeighbor.cols[0]`) is correct for a table/view
 * neighbor (validated against its own declared columns) but WRONG for a stored-procedure
 * neighbor — `validateColumnFlow` checks a proc's contributor column against its real INBOUND
 * SOURCES' columns instead (`bad_contributor_col` / rendered code `contributor_col_not_on_source`),
 * a set this fixture cannot see from the referencing hop's own `hop.neighbors`. That rejection's
 * `detail[].available_columns` carries the real answer, so `priorAvailableColumns` reads it back
 * on the very next generation (self-correcting, no coverage lost) — see its doc comment.
 */
function readDeclaredActiveColumns(request) {
  const text = userText(request);
  const matches = [...text.matchAll(/Active columns: \[([^\]]*)\]/g)];
  if (matches.length === 0) return null;
  const cols = matches[matches.length - 1][1].split(',').map((c) => c.trim()).filter(Boolean);
  return cols.length > 0 ? cols : null;
}

function buildCtColumnFlow(request, cfg, focusId, hop) {
  const focusKey = normalizeNodeId(focusId);
  const isOriginHop = focusKey === normalizeNodeId(cfg.origin);

  let outCols;
  if (isOriginHop) {
    // CT start_exploration already hard-rejects (unknown_columns) before hop 1 unless every
    // targetColumns entry is a real column on the origin — so this is always correct, no probe.
    outCols = cfg.targetColumns ?? [];
  } else {
    const declared = readDeclaredActiveColumns(request);
    const confirmed = declared ?? priorUnaccountedColumns(request);
    if (confirmed) {
      outCols = confirmed; // engine-declared active columns for this hop
    } else {
      const guessed = ctColumnAssignment.get(focusKey);
      // Neither channel produced an answer — fall back to the spine-derived guess, else submit an
      // empty column_flow so the engine's own rejection reveals the truth on the next generation.
      outCols = guessed ? [guessed] : [];
    }
  }
  if (outCols.length === 0) return [];

  const upstreamNeighbors = (hop && Array.isArray(hop.neighbors) ? hop.neighbors : [])
    .filter((n) => n && n.edge_direction === 'upstream' && typeof n.id === 'string');
  const upstream_columns = [];
  for (const neighbor of upstreamNeighbors) {
    const neighborKey = normalizeNodeId(neighbor.id);
    // A prior rejection for THIS neighbor on THIS hop's retry ladder is authoritative — it is the
    // engine's own real column list (e.g. a stored procedure's actual inbound-source columns,
    // which HopNeighbor.cols does not carry; see the module doc comment above). Otherwise reuse
    // whatever this fixture already assigned this node (from an earlier hop's reference to it, or
    // from this same loop moments ago), and only guess from HopNeighbor.cols as a last resort.
    const corrected = priorAvailableColumns(request, neighbor.id);
    const assigned = corrected
      ? corrected[0]
      : ctColumnAssignment.get(neighborKey)
        ?? (Array.isArray(neighbor.cols) && neighbor.cols.length > 0 ? neighbor.cols[0] : outCols[0]);
    ctColumnAssignment.set(neighborKey, assigned);
    upstream_columns.push({ node: neighbor.id, col: assigned });
  }
  // Every unaccounted-for out_col at this hop shares the same candidate contributor pool — a
  // wrong guess for a given (out_col, contributor) pair self-corrects on the next generation via
  // `priorAvailableColumns`, same as the single-column case.
  return outCols.map((outCol) => ({ out_col: outCol, upstream_columns }));
}

/**
 * Terminal-source node ids of the CT column chain, read off the engine's own rendered evidence.
 *
 * @remarks
 * `findMissingCtTerminalSources` (src/ai/tools/handlers/presentResult.ts) rejects a CT
 * `present_result` whose payload leaves a terminal source unlinked, computing them as the
 * `from_node`s of `columnAspect.edges` that are never a `to_node`. The completion envelope does
 * NOT carry `columnAspect`, but `buildCtSynthesisBlock` (smPrompts.ts) renders every one of those
 * edges into `synthesis_reminder` under `## Column Trace Chain`, one per line as
 * `  <from_node>.<from_col> → <to_node>.<to_col> (hop N)` — documented as the only place the model
 * is told which nodes are terminal sources. Reconstructing the same set-difference from those
 * lines is reading engine output, not guessing: the greedy `\S+` plus a dot-free column tail splits
 * a bracketed `[schema].[object].Column` back into its node id and column.
 *
 * @param synthesisReminder - `envelope.synthesis_reminder`, or any non-string (yields an empty set).
 * @returns Terminal-source node ids in first-seen order; empty when no chain block was rendered.
 */
function ctTerminalSources(synthesisReminder) {
  if (typeof synthesisReminder !== 'string' || !synthesisReminder.includes('## Column Trace Chain')) return [];
  const fromNodes = [];
  const toNodes = new Set();
  for (const line of synthesisReminder.split('\n')) {
    const match = /^ {2}(\S+)\.([^.\s]+) → (\S+)\.([^.\s]+) \(hop \d+\)$/.exec(line);
    if (!match) continue;
    fromNodes.push(match[1]);
    toNodes.add(normalizeNodeId(match[3]));
  }
  const seen = new Set();
  return fromNodes.filter((id) => {
    const key = normalizeNodeId(id);
    if (toNodes.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Derives `present_result.sections[]` from the completion envelope the engine already handed back.
 *
 * @remarks
 * `sections[]` is mandatory (`validatePresentResult`, src/ai/tools/presentResult.ts) and each entry
 * needs a NON-BLANK `text` (toolSchemas.ts `PresentResultModelSchema`, re-checked in
 * `validatePresentResult`). The envelope carries two halves of that, and neither alone is enough:
 *
 * - `result.suggested_sections` — the engine's own depth buckets `{ label, node_ids }`. It supplies
 *   the label and the node links, and has NO text field at all, so it can never satisfy `text`.
 * - `result.detail_slots` — the per-node analysis archive
 *   `{ nodeId, schema, name, type, sections:[{angle,text}], summary }`. `DetailSlot.sections` is
 *   documented (src/ai/session/memoryManager.ts) as the text synthesis "lifts verbatim into
 *   `present_result.sections[]`" — this is the sanctioned source, and the only one.
 *
 * The join is PARTIAL by construction: `suggested_sections` buckets EVERY node in the final render
 * (smBase.ts `getResult`), while `detail_slots` is filtered to the ANALYZED subset — a bucket made
 * up only of passthrough/bare nodes yields no text. Such a bucket is DROPPED rather than given
 * fixture-authored prose: inventing a body would make the payload hand-authored instead of derived.
 *
 * Two node ids must end up linked even though no bucket may carry them, and both are handled by
 * re-linking an ENGINE-SUPPLIED id into an ENGINE-SUPPLIED section — never by inventing prose:
 *
 * - the origin, which `highlight_groups` pins and `validatePresentResult` requires to be covered by
 *   a section link or a note. If its own (depth-0 `Origin`) bucket was dropped, it goes onto the
 *   FIRST surviving section.
 * - in CT, every {@link ctTerminalSources} id, which `findMissingCtTerminalSources` requires to be
 *   linked in `sections[].node_ids` or highlighted `color:"source"`. Section linking is used
 *   because a `source` highlight group would itself then need explaining. They go onto the LAST
 *   surviving section — the deepest bucket, where the trace bottoms out.
 *
 * Bucket `node_ids` are depth-partitioned and therefore disjoint, and both re-links skip an id that
 * is already linked, so no node can end up in two sections.
 *
 * @param envelope - The parsed completion envelope from {@link latestEnvelope}, or null.
 * @param originNodeId - The id `highlight_groups` colors, which must end up covered.
 * @returns Zero or more `{ label, node_ids, text }` sections, all text lifted verbatim.
 */
function buildPresentSections(envelope, originNodeId) {
  const result = envelope && envelope.result ? envelope.result : null;
  if (!result || !Array.isArray(result.suggested_sections)) return [];

  const slotText = new Map();
  for (const slot of Array.isArray(result.detail_slots) ? result.detail_slots : []) {
    if (!slot || typeof slot.nodeId !== 'string') continue;
    const captured = (Array.isArray(slot.sections) ? slot.sections : [])
      .map((s) => (s && typeof s.text === 'string' ? s.text.trim() : ''))
      .filter((t) => t.length > 0);
    // `summary` is the same archive's one-line digest of the node, used only when a slot carried
    // no captured section text — still an engine-archived verbatim lift, not fixture prose.
    const fallback = typeof slot.summary === 'string' ? slot.summary.trim() : '';
    const text = captured.length > 0 ? captured.join('\n\n') : fallback;
    if (text) slotText.set(normalizeNodeId(slot.nodeId), text);
  }

  const sections = [];
  for (const bucket of result.suggested_sections) {
    if (!bucket || typeof bucket.label !== 'string' || !Array.isArray(bucket.node_ids)) continue;
    const texts = bucket.node_ids
      .map((id) => slotText.get(normalizeNodeId(id)))
      .filter((t) => typeof t === 'string' && t.length > 0);
    if (texts.length === 0) continue; // no analyzed node in this bucket — nothing to lift
    sections.push({ label: bucket.label, node_ids: [...bucket.node_ids], text: texts.join('\n\n') });
  }

  if (sections.length === 0) return sections;

  const linked = new Set();
  for (const section of sections) {
    for (const id of section.node_ids) linked.add(normalizeNodeId(id));
  }
  const link = (section, nodeId) => {
    const key = normalizeNodeId(nodeId);
    if (linked.has(key)) return;
    linked.add(key);
    section.node_ids.push(nodeId);
  };

  link(sections[0], originNodeId);
  for (const sourceId of ctTerminalSources(envelope.synthesis_reminder)) {
    link(sections[sections.length - 1], sourceId);
  }
  return sections;
}

function activate(context) {
  // A live lane resolves BEFORE anything else and throws if its configuration is incomplete, so
  // `extension.activate()` rejects and the suite fails loudly naming the exact missing variable.
  // There is deliberately no fallback to the scripted provider.
  if (IS_LIVE_LANE) liveConfig = liveProxy().resolveLiveProvider(process.env);

  const provider = {
    provideLanguageModelChatInformation() {
      // A live lane advertises the REAL model identity, so `request.model.id` — the only channel
      // production reads a model from — carries the model that actually served the turn.
      if (liveConfig) {
        return [{
          id: liveConfig.model,
          name: liveConfig.model,
          family: liveConfig.model,
          version: '1.0.0',
          maxInputTokens: 200_000,
          maxOutputTokens: 32_768,
          capabilities: { toolCalling: true },
        }];
      }
      return [{
        id: MODEL_ID,
        name: 'Lineage Deterministic v1',
        family: MODEL_ID,
        version: '1.0.0',
        maxInputTokens: 16_384,
        maxOutputTokens: 2_048,
        capabilities: { toolCalling: true },
      }];
    },
    async provideLanguageModelChatResponse(_model, messages, options, progress, token) {
      const request = {
        messages: messages.map(message => ({
          role: message.role,
          content: message.content.map(normalizePart),
        })),
        tools: (options.tools ?? []).map(tool => ({ name: tool.name, schema: tool.inputSchema })),
        toolMode: options.toolMode,
      };
      requests.push(request);

      // ── live lane: proxy this generation to the real model ──────────────────
      // Recorded above FIRST so the call/result-correlation oracle reads the same normalized
      // request shape in both modes, then handed to the proxy verbatim.
      if (liveConfig) {
        await liveProxy().generate(liveConfig, messages, options, progress, token, quirks);
        return;
      }

      const toolNames = request.tools.map(tool => tool.name);
      const caseId = activeCase && activeCase.id;
      const cfg = activeCase ? activeCase.cfg : null;

      // ── structured_output: the narrow entry-detector call ───────────────────
      if (toolNames.includes('structured_output')) {
        const verdict = cfg
          ? { entry: cfg.entry ?? 'discovery', targetColumns: cfg.targetColumns ?? null }
          : { entry: 'discovery', targetColumns: null };
        progress.report(new vscode.LanguageModelToolCallPart('entry-001', 'structured_output', verdict));
        return;
      }

      // ── legacy fixed sequence (no active case — tests/integration/ai-backend.test.ts) ───────────
      // Must run BEFORE any case-scripted phase branch: the legacy discovery-phase request offers
      // both lineage_get_context and lineage_search_objects together (DISCOVERY_TOOLS), so a
      // get_context-keyed branch below would otherwise shadow this path when no case is active.
      if (!cfg) {
        const hasSearchResult = resultObservedFor(request, 'search-001');
        if (toolNames.includes('lineage_search_objects') && !hasSearchResult) {
          progress.report(new vscode.LanguageModelToolCallPart(
            'search-001', 'lineage_search_objects', { query: 'Orders' },
          ));
          return;
        }
        if (toolNames.includes('lineage_present_result')) {
          progress.report(new vscode.LanguageModelToolCallPart(
            'scripted-call-001', 'lineage_present_result', { id: 'snapshot-only' },
          ));
          return;
        }
        progress.report(new vscode.LanguageModelTextPart('SCRIPTED_RUNTIME_COMPLETE'));
        return;
      }

      // ── sm_entry: search_objects + start_exploration only (no get_context) ──
      if (toolNames.includes('lineage_start_exploration') && !toolNames.includes('lineage_get_context')) {
        const startCallId = `${caseId}-start-001`;
        if (!resultObservedFor(request, startCallId)) {
          const input = {
            origin: cfg.origin,
            question: `Scripted ${caseId} exploration.`,
            analysisMode: cfg.mode,
            direction: cfg.direction ?? 'upstream',
            depth: cfg.depth ?? 'all',
            classification: cfg.classification ?? 'business',
            ...(cfg.mode === 'ct' ? { targetColumns: cfg.targetColumns } : {}),
          };
          progress.report(new vscode.LanguageModelToolCallPart(startCallId, 'lineage_start_exploration', input));
          return;
        }
        // Already resolved this turn (e.g. a refine round) — nothing further to add.
        progress.report(new vscode.LanguageModelTextPart('SCRIPTED_RUNTIME_COMPLETE'));
        return;
      }

      // ── active hop loop: submit_findings (+ optional get_neighbor_columns) ──
      if (toolNames.includes('lineage_submit_findings')) {
        const hop = latestHopContext(request);
        const focusId = hop && hop.focus_node && typeof hop.focus_node.id === 'string'
          ? hop.focus_node.id
          : cfg.origin;
        hopSeq += 1;
        const callId = `${caseId}-hop-${hopSeq}`;
        const isCt = cfg.mode === 'ct';
        // BB required-route accounting: the full 'all'-depth scope is precomputed at
        // start_exploration, but BbStrategy.runRequiredNodesGuard (src/ai/sm/strategies.ts) still
        // requires each hop to explicitly account for its own in-scope, not-yet-queued directional
        // neighbors via route_requests (or prune_neighbors) — pre-seeding the scope does not queue
        // it. Route every in-budget upstream neighbor forward; the engine dedupes an already-queued
        // one, so over-routing is harmless.
        const inBudgetUpstreamNeighbors = (hop && Array.isArray(hop.neighbors) ? hop.neighbors : [])
          .filter((n) => n && n.edge_direction === 'upstream' && n.in_budget && n.boundary !== 'cycle'
            && typeof n.id === 'string');
        const routeRequests = inBudgetUpstreamNeighbors.map((n) => ({
          nodeId: n.id,
          question: 'Trace this node\'s contribution to the upstream lineage.',
        }));
        const input = {
          focus_node_id: focusId,
          sections: [{ angle: 'business', text: `Scripted ${caseId} analysis of ${focusId}.` }],
          summary: `${focusId} passes data through unchanged.`,
          verdict: 'analyze',
          ...(isCt
            ? { column_flow: buildCtColumnFlow(request, cfg, focusId, hop) }
            : (routeRequests.length > 0 ? { route_requests: routeRequests } : {})),
        };
        progress.report(new vscode.LanguageModelToolCallPart(callId, 'lineage_submit_findings', input));
        return;
      }

      // ── synthesis: present_result only ───────────────────────────────────────
      // `sections[]` is mandatory and its `text` is only derivable from the completion envelope's
      // own `detail_slots` archive — see buildPresentSections for why neither half suffices alone.
      if (toolNames.length === 1 && toolNames[0] === 'lineage_present_result') {
        const envelope = latestEnvelope(request);
        const originNodeId = envelope && envelope.result && typeof envelope.result.originNodeId === 'string'
          ? envelope.result.originNodeId
          : cfg.origin;
        const sections = buildPresentSections(envelope, originNodeId);
        const input = {
          name: `Scripted ${caseId} result`,
          summary: `Scripted synthesis for ${caseId}.`,
          ...(sections.length > 0 ? { sections } : {}),
          highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [originNodeId] }],
        };
        progress.report(new vscode.LanguageModelToolCallPart(`${caseId}-present-001`, 'lineage_present_result', input));
        return;
      }

      // ── discovery: one scripted tool call, then a final text answer ─────────
      if (toolNames.includes('lineage_get_context') && cfg.kind === 'discovery-tool') {
        const discoverCallId = `${caseId}-discover-001`;
        if (!resultObservedFor(request, discoverCallId) && toolNames.includes(cfg.tool)) {
          progress.report(new vscode.LanguageModelToolCallPart(discoverCallId, cfg.tool, cfg.buildInput(cfg)));
          return;
        }
        progress.report(new vscode.LanguageModelTextPart(`SCRIPTED_COMPLETE case=${caseId} tool=${cfg.tool}`));
        return;
      }

      // Defensive fallback: a case is active but the offered tool set matched none of the phase
      // branches above (e.g. 'completed' follow-up tools, not exercised by T1-T7).
      progress.report(new vscode.LanguageModelTextPart(`SCRIPTED_COMPLETE case=${caseId} phase=unmatched`));
    },
    async provideTokenCount(_model, text) {
      return typeof text === 'string' ? text.length : 1;
    },
  };
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.commands.registerCommand('lineageTestModel.getRequests', () => requests),
    // The lane's own account of what it is. The key is held in a closure and is NOT part of this
    // payload; the endpoint is redacted before it leaves the fixture, so nothing secret can reach
    // a log, a test name, or an artifact.
    vscode.commands.registerCommand('lineageTestModel.getLaneInfo', () => ({
      lane: MODEL_LANE,
      mode: liveConfig ? 'live' : 'scripted',
      modelId: liveConfig ? liveConfig.model : MODEL_ID,
      endpoint: liveConfig ? aiProvider().redactProviderUri(liveConfig.endpoint) : null,
      providerKind: liveConfig ? liveConfig.provider : null,
      quirks: [...quirks],
    })),
    vscode.commands.registerCommand('lineageTestModel.reset', () => {
      requests = [];
      activeCase = null;
      hopSeq = 0;
      ctColumnAssignment = new Map();
    }),
    // Selects which scripted T1-T7 scenario plays for the next turn(s), until the next
    // setCase/reset call. `overrides` is optional and merges shallowly over DEFAULT_CASES[caseId]
    // (e.g. { origin: '[dbo].[MyFact]' } to point a case at a caller-built synthetic graph).
    vscode.commands.registerCommand('lineageTestModel.setCase', (caseId, overrides) => {
      const base = DEFAULT_CASES[caseId];
      if (!base) throw new Error(`lineageTestModel.setCase: unknown case "${caseId}". Expected one of T1..T7.`);
      activeCase = { id: caseId, cfg: { ...base, ...(overrides || {}) } };
      hopSeq = 0;
      ctColumnAssignment = new Map();
    }),
  );
}

module.exports = { activate };
