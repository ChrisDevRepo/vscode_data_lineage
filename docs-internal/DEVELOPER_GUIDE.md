# Internal Developer Guide: Processes & Concepts

This document is the definitive technical reference for the Data Lineage Viz extension. It covers every major architectural component and engineering process.

---

## 1. Data Ingestion: Dual Import Strategies

The extension supports two primary ways to populate the `DatabaseModel`.

### 1.1 DACPAC Extraction (`dacpacExtractor.ts`)
- **Source**: Static `.dacpac` files (SQL Server Data Tier Application Packages).
- **Process**: 
    1. Unzip using `jszip`.
    2. Parse `model.xml` using `fast-xml-parser`.
    3. Map XML elements (Table, View, Procedure) to `ExtractedObject`.
    4. Extract dependencies directly from the XML's `Relationship` nodes (deterministic).
- **Benefit**: Offline usage, high performance, zero database connection required.

### 1.2 SQL/DMV Extraction (`dmvExtractor.ts`)
- **Source**: Live SQL Server / Azure SQL Database.
- **Process**:
    1. Execute specific DMV queries (found in `assets/dmvQueries.yaml`).
    2. Phase 1: Retrieve schema lists and metadata preview.
    3. Phase 2: Retrieve full node, edge, and constraint data.
- **Logic**: Uses `sys.sql_expression_dependencies` for edges and `sys.columns` for metadata.

---

## 2. SQL Parsing: The Regex Pipeline

For stored procedure bodies, we avoid heavy AST parsers in favor of a high-performance regex pipeline in `sqlBodyParser.ts`.

### 2.1 The Cleansing Passes
- **Pass 0**: Stack-based block comment removal (handles nested `/* ... */`).
- **Pass 1**: Identifies identifiers `[...]`, strings `'...'`, and line comments `--`. It replaces string content with dummy text to prevent false positives during extraction.
- **Pass 1.5**: Normalizes "Comma Joins" (`FROM T1, T2`) into standard `JOIN` syntax so extraction rules remain simple.

### 2.2 Rule-Based Extraction
- Rules are defined in `assets/defaultParseRules.yaml`.
- Each rule uses a `capture` group to identify potential dependencies.
- **Normalization**: Every captured name is passed through `normalizeCaptured()`, which:
    1. Strips brackets.
    2. Splits 3-part names (`db.schema.obj`).
    3. Filters out **CLR/XML Methods** (e.g., `.nodes()`) using the `sqlMetadata.ts` dictionary.

---

## 3. The Bridge: IPC & Type Safety

### 3.1 BridgeHost Interface
We decouple the extension logic from VS Code using the `BridgeHost` interface. This allows us to run the engine in pure Node.js environments (like unit tests) without a VS Code instance.

### 3.2 Zod Validation (`bridgeContract.ts`)
All communication via `postMessage` is governed by a bidirectional Zod contract:
- **`ExtensionToWebviewMsgSchema`**: Validates everything the Brain sends to the Screen.
- **`WebviewToExtensionMsgSchema`**: Validates everything the Screen sends back.
- **Mandate**: No "any" types allowed in IPC. If a message fails validation, it is caught at the boundary before it can cause a UI crash.

---

## 4. Graph & UI Concepts

### 4.1 Graphology Core
`graphology` is the single source of truth for the lineage map.
- **Logic Locality**: All graph mathematics (reachability, BFS, neighbor discovery) must live in `src/engine/graphAnalysis.ts`.
- **Indexing**: The `neighborIndex` is built during model construction to allow O(1) lookups of connected nodes.

### 4.2 React & Dagre
- **Rendering**: React Flow (@xyflow/react) handles the canvas.
- **Layout**: `dagre` is used to calculate X/Y coordinates. To keep the UI responsive, layout should ideally be non-blocking or triggered via `useTransition`.
- **Custom Nodes**: `CustomNode.tsx` uses standard VS Code CSS variables (`--vscode-editor-foreground`, etc.) to ensure a native look and feel.

---

## 5. Storage: The Metadata Concept

To keep the UI fast, we do NOT send full DDL or thousands of column definitions to the webview at once.

### 5.1 ColumnStore (`columnStore.ts`)
- **Concept**: A "Lazy Loader" for metadata.
- **Extension Side**: Holds the full DDL and Column lists in memory.
- **Webview Side**: Only holds the node IDs and types.
- **Flow**: When a user clicks a node → Webview requests details → `ColumnStore` provides them via the Bridge.

---

## 6. Testing Methodologies

### 6.1 Internal: AI-Driven "Eval-Loop"
- **Tool**: Gemini CLI / Custom Skills.
- **Process**: We use automated agents to perform "Perspective-Based Inspections." 
- **The Skill**: An internal set of prompts that force the AI to simulate edge-case SQL or malformed DACPACs to see if the engine survives.

### 6.2 External: Copilot Participant Tests
- **Tool**: VS Code Extension Tester (`vscode-test`).
- **Mocking**: Since real LLM calls are hard to automate, we use **AI Mock Tests** in `extension.test.ts`. 
- **Process**: We manually invoke the `LanguageModelTool` handlers to verify that the AI's "Tools" (like search) produce valid, readable JSON.

### 6.3 The Testing Viewer Concept
- We use `dumpSmState` to export the entire state of an AI conversation to a JSON file.
- Developers can then drag this file into a "Viewer" (or inspect the JSON) to verify the logic without needing to re-run the entire 30-hop trace.

---

## 7. Mandatory Constraints for Developers

1.  **Shared Metadata**: Never hardcode a SQL keyword. Add it to `src/engine/shared/sqlMetadata.ts`.
2.  **Logic Locality**: If a function calculates something about the graph, it belongs in `src/engine`. If it renders a button, it belongs in `src/components`.
3.  **Stability First**: Always run `npx tsc -p tsconfig.extension.json --noEmit` after changing the bridge.
