# Technical Architecture

## Overview
This document provides a comprehensive technical overview of the Data Lineage Viz extension. It is intended for open-source contributors and developers who want to understand the system's internal mechanics, contracts, and AI integration.

## 1. High-Level Component Architecture
The extension follows a standard VS Code architecture separating the backend host from the frontend UI.

```mermaid
sequenceDiagram
    participant User
    participant Participant as @lineage Participant
    participant SM as NavigationEngine
    participant LM as Language Model
    participant Webview as React Webview (UI)

    Note over User, Webview: Phase 1: Discovery (Class D or Class S routing)
    User->>Participant: question
    Participant->>LM: buildDiscoveryPrompt() + discovery tool set
    alt Class D — single object or graph-wide metadata
        LM->>Participant: search_objects / get_object_detail / search_ddl / ...
        Participant->>User: chat answer (turn ends)
    else Class S — 2+ connected objects + analysis
        LM->>Participant: start_exploration
        Participant->>SM: init(Brief, Origin)
        SM-->>Participant: {ok, scopeSize, scopeSchemas}
        Participant->>User: stream.button(Approve/Decline/Redirect)
        alt Decline or Redirect
            User->>Participant: Click Decline/Redirect
            Participant->>SM: resetExploration()
            Participant->>User: "Paused" or fresh start
        else Approve
            User->>Participant: Click Approve
            Participant->>SM: enterExploring()
        end
    end

    Note over User, Webview: Phase 2: Active Loop (ReAct Pattern)
    loop until Agenda Empty
        Participant->>SM: getHopContext()
        Participant->>LM: submit_findings (+ get_neighbor_columns in SM for neighbor columns)
        LM->>SM: verdict + route

        alt Gate Trigger (HITL)
            SM-->>Participant: action_required
            Participant->>User: stream.button(Approve/Decline)
            User->>Participant: Click Button
        end
    end

    Note over User, Webview: Phase 3: Synthesis
    Participant->>SM: getResult()
    Participant->>LM: present_result
    Participant->>Webview: postMessage(ai-view-activate)
    Webview->>User: Render Result Graph
```

| Component | Runtime | Bundler | Entry | Output |
| --- | --- | --- | --- | --- |
| **Extension Host** | Node.js | esbuild | `src/extension.ts` | `out/extension.js` (CJS) |
| **Webview (UI)** | Browser | Vite | `src/index.tsx` | `dist/assets/index.js` (ESM) |

## 2. AI Architecture Patterns

### 2.1 Hourglass Context Model (Asymmetric Tiering)
To maintain reasoning quality across deep lineage traversals, the system implements an **Asymmetric Memory Tiering** model.  

| Tier | Lifecycle | Delivery | Purpose |
| :--- | :--- | :--- | :--- |
| **Short-Term Memory** | Sliding Window | Every Hop | Maintained via summary injection (last 3 nodes). |
| **Detail Archive** | Unbounded | **Synthesis Only** | High-fidelity analysis per node. |

This model directly mitigates the "Lost in the Middle" phenomenon where LLM performance degrades when relevant information is buried in a long context. By hiding the `Detail Archive` until the final synthesis, we ensure the model's attention remains focused on the immediate topological neighbors.

### 2.2 NavigationEngine: The Grounded Router
The `NavigationEngine` acts as the **Orchestrator** while the LLM acts as the **Worker**. It follows the Orchestrator-Worker pattern where the engine owns the loop termination and topological authority, preventing agentic drift. The hop-loop implements a Reasoning + Acting (ReAct) pattern where the engine provides the "Observation" (DDL + Map) and the AI provides the "Action" (Verdict + Routing).

## 3. Deterministic Safety Guards

### 3.1 Input Hardening (Zod)
All tool boundaries use strict **Zod** schema validation. This ensures that even if a model hallucinates a parameter, the engine rejects it at the entry point with a structured recovery hint.

### 3.2 Topological Integrity
- **`wouldOrphanNotedNode`**: A graph-check guard that prevents the AI from pruning a branch that contains already-analyzed nodes.
- **`RepeatRejectGuard`**: An idempotency counter that aborts sessions if the model repeats the same failing tool call 3 times.

## 4. Data Contracts & IPC Messaging

### Data Ingestion Contracts
The extension imports SQL schemas via two distinct sources, both normalizing into a shared `DatabaseModel` contract (`src/engine/types.ts`):
1. **DACPAC Extraction (`dacpacExtractor.ts`)**: Streams XML from unzipped `.dacpac` files. Extracts columns, DDL, and foreign keys.
2. **DMV Extraction (`dmvExtractor.ts`)**: Connects to live SQL Server instances using a two-phase query load (Catalog Load -> Deep-Dive Load). Schemas are defined in `assets/dmvQueries.yaml`.

Both extractors act as thin adapters, outputting `ExtractedObject[]` and `ExtractedDependency[]`.

### IPC Bridge & Zod Validation
Communication between the Extension Host and Webview is strictly validated to prevent message injection.
- **Contract Safety**: IPC bridge validation, tool inputs, and extension host boundaries must strictly use **Zod** schemas (e.g., `BridgeMessageSchema`) for strong type safety, runtime validation, and security.
- **Typed Results**: All engine operations return a `Result<T, E>` pattern to avoid silent failures. The use of `any` is strictly forbidden in parser and extractor outputs.
- **Key Messages**: `dacpac-model`, `db-model`, `table-stats-request`, `ai-view-activate`.

## 3. SQL Parsing Engine
Stored procedures use a highly optimized, multi-pass regex engine (`src/engine/sqlBodyParser.ts`) to avoid the overhead of heavy AST libraries.

1. **Pre-Processing (The Cleansing Pipeline)**:
   - Removes block comments (TypeScript counter-scan).
   - "Best Regex Trick": Neutralizes strings and line comments in a single leftmost-match pass.
   - Normalizes ANSI comma joins and substitutes CTE aliases.
2. **Extraction Rules**: Metadata-driven rules (`assets/defaultParseRules.yaml`) extract `source`, `target`, `exec`, and `external_ref` edges.
3. **Normalization**: Strips delimiters and prefixes, enforcing a consistent `[schema].[object]` format.

## 4. AI Assistant Architecture (`@lineage`)

The extension integrates with VS Code Copilot Chat using an autonomous **"Map & Router"** architecture. It implements a custom imperative loop to allow for aggressive context cleaning and sliding memory survival during deep graph traces.

### 4.1 The Four Chat Phases (Hourglass Flow + Follow-Up)
1. **Discovery (Wide)**: Identifying user intent and mapping the initial scope. The AI seeds the topological Agenda.
2. **Active Phase (Narrow/Sliding or Wide/Inline)**:
   - **Sliding Memory Mode**: Hop-by-hop traversal. The AI receives the focus node's DDL, a sliding window of recent node summaries, and neighbor metadata.
   - **True Inline Mode**: For small graphs (< 10 nodes), the entire scope is delivered in a single batch for holistic reasoning.
3. **Holistic Synthesis (Wide)**: Once the agenda is empty, the AI evaluates the entire Detail Archive to generate a visually enriched report (`present_result`). The synthesis prompt frames the work as a process — READ the archive → ANSWER the original question in 1–2 sentences → GROUP slots by data-flow role → WRITE `present_result`.
4. **Follow-Up (Completed)**: After the report renders, the session enters the `completed` phase. The engine, archive, and classification persist on the session singleton. Refinement turns (text edits, node prunes, deferred-question adds) run against the existing archive: text changes and prunes re-render via `present_result`; "add node X" goes through `lineage_start_exploration` with a `supplement: { nodeIds }` field that extends the archive in one inline pass without resetting it. A genuinely new trace (new origin / direction) resets the session back to discovery.

### 4.2 State Machine & Memory Management
To support deep lineages within limited token budgets, the system uses **Asymmetric Tiering**:
- **NavigationEngine (`smBase.ts`)**: The core state machine and single source of truth for traversal logic. It implements `IHopStateMachine` and manages the topological map (Visited, Current, Agenda).
- **Short-Term Memory**: Sliding window of recent node summaries (last 3 hops) echoed every hop to maintain local context.
- **Detail Archive**: Full technical analysis per node. Delivered to the AI ONLY in the Synthesis phase to prevent context bloat during the active loop.
- **Session FSM (`sessionPhase.ts`)**: Turn-level state (`idle | awaiting_gate | exploring | synthesis | completed`) modeled as a discriminated union for exhaustive handling. `completed` is the post-synthesis refinement phase.
- **Supplement extension (`NavigationEngine.supplementAgenda`)**: In the `completed` phase, calling `lineage_start_exploration({ supplement: { nodeIds } })` reuses the existing engine: status flips from `complete` back to `awaiting_findings`, inline mode is forced on, new slots merge into the existing `AiMemoryManager`, and the hop loop + synthesis re-emit `present_result` with the enlarged scope. No new engine, no new memory, no scope re-declaration.

### 4.3 Pipelined Model Architecture
To maximize quality and performance, responsibilities are split:
- **Smart Tier (Reasoning)**: Core analysis, node verdicting, and routing logic.
- **Fast Tier (Packaging)**: Repetitive structural tasks like JSON packaging, progress formatting, and `present_result` assembly.
- **UX Transparency**: `surfaceProse = false` during the active phase ensures clean chat output while delivering real-time feedback via the `ChatResponseWriter.progress` channel.

## 5. Testing & Verification Strategy
- **Deterministic Core**: Tests focus on pure logic (`npm run test:unit`). Hook tests live in `tests/unit/hooks/`.
- **Snapshot Baselines**: Parser and graph building algorithms use frozen JSON baselines (`tests/fixtures/`) to prevent regressions.
- **AI Tool Proxy**: AI evaluation runs via a local proxy server inside the extension host to test tool dispatch deterministically.