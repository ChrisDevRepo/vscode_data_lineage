# AI Chat Participant (`@lineage`)

**Architecture: Explore-First Data Provider.** Extension provides tools + state machine. AI (VS Code Copilot Chat) explores freely, discovers scope, declares intent. Extension delivers data and manages traversal state. Canonical doc: `ai/dataflow.md`.

**Flow:** Discover → Declare (start_column_trace or start_exploration) → Inform → Token Gate (inline or state machine). Slash commands (`/trace`, `/search`) skip discovery.

## Guards

- `ai.maxRounds` (user setting, default 50) — hard stop
- `shouldSmInline()` (token + node count) — delivery gate for CT and BB: scope ≤ `ai.inlineNodeCap` (10) AND under `ai.inlineTokenBudget` (10K) → inline (all DDL at once, memory skipped); exceeds either → hop-by-hop SM with sliding memory. Deep traces need memory for column rename tracking.
- `BFS_INLINE_NODE_CAP` (200) — BFS results exceeding this recommend state machine delivery
- `action_required` gate — blocks non-search tools until AI responds. Only for structural flow control (`analyze_and_respond`). Search tools never gate — they use `ai_hint` (non-blocking). AI is autonomous for search, schema resolution, and discovery.
- Prune guards — `wouldOrphanNotedNode()` rejects prunes that disconnect noted/chain nodes. `CASCADE_REJECT_THRESHOLD` (50%) rejects prunes that wipe >50% of agenda. Guard 0 rejects direct-neighbor prunes outright (no dimming). Shared in `src/ai/smGuards.ts`.
- Node validation — `validateNodeIds()` rejects questions for non-existent nodes with structured error (not silent drop). SM validates, AI self-corrects.
- Context-pressure eviction: if history exceeds 75% of `maxInputTokens`, oldest turns dropped (not summarized — extension is a data store, not an agent)
- **No other mechanism truncates data. Ever.** Zero-truncation guarantee.

## Scope Awareness

State machines receive `_aiFilter` (user's active schema/type filter) for REPORTING — never for filtering or constraining.

- `get_context` reports both scopes: `visible_nodes` (filtered) + `model_stats.nodes` (full model)
- `search_objects` tags each result with `in_user_filter` flag + `filter_context` (active vs all schemas). AI reasons about user visibility.
- `start_exploration` returns `scope_preview` with `in_user_filter` / `outside_filter` counts
- BB hop neighbors tagged: `scope` (in_scope/available/pruned/external/visited) + `in_filter` (boolean)
- BFS trace includes `depth_limited_nodes` — boundary nodes at max depth with `connections_beyond` count
- Classic tools (search, detail, DDL, BFS) always operate on FULL model regardless of filter

## Tools

14 tools (8 classic + 2 CT + 2 BB + 2 batch), registered via `vscode.lm.registerTool()`:
- Classic: get_context, search_objects, get_object_detail, run_bfs_trace, run_analysis, search_ddl, get_ddl_batch, enrich_view
- CT: start_column_trace, submit_hop_analysis
- BB: start_exploration, submit_findings
- Batch (inline mode only): submit_batch_hop (CT), submit_batch_findings (BB)

**Dynamic filtering per round (5 phases):**
- `discover`: all tools visible
- `ct_active`: CT tools (hop-by-hop or batch)
- `ct_done`: classic tools restored, **BFS excluded** (SM result is authoritative)
- `bb_active`: classic + BB tools (CT hidden, mutual exclusion)
- `bb_done`: classic tools restored, **BFS excluded** (SM result is authoritative)

## Delivery Mode Gate

`shouldSmInline()` in `tokenBudget.ts` — AND logic:
- Scope <= `ai.inlineNodeCap` (default 10) AND scope DDL <= `ai.inlineTokenBudget` (default 10K tokens)
- **Below both:** inline — all DDL in `scope_nodes`, batch verdicts, memory skipped
- **Above either:** hop-by-hop — one node per hop, short_memory + detail_slots built per hop

## State Machine Types

Activated for all CT/BB traces (inline mode skips memory, not the SM):
- Type 3: Column — columns provided, validation + rename tracking
- Type 2: Dependency — no columns, frontier + verdicts + boundary detection
- Type 1: Blackboard — free-form exploration with two-tier memory (MemGPT pattern)

**Detail Memory (hop-by-hop mode only):** Per-node extractive evidence stored in `detailSlots` Map (local RAM, unlimited). Structured by aspect: COLUMNS, TRANSFORMS, JOINS, FILTERS, DATA FLOW, QUESTION RELEVANCE. Always delivered at full fidelity — no eviction. SM is a data provider, never degrades evidence. AI's ONLY source at synthesis; can re-read DDL via `get_object_detail` in done phase if insufficient. **In inline mode** (small scopes), detail memory stores only labels/captions — AI has all DDL in context already.

**Type 2/3 Lifecycle:** `init()` → `getHopContext()` ↔ `submitVerdicts()` → frontier empty → `getResult()`
**Type 2/3 Verdicts:** `trace` / `prune` / `pass` / `revisit` — FIFO frontier. `prune` triggers BFS cascade (removes unreachable frontier nodes). `revisit` restores a previously pruned node (max 3 per trace).

**Type 1 Lifecycle:** `init(origin, question)` → scope preview → `getHopContext()` ↔ `submitFindings()` → agenda empty OR AI sends `complete:true` (subject to acceptance guard) → `getResult()`
**Type 1 Scope:** BFS via graphology Graph (filtered model edges only). `model.neighborIndex` is NOT used for scope — it contains cross-schema phantom edges for NodeInfoBar display.
**Type 1 Verdicts:** `relevant` / `pass` / `irrelevant` — unified concept across all SM types (see below). On `irrelevant`, BFS cascade prunes all agenda nodes unreachable from origin. Diamond-safe. Runtime coerces legacy `noted` → `pass`.
**Type 1 Neighbor pruning:** `prune_ids` in `submit_findings` — AI lists neighbor node IDs to remove from agenda. Each triggers `cascadePrune()` (BFS from origin, removes unreachable nodes). Cuts UDF/utility bridges to reduce scope. Same prune concept as CT/Dep Type 2/3.
**Type 1 Agenda:** Question-priority queue (BFS default=0, question-boosted=2). Self-Ask decomposition.
**Type 1 autoSkipTypes:** `BlackboardConfig.autoSkipTypes?: ObjectType[]` — capability exists in BB but is currently unused. The `/document` command that passed this config was removed (commit `9af9f6d`). Extension never activates it. Dead config pending cleanup.

## Unified Node Classification (all SM types)

Three categories — one concept shared via `BLOCK.verdictCategories` in `smPrompts.ts`:

| Concept | BB verdict | CT verdict | Detail memory | Badge | Graph |
|---------|-----------|-----------|---------------|-------|-------|
| Has logic/transforms | `relevant` | `trace` | Full findings (300-1500 chars, extractive SQL evidence) | YES | Kept |
| In path, no transforms | `pass` | `pass` | Summary only (~100-200 chars) | NO | Kept |
| Not related to question | `irrelevant` | `prune` | Summary only | NO | Removed (cascade prune) |

SM enforces: `pass` verdict → `badge_label` stripped, `analysis` stored as summary only. One OOP code path in `HopStateMachine` base class — BB and CT both call `storeDetail()`.

## Key Rules

- `toolInvocationToken: request.toolInvocationToken` REQUIRED in `invokeTool()`
- DDL always delivered in full — never truncated, never `ddl_too_large`
- History: DROP error/empty results from prior turns (compact to 1-line); EVICT oldest turns under context pressure (75% of maxInputTokens). MERGE removed.
- enrich_view auto-populate: BB/CT `suggested_labels` auto-completed into `sections[].node_ids` for sections whose label matches. BB/CT `suggested_notes` used for unannotated nodes.
- No budget hints, no per-tool caps, no routing tool

## Prompts

- System prompt (hardcoded, `src/ai/prompts.ts`): role + 5 behavioral rules
- Mode-specific prompt (injected once at ct_active or bb_active, built by `src/ai/smPrompts.ts`): column trace, dependency trace, or exploration mode. Composed from named BLOCK constants.
- Tool `modelDescription` (package.json): per-tool when/what/format
- Output format (`assets/aiOutputTemplates.yaml`): user-configurable (presentation layer only)
