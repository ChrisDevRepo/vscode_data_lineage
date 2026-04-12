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
- System prompt text in `extension.ts`
- Tool `modelDescription` fields in `package.json`
- `assets/aiOutputTemplates.yaml` instruction fields
- Slash command routing in `extension.ts`

Use `/prompt-change` skill. Results logged in `ai/prompt-changelog.md`.

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

## AI Chat Participant (`@lineage`)

Details: `.claude/rules/ai.md`. Canonical doc: `ai/dataflow.md`.

## Eval-Loop Model Policy

**Eval tests use Sonnet** (`claude-sonnet-4-6`) — switched from Haiku 2026-04-12 (user approved). Sonnet better reflects real-world Copilot Chat behavior and produces richer evidence for quality evaluation. NEVER substitute a different model without explicit user approval. Model changes invalidate baseline comparisons. If an eval agent must run outside the eval-loop skill, it MUST use `model: "sonnet"` in the Agent tool call.

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
