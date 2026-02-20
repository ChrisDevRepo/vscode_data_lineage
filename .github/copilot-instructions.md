# Project Context

VS Code extension for visualizing SQL database object dependencies from .dacpac files or live database connections. React + ReactFlow frontend, graphology for graph data, dagre for layout.

## Architecture

| Runtime | Bundler | Entry | Output |
|---------|---------|-------|--------|
| Node.js (extension host) | esbuild | `src/extension.ts` | `out/extension.js` (CJS) |
| Browser (webview) | Vite | `src/index.tsx` | `dist/assets/index.js` (ESM) |

### Key Directories

- `src/engine/` — dacpac extraction, live DB extraction, SQL parsing, graph building
- `src/components/` — React UI (ReactFlow canvas, toolbar, filters, modals)
- `src/hooks/` — Graph state (`useGraphology`), trace state (`useInteractiveTrace`), loader (`useDacpacLoader` — handles both dacpac and DB sources)
- `src/extension.ts` — VS Code API, webview lifecycle, message routing

### Key Files

| File | Purpose |
|------|---------|
| `src/engine/connectionManager.ts` | MSSQL extension API wrapper, connection management |
| `src/engine/dmvExtractor.ts` | Build DacpacModel from live database DMV queries |
| `src/types/mssql.d.ts` | Type declarations for MSSQL extension API |
| `assets/dmvQueries.yaml` | Built-in DMV queries for live database extraction |

## Build & Test

```bash
npm run build    # Build extension + webview
npm run watch    # Watch extension only
npm test         # All tests (342 total)
```

Press F5 to launch Extension Development Host.

## Test Suite

| File | Tests | Purpose |
|------|-------|---------|
| `test/dacpacExtractor.test.ts` | 43 | Dacpac extraction, filtering, edge integrity, Fabric SDK, direction, security |
| `test/graphBuilder.test.ts` | 47 | Graph construction, layout, BFS trace, co-writer filter |
| `test/parser-edge-cases.test.ts` | 142 | Syntactic parser tests: all 12 rules + edge cases + cleansing pipeline + regression guards |
| `test/graphAnalysis.test.ts` | 59 | Graph analysis: islands, hubs, orphans, longest path, cycles |
| `test/dmvExtractor.test.ts` | 51 | DMV extractor: synthetic data, column validation, type formatting |
| `test/webview.integration.test.ts` | — | VS Code integration tests |
| `test/AdventureWorks.dacpac` | — | Classic style test dacpac |
| `test/AdventureWorks_sdk-style.dacpac` | — | SDK-style test dacpac |

```bash
npm test              # Run all tests (342 total)
npm run test:integration  # Run VS Code tests
```

Only `AdventureWorks*.dacpac` allowed in `test/`. Customer data goes in `customer-data/` (gitignored).

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

Other: `open-dacpac`, `load-last-dacpac`, `last-dacpac-gone`, `load-demo`, `open-external`, `open-settings`, `save-schemas`, `parse-rules-result`, `parse-stats`

## SQL Parse Rules

Stored procedures use regex-based body parsing (`sqlBodyParser.ts`). Rules defined in `assets/defaultParseRules.yaml` (single source of truth, 12 rules across 4 categories: preprocessing, source, target, exec). Views/functions use dacpac XML dependencies directly.

### Cleansing Pipeline (runs before any YAML rule)

Two TypeScript passes run before YAML rules ever see the SQL body:

**Pass 0 — `removeBlockComments()`** (counter-scan, O(n)):
Removes nested block comments correctly. Regex cannot solve nesting depth — a TypeScript counter-scan is required.
`/* outer /* inner */ still outer */` → all removed, including the tail.

**Pass 1 — Leftmost-match regex** (`/\[[^\]]+\]|"[^"]*"|'(?:''|[^'])*'|--[^\r\n]*/g`):
Using the "Best Regex Trick" — leftmost match wins, so bracket/string/comment tokens are consumed before competing patterns can fire:
- `[bracket identifiers]` → preserved as-is
- `"double-quoted identifiers"` → converted to `[bracket]` notation
- `'string literals'` → neutralized to `''` (content cannot trigger false matches)
- `-- line comments` → replaced with space

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

### Modifying Parse Rules

When modifying `assets/defaultParseRules.yaml` or `sqlBodyParser.ts`: run full 3-dacpac baseline comparison (283 SPs). `npm test` alone is not sufficient.

```bash
npx tsx tmp/snapshot-deps.ts 2>/dev/null > tmp/baseline.tsv   # before
# apply change
npx tsx tmp/snapshot-deps.ts 2>/dev/null > tmp/after.tsv      # after
diff tmp/baseline.tsv tmp/after.tsv                            # must be empty or positive only
npm test                                                        # all suites must pass
```
