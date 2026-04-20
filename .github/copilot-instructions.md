# Copilot Instructions - Data Lineage Viz

These instructions guide GitHub Copilot in generating code and solving problems within the Data Lineage Viz extension.

## 1. Project Context
VS Code extension for visualizing SQL database object dependencies from `.dacpac` files or database import (via MSSQL extension API). It uses a React + ReactFlow frontend, Graphology for graph data, and Dagre for layout.

**For complete technical architecture, data contracts, and AI implementation details, you MUST refer to:**
- `docs/TECHNICAL_ARCHITECTURE.md` (High-level architecture, IPC messaging, SQL parsing engine, State Machine, Memory)
- `docs-internal/DEVELOPER_GUIDE.md` (Developer workflows, YAML loading)
- `docs/AI_ARCHITECTURE.md` (Navigation Engine, Chat Phases)

## 2. Code Rules & Anti-Patterns
- **TypeScript strict mode** must be enforced.
- **Never hardcode CSS colors**: Always use `var(--ln-*)` or `var(--vscode-*)` custom properties.
- **Graph Traversal**: Use Graphology `bfsFromNode`. **No manual BFS implementations**. BFS must be pure (no business logic/semantic filtering inside BFS callbacks).
- **Bidirectional Edges**: Table→SP (read) and SP→Table (write). React Flow merges them into ⇄ display via `buildFlowEdges()`.
- **Settings Prefix**: `dataLineageViz`.

### React Anti-Patterns — NEVER Introduce
| Anti-Pattern | Why It Breaks |
|---|---|
| `forEach` calling state setter + rebuild | N rapid graph rebuilds crash the app |
| Ref mutation inside `useMemo` | Interrupted renders leave stale refs |
| `React.memo` on components with 10+ object/array props | Shallow compare always fails |
| `useEffect` watching state set in same handler | Effect fires with stale graph |

## 3. Testing Mandates
- **Deterministic Focus**: Write tests exclusively for the **deterministic core** (SQL parsing, graph topology, BFS, state machine contracts) in `tests/unit/`.
- **Snapshot Baselines**: Changes to `sqlBodyParser.ts` or `defaultParseRules.yaml` **MUST** include a run of `npm run test:snapshot` and commit an updated `tests/fixtures/aw-baseline.tsv`.

```bash
npm test                  # full unit suite (tsx)
npm run test:hooks        # React hooks (vitest)
npm run test:unit:ai      # AI tools + NavigationEngine + cascade-prune
npm run test:snapshot     # parser baseline regression check
```

### 3.1 AI Eval Integrity — Hard Rule
The AI eval framework (`tests/eval/`) measures the real behavior of the `@lineage` chat participant. The eval agent receives ONLY what the real VS Code chat delivers to the language model: the user's question, the system + navigation prompts + tool descriptions from `GET /prompts`, and the HTTP transport to the in-extension `toolProxy`.

**Forbidden in the eval-agent prompt:** any behavior hint, structural template, density target, terminology rule, error-recovery coaching, "keep calling submit_findings" reminder, corrected example, or re-emphasis of production-prompt rules. If the production prompt can't drive the behavior, that IS the finding — fix it upstream via `/prompt-change`, never patch it in the harness.

**Only entry point:** spawn eval agents via `python tests/eval/run.py <test-id>`. The runner loads a constant template, populates three placeholders (`QUESTION`, `FOLLOWUPS`, `SESSION_ID`), lints the populated prompt against a forbidden-tokens blocklist (`tests/eval/validate.py`), and fails-closed if any blocked token is present. Direct `Agent(model: "haiku")` invocations for eval purposes are a policy violation.

Harness contamination is worse than overfitting: overfitting tunes to the wrong data, harness cheating tunes to fiction. See `.claude/rules/eval-validity.md` for the full rule.

## 4. No Silent Failures
- **Extension host**: Every `catch` block MUST log via `logError()`/`logWarn()` from `src/utils/log.ts`.
- **Webview**: Global `unhandledrejection` and `error` handlers in `index.tsx`.
- Never `.catch(() => {})`.

## 5. Message Passing (Extension <-> Webview)
Key IPC messages strictly validated by **Zod** schemas:
- `ready`, `dacpac-data`, `show-detail`, `update-detail`, `close-detail`, `detail-update`, `detail-closed`, `themeChanged`, `filter-changed`.
- All requests conform to shared types defined in the source (refer to `src/engine/shared/bridgeContract.ts`).