# Internal Developer Guide: Processes & Concepts

This document is the definitive technical reference for the Data Lineage Viz extension. It covers every major architectural component, engineering process, and mandatory coding standard.

---

## 1. Core Engineering Mandates (The "Stability-First" Policy)

**Priority: Stability > Performance > Features.**

### 1.1 Critical Gates
- **Explicit Approval Required**: Any change to parser logic (`sqlBodyParser.ts`), AI state machines, or prompt surfaces (`extension.ts`, `aiOutputTemplates.yaml`) must be reviewed and approved.
- **Zero Regression Policy**: Any change to SQL parsing rules must result in an identical output for the 301 stored procedures in the baseline set (10 classic, 21 SDK-style, 270 customer-anonymized).

### 1.2 No Blackbox Policy (Auditable Logic)
The extension must never be a "Blackbox" for DBAs.
- **Metadata Driven**: SQL parsing is 100% driven by YAML metadata (`assets/defaultParseRules.yaml`). Code should only implement the engine that executes these rules.
- **Action Logging**: Every significant action (SQL execution, file read, AI tool invocation) must be logged to the Output Channel with category tags.
- **Transparency**: A DBA must be able to inspect the YAML rules and logs to understand exactly how a lineage edge was discovered.

---

## 2. Data Ingestion: Dual Import Strategies

Both strategies produce the same `DatabaseModel` structure.

### 2.1 DACPAC Extraction (`dacpacExtractor.ts`)
- **Mechanism**: Unzips `.dacpac` and parses `model.xml`.
- **Constraint**: Only **AdventureWorks** sample dacpacs are allowed in the public `test/` folder. **NEVER** commit customer dacpacs.

### 2.2 SQL/DMV Extraction (`dmvExtractor.ts`)
- **Process**: Two-phase load.
    - **Phase 1**: Full catalog load (names only) for cross-schema resolution.
    - **Phase 2**: Deep-dive load (columns/DDL) for selected schemas.
- **SQL Injection**: Always use `escapeRegexLiteral` or parameterized patterns when expanding schema placeholders.

---

## 3. SQL Parsing: The Regex Pipeline

### 3.1 Metadata-Driven Extraction
- **Rules**: Extraction logic is stored in `assets/defaultParseRules.yaml`.
- **Engine**: `sqlBodyParser.ts` is a generic rule-runner. It does not contain hardcoded "SELECT" or "INSERT" regexes for business logic; it only handles the pipeline (Cleansing → Rule Execution → Normalization).

### 3.2 Cleansing Pipeline
- **Comment Removal**: Stack-based removal of nested block comments.
- **Literal Neutralization**: Replaces string content with `''''` to prevent false positive regex hits.
- **Normalization**: All identifiers must be lowercased via `schemaKey()` for consistent hashing and Map keys.

### 3.3 Metadata Suppression (`sqlMetadata.ts`)
- **Mandate**: Never hardcode a system schema or CLR method. Centralize them in this file.
- **Filtering**: Captures that match `CLR_TYPE_METHODS` (e.g., `.nodes()`, `.value()`) are rejected unless they are bracket-quoted, which signifies intent as a catalog object.

---

## 4. The Bridge: IPC & Zod Validation

### 4.1 Type Safety (`bridgeContract.ts`)
- **Mandate**: 100% of messages sent via `postMessage` must be validated against a Zod schema.
- **Error Handling**: Use the `Result<T, E>` pattern. Avoid throwing errors across the bridge; send an `{ type: 'error' }` message instead.

### 4.2 Logging Protocol (`src/utils/log.ts`)
- **Standard Categories**: `[AI]`, `[Bridge]`, `[Config]`, `[DB]`, `[Dacpac]`, `[Detail]`, `[Parse]`, `[Project]`, `[Stats]`.
- **Truncation Rules (Human View)**:
    - AI Prompts/Reasoning: Max 200 chars.
    - JSON Payloads: Max 300 chars.
- **AI Truncation Rule (Semantic Integrity)**:
    - **NEVER** truncate semantic content intended for the AI Brain (DDL, column lists, results).
    - **Normalization**: Only remove noise (duplicate whitespace, repetitive boilerplate) to save tokens while keeping 100% of the meaning.

---

## 5. UI & Theming

### 5.1 CSS Variables
- **Mandate**: Never hardcode hex/rgb colors in components.
- **System**: VS Code Tokens (`--vscode-*`) → Extension Aliases (`--ln-*`) in `src/index.css`.
- **Testing**: Every UI change must be verified in **Light**, **Dark**, and **High Contrast** themes.

### 5.2 Metadata-Driven AI Overlays
- **Logic**: The presentation of AI findings (sections, badges, descriptions) is driven by `assets/aiOutputTemplates.yaml`.
- **Customization**: This allows users to override how the AI "narrative" is structured without touching the core state-machine code.

---

## 6. Testing & AI Verification

### 6.1 Internal "Eval-Loop"
- **Model Policy**: Internal AI evaluations must use **Sonnet** (`claude-sonnet-4-6`) for high-fidelity reasoning.
- **Verification**: Use `dumpSmState` to generate JSON snapshots of AI sessions for manual inspection without re-running 30-turn traces.

### 6.2 External Integration Tests
- **Tool**: `vscode-test` launches a clean VS Code instance.
- **AI Mocking**: `src/test/suite/extension.test.ts` contains mock tests that manually invoke AI tools to verify they return readable JSON (e.g., the "search for employee" test).

---

## 7. Developer Hygiene

- **File Size**: Decompose functions at >100 lines. Decompose components at >500 lines.
- **Type Check**: Always run `npx tsc -p tsconfig.extension.json --noEmit` before committing to the `testing` branch.
- **Versioning**: Follow the `feature/*` → `testing` → `main` branch flow.
