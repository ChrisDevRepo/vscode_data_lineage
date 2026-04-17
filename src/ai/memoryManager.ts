/**
 * AI Memory Manager — Two-tier memory model (MemGPT-inspired).
 * 
 * Separates Short Memory (incremental narrative synthesis) from Detail Memory (full DDL analysis).
 * Used by all exploration modes to ensure strictly bounded token usage and grounded reasoning.
 * 
 * Design:
 * - Detail Memory (Disk): Map of high-fidelity analysis for every node. Visible only in Phase 3.
 * - Short Memory (RAM): A single, incrementally updated narrative string (the Blackboard).
 */

import type { LineageNode } from '../engine/types';

/**
 * Hub Protection cap — max DetailSlot neighbors injected per hop into working memory.
 * Prevents token explosion when the focus node is a central hub (e.g., a dim table
 * joined by many facts). See `docs/AI_ARCHITECTURE.md` → Memory Tiering → Hub Protection.
 */
export const MAX_LOCAL_NEIGHBORS = 5;


/** 
 * Represents a high-fidelity memory slot for a single node's analysis.
 * 
 * @remarks
 * Detail slots are populated during the "Analysis" phase (the hop loop) and are
 * stored at full fidelity. They are only exposed to the AI during the final
 * "Synthesis" phase to ensure grounded reasoning while keeping per-hop context
 * strictly bounded.
 */
export interface DetailSlot {
  /** The unique identifier of the analyzed node. */
  nodeId: string;
  /** Schema name of the database object. */
  schema: string;
  /** Name of the database object. */
  name: string;
  /** Type of the database object (e.g., 'table', 'view'). */
  type: string;
  /** The full technical DDL/Metadata analysis performed by the AI. */
  analysis: string;
  /** A concise, one-line digest of the analysis for quick reference. */
  summary: string;
  /** Optional semantic label used to group or identify the node in the UI. */
  badge_label?: string;
  /** Optional descriptive caption for the node's UI note. */
  note_caption?: string;
}

/** 
 * Represents the shared, high-level narrative state (the "Blackboard"). 
 * 
 * @remarks
 * This structure is updated incrementally at every hop. It provides a
 * rolling synthesis of the investigation's progress without including
 * the low-level details of every object.
 */
export interface ShortMemory {
  /** The current high-level investigation narrative. */
  synthesis_narrative: string;
  /** Statistics regarding exploration coverage within the current scope. */
  coverage: { noted: number; total: number; pct: number };
}

/** 
 * A snapshot of the memory manager's state delivered to the AI during a navigation hop.
 * 
 * @remarks
 * Provides the AI with the current narrative context and progress metrics to
 * guide its next decision.
 */
export interface WorkingMemory {
  /** The current content of the synthesis narrative (Blackboard). */
  blackboard: string;
  /** List of nodes that have been requested but not yet visited. */
  pending_questions: Array<{ nodeId: string; question: string }>;
  /** Full technical analysis of immediately adjacent (1-hop) neighbors that have already been processed. */
  local_detail_context?: DetailSlot[];
  /** Progress tracking metadata. */
  checklist: { 
    /** Current hop index. */
    current_hop: number; 
    /** Number of nodes currently in detail memory. */
    noted: number; 
    /** Total number of nodes in the exploration scope. */
    total: number; 
    /** Exploration progress as a percentage. */
    coveragePct: number 
  };
}


/** Blackboard hard limit — rejection threshold (chars). ~2000 tokens.
 *  Ensures the short memory stays strictly $O(1)$ regardless of hop count. */
const DEFAULT_BLACKBOARD_HARD_LIMIT = 8000;


/**
 * Orchestrates the two-tier memory model (Short vs. Detail) for AI exploration.
 * 
 * @remarks
 * Inspired by MemGPT/Sliding Context patterns, this manager ensures that the AI's
 * active context window is never overwhelmed by high-fidelity data from previous hops,
 * while still preserving all technical findings for final report synthesis.
 */
export class AiMemoryManager {
  private detailSlots = new Map<string, DetailSlot>();
  private synthesisNarrative = '';
  private pendingQuestions: Array<{ nodeId: string; question: string }> = [];

  private readonly hardLimit: number;

  /**
   * Initializes a new AiMemoryManager.
   * 
   * @param config - Configuration options for memory limits.
   */
  constructor(config?: { shortMemoryHardLimit?: number }) {
    this.hardLimit = config?.shortMemoryHardLimit ?? DEFAULT_BLACKBOARD_HARD_LIMIT;
  }

  /** 
   * Resets all memory structures to their initial empty state.
   * 
   * @remarks
   * Must be called at the start of every new exploration session to prevent
   * cross-session leakage.
   */
  public reset(): void {
    this.detailSlots.clear();
    this.synthesisNarrative = '';
    this.pendingQuestions = [];
  }

  /** 
   * Commits technical findings for a specific node to Detail Memory.
   * 
   * @param node - The node object being analyzed.
   * @param analysis - Full technical analysis text.
   * @param summary - Concise summary of the findings.
   * @param meta - UI metadata (labels, captions) generated by the AI.
   * @param inlineMode - If `true`, minimizes storage to only visual metadata.
   */
  public storeDetail(
    node: LineageNode,
    analysis: string,
    summary: string,
    meta?: { badge_label?: string; note_caption?: string },
    inlineMode = false
  ): void {
    // In inline mode, we only store labels/captions for the final result building.
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
   * Updates the global synthesis narrative (the Blackboard).
   * 
   * @remarks
   * Enforces a hard limit on the narrative length to maintain $O(1)$ context growth.
   * 
   * @param newNarrative - The new narrative string to commit.
   * @returns An error message if the limit is exceeded, otherwise `null`.
   */
  public updateSynthesis(newNarrative: string): string | null {
    if (newNarrative.length > this.hardLimit) {
      return `blackboard_too_long: ${newNarrative.length} chars exceeds ${this.hardLimit}. Refine your synthesis to be more dense.`;
    }
    this.synthesisNarrative = newNarrative;
    return null;
  }

  /** 
   * Constructs a working memory snapshot for the AI's current hop. 
   * 
   * @param hopCount - The index of the current navigation hop.
   * @param scopeSize - The total number of nodes in the exploration scope.
   * @param neighborNodeIds - Optional array of adjacent node IDs to fetch local detail context for.
   * @returns A `WorkingMemory` object containing state and progress metrics.
   */
  public getWorkingMemory(hopCount: number, scopeSize: number, neighborNodeIds?: string[]): WorkingMemory {
    const coveragePct = scopeSize > 0 ? Math.round((this.detailSlots.size / scopeSize) * 100) : 0;
    
    let local_detail_context: DetailSlot[] | undefined;
    if (neighborNodeIds && neighborNodeIds.length > 0) {
      local_detail_context = [];
      for (let i = 0; i < neighborNodeIds.length && local_detail_context.length < MAX_LOCAL_NEIGHBORS; i++) {
        const slot = this.detailSlots.get(neighborNodeIds[i]);
        if (slot) local_detail_context.push(slot);
      }
    }
    
    return {
      blackboard: this.synthesisNarrative,
      pending_questions: this.pendingQuestions,
      local_detail_context,
      checklist: {
        current_hop: hopCount,
        noted: this.detailSlots.size,
        total: scopeSize,
        coveragePct,
      },
    };
  }

  /** 
   * Aggregates all session findings for final Phase 3 synthesis and reporting.
   * 
   * @returns A structured collection of short-term narrative and long-term technical details.
   */
  public getResult(): { short_memory: ShortMemory; detail_slots: DetailSlot[] } {
    return {
      short_memory: {
        synthesis_narrative: this.synthesisNarrative,
        coverage: { noted: this.slotCount, total: 0, pct: 0 } // total/pct filled by SM
      },
      detail_slots: Array.from(this.detailSlots.values()),
    };
  }

  /** 
   * Serializes the current memory state to a JSON-compatible object.
   * 
   * @remarks
   * Primarily used for telemetry, debugging, and AI quality evaluation.
   */
  public toJSON() {
    const slots: Record<string, DetailSlot> = {};
    for (const [id, slot] of this.detailSlots) slots[id] = slot;
    return {
      detailSlots: slots,
      slotCount: this.detailSlots.size,
      shortMemory: {
        synthesisNarrative: this.synthesisNarrative,
        synthesisLength: this.synthesisNarrative.length,
        pendingQuestions: this.pendingQuestions,
      },
    };
  }

  /** 
   * Returns the total number of nodes currently stored in Detail Memory.
   */
  public get slotCount(): number { return this.detailSlots.size; }

  /** 
   * Returns an array of node IDs that have been "noted" (analyzed) in the current session.
   */
  public get notedNodeIds(): string[] {
    return Array.from(this.detailSlots.keys());
  }
}
