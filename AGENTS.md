# Repository Guide

Vendor-agnostic instructions for coding agents working on Data Lineage Viz. Read only the linked rule or skill relevant to the task.

## Stack

- VS Code extension, single-package repository; Node.js `>=20`, npm `>=10`, VS Code API `^1.101.0`.
- TypeScript `^5.7`; VS Code extension host, esbuild `^0.28`, Vite `^6.4`.
- React/React DOM `19.3`; webview uses React Flow (`@xyflow/react` `12.11`).
- Graph: graphology `0.26`; validation: Zod `4.6`; tests: Vitest `4.1`, Mocha `11.8`, `@vscode/test-electron` `3.1`.
- MCP server: `@modelcontextprotocol/server`, `/node` and `/client` `2.x` (Streamable HTTP on `127.0.0.1`, stdio proxy).
- Sources are SQL Server, Azure SQL, Fabric Data Warehouse and Synapse Dedicated SQL Pool. No application-owned database schema or migration command.

## Quickstart

```sh
npm ci
npm run dev                 # webview dev server
npm run build               # extension and webview
npm run typecheck
npm test                    # deterministic unit tests
npm run test:core           # parser, engine and webview
npm run test:runtime        # AI runtime contracts
npm run test:edh            # VS Code Electron smoke lanes; needs a display
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
- To evaluate a set of recorded AI runs, compare a branch with a baseline, or grade answers against the SQL, read `.agents/skills/trace-analysis/SKILL.md`; use `trace-debug` for a single turn.
- For function column-lineage routing or follow-ups, read the column-provenance contract in `docs/ARCHITECTURE.md` and the hop-memory contract in `docs/AI_PROMPTS.md`. Preserve the caller SQL, qualified requested output and function definition across investigation and retry; parameters are binding context, not invented graph columns. Keep ordinary view routing unchanged.
- For CT/BB routing, read the shared readiness and continuation contract in `docs/ARCHITECTURE.md` and the hop-memory contract in `docs/AI_PROMPTS.md`. Structural readiness precedes mode ranking; qualified arriving tasks select mode. Do not recover continuation from historical edges, column names or prose.
- Before comparing prompt variants, read `.agents/skills/prompt-playground/SKILL.md`.
- Before editing prompt text or AI output templates, read `.agents/skills/prompt-change/SKILL.md` and `docs/AI_PROMPTS.md`.
- For test tiers and optional environment configuration, read `docs/testing/README.md` and `docs/EDH_TESTING.md`.
- Before provisioning or verifying a machine, container, CI runner or agent sandbox for tests, read `docs/testing/ENVIRONMENTS.md`. Report which tiers the host can run; do not mark a tier passed when its prerequisites are missing.
- For native chat buttons, pending-input behavior, AI-preview formulas or follow-up badges, use the Playwright chat acceptance lanes in `docs/EDH_TESTING.md`. Verify actual UI submission and rendered content; direct participant calls and scripted responses do not prove live inference behavior. Use isolated profiles and repeatable CLI commands.

## Change Constraints

- Fix behavior in the layer that owns the contract. Keep `src/engine/` independent of `src/components/`; `src/engine/shared/bridgeContract.ts` owns webview IPC validation.
- Validate untrusted inputs at their boundary with the existing schema and error handling. Preserve input identity where the API contract requires it.
- Use public APIs from VS Code and installed libraries. Do not add fixture-specific behavior to production paths.
- Add focused tests for changed behavior, including failure and malformed-input paths. Vitest and integration test files end in `.test.ts` or `.test.tsx`; tests of `tests/tools` end in `.test.mjs`.
- TypeScript uses ESM imports/exports. Exported APIs need contract-focused TSDoc. Keep comments actionable and current.
- A technical defect is fixed at its root cause in the layer that owns the contract, with a test that fails before the fix. No hack, workaround, retry-until-green, weakened or skipped test, or fixture-specific path. A fix that cannot be made cleanly is not pushed.
- A defect that loses or discards work is a blocker and is solved before anything else is pushed: a rejected call that is never resent, a run that does not finish, a branch dropped without a trace, a result that differs between repeated runs of one question. The defects reported by `tests/tools/trace-metrics.mjs` are such faults; its signals are not, and are verified by reasoning on the question; see `.agents/skills/trace-analysis/SKILL.md`.
- Documents are part of the change: before a push, check that every changed behavior, command, path and count named in a `.md` file is true, and remove statements that are no longer.
- Never include credentials, customer database content, raw conversations, or generated test artifacts in tracked files.
- Do not change `package.json` or lockfile versions unless the user asks.


## Test Configuration

- Optional test settings are listed in `.env.example`; values come from the process environment, then the ignored `.env`. Never commit `.env` or print secret values.
- If a needed setting is empty, copy it from the environment's secret store when one exists; otherwise skip that tier. Do not override non-empty values.
- Report each tier as passed, failed or not runnable, with the missing prerequisite. Do not work around network blocks.