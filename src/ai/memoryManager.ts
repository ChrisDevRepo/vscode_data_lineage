/**
 * AI Memory Manager — Two-tier memory model (MemGPT-inspired).
 * 
 * Separates Short Memory (narrative summaries) from Detail Memory (full DDL analysis).
 * Used by both ColumnTraceState and BlackboardState to ensure consistent memory
 * management and token budget enforcement across all exploration modes.
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
  tags?: string[];
  badge_label?: string;   // semantic label for enrich_view badge
  note_caption?: string;  // 1-line caption for enrich_view note
}

/** Short memory — compressed narrative, always available in working memory. */
export interface ShortMemory {
  narrative: string[];                                     // key findings per hop
  coverage: { noted: number; total: number; pct: number };
  pending_questions: Array<{ nodeId: string; question: string }>;
}

/** Working memory snapshot — provided to the AI during each hop. */
export interface WorkingMemory {
  all_summaries: Array<{ nodeId: string; summary: string }>;
  pending_questions: Array<{ nodeId: string; question: string }>;
  checklist: { 
    current_hop: number; 
    noted: number; 
    total: number; 
    coveragePct: number 
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Short memory soft limit — AI target for per-hop narrative entries (chars). */
const DEFAULT_SHORT_MEMORY_SOFT_LIMIT = 500;
/** Short memory hard limit — rejection threshold (chars). ~300 tokens. */
const DEFAULT_SHORT_MEMORY_HARD_LIMIT = 1200;

// ─── Class ─────────────────────────────────────────────────────────────────────

export class AiMemoryManager {
  private detailSlots = new Map<string, DetailSlot>();
  private shortMemory: ShortMemory = {
    narrative: [],
    coverage: { noted: 0, total: 0, pct: 0 },
    pending_questions: [],
  };

  private readonly softLimit: number;
  private readonly hardLimit: number;

  constructor(config?: { shortMemorySoftLimit?: number; shortMemoryHardLimit?: number }) {
    this.softLimit = config?.shortMemorySoftLimit ?? DEFAULT_SHORT_MEMORY_SOFT_LIMIT;
    this.hardLimit = config?.shortMemoryHardLimit ?? DEFAULT_SHORT_MEMORY_HARD_LIMIT;
  }

  /** Wipe all memory for a new session. */
  public reset(): void {
    this.detailSlots.clear();
    this.shortMemory = {
      narrative: [],
      coverage: { noted: 0, total: 0, pct: 0 },
      pending_questions: [],
    };
  }

  /** Store detailed findings for a specific node. */
  public storeDetail(
    node: LineageNode,
    analysis: string,
    summary: string,
    meta?: { tags?: string[]; badge_label?: string; note_caption?: string },
    inlineMode = false
  ): void {
    // In inline mode, we only store labels/captions for the final result building.
    // The AI already has the full SQL context in its turn history.
    this.detailSlots.set(node.id, {
      nodeId: node.id,
      schema: node.schema,
      name: node.name,
      type: node.type,
      analysis: inlineMode ? '' : analysis,
      summary: inlineMode ? '' : summary,
      tags: meta?.tags,
      badge_label: meta?.badge_label,
      note_caption: meta?.note_caption,
    });
  }

  /** 
   * Add a narrative entry to short memory. 
   * Returns an error string if the entry exceeds the hard limit.
   */
  public addNarrative(hopSummary: string, coverage: { noted: number; total: number }): string | null {
    if (hopSummary.length > this.hardLimit) {
      return `short_memory_too_long: ${hopSummary.length} chars exceeds ${this.hardLimit} (aim for ~${this.softLimit})`;
    }
    this.shortMemory.narrative.push(hopSummary);
    this.updateCoverage(coverage.noted, coverage.total);
    return null;
  }

  /** Update the coverage statistics. */
  private updateCoverage(noted: number, total: number): void {
    const pct = total > 0 ? Math.round((noted / total) * 100) : 0;
    this.shortMemory.coverage = { noted, total, pct };
  }

  /** Set the list of questions the AI still needs to answer. */
  public setPendingQuestions(questions: Array<{ nodeId: string; question: string }>): void {
    this.shortMemory.pending_questions = questions;
  }

  /** Build a snapshot of memory for the current hop. */
  public getWorkingMemory(hopCount: number, scopeSize: number): WorkingMemory {
    const coveragePct = scopeSize > 0 ? Math.round((this.detailSlots.size / scopeSize) * 100) : 0;
    
    return {
      all_summaries: Array.from(this.detailSlots.values()).map(s => ({ 
        nodeId: s.nodeId, 
        summary: s.summary 
      })),
      pending_questions: this.shortMemory.pending_questions,
      checklist: {
        current_hop: hopCount,
        noted: this.detailSlots.size,
        total: scopeSize,
        coveragePct,
      },
    };
  }

  /** Get the final results for synthesis. */
  public getResult(): { short_memory: ShortMemory; detail_slots: DetailSlot[] } {
    return {
      short_memory: { ...this.shortMemory },
      detail_slots: Array.from(this.detailSlots.values()),
    };
  }

  /** Accessors */
  public get slotCount(): number { return this.detailSlots.size; }
  public getNarrativeCount(): number { return this.shortMemory.narrative.length; }

  /** Return all node IDs currently in detail memory. */
  public get notedNodeIds(): string[] {
    return Array.from(this.detailSlots.keys());
  }

  public getSlot(nodeId: string): DetailSlot | undefined {
    return this.detailSlots.get(nodeId);
  }
}
