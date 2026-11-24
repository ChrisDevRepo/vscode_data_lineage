import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type Graph from 'graphology';
import {
  modelAssistantMessage,
  modelUserMessage,
  type ModelMessage,
} from '../model/modelPort';
import type { DatabaseModel } from '../../engine/types';
import { getGlobalSingleton } from '../../utils/globalSingleton';
import type { SerializedFilterState } from '../../engine/projectStore';
import { ColumnStore } from '../../engine/columnStore';
import { AiMemoryManager } from '../session/memoryManager';
import { type ResultGraph, type AiOutputTemplates, type AiOutputSections, type PresentationArtifact, type DiscoveryScopeArtifact, EMPTY_AI_TEMPLATES, EMPTY_AI_SECTIONS } from '../session/types';
import type { IHopStateMachine } from '../sm/smBase';
import type { HopLogEntry, NavigationInitParams, ScopeSummary, SmResult } from '../sm/smTypes';
import type { SessionPhase, PendingGate } from '../session/sessionPhase';
import { ClassificationSchema, type ClassificationValue } from '../session/classification';
import { contextBlockBytes, storedEvidenceKindBytes, type TurnTokenBudget } from '../support/tokenBudget';
import { RepairDraftStore } from '../support/repairDraftStore';
import { readToolError, type ToolRejection } from '../support/toolErrorEnvelope';
import { sanitizeForLog, trunc } from '../../utils/log';
import type { PresentResultInput, PresentResultRepairAuthorization } from '../tools/presentResult';
import type { LmStage } from '../tools/toolPolicy';

/** Reviewable exploration proposal. It has no active engine authority until approval. */
export interface PendingExplorationProposal {
  /** Monotonic revision, incremented on every stored proposal and checked at activation. */
  readonly revision: number;
  /** Fully resolved exploration parameters the engine initializes from on approval. */
  readonly init: NavigationInitParams;
  /** Gate-locked mission-type classification carried with the proposal. */
  readonly classification: ClassificationValue;
  /** Serialized user filter snapshot the proposal's scope was computed against. */
  readonly activeFilter: SerializedFilterState;
  /** Post-filter scope snapshot rendered at the approval gate. */
  readonly summary: ScopeSummary;
  /** The discovery-to-hop handoff memo composed for this exact revision; absent until attached. */
  readonly discoverySummary?: string;
}

/** Serializes a JSON value with keys sorted at every level, so key order cannot affect equality. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val);
}

/** Structural equality for two fully merged, validated exploration proposals. */
export function sameExplorationProposal(
  left: Omit<PendingExplorationProposal, 'revision' | 'discoverySummary'>,
  right: PendingExplorationProposal | Omit<PendingExplorationProposal, 'revision'>,
): boolean {
  const { revision: _revision, discoverySummary: _discoverySummary, ...rightRest } = right as PendingExplorationProposal;
  return canonicalJson(left) === canonicalJson(rightRest);
}

/**
 * Result of a turn-guarded session write ({@link AiSession.enterExploring} and siblings).
 * `accepted`: committed. `dropped_stale_turn`: the epoch belonged to a superseded turn (a "zombie"
 * that outlived its awaited promise); the caller must not treat the write as applied and should
 * surface the drop at DEBUG.
 */
export type SessionWriteOutcome =
  | { kind: 'accepted' }
  | { kind: 'dropped_stale_turn'; op: string; captured: number; current: number };

/** One recorded sliding-memory wipe: what fired it, at which hop, how much history it dropped. */
interface MemoryWipeEvent {
  /**
   * Only `sliding` exists: the graph swaps history for a continuation anchor after an accepted hop.
   */
  kind: 'sliding';
  trigger: string;
  hop: number;
  /** Threaded message count discarded by the wipe. */
  messagesBefore: number;
}

/** Outcome of attempting to start or resume a navigation engine session. */
export type ExplorationActivationOutcome =
  | { kind: 'accepted'; engine: IHopStateMachine }
  | { kind: 'dropped_stale_turn'; op: string; captured: number; current: number }
  | { kind: 'rejected'; reason: string };

/**
 * Maximum accepted discovery observations retained in one live session — a *count* bound, so a long
 * discovery walk cannot grow the retained set even when every result is individually small.
 */
const MAX_DISCOVERY_EVIDENCE_OBSERVATIONS = 24;
/*
 * Byte bounds for the discovery-evidence message, one evidence item, and the replayed transcript
 * live in `support/tokenBudget.ts` (`contextBlockBytes()`, `storedEvidenceKindBytes()`).
 */
/**
 * Maximum complete canonical discovery turns retained in one live session — bounds cross-turn
 * history by turn count, independently of how large any single turn is.
 */
const MAX_DISCOVERY_TRANSCRIPT_TURNS = 20;

/** Provider-neutral accepted discovery result eligible for cross-turn grounding. */
export interface DiscoveryEvidenceObservation {
  /** Name of the graph-owned tool that produced the result. */
  readonly toolName: string;
  /** Serialized JSON result text accepted as evidence. */
  readonly result: string;
}

/** Bounded accepted discovery evidence kept for cross-turn grounding, parsed JSON as-is. */
interface RetainedDiscoveryEvidence {
  /** Name of the graph-owned tool that produced the result. */
  readonly toolName: string;
  /** Parsed JSON result accepted as evidence. */
  readonly result: unknown;
}

/** One canonical user/final-assistant exchange retained in the bounded discovery transcript. */
type DiscoveryTranscriptTurn = readonly [
  { readonly role: 'user'; readonly content: string },
  { readonly role: 'assistant'; readonly content: string },
];

function renderDiscoveryTranscript(turns: readonly DiscoveryTranscriptTurn[]): string {
  return JSON.stringify(turns.flat());
}

/**
 * Encapsulates the state and lifecycle of a single AI-driven lineage investigation.
 *
 * @remarks
 * Sessions are strictly isolated to prevent cross-project or cross-user context leakage.
 */
export class AiSession {
  /** Unique session identifier for log correlation and telemetry. */
  public id: string;
  /**
   * Identifier of the exploration approved in this chat, or `null` before the first approval.
   * Minted at {@link activatePendingExploration} (the sole engine publisher), cleared by
   * {@link resetExploration}. Distinguishes bookmarked runs sharing one chat session id; a
   * discovery-turn render with no approved exploration falls back to {@link id}.
   */
  public explorationRunId: string | null = null;
  /** Count of explorations approved in this chat; the suffix that makes each run id unique. */
  private explorationCounter = 0;
  /** Orchestrates short-term narrative and long-term technical memory. */
  public readonly memory: AiMemoryManager;

  /** The current database model (nodes/edges) extracted from DDL. */
  public model: DatabaseModel | null = null;
  /** Topology-only graph used for AI navigation. */
  public graph: Graph | null = null;
  public filter: SerializedFilterState | null = null;
  /** The name or ID of the language model active for the current turn. */
  public modelName?: string;
  /**
   * Unified GUI state snapshot from the webview's `filter-changed` message, validated at the
   * bridge against `UiStateSnapshotSchema` in
   * [`bridgeContract.ts`](../engine/shared/bridgeContract.ts); readers stay defensive because
   * non-bridge writers may seed it.
   */
  public uiState: unknown = null;
  /** Trace-mode snapshot lifted from `uiState.trace`; no host consumer beyond debug dumps. */
  public traceState: unknown = null;
  /**
   * Render-state snapshot from the webview's `render-state` message, validated at the bridge
   * against `RenderStateSnapshotSchema` and consumed by the screen-state presenter.
   */
  public renderState: unknown = null;
  public graphMode: 'full' | 'overview' = 'full';
  /** \>0 when the render limit was exceeded (from webview). */
  public renderLimitHit = 0;
  public parseRulesLabel = 'built-in rules';
  /** Human-readable label for the data source origin (filename or server/db). */
  public sourceLabel = 'N/A';
  /** Statistics from the last SQL parsing run. */
  public parseStats: { resolvedEdges: number; parsedRefs: number; droppedRefs: number } | null = null;
  public projectName: string | null = null;
  /** Persistent identifier for the current project. */
  public currentProjectId: string | null = null;
  /** Indicates if the session is connected to a live database (enables Stats). */
  public isDbSession = false;
  /** Cache for column-level metadata and profiling results. */
  public columnStore: ColumnStore;

  /** The active state machine controlling the exploration loop (hop-by-hop). */
  public stateMachine: IHopStateMachine | null = null;
  /** Latest AI/user-refined proposal awaiting approval; never an active RuntimeFrame. */
  public pendingExploration: PendingExplorationProposal | null = null;
  public resultGraph: ResultGraph | null = null;
  /**
   * Latest bounded discovery scope from `lineage_get_scope_bundle`; backs
   * {@link settleDiscoveryTurn}.
   */
  public discoveryScopeArtifact: DiscoveryScopeArtifact | null = null;
  /** Latest validated presentation, retained for graph replay without another model call. */
  public presentationArtifact: PresentationArtifact | null = null;
  /** Exact LangGraph tool stage; the dispatcher must not infer it from the session phase. */
  public activeLmStage: LmStage | null = null;
  /**
   * Last `present_result` description string — consumed by `dataLineageViz.aiCreateView`
   * when re-posting the AI preview to the webview so the narrative survives panel reveal.
   */
  public get lastPresentResultDescription(): string | null { return this.presentationArtifact?.aiMetadata.description ?? null; }
  /**
   * Last `present_result` headline summary — emitted to chat after presentation so the user
   * sees an answer to their original question without opening the description overlay.
   */
  public get lastPresentResultSummary(): string | null { return this.presentationArtifact?.aiMetadata.summary ?? null; }
  /**
   * `true` when `present_result` was successfully invoked in the current turn.
   *
   * @remarks
   * Reset at turn start; set true on a successful `present_result` call. The presentation node and
   * "Show in Graph" gate read it so a graph is announced only when one was actually built.
   */
  private _presentResultCalledThisTurn = false;
  /** Whether a `present_result` call succeeded in the current turn. */
  public get presentResultCalledThisTurn(): boolean { return this._presentResultCalledThisTurn; }
  private _presentResultAutoDispatched = false;
  /** Whether the successful presentation was auto-dispatched to the webview panel this turn. */
  public get presentResultAutoDispatched(): boolean { return this._presentResultAutoDispatched; }
  /** Number of `present_result` tool invocations observed in the current turn. */
  private _presentResultAttemptCountThisTurn = 0;
  /** Count of `present_result` invocations observed in the current turn. */
  public get presentResultAttemptCountThisTurn(): number { return this._presentResultAttemptCountThisTurn; }
  /**
   * Number of failed `present_result` invocations in the current turn.
   *
   * @remarks
   * Incremented when `present_result` returns a structured failure envelope or throws.
   */
  private _presentResultFailureCountThisTurn = 0;
  /** Count of failed `present_result` invocations in the current turn. */
  public get presentResultFailureCountThisTurn(): number { return this._presentResultFailureCountThisTurn; }
  private _presentResultLastFailureReasonThisTurn: string | null = null;
  /** Last `present_result` failure reason captured in the current turn; `null` when none failed. */
  public get presentResultLastFailureReasonThisTurn(): string | null { return this._presentResultLastFailureReasonThisTurn; }
  /** Held full `present_result` draft for narrow patch-only synthesis repair. */
  public readonly presentResultRepairDraft = new RepairDraftStore<
    PresentResultInput,
    PresentResultRepairAuthorization
  >();

  /** Fields the held `present_result` repair draft lets a resend patch, or `null` if none. */
  public get presentResultRepairFields(): PresentResultRepairAuthorization['fields'] | null {
    return this.presentResultRepairDraft.getAuthorization()?.fields ?? null;
  }

  /** Highlight label indexes authorized for leaf-only repair, or `null` for ordinary repair. */
  public get presentResultRepairHighlightLabelIndexes(): readonly number[] | null {
    return this.presentResultRepairDraft.getAuthorization()?.highlightLabelIndexes ?? null;
  }

  /** Held section text leaves authorized for indexed repair, or `null` for ordinary repair. */
  public get presentResultRepairSectionTextLeaves(): PresentResultRepairAuthorization['sectionTextLeaves'] | null {
    return this.presentResultRepairDraft.getAuthorization()?.sectionTextLeaves ?? null;
  }

  /**
   * Reason the current turn's synthesis rendered the model's held text without a working
   * preview/panel step, or `null` when the last render was clean. Set by
   * {@link markSynthesisRenderDegraded}; read and cleared once by the chat host's one-shot
   * warning toast via {@link consumeSynthesisRenderDegraded}.
   */
  private _synthesisRenderDegradedReason: string | null = null;

  /** Records that a synthesis terminal path rendered the held text without a render step. */
  public markSynthesisRenderDegraded(reason: string): void {
    this._synthesisRenderDegradedReason = reason;
  }

  /**
   * Clears a render-degraded mark that a preview delivery set, leaving a mark from any other cause.
   *
   * @remarks The latest present's delivery outcome decides: a post that went through (or a deferred
   *   one) supersedes an earlier failed post of the same turn.
   */
  public clearPreviewDeliveryDegraded(): void {
    if (this._synthesisRenderDegradedReason === 'preview_post_failed'
      || this._synthesisRenderDegradedReason === 'preview_dispatch') {
      this._synthesisRenderDegradedReason = null;
    }
  }

  /** Peeks the render-degraded reason without clearing it; the synthesis chat line reads it. */
  public get synthesisRenderDegradedReason(): string | null {
    return this._synthesisRenderDegradedReason;
  }

  private readonly _closingNotices = new Map<string, string>();

  /**
   * Queues a user-visible notice for the turn's closing markdown, once per `key`. VS Code folds
   * every response part before a completed response's last markdown into a collapsed disclosure, so
   * a notice streamed ahead of the answer is never seen; notices wait until the answer-writing node
   * takes them with {@link takeClosingNotices}.
   */
  public queueClosingNotice(key: string, notice: string): void {
    if (!this._closingNotices.has(key)) this._closingNotices.set(key, notice);
  }

  /** Returns the queued notices as markdown paragraphs in queue order, and clears the queue. */
  public takeClosingNotices(): string {
    const notices = [...this._closingNotices.values()].map(notice => `\n\n${notice}`).join('');
    this._closingNotices.clear();
    return notices;
  }

  /** Returns and clears the render-degraded reason; call once, from the one-shot toast site. */
  public consumeSynthesisRenderDegraded(): string | null {
    const reason = this._synthesisRenderDegradedReason;
    this._synthesisRenderDegradedReason = null;
    return reason;
  }

  /**
   * Origin node id of the most recent discovery walk. Captured by {@link settleDiscoveryTurn} from
   * a scope of 2+ nodes or 2+ distinct `lineage_get_object_detail` reads; seeds
   * `lineage_start_exploration` from the post-discovery SM-offer pill without re-asking. Cleared in
   * {@link resetExploration}.
   */
  public lastDiscoveryOrigin: string | null = null;

  /**
   * Nodes in the most recent discovery walk: the walked scope's size, or the distinct objects read
   * with `lineage_get_object_detail`. The SM-offer follow-up pill renders when this count is ≥ 2.
   */
  public lastDiscoveryWalkCount = 0;

  /**
   * The user's verbatim discovery-turn prompt — stored so the
   * post-approval discovery-summary composition round can lift it
   * into `mission_brief` / `discoverySummary`. Cleared in {@link resetExploration}.
   */
  public lastDiscoveryQuestion: string | null = null;

  /**
   * Verbatim prompt of the current turn, set at run start by the agent runtime. Host-seeded marker
   * prompts (trace re-entry) are not stored; those flows use {@link lastDiscoveryQuestion}.
   * Read by `start_exploration` to anchor the canonical question to user-authored text for direct
   * free-text entry, not the model's paraphrase.
   */
  public currentTurnPrompt: string | null = null;

  /**
   * The AI's discovery-turn final chat answer (Markdown). Recorded by
   * {@link settleDiscoveryTurn} when the discover loop ends. Read
   * by the post-approval discovery-summary composition round so the
   * compressed memo can cite the headline finding the AI already wrote.
   * Cleared in {@link resetExploration}.
   */
  public lastDiscoveryAnswer: string | null = null;
  /** Count- and byte-bounded canonical user/final-assistant discovery turns. */
  private discoveryTranscript: DiscoveryTranscriptTurn[] = [];
  /** Bounded accepted tool evidence, independent of provider-native transcript shapes. */
  private discoveryEvidence: RetainedDiscoveryEvidence[] = [];

  /**
   * Mission-type classification inferred at end of discovery; drives which subsections fire at
   * synthesis (`business` omits Technical, `technical` renders only technical, `both` both).
   * `undefined` until resolved.
   */
  public classification?: ClassificationValue;
  /** YAML-loaded instructions for report generation. */
  public outputTemplates: AiOutputTemplates;
  /** Section labels declared by the capture recipes; synthesis serves the active angle's list. */
  public outputSections: AiOutputSections;

  /** Sequential log of tool calls and results for the current exploration. */
  public hopLog: HopLogEntry[] = [];
  /**
   * Per-wipe detail for this turn — the memory-leak waste basis the analytics layer needs.
   * Each entry records WHY a wipe fired and how many threaded messages it discarded, so a
   * regression in the sliding-wipe model (history growing instead of being replaced) is visible
   * per-wipe in telemetry, not just as an aggregate count.
   */
  private _memoryWipeEventsThisTurn: MemoryWipeEvent[] = [];
  /** Read-only per-wipe memory diagnostics recorded in the current turn. */
  public get memoryWipeEventsThisTurn(): ReadonlyArray<MemoryWipeEvent> { return this._memoryWipeEventsThisTurn; }

  /** Unix timestamp of session creation. Pinned at creation; used for result-graft windowing. */
  public startTime: number;
  /**
   * Total tool execution rounds: an engine-derived shadow copy for UI/telemetry, mirrored from
   * `engine.getHopDiagnostics().hop` after each hop. The {@link NavigationEngine} is the source of
   * truth; never branch control flow on this field.
   */
  public hopCount = 0;
  /** Monotonic round id incremented by the host runtime for same-round serial-tool guards. */
  public currentRoundId = 0;
  /** Round id in which start_exploration last succeeded (or was attempted). null when reset. */
  public startExplorationRoundId: number | null = null;

  /** Set-keyed notice queue to deduplicate messages across parallel tool calls. */
  public pendingUserNotice: Set<string> = new Set();

  /**
   * Current finite-state-machine phase, persisted across chat turns. LangGraph routes discovery,
   * exploration, synthesis and completed follow-ups from `phase.kind`. Transition only through
   * {@link enterGate}, {@link enterExploring}, {@link enterIdle} and {@link enterCompleted}; never
   * assign directly.
   */
  public phase: SessionPhase = { kind: 'idle' };

  /**
   * Monotonic turn-ownership epoch. Bumped once per turn by {@link beginTurn} and captured by that
   * turn's runtime; every guarded phase/result write carries the captured value so a superseded
   * "zombie" turn cannot mutate the session a newer turn now owns.
   */
  private _turnEpoch = 0;

  /** The live turn-ownership epoch (see {@link beginTurn}); valid for the current turn's writes. */
  public get turnEpoch(): number {
    return this._turnEpoch;
  }

  /**
   * Opens a new turn: bumps and returns the turn-ownership epoch the caller threads into this
   * turn's guarded session writes. The only site that bumps {@link turnEpoch};
   * {@link resetExploration} deliberately does not, since a bump there would strand a running
   * turn's epoch and turn its later writes into dropped-stale no-ops.
   */
  public beginTurn(): number {
    this._turnEpoch += 1;
    return this._turnEpoch;
  }

  /**
   * Guards a turn-scoped write: accepts only while {@link token} still matches the live
   * {@link turnEpoch}, otherwise reports the write as a dropped stale-turn no-op.
   *
   * @param token - The epoch captured by the calling turn.
   * @param op - The write's name, echoed in the drop outcome for the caller's DEBUG line.
   */
  private guardTurnWrite(token: number, op: string): SessionWriteOutcome {
    if (token !== this._turnEpoch) {
      return { kind: 'dropped_stale_turn', op, captured: token, current: this._turnEpoch };
    }
    return { kind: 'accepted' };
  }

  constructor(templates?: AiOutputTemplates, sections?: AiOutputSections) {
    this.id = this.generateId();
    this.memory = new AiMemoryManager();
    this.columnStore = new ColumnStore();
    this.outputTemplates = templates ?? { ...EMPTY_AI_TEMPLATES };
    this.outputSections = sections ?? EMPTY_AI_SECTIONS;
    this.startTime = Date.now();
  }

  private generateId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  }

  private resetPresentResultLifecycle(): void {
    this.presentationArtifact = null;
    this.resetPresentResultTurnState();
  }

  /**
   * Resets every turn-scoped `present_result` field. The cross-turn artifact archive
   * (`presentationArtifact`) deliberately survives — completed-phase follow-ups reuse it.
   */
  private resetPresentResultTurnState(): void {
    this._presentResultCalledThisTurn = false;
    this._presentResultAutoDispatched = false;
    this._presentResultAttemptCountThisTurn = 0;
    this._presentResultFailureCountThisTurn = 0;
    this._presentResultLastFailureReasonThisTurn = null;
    this.presentResultRepairDraft.clear();
    this._synthesisRenderDegradedReason = null;
  }

  private resetMemoryWipeDiagnostics(): void {
    this._memoryWipeEventsThisTurn = [];
  }

  /**
   * Clears all exploration-specific state while preserving environment metadata.
   *
   * @remarks
   * Delegates phase transition to {@link enterIdle}; callers should not touch
   * `phase` directly.
   */
  public resetExploration(): void {
    this.memory.reset();
    this.stateMachine = null;
    this.explorationRunId = null;
    this.pendingExploration = null;
    this.resultGraph = null;
    this.discoveryScopeArtifact = null;
    this.resetPresentResultLifecycle();
    this.hopCount = 0;
    this.hopLog = [];
    this.resetMemoryWipeDiagnostics();
    this.pendingUserNotice.clear();
    this.startExplorationRoundId = null;
    this.enterIdle(this._turnEpoch);
    this.classification = undefined;
    this.lastDiscoveryOrigin = null;
    this.lastDiscoveryWalkCount = 0;
    this.lastDiscoveryQuestion = null;
    this.lastDiscoveryAnswer = null;
  }

  /**
   * Resets per-turn bookkeeping at the start of every chat turn: a held `present_result` repair
   * draft, its single-shot flags and the per-turn wipe counters must not outlive a turn.
   * {@link resetExploration} does not run on every exit path (a synthesis abort's bare `fail()` in
   * `graph.ts` skips it), so this is the guaranteed turn-boundary clear `LineageRuntime.run` calls
   * once.
   */
  public beginTurnState(): void {
    this.resetMemoryWipeDiagnostics();
    this.resetPresentResultTurnState();
    this._bufferedFollowUpProse = null;
    this._closingNotices.clear();
  }

  /**
   * Newest follow-up prose held back by `proseGate: 'buffer-until-tool'`, turn-scoped. The gate
   * suppresses prose until its paired tool call is known good and a rejected call discards it even
   * if the prose already answered; holding it here lets the terminal path still deliver it. Each
   * new generation supersedes the last.
   */
  private _bufferedFollowUpProse: string | null = null;
  /** The newest buffered follow-up prose, or null when this turn produced none. */
  public get bufferedFollowUpProse(): string | null { return this._bufferedFollowUpProse; }
  /** Holds one generation's suppressed prose, replacing any earlier; blank text clears nothing. */
  public bufferFollowUpProse(text: string): void {
    if (text.trim().length > 0) this._bufferedFollowUpProse = text;
  }

  /** Enters the exact tool-policy stage for one model call. */
  public enterLmStage(stage: LmStage, token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterLmStage');
    if (guard.kind === 'accepted') this.activeLmStage = stage;
    return guard;
  }

  /** Clears the tool-policy stage after the owning model call settles. */
  public leaveLmStage(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'leaveLmStage');
    if (guard.kind === 'accepted') this.activeLmStage = null;
    return guard;
  }

  /** Stores one canonical scope artifact if the producing turn still owns the session. */
  public storeDiscoveryScope(artifact: DiscoveryScopeArtifact, token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'storeDiscoveryScope');
    if (guard.kind === 'accepted') this.discoveryScopeArtifact = artifact;
    return guard;
  }

  /**
   * Settles the post-discovery offers once a discovery turn has its answer. A scope of 2+ nodes
   * walked this turn, else a detail walk of 2+ objects, becomes the recorded discovery seeding the
   * "Start deeper hop-by-hop analysis" offer and `lineage_start_exploration`. A turn that read the
   * catalog without walking a scope answered about something the stored scope does not show, so
   * that scope is dropped. A direct answer (nothing read)
   * changes neither. Cleared in {@link resetExploration}.
   *
   * @param detailWalk - The turn's multi-object detail walk, or `null`.
   * @param readCatalog - Whether the turn accepted any tool observation.
   */
  public settleDiscoveryTurn(
    token: number,
    question: string,
    answer: string,
    detailWalk: { readonly origin: string; readonly walkCount: number } | null,
    readCatalog: boolean,
  ): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'settleDiscoveryTurn');
    if (guard.kind !== 'accepted') return guard;
    const scope = this.discoveryScopeArtifact?.turnEpoch === token ? this.discoveryScopeArtifact : null;
    const walk = scope && scope.nodeIds.length >= 2
      ? { origin: scope.origin, walkCount: scope.nodeIds.length }
      : detailWalk;
    if (walk) {
      this.lastDiscoveryOrigin = walk.origin;
      this.lastDiscoveryWalkCount = walk.walkCount;
      this.lastDiscoveryQuestion = question;
      this.lastDiscoveryAnswer = answer;
    }
    if (readCatalog && !(scope && scope.nodeIds.length >= 2)) this.discoveryScopeArtifact = null;
    return guard;
  }

  /**
   * Whether the post-discovery SM-offer may render (idle phase, multi-object walk with an origin).
   * The single predicate for every surface rendering the offer; do not restate its conditions at a
   * render site. An oversized scope never reaches it: the discovery budget guard routes that turn
   * into SM entry and the consent gate.
   */
  public smOfferAvailable(): boolean {
    return this.phase.kind === 'idle'
      && Boolean(this.lastDiscoveryOrigin)
      && this.lastDiscoveryWalkCount >= 2;
  }

  /**
   * Appends canonical conversation text and bounded accepted discovery evidence. Provider-native
   * tool calls and `tool` messages are never retained; evidence is accepted only as valid JSON from
   * a successful graph-owned observation. Oldest evidence and transcript turns are evicted first on
   * their byte/count bounds; every eviction or drop is normalize-with-log via `debugLog` when
   * supplied.
   *
   * @param budget - Budget of the turn that produced the messages (the session is shared by every
   *   turn).
   * @param debugLog - Debug sink for a normalized eviction/drop; the session holds no logger of its
   *   own.
   */
  public appendDiscoveryTurn(
    budget: TurnTokenBudget,
    turnMessages: readonly ModelMessage[],
    observations: readonly DiscoveryEvidenceObservation[] = [],
    debugLog?: (message: string) => void,
  ): void {
    let user: string | null = null;
    let assistant: string | null = null;
    for (const message of turnMessages) {
      if (
        HumanMessage.isInstance(message)
        && typeof message.content === 'string'
        && user === null
      ) user = message.content;
      if (
        AIMessage.isInstance(message)
        && typeof message.content === 'string'
        && user !== null
      ) assistant = message.content;
    }
    if (user !== null && assistant !== null) {
      this.discoveryTranscript.push([
        { role: 'user', content: user },
        { role: 'assistant', content: assistant },
      ]);
      while (this.discoveryTranscript.length > MAX_DISCOVERY_TRANSCRIPT_TURNS
        || Buffer.byteLength(renderDiscoveryTranscript(this.discoveryTranscript), 'utf8') > contextBlockBytes(budget)) {
        this.discoveryTranscript.shift();
        debugLog?.(`[AI] [Discovery] oldest transcript turn evicted — turnsRemaining=${this.discoveryTranscript.length} cap=${MAX_DISCOVERY_TRANSCRIPT_TURNS}`);
      }
    }
    for (const observation of observations) {
      const toolName = observation.toolName ? trunc(sanitizeForLog(observation.toolName), 64) : '(missing)';
      if (!observation.toolName) {
        debugLog?.(`[AI] [Discovery] evidence observation dropped — tool=${toolName} reason=missing_tool_name`);
        continue;
      }
      const resultBytes = Buffer.byteLength(observation.result, 'utf8');
      if (resultBytes > storedEvidenceKindBytes(budget)) {
        debugLog?.(`[AI] [Discovery] evidence observation dropped — tool=${toolName} reason=oversized bytes=${resultBytes} cap=${storedEvidenceKindBytes(budget)}`);
        continue;
      }
      let result: unknown;
      try {
        result = JSON.parse(observation.result);
      } catch {
        debugLog?.(`[AI] [Discovery] evidence observation dropped — tool=${toolName} reason=unparseable`);
        continue;
      }
      if (result === null || typeof result !== 'object') {
        debugLog?.(`[AI] [Discovery] evidence observation dropped — tool=${toolName} reason=not_an_object`);
        continue;
      }
      if (readToolError(result)) {
        debugLog?.(`[AI] [Discovery] evidence observation dropped — tool=${toolName} reason=error_envelope`);
        continue;
      }
      this.discoveryEvidence.push({ toolName: observation.toolName, result });
      while (this.discoveryEvidence.length > MAX_DISCOVERY_EVIDENCE_OBSERVATIONS
        || Buffer.byteLength(this.renderDiscoveryEvidence(), 'utf8') > contextBlockBytes(budget)) {
        const evicted = this.discoveryEvidence.shift();
        debugLog?.(`[AI] [Discovery] oldest evidence observation evicted — tool=${evicted ? trunc(sanitizeForLog(evicted.toolName), 64) : '(unknown)'} remaining=${this.discoveryEvidence.length}`);
      }
    }
  }

  /**
   * Returns prior canonical conversation plus one bounded provider-neutral evidence projection.
   *
   * @returns The accumulated prior-turn messages, oldest first; empty on the first turn.
   */
  public getDiscoveryHistory(): ModelMessage[] {
    const transcript = this.discoveryTranscript.flatMap((turn) => [
      modelUserMessage(turn[0].content),
      modelAssistantMessage(turn[1].content),
    ]);
    const evidence = this.renderDiscoveryEvidence();
    return evidence
      ? [...transcript, modelUserMessage(evidence)]
      : transcript;
  }

  /**
   * Clears cross-turn discovery memory: on model/project (re)load, on a new native chat, and after
   * every turn that supplied native history (which then owns cross-turn conversation). Never on SM
   * start.
   */
  public clearDiscoveryTranscript(): void {
    this.discoveryTranscript = [];
    this.discoveryEvidence = [];
  }

  /** Renders the accepted-evidence projection without provider call ids or transcript roles. */
  private renderDiscoveryEvidence(): string {
    if (this.discoveryEvidence.length === 0) return '';
    return JSON.stringify({ kind: 'accepted_discovery_evidence', observations: this.discoveryEvidence });
  }

  /**
   * Stores the mission-type classification inferred at end of discovery. Zod-validated at the
   * boundary; invalid values are rejected mechanically.
   */
  public setClassification(value: ClassificationValue): void {
    this.classification = ClassificationSchema.parse(value);
  }

  /**
   * Returns the gate-locked classification required by active and synthesis model calls. A missing
   * classification after approval is corrupted runtime state, not a reason to guess `business`;
   * failing before instruction-plan compilation leaves model call and engine state unchanged and
   * makes drift observable.
   *
   * @throws When no classification has been approved for the current exploration.
   */
  public requireLockedClassification(): ClassificationValue {
    if (!this.classification) {
      throw new Error('AiSession: active exploration requires a locked classification.');
    }
    return ClassificationSchema.parse(this.classification);
  }

  /**
   * Transitions into `awaiting_gate`: the engine paused on a consent gate and the next user turn
   * must resolve it (yes / no / redirect). Discovery context (`lastDiscoveryOrigin` and siblings)
   * is left intact because the post-approval summary composition reads it; on cancel
   * {@link resetExploration} clears it. A stale `token` (see {@link beginTurn}) drops the write
   * ({@link SessionWriteOutcome}).
   */
  public enterGate(gate: PendingGate, token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterGate');
    if (guard.kind !== 'accepted') return guard;
    this.phase = { kind: 'awaiting_gate', gate };
    return guard;
  }

  /** Replaces the reviewable proposal without creating or publishing an exploration engine. */
  public storePendingExploration(
    proposal: Omit<PendingExplorationProposal, 'revision'>,
    token: number,
  ): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'storePendingExploration');
    if (guard.kind !== 'accepted') return guard;
    this.pendingExploration = {
      ...proposal,
      revision: (this.pendingExploration?.revision ?? 0) + 1,
    };
    return guard;
  }

  /**
   * Attaches the composed discovery-handoff memo to the pending proposal at `revision`. Runs after
   * {@link storePendingExploration}. A no-op when the proposal has moved past `revision`
   * (superseded by a refine mid-composition); the caller omits the memo rather than failing.
   */
  public attachDiscoverySummary(revision: number, text: string, token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'attachDiscoverySummary');
    if (guard.kind !== 'accepted') return guard;
    if (this.pendingExploration && this.pendingExploration.revision === revision) {
      this.pendingExploration = { ...this.pendingExploration, discoverySummary: text };
    }
    return guard;
  }

  /** Cancels proposal review without discarding a completed engine/result on the session. */
  public cancelPendingExploration(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'cancelPendingExploration');
    if (guard.kind !== 'accepted') return guard;
    this.pendingExploration = null;
    if (this.stateMachine?.status === 'complete' && this.resultGraph) this.enterCompleted(token);
    else this.enterIdle(token);
    return guard;
  }

  /**
   * Atomically validates, constructs, and publishes the exact proposal reviewed at the gate.
   * The factory runs synchronously only after epoch and revision checks pass.
   */
  public activatePendingExploration(
    expectedRevision: number,
    token: number,
    factory: (proposal: PendingExplorationProposal) => IHopStateMachine | ToolRejection,
  ): ExplorationActivationOutcome {
    const guard = this.guardTurnWrite(token, 'activatePendingExploration');
    if (guard.kind !== 'accepted') return guard;
    const proposal = this.pendingExploration;
    if (!proposal) return { kind: 'rejected', reason: 'missing_pending_proposal' };
    if (proposal.revision !== expectedRevision) {
      return { kind: 'rejected', reason: `stale_proposal_revision:${expectedRevision}->${proposal.revision}` };
    }
    const built = factory(proposal);
    if ('code' in built) return { kind: 'rejected', reason: built.code };
    const priorMemory = this.memory.toJSON();
    try {
      const classification = ClassificationSchema.parse(proposal.classification);
      built.publishMemoryTo(this.memory);
      // A new exploration replaces any earlier result; it never extends it.
      this.resultGraph = null;
      this.resetPresentResultLifecycle();
      this.stateMachine = built;
      this.explorationCounter += 1;
      this.explorationRunId = `${this.id}:e${this.explorationCounter}`;
      this.classification = classification;
      this.pendingExploration = null;
      this.enterExploring(token);
      return { kind: 'accepted', engine: built };
    } catch (err) {
      this.memory.restoreFromJSON(priorMemory);
      return { kind: 'rejected', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Transitions the session into `exploring` — the engine is ready to produce the
   * next hop. Called on fresh SM start (post-confirm) and on gate-approved resume.
   *
   * @param token - The calling turn's epoch (see {@link beginTurn}); a stale token drops the write.
   * @returns Whether the transition committed or was dropped as a stale-turn no-op.
   */
  public enterExploring(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterExploring');
    if (guard.kind !== 'accepted') return guard;
    this.phase = { kind: 'exploring' };
    this._presentResultCalledThisTurn = false;
    this._presentResultAutoDispatched = false;
    this.presentResultRepairDraft.clear();
    return guard;
  }

  /**
   * Transitions into `idle`: no exploration active, the next turn enters discovery. Use
   * {@link resetExploration} when exploration state also needs clearing. A stale `token` drops the
   * write ({@link SessionWriteOutcome}).
   */
  public enterIdle(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterIdle');
    if (guard.kind !== 'accepted') return guard;
    this.phase = { kind: 'idle' };
    return guard;
  }

  /**
   * Transitions into `completed`: synthesis finished, the archive survives on the session
   * singleton, and the next user turn routes through follow-up refinement. Call only when
   * `stateMachine?.status === 'complete'`. A stale `token` drops the write
   * ({@link SessionWriteOutcome}).
   */
  public enterCompleted(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterCompleted');
    if (guard.kind !== 'accepted') return guard;
    this.phase = { kind: 'completed' };
    return guard;
  }

  /** Rotates the session identifier and resets the start timer. */
  public regenerateSessionId(): void {
    this.id = this.generateId();
    this.startTime = Date.now();
  }

  /**
   * Starts a new native chat session as one atomic session-owned transition: the established
   * exploration reset plus clearing the bounded discovery transcript
   * ({@link clearDiscoveryTranscript}). `AiMemoryManager` is reset only through
   * {@link resetExploration}.
   */
  public beginNativeChatSession(): void {
    this.regenerateSessionId();
    this.resetExploration();
    this.clearDiscoveryTranscript();
  }

  /**
   * Clears the single-shot `present_result` guard for the current follow-up turn. It persists from
   * synthesis into the completed phase so the chat host can stream the summary afterwards;
   * `followUpNode` clears it at the start of each follow-up turn so a Route A `present_result`
   * adjust fires fresh. Assign only through this method.
   */
  public clearPresentResultFlag(): void {
    this._presentResultCalledThisTurn = false;
    this._presentResultAutoDispatched = false;
  }

  /** Counts one `present_result` call at handler entry, if the calling turn owns the session. */
  public beginPresentResultAttempt(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'beginPresentResultAttempt');
    if (guard.kind !== 'accepted') return guard;
    this._presentResultAttemptCountThisTurn += 1;
    return guard;
  }

  /**
   * Records one failed `present_result` call and its reason, if the calling turn owns the session.
   */
  public recordPresentResultFailure(token: number, reason: string): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'recordPresentResultFailure');
    if (guard.kind !== 'accepted') return guard;
    this._presentResultFailureCountThisTurn += 1;
    this._presentResultLastFailureReasonThisTurn = reason;
    return guard;
  }

  /**
   * Commits a validated presentation (artifact, single-shot success flags) if the turn owns the
   * session.
   */
  public commitPresentResultSuccess(
    token: number,
    artifact: PresentationArtifact,
    autoDispatched = false,
  ): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'commitPresentResultSuccess');
    if (guard.kind !== 'accepted') return guard;
    this.presentationArtifact = artifact;
    this._presentResultCalledThisTurn = true;
    this._presentResultAutoDispatched = autoDispatched;
    this.presentResultRepairDraft.clear();
    return guard;
  }

  /**
   * Maps state-machine output to the `ResultGraph` contract consumed by `present_result` and the
   * webview; `source` reflects the engine's `columnAspect` flag at call time. Body fields
   * (`description`/`summary`/`title`) carry forward from the prior `resultGraph` until a new
   * `present_result` overwrites them, so a supplement round never blanks a rendered result. A stale
   * `token` drops the write ({@link SessionWriteOutcome}).
   */
  public storeSmResult(fullResult: SmResult, token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'storeSmResult');
    if (guard.kind !== 'accepted') return guard;
    const sourceMode = this.stateMachine?.columnAspect ? 'column_trace' : 'blackboard';

    const prior = this.resultGraph;
    this.resultGraph = {
      nodeIds: fullResult.fullNodes.map(n => n.id),
      edges: fullResult.edges,
      source: sourceMode,
      originNodeId: fullResult.originNodeId,
      notes: prior?.notes,
      suggested_sections: fullResult.suggested_sections,
      node_states: fullResult.node_states,
      description: prior?.description,
      summary: prior?.summary,
      title: prior?.title,
      intro: prior?.intro,
      closing: prior?.closing,
      sections: prior?.sections,
      sectionsRunId: prior?.sectionsRunId,
      ...(fullResult.columnAspect ? {
        columnAspect: {
          edges: fullResult.columnAspect.edges,
          },
      } : {}),
    };
    return guard;
  }

  /**
   * The committed report sections a further render of this run may keep instead of resending.
   * Requires sections, an approved exploration behind them, and that run still being the one
   * rendering. A discovery-turn render has no run id and never retains.
   *
   * @returns The retainable sections, or `null` when this render must author its own.
   */
  public retainableReportSections(): NonNullable<ResultGraph['sections']> | null {
    const sections = this.resultGraph?.sections;
    if (!sections?.length || !this.explorationRunId) return null;
    return this.resultGraph?.sectionsRunId === this.explorationRunId ? sections : null;
  }

  /**
   * Mirrors the engine-derived hop count into {@link hopCount} for UI/telemetry. Epoch-guarded: a
   * superseded "zombie" turn must not clobber diagnostics a newer turn owns, so the write lands
   * only while `token` matches the live {@link turnEpoch} ({@link SessionWriteOutcome}).
   */
  public setHopCount(token: number, count: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'setHopCount');
    if (guard.kind !== 'accepted') return guard;
    this.hopCount = count;
    return guard;
  }

  /**
   * Records one per-turn memory wipe and updates its aggregate counter, feeding the analytics
   * per-wipe waste basis ({@link memoryWipeEventsThisTurn}). Epoch-guarded like
   * {@link setHopCount}: a superseded "zombie" turn must not append to the log a newer turn owns.
   */
  public recordMemoryWipeEvent(
    token: number,
    event: MemoryWipeEvent,
  ): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'recordMemoryWipeEvent');
    if (guard.kind !== 'accepted') return guard;
    this._memoryWipeEventsThisTurn.push(event);
    return guard;
  }
}

const GLOBAL_SESSION_KEY = '__VSCODE_DL_AI_SESSION__';

/** The global `AiSession` singleton on `globalThis`, so state spans entry points and tests. */
export function getSession(): AiSession {
  return getGlobalSingleton(GLOBAL_SESSION_KEY, () => new AiSession());
}
