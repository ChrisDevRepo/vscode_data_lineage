# Copilot Instructions - Public Delta

Canonical repo policy lives in `AGENTS.md`. Use `CONTRIBUTING.md` and `tests/README.md` for the current test strategy. If these files conflict, follow `AGENTS.md`, then `CONTRIBUTING.md`, then this file.

## Read First
- `docs/ARCHITECTURE.md`: runtime architecture, graph contracts, `NavigationEngine`
- `docs/DEVELOPER_GUIDE.md`: extension, ingestion, and tracer workflows
- `docs/AI_PROMPTS.md`: `@lineage` prompt/tool/template lifecycle
- `docs/PARSE_RULES.md` and `docs/DMV_QUERIES.md`: parser and DMV customization

## Core Engineering Rules
- Keep `@lineage` as the primary user-facing surface.
- `NavigationEngine` owns BFS scope, agenda, gates, route validation, pruning, closure, and termination.
- Treat the language model as a semantic worker, not a process-state owner.
- Validate untrusted boundaries with Zod.
- Prefer schema/FSM/policy/code guards over prompt-only constraints.
- Use `src/utils/log.ts` helpers only.
- Every user-facing error/warning notification must go through `notifyError` / `notifyWarning` (`src/utils/notifications.ts`) so full detail + stack reach the Output channel at the same level as the toast — never demote detail to `debug`. Webview errors funnel through the bridge `'error'` message.
- AI/Zod rejections are normal AI behavior → `debug`, not error/warn. Render-limit / node-cap reached is capacity guidance → `info`, not an error.
- Use `dataLineageViz.*` for commands and settings.
- Use `Expanded Schema View` naming for the schema expansion view.
- The user solely owns the version number. Never bump/lower or restructure versioning, and never add a CHANGELOG `[Unreleased]` section (the project does not use one); new notes go under the current version heading.

## Testing And Verification
- Full gate: `npm test`
- Core tiers: `npm run test:parser`, `npm run test:bfs`
- Supporting tiers: `npm run test:support`, `npm run test:ui`, `npm run test:baseline`
- Discovery audit: `npm run test:list`
- Parser rule edits require `npm run test:snapshot`, then `npm run test:snapshot:update` only for intentional changes.
- For structural or code-path changes, run `npx tsc --noEmit`, `npm run build`, and `npm test`.
- New-test placement (so it is never silently skipped): node tests are self-running scripts (`assert`/`assertEq`/`printSummary` from `tests/unit/helpers/testUtils`, calling `runTests()` at module load) living at root `tests/unit/*.test.ts`. A domain runner under `tests/unit/runners/` collects them: `bfs`/`parser`/`baseline`/`snapshot` use explicit module arrays (add your file there); the `support` runner auto-discovers remaining root-level `*.test.ts` minus its exclude list. A file in a subdirectory (e.g. `tests/unit/ai/`) is NOT discovered. UI/hook tests under `tests/unit/components/` or `tests/unit/hooks/` are vitest `describe`/`it` files, glob-discovered by the `ui`/`support-ui` projects. Confirm a new test ran: its summary appears in `npm test` output and the project's test count increases.

## Security
- Never commit secrets, `.env*`, customer data, proprietary DACPACs, raw traces, journals, or local assistant artifacts.
- Never commit `CLAUDE*`, `GEMINI*`, `*internal*`, `.claude/`, `.gemini/`, `.cursor/`, `.continue/`, `.aider*`, `.agents/`, or `tmp/`.
- Only approved AdventureWorks DACPAC fixtures may be committed under `tests/fixtures/`.
- LM trace logging stays opt-in per session via `dataLineageViz.enableAiTraceLogging`. Do not add a persistent setting for it.
