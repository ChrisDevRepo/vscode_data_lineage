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

// ─── Types ──────────────────────────────────────────────────────────────────

/** Detail memory slot — per-node analysis stored during hops. 
 *  Stored at full fidelity; never truncated or evicted. */
export interface DetailSlot {
  nodeId: string;
  schema: string;
  name: string;
  type: string;
  analysis: string;       // AI's DDL findings (full text — never truncated)
  summary: string;        // one-line digest (AI's own compression)
  badge_label?: string;   // semantic label for enrich_view badge
  note_caption?: string;  // 1-line caption for enrich_view note
}

/** Short memory — the Incremental Blackboard. */
export interface ShortMemory {
  synthesis_narrative: string;                             // the high-level story
  coverage: { noted: number; total: number; pct: number };
}

/** Working memory snapshot — provided to the AI during each hop. */
export interface WorkingMemory {
  blackboard: string;                                     // current synthesis narrative
  pending_questions: Array<{ nodeId: string; question: string }>;
  checklist: { 
    current_hop: number; 
    noted: number; 
    total: number; 
    coveragePct: number 
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Blackboard hard limit — rejection threshold (chars). ~2000 tokens.
 *  Ensures the short memory stays strictly $O(1)$ regardless of hop count. */
const DEFAULT_BLACKBOARD_HARD_LIMIT = 8000;

// ─── Class ─────────────────────────────────────────────────────────────────────

export class AiMemoryManager {
  private detailSlots = new Map<string, DetailSlot>();
  private synthesisNarrative = '';
  private pendingQuestions: Array<{ nodeId: string; question: string }> = [];

  private readonly hardLimit: number;

  constructor(config?: { shortMemoryHardLimit?: number }) {
    this.hardLimit = config?.shortMemoryHardLimit ?? DEFAULT_BLACKBOARD_HARD_LIMIT;
  }

  /** Wipe all memory for a new session. */
  public reset(): void {
    this.detailSlots.clear();
    this.synthesisNarrative = '';
    this.pendingQuestions = [];
  }

  /** Store detailed findings for a specific node. */
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
   * Update the global synthesis narrative (The Blackboard).
   * Returns an error string if the update exceeds the hard limit.
   */
  public updateSynthesis(newNarrative: string): string | null {
    if (newNarrative.length > this.hardLimit) {
      return `blackboard_too_long: ${newNarrative.length} chars exceeds ${this.hardLimit}. Refine your synthesis to be more dense.`;
    }
    this.synthesisNarrative = newNarrative;
    return null;
  }

  /** Build a snapshot of memory for the current hop. */
  public getWorkingMemory(hopCount: number, scopeSize: number): WorkingMemory {
    const coveragePct = scopeSize > 0 ? Math.round((this.detailSlots.size / scopeSize) * 100) : 0;
    
    return {
      blackboard: this.synthesisNarrative,
      pending_questions: this.pendingQuestions,
      checklist: {
        current_hop: hopCount,
        noted: this.detailSlots.size,
        total: scopeSize,
        coveragePct,
      },
    };
  }

  /** Get the final results for Phase 3 synthesis. */
  public getResult(): { short_memory: ShortMemory; detail_slots: DetailSlot[] } {
    return {
      short_memory: {
        synthesis_narrative: this.synthesisNarrative,
        coverage: { noted: this.slotCount, total: 0, pct: 0 } // total/pct filled by SM
      },
      detail_slots: Array.from(this.detailSlots.values()),
    };
  }

  /** State-dump shape for toJSON — supports eval debug, /dumpSmState, and memory-quality pre-gate. */
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

  /** Accessors */
  public get slotCount(): number { return this.detailSlots.size; }

  /** Return all node IDs currently in detail memory. Used by cascade-prune guards. */
  public get notedNodeIds(): string[] {
    return Array.from(this.detailSlots.keys());
  }
}
