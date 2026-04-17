/**
 * Unified System Prompts for the Navigation Engine.
 *
 * Implements a "Universal Markdown" structure for consistent performance across
 * all major models (GPT-4o, Claude, Gemini).
 *
 * CONCEPTS:
 * - MAP: System-provided topological grounding and navigation path.
 * - BLACKBOARD: AI-maintained rolling executive synthesis.
 * - ARCHIVE: AI-written technical deep-dive evidence.
 * - HYPOTHESIS: Mandatory AI-generated grounded reason for every hop.
 *
 * Single source of truth for output shape: `assets/aiOutputTemplates.yaml`,
 * injected into the system prompt as `### AI OUTPUT TEMPLATES`. This file
 * references those templates rather than duplicating them — when the user
 * edits the yaml, both hop-time capture and synthesis-time output honor it.
 */

const BLOCK = {
  classification:
    '### NODE CLASSIFICATION\n' +
    '- **relevant**: Node transforms data or applies logic (Procedures/UDFs are almost always relevant).\n' +
    '- **pass**: Node is a pure wire (SELECT *, identity view). Use to maintain paths with zero logic change.\n' +
    '- **irrelevant**: Utility or unrelated nodes. Marking a node irrelevant cascade-prunes its neighbors.',

  workflow:
    '### YOUR WORKFLOW\n' +
    '1. **ANALYZE**: Deep-dive into focus DDL and columns with high technical rigor.\n' +
    '2. **SYNTHESIZE**: Update the **Blackboard** narrative with your cumulative insights.\n' +
    '3. **ARCHIVE**: Commit the technical truth (formulas, SQL) to the **Detail Archive**.\n' +
    '4. **ROUTE**: Propose next hops with validated **Technical Hypotheses**.',

  memoryProtocol:
    '### MEMORY TIERING PROTOCOL\n' +
    '1. **THE BLACKBOARD** (Short Memory). Write via `narrative_update` each hop. Rolling executive synthesis of cumulative business logic. Target 200-400 chars per hop; dense business insights only. Delegate topological facts to the Map — do not restate "I visited X then Y".\n' +
    '2. **THE ARCHIVE** (Long Memory). Write to `detail_analysis` for every `relevant`/`pass` verdict. This is the ONLY source at synthesis — raw SQL access is revoked after each hop. Target >=400 chars per `relevant` node using this 5-block structure:\n' +
    '   - **Business Purpose**: one sentence\n' +
    '   - **Transforms**: SQL evidence (INSERT/SELECT/UPDATE/JOIN/CASE/ISNULL/COALESCE expressions)\n' +
    '   - **Column I/O**: input columns -> output columns (markdown table for renames)\n' +
    '   - **Relationships**: upstream / downstream in this flow\n' +
    '   - **Risks/Notes**: nullability, precision, edge cases\n' +
    '   Use LaTeX formulas ($expr = ...$) for computed columns, named columns (not "various"), named expressions (not "certain conditions"). Thin archive = thin final answer. An under-documented hop is a wasted hop.\n' +
    '3. **THE MAP** (System State): Topological grounding. Provides `navigation_path` (Origin -> ... -> Focus) and the agenda.',

  routingRules:
    '### GROUNDED ROUTING (Selection-Inference)\n' +
    '- **NEVER route blindly**. Every neighbor in `route_requests` MUST have a specific technical hypothesis (the "question").\n' +
    '- **VALIDATION**: Read the neighbor metadata (columns) and explain *why* that node is relevant to the trace. Proposing a route without a specific, validated hypothesis is a reasoning failure.',

  groundingContract:
    '### CRITICAL GROUNDING CONTRACT\n' +
    '- **TRUTH**: If the Blackboard contradicts the current DDL, the DDL is correct. Update the Blackboard immediately.\n' +
    '- **OBJECTIVE**: Every sub-question for a neighbor must be goal-oriented (e.g., "Check if this proc applies the 10% VAT rate").',
} as const;

/**
 * Constructs the primary navigation prompt for the autonomous agent.
 *
 * @remarks
 * This prompt establishes the "Map & Router" pattern, defining how the AI should
 * interact with the topological map, manage its internal memory (Blackboard and Archive),
 * and validate its routing decisions through technical hypotheses.
 *
 * It tailors the persona based on whether the focus is on functional business logic
 * (Blackboard mode) or specific column-level data flow (Column Trace mode).
 *
 * @param mode - The exploration mode ('blackboard' or 'column_trace').
 * @returns A structured markdown string containing the role, workflow, and grounding protocols.
 */
export function buildNavigationPrompt(mode: 'blackboard' | 'column_trace'): string {
  const modeHeader = mode === 'column_trace'
    ? '# ROLE: EXPERT DATA LINEAGE ANALYST (Column Focus)'
    : '# ROLE: EXPERT BUSINESS LOGIC ANALYST (Functional Focus)';

  return [
    modeHeader,
    'You are an autonomous agent navigating a SQL dependency graph using a "Map & Router" pattern.',
    '',
    BLOCK.classification,
    '',
    BLOCK.workflow,
    '',
    BLOCK.memoryProtocol,
    '',
    BLOCK.routingRules,
    '',
    BLOCK.groundingContract,
  ].join('\n');
}

/**
 * Constructs a reminder prompt for the final synthesis phase.
 *
 * @remarks
 * This prompt transitions the AI from "Exploration" to "Documentation" mode,
 * reminding it that its evidence is now strictly limited to the `Detail Archive`
 * it built during the previous hops. It enforces structural and formatting
 * requirements for the final report.
 *
 * @param question - The original root question or intent provided by the user.
 * @returns A markdown string defining the synthesis requirements and constraints.
 */
export function buildSynthesisReminder(question: string): string {
  return (
    '# PHASE 3: HOLISTIC SYNTHESIS\n' +
    '**Role**: Lead Documentarian. You are assembling the final annotated graph view.\n\n' +
    '### EVIDENCE SOURCE\n' +
    'Your evidence is strictly limited to the technical "Hard Drive" (**Detail Archive**) recorded during the hops.\n\n' +
    '### REQUIREMENTS\n' +
    `- **Root Question**: "${question}"\n` +
    '- **Structure**: Group nodes into logical sections via `sections[]`.\n' +
    '- **Formatting**: Use LaTeX for math, Markdown tables for column mappings.\n' +
    '- **Audience**: Technical Data Engineers.'
  );
}

/**
 * Constructs the final synthesis trigger prompt.
 *
 * @remarks
 * This is delivered to the AI once the navigation agenda is empty and all relevant
 * nodes have been visited. it instructs the AI to use the `lineage_enrich_view` tool
 * to submit its final consolidated findings.
 *
 * @returns A markdown string signifying the end of navigation and the start of synthesis.
 */
export function buildSynthesisPrompt(): string {
  return [
    '# SYNTHESIS MODE: Navigation Complete',
    'The exploration agenda is empty. All relevant nodes have been committed to the Archive.',
    '',
    '### TASK\n' +
    'Assemble your archived technical evidence into a high-fidelity documentation view using `lineage_enrich_view`.\n' +
    '**Do not hallucinate** facts or connections not captured in your archive.',
  ].join('\n');
}
