# Repository Guide

Vendor-agnostic instructions for coding agents working on Data Lineage Viz. Read only the linked rule or skill relevant to the task.

## Stack

- VS Code extension, single-package repository; Node.js `>=20`, npm `>=10`, VS Code API `^1.101.0`.
- TypeScript `^5.7`; VS Code extension host, esbuild `^0.28`, Vite `^6.4`.
- React/React DOM `19.3`; webview uses React Flow (`@xyflow/react` `12.11`).
- Graph: graphology `0.26`; validation: Zod `4.6`; tests: Vitest `4.1`, Mocha `11.8`, `@vscode/test-electron` `3.1`.
- Sources are SQL Server, Azure SQL, Fabric Data Warehouse and Synapse. No application-owned database schema or migration command.

## Quickstart

```sh
npm install
npm run dev                 # webview dev server
npm run build               # extension and webview
npm run typecheck
npm test                    # deterministic unit tests
npm run test:core           # parser, engine and webview
npm run test:runtime        # AI runtime contracts
npm run test:edh             # VS Code Electron smoke lanes
npm run gate                 # configured deterministic checks
npm run package              # create VSIX
```

There is no lint script; use `npm run typecheck`. There is no database migration command: the extension reads source metadata and stores user connection/project data through its existing versioned store logic.

## Repository Map

```text
src/engine/       SQL ingestion, parsing, graph, database connections and deterministic analysis
src/ai/           @lineage participant, tools, prompts and runtime
src/components/   React webview; imports engine types, never the reverse
src/hooks/        React webview hooks
assets/           parse rules, DMV queries, AI output templates and public demo DACPAC
tests/unit/       Vitest parser, engine, AI contract and webview coverage
tests/integration/ VS Code Extension Development Host smoke tests
tests/tools/      test runners, gate and package checks
docs/             product architecture, developer and testing documentation
.agents/rules/    on-demand coding and architecture constraints
.agents/skills/   on-demand task workflows
```

## Rules And Skills Router

- Before changing TypeScript or layering, read `.agents/rules/typescript.md`.
- Before changing trust boundaries, credentials, logging, or model/provider handling, read `.agents/rules/security.md`.
- Before adding or changing tests, read `.agents/rules/testing.md` and `.agents/skills/testing/SKILL.md`.
- Before changing SQL parsing, graph traversal, or runtime contracts, read `docs/ARCHITECTURE.md` and the relevant `docs/` contract.
- For database connection behavior, read `docs/DEVELOPER_GUIDE.md` database sections and `.agents/skills/testing/SKILL.md`.
- For a trace, state dump, NDJSON conversation, or Langfuse observation, read `.agents/skills/trace-debug/SKILL.md`.
- Before comparing prompt variants, read `.agents/skills/prompt-playground/SKILL.md`.
- Before editing prompt text or AI output templates, read `.agents/skills/prompt-change/SKILL.md` and `docs/AI_PROMPTS.md`.
- For test tiers and optional environment configuration, read `docs/testing/README.md` and `docs/EDH_TESTING.md`.

## Change Constraints

- Fix behavior in the layer that owns the contract. Keep `src/engine/` independent of `src/components/`; `src/engine/shared/bridgeContract.ts` owns webview IPC validation.
- Validate untrusted inputs at their boundary with the existing schema and error handling. Preserve input identity where the API contract requires it.
- Use public APIs from VS Code and installed libraries. Do not add fixture-specific behavior to production paths.
- Add focused tests for changed behavior, including failure and malformed-input paths. Test files end in `.test.ts` or `.test.tsx` and start with a short statement of what they cover.
- TypeScript uses ESM imports/exports. Exported APIs need contract-focused TSDoc. Keep comments actionable and current.
- Never include credentials, customer database content, raw conversations, or generated test artifacts in tracked files.
- Do not change `package.json` or lockfile versions unless the user asks.
