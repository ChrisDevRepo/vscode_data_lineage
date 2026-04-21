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

The extension integrates with VS Code Copilot Chat (`https://code.visualstudio.com/api/extension-guides/ai/chat`) using an autonomous **"Map & Router"** architecture. It implements a custom imperative loop instead of using `@vscode/prompt-tsx` to allow for aggressive context cleaning and sliding memory survival during deep graph traces.

### 4.1 The Three Chat Phases
1. **Discovery**: The user invokes the participant. The AI maps the starting point, intents, and scope, seeding the initial topological Agenda.
2. **Analysis (The Hop Loop)**: Active traversal. The AI navigates the graph hop-by-hop. In each round it receives the focus node's DDL, the Map, neighbor Metadata, and `working_memory.short_term_memory` (sliding window of recent findings), then executes tools (via `vscode.lm.invokeTool`).
3. **Holistic Synthesis**: Once the agenda is empty, the AI evaluates the entire Detail Memory to deduce final business logic and generate a visually enriched report (`present_result`).

### 4.2 State Machine & Memory Management
To support deep 30-hop lineages within limited token budgets, the system uses a **two-tier memory model**:
- **NavigationEngine (`smBase.ts`)**: Consolidates all traversal modes (Blackboard, Column Trace). Following our foundational **DRY and OOP mandates**, it serves as the single source of truth for its domain. Developers must use explicit composition and delegation, avoiding redundant logic or anti-patterns that bypass its structural design. It guards routing by strictly validating requested node/column routes against the actual schema metadata.
- **Short Memory (`short_term_memory`)**: After each hop, the AI's one-line summary is appended to `working_memory.short_term_memory: Array<{nodeId, summary}>` and echoed every subsequent hop. Implements incremental loading (sliding window) to prevent context bloat.
- **Detail Memory (Evidence Archive)**: Full technical analysis per node, stored in `AiMemoryManager.detailSlots`. **Not shipped per hop** — delivered to the AI only in Phase 3 (Synthesis) via `getResult()`. This is the architectural reason synthesis can hit a context ceiling on very large graphs (see `CLAUDE.md` § "Known pain points").
- **Session FSM (`sessionPhase.ts`)**: Turn-level state (`idle | awaiting_gate | exploring | synthesis`) modeled as a TypeScript discriminated union with exhaustive `switch` dispatch. Hop-loop exits are themselves typed (`HopLoopExit`), so each outcome (complete / gate / budget-cap / abort / error) owns its cleanup branch — no post-hoc guards. Canonical example of the "state management" rule in `.claude/rules/code-quality.md`.

## 5. Testing & Verification Strategy
- **Deterministic Core**: Tests focus on pure logic (`npm run test:unit`). Hook tests live in `tests/unit/hooks/`.
- **Snapshot Baselines**: Parser and graph building algorithms use frozen JSON baselines (`tests/fixtures/`) to prevent regressions.
- **AI Tool Proxy**: AI evaluation runs via a local proxy server inside the extension host to test tool dispatch deterministically.