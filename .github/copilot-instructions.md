# Project Context

VS Code extension for visualizing SQL database object dependencies from .dacpac files. React + ReactFlow frontend, graphology for graph data, dagre for layout.

## Architecture

| Runtime | Bundler | Entry | Output |
|---------|---------|-------|--------|
| Node.js (extension host) | esbuild | `src/extension.ts` | `out/extension.js` (CJS) |
| Browser (webview) | Vite | `src/index.tsx` | `dist/assets/index.js` (ESM) |

### Key Directories

- `src/engine/` — dacpac extraction, SQL parsing, graph building
- `src/components/` — React UI (ReactFlow canvas, toolbar, filters, modals)
- `src/hooks/` — Graph state (`useGraphology`), trace state (`useInteractiveTrace`), loader (`useDacpacLoader`)
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
npm test         # All tests (352 total)
```

Press F5 to launch Extension Development Host.

## Test Suite

| File | Tests | Purpose |
|------|-------|---------|
| `test/engine.test.ts` | 115 | Engine integration: extraction, graph, trace, direction validation |
| `test/parser-edge-cases.test.ts` | 127 | Syntactic parser tests: all 11 rules + edge cases + regression guards |
| `test/graphAnalysis.test.ts` | 59 | Graph analysis: islands, hubs, orphans, longest path, cycles |
| `test/dmvExtractor.test.ts` | 51 | DMV extractor: synthetic data, column validation, type formatting |
| `test/webview.integration.test.ts` | — | VS Code integration tests |
| `test/AdventureWorks.dacpac` | — | Classic style test dacpac |
| `test/AdventureWorks_sdk-style.dacpac` | — | SDK-style test dacpac |

```bash
npm test              # Run all tests (352 total)
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

Database connection messages: `check-mssql`, `mssql-status`, `db-add-connection`, `db-connection-added`, `db-remove-connection`, `db-connection-removed`, `db-extract`, `db-progress`, `db-model`, `db-error`

Other: `open-dacpac`, `load-last-dacpac`, `last-dacpac-gone`, `load-demo`, `open-external`, `open-settings`, `save-schemas`, `parse-rules-result`, `parse-stats`

## SQL Parse Rules

Stored procedures use regex-based body parsing (`sqlBodyParser.ts`). Rules defined in `parseRules.yaml` (11 rules across 4 categories: preprocessing, source, target, exec). Views/functions use dacpac XML dependencies directly.

When modifying parse rules: run `npm test` before and after, zero regressions allowed.
