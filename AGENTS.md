# Repository Guide

Vendor-agnostic instructions for coding agents working on Data Lineage Viz. Read only the linked rule or skill relevant to the task.

## Stack

- VS Code extension, single-package repository; Node.js `>=20`, npm `>=10`, VS Code API `^1.101.0`.
- TypeScript `^5.7`; VS Code extension host, esbuild `^0.28`, Vite `^6.4`.
- React/React DOM `19.3`; webview uses React Flow (`@xyflow/react` `12.11`).
- Graph: graphology `0.26`; validation: Zod `4.6`; tests: Vitest `4.1`, Mocha `11.8`, `@vscode/test-electron` `3.1`.
- Sources are SQL Server, Azure SQL, Fabric Data Warehouse and Synapse Dedicated SQL Pool. No application-owned database schema or migration command.

## Quickstart

```sh
npm ci
npm run dev                 # webview dev server
npm run build               # extension and webview
npm run typecheck
npm test                    # parser, lineage, and deterministic AI/trust contracts
npm run gate                # deterministic gate (excludes test:support); run before reporting a change
npm run package             # create VSIX
```

There is no lint script; use `npm run typecheck`. There is no database migration command; user connection and project data use the existing versioned store logic. [`docs/testing/README.md`](docs/testing/README.md) is the single source for test tiers, lanes and commands.

## Repository map

```text
src/engine/       SQL ingestion, parsing, graph, database connections and deterministic analysis
src/ai/           @lineage participant, tools, prompts and runtime
src/components/   React webview; imports engine types, never the reverse
src/hooks/        React webview hooks (also src/contexts/, src/detail/)
assets/           parse rules, DMV queries, AI output templates and public demo DACPAC
tests/unit/       Vitest parser, lineage, AI contract, and supporting suites
tests/cases/      shared case catalog; runners loop the rows tagged for them
tests/integration/ VS Code Extension Development Host smoke tests
tests/tools/      test runners, gate and package checks
docs/             product architecture, developer and testing documentation
.agents/rules/    on-demand coding and architecture constraints
.agents/skills/   on-demand task workflows
```

## Rules and skills router

- Before changing TypeScript or layering, read `.agents/rules/typescript.md`.
- Before changing trust boundaries, credentials, logging, or model/provider handling, read `.agents/rules/security.md`.
- Before changing hop submission checks, rejections, routing or CT validation, read `.agents/rules/backend-contract.md`.
- Before adding, changing, selecting or diagnosing tests, read `.agents/rules/testing.md` and `.agents/skills/testing/SKILL.md`; tiers and commands are in `docs/testing/README.md`.
- Before changing SQL parsing, graph traversal, or runtime contracts, read `docs/ARCHITECTURE.md` and the relevant `docs/` contract.
- For database connection behavior, read `docs/DEVELOPER_GUIDE.md` database sections and `.agents/skills/testing/SKILL.md`.
- For a trace, state dump, NDJSON quick analysis, or Langfuse debug trace, read `.agents/skills/trace-debug/SKILL.md`.
- For function column-lineage routing or follow-ups, read the column-trace section of `docs/ARCHITECTURE.md` and the hop-memory contract in `docs/AI_PROMPTS.md`. Preserve the caller SQL, qualified requested output and function definition across investigation and retry; parameters are binding context, not invented graph columns. Keep ordinary view routing unchanged.
- For CT/BB routing, read the shared readiness and continuation contract in `docs/ARCHITECTURE.md` and the hop-memory contract in `docs/AI_PROMPTS.md`. Structural readiness precedes mode ranking; qualified arriving tasks select mode. Do not recover continuation from historical edges, column names or prose.
- Before comparing prompt variants, read `.agents/skills/prompt-playground/SKILL.md`.
- Before editing AI prompt text, model-facing tool descriptions or output templates, read `.agents/skills/prompt-change/SKILL.md` and `docs/AI_PROMPTS.md`.
- Before provisioning a machine, container, CI runner or agent sandbox, read `docs/testing/ENVIRONMENTS.md`.
- For native chat buttons, pending input, or follow-up badges, run the chat UI labels in `docs/testing/README.md` and verify the rendered UI. A direct participant call does not prove that path.

## Change constraints

- Fix a reproduced defect at its root cause in the layer that owns the contract. Establish a supported trigger and failing evidence before changing production code. No hack, workaround, retry-until-green, weakened or skipped test, or fixture-specific path in production code. A fix that cannot be made cleanly is not pushed.
- Validate untrusted inputs at their boundary with the existing schema and error handling. Preserve input identity where the API contract requires it.
- Use public APIs from VS Code and installed libraries.
- Extend existing owning tests only for changed key features or reproduced stability/security defects, including relevant failure paths. Use private one-time checks for cleanup equivalence, reference audits, assets, documentation and ancillary tooling probes. Preserve distinct parser and lineage scenarios and coverage floors.
- Documents are part of the change: before a push, check that every changed behavior, command, path and count named in a `.md` file is true, and remove statements that are no longer.
- Never include credentials, customer database content, raw conversations, or generated test artifacts in tracked files.
- Keep generated reviews, audit reports, inventories and session notes in `.audit/` or outside the repository. Never commit or publish them, or put them under `docs/`. Update existing public documentation only for supported behavior changes.
- Do not change `package.json` or lockfile versions unless the user asks.


## Test configuration

- Optional test settings are listed in `.env.example`; a non-empty process environment value wins over the ignored `.env`. Never commit `.env` or print secret values.
- If a needed setting is empty, copy it from the environment's secret store when one exists; do not override non-empty values. Otherwise report the tier as described in `docs/testing/ENVIRONMENTS.md`; an explicitly requested check must fail clearly. Do not work around network blocks.
