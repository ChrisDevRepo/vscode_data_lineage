# Copilot Instructions

A short orientation for an AI assistant working on this repository. Tracked
source, tests, and documentation are the authoritative context; runtime
contracts and coding rules live in the docs listed below, not here.

## What the extension is

`data-lineage-viz` reads SQL objects — tables, views, procedures, functions —
from a DACPAC file or from live SQL Server, Azure SQL, Fabric, or Synapse
metadata, resolves them into a dependency graph, and renders that graph as an
interactive diagram in a React webview. An optional `@lineage` chat participant
answers questions about the graph using the model the user picked for the chat
request; the extension holds no API keys and has no provider setting.

Two bundles ship: the extension host (esbuild → `out/extension.js`) and the
webview (Vite → `dist/`). Messages between them are Zod-validated against
`src/engine/shared/bridgeContract.ts`.

## Where to read first

- `docs/ARCHITECTURE.md`: runtime architecture, graph contracts, `NavigationEngine`
- `docs/DEVELOPER_GUIDE.md`: toolchain, ingestion, host/webview and AI runtime boundaries, testing, diagnostics
- `docs/AI_PROMPTS.md`: `@lineage` prompt, tool, and template lifecycle
- `docs/EDH_TESTING.md`: unit gate and Electron smoke lanes
- `docs/PARSE_RULES.md` and `docs/DMV_QUERIES.md`: parser and DMV customization
- `docs/PROFILING_PATTERNS.md`: generated profiling SQL and its settings
- `docs/FEATURES.md` and `docs/TROUBLESHOOTING.md`: user-facing behaviour and diagnostics
- `CONTRIBUTING.md` and the `package.json` scripts: coding standards and the command set

## Small adjustments

- SQL extraction is metadata driven: adjust `assets/defaultParseRules.yaml`,
  then run `npm run test:parser` and review the resulting dependency edges
  against the SQL.
- Live-database queries live in `assets/dmvQueries.yaml`; a change ships the
  matching `docs/DMV_QUERIES.md` update.
- `@lineage` answer templates live in `assets/aiOutputTemplates.yaml`; see
  `docs/AI_PROMPTS.md` before editing prompt or tool text.
- A tool-contract change needs `npm run generate:tool-manifest` and the
  regenerated manifest committed.
- Model selection is the request's `ChatRequest.model`; do not add provider,
  endpoint, or model-picker configuration.

## Build and test

```bash
npm ci
npm run build       # extension + webview
npm test            # all unit projects
npm run typecheck
npm run gate        # deterministic pre-merge gate
npm run test:edh    # Electron smoke lanes, outside the gate
```

Press `F5` to launch the Extension Development Host. Tracked tests prove the
deterministic core — SQL parsing, graph traversal, schemas, state transitions —
and extension wiring; answer quality is not measured in this repository.
Details: `docs/DEVELOPER_GUIDE.md` and `docs/EDH_TESTING.md`.

## Conventions

- ESM `import`/`export`; strict TypeScript; Zod at every untrusted boundary.
- Doc comments follow [TSDoc](https://tsdoc.org/): `/** */` on exported API
  stating the contract, no JSDoc `{Type}` braces. No narration, decision
  history, provenance tags, or commented-out code. Test files start with a
  1–3 line header stating what the suite pins.
- Logging goes through `src/utils/log.ts`; user-facing errors and warnings go
  through `notifyError` / `notifyWarning`.
- Severity follows meaning: AI and Zod rejections are normal AI behaviour and
  log at `debug`; a render-limit or node-cap refusal is capacity guidance and
  logs at `info`.
- Commands and settings use the `dataLineageViz.*` prefix.
- Test files end in `.test.ts`. Parser and graph/BFS tests never shrink.
- Changelog notes go under the current version heading; the version number is
  the maintainer's to set. `CHANGELOG.md` has no `[Unreleased]` section.

## Security and data handling

Secrets, customer data, proprietary DACPACs, and raw traces do not belong in
the repository; only AdventureWorks DACPAC fixtures are committed under
`tests/fixtures/`. Default runtime logs are content-free. AI session
diagnostics, once explicitly enabled, may contain prompts, customer data, and
tool payloads — keep them out of version control and review them before sharing.
