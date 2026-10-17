# Repository guide

Instructions for an agent that cloned Data Lineage Viz to review security and behavior before using or packaging the extension. Read only the linked rule or skill for the task you are doing.

## What this is

A VS Code extension that draws SQL Server lineage. Sources are SQL Server, Azure SQL, Fabric Data Warehouse, and Synapse Dedicated SQL Pool. It does not own a database schema and has no migration command.

- `src/engine/` parses SQL, builds the graph, and connects to databases.
- `src/ai/` is the `@lineage` chat runtime. It records findings the model supplies. It does not invent graph facts or open a database on its own.
- `src/components/` (with `src/hooks/`, `src/contexts/`, and `src/detail/`) is the webview. It may import engine types. Engine code does not import the webview.
- `assets/` holds parse rules, DMV queries, AI output templates, and the public AdventureWorks demo.
- `tests/` holds deterministic parser, lineage, and AI-contract checks, plus optional host checks. Sample SQL is the AdventureWorks demo or synthetic statements.

Stack: Node.js `>=20`, npm `>=10`, VS Code API `^1.101.0`, TypeScript `^5.7`. There is no lint script. Use `npm run typecheck`.

## Review before use

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run gate
```

`npm test` and `npm run gate` do not call a model provider. They are the check for a code change. A live model run spends the external API provider's tokens. Run one only when [the testing guide](docs/testing/README.md#when-a-live-run-is-worth-its-cost) says that run answers a question the deterministic tests cannot. Keep that external test profile's provider, model, and reasoning effort. The coding agent reviewing the repository is a separate model.

Package with `npm run package` and inspect the VSIX before install. Data boundaries are in [`SECURITY.md`](SECURITY.md). What the extension sends to a database is in [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md) and [`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md).

## How to change code

- Change the layer that owns the contract. Engine, chat runtime, and webview stay separated as above.
- Validate untrusted input at the boundary with the existing schema. Leave invalid model input rejected.
- Use public APIs from VS Code and the installed libraries.
- Leave `package.json` and the lockfile versions unchanged unless the user asks.
- Add a permanent test only for parsing, lineage, an AI middleware contract, or a security boundary. Use the AdventureWorks demo or synthetic SQL. Leave customer database content out of the repository.
- When you change behavior that a markdown file describes, update that file so it stays true.
- Leave credentials, customer database content, raw conversations, and generated run output out of tracked files.

## Which file to read

- TypeScript or layering: [`.agents/rules/typescript.md`](.agents/rules/typescript.md)
- Credentials, logging, or model handling: [`.agents/rules/security.md`](.agents/rules/security.md)
- Hop checks, rejections, or routing: [`.agents/rules/backend-contract.md`](.agents/rules/backend-contract.md) and the matching section of [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Tests: [`.agents/rules/testing.md`](.agents/rules/testing.md), [`.agents/skills/testing/SKILL.md`](.agents/skills/testing/SKILL.md), and [`docs/testing/README.md`](docs/testing/README.md)
- Prompt or template wording: [`.agents/skills/prompt-change/SKILL.md`](.agents/skills/prompt-change/SKILL.md) and [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md)
- Compare two model answers: [`.agents/skills/prompt-playground/SKILL.md`](.agents/skills/prompt-playground/SKILL.md)
- Diagnose one captured turn: [`.agents/skills/trace-debug/SKILL.md`](.agents/skills/trace-debug/SKILL.md)
- Database connections: the database sections of [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md)
- A new machine: [`docs/testing/ENVIRONMENTS.md`](docs/testing/ENVIRONMENTS.md)

Column-lineage and continuation behavior are specified in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md). Read those when the change touches them. Parameters stay binding context. Continuation comes from the qualified arriving task.
