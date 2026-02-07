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

## Build & Test

```bash
npm run build    # Build extension + webview
npm run watch    # Watch extension only
npm test         # Engine tests
```

Press F5 to launch Extension Development Host.

## Test Suite

| File | Purpose |
|------|---------|
| `test/engine.test.ts` | Parser baseline tests |
| `test/webview.integration.test.ts` | VS Code integration tests |
| `test/AdventureWorks.dacpac` | Classic style test dacpac |
| `test/AdventureWorks_sdk-style.dacpac` | SDK-style test dacpac |

```bash
npm test              # Run parser tests
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
- **Co-writer post-filter**: When a SP both reads and writes the same table, BFS upstream finds all other writers to that table (siblings). These are co-writers, not true upstream producers. `filterCoWriters()` runs as post-processing on the BFS result subset — if the origin writes to a table, nodes that only write (no read) to that same table are excluded. Bidirectional nodes (read+write) are kept. This follows the input/output separation pattern used by Apache Atlas and OpenMetadata.
- Settings prefix: `dataLineageViz`

## Message Passing (Extension <-> Webview)

Key messages: `ready`, `config-only`, `show-ddl`, `update-ddl`, `log`, `error`, `themeChanged`

## SQL Parse Rules

Stored procedures use regex-based body parsing (`sqlBodyParser.ts`). Rules defined in `parseRules.yaml` (9 rules across 4 categories: preprocessing, source, target, exec). Views/functions use dacpac XML dependencies directly.

When modifying parse rules: run `npm test` before and after, zero regressions allowed.
