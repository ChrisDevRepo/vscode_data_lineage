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
- **Pass 1.5 (Normalization)**: Transforms ANSI-92 comma-joins into modern JOIN syntax to simplify extraction rules.
- **Pass 1.6 (Substitution)**: Resolves CTE aliases in UPDATE statements. Uses a paren-balancing algorithm (`resolveCteFromTarget`) to find the first `FROM` in a CTE body, collapsing chains like `CTE_A -> CTE_B -> Table`.
- **Normalization**: Identifiers are stripped of brackets, lowercased, and validated against the `CLR_TYPE_METHODS` set in `sqlMetadata.ts`.

---

## 3. Data Extraction Internals

The system supports two high-fidelity ingestion paths that produce a unified `DatabaseModel`.

### 3.1 DACPAC Extraction (`dacpacExtractor.ts`)
- **XML Processing**: Uses `JSZip` to extract `model.xml` and `fast-xml-parser` for O(n) element traversal.
- **Header Synthesis**: If `SysCommentsObjectAnnotation` is missing, the engine synthesizes a `CREATE [TYPE] [SCHEMA].[NAME]` header from element metadata to ensure the SQL parser has valid context.
- **Column Resolution**: Navigates the `TypeSpecifier` relationship to resolve `system_type_id`, `length`, `precision`, and `scale` from the underlying XML properties.

### 3.2 DMV Extraction (`dmvExtractor.ts`)
- **Dual Phase Strategy**:
    - **Phase 1 (Global)**: Fetches `sys.schemas` and `sys.objects` to build the "Discovery Map".
    - **Phase 2 (Scoped)**: Fetches `sys.sql_modules` (DDL), `sys.columns` (Metadata), and `sys.sql_expression_dependencies` (Formal Edges) only for user-selected schemas.
- **Dependency Nuance**: Only schema-qualified dependencies (`referenced_schema_name IS NOT NULL`) are accepted. Unqualified references are rejected to prevent "Default Schema" hallucinations.

---

## 4. Core Engine Components

Beyond parsing, the engine maintains state and performs structural analysis:

- **Graph Analysis (`graphAnalysis.ts`)**: All "Decision Making" logic must reside in the Engine, not React.
    - **Example**: `getNeighborSchemas`, `analyzeHubs`, `analyzeCycles`.
    - **Constraint**: React components should only be responsible for "Presenting" data.
- **Project Store (`projectStore.ts`)**: Manages session persistence, saved filter profiles, and AI-curated views using a versioned JSON schema.
- **Profiling Engine (`profilingEngine.ts`)**: Generates type-aware, single-pass SQL for table statistics. DBA-facing; all generated SQL is logged for transparency.

---

## 4. UI Component Patterns

We follow a strict "Native-First" approach.

- **Components**: Use `@vscode/webview-ui-toolkit` primitives.
- **State**: Complex UI state (like filters or projects) should be managed via custom hooks or a lightweight store (Zustand planned). Avoid "God Components" like the current `App.tsx`.

---

## 5. Testing & Verification

- **Snapshots**: `test/aw-baseline.tsv` is the gold standard. Any change to the parser must result in an identical snapshot.
- **E2E**: `npm run test:vscode` uses a real VS Code instance. It requires `out/extension.js` to be built (run `npm run build:ext` first).
