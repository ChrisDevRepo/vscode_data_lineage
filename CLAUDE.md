# Claude Context - Data Lineage Viz

> **LOCAL only** (gitignored). Public context: `.github/copilot-instructions.md`

VS Code extension for visualizing SQL database object dependencies from .dacpac files or database import (via MSSQL extension API).

## Stabilization Phase (Active)

Scope: bug fixes, logging/notification improvements, GUI polish, code cleanup, test coverage.

**Requires explicit user approval:**
- New features or new tools
- Refactors touching >3 files
- Dependency additions or upgrades
- Architecture or state machine changes

**Default:** smallest possible change. Measure blast radius. One concern per commit.

## Critical Gates — NEVER modify without explicit user approval

**Parser files:** `assets/defaultParseRules.yaml`, `sqlBodyParser.ts`, `dacpacExtractor.ts` — use `/parser-change` skill.

**AI prompt surfaces** (one change per iteration to isolate regressions):
- System prompt text in `src/ai/prompts.ts` and `src/ai/smPrompts.ts`
- Tool `modelDescription` fields in `package.json`
- `assets/aiOutputTemplates.yaml` instruction fields
- Chat participant logic in `src/ai/lineageParticipant.ts`
- Tool registrations in `src/ai/toolProvider.ts`

Use `/prompt-change` skill. Results logged in `test-results/archive/prompt-changelog.md`.

## Case Sensitivity (CI/CS)

`CASE_MODE` in `src/utils/sql.ts` = `'CI'` (SQL Server default). `schemaKey()` lowercases for Map keys/hashing. Always use `schemaKey()` for schema-keyed lookups — never raw string comparison on schema names.

## Data Layer vs Rendering Layer

Guard chain and thresholds: see `.claude/rules/architecture.md`. AI tools + BFS always use full model.

## Stability-First Policy

**Priority: Stability > Performance > Features.**

### React Anti-Patterns — NEVER Introduce

| Anti-Pattern | Why It Breaks |
|---|---|
| `forEach` calling state setter + rebuild | N rapid graph rebuilds crash the app |
| Ref mutation inside `useMemo` | Interrupted renders leave stale refs |
| `React.memo` on components with 10+ object/array props | Shallow compare always fails |
| `useEffect` watching state set in same handler | Effect fires with stale graph |
| `onlyRenderVisibleElements` with <1000 nodes | Visual glitches, marginal gain |

### Performance Gate

1. Measure first — actual problem at 750 nodes?
2. Correctness risk — adds state coupling, refs, index assumptions?
3. Revert path — cleanly removable?
4. If unsure, don't add it.

### No Silent Failures

- Extension host: every `catch` must log via `logError()`/`logWarn()` from `src/utils/log.ts`
- Webview: global `unhandledrejection` + `error` handlers in `index.tsx`
- Never `.catch(() => {})` — minimum: `.catch(err => logDebug(outputChannel, 'Cat', ...))`

## Logging

All outputChannel calls use `logInfo/Debug/Warn/Error/Trace` from `src/utils/log.ts`. Details: `.claude/rules/logging.md`.

**`console.warn` in pure utilities** (`sqlBodyParser.ts`, `modelBuilder.ts`): Technical debt, not policy. These modules lack logger injection so `console.warn` is a temporary fallback. Plan: inject an optional `WarnFn` parameter, extension passes `logWarn`, tests use default `console.warn`.

## AI Chat Participant (`@lineage`)

Code: `src/ai/` — lineageParticipant.ts (chat handler), toolProvider.ts (13 tools), session.ts (state singleton), memoryManager.ts (two-tier memory), smBase.ts (SM base class), viewSynthesisService.ts (enrich_view synthesis).

Rules: `.claude/rules/ai.md`. Full internals: `docs-internal/AI_IMPLEMENTATION.md`.

## Testing Framework (Phase 1 — 2026-04-16)

Three-tier structure — see `tests/README.md`:

- **`tests/unit/`** — Node.js tests (tsx runner), no VS Code needed. Parser, BFS, graph analysis, SM lifecycle. CI-safe.
- **`tests/integration/`** — Live SQL Server tests, skips without `.env`.
- **`tests/e2e/`** — Runs in `@vscode/test-electron` extension host. Contains `suite/eval/toolProxy.ts` (the AI eval proxy).

**Fixtures** (committed, `tests/fixtures/`):
- `AdventureWorks2025_AI.dacpac` — primary, includes `[ai]` schema with synthetic pipeline
- `AdventureWorks_sdk-style.dacpac` — SDK-style XML extraction path
- `aw-baseline.tsv` — parser regression baseline

**Results** (gitignored, `test-results/`): eval runs, SM dumps, workspace.

### Eval-Loop (replaces old HTTP bridge)

`tests/e2e/suite/eval/toolProxy.ts` runs **inside the VS Code extension host**. All tool calls route through `vscode.lm.invokeTool()` → real `toolProvider.ts` → real SM. **Zero tool routing duplication** (replaces the 355-line `dispatcher.ts` + 462-line `ai-test-server.ts` that were deleted).

Test cases in `tests/cases/*.md` — each has `Classification` + `Expected Outcome` + `Fact Check` sections. The Fact Check section documents ground-truth measurements (scope, delivery mode, required nodes) verified against the actual AI dacpac. Use `/eval-loop` to run.

## Eval-Loop Model Policy

**Eval tests use Haiku** via Claude Code `Agent(model: "haiku")` — no API key required, same infrastructure as other skill-spawned agents. NEVER substitute a different model without explicit user approval. Model changes invalidate baseline comparisons.

_(Note: docs previously mentioned Sonnet; Haiku is the current operational model — switched during Phase 0 migration since Claude Code agents use the skill-configured model.)_

## Branch Flow

`feature/*` → `testing` → `main` → tag → publish

## Web Search Guidance

This is a VS Code extension with custom architecture — state machines as data providers, two-tier memory (MemGPT-inspired), graphology graph engine, React Flow rendering. Off-the-shelf lineage tools are irrelevant.

**Search FOR:**
- React / React Flow patterns (layout, performance, large graphs, virtualization)
- AI provider SDKs: LangChain, Anthropic, Google AI, OpenAI — tool-use patterns, context management, token budgeting
- Academic papers: state machines, graph traversal, memory architectures, sliding-window context
- Well-known OSS codebases with similar patterns (VS Code extensions, graph editors, chat participants)

**Search NEVER for:**
- sqlglot, dbt, Apache Atlas, Alation, Collibra, or any data lineage / catalog product
- Generic "SQL lineage" tutorials — our parser is regex-based by design (see parse rules YAML)
- Solutions that assume a different runtime (Python notebooks, CLI tools, cloud services)

**Why:** This extension's value is its architecture (SM + memory + data provider separation), not its SQL parsing. Web results about lineage tools describe different problems. Look for patterns that improve our SM delivery, React rendering, or AI tool-use — not alternative lineage approaches.
