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

**Data provider for VS Code Copilot Chat.** Registers a chat participant (`@lineage`) and **10 language model tools** via `vscode.lm.registerTool()`. VS Code + Copilot own all AI concerns (model selection, credentials, inference, streaming). The extension owns the tool server side — pure data queries against the loaded graph. The user selects the model in the Copilot chat dropdown.

**Architecture: Unified Navigation Engine.** One grounded state machine (`NavigationEngine` in `src/ai/smBase.ts`) with `mode: 'blackboard' | 'column_trace'`. Implements a "Map & Router" pattern: the engine owns topology + agenda, the AI owns the narrative (Blackboard) and evidence (Archive), and every hop requires a specific technical hypothesis per neighbor (Selection-Inference Routing).

**Three chat phases:**

| Phase | Tools visible | Transition |
|-------|---------------|------------|
| **discover** | All 8 classic tools + `start_exploration` | `start_exploration` called → `active` |
| **active** | Engine tools only (`start_exploration`, `submit_findings`) | Engine `status === 'complete'` → `done` |
| **done** | Classic tools restored (minus `submit_findings`) | End of request |

**10 registered tools:**

| Tool | Tag | Kind | Purpose |
|------|-----|------|---------|
| `lineage_get_context` | lineage | read | Active project, filter, stats — call first |
| `lineage_search_objects` | lineage | read | Name/column substring or regex search |
| `lineage_get_object_detail` | lineage | read | Full metadata + DDL body for one object |
| `lineage_run_bfs_trace` | lineage | read | BFS lineage trace. Level mode (depth) or path mode (start→end via `target`) |
| `lineage_run_analysis` | lineage | read | Structural analysis: hubs / islands / orphans / longest-path / cycles / external-refs |
| `lineage_search_ddl` | lineage | read | Regex search across SP/view/function DDL bodies |
| `lineage_get_ddl_batch` | lineage | read | Batch DDL retrieval for up to 20 IDs |
| `lineage_enrich_view` | lineage | write | Create annotated AI graph view from completed engine result |
| `lineage_start_exploration` | lineage, lineage-engine | read | Boot the NavigationEngine; `targetColumns` param → column_trace mode |
| `lineage_submit_findings` | lineage, lineage-engine | read | Per-hop: narrative + detail + verdict + route requests |

**Guard test:** `tests/unit/ai-tool-registration.test.ts` parses the manifest and the provider source to assert registration count matches declaration count — prevents the class of regression where a tool is declared but never wired.

**Key files:**
- `src/ai/smBase.ts` — `NavigationEngine` (unified state machine) + `IHopStateMachine` interface. `bfsFromNode` from `graphology-traversal` for scope discovery. Priority agenda (3=origin, 2=AI-requested, 0=BFS-seeded).
- `src/ai/smTypes.ts` — concrete types: `HopContext`, `HopSubmission`, `RouteRequest`, `SubmitResult`, `SmResult`, `HopLogEntry`.
- `src/ai/smGuards.ts` — pure graph primitives: `wouldOrphanNotedNode`, `countCascadeIfPruned`, `bfsReachable`, `findBridgeNodes`, `bfsDepthMap`, `validateNodeIds`.
- `src/ai/memoryManager.ts` — two-tier memory (Blackboard short memory + Detail Archive long memory, MemGPT pattern).
- `src/ai/tools.ts` — 10 pure tool functions, `shouldSmInline()` delivery gate, Zero-truncation guarantee. Zero VS Code imports.
- `src/ai/aiPresenter.ts` — compact LLM presentation layer. Owns `strip()`, `edgeApiType()`, `presentNode/Column/Schema/Neighbor/Filter()`.
- `src/ai/prompts.ts` — system prompt base, trace/search prompts, action-required gate.
- `src/ai/smPrompts.ts` — `buildNavigationPrompt(mode)`, `buildSynthesisPrompt()`.
- `src/ai/toolProvider.ts` — 10 tool registrations, `prepareInvocation` hooks.
- `src/ai/lineageParticipant.ts` — chat request handler, 3-phase tool filtering, sliding-memory context wipe after successful hops, Phase 3 evidence injection.
- `src/ai/session.ts` — `AiSession` singleton: model, graph, column store, NavigationEngine instance, memory, project context.
- `src/extension.ts` — chat participant registration, `isAiEnabled()`.

**Guards:**
1. `ai.maxRounds` (VS Code setting, default 50) — hard tool-round cap.
2. `ai.inlineNodeCap` (10) AND `ai.inlineTokenBudget` (10K tokens) — `shouldSmInline()` delivery gate. Small scopes → inline (AI gets all DDL). Larger → hop-by-hop with sliding memory.
3. Cascade-prune guards (`src/ai/smGuards.ts`): `wouldOrphanNotedNode` (rejects prune if it would disconnect a noted node) + 50% cascade threshold (rejects prunes that wipe most of the agenda). Origin exempt.
4. Selection-Inference Validation: rejects route requests for unknown nodeIds / columns. AI self-corrects.
5. `action_required` gate — blocks non-search tools until the AI produces a prose response. Search tools bypass.
6. Context-pressure eviction: history > 75% `maxInputTokens` → oldest turns dropped with an eviction stub. Never summarized.

**Zero-truncation guarantee:** DDL is never truncated, capped, or sliced. The only boundary is the `shouldSmInline()` delivery mode choice.

**Verdict semantics (unified across modes):**
- `relevant` — has logic/transforms → full findings stored, kept in result.
- `pass` — pure passthrough (identity view, SELECT *) → full findings stored as context, no badge.
- `irrelevant` — utility only (logging) → NOT stored, cascade-pruned from graph via `bfsReachable` on `removedSet`. Orphan + 50%-cascade guards reject unsafe prunes.

**Bridge-node reconnection:** `getResult()` calls `findBridgeNodes` to reconnect orphan noted nodes through intermediate paths. Diamond-safe. `bfsDepthMap` assigns data-flow depth → auto-generates `suggested_sections` (Origin, Stage 1, …) for `enrich_view`.

**Sliding memory:** After each successful `submit_findings`, message history is wiped to `systemPrompt + userPrompt + lastAssistantPart + lastToolResult`. On tool error (route_validation_failed, orphan_rejection, cascade_too_wide, invalid_status, focus_mismatch) history is preserved so the AI sees its own mistake.

**AI tests:** run via `npm run test:unit:ai`
- `tests/unit/ai-tools.test.ts` — pure tool functions
- `tests/unit/navigation-engine.test.ts` (15 tests) — engine lifecycle, memory, Selection-Inference, unification modes
- `tests/unit/navigation-engine-cascade.test.ts` (11 tests) — cascade-prune contract
- `tests/unit/ai-tool-registration.test.ts` — manifest ↔ registration guard (runs under `npm test`)

