/** AI Memory Manager — per-hop working memory for the navigation engine. */

import type { LineageNode } from '../../engine/types';

/** Node summaries carried forward in the `<short_term_memory>` window. */
const RECENT_SUMMARY_WINDOW = 3;

/** Depth of the recent-rejection ring replayed to the active worker. */
const MAX_RECENT_REJECTIONS = 5;


/** Angle of a captured section — drives YAML render-rule selection at synthesis. */
type CaptureAngle = 'business' | 'technical';

/** One captured section within a `DetailSlot` — output of one fired `*_capture` template. */
export interface CapturedSection {
  /** Which YAML capture template produced this section. */
  angle: CaptureAngle;
  /** Pre-formatted section body — written per the angle's `*_capture.instruction`. */
  text: string;
}

/** High-fidelity analysis for a single visited node. */
export interface DetailSlot {
  /** Node identifier. */
  nodeId: string;
  /** Schema of the database object. */
  schema: string;
  /** Object name. */
  name: string;
  /** Object type (e.g. 'table', 'view', 'procedure'). */
  type: string;
  /** Captured sections — one per fired `*_capture` template. The locked classification defines required angles; optional extra valid angle sections may also be stored. */
  sections: CapturedSection[];
  /** One-line digest of the whole node (across both angles when both fire), shared across hops via `short_term_memory`. */
  summary: string;
  /** Optional hop-time role hint for synthesis; not rendered directly. */
  badge_label?: string;
  /** Every non-blank sub-question the hop was dispatched with, verbatim, with the node whose hop asked it when the task ledger records one. Revisits append; nothing is replaced. */
  incoming_questions?: IncomingQuestion[];
  /** First dispatch question, written only by snapshots taken before `incoming_questions` existed. */
  reason_for_visit?: string;
}

/** One sub-question a hop was dispatched with. */
export interface IncomingQuestion {
  /** The question text as the hop received it. */
  question: string;
  /** Node whose hop asked the question; absent when the ledger records no asking hop. */
  from_node?: string;
}

/** Appends `incoming` questions not already present by exact sender and trimmed text. */
function appendUniqueQuestions(earlier: readonly IncomingQuestion[], incoming: readonly IncomingQuestion[]): IncomingQuestion[] {
  const key = (q: IncomingQuestion): string => JSON.stringify([q.from_node ?? '', q.question.trim()]);
  const seen = new Set(earlier.map(key));
  const merged = [...earlier];
  for (const q of incoming) {
    if (seen.has(key(q))) continue;
    seen.add(key(q));
    merged.push(q);
  }
  return merged;
}


/** Snapshot of the memory state delivered to the model at every navigation hop. */
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


/** Frozen snapshot of an `AiMemoryManager`. Returned by `toJSON()` and embedded in `SmState.memory` for the SM-state debug dump and eval extraction. */
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


/** Appends `incoming` sections that the archived `earlier` ones do not already carry verbatim. */
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

/** In-session store for the per-hop working memory and full detail archive. */
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

  /** Records one focus verdict against the running tally. */
  public recordVerdict(verdict: 'analyze' | 'passthrough'): void {
    this.verdictCounts[verdict]++;
  }

  /** Appends a route rejection to the ring buffer surfaced back to the model via working memory. */
  public recordRejection(nodeId: string, reason: string, atHop: number): void {
    this.recentRejections.push({ nodeId, reason, atHop });
    if (this.recentRejections.length > MAX_RECENT_REJECTIONS) this.recentRejections.shift();
  }

  /** Records the user's original question so it can be echoed in every working-memory snapshot. */
  public setUserQuestion(q: string): void {
    this.userQuestion = q;
  }

  /** The user's original question, as captured at session start. */
  public getUserQuestion(): string {
    return this.userQuestion;
  }

  /** Records the AI-composed mission brief — a distilled narrative of intent + filters + scope delivered every hop. Survives sliding-memory wipes. */
  public setMissionBrief(brief: string): void {
    this.missionBrief = brief;
  }

  /** The mission brief the AI composed at discovery→active transition. */
  public getMissionBrief(): string {
    return this.missionBrief;
  }

  /** Records the user-stated analysis constraints that no filter field expresses. */
  public setScopeNotes(notes: readonly string[]): void {
    this.scopeNotes = [...notes];
  }

  /** User-stated constraints carried verbatim to every hop. */
  public getScopeNotes(): string[] {
    return [...this.scopeNotes];
  }

  /** Stores the technical findings for a single node in the detail archive. */
  public storeDetail(
    node: LineageNode,
    sections: CapturedSection[],
    summary: string,
    meta?: { badge_label?: string; incoming_questions?: readonly IncomingQuestion[] },
    debugLog?: (message: string) => void,
  ): void {
    const previous = this.detailSlots.get(node.id);
    const earlier = previous?.sections ?? [];
    if (previous) {
      const replaced = ([
        ['summary', previous.summary, summary],
        ['badge_label', previous.badge_label, meta?.badge_label],
      ] as const).filter(([, before, after]) => before !== after).map(([field]) => field);
      if (replaced.length > 0) {
        debugLog?.(`[Memory] revisit replaced ${replaced.join(',')} — node=${node.id}`);
      }
    }
    const questions = appendUniqueQuestions(previous?.incoming_questions ?? [], meta?.incoming_questions ?? []);
    this.detailSlots.set(node.id, {
      nodeId: node.id,
      schema: node.schema,
      name: node.name,
      type: node.type,
      sections: appendUniqueSections(earlier, sections, node.id, debugLog),
      summary,
      badge_label: meta?.badge_label,
      ...(questions.length > 0 ? { incoming_questions: questions } : {}),
    });
  }

  /** Capture angles already archived for `nodeId` from an earlier visit, read before this submission's own sections are merged in by {@link storeDetail}. */
  public getArchivedAngles(nodeId: string): Set<CaptureAngle> {
    return new Set(this.detailSlots.get(nodeId)?.sections.map(s => s.angle) ?? []);
  }

  /** Produces the working-memory snapshot delivered to the model this hop. */
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

  /** Returns the full detail archive for the synthesis phase. */
  public getResult(): { detail_slots: DetailSlot[] } {
    return { detail_slots: Array.from(this.detailSlots.values()) };
  }

  /** JSON snapshot embedded in the engine checkpoint (state dump and saved run). */
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

  /** Rehydrates a manager from a {@link toJSON} snapshot. */
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

  /** Replaces this manager's contents with a validated persisted snapshot. */
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

  /** Returns the last {@link RECENT_SUMMARY_WINDOW} node summaries for injection into the per-hop user message's `<short_term_memory>` block. */
  public getShortTermMemory(): Array<{ nodeId: string; summary: string }> {
    return Array.from(this.detailSlots.values())
      .slice(-RECENT_SUMMARY_WINDOW)
      .map(s => ({ nodeId: s.nodeId, summary: s.summary }));
  }

  /** Returns the recent-rejection ring (max {@link MAX_RECENT_REJECTIONS}) for injection into the active worker prompt so the model can self-correct from prior rejected hops. */
  public getRecentRejections(): Array<{ nodeId: string; reason: string; atHop: number }> {
    return this.recentRejections.slice();
  }
}
