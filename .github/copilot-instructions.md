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
| `assets/dmvQueries.yaml` | Built-in DMV queries (7 queries) |
| `docs/PARSE_RULES.md` | Custom parse rules guide |
| `docs/DMV_QUERIES.md` | Custom DMV queries guide |
| `docs/PROFILING_PATTERNS.md` | Table profiling SQL patterns reference |
| `src/ai/tools.ts` | AI tool pure functions (8 tools): 7 read-only queries + `validateEnrichView`. `shouldInline()` gates catalog/detail delivery mode (not CT/BB). Zero VS Code imports. |
| `src/ai/tokenBudget.ts` | Token budget: `INLINE_TOKEN_BUDGET`, `shouldInline()`, `estimateTokens()`, `CONTEXT_PRESSURE_THRESHOLD`, `REGEX_MAX_LENGTH`. CT/BB always use state machine; budget applies to catalog/detail tools only. Zero VS Code imports. |
| `src/ai/prompts.ts` | Central prompt dispatcher: `buildSystemPromptBase()`, `CT_MODE_PROMPT`, `CT_DEP_MODE_PROMPT`, `BB_MODE_PROMPT`. Zero VS Code imports. |
| `src/ai/aiPresenter.ts` | Compact LLM presentation layer: `strip()`, `presentNode/Column/Schema/Neighbor/Filter()`, `edgeApiType()` (explicit type map with 'read' fallback). Zero business logic, zero VS Code imports. |
| `src/ai/graphUtils.ts` | `buildBareGraph()` — connection-only graphology graph for BFS in AI tools |

## Testing Mandates

- **Deterministic Focus**: Only write tests for the **deterministic core** (SQL parsing, graph topology, BFS).
- **No UI/Hook Tests**: Do NOT write unit tests for React components, hooks, or UI routing. These are low-value and brittle.
- **Snapshot Baselines**: When changing `sqlBodyParser.ts` or `defaultParseRules.yaml`, you MUST run `npm run test:snapshot` and commit an updated `test/aw-baseline.tsv` if the changes are intended.
- **Internal Eval-Loop**: Deep AI/semantic testing is handled internally via a private `eval-loop` and is not part of the public PR process.

Press F5 to launch Extension Development Host.

## Test Suite

| File | Tests | Purpose |
|------|-------|---------|
| `test/dacpacExtractor.test.ts` | 89 | Dacpac extraction, filtering, edge integrity, Fabric SDK, security, constraints, `parseDspPlatform`, `dbPlatform`, `pkOrdinal`, Phase 1→2 bridge flow |
| `test/graphBuilder.test.ts` | 127 | Graph construction, layout, BFS trace, directional edge filtering, cycle filtering, bidirectional correctness, determinism, virtual external nodes, CLR method suppression, buildSchemaEdges, buildSchemaGraph |
| `test/parser-edge-cases.test.ts` | 204 | Syntactic parser tests: all 17 rules + edge cases + cleansing pipeline + regression guards |
| `test/graphAnalysis.test.ts` | 74 | Graph analysis: islands, hubs, orphans, longest path, cycles, external refs |
| `test/dmvExtractor.test.ts` | 146 | DMV extractor: synthetic data, column validation, type formatting, fallback body direction, constraints, external tables, schema placeholder expansion, `dbPlatform` via `mapEnginePlatform`, `pkOrdinal` from columns query |
| `test/tsql-complex.test.ts` | 5 | SQL pattern tests: targeted SQL files covering each parser pattern; expected results in `-- EXPECT` comments |
| `test/projectStore.test.ts` | 41 | Project store: createProject, updateProject, deleteProject, migrateProjectStore, generateProjectName, addFilterProfile, deleteFilterProfile, serializeFilter, deserializeFilter |
| `test-internal/ai-tools.test.ts` | 255 | AI tool pure functions: getContext, searchObjects, getObjectDetail, runBfsTrace (level + path mode), runAnalysis, searchDdl, getDdlBatch, validateEnrichView, autoFixEnrichView, validateQuery, safeRegex, validateMarkdownFormat |
| `test-internal/column-trace-state.test.ts` | 113 | Column-trace state machine: lifecycle, init, verdict processing (trace/pass/prune), rejection/retry, column validation, frontier cap, boundary detection (source/sink/external/cycle), synthetic model tests, bug regression (diamond merge, passthrough visited, depth, focus boundary) |
| `test-internal/blackboard-state.test.ts` | 64 | Blackboard state machine: lifecycle, findings, two-tier memory, Self-Ask questions, agenda priority, prune cascade, coverage tracking, boundary detection, edge cases |
| `test/hooks/useInteractiveTrace.test.ts` | 31 | Trace state machine: mode transitions, depth limits, direction filtering, startTraceConfig/Immediate/applyTrace/startPathFinding/applyPath/applyAnalysisSubset/endTrace, tracedNodes memoization |
| `test/hooks/useGraphology.test.ts` | 27 | Graph filter pipeline: schema filter, type filter, isolation filter (hideIsolated), exclusion patterns, focus schema, allowlist, external ref filter, graph/metrics state, rebuild behavior |
| `test/hooks/useOverviewMode.test.ts` | 18 | Overview mode state machine: auto-trigger, manual toggle, threshold guards, resetUserChoice |
| `test/hooks/useDacpacLoader.routing.test.tsx` | 30 | useDacpacLoader state machine: message routing (dacpac vs DB path), state transitions, callbacks, isDemo flag |
| `test/hooks/CreateFlow.save.test.tsx` | 3 | CreateFlow: save-project passes DacpacConnection to onVisualize |
| `test/hooks/App.save.test.tsx` | 3 | App-level save-project routing |
| `test/snapshot-aw-baseline.ts` | — | Parser regression baseline: diffs all 31 AW SPs against committed `test/aw-baseline.tsv` — run via `npm run test:snapshot` |
| `test/AdventureWorks.dacpac` | — | Classic style test dacpac |
| `test/AdventureWorks_sdk-style.dacpac` | — | SDK-style test dacpac |

```bash
npm test                            # All unit tests (1118 tsx + 115 vitest + snapshot)
npm run test:snapshot               # Parser baseline check only
npm run test:snapshot:update        # Regenerate test/aw-baseline.tsv after parser changes
npm run test:coverage               # Vitest with v8 coverage (requires @vitest/coverage-v8)
```

**tsx tests** (1118 total): run via `npx tsx test/<file>.test.ts`. Use `assert`, `assertEq`, `test`, `printSummary` from `./testUtils`.

**Vitest tests** (115 total): run via `npx vitest run --config vitest.config.ts`. Use `describe`, `it`, `expect`, `renderHook`, `act` (standard vitest + React Testing Library). Located in `test/hooks/`.

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

**Data provider for VS Code Copilot Chat.** Registers a chat participant (`@lineage`) and 13 language model tools (8 classic + 2 column-trace + 3 blackboard) via `vscode.lm.registerTool()`. VS Code + Copilot own all AI concerns (model selection, credentials, inference, streaming). The extension owns the tool server side — pure data queries against the loaded graph. The user selects the model in the Copilot chat dropdown.

**Explore-first architecture** — no upfront mode routing. AI discovers intent via tools. Dynamic tool filtering by phase:

| Phase | Tag filter | Tools visible | Transition |
|-------|-----------|---------------|------------|
| **discover** | `lineage` | All 13 tools (free-form) or filtered (slash commands) | `/trace` filters to 6 tools (CT path, no BFS); `/search` prompt rewrite only |
| **ct_active** | `lineage-ct` | 2 CT tools only | Entered when `start_column_trace` activates state machine |
| **ct_done** | `lineage` | All 13 tools restored | Entered when CT state machine completes; AI can `enrich_view` |
| **bb_active** | `lineage` minus `lineage-ct` | Classic 8 + BB 3 (CT excluded) | Entered when `start_exploration` activates state machine; CT mutual exclusion |
| **bb_done** | `lineage` | All 13 tools restored | Entered when BB state machine completes; AI can `enrich_view` |

**Key files:**
- `src/ai/tokenBudget.ts` — Token budget: `ai.inlineTokenBudget` setting (default 10K tokens), `shouldInline()`, `estimateTokens()`, `CONTEXT_PRESSURE_THRESHOLD`. Budget gates catalog/detail delivery; CT/BB always use state machine. Zero VS Code imports.
- `src/ai/prompts.ts` — Central prompt dispatcher: `buildSystemPromptBase()`, `CT_MODE_PROMPT`, `CT_DEP_MODE_PROMPT`, `BB_MODE_PROMPT`. Zero VS Code imports.
- `src/ai/tools.ts` — 8 pure tool functions (7 read-only queries + `validateEnrichView` write tool). Zero-truncation guarantee: DDL always returned in full. `shouldInline()` gates catalog/detail delivery. Soft errors `{ error: 'not_found' }` (no throw). Zero VS Code imports.
- `src/ai/aiPresenter.ts` — Compact LLM presentation layer. Owns: `strip()` (null/false/''/[] pruner), `edgeApiType()` (explicit type map with 'read' fallback), `presentNode/Column/Schema/Neighbor/Filter()`. Zero business logic, zero VS Code imports.
- `src/ai/graphUtils.ts` — `buildBareGraph()`: connection-only graphology graph used for BFS in `runBfsTrace`.
- `src/ai/blackboardState.ts` — Type 1 Blackboard state machine: free-form exploration with two-tier memory (MemGPT pattern). Passive SM: AI drives traversal via sub-questions, SM stores findings, manages agenda priority. Zero VS Code imports.
- `src/ai/toolProvider.ts` — 13 tool registrations (8 classic + 2 CT + 3 BB), dynamic tool filtering (5 phase transitions), `prepareInvocation` with `confirmationMessages` for write tool (`enrich_view`).
- `src/extension.ts` — chat participant registration, `isAiEnabled()`, participant handler.

**13 registered tools:**

| Tool | Tag | Kind | Purpose |
|------|-----|------|---------|
| `lineage_get_context` | lineage | read | Active project, filter, stats — call first. Inline catalog when `shouldInline()` passes |
| `lineage_search_objects` | lineage | read | Name/body search, returns IDs for other tools |
| `lineage_get_object_detail` | lineage | read | Full metadata + DDL body for one object |
| `lineage_run_bfs_trace` | lineage | read | BFS lineage trace. Level mode (depth) or path mode (start→end via `target` param) |
| `lineage_run_analysis` | lineage | read | Structural analysis: hubs/islands/orphans/longest-path/cycles |
| `lineage_search_ddl` | lineage | read | Regex search across SP/view/function DDL bodies |
| `lineage_get_ddl_batch` | lineage | read | Batch DDL retrieval for multiple objects by ID array |
| `lineage_enrich_view` | lineage | write | Create named AI bookmark with annotations |
| `lineage_start_column_trace` | lineage, lineage-ct | read | Init hop-by-hop CT state machine trace |
| `lineage_submit_hop_analysis` | lineage, lineage-ct | read | Submit verdicts, get next hop or final result |
| `lineage_start_exploration` | lineage, lineage-bb | read | Init BB state machine: free-form exploration with two-tier memory |
| `lineage_expand_frontier` | lineage, lineage-bb | read | Batch BFS expansion from boundary nodes (extra_hops param, default 2, max 5) |
| `lineage_submit_findings` | lineage, lineage-bb | read | Submit findings + summary, get next hop or final result |

**Two guards** (`src/ai/tokenBudget.ts`):
1. `ai.inlineTokenBudget` (VS Code setting, default 10K tokens) — catalog/detail delivery gate: inline vs on_demand hint. CT/BB always use state machine regardless.
2. `ai.maxRounds` (VS Code setting, default 50) — hard stop on tool rounds

**Zero-truncation guarantee:** No tool response is ever truncated, capped, or sliced. Fits budget → full data inline. Exceeds budget → state machine or on_demand hint. No per-tool caps exist.

**Conversation memory:** `context.history` is read each turn and prepended to `messages[]` so the model remembers earlier questions in the same chat session. Under context pressure (>75% of `maxInputTokens`), oldest turns are evicted (drop+log, not summarize).

**`ai.enabled` guard:** `isAiEnabled()` checked at both the chat participant level (returns disabled message) and in every tool `invoke()` handler (returns `{ error: 'disabled' }`).

**Column-trace state machine** (`src/ai/columnTraceState.ts`):
- Lifecycle: `init()` → `getHopContext()` ↔ `submitVerdicts()` → (frontier empty → full result)
- Verdict actions: `trace` (follow + track columns), `pass` (skip node, queue children), `prune` (drop node + subtree), `revisit` (re-expand previously pruned node, max 3/trace)
- Graph traversal uses NeighborIndex (O(1) neighbor lookup), NOT graphology — deliberate separation from classic BFS
- Column tracking: `activeColumns` per frontier entry, `columnsOut` for rename tracking (INSERT→SELECT mapping)
- Boundary detection: source/sink/external/cycle — deterministic, no AI input
- Column validation: tables only (case-insensitive, max 2 rejections/hop). SPs/views: accept on trust

**Blackboard state machine** (`src/ai/blackboardState.ts`):
- Lifecycle: `init(origin, question)` → BFS scope → `getHopContext()` ↔ `submitFindings()` → (agenda empty → full result)
- Two-tier memory (MemGPT pattern): `findings` (long-term, full detail per node) + `summary` (working memory, all summaries shown every hop)
- Priority agenda: question-boosted nodes (priority 2) > neighbors of noted (1) > BFS default (0)
- Self-Ask: AI generates sub-questions that boost target node priority and persist in `pending_questions`
- Goal anchor: `working_memory.user_question` repeats the original question every hop to prevent drift
- Hard limits: findings 5000 chars, summary 500 chars — rejected (not truncated)

**Goal anchoring** (anti-drift):
- CT: `goal: { columns, direction, origin }` repeated in every hop context — prevents losing track of original columns after renames
- BB: `working_memory.user_question` repeated every hop — prevents losing sight of original investigation question

**AI tests (3 tiers, 432 tests):** run via `npm run test:internal` (gitignored, local-only)
- `test-internal/ai-tools.test.ts` (255) — pure tool functions: getContext, search, detail, BFS (level + path), analysis, DDL, validate, autoFix
- `test-internal/column-trace-state.test.ts` (113) — CT state machine: lifecycle, verdicts, boundaries, goal anchoring, golden scenarios (multi-branch CT, hop mode, impact downstream)
- `test-internal/blackboard-state.test.ts` (64) — BB state machine: lifecycle, findings, two-tier memory, Self-Ask questions, agenda priority, goal anchoring, edge cases

- **AI Suite**: `npm run test:ai:quick` (PR gate) and `npm run test:ai:detail` (nightly). Uses `@vscode/test-electron` and real Copilot Chat tools.
- **Internal Eval-Loop**: Replaced by the `vscode-test` suite. Semantic testing is now programmatic and resides in `src/test/suite/ai-integration.test.ts`.
- **UAT Scenarios**: Transitioning to programmatic tests. Baseline reports are generated via `npm run test:baseline`.

