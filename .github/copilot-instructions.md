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
- `src/hooks/` — Graph state (`useGraphology`), trace state (`useInteractiveTrace`), loader (`useDacpacLoader` — handles both dacpac and DB sources)
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
| `test/dacpacExtractor.test.ts` | 63 | Dacpac extraction, filtering, edge integrity, Fabric SDK, direction, security, constraints |
| `test/graphBuilder.test.ts` | 156 | Graph construction, layout, BFS trace, directional edge filtering, cycle filtering, bidirectional correctness, determinism, virtual external nodes, CLR method suppression |
| `test/parser-edge-cases.test.ts` | 192 | Syntactic parser tests: all 17 rules + edge cases + cleansing pipeline + regression guards |
| `test/graphAnalysis.test.ts` | 62 | Graph analysis: islands, hubs, orphans, longest path, cycles, external refs |
| `test/dmvExtractor.test.ts` | 161 | DMV extractor: synthetic data, column validation, type formatting, fallback body direction, constraints, external tables, schema placeholder expansion |
| `test/tsql-complex.test.ts` | 54 | SQL pattern tests: targeted SQL files covering each parser pattern; expected results in `-- EXPECT` comments |
| `test/profilingEngine.test.ts` | 75 | Table statistics: query generation, column classification, aggregation building, sampling logic, result parsing |
| `test/AdventureWorks.dacpac` | — | Classic style test dacpac |
| `test/AdventureWorks_sdk-style.dacpac` | — | SDK-style test dacpac |

```bash
npm test                  # Run all unit tests
```

Shared test helpers in `test/testUtils.ts` — `assert()`, `assertEq()`, `test()`, `loadParseRules()`, `testPath()`, `printSummary()`, `makeGraph()`. Import from `./testUtils` in new test files.

Only `AdventureWorks*.dacpac` allowed in `test/`. Customer data and identifiers must never appear in public source code, test files, or comments. Customer data goes in `customer-data/` (gitignored). Internal tests (live DB, baseline snapshots) in `test-internal/` (gitignored).


## Code Rules

- TypeScript strict mode
- Never hardcode CSS colors — use `var(--ln-*)` or `var(--vscode-*)` custom properties
- Graph traversal uses graphology `bfsFromNode` — no manual BFS
- Layout uses shared `dagreLayout()` helper
- BFS must be pure — callbacks use only edges, nodes, and direction. No business logic or semantic filtering inside BFS callbacks. Depth limits control trace scope.
- Bidirectional connections = two antiparallel directed edges (Table→SP for read, SP→Table for write). React Flow merges them into ⇄ display via `buildFlowEdges()`.
- **Co-writer post-filter** (`trace.hideCoWriters`, default: true): When a SP both reads and writes the same table, BFS upstream finds all other writers to that table. These are co-writers — parallel writers, not true upstream producers. `filterCoWriters()` runs as post-processing on the BFS result subset — if the origin writes to a table, nodes that only write (no read) to that same table are excluded. Bidirectional nodes (read+write) are kept. Controlled by `dataLineageViz.trace.hideCoWriters` setting. This follows the input/output separation pattern used by Apache Atlas and OpenMetadata.
- Settings prefix: `dataLineageViz`

## Message Passing (Extension <-> Webview)

Key messages: `ready`, `config-only`, `dacpac-data`, `show-ddl`, `update-ddl`, `log`, `error`, `themeChanged`

Database messages: `check-mssql`, `mssql-status`, `db-connect`, `db-reconnect`, `db-visualize`, `db-progress`, `db-schema-preview`, `db-model`, `db-error`, `db-cancelled`

Other: `open-dacpac`, `load-last-dacpac`, `last-dacpac-gone`, `load-demo`, `open-external`, `open-settings`, `save-schemas`, `parse-rules-result`, `parse-stats`, `reload`, `export-file`

Table statistics: `table-stats-request` (Webview → Extension), `table-stats-result`, `table-stats-error` (Extension → Webview)

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
