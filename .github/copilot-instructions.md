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

- **Snapshot Testing**: Any change to `assets/defaultParseRules.yaml` requires `npm run test:snapshot`. Zero lost dependencies allowed.
- **Tiers**:
  - `npm run test:unit`: Core logic.
  - `npm run test:unit:ai`: AI state machine and memory management.
  - `npm run test:hooks`: React hook tests.

## Guidelines for AI Generation
- **Logic**: Use explicit composition and delegation over complex inheritance.
- **Accuracy**: Ensure generated code aligns strictly with the Orchestrator-Worker pattern for AI and the Bipartite model for graph traversal.
- **Conciseness**: Prioritize technical signal over conversational filler in code comments and logs.
