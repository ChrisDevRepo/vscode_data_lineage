# Developer Guide: Processes & Concepts

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
- **Engine**: `sqlBodyParser.ts` is a generic rule-runner. It does not contain hardcoded "SELECT" or "INSERT" regexes for business logic; it only handles the pipeline (Cleansing â†’ Rule Execution â†’ Normalization).

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
    - `loadingPhase`: Tracks `load` â†’ `analyze` â†’ `render`.
    - `filter`: A complex `Set`-based object for schema, type, and search filtering.
    - `aiPreview`: Transient state for AI-curated views before they are committed to the `projectStore`.
- **Constraint**: Avoid "prop drilling" by utilizing `VsCodeContext` for global singletons.

### 5.2 CSS Variables
- **Mandate**: Never hardcode hex/rgb colors in components.
- **System**: VS Code Tokens (`--vscode-*`) â†’ Extension Aliases (`--ln-*`) in `src/index.css`.
- **Testing**: Every UI change must be verified in **Light**, **Dark**, and **High Contrast** themes.

### 5.2 Metadata-Driven AI Overlays
- **Logic**: The presentation of AI findings (sections, badges, descriptions) AND what the AI captures per hop are both driven by `assets/aiOutputTemplates.yaml`.
- **Customization**: Users override both capture and render behaviour without touching the state-machine code. Override path: VS Code setting `dataLineageViz.ai.outputTemplateFile`. Users read the YAML's `stages:` field on each key to understand where that key's instruction is injected.
- **Naming convention: phase-pure keys.** `*_capture` keys fire at ACTIVE; `*_subsection` keys fire at SYNTHESIS. No dual-stage preambles, no `CAPTURE (active phase)` / `RENDER (synthesis phase)` labels inside instruction text. The AI reads clean, phase-specific guidance without meta about phases it isn't in.
- **Stage routing â€” authoritative map.** `STAGE_BY_KEY` in `templateRenderer.ts` is the single source of truth for phase routing. The YAML `stages:` field on each key is informational for power users reading the YAML; a user overlay that disagrees with the canonical routing is logged (WARN) and ignored. Fallback on malformed user YAML: loader shows a VS Code notification + reverts to shipped defaults.
- **Phase assignment** â€” canonical mapping (source of truth: `STAGE_BY_KEY` in [`src/ai/templateRenderer.ts`](../src/ai/templateRenderer.ts)):
  - `discover` â†’ `summary`, `description` (chat-only answers without SM â€” Class D routing)
  - `active` (per-hop) â†’ `business_capture`, `technical_capture` (capture rules for `detail_analysis`)
  - `done` (synthesis) â†’ full render set (`title`, `intro`, `sections`, `closing`, `notes`, `highlights`, `loading_pattern`, `description`, `business_subsection`, `technical_subsection`) + code-injected `**Mission type:** <value>` line
  - post-synthesis follow-up â†’ same template set as `discover` (`summary`, `description`) plus `present_result` for re-render; see `docs/AI_PROMPTS.md Â§ 1.5` for the closing-circle loop
- **Engine invariants stay in TS.** `buildPhaseBlock('active')` in `prompts.ts` owns the archive contract (`detail_analysis` is SOLE evidence, ANCHORING rule). `buildModeBlock` in `smPrompts.ts` owns the per-mode verdict + routing rules. LaTeX directive lives in `buildBaseBlock` (core rules) because it is tied to the webview renderer. Do not restate these in YAML.
- **Onion layers**: `src/ai/templateRenderer.ts` projects graph topology into the description â€” `renderMetadataBand()` prepends In/Out/Loading-Pattern between `intro` and the first section; `renderSectionObjectTable()` injects a `| Object | In | Out |` table inside any section that groups â‰¥ 2 nodes. Content stays AI-authored; the renderer only supplies topology. Integrated via `orderAndAssemble()` (`src/ai/tools.ts`) through the `metadataBand` + `sectionTableFor` options.
- **Classification gate** (`src/ai/classification.ts`): mission-type signal (`business | technical | both`) resolved heuristically from mission brief + user question at the activeâ†’synthesis transition. Zod-enum-validated at `AiSession.setClassification()` (boundary). Inline mode streams a one-line banner; SM mode folds the signal into the pre-existing `confirm_sm_start` messaging. `CLASSIFICATION_GATED` in `templateRenderer.ts` maps capture + subsection keys to their allowed classification values â€” at ACTIVE the gate is open (classification undefined â†’ both angles fire); at SYNTHESIS it filters to the resolved value.

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
- **Versioning**: Follow the `feature/*` â†’ `testing` â†’ `main` branch flow.

---

## 8. Prompt System Architecture

### 8.1 Builder Function Hierarchy

All prompt text is assembled by composing pure functions. Each function owns exactly one concern.

| Function | File | Fires when | Concern |
|---|---|---|---|
| `buildGeneralSystemPrompt(platform, schemas, phase)` | `prompts.ts` | always | Role, platform, schemas, phase label, global invariants (validate, no fabrication, LaTeX, output-shape decision) |
| `buildDiscoveryPrompt()` | `prompts.ts` | discover only | Discovery-phase protocol: search, mission_brief authoring, `start_exploration` rules |
| `buildActivePhasePrompt(isInline)` | `prompts.ts` | active only | Active-phase protocol: hop loop discipline, verdict semantics, archive contract |
| `buildSynthesisPrompt()` | `prompts.ts` | synthesis only | Synthesis-phase protocol: READ â†’ ANSWER â†’ GROUP â†’ WRITE. Forces a one-sentence big-picture intro before per-section work and names variant-sibling grouping (same section + per-variant distinction lines) without compressing per-slot depth |
| `buildFollowUpPrompt()` | `prompts.ts` | completed only | Follow-up-phase protocol: refinement, not re-exploration. Text edits / prunes â†’ re-render `present_result`; deferred-question adds â†’ `start_exploration({ supplement })`; catalog lookups â†’ `get_object_detail` / `search_ddl` |
| `buildToolUsageBlock()` | `prompts.ts` | active only | `submit_findings` / `get_ddl_batch` usage + routing |
| `buildModeBlock(isInline, targetColumns?)` | `smPrompts.ts` | active only | BB verdict/analysis/routing; CT = BB + column protocol |
| `buildColumnAspectPrompt(targetColumns)` | `prompts.ts` | CT active only | `<column_state>` XML block (column-trace context) |
| `resolveStagePrompt(templates, phase, cls)` | `templateRenderer.ts` | always | YAML `*_capture` (active) + `*_subsection` (synthesis) rules. `completed` passes `'synthesis'` so re-renders keep the same formatting contract |
| `buildMissionBlock(brief, q, task)` | `prompts.ts` | active + synthesis + completed | `<mission_brief>` + `<current_task>` XML blocks |
| `buildMemoryBlock(stm, tally, hop, n)` | `prompts.ts` | SM active only | `<short_term_memory>` XML block + tally line |

Composition lives at [`src/ai/lineageParticipant.ts:309-353`](../src/ai/lineageParticipant.ts#L309-L353) `buildStageSystemPrompt`.

### 8.2 Condition Matrix

Four axes drive what fires: **phase** (discover/active/synthesis/completed), **execution** (SM/inline), **nav mode** (BB/CT), **classification** (undefined/business/technical/both).

```
Block                       discover  active-SM-BB  active-SM-CT  active-inline  synthesis  completed
buildGeneralSystemPrompt      âœ…          âœ…             âœ…             âœ…            âœ…           âœ…
buildDiscoveryPrompt          âœ…          â€”             â€”             â€”            â€”           â€”
buildActivePhasePrompt        â€”          âœ…             âœ…             âœ…            â€”           â€”
buildSynthesisPrompt          â€”          â€”             â€”             â€”            âœ…           â€”
buildFollowUpPrompt           â€”          â€”             â€”             â€”            â€”           âœ…
buildToolUsageBlock           â€”          âœ…             âœ…             âœ…            â€”           â€”
buildModeBlock(BB)            â€”          âœ…             â€”             âœ…(BB)         â€”           â€”
buildModeBlock(CT)            â€”          â€”             âœ…             âœ…(CT)         â€”           â€”
buildColumnAspectPrompt       â€”          â€”             âœ…             âœ…(CT)         â€”           â€”
resolveStagePrompt (YAML)     âœ…*         âœ…*            âœ…*            âœ…*           âœ…**         âœ…**
buildMissionBlock             â€”          âœ…             âœ…             âœ…            âœ…           âœ…
buildMemoryBlock              â€”          âœ…             âœ…             â€”            â€”           â€”
```

`*` active: classification=undefined â†’ both `business_capture` and `technical_capture` fire.  
`**` synthesis / completed: `business_subsection`/`technical_subsection` gated by resolved classification. `completed` reuses the synthesis YAML so `present_result` re-renders keep the same formatting contract.

### 8.3 Hybrid Markdown + XML Format

- **Markdown headers** for static structural sections (protocols, numbered rules, verdict tables).
- **XML tags** only for dynamic per-hop data that rules already reference by name:
  - `<mission_brief>` â€” filled from `engine.memory.getMissionBrief()`
  - `<current_task>` â€” filled from `engine.getCurrentTask()`
  - `<short_term_memory>` â€” filled from `engine.memory.getShortTermMemory()`
  - `<column_state>` â€” filled from `engine.columnAspect` (CT only, inside `buildModeBlock`)

This matches the Anthropic guidance: XML tags for precise slot identification of dynamic content; Markdown for document structure.

### 8.4 What Moves Out of Tool Result JSON

The following fields were previously in the `getHopContext()` JSON return and are being moved to the system prompt:

| Field | Was in JSON | Now in system prompt via |
|---|---|---|
| `mission_brief` | `HopContext.mission_brief` | `buildMissionBlock` |
| `current_task` | `HopContext.current_task` | `buildMissionBlock` |
| `working_memory.short_term_memory` | `WorkingMemory.short_term_memory` | `buildMemoryBlock` |
| `working_memory.tally` | `WorkingMemory.tally` | `buildMemoryBlock` |

Remaining in JSON: `sm_status`, `hop`, `agenda_remaining`, `focus_node` (DDL), `neighbors`, `working_memory.checklist`, `working_memory.approved_border`, `working_memory.topological_map`, `working_memory.recent_rejections`, `working_memory.column_aspect`.

### 8.5 Agenda Composition â€” Bipartite Rule

The analysis agenda (what the AI hops through) is **not** the same set as the BFS scope (what the AI may reference). Scope is strictly larger â€” it contains passive nodes (tables, externals) that the AI can inspect or prune, but never hop on.

**Single funnel:** all agenda writes go through `NavigationEngine.enqueueHop` in [`src/ai/smBase.ts`](../src/ai/smBase.ts). There are three callers â€” origin init, `seedAgenda`, and `submitFindings` route enqueue â€” and none of them bypasses the funnel. The bipartite invariant (`agenda.every(e => SCRIPT_TYPES.has(e.type))`) holds by construction.

**Edge contraction:** when `enqueueHop` is called with a non-bodied target (a table or external), it does not push. Instead it forwards the authored question verbatim to the target's bodied neighbors in the current exploration direction (`this._direction`, set at `init`). The caller's routing intent flows *through* the passive node to the real analysis targets. A cycle guard prevents infinite recursion on reference-to-reference chains.

**Why this matters for prompts.** `<current_task>` is rendered from the agenda entry's `question` field. When a proc routes to a table, the table's bodied neighbors inherit the proc's question verbatim â€” so Hop N+1's `<current_task>` carries the authored intent from Hop N without the prompt having to explain the forwarding. The prompt template does not need a "table-hop" variant because tables never become focus.

**Test coverage:** [`tests/unit/navigation-engine-bipartite.test.ts`](../tests/unit/navigation-engine-bipartite.test.ts).

### 8.6 Adding or Changing Prompts

See `.claude/skills/prompt-change/SKILL.md`. Key rules:
1. Every prompt change must target a specific builder function. No free-form strings in `lineageParticipant.ts`.
2. Changes to YAML `*_capture` and `*_subsection` keys must be paired â€” a capture change without the matching subsection change drifts content from capture to render.
3. Run `npm test` after every change. Eval with `python tests/eval/run.py` for quality regressions.

### 8.7 Completed Phase â€” Follow-Up Protocol & Supplement Flow

After synthesis emits, `dispatchExit('final_answer')` (when `sess.stateMachine?.status === 'complete'`) calls `sess.enterCompleted()`. Two INFO logs fire: `[Phase] synthesis â†’ completed â€” archive slots=N, deferred=M` and an immediately-following DEBUG `[Phase] follow-up ready â€” â€¦`. Archive, engine, classification, mission brief, and deferred-question bucket survive on the session singleton.

**Next-turn routing.** `handleChatRequest` detects `sess.phase.kind === 'completed' && chatContext.history.length > 0` and sets `activePhase = 'completed'`. Tool set is filtered to the `completed` kind in `toolPolicy.ts`: `present_result`, `get_object_detail`, `search_ddl`, `search_objects`, `start_exploration`. The system prompt is built with `buildFollowUpPrompt()` + the synthesis-stage YAML block (same formatting contract) + `<mission_brief>`.

**Archive delivery in the follow-up turn.** No new read accessor on `AiMemoryManager`. The prior `submit_findings` tool_result, containing `detail_slots[]`, rides into the next turn via VS Code's automatic `chatContext.history` replay â€” `historyManager` compacts stale hop results but preserves the final synthesis result. The AI addresses the archive directly from the replayed tool_result.

**Supplement-agenda flow.** When the AI calls `lineage_start_exploration({ supplement: { nodeIds: [â€¦] } })` from the `completed` phase, the handler:

1. Validates the prior engine exists and has `status === 'complete'` â€” otherwise returns `supplement_requires_complete_engine`.
2. Calls `engine.supplementAgenda(nodeIds)` on `NavigationEngine`. The engine: (a) pushes ids through `enqueueHop` so the bipartite rule still holds (body-less ids contract through to bodied neighbors), (b) forces `_inlineMode = true`, (c) flips `_status` from `complete` to `awaiting_findings`. Unknown ids are reported in the returned `{ agendaed, contracted, skipped }` counts rather than raising.
3. Calls `sess.enterExploring()` and logs `[Phase] completed â†’ exploring (supplement) â€” nodeIds=N agendaed=A contracted=C skipped=S`.
4. Returns the first hop context. The normal hop loop + synthesis drain the supplement and re-emit `present_result` with the enlarged scope. New `storeDetail` calls merge into the existing `AiMemoryManager.detailSlots` (no reset).

**Supplement bypasses `confirm_sm_start`.** The gate check at `startExploration` only fires when `origin` is present (the fresh-exploration path). Supplement paths short-circuit before the gate logic because the user has already consented to the parent exploration.

**Fresh exploration from `completed`.** If the AI decides the user's refinement is actually a new trace (new origin, new direction), it calls `start_exploration` with an `origin` â€” the handler detects `sess.phase.kind === 'completed' && prior.status === 'complete'`, logs `[Phase] completed â†’ discover`, calls `sess.resetExploration()`, and proceeds on the normal fresh-SM path (including the `confirm_sm_start` gate).

**Test coverage:** [`tests/unit/navigation-engine-supplement.test.ts`](../tests/unit/navigation-engine-supplement.test.ts) â€” 21 assertions covering status guards, unknown-id skipping, bodied-id enqueuing, inline-mode forcing, and archive merge without reset.
