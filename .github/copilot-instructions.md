# Copilot instructions — Data Lineage Viz

Guidance for GitHub Copilot / Copilot Chat when editing in this repo. These apply in addition to any user prompt.

## What this repo is

A VS Code extension (`data-lineage-viz`, publisher `datahelper-chwagner`) that parses SQL Server dacpacs or live-DB metadata into a directed dependency graph and renders it with React + React Flow. A chat participant (`@lineage`) walks the graph hop-by-hop via the VS Code Language Model API to answer lineage questions grounded in the user's schema.

For the full architecture, read [`docs/TECHNICAL_ARCHITECTURE.md`](../docs/TECHNICAL_ARCHITECTURE.md) and [`docs/AI_ARCHITECTURE.md`](../docs/AI_ARCHITECTURE.md) before generating non-trivial code. Prompt engineering belongs in [`docs/AI_PROMPTS.md`](../docs/AI_PROMPTS.md).

## Code navigation

| Task | Read |
|---|---|
| Parser rule changes | [`docs/PARSE_RULES.md`](../docs/PARSE_RULES.md), `src/engine/sqlBodyParser.ts`, `assets/defaultParseRules.yaml` |
| AI chat participant | `src/ai/lineageParticipant.ts`, `src/ai/smBase.ts`, `src/ai/toolProvider.ts` |
| Prompt builders | `src/ai/prompts.ts`, `src/ai/smPrompts.ts`, `src/ai/templateRenderer.ts` |
| Webview bridge | `src/panelProvider.ts`, `src/engine/shared/bridgeContract.ts` |
| Database import | `src/engine/dacpacExtractor.ts`, `src/engine/dmvExtractor.ts`, `assets/dmvQueries.yaml` |
| Testing strategy | [`docs/TESTING.md`](../docs/TESTING.md) |

## Conventions this repo enforces

- **TypeScript strict mode is non-negotiable.** Run `npx tsc --noEmit` after any structural change.
- **Discriminated unions over boolean flag piles.** See `src/ai/sessionPhase.ts` (`SessionPhase`, `HopLoopExit`) for the canonical pattern; exhaustive `switch` on the `kind` field.
- **Zod at the boundary.** Every untrusted payload (webview → extension messages, AI tool results, user YAML overlays) parses through a Zod schema at the edge. Inner layers consume the parsed type — no re-validation.
- **Mechanical enforcement over prompt language.** If an invariant matters to the AI, enforce it in code (tool mode, parallel-call guard, route validation) — don't rely on prompt prose.
- **Command and setting prefix**: `dataLineageViz.*` for both. Register commands in `package.json` → `contributes.commands`; settings in `contributes.configuration.properties`.
- **No hardcoded CSS colors.** Use `var(--ln-*)` or `var(--vscode-*)` custom properties. Node-type colors are fixed in `src/utils/schemaColors.ts`; schema colors come from `getSchemaColor()`. Never define either elsewhere.
- **Graph traversal**: use `graphology.bfsFromNode` — never a hand-rolled BFS. No semantic filtering inside BFS callbacks; filter the result set afterward.
- **Bidirectional edges** are stored as two antiparallel directed edges. `buildFlowEdges()` merges them into a ⇄ display edge in React Flow — that is a rendering concern, not a model concern.

## Patterns to avoid in the React webview

| Anti-pattern | Why |
|---|---|
| `forEach` calling a state setter + graph rebuild | N synchronous rebuilds freeze the UI |
| Ref mutation inside `useMemo` | Interrupted renders leave stale refs |
| `React.memo` on components with 10+ object/array props | Shallow compare always fails — no win |
| `useEffect` depending on state set inside the same handler | Effect fires with pre-update value |

## No silent failures

Every `catch` in the extension host must log via `logError()` / `logWarn()` from `src/utils/log.ts`. The webview has global `unhandledrejection` and `error` handlers in `src/index.tsx`. `.catch(() => {})` is never acceptable.

## Parser rule changes need a snapshot run

After any edit to `assets/defaultParseRules.yaml`:

```bash
npm run test:snapshot            # must stay green — zero lost dependencies allowed
```

A lost dependency is a regression. A gained dependency needs a one-line justification in the commit message before running `npm run test:snapshot:update`.

## Testing

See [`docs/TESTING.md`](../docs/TESTING.md). Minimum before pushing: `npm test`.
