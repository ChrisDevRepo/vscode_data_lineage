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
import { type ResultGraph, type AiOutputTemplates, type PresentationArtifact, type DiscoveryScopeArtifact, EMPTY_AI_TEMPLATES } from '../session/types';
import type { IHopStateMachine } from '../sm/smBase';
import type { HopLogEntry, NavigationInitParams, ScopeSummary, SmResult, SmState } from '../sm/smTypes';
import type { SessionPhase, PendingGate } from '../session/sessionPhase';
import { ClassificationSchema, type ClassificationValue } from '../session/classification';
import { RepairDraftStore } from '../support/repairDraftStore';
import { readToolError } from '../support/toolErrorEnvelope';
import { longestPrefixFitting } from '../support/textTruncation';
import type { PresentResultInput, PresentResultRepairPatch } from '../tools/presentResult';
import type { PresentResultRepairField } from '../tools/toolSchemas';
import type { LmStage } from '../tools/toolPolicy';

/** Reviewable exploration proposal. It has no active engine authority until approval. */
export interface PendingExplorationProposal {
  readonly revision: number;
  readonly init: NavigationInitParams;
  readonly classification: ClassificationValue;
  readonly activeFilter: SerializedFilterState;
  readonly summary: ScopeSummary;
  /** The discovery-to-hop handoff memo composed for this exact revision; absent until attached. */
  readonly discoverySummary?: string;
}

/** Serializes a JSON value with object keys sorted at every level, so key insertion order cannot affect equality. */
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
  // `discoverySummary` is excluded on both sides — it is cached after this comparison runs, so a
  // prior revision's cached memo must never make a genuinely-unchanged refine look "changed".
  const { revision: _revision, discoverySummary: _discoverySummary, ...rightRest } = right as PendingExplorationProposal;
  return canonicalJson(left) === canonicalJson(rightRest);
}

/**
 * Result of a turn-guarded session write ({@link AiSession.enterExploring} and its siblings).
 *
 * @remarks
 * `accepted` — the calling turn still owns the session and the write committed. `dropped_stale_turn`
 * — the write carried an epoch from a turn that has since been superseded (a "zombie" turn that
 * outlived its awaited promise, e.g. a test timeout abandoning it), so it was a no-op and the caller
 * must not treat the transition as applied. Callers that can log surface the drop at DEBUG; none may
 * silently discard the outcome.
 */
export type SessionWriteOutcome =
  | { kind: 'accepted' }
  | { kind: 'dropped_stale_turn'; op: string; captured: number; current: number };

interface MemoryWipeEvent {
  /**
   * Only `sliding` exists: the graph replaces history with a continuation anchor after an accepted
   * hop submission. A second `forced` kind was removed once it proved to have no construction site.
   */
  kind: 'sliding';
  trigger: string;
  hop: number;
  messagesBefore: number;
}

/**
 * Outcome of attempting to start or resume a navigation engine session.
 */
export type ExplorationActivationOutcome =
  | { kind: 'accepted'; engine: IHopStateMachine }
  | { kind: 'dropped_stale_turn'; op: string; captured: number; current: number }
  | { kind: 'rejected'; reason: string };

/**
 * Maximum accepted discovery observations retained in one live session — a *count* bound, so a long
 * discovery walk cannot grow the retained set even when every result is individually small.
 */
export const MAX_DISCOVERY_EVIDENCE_OBSERVATIONS = 24;
/**
 * Maximum UTF-8 bytes retained for one canonical discovery result — held below
 * {@link MAX_DISCOVERY_EVIDENCE_BYTES} so one oversized result cannot consume the whole projection.
 */
export const MAX_DISCOVERY_EVIDENCE_ITEM_BYTES = 61_440;
/**
 * Maximum UTF-8 bytes projected by the complete discovery-evidence message — the 64 KiB prompt-budget
 * ceiling the per-item and per-count bounds exist to keep.
 */
export const MAX_DISCOVERY_EVIDENCE_BYTES = 65_536;
/**
 * Maximum complete canonical discovery turns retained in one live session — bounds cross-turn history
 * by turn count, independently of how large any single turn is.
 */
export const MAX_DISCOVERY_TRANSCRIPT_TURNS = 20;
/**
 * Maximum UTF-8 bytes in the rendered canonical discovery transcript — the same 64 KiB ceiling as
 * evidence, applied to replayed history so the two cannot compound.
 */
export const MAX_DISCOVERY_TRANSCRIPT_BYTES = 65_536;

/** Provider-neutral accepted discovery result eligible for cross-turn grounding. */
export interface DiscoveryEvidenceObservation {
  readonly toolName: string;
  readonly result: string;
}

interface RetainedDiscoveryEvidence {
  readonly toolName: string;
  readonly result: unknown;
}

type DiscoveryTranscriptTurn = readonly [
  { readonly role: 'user'; readonly content: string },
  { readonly role: 'assistant'; readonly content: string },
];

const DISCOVERY_TRUNCATION_MARKER = '…[truncated to discovery memory bound]';

function renderDiscoveryTranscript(turns: readonly DiscoveryTranscriptTurn[]): string {
  return JSON.stringify(turns.flat());
}

function truncateDiscoveryText(text: string, fits: (candidate: string) => boolean): string {
  if (!fits(DISCOVERY_TRUNCATION_MARKER)) return DISCOVERY_TRUNCATION_MARKER;
  const prefix = longestPrefixFitting(text, candidate => fits(`${candidate}${DISCOVERY_TRUNCATION_MARKER}`));
  return `${prefix}${DISCOVERY_TRUNCATION_MARKER}`;
}

function boundDiscoveryTurn(turn: DiscoveryTranscriptTurn): DiscoveryTranscriptTurn {
  const build = (user: string, assistant: string): DiscoveryTranscriptTurn => [
    { role: 'user', content: user },
    { role: 'assistant', content: assistant },
  ];
  const fits = (user: string, assistant: string): boolean =>
    Buffer.byteLength(renderDiscoveryTranscript([build(user, assistant)]), 'utf8') <= MAX_DISCOVERY_TRANSCRIPT_BYTES;
  const user = turn[0].content;
  const assistant = turn[1].content;
  if (fits(user, assistant)) return turn;

  const boundedAssistant = truncateDiscoveryText(assistant, candidate => fits(user, candidate));
  if (fits(user, boundedAssistant)) return build(user, boundedAssistant);
  const boundedUser = truncateDiscoveryText(user, candidate => fits(candidate, boundedAssistant));
  return build(boundedUser, boundedAssistant);
}

/**
 * Encapsulates the state and lifecycle of a single AI-driven lineage investigation.
 *
 * @remarks
 * The `AiSession` acts as a "Clean Slate" for `@lineage` participant interactions.
 * It maintains the grounded database model, the active exploration state machine,
 * and the two-tier memory manager. Sessions are strictly isolated to prevent
 * cross-project or cross-user context leakage.
 */
export class AiSession {
  /** Unique session identifier for log correlation and telemetry. */
  public id: string;
  /**
   * Identifier of the exploration approved in this chat, or `null` before the first approval.
   *
   * @remarks
   * A presented run is what a bookmark recalls, and a chat can hold several: two explorations
   * sharing the chat session id made a bookmark saved from the first resolve against the second.
   * Minted at {@link activatePendingExploration} — the sole publisher of an engine, so exactly one
   * id exists per approved run — and cleared by {@link resetExploration}. A presentation with no
   * approved exploration behind it (a discovery-turn render) falls back to {@link id}.
   */
  public explorationRunId: string | null = null;
  /** Count of explorations approved in this chat; the suffix that makes each run id unique. */
  private explorationCounter = 0;
  /** Orchestrates short-term narrative and long-term technical memory. */
  public readonly memory: AiMemoryManager;

  // ── Environment State ──
  /** The current database model (nodes/edges) extracted from DDL. */
  public model: DatabaseModel | null = null;
  /** Topology-only graph used for AI navigation. */
  public graph: Graph | null = null;
  /** Active schema/object filters applied by the user. */
  public filter: SerializedFilterState | null = null;
  /** The name or ID of the language model active for the current turn. */
  public modelName?: string;
  /**
   * Unified GUI state snapshot — passthrough buffer from the webview's
   * `filter-changed` message (declared as `z.any()` in
   * [`bridgeContract.ts`](../engine/shared/bridgeContract.ts)).
   * Treated as opaque inside the extension host; consumed only by the debug-dump renderer.
   */
  public uiState: unknown = null;
  /**
   * Trace-mode snapshot lifted from `uiState.trace` — passthrough buffer with
   * no extension-host consumer beyond debug dumps. Shape-validation is the
   * webview's responsibility before it posts.
   */
  public traceState: unknown = null;
  /**
   * Render-state snapshot — passthrough buffer from the webview's `render-state` message,
   * consumed by the screen-state presenter.
   */
  public renderState: unknown = null;
  /** Current graph rendering mode: 'full' or 'overview'. */
  public graphMode: 'full' | 'overview' = 'full';
  /** Total count of nodes after all active filters are applied (from webview). */
  public filteredCount = 0;
  /** >0 when the render limit was exceeded (from webview). */
  public renderLimitHit = 0;
  /** Friendly label for the currently loaded parse rules. */
  public parseRulesLabel = 'built-in rules';
  /** Human-readable label for the data source origin (filename or server/db). */
  public sourceLabel = 'N/A';
  /** Statistics from the last SQL parsing run. */
  public parseStats: { resolvedEdges: number; parsedRefs: number; droppedRefs: number } | null = null;
  /** Human-readable name of the active project. */
  public projectName: string | null = null;
  /** Persistent identifier for the current project. */
  public currentProjectId: string | null = null;
  /** Indicates if the session is connected to a live database (enables Stats). */
  public isDbSession = false;
  /** Cache for column-level metadata and profiling results. */
  public columnStore: ColumnStore;

  // ── AI reasoning State ──
  /** The active state machine controlling the exploration loop (hop-by-hop). */
  public stateMachine: IHopStateMachine | null = null;
  /** Latest AI/user-refined proposal awaiting approval; never an active RuntimeFrame. */
  public pendingExploration: PendingExplorationProposal | null = null;
  /** The synthesized findings of the session, ready for visualization. */
  public resultGraph: ResultGraph | null = null;
  /** Latest bounded discovery scope captured in the current turn. */
  public discoveryScopeArtifact: DiscoveryScopeArtifact | null = null;
  /** Latest validated presentation, retained for graph replay without another model call. */
  public presentationArtifact: PresentationArtifact | null = null;
  /** Exact LangGraph tool stage; the dispatcher must not infer this from the broader session phase. */
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
   * Last `present_result` highlight groups (the Lineage `source`/`transform`/`target` colour
   * scheme). Persisted from the transient webview `aiMetadata` so post-session diagnostics
   * can see the rendered colour grouping, which otherwise
   * lives only in the webview message and never reaches `resultGraph`.
   */
  public get lastPresentResultHighlightGroups(): Array<{ label: string; color: string; nodeIds: string[] }> | null {
    return this.presentationArtifact?.aiMetadata.highlightGroups ?? null;
  }
  /**
   * `true` when `present_result` was successfully invoked in the current turn.
   *
   * @remarks
   * Reset to `false` at turn start by the graph runtime. Set to `true` by the
   * `present_result` tool handler on success. The presentation node and the "Show in Graph"
   * button gate read this flag so a graph is only announced when one was actually built.
   */
  private _presentResultCalledThisTurn = false;
  public get presentResultCalledThisTurn(): boolean { return this._presentResultCalledThisTurn; }
  private _presentResultAutoDispatched = false;
  public get presentResultAutoDispatched(): boolean { return this._presentResultAutoDispatched; }
  /**
   * Number of `present_result` tool invocations observed in the current turn.
   *
   * @remarks
   * Incremented at tool-handler entry. Reset at turn start.
   */
  private _presentResultAttemptCountThisTurn = 0;
  public get presentResultAttemptCountThisTurn(): number { return this._presentResultAttemptCountThisTurn; }
  /**
   * Number of failed `present_result` invocations in the current turn.
   *
   * @remarks
   * Incremented when `present_result` returns a structured failure envelope or throws.
   * Reset at turn start.
   */
  private _presentResultFailureCountThisTurn = 0;
  public get presentResultFailureCountThisTurn(): number { return this._presentResultFailureCountThisTurn; }
  /**
   * Last `present_result` failure reason captured this turn.
   *
   * @remarks
   * Set when `present_result` fails validation this turn; cleared at turn start.
   */
  private _presentResultLastFailureReasonThisTurn: string | null = null;
  public get presentResultLastFailureReasonThisTurn(): string | null { return this._presentResultLastFailureReasonThisTurn; }
  /** Held full `present_result` draft for narrow patch-only synthesis repair. */
  public readonly presentResultRepairDraft = new RepairDraftStore<
    PresentResultInput,
    PresentResultRepairPatch,
    readonly PresentResultRepairField[]
  >();

  /**
   * Origin node id walked during the most recent discovery turn.
   *
   * @remarks
   * Captured after a discovery turn when the AI
   * made ≥2 distinct `lineage_get_object_detail` calls. Read by the
   * post-discovery SM-offer follow-up pill to seed
   * `lineage_start_exploration` without re-asking the user. Cleared in
   * {@link resetExploration}.
   */
  public lastDiscoveryOrigin: string | null = null;

  /**
   * Number of distinct nodes inspected via `lineage_get_object_detail`
   * in the most recent discovery turn. The SM-offer follow-up pill renders
   * only when this count is ≥ 2 — a multi-object walk worth deepening.
   */
  public lastDiscoveryWalkCount = 0;

  /**
   * The user's verbatim discovery-turn prompt — stored so the
   * post-approval discovery-summary composition round can lift it
   * into `mission_brief` / `discoverySummary`. Cleared in {@link resetExploration}.
   */
  public lastDiscoveryQuestion: string | null = null;

  /**
   * The verbatim prompt of the current turn, set at run start by the agent
   * runtime. Host-seeded marker prompts (preview/trace re-entry) are not
   * stored — those flows resolve their question from
   * {@link lastDiscoveryQuestion} instead. Read by `start_exploration` to
   * anchor the canonical user question to user-authored text for direct
   * free-text entry rather than the model's paraphrase.
   */
  public currentTurnPrompt: string | null = null;

  /**
   * The AI's discovery-turn final chat answer (Markdown). Captured from
   * the last `toolCallRound.response` after the discover loop ends. Read
   * by the post-approval discovery-summary composition round so the
   * compressed memo can cite the headline finding the AI already wrote.
   * Cleared in {@link resetExploration}.
   */
  public lastDiscoveryAnswer: string | null = null;
  /** Count- and byte-bounded canonical user/final-assistant discovery turns. */
  private discoveryTranscript: DiscoveryTranscriptTurn[] = [];
  /** Bounded accepted tool evidence projected independently of provider-native transcript shapes. */
  private discoveryEvidence: RetainedDiscoveryEvidence[] = [];

  /**
   * Mission-type classification inferred at end of discovery.
   *
   * @remarks
   * Drives which subsections fire at synthesis. `business` omits the Technical
   * subsection; `technical` renders technical content only; `both` renders both.
   * `undefined` means classification has not yet been resolved for this session.
   */
  public classification?: ClassificationValue;
  /** YAML-loaded instructions for report generation. */
  public outputTemplates: AiOutputTemplates;

  /** Sequential log of tool calls and results for the current exploration. */
  public hopLog: HopLogEntry[] = [];
  /** Sliding-memory replacements emitted during the current API turn — derived from the event log so the two can never drift. */
  public get slidingMemoryWipeCountThisTurn(): number { return this._memoryWipeEventsThisTurn.length; }
  /**
   * Per-wipe detail for this turn — the memory-leak waste basis the analytics layer needs.
   * Each entry records WHY a wipe fired and how many threaded messages it discarded, so a
   * regression in the sliding-wipe model (history growing instead of being replaced) is visible
   * per-wipe in telemetry, not just as an aggregate count.
   */
  private _memoryWipeEventsThisTurn: MemoryWipeEvent[] = [];
  public get memoryWipeEventsThisTurn(): ReadonlyArray<MemoryWipeEvent> { return this._memoryWipeEventsThisTurn; }

  // ── Telemetry / Log Correlation ──
  /** Unix timestamp of session creation. Pinned at creation; used for result-graft windowing. */
  public startTime: number;
  /**
   * Total number of tool execution rounds performed.
   *
   * @remarks
   * Engine-derived shadow copy for UI/telemetry only — the host graph mirrors
   * `engine.getHopDiagnostics().hop` here after each hop. The {@link NavigationEngine} is the
   * source of truth; never branch control flow on this field.
   */
  public hopCount = 0;
  /** Monotonic round id incremented by the host runtime for same-round serial-tool guards. */
  public currentRoundId = 0;
  /** Round id in which start_exploration last succeeded (or was attempted). null when reset. */
  public startExplorationRoundId: number | null = null;

  // ── Notice Queue ──
  /** Set-keyed notice queue to deduplicate messages across parallel tool calls. */
  public pendingUserNotice: Set<string> = new Set();

  /**
   * Current finite-state-machine phase. Persists across VS Code chat turns.
   *
   * @remarks
   * LangGraph routes discovery, exploration, synthesis, and completed follow-ups from
   * `phase.kind`; the participant only projects native gate and follow-up UI. Transitions go
   * through {@link enterGate},
   * {@link enterExploring}, {@link enterIdle}, and {@link enterCompleted} — never
   * assign this field directly.
   */
  public phase: SessionPhase = { kind: 'idle' };

  /**
   * Monotonic turn-ownership epoch. Bumped once per turn by {@link beginTurn} and captured by that
   * turn's runtime; every guarded phase/result write carries the captured value so a superseded
   * "zombie" turn cannot mutate the session a newer turn now owns.
   */
  private _turnEpoch = 0;

  /** The live turn-ownership epoch (see {@link beginTurn}); always valid for the current turn's own writes. */
  public get turnEpoch(): number {
    return this._turnEpoch;
  }

  /**
   * Opens a new turn: bumps and returns the turn-ownership epoch the caller threads into this turn's
   * guarded session writes.
   *
   * @remarks
   * The ONLY site that bumps {@link turnEpoch}. Deliberately NOT called by {@link resetExploration}:
   * graph nodes legitimately call `resetExploration` mid-turn on their own session, and a bump there
   * would strand the still-running turn's captured epoch — turning its own later writes into
   * dropped-stale no-ops.
   *
   * @returns The new epoch to capture for the duration of this turn.
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

  /**
   * Creates a new AiSession.
   *
   * @param templates - Optional report generation templates.
   */
  constructor(templates?: AiOutputTemplates) {
    this.id = this.generateId();
    this.memory = new AiMemoryManager();
    this.columnStore = new ColumnStore();
    this.outputTemplates = templates ?? { ...EMPTY_AI_TEMPLATES };
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
    // Internal mid-turn transition — pass the live epoch so it is never a stale-turn no-op.
    this.enterIdle(this._turnEpoch);
    this.classification = undefined;
    this.lastDiscoveryOrigin = null;
    this.lastDiscoveryWalkCount = 0;
    this.lastDiscoveryQuestion = null;
    this.lastDiscoveryAnswer = null;
  }

  /**
   * Resets the per-turn-scoped bookkeeping at the start of every chat turn.
   *
   * @remarks
   * A held `present_result` repair draft belongs to the turn that authored it and must never survive
   * into a later turn's fresh exploration. {@link resetExploration} already clears it on the paths
   * that run it, but a synthesis abort (three cumulative graph-owned semantic failures,
   * `present_result` calls) exits via a bare `fail()` in `graph.ts` that does NOT call
   * `resetExploration()` — unlike the parallel active-hop abort. Without this turn-boundary clear a
   * stale draft can be picked up by a later turn's first `present_result` call (models routinely set
   * `is_update:true` on a first render) and silently seed the new render from the old, unrelated one.
   * The same turn-boundary rule holds for the single-shot flags and attempt/failure counters: a
   * visual-preview turn leaves `presentResultCalledThisTurn` true with no later reset on the
   * discovery path, which suppressed fresh preview offers and let the participant's terminal
   * handler offer a previous turn's graph. Owns the per-turn wipe counters too, so
   * `LineageRuntime.run` has one call, not a manual field list (DRY).
   */
  public beginTurnState(): void {
    this.resetMemoryWipeDiagnostics();
    this.resetPresentResultTurnState();
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

  /** Clears a stale discovery scope before a new, non-preview discovery turn. */
  public clearDiscoveryScope(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'clearDiscoveryScope');
    if (guard.kind === 'accepted') this.discoveryScopeArtifact = null;
    return guard;
  }

  /**
   * Records a multi-object discovery walk so the post-discovery SM-offer pill can fire and seed
   * `lineage_start_exploration` without re-asking the user. Set by the discovery graph node after a
   * discovery turn inspects ≥ 2 distinct objects; cleared in {@link resetExploration}.
   *
   * @param origin - The first inspected node id (the SM-offer origin).
   * @param walkCount - Distinct objects inspected (≥ 2).
   * @param question - The user's verbatim discovery prompt.
   * @param answer - The AI's final discovery answer (markdown).
   */
  public recordDiscovery(origin: string, walkCount: number, question: string, answer: string): void {
    this.lastDiscoveryOrigin = origin;
    this.lastDiscoveryWalkCount = walkCount;
    this.lastDiscoveryQuestion = question;
    this.lastDiscoveryAnswer = answer;
  }

  /**
   * Whether the post-discovery SM-offer may render (idle phase, multi-object walk with an origin).
   *
   * @remarks
   * The single predicate for every surface that renders the offer, so their trigger conditions
   * cannot drift. Call it — never re-state the three conditions at a render site.
   */
  public smOfferAvailable(): boolean {
    return this.phase.kind === 'idle' && this.lastDiscoveryWalkCount >= 2 && Boolean(this.lastDiscoveryOrigin);
  }

  /** Whether a completed bounded BFS chat answer can offer a visual-preview action. */
  public previewOfferAvailable(): boolean {
    return this.smOfferAvailable()
      && this.discoveryScopeArtifact !== null
      && !this.presentResultCalledThisTurn;
  }

  /**
   * Appends canonical conversation text and bounded accepted discovery evidence.
   *
   * @remarks
   * Provider-native assistant tool calls and `tool` messages are never retained. Evidence is
   * accepted only when it is valid JSON produced by a successful graph-owned observation. Oldest
   * evidence is evicted first when the session count or rendered-byte bound is reached.
   *
   * @param turnMessages - Canonical user/final-assistant messages for the completed turn.
   * @param observations - Successful provider-neutral discovery observations from graph state.
   */
  public appendDiscoveryTurn(
    turnMessages: readonly ModelMessage[],
    observations: readonly DiscoveryEvidenceObservation[] = [],
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
      this.discoveryTranscript.push(boundDiscoveryTurn([
        { role: 'user', content: user },
        { role: 'assistant', content: assistant },
      ]));
      while (this.discoveryTranscript.length > MAX_DISCOVERY_TRANSCRIPT_TURNS
        || Buffer.byteLength(renderDiscoveryTranscript(this.discoveryTranscript), 'utf8') > MAX_DISCOVERY_TRANSCRIPT_BYTES) {
        this.discoveryTranscript.shift();
      }
    }
    for (const observation of observations) {
      if (!observation.toolName || Buffer.byteLength(observation.result, 'utf8') > MAX_DISCOVERY_EVIDENCE_ITEM_BYTES) continue;
      let result: unknown;
      try {
        result = JSON.parse(observation.result);
      } catch {
        continue;
      }
      if (result === null || typeof result !== 'object' || readToolError(result)) continue;
      this.discoveryEvidence.push({ toolName: observation.toolName, result });
      while (this.discoveryEvidence.length > MAX_DISCOVERY_EVIDENCE_OBSERVATIONS
        || Buffer.byteLength(this.renderDiscoveryEvidence(), 'utf8') > MAX_DISCOVERY_EVIDENCE_BYTES) {
        this.discoveryEvidence.shift();
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

  /** Clears cross-turn discovery memory. Called on model/project (re)load, never on SM start. */
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
   * Stores the mission-type classification inferred at end of discovery.
   *
   * @remarks
   * Zod-validates the value at the boundary. Invalid values are rejected
   * mechanically — callers should pass only `'business' | 'technical' | 'both'`.
   *
   * @param value - One of `business` | `technical` | `both`.
   */
  public setClassification(value: ClassificationValue): void {
    this.classification = ClassificationSchema.parse(value);
  }

  /**
   * Returns the gate-locked classification required by active and synthesis model calls.
   *
   * @remarks
   * Missing classification after exploration approval is corrupted runtime state, not a reason to
   * guess `business`. Failing before instruction-plan compilation keeps the model call and engine
   * state unchanged and makes checkpoint/session drift observable.
   *
   * @returns The validated locked classification.
   * @throws When no classification has been approved for the current exploration.
   */
  public requireLockedClassification(): ClassificationValue {
    if (!this.classification) {
      throw new Error('AiSession: active exploration requires a locked classification.');
    }
    return ClassificationSchema.parse(this.classification);
  }

  /**
   * Transitions the session into `awaiting_gate` — the engine paused on a consent
   * gate and the next user turn must resolve it (yes / no / redirect).
   *
   * @remarks
   * Discovery context (`lastDiscoveryOrigin` and siblings) is deliberately left intact here —
   * the post-approval discovery-summary composition round reads it after the user approves the
   * gate. The SM-offer pill is separately gated by `phase.kind === 'idle'`, so it disappears as
   * soon as the gate is pending regardless; on cancel, {@link resetExploration} clears these fields.
   *
   * @param gate - The validated consent-gate envelope produced by the engine.
   * @param token - The calling turn's epoch (see {@link beginTurn}); a stale token drops the write.
   * @returns Whether the transition committed or was dropped as a stale-turn no-op.
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
   * Attaches the composed discovery-handoff memo to the pending proposal at `revision`.
   *
   * @remarks
   * Runs after {@link storePendingExploration} so the memo is never mutated onto a proposal whose
   * revision isn't known yet. Silently a no-op when the proposal has since moved past `revision`
   * (superseded by a newer refine while composition was in flight) — the caller degrades by
   * omitting the memo rather than treating this as a failure.
   */
  public attachDiscoverySummary(revision: number, text: string, token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'attachDiscoverySummary');
    if (guard.kind !== 'accepted') return guard;
    if (this.pendingExploration && this.pendingExploration.revision === revision) {
      this.pendingExploration = { ...this.pendingExploration, discoverySummary: text };
    }
    return guard;
  }

  /** Cancels proposal review without discarding a completed engine/result already on the session. */
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
    factory: (proposal: PendingExplorationProposal) => IHopStateMachine | { error: string },
  ): ExplorationActivationOutcome {
    const guard = this.guardTurnWrite(token, 'activatePendingExploration');
    if (guard.kind !== 'accepted') return guard;
    const proposal = this.pendingExploration;
    if (!proposal) return { kind: 'rejected', reason: 'missing_pending_proposal' };
    if (proposal.revision !== expectedRevision) {
      return { kind: 'rejected', reason: `stale_proposal_revision:${expectedRevision}->${proposal.revision}` };
    }
    const built = factory(proposal);
    if ('error' in built) return { kind: 'rejected', reason: built.error };
    const priorMemory = this.memory.toJSON();
    try {
      // Validate before the first session write so a parse throw rejects with the session untouched.
      const classification = ClassificationSchema.parse(proposal.classification);
      built.publishMemoryTo(this.memory);
      this.stateMachine = built;
      // Minted with the engine, so the run a presentation stamps is the run that produced it.
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
    return guard;
  }

  /**
   * Transitions the session into `idle` — no exploration is active, next turn
   * enters discovery. Use {@link resetExploration} when exploration state itself
   * also needs clearing.
   *
   * @param token - The calling turn's epoch (see {@link beginTurn}); a stale token drops the write.
   * @returns Whether the transition committed or was dropped as a stale-turn no-op.
   */
  public enterIdle(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterIdle');
    if (guard.kind !== 'accepted') return guard;
    this.phase = { kind: 'idle' };
    return guard;
  }

  /**
   * Transitions the session into `completed` — synthesis finished, archive survives
   * on the session singleton. Next user turn routes through the follow-up protocol
   * (refinement without a fresh exploration). Call only when
   * `stateMachine?.status === 'complete'`.
   *
   * @param token - The calling turn's epoch (see {@link beginTurn}); a stale token drops the write.
   * @returns Whether the transition committed or was dropped as a stale-turn no-op.
   */
  public enterCompleted(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterCompleted');
    if (guard.kind !== 'accepted') return guard;
    this.phase = { kind: 'completed' };
    return guard;
  }

  /**
   * Rotates the session identifier and resets the start timer.
   */
  public regenerateSessionId(): void {
    this.id = this.generateId();
    this.startTime = Date.now();
  }

  /**
   * Starts a new native chat session as one atomic session-owned transition.
   *
   * @remarks
   * Preserves the established exploration reset semantics while also clearing
   * the bounded discovery transcript via {@link clearDiscoveryTranscript}.
   * `AiMemoryManager` continues to be reset only through {@link resetExploration}.
   */
  public beginNativeChatSession(): void {
    this.regenerateSessionId();
    this.resetExploration();
    this.clearDiscoveryTranscript();
  }

  /**
   * Clears the single-shot `present_result` guard for the current follow-up turn.
   *
   * @remarks
   * The flag persists from synthesis into the completed phase so the participant can
   * stream the summary after the turn. `followUpNode` resets it at the start of each
   * follow-up turn so a Route A `present_result` adjust fires fresh. Besides this and
   * `enterExploring`, only the wholesale turn-boundary reset in `beginTurnState` touches it —
   * do not assign `presentResultCalledThisTurn` directly from graph nodes.
   */
  public clearPresentResultFlag(): void {
    this._presentResultCalledThisTurn = false;
    this._presentResultAutoDispatched = false;
  }

  public beginPresentResultAttempt(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'beginPresentResultAttempt');
    if (guard.kind !== 'accepted') return guard;
    this._presentResultAttemptCountThisTurn += 1;
    return guard;
  }

  public recordPresentResultFailure(token: number, reason: string): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'recordPresentResultFailure');
    if (guard.kind !== 'accepted') return guard;
    this._presentResultFailureCountThisTurn += 1;
    this._presentResultLastFailureReasonThisTurn = reason;
    return guard;
  }

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
   * Reattaches a state machine rebuilt from a checkpointed engine snapshot.
   *
   * @remarks
   * The LangGraph checkpointer persists the serializable engine projection, not live
   * runtime handles. On resume, the graph reconstructs the `NavigationEngine` from fresh
   * model/graph handles and restores this session's stable memory object in place so
   * prompt builders and synthesis see the same archive as the engine.
   * @param engine - Fully reconstructed engine, not yet published to this session.
   * @param snapshot - Validated serializable engine projection.
   * @param token - The restoring turn's captured ownership epoch.
   * @returns Whether the atomic restore committed or was rejected as stale.
   */
  public restoreExplorationFromSnapshot(engine: IHopStateMachine, snapshot: SmState, token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'restoreExplorationFromSnapshot');
    if (guard.kind !== 'accepted') return guard;
    // restoreFromJSON builds a complete temporary manager first, so a malformed projection leaves the session intact.
    this.memory.restoreFromJSON(snapshot.memory);
    this.stateMachine = engine;
    this.hopCount = snapshot.hopCount;
    this.phase = snapshot.status === 'complete' ? { kind: 'completed' } : { kind: 'exploring' };
    return guard;
  }

  /**
   * Transmutes state-machine findings into the visual `ResultGraph` format.
   *
   * @remarks
   * Maps navigation-engine output (nodes, edges, detail slots) to the standard
   * contract consumed by the `present_result` tool handler and the React webview.
   * Handles both Blackboard and Column-Trace results — `source` is set from the
   * engine's `columnAspect` flag at the time of the call.
   *
   * This fires both at exploration completion and on later supplement rounds; synthesized body
   * fields (`description`/`summary`/`title`/etc.) from a prior `present_result` call are carried
   * forward from the existing `resultGraph` until a new `present_result` call overwrites them —
   * otherwise a supplement round would blank an already-rendered description.
   *
   * @param fullResult - The raw completion result from the state machine.
   * @param token - The calling turn's epoch (see {@link beginTurn}); a stale token drops the write.
   * @returns Whether the result committed or was dropped as a stale-turn no-op.
   */
  public storeSmResult(fullResult: SmResult, token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'storeSmResult');
    if (guard.kind !== 'accepted') return guard;
    const sourceMode = this.stateMachine?.columnAspect ? 'column_trace' : 'blackboard';

    // Carry forward prior synthesized body fields; see @remarks above.
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
      ...(fullResult.columnAspect ? {
        columnAspect: {
          edges: fullResult.columnAspect.edges,
          ctPrunedNodeIds: fullResult.ctPrunedNodeIds ?? [],
        },
      } : {}),
    };
    return guard;
  }

  /**
   * Mirrors the engine-derived hop count into {@link hopCount} for UI/telemetry, guarded by the
   * turn epoch.
   *
   * @remarks
   * `hopCount` is an engine-derived shadow copy (see {@link hopCount}); a superseded "zombie" turn
   * must not clobber the diagnostics a newer turn now owns, so the write lands only while
   * {@link token} still matches the live {@link turnEpoch}.
   *
   * @param token - The calling turn's epoch (see {@link beginTurn}); a stale token drops the write.
   * @param count - The engine-derived hop count to mirror.
   * @returns Whether the write committed or was dropped as a stale-turn no-op.
   */
  public setHopCount(token: number, count: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'setHopCount');
    if (guard.kind !== 'accepted') return guard;
    this.hopCount = count;
    return guard;
  }

  /**
   * Records one per-turn memory wipe and updates its matching aggregate counter, guarded by the
   * turn epoch.
   *
   * @remarks
   * Feeds the analytics layer's per-wipe waste basis (see {@link memoryWipeEventsThisTurn}); a
   * superseded "zombie" turn must not append to the event log a newer turn now owns, so the push
   * lands only while {@link token} still matches the live {@link turnEpoch}.
   *
   * @param token - The calling turn's epoch (see {@link beginTurn}); a stale token drops the write.
   * @param event - The wipe event (kind / trigger / hop / messages-before-wipe).
   * @returns Whether the write committed or was dropped as a stale-turn no-op.
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

/**
 * Retrieves the global singleton instance of the `AiSession`.
 *
 * @remarks
 * Uses `globalThis` to ensure state persistence across different entry points
 * (Extension Host vs. Integration Tests).
 *
 * @returns The active `AiSession` instance.
 */
export function getSession(): AiSession {
  return getGlobalSingleton(GLOBAL_SESSION_KEY, () => new AiSession());
}
