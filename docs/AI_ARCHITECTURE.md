# AI Assistant Architecture — "Grounded Router"

## Overview
This guide is for Super Power Users who want to understand the conceptual framework behind the `@lineage` participant. The `@lineage` AI participant bridges deterministic graph traversal with semantic reasoning. It implements an autonomous **"Map & Router"** architecture where the extension host manages the topological state and the AI performs the semantic analysis.

## Key Concepts
- **The Map (Deterministic)**: Managed by the extension host (`NavigationEngine`). It tracks `Visited Nodes`, the `Active Agenda`, and provides **Metadata (Column Lists)** for all neighbors.
- **The Router (Semantic)**: Managed by the AI. It analyzes the DDL of the current node to answer a specific **Sub-Question**, updates the **Blackboard**, and requests the next **Route** to relevant neighbors.
- **Selection-Inference Validation**: Ensures the AI only requests routes to valid, existing columns and nodes.

## Engineering Standards
As foundational mandates for the AI Assistant:
- **Zod Validation**: IPC bridge validation, tool inputs, and extension host boundaries must strictly use `zod` for strong type safety, runtime validation, and security.
- **DRY & OOP**: Emphasize explicit composition, reusability, and delegation. The `NavigationEngine` and similar core orchestration systems must serve as the single source of truth for their domains without redundant logic. Do not duplicate logic or introduce anti-patterns to bypass structural designs.

## Architecture/Workflow

### Execution Model: Inline vs. State Machine (SM)
The system automatically chooses the delivery strategy based on the complexity of the investigation.

| Mode | Threshold | Context Strategy | Per-Hop Memory | Reasoning Capability |
| :--- | :--- | :--- | :--- | :--- |
| **Inline Mode** | Fits budget (< 10 nodes) | **One-Shot**: Full DDL and columns for all nodes are provided simultaneously. | **None** — the AI sees the full picture immediately. | **Holistic**: Turn-zero reasoning and logical grouping. |
| **SM Mode** | Exceeds budget | **Focus + auto-delivered summaries**: the current node's DDL plus every prior hop's one-line summary. | **`all_summaries`** — cumulative, unbounded, system-managed. | **Per-hop** local edge reasoning, converges in a final synthesis phase. |

### Memory Model (SM Mode)
SM mode preserves the 0.9.8 design: **storage + delivery + execution** only — no filtering, no ranking, no content decisions. Two stores back every session:

1. **Detail Archive** (`AiMemoryManager.detailSlots`) — full technical analysis per node, written in `submit_findings.detail_analysis`. Never compressed. Exposed at synthesis via `AiMemoryManager.getResult()`.
2. **Per-hop Working Memory** (`AiMemoryManager.getWorkingMemory`) — the `WorkingMemory` snapshot delivered at every hop:
   - `user_question` — echoed verbatim so the root question survives sliding-history eviction.
   - `all_summaries: Array<{ nodeId, summary }>` — every prior hop's `submit_findings.summary`, in visit order, **unbounded**. No token budget, no path/neighbor prioritization. The model decides which summaries matter for the current hop.
   - `pending_questions` — self-ask entries the model posted via `route_requests` but has not yet visited.
   - `checklist` — `{ current_hop, noted, total, open, coveragePct }` for drain signaling.

No AI-managed narrative string. No `blackboard`. No `local_detail_context` slice. The model reads the snapshot and the focus node's DDL; it writes a fresh analysis + one-line summary; the engine appends the summary to `all_summaries` for the next hop.

**Grounding**: simple per-hop delivery matches the original 0.9.8 behavior and the project's SM-never-truncates principle. Earlier iterations attempted MemGPT-style cumulative narratives and token-budget working sets; both were abandoned because the AI frequently compressed, paraphrased, or lost information when asked to manage memory, and because filtering violated the stored design principle.

### Exploration Modes (`SmMode`)
The same `NavigationEngine` serves two personas, selected by the mode of the active session:
- **`blackboard`** — Business Logic Analyst / Default. Used for "explain / summarize / what depends on X" style questions. Carries cross-hop reasoning via `working_memory.all_summaries`.
- **`column_trace`** — Data Lineage Analyst (Column Focus). Activated when the user asks about specific column flow; adds column-name validation on `route_requests`.

### Completion Contract (when SM says "done")
Completion semantics depend on the execution mode:

| Mode | Trigger | AI action |
| :--- | :--- | :--- |
| **Inline mode** (scope ≤ `inlineNodeCap` AND ≤ `inlineTokenBudget`) | AI sets `complete: true` on `submit_findings`. No coverage gate — the AI has the full picture one-shot and decides when the question is answered. | On acceptance, the tool returns `{ ok: true, done: true, result }` and the AI produces the chat answer + `enrich_view`. |
| **SM sliding-memory mode** (scope exceeds either threshold) | **AI does not decide.** The engine drains the agenda: every item must receive one of the three verdicts — `relevant`, `pass`, `irrelevant`. When the last verdict is dispatched, the engine emits the synthesis trigger and the AI produces the chat answer + `enrich_view`. `complete: true` is **rejected** with `{error:'complete_not_allowed'}` so the AI cannot self-finalize. | Synthesis trigger delivered as a distinct user message; the continuation-phase nav prompt contains no mention of completion. |
| **MAX_ROUNDS cap** (safety cut-off at `ai.maxRounds`, default 50) | The loop exits without the SM reaching `complete`. The session persists a **partial resultGraph** (flagged `partial: true`, `partialCoverage: {analyzed, total}`) from all nodes analyzed so far. | `enrich_view` / "Show in Graph" still renders the partial result; the UI surfaces a "cap hit" notice. |

Three verdicts (SM mode):
- `relevant` — full 5-block analysis stored; drives badges/notes.
- `pass` — visited, no analysis stored, always accepted. Intended for variant siblings of an already-analyzed archetype (reference the archetype in the blackboard).
- `irrelevant` — cascade-prune the node + unreachable downstream. May be rejected by the orphan guard (would disconnect an already-analyzed node); fall back to `pass`.

This replaces the earlier `premature_complete` coverage-floor guard. That guard (removed) refused `complete=true` in SM mode until coverage ≥ 80%, which was unreachable on variant-heavy neighborhoods and created rejection loops. The drain-only contract is always satisfiable (each verdict is a legal move) and the SM — not the AI — decides when the session is over.

### Repeat-Rejection Belt
A session-level idempotency counter (`src/ai/repeatRejectGuard.ts → RepeatRejectGuard`) aborts the exploration cleanly if the model sends the same tool call three consecutive times and it fails every time. Any successful call resets the counter. The abort surfaces a typed envelope (`RepeatRejectAbort` in `src/ai/smErrors.ts`) and a user-visible message in chat. This is a belt against any future guard-interaction loop; it is orthogonal to SM semantics and applies to every tool call, not just `submit_findings`. The existing `dataLineageViz.ai.maxRounds` setting (default 50) remains the absolute round-cap.

### View Refinement: Prune
`enrich_view` supports pruning nodes from the delivered result graph. Pruning **removes the listed nodes and every edge that touches them** — it does not reconnect edges across pruned nodes. Passthrough-style reconnection was deliberately removed because, for a shared hub `P` in `A→P→B, C→P→D`, it fabricated phantom edges (`A→D`, `C→B`) between otherwise-unrelated lineage siblings.

### The Hop Payload
Every hop, `NavigationEngine.getHopContext()` returns a single JSON object delivered to the model as the tool result. It is self-contained — the agent does not need conversation history to reason about the current hop.

| Section | Field | Purpose |
| :--- | :--- | :--- |
| **Engine status** | `sm_status` | `'awaiting_findings'` while the loop is draining — the explicit "you are mid-loop" signal that survives sliding-memory wipes |
| **Index** | `hop` | Integer hop number (1-based) |
| **Drain signal** | `agenda_remaining` | Count of nodes still on the agenda — tells the AI how much work is left this session |
| **Focus DDL** | `focus_node` | `{id, schema, name, type, ddl, columns, fks}` for the current node |
| **Local metadata** | `neighbors[]` | Each entry: `{id, schema, name, type, edge_direction, edge_type, boundary, cols, fks, hasDdl}` — enables grounded routing decisions without fetching |
| **Sub-goal** | `current_task` | The grounded task driving *this* hop (set by `route_requests` from a prior hop, or the root question on hop 1) |
| **User question** | `working_memory.user_question` | The original user question, echoed verbatim every hop |
| **Auto-delivered memory** | `working_memory.all_summaries` | `Array<{nodeId, summary}>` — every prior hop's one-line summary, in visit order, unbounded |
| **Pending** | `working_memory.pending_questions` | Neighbors the AI deferred for later hops |
| **Progress** | `working_memory.checklist` | `{current_hop, noted, total, open, coveragePct}` — `open = total − noted`, the per-hop count of un-analyzed nodes in scope |
| **The Map** | `working_memory.topological_map` | `{navigation_path, visited_nodes, current_focus, agenda}` — the deterministic structural grounding |

The hop payload is designed to survive sliding-memory wipes: `sm_status`, `agenda_remaining`, and `checklist.open` give the AI the situational awareness it needs to keep draining even when the conversation history has been trimmed to the last turn. Omitting these signals — as earlier iterations did — forces the AI to fall back on acknowledge-the-data prose after each hop, which shows up as a "premature final answer" pattern. The fix is data, not more prose rules.

The user's original question reaches the model via three paths every hop: (1) `working_memory.user_question` (echoed verbatim by the engine), (2) the VS Code chat-history messages on every LM call, and (3) `current_task` on hop 1 as `"Root Question: <user text>"`. Sliding-history wipes preserve paths (1) and (3) because they live in tool results, not user messages.

### The Three Lifecycle Phases
1. **Discovery (Initiation)**: The AI maps the starting point and scope. The engine seeds the initial Agenda.
2. **Analysis (The Hop Loop)**: The AI navigates the graph hop-by-hop. Each hop it receives `all_summaries`, the Map, the focus DDL, and neighbor metadata.
3. **Holistic Synthesis & Presentation**: Once the agenda drains, the AI uses the full Detail Archive to write the chat prose + `enrich_view` sections.

### Phase-Boundary Contract for Prompt Authors

- **DISCOVERY → ACTIVE** — triggered by `lineage_start_exploration`. Nav prompt for the chosen mode is injected. `lineage-engine` tool tag replaces `lineage` (so classic tools are hidden). Prompts added in DISCOVERY that mention classic-tool choice are dead weight after this transition — scope them to DISCOVERY only.
- **ACTIVE hop loop** — `submit_findings` is the only active-phase tool (plus `get_object_detail` for ad-hoc look-up). Nav prompt is re-injected on every sliding-memory wipe (`lineageParticipant.ts:494`).
- **ACTIVE → SYNTHESIS** — triggered when the engine drains the agenda. Detail archive is injected as a fresh user message, followed by the synthesis prompt. The synthesis prompt is not preserved through sliding-memory wipes today; if synthesis is reached post-wipe, the rules may be stale (known limitation; re-injection is an active investigation).

### Mechanical Map-&-Router enforcement (2026-04-18)

The ACTIVE phase of the chat loop sets `vscode.LanguageModelChatToolMode.Required` on every `sendRequest`. The AI **cannot** produce free-form text during the hop loop — it must call `submit_findings`. This enforces the Map-&-Router contract ("the engine owns the loop") at the API level rather than relying on prompt discipline.

Consequences:
- **No self-exit for the AI.** `complete: true` is honored only in inline mode (`_inlineMode === true`); in sliding-memory mode it is silently ignored. Termination is owned by the engine — `getHopContext` sets status to `'complete'` when the agenda is empty, which triggers the `active → done` phase transition.
- **Speed control via verdicts, not prose.** If the AI judges a branch unworthy, it emits `verdict: "irrelevant"` for each focus node → cascade-prune drains the agenda quickly → synthesis fires. No silent text bail possible.
- **ACTIVE tool set is narrowed to `submit_findings` only.** `start_exploration` is dropped from the ACTIVE schema (the parallel-call guard in `toolProvider.ts` remains as defense-in-depth). This both satisfies the "some models support only a single tool under Required" caveat in the VS Code API and removes the AI's temptation to re-enter discovery.
- **Prompt surfaces contain no exit vocabulary.** `BLOCK.completionContract` in `smPrompts.ts` describes only the loop (call `submit_findings` with a verdict until the engine drains). No mention of `complete: true`, "final answer", or "enrich_view only after" — those would teach the AI a path it cannot take.

Reference: VS Code API `LanguageModelChatToolMode.Required` at `node_modules/@types/vscode/index.d.ts:20843`.

### Known Failure Modes (observed in production logs)

| Mode | Symptom | Root cause | Mitigation |
|---|---|---|---|
| **Parallel `start_exploration` storm** | After `complete_rejected`, AI emits N parallel `start_exploration` calls (one per unvisited neighbor) instead of continuing `submit_findings`. Wipes the accumulated Detail Archive, forcing synthesis into an empty-evidence state. | `already_started` guard is sequential. Prompt-level "Do NOT call start_exploration" in the `complete_rejected` hint is not reliably binding. Multi-call rounds are unprotected. | Mechanical guard in `toolProvider.ts`: reject calls 2..N of `start_exploration` within one LM round with a structured `{error:'parallel_call_forbidden', hint}` envelope. Prose hints alone do not enforce. |
| **Utility-proc DDL overflow** | One hop returns 50k-char tool result (e.g., `LogMessage` DDL with verbose boilerplate). Next hop's input jumps from ~7k to ~17k tokens. | `aiPresenter.ts` does not cap DDL length for utility/log procedures. | Per-node DDL length cap (~8k chars) with `{truncated: true, hint: 'Call get_ddl_batch if full DDL needed'}` envelope. |
| **Synthesis with empty archive** | Final round receives synthesis prompt but no archive slots (because SM was wiped mid-exploration). Output is truncated (<100 tokens) with no `enrich_view`. | Consequence of the parallel-storm failure mode, or any `start_exploration` re-call during ACTIVE phase. | Detect empty-archive synthesis and emit a user-facing warning + re-run suggestion. |

### State Diagram: AI Navigation Engine

```mermaid
stateDiagram-v2
    [*] --> Discovery
    
    state Discovery {
        [*] --> InitializeMap
        InitializeMap --> SeedAgenda
        SeedAgenda --> [*]
    }
    
    Discovery --> Analysis
    
    state Analysis {
        [*] --> EvaluateAgenda
        EvaluateAgenda --> FetchContext: Pop Agenda Item
        FetchContext --> AI_Reasoning: Provide Map & DDL
        AI_Reasoning --> ValidateSubmission
        ValidateSubmission --> UpdateMemory: Success
        ValidateSubmission --> AI_Reasoning: Failure (Fail Early)
        UpdateMemory --> EvaluateAgenda
        EvaluateAgenda --> [*]: Agenda Empty
    }
    
    Analysis --> Synthesis
    
    state Synthesis {
        [*] --> AggregateFindings
        AggregateFindings --> GenerateReport: Detail Memory Provided
        GenerateReport --> EnrichVisualization
        EnrichVisualization --> [*]
    }
    
    Synthesis --> [*]
```

## Detailed Specs

### The Unified Navigation Engine
A single `NavigationEngine` handles both modes (Blackboard, Column Trace).
- **Metadata Guard**: The engine provides column lists for neighbors *before* the AI visits them.
- **Fail Early**: Hallucinated questions or non-existent columns are rejected immediately.
- **Grounded Routing**: Every hop is driven by a specific AI-generated sub-question attached to the node on the agenda.

### Singleton Session Model
One `AiSession` per extension instance.
- **Cross-session guard (chat-visible, non-modal)**: Each `start_exploration` stamps `engine.sessionId = sess.id`. A new `start_exploration` from a *different* session (`sess.id` rotates on every empty-history chat turn) wipes the prior SM silently and queues a one-line notice on `sess.pendingUserNotice`, which `runWithTools` drains as a `stream.markdown` blockquote after the tool round. No `confirmationMessages` modal, ever — blocking dialogs are forbidden by design.
- **Same-session re-call is a hard error, not a wipe**: `start_exploration` is strictly one-shot per turn. Re-calling it within the same session returns `{ error: 'already_started', hint: '…' }` without touching the live SM, so the AI cannot accidentally wipe in-progress findings (e.g. after a `complete_rejected` verdict — the queued neighbors are served on the next `submit_findings`).
- **Auto-reset**: Sessions auto-reset after 30 minutes of inactivity (`STALE_AFTER_MS`), or immediately when the prior SM has reached `complete`. Stale resets are silent — no notice.
- **Result-graph preservation across new chat**: When VS Code creates an empty-history chat thread and the session has a `resultGraph` less than 5 minutes old, the graph is preserved across the reset so follow-up prompts like *"Show the trace result in the graph"* can still render. Transient state (`stateMachine`, agenda) is always cleared — only the completed / partial result survives the window.

### Column validation scope
`submit_findings.route_requests[].columns` is validated against the target node's columns **only in `column_trace` mode**. In `blackboard` mode the field is silently dropped (it has no semantic meaning there) — the AI cannot trigger a `route_validation_failed` error by copying source-node column names onto a target UDF or proc.

## Scope Budget Enforcement (2026-04-18)

Two complementary guards keep the exploration loop inside the user's declared scope:

1. **Preflight scope-vs-budget gate** — at `start_exploration`, sliding-memory sessions whose initial BFS scope exceeds `ai.maxRounds × 0.7` are rejected with `scope_exceeds_budget`. The AI receives a `safe_depth_hint` (largest depth fitting the budget) and asks the user to narrow the question or raise the setting. Inline sessions are exempt — they complete in a single reasoning round.
2. **Per-hop consent gate** — during ACTIVE, any route that leaves the schema filter or exceeds the mode-specific depth cap returns an `action_required` envelope. The participant pauses the active loop, surfaces the question in chat, and resumes on the user's next NL reply. "Yes" caches the class (schema or depth level) on the session; "no" aborts the exploration and offers synthesis from partial findings.

### Three depth-enforcement cases

| User signal | Engine mode | Cap | Behavior on out-of-cap route |
|-------------|-------------|-----|------------------------------|
| `/depth N` slash command OR clear NL ("direct neighbors", "one level", "immediate") | `strict` | `depth` exactly | `action_required` gate |
| Vague NL ("nearby", "surrounding", "next level") | `soft` | `depth + 1` | `action_required` gate |
| No depth mentioned | `silent` | `depth + 2` | `action_required` gate |

`strict` mode admits zero silent expansion; `soft` and `silent` let the engine expand the scope within their cap and log every expansion to `working_memory.budget_expansions`. Any route past the cap surfaces a gate; the user decides.

### Two-loop control flow

**Loop 1 — exploration** runs from `start_exploration` through agenda drain to synthesis. **Loop 2 — consent gate** is a nested pause on top of Loop 1: the engine halts, the participant asks the user, the user replies in NL, then either Loop 1 resumes or aborts.

```mermaid
flowchart TD
    U[User question] --> D[DISCOVER]
    D -->|start_exploration| PG{Preflight:<br/>scope > budget?}
    PG -- Yes --> ReAsk[Return scope_exceeds_budget<br/>with safe_depth_hint]
    ReAsk --> U
    PG -- No --> A[ACTIVE: hop loop]
    A -->|submit_findings| V{Route validation}
    V -- route valid --> A
    V -- out-of-schema<br/>or out-of-cap --> G[Engine emits<br/>action_required]
    G --> H[Participant halts loop,<br/>renders gate in chat]
    H --> UR{User replies}
    UR -- yes --> Y[Engine caches class<br/>on session allowlist]
    Y --> A
    UR -- no --> N[Abort exploration,<br/>preserve partial archive]
    N --> U
    UR -- synthesize --> S
    A -->|agenda drained| S[SYNTHESIS]
    S -->|enrich_view + chat prose| End[Done]
```

### Consent-gate lifecycle (Loop 2)

```mermaid
sequenceDiagram
    participant AI
    participant Engine
    participant Participant
    participant User

    AI->>Engine: submit_findings({route_requests: [out-of-scope-node]})
    Engine->>Engine: Check schema filter + depth cap
    Engine-->>AI: {error: 'action_required', gate, classes, nodeIds}
    Participant->>Participant: Detect action_required in tool result
    Participant->>User: stream.markdown("Scope expansion requested — Reply yes/no")
    Participant->>Participant: sess.pendingGate = {...}; return from turn
    Note over User: Turn ends. User reads and types reply.
    User->>Participant: "yes" (or "no", or a refined question)
    Participant->>Participant: classifyGateReply(prompt)
    alt yes
        Participant->>Engine: engine.extendAllowedSchemas(class) / extendAllowedDepth(n)
        Participant->>AI: effectivePrompt = "Resume. Route the previously blocked nodes"
        Note right of AI: Loop 1 resumes
    else no
        Participant->>Participant: storeBbResultPartial()
        Participant->>User: "Exploration paused. Refine or 'synthesize'"
        Note right of User: Loop 1 aborted
    end
```

### AI-visible signals

Each hop's `working_memory` carries the diagnostics the AI needs to self-correct:
- `checklist.rounds_used` — monotonic counter (not countdown — countdowns anchor the model toward premature stopping per s1 / Muennighoff et al. 2025)
- `checklist.scope_growth` — cumulative auto-expansions
- `verdict_counts` — running R/P/I tally (flags "many relevants, zero irrelevants" imbalance)
- `recent_rejections` — last 5 blocked routes, so the same invalid ID isn't re-submitted
- `active_schemas` — current session allowlist (grows on each consented schema)
- `depth_cap` — engine-enforced ceiling, always surfaced when a budget is set (removed the old silent-mode gate)

Per-neighbor flags: `in_budget`, `in_approved_scope`, `would_trigger_action_required` — the AI knows before routing whether it will trip the gate (inline mode) or be deferred (SM mode).

### SM closed-loop contract & deferred-questions checkpoint (2026-04-18)

After `confirm_sm_start` is approved, the SM session runs as a closed loop — no mid-session consent gates. The AI's tool surface is a single tool (`lineage_submit_findings`), `LanguageModelChatToolMode.Required` prevents free-form chat, and the engine enforces the border mechanically:

- **Approved border** — `working_memory.approved_border = { schemas, depth_cap }` surfaced every hop. Locked at session start; extensions require a new session.
- **Deferral, not rejection** — when the AI routes to an out-of-border node, the engine calls `deferQuestion({...})` into an internal bucket (single encapsulated mutation point on `NavigationEngine`) and the hop proceeds. In-border routes in the same `route_requests` array are accepted normally.
- **Visibility every hop** — `working_memory.deferred_count` shows the running tally. The structured `[AI] [Hop N]` log line carries `routed=<new>/<rejected>/<deferred>` and `deferred_queued=<N>`.
- **Synthesis surfaces the gap** — the Detail Archive is accompanied by a `DEFERRED QUESTIONS` block listing `(nodeId, schema, question, fromFocusNode, reason)` per entry. The synthesis prompt instructs the AI to render an "Unanswered (out of approved scope)" section at the tail of the report.
- **Post-synthesis checkpoint** — when the session completes with a non-empty deferred list, the participant streams a concluding summary of deferred entries so the user can decide to follow up in a new question. The gate literal `confirm_scope_extension` is reserved in `PendingGateSchema` for future one-click re-spawn flows.

Grounded in: Anthropic *Effective Context Engineering* (compaction over truncation), Reflexion / ReAct (self-reflective deferral in the reasoning trace), MemGPT (hierarchical memory preservation), and HITL-batching (two checkpoints — entry and optional exit — rather than many mid-flight).

### Design citations

- **LangGraph `interrupt_on` / HumanInTheLoopMiddleware** — the consent-gate pattern. Halt on structured signal, resume on user input. [docs.langchain.com/oss/python/langchain/human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)
- **Anthropic, *Building Effective Agents* (Dec 2024)** — fewer, orthogonal tools; include stopping conditions. [anthropic.com/research/building-effective-agents](https://www.anthropic.com/research/building-effective-agents)
- **s1 / Budget Forcing (Muennighoff et al., 2025)** — exposing a budget can cause premature stopping. Use monotonic `used` counters, not `remaining` countdowns. [arxiv.org/abs/2501.19393](https://arxiv.org/abs/2501.19393)
- **$47k Agent Loop (Nov 2025)** — preflight budget checks prevent loops that can't finish. [relayplane.com/blog/agent-runaway-costs-2026](https://relayplane.com/blog/agent-runaway-costs-2026)

## Cascade-prune guards — content-blind by design (2026-04-18)

Three topological guards govern `irrelevant`-verdict pruning. All are content-blind — they operate on graph reachability, never second-guess the AI's verdict.

| Guard | Where | Role |
|---|---|---|
| `wouldOrphanNotedNode` | Pre-prune ([smBase.ts submitFindings](src/ai/smBase.ts)) | Rejects a prune that would disconnect an already-analyzed (noted) node from the origin. Protects work already done. |
| `findBridgeNodes` | Post-exploration ([smBase.ts getResult](src/ai/smBase.ts)) | At result-graph assembly, reinserts pruned nodes that would leave the final graph disconnected. Purely a rendering safety net for the user's visualization. |
| ~~cascade-width > 50%~~ | **Removed 2026-04-18** | Was a numeric heuristic that rejected prunes affecting >half of remaining agenda. Removed: the engine is content-blind, the AI has the only DDL view and already committed a verdict (relevant\|pass\|irrelevant); SM doesn't second-guess that with numbers. If over-pruning shows up in evals, the fix is in the `irrelevant` rubric in [smPrompts.ts BLOCK.verdictCategories](src/ai/smPrompts.ts), not the engine. |

**Principle:** engine guards are topological only. Content judgment lives in the AI + the prompts that frame it.

## Trust + Blinkers model (2026-04-18 iteration 3)

The `@lineage` exploration loop implements the **Orchestrator-Workers** pattern (Anthropic, [*Building Effective Agents*](https://www.anthropic.com/research/building-effective-agents), Dec 2024):

- **Orchestrator** — `NavigationEngine`. Decomposes the user question into hop-sized work items (focus nodes), presents them one at a time via `getHopContext()`, decides termination (agenda drained, gate emitted, or MAX_ROUNDS).
- **Worker** — the AI at each hop. Reads DDL, emits a verdict + optional route requests via `submit_findings`. That's the entire job.
- **Aggregator** — synthesis phase, which lifts the detail archive into the final report.

The worker is bounded by **horse-with-blinkers mechanics**:
- `LanguageModelChatToolMode.Required` in ACTIVE — can't emit free-form text.
- Tool filter narrows the visible toolset to `submit_findings` only — no `enrich_view`, `run_bfs_trace`, etc.
- Engine rejects `complete: true` in SM mode — worker can't self-terminate.

**Consent gates are two-turn pauses** (not a sub-loop): engine emits `action_required` envelope → turn ends → user replies yes/no/redirect → next turn resumes. On yes, the participant does NOT mechanically advance the engine — the engine was already primed at gate-emission time (tool called `getHopContext()` before returning the envelope). AI's next `submit_findings` lands on an already-primed engine. **Trust-on-resume** — no runtime coupling between participant state and engine state beyond what the AI sees in its history.

Design citation: Orchestrator-Workers. Key deviation from autonomous-agent patterns (plain ReAct, AutoGPT): we give up the AI's termination authority in exchange for bounded, auditable completion.

## Session FSM & Typed Exit Dispatch (2026-04-18 iteration 2)

Follow-up to the scope-budget bundle. The mid-exploration consent gate above worked, but the turn handler had four implicit exit reasons (final_answer / gate / budget / error) with only one return path — so post-loop partial-result storage ran after any exit, including a paused gate. Fix: promote session state to a typed discriminated union; make every hop-loop exit typed; dispatch on the kind.

### Phases (`SessionPhase`)

Persists across VS Code chat turns. Turn-entry switches on `phase.kind`.

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> awaiting_gate: start_exploration needs SM\n→ action_required{gate:'confirm_sm_start'}
    idle --> exploring: fresh hop loop enters ACTIVE\n(inline mode or post-confirm)
    exploring --> awaiting_gate: [inline only] submit_findings returns\nschema_out_of_filter /\ndepth_cap_exceeded /\nschema_and_depth
    awaiting_gate --> exploring: user reply: yes\n(apply extendAllowedSchemas /\nextendAllowedDepth — inline only)
    awaiting_gate --> idle: user reply: no\n(paused, no partial stored)
    awaiting_gate --> idle: user reply: redirect\n(resetExploration → new question flows through)
    exploring --> idle: HopLoopExit.final_answer\n(SM complete OR discovery final)
    exploring --> idle: HopLoopExit.hop_cap\n(store partial, "incomplete" notice)
    exploring --> idle: HopLoopExit.aborted\n(repeat-reject guard, store partial)
    exploring --> idle: HopLoopExit.error\n(uncaught exception)
```

### Typed hop-loop exits (`HopLoopExit`)

Single `dispatchExit` switch owns all post-loop cleanup. Each variant's cleanup lives in exactly one place — TypeScript discriminated-union exhaustiveness prevents the "paused gate rendered as incomplete" regression structurally.

| `HopLoopExit.kind` | Triggered by | Cleanup in `dispatchExit` |
|---|---|---|
| `final_answer` | AI produced chat response with no tool calls (SM complete or discovery final) | `sess.enterIdle()` → optional "Show in Graph" button if SM completed |
| `gate` | Tool result carried `action_required` envelope (Zod-validated) | `sess.enterGate(gate)` → stream consent question. **No** partial storage, **no** "incomplete" notice |
| `hop_cap` | `MAX_ROUNDS` reached without completion | `storeBbResultPartial()` if slots exist → `sess.enterIdle()` → "incomplete" notice → "Show Partial Graph" |
| `aborted` | Repeat-reject guard tripped | `storeBbResultPartial()` if slots exist → `sess.enterIdle()` |
| `error` | Uncaught exception | `sess.enterIdle()` → error message |

### Confirm-SM-start gate (reuses the same dispatch)

`lineage_start_exploration` emits `action_required{gate:'confirm_sm_start'}` when sliding-memory mode is needed (non-inline session, scope fits budget). The tool returns the envelope; `HopLoopExit.gate` carries it; `dispatchExit` transitions to `awaiting_gate`; the participant surfaces the scope + depth + budget summary in chat. On `yes` the engine is live and resumes directly (no re-init). On `redirect` the session resets and the new question flows through normal discovery.

### Why buttons are not used for the gate reply

Per [`docs-internal/VS_CODE_CHAT_API.md`](../docs-internal/VS_CODE_CHAT_API.md) §4 + §12: `stream.button` dispatches commands (no back-channel into the running turn); `stream.confirmation` is deliberately unused (no destructive side-effects in this extension); turns are strictly one-shot. Text-reply yes/no/redirect is the only clean path — and `redirect` couldn't be carried by a 2-button surface anyway. The gate protocol stores everything a future command handler would need (`PendingGate.gate` + `.classes`), so adding buttons later is additive.

## References
- [Graph BFS Standard References](https://en.wikipedia.org/wiki/Breadth-first_search)
- Internal developer documentation: `docs-internal/AI_IMPLEMENTATION.md`
