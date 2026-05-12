# Developer Guide

Starting point for forking and contributing. The deeper engine concepts live in [`ARCHITECTURE.md`](ARCHITECTURE.md); the YAML knobs in [`AI_PROMPTS.md`](AI_PROMPTS.md) and [`PARSE_RULES.md`](PARSE_RULES.md). Coding standards and PR hygiene live in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Repository layout

| Path | Owns |
|------|------|
| [`src/ai/`](../src/ai/) | `@lineage` chat participant, navigation engine (`smBase.ts`), tool provider, memory manager, prompt builders. |
| [`src/engine/`](../src/engine/) | DACPAC + DMV ingestion, regex SQL parser, profiling engine, connection manager, graph builder. |
| [`src/components/`](../src/components/) | React webview — graph canvas (React Flow), filters, detail panel, AI view card. |
| [`src/engine/shared/bridgeContract.ts`](../src/engine/shared/bridgeContract.ts) | Zod-validated message contract between extension host and webview. |
| [`src/utils/`](../src/utils/) | Logger, sanitizers, theming helpers. |
| [`assets/`](../assets/) | YAML knobs: `defaultParseRules.yaml`, `dmvQueries.yaml`, `aiOutputTemplates.yaml`, plus the demo `.dacpac`. |
| [`tests/`](../tests/) | Unit, integration, and snapshot suites. |

## Build & run

```bash
git clone https://github.com/ChrisDevRepo/vscode_data_lineage.git
cd vscode_data_lineage
npm install
```

Press <kbd>F5</kbd> to launch the Extension Development Host. The webview React bundle and the extension TypeScript are both built by `npm run watch` (started automatically by the launch config).

For a release-style local build:

```bash
npx tsc --noEmit              # type-check only
npm run package               # production webpack bundle
npx @vscode/vsce package      # produce a .vsix
```

## Two ingestion paths, one model

Both paths produce the same `DatabaseModel` consumed by `graphBuilder.ts`.

Two ingestion lanes converge on a single regex parser. The DFD shows ownership (lane = source) and phase ordering within the live-database lane.

```mermaid
flowchart LR
    subgraph DACPAC[DACPAC lane — file-based]
        DP[.dacpac file] -->|dacpacExtractor.ts<br/>unzip| MX[model.xml]
    end
    subgraph LIVE[Live database lane — DMV-based]
        SRV[(SQL Server*)] -->|Phase 1: catalog| CAT[Catalog metadata]
        SRV -->|Phase 2: DDL + columns| DDL[DDL + columns]
        CAT --> MERGE[Merge + normalize]
        DDL --> MERGE
    end
    MX --> PARSE[[Regex parser<br/>sqlBodyParser.ts]]
    MERGE --> PARSE
    PARSE --> DM[DatabaseModel<br/>shared schema]
    DM --> GB[graphBuilder] --> G[Directed graph<br/>graphology]

    style DACPAC stroke:#0288d1,stroke-width:2px
    style LIVE stroke:#ef6c00,stroke-width:2px
```

*`SQL Server` covers SQL Server, Azure SQL, Fabric, and Synapse — same DMVs, same catalog shape. The cylinder is a UML **datastore** marker; the double-bordered parser is a UML **subroutine / composite activity** (its internals are decomposed in `PARSE_RULES.md`).

The parser has no awareness of the source. Same regex pipeline, same edge-direction inference, same YAML rules.

- **DACPAC** — [`src/engine/dacpacExtractor.ts`](../src/engine/dacpacExtractor.ts). Streams `model.xml` from the unzipped `.dacpac`. Test fixtures must be AdventureWorks only.
- **DMV** — [`src/engine/dmvExtractor.ts`](../src/engine/dmvExtractor.ts) + [`src/engine/connectionManager.ts`](../src/engine/connectionManager.ts). Two-phase load defined in [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml). DBA contract: [`DMV_QUERIES.md`](DMV_QUERIES.md).
- **Persistence** — [`src/engine/projectStore.ts`](../src/engine/projectStore.ts). Any change to the `Project` or `FilterProfile` types needs a migration in `migrateProjectStore()`.

## SQL parsing pipeline

A multi-pass cleansing engine drives a metadata-driven extractor.

```mermaid
flowchart LR
    IN[Raw SQL body] --> C1[Pass 0 — strip block comments]
    C1 --> C2[Pass 1 — leftmost regex<br/>brackets / strings / line comments]
    C2 --> C3[Pass 1.5 — ANSI comma-join normalisation]
    C3 --> C4[Pass 1.6 — CTE alias substitution]
    C4 --> RE[Pass 2 — YAML rule extraction]
    RE --> SUP[Metadata suppression<br/>CLR methods, system schemas]
    SUP --> CAP[Normalised captures<br/>object refs + edge direction]
```

`src/engine/sqlBodyParser.ts` is a generic rule-runner — every rule lives in [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml). The full reference is [`PARSE_RULES.md`](PARSE_RULES.md). Metadata suppression centralises CLR-method filtering in `src/engine/sqlMetadata.ts`; bracket-quoted identifiers bypass it (intent signal).

## The bridge — IPC & Zod validation

```mermaid
flowchart LR
    WV[Webview React app] <-->|postMessage<br/>Zod-validated| BC[bridgeContract.ts<br/>schemas]
    BC <--> EXT[Extension host<br/>panelProvider.ts]
```

Every `postMessage` hits the Zod cage in [`src/engine/shared/bridgeContract.ts`](../src/engine/shared/bridgeContract.ts) exactly once in each direction. Inner layers consume parsed types; no re-validation. Routing and handlers live in [`src/panelProvider.ts`](../src/panelProvider.ts).

Logging categories standardised across the codebase: `[AI]`, `[Bridge]`, `[Config]`, `[DB]`, `[Dacpac]`, `[Detail]`, `[Filter]`, `[Parse]`, `[Project]`, `[Stats]`. Helpers in [`src/utils/log.ts`](../src/utils/log.ts) — never call `outputChannel.*` directly. Output-channel lines are normalized to single-line text (including stack traces). AI/tool hallucination rejections should be logged as debug (`[Reject] ...`) to avoid error-level log flooding.

## AI prompt builder hierarchy

`buildStageSystemPrompt` ([`src/ai/participant/lineageParticipant.ts`](../src/ai/participant/lineageParticipant.ts)) composes the system prompt in a fixed order. Adding a builder = inserting at the correct step. Adding a phase = extending step 2.

```
1. buildGeneralSystemPrompt          (always — role, platform, schemas, global invariants)
2. one phase-specific block:
     discover    → buildPhasePrompt('discover')
     active      → buildPhasePrompt('active')
                   + buildSmProtocol(targetColumns?, classification)
                       — buildColumnAspectPrompt is folded in when targetColumns set (CT)
     synthesis   → buildPhasePrompt('synthesis')
     completed   → buildPhasePrompt('completed')
3. resolveStagePrompt                 (always — YAML keys gated by stage + classification + slotCount; `closing` requires slotCount ≥ 5; `discovery_chat` fires only at discover stage)
4. buildMissionBriefBlock             (active + completed — <mission_brief>, <current_task>; synthesis emits no <current_task>)
5. buildMemoryBlock                   (active only — <short_term_memory> + tally)
```

**Active-loop request composition (strict sliding-memory).**
- `discover` / `completed`: normal chat-history replay is allowed.
- `active`: broad `chatContext.history` replay is disabled; each hop request uses current system prompt + current directive, plus at most one minimized trailing tool pair for protocol continuity (`tool_use` / `tool_result` callId pairing).
- `active` canonical de-dup: one owner per field in the request envelope. `<mission_state>` owns `focus_node_id` / hop counters, `<mission_brief>` owns mission intent, replayed tool payload owns current-hop evidence only (`focus_node`, `neighbors`, `sm_status`).
- This prevents prior-hop narrative payloads (`submit_findings.sections[].text`) from being re-sent every hop while keeping synthesis quality (full archive remains in `AiMemoryManager`).

**Synthesis output contract.** The AI submits `present_result` with structured parts: `summary`, `title`, `intro`, `sections[]` (each `{ label, node_ids[], text }` lifted verbatim from a captured slot body), `closing`, `notes[]`, `highlight_groups[]`. The engine, via `orderAndAssemble()` ([`tools.ts`](../src/ai/tools/tools.ts)), assembles those parts into the rendered description shown in `AiDescriptionOverlay`: section numbering (`## N {label}`), object link headers (`### Objects [name](#focus-node:id)`), badge chips on the graph. The AI never writes the assembled blob; there is no AI-input `description` field. This is enforced mechanically — `PresentResultInput` omits the field — and documented across the YAML header, `buildSynthesisPrompt()`, and `STAGE_BY_KEY`.

**Completed follow-up intent split.** In completed phase, treat follow-ups as either (A) refine existing graph or (B) start a new trace. Route A uses `lineage_present_result` (relabel/regroup via `sections[]`; caption updates via `notes[]`; graph edits via `prune_node_ids` / `add_node_ids`). Route B uses `lineage_start_exploration` for new origin/scope semantics; engine routing decides retrace vs fresh discovery.

Low-risk diagnostics added for follow-up routing:
- `fromFollowupDeferredTriggerThisTurn` marks turns expanded from deferred follow-up trigger text.
- completed-phase warning log fires when that trigger flow attempts fresh `start_exploration` with `origin` and no `supplement`.
- exact-string block append guard prevents duplicate snapshot injection into one request.
- prompt metrics now log duplicate block removals and per-tool result payload chars.

| Function | File | Concern |
|----------|------|---------|
| `buildGeneralSystemPrompt` | `prompts.ts` | Role, platform, schemas, phase label, global invariants. |
| `buildPhasePrompt(phase, ctx?)` | `prompts.ts` | Canonical static phase protocol entrypoint (discover/active/synthesis/completed). |
| `buildDiscoveryPrompt` | `prompts.ts` | Search, mission_brief authoring, `start_exploration` rules. |
| `buildActivePhasePrompt()` | `prompts.ts` | Hop-loop discipline, verdict semantics, archive contract; routes mission-relevant neighbors via `route_requests` (pruning specifics are SM-owned). |
| `buildSynthesisPrompt` | `prompts.ts` | Archive lift + assembly + intro/closing anchoring. |
| `buildFollowUpPrompt` | `prompts.ts` | Refinement vs re-exploration routing. |
| `buildSmProtocol(targetColumns?, classification)` | `smPrompts.ts` | Active SM protocol (verdict + sections + badges + routing + pruning); CT adds column protocol. Pruning uses `get_neighbor_columns` for lightweight neighbor inspection before deciding to prune. |
| `buildModeBlock(targetColumns?, classification)` | `smPrompts.ts` | Compatibility wrapper delegating to `buildSmProtocol(...)`. |
| `buildColumnAspectPrompt` | `prompts.ts` | CT protocol block — two-channel contract, role table, terminal source rules. Injected into stable system prompt when CT is active. |
| `buildCtSynthesisBlock(edges)` | `smPrompts.ts` | CT chain summary appended to synthesis reminder. Renders accumulated `ColumnEdge[]` as a directed edge list so `present_result` anchors to the traced path. |
| `buildCurrentTaskBlock(task, columns?)` | `prompts.ts` | `<current_task>` XML block; when `columns` are passed (CT active), appends `<column_trace>` sub-block with the structural lineage sub-question. |
| `resolveStagePrompt` | `templateRenderer.ts` | YAML capture (active) + per-field synthesis keys; classification-gated; `closing` size-gated on slotCount ≥ 5. |
| `orderAndAssemble` | `tools.ts` | Engine-built description blob from AI's title + intro + sections[] + closing — sole assembly path. |
| `interaction rules` | `interaction/rules/*.ts` | Central process-rule evaluators (non-Zod): tool phase policy, start/submit/present guards, gate transition mapping. |
| `buildMissionBriefBlock` | `prompts.ts` | `<mission_brief>` + `<current_task>` XML blocks. |
| `buildMemoryBlock` | `prompts.ts` | `<short_term_memory>` XML block + tally line. |

**Hybrid format rule.** Markdown headers for static structural sections (protocols, numbered rules); XML tags for dynamic per-hop data so the model can locate them precisely (`<mission_brief>`, `<current_task>`, `<short_term_memory>`, `<column_trace>`).

## Testing

High-priority regression net: **parsing, BFS, baseline**. Other tests are narrower guards.

| Tier | Command | Scope |
|------|---------|-------|
| **Unit** | `npm test` | All `tests/unit/*.test.ts` — parser, graph, baseline, NavigationEngine + cascade + bipartite + supplement, boundary guards. |
| **Parsing** | `npm run test:parser` | `parser-edge-cases.test.ts` + `tsql-complex.test.ts` (55 SQL fixtures). |
| **Graph / BFS** | `npm run test:graph` | `graphBuilder.test.ts` + `graphAnalysis.test.ts`. |
| **Baseline** | `npm run test:baseline` | Parser TSV (`aw-baseline.tsv`) + graph-analysis JSON (`graph-baseline-aw.json`) regression. |
| **Snapshot** | `npm run test:snapshot` | Parser baseline only. Refresh: `npm run test:snapshot:update`. |
| **Hooks** | `npm run test:hooks` | React hook tests (jsdom via vitest). |

AI behaviour beyond pure-function surface is verified via UAT baseline captures (`tmp/baseline/`), not unit tests.

`tsc --noEmit` after every structural change; the type system is the first line of defence.

## LM traffic tracer

`src/ai/infra/lmTracer.ts` is a built-in observability tool that captures the full content of every `vscode.lm.sendRequest` call as NDJSON for post-session diagnostic analysis. It is an internal developer backdoor for testing only, controlled by a hardcoded flag in code.

### What it captures

Each event is one JSON line (`_: "TX"`) in `tmp/lm-trace/trace-{iso}.ndjson`:

| Event | When emitted | Key fields |
|---|---|---|
| `SESSION_START` | Once per chat turn | `modelId`, `maxTokens` |
| `REQ` | Before every `vscode.lm.sendRequest` | `phase`, `tools`, `mode`, `messages[]` (full serialized) |
| `TOOL_CALL` | Per tool call part in the response stream | `tool`, `callId`, `input` |
| `TOOL_INVOKE` | Before `vscode.lm.invokeTool` | `tool`, `callId`, `cached` |
| `TOOL_RESULT` | After `vscode.lm.invokeTool` returns | `tool`, `result[]`, `ms`, `errCode?`, `hint?` |
| `ROUND` | After each round drains | `phase`, `ms`, `inTok`, `outTok`, `toolCount` |
| `WIPE` | Before every `envelope.wipeAndSeed` | `trigger`, `msgsBefore` |
| `ANSWER_TEXT` | Once for the final text response | `text`, `chars` |
| `SESSION_END` | After `runHopLoop` returns | `cumInTok`, `cumOutTok`, `peakTok`, `rounds`, `exitKind` |

Token counts (`inTok`, `outTok`) come from `model.countTokens()` — a local estimate; no LLM-side prompt cache instrumentation is available via the VS Code LM API.

### How to enable

Enable tracing only for local test/dev sessions by setting the hardcoded trace flag to `true` before launching the extension host. Run a `@lineage` chat session and trace files will be written to `tmp/lm-trace/` (gitignored). Disable the flag before production packaging.

### Analyzing a trace

Analysis scripts live in [`tests/tools/`](../tests/tools/) (excluded from VSIX via `.vscodeignore`).

**Quick summary:**
```bash
node tests/tools/trace-analyze.js tmp/lm-trace/<file>.ndjson --summary
```

**Full diagnostic (all flags):**
```bash
node tests/tools/trace-analyze.js tmp/lm-trace/<file>.ndjson \
  --summary --phase --patterns --redundancy \
  --rejected --loops --wipes --waste \
  --tools --growth --tool-bloat --detail-metrics --ct
```

**All flags:**

| Flag | Purpose |
|---|---|
| `--summary` | Per-session totals — rounds, tokens, tools, rejections (default) |
| `--phase` | Token spend per phase (discover / active / synthesis / completed) |
| `--patterns` | Prompt block presence per phase; flags cross-phase anomalies |
| `--redundancy` | Duplicate content within and across requests |
| `--rejected` | Tool rejections with error codes and hints |
| `--loops` | Same-input tool calls called consecutively |
| `--wipes` | Context wipe events with triggers and message counts |
| `--waste` | Tokens present at wipe time vs total sent |
| `--tools` | Tool frequency, duration, cache hits, rejection rate |
| `--growth` | Per-round context size + growth % (flags runaway rounds >50%) |
| `--tool-bloat` | Tool result payload sizes — avg/max chars |
| `--detail-metrics` | Badge/caption Zod limit scan, math violations, response length |
| `--ct` | Column tracing session analysis: per-hop flow coverage, CT-specific rejections (`column_flow_required`, `ct_requires_sm`), column propagation edges |
| `--report` | Full round-by-round narrative including prompt excerpts |
| `--sizes` | Per-round message composition: system / history / tool_results / prompt |
| `--timeline` | Chronological event dump |
| `--journal-metrics` | One compact JSON line to stdout — pipe to `>> tmp/lm-journal/journal.jsonl` |

### Performance baseline and journal

Generate calibrated metric targets from the demo dacpac:
```bash
node tests/tools/generate-ideal.js assets/demo.dacpac
# → writes tmp/lm-ideal/ideal-run.md (commit after a representative session)
```

Append session metrics to the journal:
```bash
node tests/tools/trace-analyze.js tmp/lm-trace/<file>.ndjson --journal-metrics >> tmp/lm-journal/journal.jsonl
```

### Output locations

| Path | Contents | Gitignored? |
|---|---|---|
| `tmp/lm-trace/` | Raw NDJSON trace files | Yes — never commit |
| `tmp/lm-journal/` | `journal.jsonl` + `journal.md` | Yes — never commit |
| `tmp/lm-ideal/` | `ideal-run.md` — performance targets | No — commit after baseline run |

### Known limitations

- `SESSION_END.cumInTok` covers only the primary discover-phase invocation. SM phases (active / synthesis / completed) run in subsequent turns; the analysis scripts reconstruct full session totals by summing all ROUND events across all phases.
- Analysis is always post-session — no real-time streaming.
- `dedup=hit` in logs = `toolCallCache` in `lineageParticipant.ts`, not Anthropic prompt caching (VS Code LM API does not expose `cached_tokens`).
- `submit_findings` rejects are now no-op for hop state: a `route_validation_failed` (or other validation reject) requires resubmission and does not persist partial detail/edge/prune mutations from the failed attempt.

## Where to look first

| Changing… | Read these |
|-----------|------------|
| SQL parsing rules | [`PARSE_RULES.md`](PARSE_RULES.md), [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml), [`src/engine/sqlBodyParser.ts`](../src/engine/sqlBodyParser.ts). Run `npm run test:snapshot` before merge. |
| AI behaviour or prompts | [`AI_PROMPTS.md`](AI_PROMPTS.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), [`src/ai/prompting/prompts.ts`](../src/ai/prompting/prompts.ts), [`src/ai/prompting/smPrompts.ts`](../src/ai/prompting/smPrompts.ts), [`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml). |
| Tool surface, phase routing, or process guards | [`src/ai/tools/toolProvider.ts`](../src/ai/tools/toolProvider.ts), [`src/ai/tools/toolPolicy.ts`](../src/ai/tools/toolPolicy.ts), [`src/ai/session/sessionPhase.ts`](../src/ai/session/sessionPhase.ts), [`src/ai/interaction/rules/`](../src/ai/interaction/rules/). |
| Webview (React Flow, filters, themes) | [`src/panelProvider.ts`](../src/panelProvider.ts), [`src/engine/shared/bridgeContract.ts`](../src/engine/shared/bridgeContract.ts), [`src/components/`](../src/components/). |
| DMV ingestion / DBA contract | [`DMV_QUERIES.md`](DMV_QUERIES.md), [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml), [`src/engine/dmvExtractor.ts`](../src/engine/dmvExtractor.ts). |
| Profiling SQL | [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md), [`src/engine/profilingEngine.ts`](../src/engine/profilingEngine.ts). |

