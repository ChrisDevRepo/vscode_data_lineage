# Copilot instructions — Data Lineage Viz

Guidance for GitHub Copilot when editing in this repo. These instructions prioritize architectural grounding and technical rigor.

## Project Context
A VS Code extension for visualizing SQL dependencies. Key technologies:
- **Core**: TypeScript, Node.js (Extension Host).
- **Visualization**: React, React Flow, Graphology.
- **AI**: `@lineage` Chat Participant using an autonomous Map & Router architecture.
- **Parsing**: Multi-pass regex engine with YAML-driven rules.

## Documentation Reference (Mandatory for non-trivial changes)
- [**System Architecture**](../docs/ARCHITECTURE.md): Map & Router, Bipartite analysis, Hourglass context.
- [**Developer Guide**](../docs/DEVELOPER_GUIDE.md): Prompt builders, builder hierarchy, dual ingestion flows.
- [**Parse Rules**](../docs/PARSE_RULES.md), [**DMV Queries**](../docs/DMV_QUERIES.md), [**Profiling**](../docs/PROFILING_PATTERNS.md): SQL parser YAML reference, DBA contract, and profiling SQL patterns.
- [**Contributing**](../CONTRIBUTING.md): Testing tiers, coding standards, snapshot protocol.

## Engineering Standards

- **TypeScript**: Strict mode is mandatory. Use `npx tsc --noEmit` to verify. Avoid `any` at architectural boundaries.
- **State Machine**: Follow the **Discriminated Union** pattern for FSM states (see `src/ai/sessionPhase.ts`). Use exhaustive `switch` on the `kind` field.
- **Security**: Never log or commit secrets. Use Zod schemas at every untrusted boundary (IPC, AI tool results, YAML).
- **Logging**: Use the standard logger in `src/utils/log.ts`.
  - Extension Host: `logInfo`, `logDebug`, `logWarn`, `logError`.
  - Webview: Bubbles up via `unhandledrejection` and `error` listeners to the extension log channel.
- **Styling**: Use CSS variables (`var(--ln-*)` or `var(--vscode-*)`). Never hardcode colors. Schema colors are resolved via `getSchemaColor()` in `src/utils/schemaColors.ts`.
- **Performance**:
  - Prefer `graphology.bfsFromNode` for traversals.
  - Optimize React renders by avoiding state setters inside loops and ensuring stable hook dependencies.

## Coding Conventions

- **Naming**: Use the `dataLineageViz.*` prefix for commands and settings.
- **IPC**: All messages across the Extension ↔ Webview bridge must be defined in `src/engine/shared/bridgeContract.ts` using Zod.
- **Parsing**: The regex pipeline in `src/engine/sqlBodyParser.ts` uses the "Best Regex Trick" for cleansing. Rule extraction is driven by `assets/defaultParseRules.yaml`.

## Testing & Verification

The regression net rests on three high-priority categories — **parsing, BFS/graph, baseline**. Other tests are narrower guards (Zod boundaries, tool policy, idempotency, classifiers); add to them only when an invariant they protect changes.

- **Snapshot testing**: Any change to `assets/defaultParseRules.yaml` requires `npm run test:snapshot`. Zero lost dependencies allowed.
- **Tiers**:
  - `npm test` — full unit suite (parser, graph, baseline, NavigationEngine + cascade + bipartite + supplement, boundary guards).
  - `npm run test:parser` — SQL parser edge cases + 55 real-world SQL fixtures.
  - `npm run test:graph` — graph construction, BFS, analysis algorithms.
  - `npm run test:baseline` — parser TSV + graph-analysis JSON regression net.
  - `npm run test:hooks` — React hooks (vitest jsdom).
- **AI quality** beyond pure-function surface (prompt content, classification semantics, narrative quality) is verified through UAT baseline captures (`tmp/baseline/`), not unit tests — there is no in-process LM to assert against.

## Dev: LM Traffic Tracer

`src/ai/infra/lmTracer.ts` is a **built-in observability tool** — not part of the extension API. It is an internal developer backdoor for testing only, controlled by a hardcoded code flag. It is not removed after use.

It captures every `vscode.lm.sendRequest` call (messages, tool calls, results, wipes, token counts) as NDJSON to `tmp/lm-trace/` for post-session analysis. Trace files are gitignored.

**Enable (test/dev only):** set the hardcoded trace flag to `true` in code, rebuild/run the extension, then run a `@lineage` chat session. Disable it again before production packaging. Do not add a VS Code setting or command for this toggle.

**Analyse (manual workflow — run in terminal):**
```
node tests/tools/trace-analyze.js tmp/lm-trace/<file>.ndjson \
  --summary --phase --patterns --rejected --loops --wipes \
  --waste --tools --growth --tool-bloat --detail-metrics --ct
```

**Generate performance baseline:**
```
node tests/tools/generate-ideal.js assets/demo.dacpac
```

Full flag reference, journal workflow, and ideal-vs-actual comparison: see the **LM traffic tracer** section in [`docs/DEVELOPER_GUIDE.md`](../docs/DEVELOPER_GUIDE.md).

## Guidelines for AI Generation
- **Logic**: Use explicit composition and delegation over complex inheritance.
- **Accuracy**: Ensure generated code aligns strictly with the Orchestrator-Worker pattern for AI and the Bipartite model for graph traversal.
- **Conciseness**: Prioritize technical signal over conversational filler in code comments and logs.
