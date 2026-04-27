/**
 * AI Memory Manager — per-hop working memory for the navigation engine.
 *
 * @remarks
 * Stores high-fidelity per-node analysis (`DetailSlot`). On every hop the manager
 * emits a {@link WorkingMemory} snapshot containing the user's original question,
 * a sliding window of recent node summaries (incremental loading), and progress 
 * metrics. Emission is state-machine-driven — the full detail archive remains 
 * internal until synthesis to prevent context bloat.
 */

import type { LineageNode } from '../engine/types';


/**
 * Angle of a captured section — drives YAML render-rule selection at synthesis.
 *
 * @remarks
 * The locked classification (`business | technical | both`) dictates which angles
 * fire at capture time:
 * - `business` → exactly one section with `angle: 'business'`
 * - `technical` → exactly one section with `angle: 'technical'`
 * - `both` → two sections, one of each
 * Mechanically enforced in `toolProvider.validateSectionsAgainstClassification`
 * per the agreement-phase classification contract.
 */
export type CaptureAngle = 'business' | 'technical';

/**
 * One captured section within a `DetailSlot` — output of one fired `*_capture` template.
 *
 * @remarks
 * Each `business_capture` / `technical_capture` YAML key produces ONE entry with the
 * matching angle. Body text arrives pre-formatted from active phase and is lifted
 * verbatim by synthesis as a peer entry in `present_result.sections[]` (NOT as a
 * nested subheading inside another section).
 */
export interface CapturedSection {
  /** Which YAML capture template produced this section. */
  angle: CaptureAngle;
  /** Pre-formatted section body — written per the angle's `*_capture.instruction`. */
  text: string;
}

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
  /**
   * Captured sections — one per fired `*_capture` template. Length 1 for
   * `business`/`technical` classification; length 2 for `both`. Length 0 only
   * when verdict was `prune` and no sections were submitted.
   *
   * @remarks
   * Synthesis lifts each section verbatim into `present_result.sections[]` as a
   * peer entry (groupable across nodes for sibling-variant tables). The capture
   * vs synthesis split is mechanical: the AI writes per-node sections at active
   * phase; synthesis groups across nodes.
   */
  sections: CapturedSection[];
  /** One-line digest of the whole node (across both angles when both fire), shared across hops via `short_term_memory`. */
  summary: string;
  /** Optional short role tag used for graph badges. */
  badge_label?: string;
  /** Optional caption shown under the node in the graph. */
  note_caption?: string;
  /** The specific reason or question that triggered the analysis of this node. */
  reason_for_visit?: string;
}


/**
 * Snapshot of the memory state delivered to the model at every navigation hop.
 *
 * @remarks
 * The user question is echoed verbatim and a sliding window of prior findings is
 * exposed through `short_term_memory`. The model receives the immediate
 * investigation context each hop.
 */
export interface WorkingMemory {
  /** The user's original question, echoed verbatim every hop. */
  user_question: string;
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
    /** Monotonic hop counter exposed as the AI-visible budget signal — a counter (not countdown) to avoid the model anchoring on remaining budget. */
    rounds_used: number;
    /** Cumulative count of soft/silent-mode scope expansions. */
    scope_growth: number;
  };

  /** Recent route rejections — prevents the AI from repeating the same invalid or blocked route. Capped at 5 entries. */
  recent_rejections: Array<{ nodeId: string; reason: string; atHop: number }>;
  /** Schemas currently on the session allowlist. Starts from the user filter; grows when the user confirms an expansion gate. */
  active_schemas: string[];
  /** Budget pressure flag — surfaced only when the scope-to-budget ratio is tight. "ok" omitted to avoid noise. */
  budget_pressure?: 'tight' | 'exceeded';
}


/**
 * Frozen snapshot of an `AiMemoryManager`. Returned by `toJSON()` and embedded in
 * `SmState.memory` for the SM-state debug dump and eval extraction.
 */
export interface MemoryStateSnapshot {
  /** The user's original question, captured at session start. */
  userQuestion: string;
  /** Every stored `DetailSlot` keyed by node id, in insertion order. */
  detailSlots: Record<string, DetailSlot>;
  /** Count of stored detail slots (mirrors `Object.keys(detailSlots).length`). */
  slotCount: number;
  /** Per-node sub-questions queued by the AI but not yet visited. */
  pendingQuestions: Array<{ nodeId: string; question: string }>;
}


/**
 * In-session store for the per-hop working memory and full detail archive.
 *
 * @remarks
 * Storage + delivery + execution only — no ranking, no truncation, no content
 * decisions. The model reads the snapshot and decides relevance on its own.
 */
export class AiMemoryManager {
  private detailSlots = new Map<string, DetailSlot>();
  private pendingQuestions: Array<{ nodeId: string; question: string }> = [];
  private userQuestion = '';
  private missionBrief = '';
  private verdictCounts = { analyze: 0, pass: 0, prune: 0 };
  private recentRejections: Array<{ nodeId: string; reason: string; atHop: number }> = [];

  /** Clears every field so the manager can be reused across sessions. */
  public reset(): void {
    this.detailSlots.clear();
    this.pendingQuestions = [];
    this.userQuestion = '';
    this.missionBrief = '';
    this.verdictCounts = { analyze: 0, pass: 0, prune: 0 };
    this.recentRejections = [];
  }

  /**
   * Records one verdict against the running A/P/Pr tally.
   *
   * @param verdict - The verdict the model submitted this hop.
   */
  public recordVerdict(verdict: 'analyze' | 'pass' | 'prune'): void {
    this.verdictCounts[verdict]++;
  }

  /**
   * Appends a route rejection to the ring buffer surfaced back to the model via working memory.
   *
   * @param nodeId - Node id that was rejected.
   * @param reason - Short reason string (engine error code + detail).
   * @param atHop - Hop index the rejection happened at.
   */
  public recordRejection(nodeId: string, reason: string, atHop: number): void {
    this.recentRejections.push({ nodeId, reason, atHop });
    // Enforce ring-buffer cap to prevent unbounded growth.
    if (this.recentRejections.length > 5) this.recentRejections.shift();
  }

  /**
   * Records the user's original question so it can be echoed in every working-memory snapshot.
   *
   * @param q - The user's question, verbatim.
   */
  public setUserQuestion(q: string): void {
    this.userQuestion = q;
  }

  /** The user's original question, as captured at session start. */
  public getUserQuestion(): string {
    return this.userQuestion;
  }

  /**
   * Records the AI-composed mission brief — a distilled narrative of intent + filters + scope
   * delivered every hop. Survives sliding-memory wipes.
   */
  public setMissionBrief(brief: string): void {
    this.missionBrief = brief;
  }

  /** The mission brief the AI composed at discovery→active transition. */
  public getMissionBrief(): string {
    return this.missionBrief;
  }

  /**
   * Stores the technical findings for a single node in the detail archive.
   *
   * @param node - The node the findings describe.
   * @param sections - Captured sections (one per fired `*_capture` template).
   * @param summary - One-line digest of the whole node, shared across hops via `short_term_memory`.
   * @param meta - Optional UI metadata — `badge_label`, `note_caption`, `reason_for_visit`.
   *
   * @remarks
   * Sections are stored verbatim regardless of inline vs SM mode — uniform
   * downstream shape simplifies eval extraction and synthesis lift.
   */
  public storeDetail(
    node: LineageNode,
    sections: CapturedSection[],
    summary: string,
    meta?: { badge_label?: string; note_caption?: string; reason_for_visit?: string },
  ): void {
    this.detailSlots.set(node.id, {
      nodeId: node.id,
      schema: node.schema,
      name: node.name,
      type: node.type,
      sections,
      summary,
      badge_label: meta?.badge_label,
      note_caption: meta?.note_caption,
      reason_for_visit: meta?.reason_for_visit,
    });
  }

  /**
   * Produces the working-memory snapshot delivered to the model this hop.
   *
   * @param hopCount - Hop index (1-based) supplied by the engine.
   * @param scopeSize - Total number of nodes in the exploration scope.
   * @returns A `WorkingMemory` snapshot with `user_question`, checklist metrics, and route rejection history.
   */
  public getWorkingMemory(
    hopCount: number,
    scopeSize: number,
    extras: {
      rounds_used: number;
      scope_growth: number;
      active_schemas: string[];
      budget_pressure?: 'tight' | 'exceeded';
    } = { rounds_used: hopCount, scope_growth: 0, active_schemas: [] },
  ): WorkingMemory {
    const noted = this.detailSlots.size;
    const coveragePct = scopeSize > 0 ? Math.round((noted / scopeSize) * 100) : 0;

    const memory: WorkingMemory = {
      user_question: this.userQuestion,
      checklist: {
        current_hop: hopCount,
        noted,
        total: scopeSize,
        open: Math.max(0, scopeSize - noted),
        coveragePct,
        rounds_used: extras.rounds_used,
        scope_growth: extras.scope_growth,
      },
      recent_rejections: this.recentRejections.slice(),
      active_schemas: extras.active_schemas.slice(),
    };
    if (extras.budget_pressure) memory.budget_pressure = extras.budget_pressure;
    return memory;
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
  public toJSON(): MemoryStateSnapshot {
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

  /** Cloned verdict tally for diagnostics / logging. */
  public getVerdictCounts(): { analyze: number; pass: number; prune: number } {
    return { ...this.verdictCounts };
  }

  /**
   * Returns the last 3 node summaries for injection into the system prompt `<short_term_memory>` block.
   *
   * @remarks
   * Same sliding window used by `getWorkingMemory` — exposed separately so prompt builders
   * can access it without constructing the full working-memory envelope.
   */
  public getShortTermMemory(): Array<{ nodeId: string; summary: string }> {
    return Array.from(this.detailSlots.values())
      .slice(-3)
      .map(s => ({ nodeId: s.nodeId, summary: s.summary }));
  }
}
