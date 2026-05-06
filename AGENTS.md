# AGENTS.md

## Read This First
- For non-trivial changes, read `.github/copilot-instructions.md` first; it points to the architecture and testing docs this repo treats as canonical.

## Branch Discipline
- For this workstream, treat `testingnew` as the base branch and create follow-up work on `testing2` (or descendants) from that base.
- Do not use `main` as a base, comparison target, rebase target, or merge target for this workstream.

## Toolchain And Build Reality
- Use `npm` (lockfile is `package-lock.json`; no workspace/monorepo tooling).
- Use Node 20+ in practice (lockfile contains dependencies that require `node >=20`).
- `npm run build` is the release build (`build:ext` via esbuild -> `out/extension.js`, plus `build:webview` via Vite -> `dist/`).
- VS Code `Run Extension (Watch)` runs `npm run watch`, but `watch` only watches the extension host (`esbuild --watch`); webview edits still require `npm run build:webview`.

## Verification Commands (Preferred Order)
- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- If AI state-machine/tooling changed: `npm run test:unit:ai`
- If React hooks changed: `npm run test:hooks`
- If parse rules changed (`assets/defaultParseRules.yaml`): run `npm run test:snapshot`; if intentional, run `npm run test:snapshot:update` and commit `tests/fixtures/aw-baseline.tsv`.

## Focused Test Shortcuts
- Single test file: `npx tsx tests/unit/<name>.test.ts`
- Existing narrow scripts: `npm run test:dacpac`, `npm run test:graph`, `npm run test:parser`, `npm run test:analysis`, `npm run test:dmv`, `npm run test:sql`, `npm run test:project`

## Fixtures And Integration Gotchas
- Many unit/snapshot/integration tests expect local DACPAC fixtures at:
  - `tests/fixtures/AdventureWorks2025_AI.dacpac`
  - `tests/fixtures/AdventureWorks_sdk-style.dacpac`
- Those DACPACs are intentionally gitignored (`tests/fixtures/*.dacpac`), so test failures from missing fixtures are common on fresh clones.
- Integration command is `npm run test:integration` (not `test:db`).
- `test:integration` always runs DACPAC/parser checks first, then runs live DB tests only when `DB_SERVER` is set.
- Live DB env vars used by tests: `DB_SERVER`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE_AW`, `DB_DATABASE_AW_DW`, optional `DB_ENCRYPT`, `DB_TRUST_SERVER_CERT`.

## High-Risk Sync Points
- Extension/webview IPC is strict: update `src/engine/shared/bridgeContract.ts` (Zod schemas) together with bridge handlers (`src/panelProvider.ts`, `src/bridge/messageHandlers.ts`).
- AI tools are dual-declared: `package.json` (`contributes.languageModelTools`) and `src/ai/toolProvider.ts` (`vscode.lm.registerTool`). Keep names in sync or `tests/unit/ai-tool-registration.test.ts` fails.
- If `Project` or `FilterProfile` shapes change, update validation/migration in `src/engine/projectStore.ts` (`migrateProjectStore`, guards).

## AI Phases And Ownership (Read Before AI Edits)
- Canonical references: `docs/ARCHITECTURE.md`, `docs/AI_PROMPTS.md`, `docs/DEVELOPER_GUIDE.md`, then `src/ai/lineageParticipant.ts`.
- Session phases are a typed FSM in `src/ai/sessionPhase.ts`: `idle` -> `awaiting_gate` -> `exploring` -> `synthesis` -> `completed`.
- Ownership split is strict:
  - Discovery/synthesis narration is AI-driven.
  - Consent gates + SM hop drain are engine-driven.
  - `dispatchExit` in `src/ai/lineageParticipant.ts` is the single cleanup/finalization switch for hop-loop exits.
- `start_exploration` always enters the consent flow (`confirm_sm_start`) before analysis runs; refine loops re-call `start_exploration` with a full re-spec.

## Discovery-First Trigger Policy
- Product intent: default to discovery-only handling for most ad-hoc asks (search/object detail/direct explanation) and avoid unnecessary escalation into SM phases.
- Start exploration (`lineage_start_exploration` -> `exploring`/`synthesis`/`completed`) only when at least one trigger is true:
  - Column Trace is explicitly requested (`targetColumns` present).
  - User explicitly wants AI preview/graph-ready synthesized output (`present_result` path).
  - Scope/complexity exceeds single-turn budget and needs hop orchestration (bounded by `dataLineageViz.ai.inlineTokenBudget` and `dataLineageViz.ai.maxRounds`).
- If none of the above triggers apply, prefer discovery tools and return chat prose; do not escalate to SM only because multiple objects are mentioned.
- Consent-gate semantics remain unchanged whenever `start_exploration` is invoked.

## Vendor-Aligned Retry + Error Policy
- Do not retry deterministic validation failures blindly (schema mismatch, unknown ids, scope/budget rejection, classification lock violations). Surface the tool hint and require user refinement/approval before reattempting.
- Retry only transient failures (network/timeouts/provider API 429-style throttling) with bounded exponential backoff + jitter and a max-attempt cap.
- Distinguish provider throttling from exploration budgeting: `scope_exceeds_budget` / token-window scope pressure are deterministic orchestration limits (switch to hop-by-hop or narrow scope), not transient API rate limits.
- Remember failed retries still consume provider quota; avoid tight retry loops.
- Return instructive tool errors: name what failed, why, and the concrete next action (for example: search id, narrow depth, approve expansion, or wait/retry).
- Prefer strict schema-conformant tool calls (`strict` style contract thinking): tool schemas and code validation are authoritative over prompt prose.
- If inputs are ambiguous, ask a clarifying question instead of inventing function arguments.
- For over-budget exploration attempts, present the budget hint and pause for user decision (narrow scope or explicit approval path), rather than repeatedly calling `start_exploration` with near-identical args.

## Budget Signals And Token Controls (Important)
- `lineage_search_objects` is a discovery lookup tool to resolve canonical object ids (and optional column-name matches) before structured tool calls; it is not a substitute for hop orchestration on large scopes.
- Discovery-side hard guard: `over_discovery_budget` is emitted when scope-expanding discovery requests exceed `dataLineageViz.ai.discoveryNodeCap` or `dataLineageViz.ai.discoveryTokenBudget`; expected next step is `lineage_start_exploration` (with consent gate), not repeated discovery retries.
- Exploration-side hard guard: `scope_exceeds_budget` is emitted from `start_exploration` when projected scope exceeds safe hop budget (derived from `dataLineageViz.ai.maxRounds`); follow `safe_depth_hint` / narrowing guidance before retry.
- These budget rejections are deterministic orchestration outcomes (needle-in-haystack control), not provider API rate-limit events.
- Current token-control mechanisms in code:
  - Stage prompt gating in `templateRenderer` (for example suppressing `closing` on small slot counts).
  - History replay compaction (`compactNoiseResult`, `compactStaleHopResult`).
  - Sliding-memory envelope reseed (`wipeAndSeed`) after successful SM hops and at synthesis transition.
  - Stable prompt build memoization (`cachedStablePart`) for compute reuse.

## Copilot Chat Participant And Command Surface
- Participant registration: `dataLineageViz.lineage` in `src/ai/lineageParticipant.ts` and `package.json` (`contributes.chatParticipants`).
- Slash commands exposed by participant:
  - `/trace` -> `buildTracePrompt(...)`
  - `/search` -> `buildSearchPrompt(...)`
- AI-related VS Code commands in `src/commands.ts`:
  - `dataLineageViz.aiResolveGate` (approve/cancel/refine gate actions)
  - `dataLineageViz.showDeferredQuestions` (prefill follow-up prompt)
  - `dataLineageViz.aiCreateView` (reveal or synthesize AI graph view)
  - `dataLineageViz.dumpSmState` (debug dump for SM state)
- Tool exposure by phase is code-owned in `src/ai/toolPolicy.ts`; do not infer tool availability from prompt text alone.

## Prompt + YAML Contract (Do Not Drift)
- Prompt assembly root is `buildStageSystemPrompt` in `src/ai/lineageParticipant.ts`:
  - Stable part: general + phase protocol + tool/mode blocks + YAML templates + mission brief.
  - Dynamic part (SM active only): current task + mission state + `<short_term_memory>`.
- Prompt string caching lives in `lineageParticipant`: `cachedStablePart` memoizes the stable prompt by `(phase, focusIsNonBodied)`.
  - Invalidate on phase transitions (`discover -> active -> synthesis`) and whenever focus-bodiedness flips (table vs view/proc/function).
  - This is compute caching only (prompt build reuse), not memory/archive persistence.
- Prompt builders:
  - `src/ai/prompts.ts` (discovery/active/synthesis/follow-up, mission/task/memory blocks)
  - `src/ai/smPrompts.ts` (mode blocks, CT synthesis chain)
- AI output YAML is `assets/aiOutputTemplates.yaml`.
  - Only `instruction` text is injected.
  - Key routing is code-owned in `src/ai/templateRenderer.ts` (`STAGE_BY_KEY`).
  - Classification gates are code-owned in `CLASSIFICATION_GATED`.
  - `structural_summary` is focus-gated (non-bodied focus only).
- Parse/DMV YAMLs are separate concerns:
  - Parse rules: `assets/defaultParseRules.yaml` (requires snapshot tests on change).
  - DMV queries: `assets/dmvQueries.yaml`.

## Prompt De-Dup Boundaries (Phase-Aware)
- De-duplicate **within** a phase; do not over-collapse prompts **across** phases.
- Keep dual data-view framing explicit:
  - **Active / hop-by-hop view:** reason on current focus DDL + immediate tool returns for this hop.
  - **Synthesis view:** reason on the full archived `detail_slots[]` corpus and assemble cross-node conclusions.
- Some anchors are intentionally repeated across phases (safety rails), including: grounding/no-invention, capture-quality implications for synthesis, and classification/contract constraints.
- Prefer one canonical source per phase for shape mechanics (e.g., `sections[]` contract), then reference it from neighboring blocks to reduce drift.
- For Column Trace, keep full binary map/prune contract in YAML (`column_trace_capture`); TS prompt blocks should carry concise hierarchy/reminder text only.

## Hop-By-Hop + Sliding-Memory Invariants
- Engine: `src/ai/smBase.ts` (`NavigationEngine`).
  - `getHopContext()` emits one focus node per SM hop (or batch in inline).
  - `submitFindings()` validates routes/columns/classification contracts and drives agenda progression.
  - `enqueueHop()` is the only agenda-write funnel (bipartite contraction invariant).
- Memory model: single persistent archive + derived working memory.
  - Persistent detail archive: `AiMemoryManager.detailSlots` in `src/ai/memoryManager.ts`.
  - Sliding short-term view: `getShortTermMemory()` -> last 3 summaries (`slice(-3)`).
  - Per-hop `working_memory` is recomputed each hop; it is not a second persisted store.
- What gets wiped vs what persists:
  - **Per-hop in SM (hop-by-hop):** the **message envelope** is wiped/reseeded (`wipeAndSeed`) after successful `submit_findings`; this trims conversation context, not archive memory.
  - **Synthesis transition:** envelope is wiped/reseeded again (optionally preserving the trailing tool-use/tool-result pair) to avoid stale hop context.
  - **Error control:** after 3 consecutive `submit_findings` error rounds, a bounded envelope wipe occurs.
  - **Long memory persists across these wipes:** `detailSlots`, mission brief, user question, verdict tallies, deferred questions.
  - **Long memory resets only on exploration reset paths** (e.g., `sess.resetExploration()` on new chat session, gate cancel/redirect, divergent fresh start, or explicit reset).
- Conversation envelope safety: `src/ai/messageEnvelope.ts`.
  - Use `wipeAndSeed(...)` for sliding-memory rebuild.
  - Preserve tool-use/tool-result adjacency invariants before `sendRequest` (`assertWellFormed`).
- In SM mode, successful `submit_findings` rounds trigger envelope wipe/reseed in participant loop; synthesis transition also performs a bounded context reseed.

## AI Change Verification Quicklist
- Always run: `npx tsc --noEmit`, `npm test`, `npm run build`.
- For prompt/tool/state-machine/memory changes: `npm run test:unit:ai`.
- For tool availability/routing changes: ensure `tests/unit/toolPolicy.test.ts` and `tests/unit/ai-tool-registration.test.ts` pass.
- For parse-rule YAML edits: run `npm run test:snapshot` (and update snapshot only if intentional).

## Local Conventions That Differ From Defaults
- Use the central logger in `src/utils/log.ts`; avoid ad-hoc direct output channel writes.
- Webview styling is token-driven: prefer `--ln-*` / `--vscode-*` variables; schema colors come from `getSchemaColor` in `src/utils/schemaColors.ts`.

## Commit Hygiene Enforced By CI
- Do not commit secrets or sensitive artifacts (`.env*`, keys/certs, credentials JSON, customer/internal/test-data folders, ad-hoc DACPACs). `.github/workflows/security-check.yml` enforces this on PRs.
