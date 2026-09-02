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

import type { LineageNode } from '../../engine/types';

/**
 * Node summaries carried forward in the `<short_term_memory>` window.
 *
 * @remarks
 * Three because the window exists to show how the *immediately preceding* hops connect; the full
 * detail archive stays internal until synthesis, so widening this trades prompt budget for context
 * the model already committed to engine memory.
 */
const RECENT_SUMMARY_WINDOW = 3;

/**
 * Depth of the recent-rejection ring replayed to the active worker.
 *
 * @remarks
 * Five because the ring exists for self-correction on the *current* routing attempt; rejections
 * older than that describe routes the engine has already moved past and only crowd the prompt.
 */
const MAX_RECENT_REJECTIONS = 5;


/**
 * Angle of a captured section — drives YAML render-rule selection at synthesis.
 *
 * @remarks
 * The locked classification (`business | technical | both`) dictates which angles
 * are required at capture time:
 * - `business` → at least one section with `angle: 'business'`
 * - `technical` → at least one section with `angle: 'technical'`
 * - `both` → at least one section of each angle
 * Mechanically enforced in `interaction/rules/submitFindingsRules`
 * (`validateSectionsAgainstClassification` requires the locked angles;
 * `filterSectionsForClassification` drops off-classification sections at commit)
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
   * Captured sections — one per fired `*_capture` template. The locked
   * classification defines required angles; optional extra valid angle sections
   * may also be stored.
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
  /** Optional hop-time role hint for synthesis; not rendered directly. */
  badge_label?: string;
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
  /** The AI-composed mission brief, surviving sliding-memory wipes. */
  missionBrief: string;
  /** User-stated analysis constraints no filter expresses, surviving sliding-memory wipes. */
  scopeNotes: string[];
  /** Running verdict tally. */
  verdictCounts: { analyze: number; passthrough: number; prune: number };
  /** Ring buffer (≤5) of recent route rejections surfaced in working memory. */
  recentRejections: Array<{ nodeId: string; reason: string; atHop: number }>;
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
  /**
   * Archive of content already captured for a node at the hop where its focus verdict landed
   * `prune`. Storage only — never read by {@link getResult} or {@link getWorkingMemory}, so a
   * self-prune cannot resurrect a node into the synthesis-visible archive. Kept so a later,
   * separately-approved read path can cite it; see `getPrunedDetails`.
   */
  private prunedDetails = new Map<string, DetailSlot>();
  private userQuestion = '';
  private missionBrief = '';
  private scopeNotes: string[] = [];
  private verdictCounts = { analyze: 0, passthrough: 0, prune: 0 };
  private recentRejections: Array<{ nodeId: string; reason: string; atHop: number }> = [];

  /** Clears every field so the manager can be reused across sessions. */
  public reset(): void {
    this.detailSlots.clear();
    this.prunedDetails.clear();
    this.userQuestion = '';
    this.missionBrief = '';
    this.scopeNotes = [];
    this.verdictCounts = { analyze: 0, passthrough: 0, prune: 0 };
    this.recentRejections = [];
  }

  /**
   * Records one verdict against the running A/P/prune tally.
   *
   * @param verdict - The verdict the model submitted this hop (`analyze`, `passthrough`, or `prune` — the AI
   * may self-prune an irrelevant node; BB self-prune is orphan-guarded by the engine, see `submitFindings`).
   */
  public recordVerdict(verdict: 'analyze' | 'passthrough' | 'prune'): void {
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
    if (this.recentRejections.length > MAX_RECENT_REJECTIONS) this.recentRejections.shift();
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
   * Records the user-stated analysis constraints that no filter field expresses.
   *
   * @remarks
   * Fixed once at `start_exploration` approval, so it is stable-prefix-safe: every hop renders the
   * same bytes. Without this carrier an instruction like "ignore filter criteria" reaches the first
   * hop only as conversation history and is dropped by the sliding-memory wipe.
   */
  public setScopeNotes(notes: readonly string[]): void {
    this.scopeNotes = [...notes];
  }

  /** User-stated constraints carried verbatim to every hop. */
  public getScopeNotes(): string[] {
    return [...this.scopeNotes];
  }

  /**
   * Stores the technical findings for a single node in the detail archive.
   *
   * @param node - The node the findings describe.
   * @param sections - Captured sections (one per fired `*_capture` template).
   * @param summary - One-line digest of the whole node, shared across hops via `short_term_memory`.
   * @param meta - Optional synthesis metadata — `badge_label`, `reason_for_visit`.
   *
   * @remarks
   * Sections are stored verbatim — uniform downstream shape simplifies eval
   * extraction and synthesis lift.
   */
  public storeDetail(
    node: LineageNode,
    sections: CapturedSection[],
    summary: string,
    meta?: { badge_label?: string; reason_for_visit?: string },
  ): void {
    this.detailSlots.set(node.id, {
      nodeId: node.id,
      schema: node.schema,
      name: node.name,
      type: node.type,
      sections,
      summary,
      badge_label: meta?.badge_label,
      reason_for_visit: meta?.reason_for_visit,
    });
  }

  /**
   * Retains a self-pruned focus node's already-captured content instead of discarding it.
   *
   * @param node - The node the findings describe.
   * @param sections - Captured sections at the hop where the verdict landed `prune`.
   * @param summary - One-line digest submitted alongside the prune verdict.
   * @param meta - Optional synthesis metadata — `badge_label`, `reason_for_visit`.
   *
   * @remarks
   * No-op when nothing was captured (`sections` empty and `summary` blank) — a bare prune with no
   * prior content leaves nothing worth retaining. Writes to {@link prunedDetails}, a store distinct
   * from {@link detailSlots}; {@link getResult} never reads it, so this cannot change what synthesis
   * sees on a run that would otherwise succeed.
   */
  public storePrunedDetail(
    node: LineageNode,
    sections: CapturedSection[],
    summary: string,
    meta?: { badge_label?: string; reason_for_visit?: string },
  ): void {
    if (sections.length === 0 && !summary.trim()) return;
    this.prunedDetails.set(node.id, {
      nodeId: node.id,
      schema: node.schema,
      name: node.name,
      type: node.type,
      sections,
      summary,
      badge_label: meta?.badge_label,
      reason_for_visit: meta?.reason_for_visit,
    });
  }

  /**
   * Archive of content retained from self-pruned focus nodes, in insertion order.
   *
   * @remarks
   * Not consumed by any current caller — the read side is deferred past rollout. Exposed for
   * diagnostics and for tests pinning the retention write.
   */
  public getPrunedDetails(): DetailSlot[] {
    return Array.from(this.prunedDetails.values());
  }

  /**
   * Produces the working-memory snapshot delivered to the model this hop.
   *
   * @param hopCount - Hop index (1-based) supplied by the engine.
   * @param scopeSize - Total number of nodes in the exploration scope.
   * @param extras - Additional progress metrics.
   * @returns A `WorkingMemory` snapshot with `user_question`, checklist metrics, and route rejection history.
   */
  public getWorkingMemory(
    hopCount: number,
    scopeSize: number,
    extras: {
      rounds_used: number;
      scope_growth: number;
      active_schemas: string[];
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

  /** JSON snapshot used by telemetry, eval extraction, and strict engine-checkpoint assembly. */
  public toJSON(): MemoryStateSnapshot {
    const slots: Record<string, DetailSlot> = {};
    for (const [id, slot] of this.detailSlots) slots[id] = slot;
    return {
      userQuestion: this.userQuestion,
      scopeNotes: [...this.scopeNotes],
      detailSlots: slots,
      slotCount: this.detailSlots.size,
      missionBrief: this.missionBrief,
      verdictCounts: { ...this.verdictCounts },
      recentRejections: this.recentRejections.slice(),
    };
  }

  /**
   * Rehydrates a manager from a {@link toJSON} snapshot.
   *
   * @remarks
   * The inverse of {@link toJSON}: restores the detail archive **in insertion order** (so the
   * sliding `<short_term_memory>` window and synthesis lift see the same sequence), plus the
   * mission brief, verdict tally and rejection ring. Engine restore passes a memory snapshot
   * already validated as part of the strict current-format checkpoint.
   *
   * @param snapshot - A prior `toJSON()` payload (typically after a JSON serialize/parse round-trip).
   * @returns A new manager carrying the restored state.
   */
  public static fromJSON(snapshot: MemoryStateSnapshot): AiMemoryManager {
    const m = new AiMemoryManager();
    m.userQuestion = snapshot.userQuestion;
    m.missionBrief = snapshot.missionBrief;
    m.scopeNotes = [...snapshot.scopeNotes];
    m.verdictCounts = { ...snapshot.verdictCounts };
    m.recentRejections = snapshot.recentRejections.map(r => ({ ...r }));
    // Object key order preserves insertion order for the non-integer node-id keys used here.
    for (const [id, slot] of Object.entries(snapshot.detailSlots)) m.detailSlots.set(id, slot);
    return m;
  }

  /**
   * Replaces this manager's contents with a validated persisted snapshot.
   *
   * @remarks
   * `AiSession.memory` is a stable readonly object shared by prompt builders and the
   * state machine. Cross-restart graph resume must therefore restore the object in place
   * rather than swapping the reference.
   */
  public restoreFromJSON(snapshot: MemoryStateSnapshot): void {
    const restored = AiMemoryManager.fromJSON(snapshot);
    this.detailSlots = restored.detailSlots;
    this.userQuestion = restored.userQuestion;
    this.missionBrief = restored.missionBrief;
    this.scopeNotes = [...restored.scopeNotes];
    this.verdictCounts = restored.verdictCounts;
    this.recentRejections = restored.recentRejections;
  }

  /** Count of nodes currently stored in the detail archive. */
  public get slotCount(): number {
    return this.detailSlots.size;
  }

  /** Node IDs of every stored detail slot. */
  public get notedNodeIds(): string[] {
    return Array.from(this.detailSlots.keys());
  }

  /** Cloned A/P/prune verdict tally for diagnostics / logging. */
  public getVerdictCounts(): { analyze: number; passthrough: number; prune: number } {
    return { ...this.verdictCounts };
  }

  /**
   * Returns the last {@link RECENT_SUMMARY_WINDOW} node summaries for injection into the system
   * prompt `<short_term_memory>` block.
   *
   * @remarks
   * Same sliding window used by `getWorkingMemory` — exposed separately so prompt builders
   * can access it without constructing the full working-memory envelope.
   */
  public getShortTermMemory(): Array<{ nodeId: string; summary: string }> {
    return Array.from(this.detailSlots.values())
      .slice(-RECENT_SUMMARY_WINDOW)
      .map(s => ({ nodeId: s.nodeId, summary: s.summary }));
  }

  /**
   * Returns the recent-rejection ring (max {@link MAX_RECENT_REJECTIONS}) for injection into the
   * active worker prompt so the model can self-correct from prior rejected hops.
   *
   * @remarks
   * Same ring surfaced in `getWorkingMemory().recent_rejections` — exposed separately so the host
   * worker's `buildMemoryBlock` can render it without constructing the full working-memory envelope
   * (the host worker is handed `peekHopContext`, which omits `working_memory`).
   */
  public getRecentRejections(): Array<{ nodeId: string; reason: string; atHop: number }> {
    return this.recentRejections.slice();
  }
}
