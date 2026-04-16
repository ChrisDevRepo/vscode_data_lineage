# Internal Architecture — Data Lineage Viz

This document is for developers only. it contains low-level details about the codebase structure, IPC protocols, and internal logic that are NOT included in the public docs.

---

## 1. IPC & The "Bridge" (Zod Validation)

Communication between the Extension Host (Brain) and the Webview (Screen) is strictly validated using Zod.

- **File**: `src/engine/shared/bridgeContract.ts`
- **Mechanism**: Every `postMessage` call is wrapped in a validation layer. If the object sent does not match the schema, an error is thrown immediately.
- **Benefits**: Prevents "mystery crashes" where the UI goes white because a property name was changed in the extension but not the webview.

---

## 2. SQL Extraction Pipeline

The engine uses a non-AST, regex-cleansing approach for performance.

- **Pass 0 (Comments)**: Removes block comments using a stack-based counter (handles nesting).
- **Pass 1 (Sanitization)**: Neutralizes strings and line comments to prevent false regex hits.
- **Normalization**: Identifiers are stripped of brackets, lowercased, and validated against the `SYSTEM_SCHEMAS` set in `sqlMetadata.ts`.

---

## 3. Graph Logic Locality

All "Decision Making" logic must reside in the Engine, not React.

- **Example**: `getNeighborSchemas` in `graphAnalysis.ts`.
- **Constraint**: React components should only be responsible for "Presenting" data. They should never calculate reachability or filter nodes themselves. Use the `DatabaseModel` indices instead.

---

## 4. UI Component Patterns

We follow a strict "Native-First" approach.

- **Components**: Use `@vscode/webview-ui-toolkit` primitives.
- **State**: Complex UI state (like filters or projects) should be managed via custom hooks or a lightweight store (Zustand planned). Avoid "God Components" like the current `App.tsx`.

---

## 5. Testing & Verification

- **Snapshots**: `test/aw-baseline.tsv` is the gold standard. Any change to the parser must result in an identical snapshot.
- **E2E**: `npm run test:vscode` uses a real VS Code instance. It requires `out/extension.js` to be built (run `npm run build:ext` first).
