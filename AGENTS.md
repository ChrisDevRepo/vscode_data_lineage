# Repository guide

Instructions for an agent or developer that cloned Data Lineage Viz to review security, verify contracts, or build the extension.

## What this is

A VS Code extension that draws SQL Server lineage. Sources are SQL Server, Azure SQL, Fabric Data Warehouse, and Synapse Dedicated SQL Pool. It does not own a database schema and has no migration command.

- `src/engine/` parses SQL, builds the graph, and connects to databases.
- `src/ai/` is the `@lineage` chat runtime. It records findings the model supplies. It does not invent graph facts or open a database on its own.
- `src/components/` (with `src/hooks/`, `src/contexts/`, and `src/detail/`) is the webview. It may import engine types. Engine code does not import the webview.
- `assets/` holds parse rules, DMV queries, AI output templates, and the public AdventureWorks demo.
- `tests/` holds deterministic parser, lineage, and AI-contract checks, plus optional host checks. Sample SQL is the AdventureWorks demo or synthetic statements.

Stack: Node.js per `package.json` engines, npm `>=10`, VS Code API `^1.101.0`, TypeScript `^5.7`. There is no lint script. Use `npm run typecheck`.

## Review before use

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run gate
```

`npm test` and `npm run gate` are deterministic and do not call a model provider. Live model tests are optional and need the `AI_TEST_*` settings in [`.env.example`](.env.example); see [`docs/testing/README.md`](docs/testing/README.md).

Package with `npm run package` and inspect the VSIX before install. Data boundaries are in [`SECURITY.md`](SECURITY.md). What the extension sends to a database is in [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md) and [`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md).

## How to change code

- Change the layer that owns the contract. Engine, chat runtime, and webview stay separated as above.
- Validate untrusted input at the boundary with the existing schema. Leave invalid model input rejected.
- Follow strict TypeScript and the layering above.
- Leave `package.json` and the lockfile versions unchanged unless the user asks.
- `CHANGELOG.md` is the release record: keep shipped sections unchanged and list user-visible changes under the version in `package.json`.
- Add a permanent test only for parsing, lineage, an AI middleware contract, or a security boundary. Use the AdventureWorks demo or synthetic SQL. Leave customer database content out of the repository.
- When you change behavior that a markdown file describes, update that file so it stays true.
- Leave credentials, customer database content, raw conversations, and generated run output out of tracked files.

## Documentation index

- Architecture overview: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Security and data boundaries: [`SECURITY.md`](SECURITY.md)
- Database queries (DMVs) for DBA review: [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md)
- Table profiling SQL patterns: [`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md)
- `@lineage` output templates and prompts: [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md)
- Test tiers and execution: [`docs/testing/README.md`](docs/testing/README.md)
- Developer setup and build instructions: [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md)
- Machine setup: [`docs/testing/ENVIRONMENTS.md`](docs/testing/ENVIRONMENTS.md)
