/**
 * Per-hop working memory for the navigation engine. Stores per-node analysis (`DetailSlot`) and
 * emits a {@link WorkingMemory} snapshot each hop: the user question, a sliding window of recent
 * node summaries and progress metrics. The full detail archive stays internal until synthesis to
 * prevent context bloat.
 */

import type { LineageNode } from '../../engine/types';

/**
 * Neighbor summaries carried in `<short_term_memory>`. At most three: the most recent stored
 * summaries of the focus's neighbors. A non-neighbor does not bear on this hop, and widening
 * past three trades prompt budget for context the engine already stores.
 */
const RECENT_SUMMARY_WINDOW = 3;

/**
 * Depth of the recent-rejection ring replayed to the active worker. Five because the ring serves
 * self-correction on the *current* routing attempt; older rejections describe routes the engine
 * moved past and crowd the prompt.
 */
const MAX_RECENT_REJECTIONS = 5;


/**
 * Angle of a captured section; drives YAML render-rule selection at synthesis.
 *
 * The locked classification (`business | technical | both`) requires at least one section of each
 * locked angle. Enforced two ways: the per-dispatch `submit_findings` schema
 * (`submitFindingsSchemaForMode`) narrows the `angle` enum to the locked angle(s), and
 * `submitFindingsRules.validateSectionsAgainstClassification` checks they are present.
 */
export type CaptureAngle = 'business' | 'technical';

/**
 * One captured section within a `DetailSlot`: the output of one fired `*_capture` template. Body
 * text arrives pre-formatted and is lifted verbatim by synthesis as a peer entry in
 * `present_result.sections[]`, not as a subheading of another section.
 */
export interface CapturedSection {
  /** Which YAML capture template produced this section. */
  angle: CaptureAngle;
  /** Pre-formatted section body — written per the angle's `*_capture.instruction`. */
  text: string;
}

/**
 * High-fidelity analysis for a single visited node, stored by `AiMemoryManager.storeDetail` at full
 * fidelity for the session and exposed in `getResult()` so synthesis can render every slot
 * verbatim.
 */
export interface DetailSlot {
  nodeId: string;
  schema: string;
  name: string;
  /** Object type (e.g. 'table', 'view', 'procedure'). */
  type: string;
  /**
   * Captured sections, one per fired `*_capture` template; extra valid-angle sections may also be
   * stored. Synthesis lifts each verbatim as a peer entry in `present_result.sections[]` (groupable
   * across nodes); the AI writes per-node sections at active phase, synthesis groups across nodes.
   */
  sections: CapturedSection[];
  /**
   * One-line digest of the whole node (across both angles when both fire), shared across hops via
   * `short_term_memory`.
   */
  summary: string;
  /** Optional hop-time role hint for synthesis; not rendered directly. */
  badge_label?: string;
  /** The specific reason or question that triggered the analysis of this node. */
  reason_for_visit?: string;
}


/**
 * Snapshot of the memory state delivered to the model at every navigation hop: the user question
 * verbatim plus a sliding window of prior findings in `short_term_memory`.
 */
export interface WorkingMemory {
  /** The user's original question, echoed verbatim every hop. */
  user_question: string;
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
    /**
     * Monotonic hop counter shown to the AI as its budget signal; counts up so the model does not
     * anchor on it.
     */
    rounds_used: number;
    /** Cumulative count of soft/silent-mode scope expansions. */
    scope_growth: number;
  };

  /** Recent route rejections, so the AI does not repeat an invalid or blocked route; max 5. */
  recent_rejections: Array<{ nodeId: string; reason: string; atHop: number }>;
  /** Session allowlist schemas: the user filter, grown when an expansion gate is confirmed. */
  active_schemas: string[];
}


/** Frozen `AiMemoryManager` snapshot from `toJSON()`, embedded in `SmState.memory`. */
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
  verdictCounts: { analyze: number; passthrough: number; prune: number };
  /** Ring buffer (≤5) of recent route rejections surfaced in working memory. */
  recentRejections: Array<{ nodeId: string; reason: string; atHop: number }>;
}


/**
 * Appends `incoming` sections the archived `earlier` ones do not already carry verbatim. Identity
 * is exact equality of trimmed body text, angle ignored; first occurrence wins. A first write (no
 * `earlier`) passes through untouched. A section that merely contains, or is contained by, an
 * earlier one is distinct evidence and is kept. A dropped duplicate is NORMALIZE-WITH-LOG when
 * `debugLog` is supplied.
 *
 * @param debugLog - Optional debug sink; {@link AiMemoryManager.storeDetail} passes the logger it
 *   holds.
 */
function appendUniqueSections(
  earlier: readonly CapturedSection[],
  incoming: readonly CapturedSection[],
  nodeId?: string,
  debugLog?: (message: string) => void,
): CapturedSection[] {
  if (earlier.length === 0) return [...incoming];
  const seenTexts = new Set(earlier.map(s => s.text.trim()));
  const merged = [...earlier];
  let droppedCount = 0;
  for (const section of incoming) {
    const text = section.text.trim();
    if (text && seenTexts.has(text)) {
      droppedCount++;
      continue;
    }
    merged.push(section);
  }
  if (droppedCount > 0) {
    debugLog?.(`[Memory] duplicate section(s) dropped on revisit — node=${nodeId ?? '(unknown)'} count=${droppedCount}`);
  }
  return merged;
}

/**
 * In-session store for the per-hop working memory and full detail archive. Storage, delivery and
 * execution only: no ranking, truncation or content decisions; the model decides relevance.
 */
export class AiMemoryManager {
  private detailSlots = new Map<string, DetailSlot>();
  private userQuestion = '';
  private missionBrief = '';
  private scopeNotes: string[] = [];
  private verdictCounts = { analyze: 0, passthrough: 0, prune: 0 };
  private recentRejections: Array<{ nodeId: string; reason: string; atHop: number }> = [];

  /** Clears every field so the manager can be reused across sessions. */
  public reset(): void {
    this.detailSlots.clear();
    this.userQuestion = '';
    this.missionBrief = '';
    this.scopeNotes = [];
    this.verdictCounts = { analyze: 0, passthrough: 0, prune: 0 };
    this.recentRejections = [];
  }

  /**
   * Records one focus verdict against the running tally. The `prune` count is not fed from here;
   * the engine reports pruned nodes from node lifecycle.
   */
  public recordVerdict(verdict: 'analyze' | 'passthrough'): void {
    this.verdictCounts[verdict]++;
  }

  /**
   * Appends a route rejection to the ring buffer surfaced back to the model via working memory.
   *
   * @param reason - Short reason string (engine error code + detail).
   */
  public recordRejection(nodeId: string, reason: string, atHop: number): void {
    this.recentRejections.push({ nodeId, reason, atHop });
    if (this.recentRejections.length > MAX_RECENT_REJECTIONS) this.recentRejections.shift();
  }

  /** Records the user's original question, echoed verbatim in every working-memory snapshot. */
  public setUserQuestion(q: string): void {
    this.userQuestion = q;
  }

  /** The user's original question, as captured at session start. */
  public getUserQuestion(): string {
    return this.userQuestion;
  }

  /** The AI's mission brief (intent, filters, scope): re-sent each hop, kept across wipes. */
  public setMissionBrief(brief: string): void {
    this.missionBrief = brief;
  }

  /** The mission brief the AI composed at discovery→active transition. */
  public getMissionBrief(): string {
    return this.missionBrief;
  }

  /**
   * Records the user-stated analysis constraints that no filter field expresses. Fixed once at
   * `start_exploration` approval, so it is stable-prefix-safe; without this carrier an instruction
   * like "ignore filter criteria" reaches the first hop only as history and is lost to the
   * sliding-memory wipe.
   */
  public setScopeNotes(notes: readonly string[]): void {
    this.scopeNotes = [...notes];
  }

  /** User-stated constraints carried verbatim to every hop. */
  public getScopeNotes(): string[] {
    return [...this.scopeNotes];
  }

  /**
   * Stores the technical findings for a single node in the detail archive. Sections are stored
   * verbatim. A revisit (a `supplementAgenda` follow-up re-enqueues a visited node) appends its
   * sections after the earlier visit's; summary and metadata take the latest visit, and
   * {@link appendUniqueSections} drops re-emitted text. Column-flow notes remain on their
   * structural records.
   *
   * @param summary - One-line digest of the whole node, shared across hops via `short_term_memory`.
   * @param meta - Optional synthesis metadata: `badge_label`, `reason_for_visit`.
   * @param debugLog - Optional debug sink for the NORMALIZE-WITH-LOG lines: a revisit section
   *   dropped as an exact repeat, and each `summary` / `badge_label` / `reason_for_visit` a revisit
   *   replaced.
   */
  public storeDetail(
    node: LineageNode,
    sections: CapturedSection[],
    summary: string,
    meta?: { badge_label?: string; reason_for_visit?: string },
    debugLog?: (message: string) => void,
  ): void {
    const previous = this.detailSlots.get(node.id);
    const earlier = previous?.sections ?? [];
    if (previous) {
      const replaced = ([
        ['summary', previous.summary, summary],
        ['badge_label', previous.badge_label, meta?.badge_label],
        ['reason_for_visit', previous.reason_for_visit, meta?.reason_for_visit],
      ] as const).filter(([, before, after]) => before !== after).map(([field]) => field);
      if (replaced.length > 0) {
        debugLog?.(`[Memory] revisit replaced ${replaced.join(',')} — node=${node.id}`);
      }
    }
    this.detailSlots.set(node.id, {
      nodeId: node.id,
      schema: node.schema,
      name: node.name,
      type: node.type,
      sections: appendUniqueSections(earlier, sections, node.id, debugLog),
      summary,
      badge_label: meta?.badge_label,
      reason_for_visit: meta?.reason_for_visit,
    });
  }

  /**
   * Capture angles already archived for `nodeId` from an earlier visit, read before this
   * submission's sections are merged by {@link storeDetail}. A `supplementAgenda` revisit appends
   * to the archive, so it need not re-carry an angle already held; callers credit the archive when
   * checking classification-locked angle coverage. Empty for a first visit.
   */
  public getArchivedAngles(nodeId: string): Set<CaptureAngle> {
    return new Set(this.detailSlots.get(nodeId)?.sections.map(s => s.angle) ?? []);
  }

  /**
   * Produces the working-memory snapshot delivered to the model this hop.
   *
   * @param hopCount - Hop index (1-based) supplied by the engine.
   * @param extras - Additional progress metrics.
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

  /** Returns the full detail archive for synthesis, in insertion order. */
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
   * Rehydrates a manager from a {@link toJSON} snapshot (typically after a JSON round-trip).
   * Restores the archive **in insertion order** so the sliding window and synthesis lift see the
   * same sequence, plus the mission brief, verdict tally and rejection ring.
   */
  public static fromJSON(snapshot: MemoryStateSnapshot): AiMemoryManager {
    const m = new AiMemoryManager();
    m.userQuestion = snapshot.userQuestion;
    m.missionBrief = snapshot.missionBrief;
    m.scopeNotes = [...snapshot.scopeNotes];
    m.verdictCounts = { ...snapshot.verdictCounts };
    m.recentRejections = snapshot.recentRejections.map(r => ({ ...r }));
    for (const [id, slot] of Object.entries(snapshot.detailSlots)) m.detailSlots.set(id, slot);
    return m;
  }

  /**
   * Replaces this manager's contents with a validated persisted snapshot, in place:
   * `AiSession.memory` is a readonly object shared by prompt builders and the state machine, so a
   * rollback must not swap the reference.
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

  public get slotCount(): number {
    return this.detailSlots.size;
  }

  public get notedNodeIds(): string[] {
    return Array.from(this.detailSlots.keys());
  }

  /** Cloned A/P/prune verdict tally for diagnostics / logging. */
  public getVerdictCounts(): { analyze: number; passthrough: number; prune: number } {
    return { ...this.verdictCounts };
  }

  /**
   * Summaries for `<short_term_memory>`: the last {@link RECENT_SUMMARY_WINDOW} stored slots
   * whose node id is in `neighborIds`, in insertion order. Empty when none of those neighbors
   * have a stored summary.
   *
   * @param neighborIds - Node ids of this hop's focus neighbors.
   */
  public getShortTermMemory(neighborIds: readonly string[]): Array<{ nodeId: string; summary: string }> {
    const neighbors = new Set(neighborIds);
    return Array.from(this.detailSlots.values())
      .filter(slot => neighbors.has(slot.nodeId))
      .slice(-RECENT_SUMMARY_WINDOW)
      .map(slot => ({ nodeId: slot.nodeId, summary: slot.summary }));
  }

  /**
   * Returns the recent-rejection ring (max {@link MAX_RECENT_REJECTIONS}) for the active worker
   * prompt. Same ring as `getWorkingMemory().recent_rejections`; exposed separately because the
   * host worker is handed `peekHopContext`, which omits `working_memory`.
   */
  public getRecentRejections(): Array<{ nodeId: string; reason: string; atHop: number }> {
    return this.recentRejections.slice();
  }
}
