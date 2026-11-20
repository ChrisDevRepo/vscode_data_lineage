# Repository Guide

Instructions for a coding agent working in a clone of Data Lineage Viz. Stack, versions and scripts are in `package.json`.

## What this is

A VS Code extension that draws SQL lineage for SQL Server, Azure SQL, Fabric Data Warehouse and Synapse Dedicated SQL Pool. Single package, TypeScript, esbuild extension host, Vite and React webview. It owns no database schema and has no migration command.

## Commands

```sh
npm ci
npm run build        # extension and webview
npm run typecheck
npm test             # deterministic unit tests
npm run gate         # every deterministic check; run before reporting a change done
npm run package      # create the VSIX
```

The gate includes `npm run lint` (errors only).

## Map

Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Build: [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md). Prompts and templates: [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md).

## Rules

- Change behavior in the layer that owns the contract. `src/engine/` never imports `src/components/` or `src/hooks/`; `src/engine/shared/bridgeContract.ts` is the Zod-validated webview message contract, so update it and both ends together.
- Validate untrusted input (workspace files, database metadata, model output, tool arguments, webview messages) at the receiving boundary with the existing schema. A boundary check accepts or rejects; it never repairs a model-supplied value.
- Keep credentials in VS Code SecretStorage. Log through `src/utils/log.ts`, single-line, with no database identifiers or SQL at info level and above. Add no telemetry SDK, and keep external tracing off. Keep the LangSmith stub (`stubs/langsmith`, the `overrides` entry and the `assert-no-langsmith` gate step).
- `@lineage` tools read the loaded model only; they cannot connect to a database, run SQL, import or profile.
- Add a focused test for changed behavior, including failure and malformed input, in `*.test.ts` or `*.test.tsx`. Use the demo DACPAC or synthetic SQL. A fixed-response model fixture proves API wiring, not answer quality.
- Never put credentials, customer data, raw conversations, traces or generated test output in tracked files. Optional test settings live in `.env` (git-ignored; tracked template `.env.example`); report a tier whose prerequisites are missing as not runnable.
- Do not change `package.json` or lockfile versions unless asked. After changing a tool description or schema, run `npm run generate:tool-manifest`.
- Bug reports and forking: [`CONTRIBUTING.md`](CONTRIBUTING.md).
