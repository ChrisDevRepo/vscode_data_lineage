# Project Context

VS Code extension for visualizing SQL database object dependencies from .dacpac files or database import (via MSSQL extension). React + ReactFlow frontend, graphology for graph data, dagre for layout.

## Architecture

| Runtime | Bundler | Entry | Output |
|---------|---------|-------|--------|
| Node.js (extension host) | esbuild | `src/extension.ts` | `out/extension.js` (CJS) |
| Browser (webview) | Vite | `src/index.tsx` | `dist/assets/index.js` (ESM) |

### Key Directories

- `src/engine/` — dacpac extraction, database import, SQL parsing, graph building
- `src/components/` — React UI (ReactFlow canvas, toolbar, filters, modals)
- `src/hooks/` — Graph state (`useGraphology`), trace state (`useInteractiveTrace`), loader (`useDacpacLoader` — handles both dacpac and DB sources), dropdown state (`useDropdown` — shared open/close + outside-click), overview mode (`useOverviewMode` — schema-level view state machine, auto-trigger guard, `resetUserChoice`)
- `src/extension.ts` — VS Code API, webview lifecycle, message routing

### Extraction Pipeline (DRY principle)

Both dacpac and database import produce `ExtractedObject[]` + `ExtractedDependency[]` + `ConstraintMaps`.
Post-extraction logic (schema aggregation, constraint enrichment, catalog building) lives exclusively
in `modelBuilder.ts` and `types.ts`. The extractors are thin format adapters — they translate their
source format into the shared intermediate types and nothing more.

### Key Files

| File | Purpose |
|------|---------|
| `src/engine/connectionManager.ts` | MSSQL extension API wrapper, connection management |
| `src/engine/dmvExtractor.ts` | Build DacpacModel from database import via DMV queries |
| `src/types/mssql.d.ts` | Type declarations for MSSQL extension API |
| `assets/defaultParseRules.yaml` | Built-in parse rules (17 rules, 5 categories) |
| `assets/dmvQueries.yaml` | Built-in DMV queries (6 queries) |
| `docs/PARSE_RULES.md` | Custom parse rules guide |
| `docs/DMV_QUERIES.md` | Custom DMV queries guide |
| `docs/PROFILING_PATTERNS.md` | Table profiling SQL patterns reference |
| `src/ai/tools.ts` | AI tool pure functions (10 tools): 9 read-only queries + `validateCreateAiView`. `AI_CAPS` defaults, `AiCapsOverride` type. Imports presentation from `aiPresenter.ts`. Zero VS Code imports. |
| `src/ai/aiPresenter.ts` | Compact LLM presentation layer: `strip()`, `presentNode/Column/Schema/Neighbor/Filter()`, `edgeApiType()`, `withCap()`. Zero business logic, zero VS Code imports. |
| `src/ai/graphUtils.ts` | `buildBareGraph()` — connection-only graphology graph for BFS in AI tools |

## Build & Test

```bash
npm run build    # Build extension + webview
npm run watch    # Watch extension only
npm test         # All unit tests
```

Press F5 to launch Extension Development Host.

## Test Suite

| File | Tests | Purpose |
|------|-------|---------|
| `test/dacpacExtractor.test.ts` | 110 | Dacpac extraction, filtering, edge integrity, Fabric SDK, direction, security, constraints, `parseDspPlatform`, `dbPlatform`, `pkOrdinal`, Phase 1→2 bridge flow |
| `test/graphBuilder.test.ts` | 218 | Graph construction, layout, BFS trace, directional edge filtering, cycle filtering, bidirectional correctness, determinism, virtual external nodes, CLR method suppression, buildSchemaEdges, buildSchemaGraph |
| `test/parser-edge-cases.test.ts` | 197 | Syntactic parser tests: all 17 rules + edge cases + cleansing pipeline + regression guards |
| `test/graphAnalysis.test.ts` | 81 | Graph analysis: islands, hubs, orphans, longest path, cycles, external refs |
| `test/dmvExtractor.test.ts` | 193 | DMV extractor: synthetic data, column validation, type formatting, fallback body direction, constraints, external tables, schema placeholder expansion, `dbPlatform` via `mapEnginePlatform`, `pkOrdinal` from columns query |
| `test/tsql-complex.test.ts` | 55 | SQL pattern tests: targeted SQL files covering each parser pattern; expected results in `-- EXPECT` comments |
| `test/projectStore.test.ts` | 153 | Project store: createProject, updateProject, deleteProject, migrateProjectStore, generateProjectName, addFilterProfile, deleteFilterProfile, serializeFilter, deserializeFilter |
| `test/ai-tools.test.ts` | 95 | AI tool pure functions: getContext, getSchemasSummary, searchObjects (incl. include_body), getObjectDetail (incl. inline neighbors), runBfsTrace (incl. truncation cap), runAnalysis, searchDdl, validateSaveView, safeRegex |
| `test/hooks/useInteractiveTrace.test.ts` | 56 | Trace state machine: mode transitions, depth limits, direction filtering, startTraceConfig/Immediate/applyTrace/startPathFinding/applyPath/applyAnalysisSubset/endTrace, tracedNodes memoization |
| `test/hooks/useGraphology.test.ts` | 34 | Graph filter pipeline: schema filter, type filter, isolation filter (hideIsolated), exclusion patterns, focus schema, allowlist, external ref filter, graph/metrics state, rebuild behavior |
| `test/hooks/useDacpacLoader.routing.test.tsx` | 30 | useDacpacLoader state machine: message routing (dacpac vs DB path), state transitions, callbacks, isDemo flag |
| `test/snapshot-aw-baseline.ts` | — | Parser regression baseline: diffs all 31 AW SPs against committed `test/aw-baseline.tsv` — run via `npm run test:snapshot` |
| `test/AdventureWorks.dacpac` | — | Classic style test dacpac |
| `test/AdventureWorks_sdk-style.dacpac` | — | SDK-style test dacpac |

```bash
npm test                            # All unit tests (1086 tsx + 126 vitest + snapshot)
npm run test:snapshot               # Parser baseline check only
npm run test:snapshot:update        # Regenerate test/aw-baseline.tsv after parser changes
npm run test:coverage               # Vitest with v8 coverage (requires @vitest/coverage-v8)
```

**tsx tests** (1086 total): run via `npx tsx test/<file>.test.ts`. Use `assert`, `assertEq`, `test`, `printSummary` from `./testUtils`.

**Vitest tests** (126 total): run via `npx vitest run --config vitest.config.ts`. Use `describe`, `it`, `expect`, `renderHook`, `act` (standard vitest + React Testing Library). Located in `test/hooks/`.

Only `AdventureWorks*.dacpac` allowed in `test/`. Customer data and identifiers must never appear in public source code, test files, or comments. Customer data goes in `customer-data/` (gitignored). Internal tests (live DB, baseline snapshots) in `test-internal/` (gitignored).


## Code Rules

- TypeScript strict mode
- Never hardcode CSS colors — use `var(--ln-*)` or `var(--vscode-*)` custom properties
- Graph traversal uses graphology `bfsFromNode` — no manual BFS
- Layout uses shared `dagreLayout()` helper
- BFS must be pure — callbacks use only edges, nodes, and direction. No business logic or semantic filtering inside BFS callbacks. Depth limits control trace scope.
- Bidirectional connections = two antiparallel directed edges (Table→SP for read, SP→Table for write). React Flow merges them into ⇄ display via `buildFlowEdges()`.
- Settings prefix: `dataLineageViz`

## Message Passing (Extension <-> Webview)

Key messages: `ready`, `config-only`, `dacpac-data`, `show-detail`, `update-detail`, `close-detail`, `detail-update`, `detail-closed`, `log`, `error`, `themeChanged`, `filter-changed`

Dacpac messages: `dacpac-schema-preview` (Phase 1 result), `dacpac-visualize` (Phase 2 trigger), `dacpac-model` (Phase 2 result + demo + panel restore)

Database messages: `check-mssql`, `mssql-status`, `db-connect`, `db-schema-preview`, `db-visualize`, `db-progress`, `db-model`, `db-error`, `db-cancelled`

Project messages: `save-project`, `load-project`, `delete-project`, `save-view`, `delete-view`, `projects-list` (Extension → Webview)

Table statistics: `table-stats-request` (Webview → Extension), `table-stats-result`, `table-stats-error` (Extension → Webview)

Other: `open-dacpac`, `last-dacpac-gone`, `load-demo`, `open-external`, `open-settings`, `parse-rules-result`, `parse-stats`, `reload`, `export-file`

## YAML Loading & Failsafe Chain

Both YAML files (`defaultParseRules.yaml`, `dmvQueries.yaml`) support user overrides via VS Code settings. The loading chain is: **custom file → validate → use custom; on any failure → warn user (outputChannel + VS Code dialog) → fall back to built-in**.

| YAML | Setting | Loaded when | Fallback |
|------|---------|-------------|----------|
| `assets/defaultParseRules.yaml` | `dataLineageViz.parseRulesFile` | Extension startup (`readExtensionConfig`) | Built-in; if both fail: no regex edges, user warned |
| `assets/dmvQueries.yaml` | `dataLineageViz.dmvQueriesFile` | DB import initiated (`loadDmvQueries`) | Built-in; if both fail: `db-error` to user |

**Parse rules validation** (two-phase): extension host validates YAML structure (`rules` array); webview validates each rule individually (name, pattern, category, flags, regex compile, empty-match check). Invalid rules are skipped — valid rules still load. Results posted back via `parse-rules-result`.

**DMV queries validation**: checks `name` + `sql` fields per query. Required query names (`schema-preview`, `all-objects`, `nodes`, `columns`, `dependencies`) are validated at load time (early warning) and at execution time (hard guard — throws descriptive error if missing).

Scaffold commands: `dataLineageViz.createParseRules`, `dataLineageViz.createDmvQueries` — copy built-in YAML to workspace root for customization.

## SQL Parse Rules

Stored procedures use regex-based body parsing (`sqlBodyParser.ts`). Rules defined in `assets/defaultParseRules.yaml` (single source of truth, 17 rules across 5 categories: preprocessing, source, target, exec, external_ref).

Views/functions use MS metadata as the primary source (dacpac XML `BodyDependencies` / `sys.sql_expression_dependencies`). As a supplement, `modelBuilder.ts` also runs the parser on their body scripts to catch any gaps in MS metadata — only the **delta** (parser findings beyond what metadata already captured) is recorded in `spDetails` (as `inRefs`) and surfaced in the NodeInfoBar detail panel. SQL Server XML type method calls (`nodes`, `value`, `exist`, `query`, `modify`) are recognized by the supplement and skipped — they look like `[alias].[method]` to the parser but are never real catalog references.

When regex misses a dep that MS metadata (XML/DMV) knows about, a fallback in `modelBuilder.ts` applies:
- Procedure dep → EXEC outbound edge
- Table dep → `inferBodyDirection()` scans the raw body for the table name after a write keyword (UPDATE/INSERT/MERGE/TRUNCATE TABLE); WRITE if found, READ otherwise
- View/function dep → READ inbound (read-only by SQL design)

The DMV `dependencies` query filters to `referenced_schema_name IS NOT NULL AND referenced_entity_name IS NOT NULL` — unqualified (schema-less) refs where SQL Server cannot determine the target schema are excluded at the SQL Server level.

### Cleansing Pipeline (runs before any YAML rule)

Four TypeScript passes run before YAML rules ever see the SQL body:

**Pass 0 — `removeBlockComments()`** (counter-scan, O(n)):
Removes nested block comments correctly. Regex cannot solve nesting depth — a TypeScript counter-scan is required.
`/* outer /* inner */ still outer */` → all removed, including the tail.

**Pass 1 — Leftmost-match regex** (`/\[[^\]]+\]|"[^"]*"|'(?:''|[^'])*'|--[^\r\n]*/g`):
Using the "Best Regex Trick" — leftmost match wins, so bracket/string/comment tokens are consumed before competing patterns can fire:
- `[bracket identifiers]` → preserved as-is
- `"double-quoted identifiers"` → converted to `[bracket]` notation
- `'string literals'` → neutralized to `''` (content cannot trigger false matches)
- `-- line comments` → replaced with space

**Pass 1.5 — `normalizeAnsiCommaJoins()`** (TypeScript rewrite):
Rewrites ANSI SQL-92 comma-joins to explicit JOIN syntax so the `FROM/JOIN` extraction rule can find all tables:
`FROM t1, t2, t3` → `FROM t1 JOIN t2 JOIN t3`
SELECT-list commas are safe: they always appear before the first `FROM` keyword in a query.

**Pass 1.6 — `substituteCteUpdateAliases()`** (TypeScript rewrite):
Resolves CTE aliases in `UPDATE cte SET` statements to the CTE's real base table.
`WITH cte AS (SELECT … FROM [dbo].[T]) UPDATE cte SET …` → `… UPDATE [dbo].[T] SET …`
Only fires for known CTE names; a keyword guard prevents SQL keywords from being treated as CTE names.
**Known limitation**: chained CTEs (`WITH c2 AS (SELECT … FROM c1) UPDATE c2`) are not resolved — `c1` has no schema dot so `fromMatch` returns null for `c2`. Zero occurrences in 448 SPs checked; documented in `test/sql/targeted/cte_chained_limitation.sql`.

**Not supported — no whitespace before bracket identifiers**: `from[dbo].[T]` and `exec[dbo].[sp]` (no space between keyword and `[`) are not detected. All YAML rules require at least one space. This is valid T-SQL but extremely rare; standard SQL formatters always insert the space.

**What YAML rule authors see** (what the regex receives):
```sql
-- ORIGINAL:
SELECT col FROM [dbo].[Orders] /* comment */ JOIN "staging"."Log" ON ... WHERE x = 'don''t'
EXEC [dbo].[sp_Proc]

-- AFTER CLEANSING:
SELECT col FROM [dbo].[Orders]  JOIN [staging].[Log] ON ... WHERE x = ''
EXEC [dbo].[sp_Proc]
```

Rule authors never need to handle comments, string content, or double-quoted identifiers — these are always gone before the YAML regex runs.

### Capture Normalization (`normalizeCaptured()`)

After each YAML rule captures a name, `normalizeCaptured()` in `sqlBodyParser.ts` normalizes it before catalog lookup:
- Strips `[]` and `"` delimiters
- Splits on dots **outside** bracket-quoted identifiers (`splitSqlName()` in `src/utils/sql.ts`) — dots inside `[sp.with.dots]` are part of the name, not separators
- `@tableVariable` / `#TempTable` → rejected (`null`) — never in catalog
- Unqualified names (no dot) → rejected — schema.object minimum required
- 2-part `dbo.Orders` → `[dbo].[orders]` ✅
- 3-part `MyDB.dbo.Orders` → `[dbo].[orders]` (database prefix dropped) ✅
- 4-part `Server.DB.dbo.Orders` → rejected (linked server, never local) ✅
- Result is lowercased for case-insensitive catalog lookup

Rule authors write patterns that capture the raw SQL name — normalization is handled automatically.

### Known Limitations

**Cross-DB virtual nodes from CLR type method calls (suppressed):** SQL Server CLR type method calls (HierarchyID: `GetAncestor`, `GetLevel`, `ToString`; XML: `.value()`, `.nodes()`, `.query()`; Geometry/Geography: all `ST*` methods) look identical to cross-database 3-part references (`alias.column.Method`) to the regex parser. These are filtered at `normalizeCrossDb()` in `sqlBodyParser.ts` using a `CLR_TYPE_METHODS` set, and at the DMV metadata path in `modelBuilder.ts`. Side effect: a real cross-DB table/view whose name exactly matches a CLR method name (e.g. `OtherDB.dbo.nodes`) will not create a virtual external node — this is an acceptable trade-off.

**Cross-DB inline scalar UDF calls not tracked:** `OtherDB.dbo.fn_calc(x)` captured by `extract_udf_calls` could in principle create a cross-DB virtual node, but any cross-DB TVF call via CROSS APPLY and table references via FROM/JOIN do create virtual nodes correctly.

### Modifying Parse Rules

When modifying `assets/defaultParseRules.yaml` or `sqlBodyParser.ts`: run full 3-dacpac baseline comparison (301 SPs). `npm test` alone is not sufficient.

```bash
# run full 3-dacpac baseline comparison before and after changes
diff tmp/baseline.tsv tmp/after.tsv   # must be empty or positive only
npm test                               # all suites must pass
```

## AI Chat Participant (`@lineage`)

VS Code Copilot chat participant registered via `vscode.chat.createChatParticipant()`. NOT a standalone AI framework — the model (GPT-4o, Claude Sonnet, Gemini, local Ollama LLM) is selected by the user in the Copilot chat dropdown.

**Key files:**
- `src/ai/tools.ts` — 10 tool functions (9 read-only queries + `validateCreateAiView` write tool). `AI_CAPS` (SEARCH=50, BFS_N=200, BFS_E=300, GROUPS=100, DDL=10000), `AiCapsOverride` type. Zero VS Code imports. Imports `strip()` and all presenters from `aiPresenter.ts`. Soft errors `{ error: 'not_found' }` (no throw). DDL too large → `{ ddl: null, ddl_too_large: true, ddl_chars: N }` (never partial DDL).
- `src/ai/aiPresenter.ts` — Compact LLM presentation layer extracted from `tools.ts`. Owns: `strip()` (null/false/''/[] pruner), `edgeApiType()` (`'body'`→`'read'`), `presentNode/Column/Schema/Neighbor/Filter()`, `withCap()`. Zero business logic, zero VS Code imports — shape changes here propagate to all tools automatically.
- `src/ai/graphUtils.ts` — `buildBareGraph()`: connection-only graphology graph used for BFS in `runBfsTrace`.
- `src/extension.ts` — chat participant registration, 10 tool registrations (`readOnlyHint` on 8 read tools), `readAiCaps()`, `autoScaleTier()`, `isAiEnabled()`, participant handler.

**10 registered tools** (all tagged `"lineage"`, hidden via `"when": "dataLineageViz.modelLoaded"` when no graph is loaded):

| Tool | Kind | Purpose |
|------|------|---------|
| `lineage_get_context` | read | Active project, platform, filter state, model stats — call first each conversation |
| `lineage_get_schemas_summary` | read | All schemas with per-type object counts |
| `lineage_search_objects` | read | Name/body search, returns IDs for other tools. `scope=visible` restricts to screen |
| `lineage_get_object_detail` | read | Full metadata + DDL body for one object; inline up/dn neighbors |
| `lineage_get_neighbors` | read | 1-hop upstream/downstream neighbors with edge types |
| `lineage_run_bfs_trace` | read | Multi-hop BFS lineage trace; `incomplete=true` means capped — narrow scope or reduce hops |
| `lineage_run_analysis` | read | Structural analysis: hubs/islands/orphans/longest-path/cycles |
| `lineage_search_ddl` | read | Full-text regex search across SP/view/function DDL bodies |
| `lineage_save_view` | write | Bookmark current filter state (schemas/types/search) as named view |
| `lineage_create_ai_view` | write | Create named AI bookmark: node set, highlight groups (up to 5), badges (up to 50), narrative |

**Auto-scaling caps** — set via `request.model.maxInputTokens` per request → `autoScaleTier()`:

| Model context | SEARCH | BFS nodes | BFS edges | GROUPS | DDL chars |
|---|---|---|---|---|---|
| < 32K (small local LLM) | 20 | 100 | 150 | 50 | 4000 |
| 32K–128K (GPT-4o, medium) | 50 | 200 | 300 | 100 | 10000 |
| > 128K (Claude Sonnet, large) | 100 | 400 | 600 | 200 | 500000 |

Explicit `dataLineageViz.ai.*` VS Code settings override auto-scale (detected via `cfg.inspect()` checking `globalValue`/`workspaceValue`).

**DDL size policy:** When `MAX_DDL_CHARS` exceeded, `getObjectDetail` returns `{ ddl: null, ddl_too_large: true, ddl_chars: N, ddl_hint: "..." }` — NOT partial DDL. Partial DDL misleads the LLM.

**Conversation memory:** `context.history` is read each turn and prepended to `messages[]` so the model remembers earlier questions in the same chat session.

**`ai.enabled` guard:** `isAiEnabled()` checked at both the chat participant level (returns disabled message) and in every tool `invoke()` handler (returns `{ error: 'disabled' }`).

**Unit tests:** `test/ai-tools.test.ts` (95 tests) covers all pure tool functions (`getContext`, `getSchemasSummary`, `searchObjects` incl. `include_body`, `getObjectDetail` incl. inline neighbors, `runBfsTrace` incl. truncation, `runAnalysis`, `searchDdl`, `validateSaveView`, `validateCreateAiView`, `safeRegex`). Does not test `extension.ts` wiring (VS Code dependency).
