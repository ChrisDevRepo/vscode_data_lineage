# Technical Architecture

## Overview
This document provides a comprehensive technical overview of the Data Lineage Viz extension. It is intended for open-source contributors and developers who want to understand the system's internal mechanics, contracts, and AI integration.

## 1. High-Level Component Architecture
The extension follows a standard VS Code architecture separating the backend host from the frontend UI.

| Component | Runtime | Bundler | Entry | Output |
| --- | --- | --- | --- | --- |
| **Extension Host** | Node.js | esbuild | `src/extension.ts` | `out/extension.js` (CJS) |
| **Webview (UI)** | Browser | Vite | `src/index.tsx` | `dist/assets/index.js` (ESM) |

- **`src/engine/`**: Core logic (DACPAC extraction, database import, SQL parsing, graph building).
- **`src/components/`**: React UI (ReactFlow canvas, toolbar, filters, modals).
- **`src/ai/`**: The Copilot Chat participant, tools, state machine, and memory managers.

## 2. Data Contracts & IPC Messaging

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

### 4.1 The Three Chat Phases (Hourglass Flow)
1. **Discovery (Wide)**: Identifying user intent and mapping the initial scope. The AI seeds the topological Agenda.
2. **Active Phase (Narrow/Sliding or Wide/Inline)**:
   - **Sliding Memory Mode**: Hop-by-hop traversal. The AI receives the focus node's DDL, a sliding window of recent node summaries, and neighbor metadata.
   - **True Inline Mode**: For small graphs (< 10 nodes), the entire scope is delivered in a single batch for holistic reasoning.
3. **Holistic Synthesis (Wide)**: Once the agenda is empty, the AI evaluates the entire Detail Archive to generate a visually enriched report (`present_result`).

### 4.2 State Machine & Memory Management
To support deep lineages within limited token budgets, the system uses **Asymmetric Tiering**:
- **NavigationEngine (`smBase.ts`)**: The core state machine and single source of truth for traversal logic. It implements `IHopStateMachine` and manages the topological map (Visited, Current, Agenda).
- **Short-Term Memory**: Sliding window of recent node summaries (last 3 hops) echoed every hop to maintain local context.
- **Detail Archive**: Full technical analysis per node. Delivered to the AI ONLY in the Synthesis phase to prevent context bloat during the active loop.
- **Session FSM (`sessionPhase.ts`)**: Turn-level state (`idle | awaiting_gate | exploring | synthesis`) modeled as a discriminated union for exhaustive handling.

### 4.3 Pipelined Model Architecture
To maximize quality and performance, responsibilities are split:
- **Smart Tier (Reasoning)**: Core analysis, node verdicting, and routing logic.
- **Fast Tier (Packaging)**: Repetitive structural tasks like JSON packaging, progress formatting, and `present_result` assembly.
- **UX Transparency**: `surfaceProse = false` during the active phase ensures clean chat output while delivering real-time feedback via the `ChatResponseWriter.progress` channel.

## 5. Testing & Verification Strategy
- **Deterministic Core**: Tests focus on pure logic (`npm run test:unit`). Hook tests live in `tests/unit/hooks/`.
- **Snapshot Baselines**: Parser and graph building algorithms use frozen JSON baselines (`tests/fixtures/`) to prevent regressions.
- **AI Tool Proxy**: AI evaluation runs via a local proxy server inside the extension host to test tool dispatch deterministically.