/**
 * AI Memory Manager — per-hop working memory for the navigation engine.
 *
 * @remarks
 * Stores high-fidelity per-node analysis (`DetailSlot`). On every hop the manager
 * emits a {@link WorkingMemory} snapshot containing the user's original question,
 * one-line summaries of every prior finding, pending self-ask questions, and
 * progress metrics. Emission is state-machine-driven — delivery never filters,
 * ranks, or truncates content. All relevance decisions are the model's.
 */

import type { LineageNode } from '../engine/types';


/**
 * High-fidelity analysis for a single visited node.
 *
 * @remarks
 * Populated during the hop loop by `AiMemoryManager.storeDetail`. Remains at full
 * fidelity for the entire session and is exposed in `getResult()` so the synthesis
 * step can render every archived slot verbatim.
 */
export interface DetailSlot {
  /** Node identifier. */
  nodeId: string;
  /** Schema of the database object. */
  schema: string;
  /** Object name. */
  name: string;
  /** Object type (e.g. 'table', 'view', 'procedure'). */
  type: string;
  /** Full technical analysis written by the model. */
  analysis: string;
  /** One-line digest shared across hops via `all_summaries`. */
  summary: string;
  /** Optional short role tag used for graph badges. */
  badge_label?: string;
  /** Optional caption shown under the node in the graph. */
  note_caption?: string;
}


/**
 * Snapshot of the memory state delivered to the model at every navigation hop.
 *
 * @remarks
 * Shape matches the 0.9.8 contract: the user question is echoed verbatim and every
 * prior finding is exposed through `all_summaries`. The model receives the whole
 * investigation context each hop; no per-hop filtering.
 */
export interface WorkingMemory {
  /** The user's original question, echoed verbatim every hop. */
  user_question: string;
  /** One-line summary of every previously analyzed node (ordered by visit). */
  all_summaries: Array<{ nodeId: string; summary: string }>;
  /** Self-ask questions posted for neighbors the model has not yet visited. */
  pending_questions: Array<{ nodeId: string; question: string }>;
  /** Progress metrics for this session. */
  checklist: {
    /** Current hop index (1-based). */
    current_hop: number;
    /** Number of nodes with a stored `DetailSlot`. */
    noted: number;
    /** Total number of nodes in the exploration scope. */
    total: number;
    /** Nodes still awaiting analysis (= `total - noted`). */
    open: number;
    /** Coverage percentage across `total`. */
    coveragePct: number;
  };
}


/**
 * In-session store for the per-hop working memory and full detail archive.
 *
 * @remarks
 * Behavior mirrors the 0.9.8 design: storage + delivery + execution only — no
 * ranking, no truncation, no content decisions. The model reads the snapshot and
 * decides relevance on its own.
 */
export class AiMemoryManager {
  private detailSlots = new Map<string, DetailSlot>();
  private pendingQuestions: Array<{ nodeId: string; question: string }> = [];
  private userQuestion = '';

  /** Clears every field so the manager can be reused across sessions. */
  public reset(): void {
    this.detailSlots.clear();
    this.pendingQuestions = [];
    this.userQuestion = '';
  }

  /**
   * Records the user's original question so it can be echoed in every working-memory snapshot.
   *
   * @param q - The user's question, verbatim.
   */
  public setUserQuestion(q: string): void {
    this.userQuestion = q;
  }

  /**
   * Stores the technical findings for a single node in the detail archive.
   *
   * @param node - The node the findings describe.
   * @param analysis - Full technical analysis written by the model.
   * @param summary - One-line digest used in `all_summaries`.
   * @param meta - Optional UI metadata — `badge_label` and `note_caption`.
   * @param inlineMode - When `true`, discards the bulk text and keeps only visual metadata.
   */
  public storeDetail(
    node: LineageNode,
    analysis: string,
    summary: string,
    meta?: { badge_label?: string; note_caption?: string },
    inlineMode = false,
  ): void {
    this.detailSlots.set(node.id, {
      nodeId: node.id,
      schema: node.schema,
      name: node.name,
      type: node.type,
      analysis: inlineMode ? '' : analysis,
      summary: inlineMode ? '' : summary,
      badge_label: meta?.badge_label,
      note_caption: meta?.note_caption,
    });
  }

  /**
   * Produces the working-memory snapshot delivered to the model this hop.
   *
   * @param hopCount - Hop index (1-based) supplied by the engine.
   * @param scopeSize - Total number of nodes in the exploration scope.
   * @returns A `WorkingMemory` snapshot with `user_question`, `all_summaries` for every stored slot, pending self-asks, and progress metrics.
   */
  public getWorkingMemory(hopCount: number, scopeSize: number): WorkingMemory {
    const noted = this.detailSlots.size;
    const coveragePct = scopeSize > 0 ? Math.round((noted / scopeSize) * 100) : 0;
    const all_summaries = Array.from(this.detailSlots.values()).map(s => ({
      nodeId: s.nodeId,
      summary: s.summary,
    }));

    return {
      user_question: this.userQuestion,
      all_summaries,
      pending_questions: this.pendingQuestions,
      checklist: {
        current_hop: hopCount,
        noted,
        total: scopeSize,
        open: Math.max(0, scopeSize - noted),
        coveragePct,
      },
    };
  }

  /**
   * Returns the full detail archive for the synthesis phase.
   *
   * @returns An object containing every stored `DetailSlot` in insertion order.
   */
  public getResult(): { detail_slots: DetailSlot[] } {
    return { detail_slots: Array.from(this.detailSlots.values()) };
  }

  /** JSON snapshot of the manager's current state — used by telemetry and eval extraction. */
  public toJSON() {
    const slots: Record<string, DetailSlot> = {};
    for (const [id, slot] of this.detailSlots) slots[id] = slot;
    return {
      userQuestion: this.userQuestion,
      detailSlots: slots,
      slotCount: this.detailSlots.size,
      pendingQuestions: this.pendingQuestions,
    };
  }

  /** Count of nodes currently stored in the detail archive. */
  public get slotCount(): number {
    return this.detailSlots.size;
  }

  /** Node IDs of every stored detail slot. */
  public get notedNodeIds(): string[] {
    return Array.from(this.detailSlots.keys());
  }
}
