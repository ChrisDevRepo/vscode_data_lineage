# Copilot Instructions

A short guide for making small changes to this repository. Runtime contracts
and deeper coding rules live in the docs listed below.

## What the extension is

`data-lineage-viz` is a TypeScript VS Code extension. It reads SQL objects
(tables, views, procedures, functions) from a `.dacpac` file or from live
SQL Server, Azure SQL, Fabric Data Warehouse, or Synapse metadata, resolves
them into a dependency graph, and shows the graph in a React webview. An
optional `@lineage` chat participant answers questions about the loaded graph
with the model the user picked for the chat request; the extension has no
provider or API-key settings.

Two bundles ship: the extension host (esbuild, `out/extension.js`) and the
webview (Vite, `dist/`). Messages between them are validated with Zod against
`src/engine/shared/bridgeContract.ts`.

## Repository layout

- `src/engine/`: DACPAC and live-database ingestion, SQL parsing, graph build and traversal
- `src/ai/`: the `@lineage` chat participant, its tools and runtime
- `src/components/`, `src/hooks/`: React webview UI
- `assets/`: YAML behaviour (`defaultParseRules.yaml`, `dmvQueries.yaml`, `aiOutputTemplates.yaml`) and `demo.dacpac`
- `tests/`: Vitest unit tests, AdventureWorks fixtures, Electron integration tests
- `docs/`: architecture, developer guide, and reference documents

## Build and test

```bash
npm install
npm run build          # extension + webview
npm test               # all unit tests
npm run test:parser    # SQL parser tier
npm run test:bfs       # graph and traversal tier
npm run test:core      # parser + engine + webview
npm run typecheck
npm run gate           # deterministic pre-merge checks
npm run test:edh       # Electron integration lanes
npm run package        # build a VSIX
```

Press `F5` to launch the Extension Development Host.

## Small adjustments

- SQL extraction rules live in `assets/defaultParseRules.yaml`; run `npm run test:parser` and review the resulting edges against the SQL.
- Live-database queries live in `assets/dmvQueries.yaml`; update `docs/DMV_QUERIES.md` with them.
- A tool-contract change needs `npm run generate:tool-manifest` and the regenerated manifest committed.

## Conventions

- ESM `import` / `export`; strict TypeScript; Zod at untrusted boundaries.
- Comments follow [TSDoc](https://tsdoc.org/): `/** */` on exported API stating the contract, no `{Type}` braces, no narration, history, or commented-out code.
- Log through `src/utils/log.ts`.
- Commands and settings use the `dataLineageViz.*` prefix.
- Test files end in `.test.ts` and start with a short header stating what the suite pins.
- Commit messages read `type(scope): summary`, for example `fix(engine): ...`.
- Do not change the version number; changelog notes go under the current version heading.
- Commit only AdventureWorks DACPAC fixtures; never secrets, customer data, or raw traces.

## Where to read more

- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md): runtime architecture and graph contracts
- [`docs/DEVELOPER_GUIDE.md`](../docs/DEVELOPER_GUIDE.md): toolchain, ingestion, host/webview boundaries, testing
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): coding standards
