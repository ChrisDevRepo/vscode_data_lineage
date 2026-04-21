# Internal Developer Guide: Processes & Concepts

This document is the definitive technical reference for the Data Lineage Viz extension. It covers every major architectural component, engineering process, and mandatory coding standard.

---

## 1. Core Engineering Mandates (The "Stability-First" Policy)

**Priority: Stability > Performance > Features.**

### 1.1 Critical Gates
- **Explicit Approval Required**: Any change to parser logic (`sqlBodyParser.ts`), AI state machines, or prompt surfaces (`extension.ts`, `aiOutputTemplates.yaml`) must be reviewed and approved.
- **Zero Regression Policy**: Any change to SQL parsing rules must result in an identical output for the baseline stored procedure set in `tests/fixtures/aw-baseline.tsv`.
    - **Baseline Composition**: Currently includes ~40 procedures (10 classic, 21 SDK-style from committed dacpacs). An extended set of 270 customer-anonymized procedures is used for private validation and must NEVER be committed.
- **Auditable Logic**:
    - **Metadata Driven**: SQL parsing is 100% driven by YAML metadata (`assets/defaultParseRules.yaml`).
    - **Profiling Transparency**: The `profilingEngine.ts` must generate standard T-SQL. All generated statistics queries must be logged to the Output Channel so DBAs can verify they are non-destructive and performant.
    - **Action Logging**: Every significant action (SQL execution, file read, AI tool invocation) must be logged with category tags.

### 1.2 Coding Standards (gemini.md Rules)
- **Zod Validation**: Strict boundaries required. IPC bridge validation, tool inputs, and extension host boundaries must strictly use zod for strong type safety, runtime validation, and security.
- **DRY & OOP**: Emphasize explicit composition, reusability, and delegation. Do not duplicate logic or introduce anti-patterns to bypass structural designs. The NavigationEngine should serve as the single source of truth.
- **No Chatty Comments**: Omit overly chatty, conversational inline comments inside functions. Focus inline comments on the *why* or complex business rules, not the *what*.
- **Rigorous JSDoc**: Provide rigorous, professional JSDoc comments for all exported types, functions, classes, and properties.

---

## 2. Data Ingestion: Dual Import Strategies

Both strategies produce the same `DatabaseModel` structure.

### 2.1 DACPAC Extraction (`dacpacExtractor.ts`)
- **Mechanism**: Unzips `.dacpac` and parses `model.xml`.
- **Constraint**: Only **AdventureWorks** sample dacpacs are allowed in the public `tests/fixtures/` folder. **NEVER** commit customer dacpacs.

### 2.2 SQL/DMV Extraction (`dmvExtractor.ts`)
- **Process**: Two-phase load (Catalog then Deep-dive).
- **SQL Injection**: Always use `escapeRegexLiteral` or parameterized patterns when expanding schema placeholders.

### 2.3 Persistence (`projectStore.ts`)
- **Mandate**: All user-created projects and saved views must be managed via `projectStore.ts`.
- **Schema Versioning**: Any change to the `Project` or `FilterProfile` types must be accompanied by a version bump and a migration in `migrateProjectStore()`.
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
- **Bridge Abstraction**: The `BridgeHost` interface (`host.ts`) decouples communication from VS Code, enabling the extension logic to be unit tested in Node.js.

### 4.2 Logging Protocol (`src/utils/log.ts`)
- **Standard Categories**: `[AI]`, `[Bridge]`, `[Config]`, `[DB]`, `[Dacpac]`, `[Detail]`, `[Parse]`, `[Project]`, `[Stats]`.
- **Truncation Rules (Human View)**:
    - AI Prompts/Reasoning: Max 200 chars.
    - JSON Payloads: Max 300 chars.
- **AI Truncation Rule (Semantic Integrity)**:
    - **NEVER** truncate semantic content intended for the AI Brain (DDL, column lists, results).

---

## 5. UI & State Management

### 5.1 The "God Store" (`useAppState.ts`)
- **Architecture**: The extension uses a centralized state hook to manage the lifecycle of a lineage session.
- **Key States**:
    - `loadingPhase`: Tracks `load` → `analyze` → `render`.
    - `filter`: A complex `Set`-based object for schema, type, and search filtering.
    - `aiPreview`: Transient state for AI-curated views before they are committed to the `projectStore`.
- **Constraint**: Avoid "prop drilling" by utilizing `VsCodeContext` for global singletons.

### 5.2 CSS Variables
- **Mandate**: Never hardcode hex/rgb colors in components.
- **System**: VS Code Tokens (`--vscode-*`) → Extension Aliases (`--ln-*`) in `src/index.css`.
- **Testing**: Every UI change must be verified in **Light**, **Dark**, and **High Contrast** themes.

### 5.2 Metadata-Driven AI Overlays
- **Logic**: The presentation of AI findings (sections, badges, descriptions) AND what the AI captures per hop are both driven by `assets/aiOutputTemplates.yaml`.
- **Customization**: Users override both capture and render behaviour without touching the state-machine code. Override path: VS Code setting `dataLineageViz.ai.outputTemplateFile`. Users read the YAML's `stages:` field on each key to understand where that key's instruction is injected.
- **Naming convention: phase-pure keys.** `*_capture` keys fire at ACTIVE; `*_subsection` keys fire at SYNTHESIS. No dual-stage preambles, no `CAPTURE (active phase)` / `RENDER (synthesis phase)` labels inside instruction text. The AI reads clean, phase-specific guidance without meta about phases it isn't in.
- **Stage routing — authoritative map.** `STAGE_BY_KEY` in `templateRenderer.ts` is the single source of truth for phase routing. The YAML `stages:` field on each key is informational for power users reading the YAML; a user overlay that disagrees with the canonical routing is logged (WARN) and ignored. Fallback on malformed user YAML: loader shows a VS Code notification + reverts to shipped defaults.
- **Phase assignment** — see `docs-internal/AI_IMPLEMENTATION.md §5.1` for the full table:
  - `discover` → `summary`, `description` (chat-only answers without SM)
  - `active` (per-hop) → `business_capture`, `technical_capture` (capture rules for `detail_analysis`)
  - `done` (synthesis) → full render set (`title`, `intro`, `sections`, `closing`, `notes`, `highlights`, `loading_pattern`, `description`, `business_subsection`, `technical_subsection`) + code-injected `**Mission type:** <value>` line
- **Engine invariants stay in TS.** `BLOCK.writeFindings` in `smPrompts.ts` owns the memory-architecture contract (archive is SOLE evidence, NO NEW FACTS, mission_brief anchor) and the pass/irrelevant verdict shortcuts. LaTeX directive lives in `buildSystemPromptBase` rule #6 because it is tied to the webview renderer. Do not restate these in YAML.
- **Onion layers**: `src/ai/templateRenderer.ts` projects graph topology into the description — `renderMetadataBand()` prepends In/Out/Loading-Pattern between `intro` and the first section; `renderSectionObjectTable()` injects a `| Object | In | Out |` table inside any section that groups ≥ 2 nodes. Content stays AI-authored; the renderer only supplies topology. Integrated via `orderAndAssemble()` (`src/ai/tools.ts`) through the `metadataBand` + `sectionTableFor` options.
- **Classification gate** (`src/ai/classification.ts`): mission-type signal (`business | technical | both`) resolved heuristically from mission brief + user question at the active→synthesis transition. Zod-enum-validated at `AiSession.setClassification()` (boundary). Inline mode streams a one-line banner; SM mode folds the signal into the pre-existing `confirm_sm_start` messaging. `CLASSIFICATION_GATED` in `templateRenderer.ts` maps capture + subsection keys to their allowed classification values — at ACTIVE the gate is open (classification undefined → both angles fire); at SYNTHESIS it filters to the resolved value.

---

## 6. Testing & AI Verification

### 6.1 Internal AI Integration Suite (The New "Eval Loop")
- **Architecture**: AI correctness is validated using `vscode-test` calling real Copilot Chat tools.
- **Tiers**:
    - **Unit AI** (`npm run test:unit:ai`): Validates tools and navigation engine logic.
    - **Eval Suite** (`npm run test:eval`): Runs deep explorations and role-based scenarios.
    - **Snapshot Suite** (`npm run test:snapshot`): Detects parser regressions against `aw-baseline.tsv`.
- **Quality Gate**: Parser changes MUST be verified via `npm run test:snapshot`. Update the baseline via `npm run test:snapshot:update` only after manual audit of the diff.

### 6.2 External Integration Tests
- **Tool**: `vscode-test` launches a clean VS Code instance.
- **Deterministic Core**: Validates dacpac loading, BFS graph traversal, and command registration without LLM dependencies.
- **AI Tool Mocking**: `src/test/suite/ai-integration.test.ts` contains programmatic tests that invoke tools directly via `vscode.lm.invokeTool` to verify SM logic with zero UI latency.

---

## 7. Developer Hygiene

- **File Size**: Decompose functions at >100 lines. Decompose components at >500 lines.
- **Type Check**: Always run `npx tsc -p tsconfig.extension.json --noEmit` before committing to the `testing` branch.
- **Versioning**: Follow the `feature/*` → `testing` → `main` branch flow.
