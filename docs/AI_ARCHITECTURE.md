# AI Assistant Architecture — "Grounded Router"

## Overview
This guide is for Super Power Users who want to understand the conceptual framework behind the `@lineage` participant. The `@lineage` AI participant bridges deterministic graph traversal with semantic reasoning. It implements an autonomous **"Map & Router"** architecture where the extension host manages the topological state and the AI performs the semantic analysis.

## Key Concepts
- **The Map (Deterministic)**: Managed by the extension host (`NavigationEngine`). It tracks `Visited Nodes`, the `Active Agenda`, and provides **Metadata (Column Lists)** for all neighbors.
- **The Router (Semantic)**: Managed by the AI. It analyzes the DDL of the current node to answer a specific **Sub-Question**, updates the **Blackboard**, and requests the next **Route** to relevant neighbors.
- **Selection-Inference Validation**: Ensures the AI only requests routes to valid, existing columns and nodes.

## Architecture/Workflow

### Execution Model: Inline vs. State Machine (SM)
The system automatically chooses the delivery strategy based on the complexity of the investigation.

| Mode | Threshold | Context Strategy | Short Memory | Reasoning Capability |
| :--- | :--- | :--- | :--- | :--- |
| **Inline Mode** | Fits budget (< 10 nodes) | **One-Shot**: Full DDL and columns for all nodes are provided simultaneously. | **None**: The AI sees the "full picture" immediately. | **Holistic**: Turn-zero reasoning and logical grouping. |
| **SM Mode** | Exceeds budget | **Local-Neighborhood (GraphRAG)**: Only the focus node's DDL + the detailed analysis of its immediate (1-hop) neighbors are provided per round. | **Incremental Blackboard**: A single, dense narrative synthesis. | **Segmented**: High-fidelity local edge reasoning, requires a final Phase 3 for holistic reasoning. |

### Memory Tiering (SM Mode)
To solve the token explosion problem inherent in large graphs while preserving the high-fidelity reasoning required for data lineage, the SM Mode utilizes a **Two-Tier Memory Model**:
1. **Short Memory (Blackboard)**: A length-capped, incrementally updated global narrative of the business logic.
2. **Detail Memory (Local Context)**: The AI's full technical analysis (SQL transforms, math formulas) for every node. Instead of loading the entire history, the engine uses **Local Neighborhood Retrieval** to inject only the detail slots of nodes directly connected to the current focus node.
   - **Hub Protection**: To prevent context overflow when analyzing "hub" nodes (e.g., a central dimension table joined to 50 facts), local detail retrieval is capped at 5 neighbors per hop.

### Exploration Modes (`SmMode`)
The same `NavigationEngine` serves three personas, selected by the mode of the active session:
- **`blackboard`** — Business Logic Analyst (Functional Focus). The default for "explain / summarize" style questions.
- **`column_trace`** — Data Lineage Analyst (Column Focus). Activated when the user asks about specific column flow.
- **`dependency`** — Structural Analyst (Dependency Focus). Structural topology questions ("what depends on X"). Uses the same hop workflow and memory tiering as `blackboard`; only the role framing of the system prompt differs.

### View Refinement: Prune
`enrich_view` supports pruning nodes from the delivered result graph. Pruning **removes the listed nodes and every edge that touches them** — it does not reconnect edges across pruned nodes. Passthrough-style reconnection was deliberately removed because, for a shared hub `P` in `A→P→B, C→P→D`, it fabricated phantom edges (`A→D`, `C→B`) between otherwise-unrelated lineage siblings.

### The Three Lifecycle Phases
1. **Discovery (Initiation)**: The AI maps the starting point and scope. The engine seeds the initial Agenda.
2. **Analysis (The Hop Loop)**: The AI navigates the graph hop-by-hop. In each round, the AI receives The Blackboard, The Map, and The Metadata.
3. **Holistic Synthesis & Presentation**: Once the agenda is empty, the AI uses the **Archive (Detail Memory)** to build the final document and generate visual sections/badges.

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
A single `NavigationEngine` handles all modes (Blackboard, Column Trace, Dependency).
- **Metadata Guard**: The engine provides column lists for neighbors *before* the AI visits them.
- **Fail Early**: Hallucinated questions or non-existent columns are rejected immediately.
- **Grounded Routing**: Every hop is driven by a specific AI-generated sub-question attached to the node on the agenda.

### Singleton Session Model
One `AiSession` per extension instance.
- **User-facing safety**: Explicit user acknowledgement is required before a new exploration wipes an active one.
- **Auto-reset**: Sessions auto-reset after 1 hour of inactivity.

## References
- [Graph BFS Standard References](https://en.wikipedia.org/wiki/Breadth-first_search)
- Internal developer documentation: `docs-internal/AI_IMPLEMENTATION.md`
