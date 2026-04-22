# Data Lineage Viz - AI Assistant Mandates

These instructions are foundational mandates for the AI assistant operating in this workspace.

## Architectural Grounding
- **Map & Router Architecture**: The AI interacts with the graph using a deterministic "Grounded Router". Hallucinations are prevented by validating all route requests against actual database metadata before execution (e.g. `src/ai/smBase.ts`).
- **State Machine Modes**: The exploration engine orchestrates autonomous reasoning using a unified state machine. Blackboard mode supports **True Inline Mode** for small graphs (batch analysis, full context) and **Sliding Memory Mode** for large ones. When the **Column Aspect** is active (column tracing), the engine is strictly **Sliding Memory** (hop-by-hop) to ensure precise attribution.
- **Hourglass Context Model**: The prompt architecture follows an "Hourglass" flow: Wide Discovery → Active Phase (Wide/True Inline or Narrow/Sliding Memory) → Wide Synthesis.
- **Memory Model**: Follow the **"Asymmetric Tiering"** memory pattern. Strictly separate the short-term `short_term_memory` (used ONLY in Sliding Memory hops) from the full-fidelity 'Detail Archive' (used EXCLUSIVELY in Synthesis).

## Performance & Latency Optimization
- **Pipelined Model Architecture**: Maintain maximum quality by assigning all core reasoning and node analysis to the "Smart" model. Offload repetitive structural tasks—such as JSON packaging, UI progress formatting, and `present_result` assembly—to a high-speed "Fast" model tier.
- **UX Transparency**: Keep `surfaceProse = false` during the active phase to prevent noisy chat output. Real-time feedback for analysis must be delivered via the `ChatResponseWriter.progress` channel (e.g., "Hop N: Analyzing [Object]..." or "Analyzing full graph...").
- **Batch Submission**: Support and prefer batch submissions (`submit_findings` with finding array) in True Inline mode to reduce turns and latency.
- **Interactive Gates**: Use `stream.button` for all "Human-in-the-loop" decisions (Approve/Decline). Do not rely on natural language classification for deterministic state machine transitions.

## VS Code API Compliance & AI Tooling
- **Model Handle Protocol**: Strictly use the `request.model` handle provided by the Chat API. Do not attempt to re-resolve or switch models via the registry unless the requested model is fundamentally incompatible with tool calling.
- **Tool Mode Constraints**: VS Code API enforces `LanguageModelChatToolMode.Required` ONLY when exactly one tool is provided. For multiple tools (e.g. `submit_findings` + `get_ddl_batch`), always use `LanguageModelChatToolMode.Auto` to prevent runtime crashes.
- **Robust Loop Termination**: Multi-round tool loops must only terminate when BOTH `toolCalls.length === 0` AND `responseText.length === 0`. This ensures conversational model outputs (e.g. Claude Haiku) are properly displayed to the user.
- **Hourglass Context Packaging**: Maintain strict "Sliding Memory" by clearing `messages` and re-injecting only the System Prompt, User Prompt, and the most recent Hop result. This preserves the token budget for the "Smart" model.

## Engineering Standards
- **Tool Registry Pattern**: Avoid "God Functions" in tool registration. Follow the `ToolHandler` pattern by separating VS Code tool registration from implementation logic. Delegate all business logic to a specialized handler class.
- **Zod Validation**: IPC bridge validation, tool inputs, and extension host boundaries must strictly use `zod` for strong type safety, runtime validation, and security.
- **DRY & OOP**: Emphasize explicit composition, reusability, and delegation. The `NavigationEngine` should be the single source of truth for its domain. Do not duplicate logic or introduce anti-patterns.
- **JSDoc Usage**: Provide professional JSDoc for all exports. Focus inline comments on *why* or complex business rules, not the *what*.
- **VS Code Configuration**: Add new settings to `package.json` under `contributes.configuration` and retrieve them using `vscode.workspace.getConfiguration()`.
