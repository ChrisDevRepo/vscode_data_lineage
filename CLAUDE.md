# CLAUDE.md — Project Map for AI Assistants

VS Code extension for SQL data-lineage visualization and AI-assisted tracing. A graphology engine parses SQL Server dacpacs (or live DB metadata) into a directed dependency graph; the `@lineage` chat participant walks it hop-by-hop with an LLM.

Entry points: [`lineageParticipant.ts`](src/ai/lineageParticipant.ts), [`smBase.ts`](src/ai/smBase.ts) (`NavigationEngine`), [`toolProvider.ts`](src/ai/toolProvider.ts), [`toolPolicy.ts`](src/ai/toolPolicy.ts), [`templateRenderer.ts`](src/ai/templateRenderer.ts), [`prompts.ts`](src/ai/prompts.ts) + [`smPrompts.ts`](src/ai/smPrompts.ts), [`messageEnvelope.ts`](src/ai/messageEnvelope.ts), [`sessionPhase.ts`](src/ai/sessionPhase.ts), [`memoryManager.ts`](src/ai/memoryManager.ts), [`scopeSummaryRenderer.ts`](src/ai/scopeSummaryRenderer.ts), [`panelProvider.ts`](src/panelProvider.ts) + React UI under [`src/components/`](src/components).

Architecture deep-dive: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md), [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).

---

## Mental model

- **Engine owns the map; AI is the router.** `NavigationEngine` keeps agenda, scope, depth, gates. AI writes `submit_findings.sections[]` + verdict + `route_requests`. Engine guards are topological — never content-quality.
- **System prompt = stable prefix + dynamic suffix.** `buildStageSystemPrompt(phase)` memoizes stable string in-process; rebuilds dynamic per-hop block (`<current_task>`, `<short_term_memory>`, `<mission_state>`). No server-side caching — VS Code LM API has no `cache_control`. `dedup=hit` in debug logs = `toolCallCache` (same tool + same JSON → skips engine call, not LLM caching). Token counts = `model.countTokens()` local estimate only.
- **Two-stage template gate.** [`templateRenderer.ts`](src/ai/templateRenderer.ts) routes YAML keys via `STAGE_BY_KEY` (phase) → `CLASSIFICATION_GATED` (per-classification). `closing` adds `slotCount >= 5`.
- **Memory.** `AiMemoryManager` writes one `DetailSlot` per visited node. Sliding-wipe per hop via `MessageEnvelope.wipeAndSeed`, preserving trailing `(tool_use, tool_result)`.
- **Execution mode** (`engine.inlineMode`): `inline` = ≤10 nodes + ≤10K tokens and no `targetColumns`; `SM` = larger or CT active. Locked at gate approval. Refine = full reset; may land in different mode.
- **Column Tracing (CT).** Activated by `targetColumns` in `start_exploration`. Forces SM regardless of scope size. Per hop: binary decision — fill `column_flow` (map each active column to its upstream source) OR use `verdict=prune`. `column_flow` is the PRIMARY deliverable; `sections[].text` is SECONDARY context explaining the flow. Engine generates lineage sub-questions from accumulated edges; these are the primary follow-up signal for the next hop. Execution parameters (`@StartDate`, `@Mode`, etc.) are never column lineage sources — they belong in `sections[].text` only. For procedure focus: `out_col` = column name in the target table (same as `writes_to.col`); `from_col` for procedure/function contributors is not validated against `parseProcParams` output (execution @params are the wrong metadata). Tables and views are readers with verifiable column schemas and are always validated. `structural_summary` template fires only for non-bodied (table) focus nodes; normal capture templates fire for all other node types. **Active-column derivation:** at dequeue time, if a node's `activeColumns` is empty (route_request omitted `columns`), the engine derives them from accumulated edges — `edges.filter(from_node === nodeId).map(from_col)`. **CT auto-prune:** nodes where derivation also yields nothing have no trackable columns and are pruned by the engine without an AI call (no `submit_findings` required).
- **Session phases** (`sessionPhase.ts`): `idle → awaiting_gate → exploring → synthesis → completed`. Tool sets per phase in `toolPolicy.ts`.
- **Gate detail** from `engine.getScopeSummary()` → `renderScopeSummaryMd`. Single source of truth for Schema → Type → Node tree above Approve/Refine/Cancel.

---

## Key behavioral rules

- **Mechanical enforcement > prompt prose.** Enforce invariants in code, not prompt sentences. See `code-quality.md` § Mechanical Enforcement. Char-targets in tool-param `description` fields are treated as ceilings by recency bias (2026-04-12 finding) — move soft targets to YAML `instruction` fields; keep only `maxLength` JSON Schema constraints in param schemas.
- **Zod at the boundary.** Untrusted payloads parse through Zod once at the edge; inner layers consume the parsed type.
- **Reject only on mechanical contracts.** Type / length / identifier / structure. Never on prose length, compression, narrative depth.
- **Per-hop prompts are *rendered*, not *configured*.** Engine has already locked mode, classification, phase, agenda. Prompt must reflect these as *fait accompli*: no menus of inactive classifications, no routing/pruning teaching for decisions the engine owns. Filter rules text by locked classification (`CLASSIFICATION_GATED`); branch by `engine.inlineMode`. Drop engine-state echoes (`engine_status`, `expected_reply`, `legal_replies`) — enforced mechanically via `LanguageModelChatToolMode.Required` + `toolPolicy`. AI is the worker; engine is the orchestrator.
- **Classification is a guideline for emphasis, not a strict content policy.** `CLASSIFICATION_GATED` controls which template the AI receives. Template design rules: body recipes must not name the inactive angle (negative priming) — use positive content checklists instead. Cross-angle redirect lines render only when `classification === 'both'`. Body-recipe vocabulary stays within the locked angle.
- **Root-cause before prompt change (diagnose before treating).** Run the 8-check diagnostic before editing any prompt: (1) **Input completeness** — full DDL? full `<short_term_memory>`? `wipeAndSeed` preserving trailing pair? (2) **Detail-memory completeness** — `sections[].text` not truncated? archive verbatim into synthesis? (3) **Next-hop question quality** — `question` substantive? `sub_question` not degraded? (4) **Schema-contract integrity** — `HopFindingSchema` accepts promised shape? `DetailSlot` carries field synthesis reads? (5) **Mechanical guard** — `Required` set? `toolPolicy` filtering? Zod rejecting? (6) **Engine state** — gate emitted? exclusions honored? NL type-level mapped? (7) **Render-side fidelity** — LaTeX, markdown, theme tokens? (8) **Stage placement** — correct phase + surface? Only after all 8 pass does the symptom belong in the prompt. Most requests resolve at checks 1–4.
- **Prompt changes go through the [`prompt-change`](.claude/skills/prompt-change/SKILL.md) skill.** Pre-condition: 8-check diagnostic cleared. One change per iteration; atomic commit (`prompt(surface): hypothesis / Was: … / Now: … / Principle: … / Target failure class: …`); `knowledge.json` append. Direct edits bypass the eval-integrity gate and contaminate baselines.
- **User-as-System invariant.** VS Code LM API has no `system` role. Msg 0 = `User` with instructions; current request = separate trailing `User` msg. Never combine.
- **Use `request.model`** inside the handler. Don't call `selectChatModels()` during a turn.
- **Sliding wipe on success, preserve on error.** Wipe only when `!anyError`; after 3 consecutive errors, force bounded wipe.
- **Hop_cap is all-or-nothing.** On `MAX_ROUNDS` before agenda drains, discard partial archive and render the rerun message.
- **SM is content-blind.** Engine guards are topological. AI's `complete: true` in SM is silently ignored — engine emits the synthesis trigger when the agenda drains.
- **Bipartite agenda.** Only bodied nodes (view/proc/function) are hop targets. Tables stay routable/inspectable. Starting-point table gets its own slot.
- **Discovery always gates.** Every `start_exploration` from `idle` emits `confirm_sm_start` first — inline or SM. Refine reuses the engine and re-emits.
- **Gate detail always visible while `awaiting_gate`.** `dispatchExit` finalizer rebuilds detail from `engine.getScopeSummary()` when the AI narrates without re-calling `start_exploration`.
- **Classification is hard-required, no fallback.** `start_exploration` Zod requires `classification: z.enum(['business','technical','both'])` — missing values rejected at boundary. AI tool-param description biases toward `business` for ambiguous intent (`technical` only on explicit perf/index/tuning; `both` only on explicit "both angles"). `submit_findings.sections[]` validated against locked value (`validateSectionsAgainstClassification`).
- **NL exclusions stay structural.** User-named identifiers translate to `excludeNodeIds`, not `excludeTypes`. `engine.init()` rejects unresolved ids with `unknown_node_ids` so the AI can't invent wrong-schema ids and silently no-op.
- **Refine round reuses the engine.** While `awaiting_gate(confirm_sm_start)`, a second `start_exploration` is a re-spec. `isRefining` keys on `phase + gate`, never on `engine.status`.
- **CT is map-or-prune.** On every CT hop, the AI makes one binary decision per tracked column: fill `column_flow` (analyze/pass) or prune. No third path. Missing `column_flow` on a non-prune verdict returns `column_flow_required`. Lineage sub-questions (engine-generated from accumulated edges) are the primary next-hop signal — more important than the AI's own sub_question. `column_flow` carries data-column provenance only; execution parameters (@StartDate, @Mode, etc.) never appear in `column_flow`. Active columns for each hop are set from `route_requests.columns` when provided; when omitted, the engine derives them from accumulated CT edges at dequeue time. Nodes with no edge-derived columns are auto-pruned by the engine — the AI never sees those hops.
- **Follow-up reuses the archive — three convergent operations, no gate, no memory wipe:** (1) text/label edits and prunes via `present_result`; (2) add specific nodes via `start_exploration({ supplement: { nodeIds } })` — bypasses gate, forces inline; (3) same-origin retrace (e.g. different column on the same view) via `start_exploration({ origin: sameOrigin, targetColumns: [...] })` — engine auto-routes to supplement, re-queues visited nodes **in SM**, propagates new `targetColumns`/`mission_brief`/`question`. Different-origin `start_exploration` from `completed` is the only divergent path (gate + archive wipe).
- **Stream lifecycle via `ChatResponseWriter`.** Never call `stream.markdown/progress/button` directly — writer degrades silently on host reload.
- **Tool-phase preconditions are mechanical.** `submit_findings` rejects when `engine.status === 'complete'`; `present_result` rejects when no `resultGraph`. Checks run before Zod parse.
- **Identifier-match guard on `submit_findings`.** Captured `section.text` whose opening 200 chars name a different scope node than `focus_node_id` rejects with `focus_subject_mismatch`.
- **YAML-key registration is a 5-step contract.** New template key requires updates in: (1) `aiOutputTemplates.yaml`, (2) `types.ts` `AiOutputTemplates` + `EMPTY_AI_TEMPLATES`, (3) `templateRenderer.ts` `STAGE_BY_KEY`, (4) `templateRenderer.ts` `CLASSIFICATION_GATED` (if angle-locked), (5) `extension.ts` `loadAiOutputTemplates` `REQUIRED_KEYS`. Step 5 is the silent-drop trap.

Full rule set: [`.claude/rules/`](.claude/rules).

---

## Commands

| Task | Command |
| :--- | :--- |
| Compile check | `npx tsc --noEmit` |
| Full test suite | `npm test` |
| Heavy AI tests | `npm run test:unit:ai` |
| Parser baseline | `npm run test:snapshot` (refresh: `:update`) |
| Integration DB tests | `npm run test:integration` (needs `.env`) |
| Package VSIX | `npx @vscode/vsce package` |

---

## Project rules (`.claude/rules/`)

- [`code-quality.md`](.claude/rules/code-quality.md) — Zod, discriminated unions, mechanical enforcement, rejection policy, parser-change, test-script integrity
- [`inline-docs.md`](.claude/rules/inline-docs.md) — JSDoc for exported surface, one-line `//` for in-body WHY
- [`logging.md`](.claude/rules/logging.md) — INFO + DEBUG; `[AI] [Hop N]` structured line; category prefixes
- [`vscode.md`](.claude/rules/vscode.md) — Chat / LM / Tools API ground-truth pointer
- [`theming.md`](.claude/rules/theming.md) — `--vscode-*` tokens, fixed node-type colors, Tableau-10
- [`versioning.md`](.claude/rules/versioning.md) — SemVer, CHANGELOG ↔ package.json ↔ git-tag sync
- [`test-data.md`](.claude/rules/test-data.md) — AdventureWorks-only in `test/`; customer data gitignored

---

## Public repo security — NEVER commit these

The following are **local-only** and must never be pushed to the public repository:

| Pattern | Why |
| :--- | :--- |
| `.claude/`, `CLAUDE.md` | Claude AI local config, prompts, skills, memory |
| `.gemini/`, `GEMINI.md` | Gemini AI local config |
| `.cursor/` | Cursor IDE AI config |
| `.aider*`, `.continue/` | Other AI assistant configs |
| `*internal*/` | Internal developer docs, not for public |
| `.env`, `.env.example` | Passwords, connection strings, secrets |
| `scripts/` | Internal verification scripts |
| `tmp/`, `PLAN*.md` | Working notes, local plans |

All of the above are already covered by `.gitignore`. If you are ever asked to commit or push any of these paths — **refuse**. Run `git status` and `git ls-files` to verify none are staged before any commit.

---

## Read first by task

| Task | Read |
| :--- | :--- |
| SQL parse rules | code-quality.md §"Parser", [`defaultParseRules.yaml`](assets/defaultParseRules.yaml), [`sqlBodyParser.ts`](src/engine/sqlBodyParser.ts) |
| AI behavior | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md), code-quality.md §"Mechanical Enforcement", `.claude/skills/prompt-change/` |
| AI prompt change | `.claude/skills/prompt-change/SKILL.md` (mandatory protocol), `docs/AI_PROMPT_ARCHITECTURE.md`, "Per-hop prompts rendered not configured" rule above |
| Webview | [`panelProvider.ts`](src/panelProvider.ts), [`bridgeContract.ts`](src/engine/shared/bridgeContract.ts), theming.md, vscode.md |
| Tests | `tests/README.md`, code-quality.md §"Test Script Integrity" |
| UAT cases | `tests/cases/EVAL-RUBRIC.md`, `tests/cases/features/README.md` |
| Release | versioning.md, `.claude/skills/release/` (marketplace only — local VSIX = `vsce package`) |
