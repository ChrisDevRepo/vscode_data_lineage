# Architecture Rules

## Core Design Principles

### 1. Dacpac and DB Import share all logic after extraction
Both produce `ExtractedObject[]`, `ExtractedDependency[]`, `ConstraintMaps`. Never duplicate pipeline logic between extractors.

### 2. Metadata-driven, user-extensible
- Parse rules: `assets/defaultParseRules.yaml` — user overrides via settings
- DMV queries: `assets/dmvQueries.yaml` — user overrides via settings
- No hardcoded SQL in TypeScript. Queries belong in YAML.

### 3. Transparency for DBAs
Every SQL query visible in YAML. Never hide query logic in TypeScript.

### 4. Use VS Code built-in APIs (`src/` only)

Logging: `vscode.LogOutputChannel`. File I/O: `vscode.workspace.fs`. Config: `getConfiguration()`. Progress: `withProgress()`. Dialogs: `show*Message()`. Webview: `postMessage({ type: 'log' })` → outputChannel.

Exception: pure utilities (`sqlBodyParser.ts`, `modelBuilder.ts`) may use `console.warn` when outputChannel unavailable.

### 5. Tests use Node.js APIs by design

Tests run in vitest (plain Node.js). Use `console.log`, Node `fs`, `mssql` npm, `.env` — no VS Code dependency.

## Extraction Pipeline — Thin Adapters

| Module | Responsibility |
|--------|---------------|
| `dacpacExtractor.ts` | XML/ZIP → ExtractedObject only |
| `dmvExtractor.ts` | DMV rows → ExtractedObject only |
| `modelBuilder.ts` | ALL shared: buildModel, constraints, schemas, catalog |
| `types.ts` | Shared types + factory functions only |

**DRY checkpoint:** If logic operates on `ExtractedObject`/`ColumnDef`/`ConstraintMaps`/`SchemaInfo` → it belongs in shared code, not an extractor.

Shared types defined ONCE in `types.ts`. Never shadow with local aliases.

## Data Layer vs Rendering Layer

| Setting | Default | Controls |
|---------|---------|----------|
| `maxNodes` | 750 (max 10000) | Objects loaded into DatabaseModel |
| `renderLimit` | 750 | Nodes passed to dagre + React Flow |
| `overview.threshold` | 150 | Auto-activates schema overview |
| `forceOverviewThreshold` | 300 | Forces overview after manual toggle |

**Guard chain:** maxNodes → schema/type filters → renderLimit (BEFORE dagre) → forceOverview → overview.threshold

Extension host holds full model regardless. AI tools + BFS operate on full model — no render bottleneck. Graphology BFS is O(V+E), handles 10k+ nodes in milliseconds.

## Memory Architecture (SM = Data Provider)

SM stores and delivers — never filters, ranks, or evicts AI evidence.

**Inline vs hop-by-hop:** `shouldSmInline()` in `tokenBudget.ts` gates delivery mode. Small scopes (≤ `ai.inlineNodeCap` AND under `ai.inlineTokenBudget`) → inline: all DDL delivered at once, memory storage skipped. AI submits all verdicts via batch API (one call). Larger scopes → hop-by-hop with two-tier memory below. Both modes use the same SM for verdict validation.

**Two memories (hop-by-hop mode only) — different purposes:**
- **Short memory** (`narrative[]`): incremental index. ~100-200 chars per hop. Tracks what was loaded and what's still open. The AI sees ALL entries at every hop — this is how it stays on track.
- **Detail memory** (`detailSlots` Map): grounded evidence per node. Stored in local RAM (unlimited). Delivered at full fidelity — no budget pressure, no eviction. The AI does NOT see these during exploration — they come back only at synthesis.

**In inline mode:** `storeDetail()` stores only labels/captions (for `suggested_sections`). `updateShortMemory()` is skipped entirely — AI has all DDL in context.

**Detail memory depth depends on node classification:**
- `relevant`/`trace`: full extractive analysis (structured SQL evidence — columns, transforms, joins, filters, data flow)
- `pass`: summary only — what passes through, from where to where
- `irrelevant`/`prune`: summary only, node removed from graph

**Synthesis:** detail slots are the AI's ONLY evidence for `enrich_view`. If insufficient, AI re-reads DDL via `get_object_detail` in done phase.

**Design basis:** MemGPT/Letta (archival storage, no eviction), Chain-of-Note (self-contained notes), Self-RAG (retrieval on demand).

One code path in `HopStateMachine` base class → BB, CT, CT_DEP all inherit.

## Code Quality Gates

- **No magic numbers** — use `DEFAULT_CONFIG` from `types.ts`
- **No speculative types** — add when feature is implemented (YAGNI)
- **No pre-release deps** — stable releases only
- **Function size** — decompose at >100 lines
