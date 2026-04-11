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

**Inline vs hop-by-hop:** `shouldSmInline()` in `tokenBudget.ts` gates delivery. Small scopes → inline (all DDL at once, batch verdicts). Larger scopes → hop-by-hop with two-tier memory. Both use same SM for verdict validation.

**Two memories (hop-by-hop only):**
- **Short memory** (`narrative[]`): incremental index, ~100-200 chars/hop, all entries visible every hop
- **Detail memory** (`detailSlots` Map): grounded evidence per node, local RAM, full fidelity, no eviction. Delivered only at synthesis.

Detail depth: `relevant`/`trace` → full analysis; `pass` → summary; `irrelevant`/`prune` → summary + removed.

One code path in `HopStateMachine` base class → BB, CT, CT_DEP inherit.
