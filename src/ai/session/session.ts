import { randomUUID } from 'node:crypto';
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
import type { SessionPhase, ToolControlSignal } from '../session/sessionPhase';
import { InternalInvariantError } from '../support/internalInvariant';
import type { ClassificationValue } from '../session/classification';
import { contextBlockBytes, storedEvidenceKindBytes, type TurnTokenBudget } from '../support/tokenBudget';
import { readToolError, type ToolRejection } from '../support/toolErrorEnvelope';
import { sanitizeForLog, trunc } from '../../utils/log';
import type { PresentResultInput } from '../tools/presentResult';
import { ToolDraft } from '../support/toolDraft';
import type { ChatLmStage } from '../tools/toolPolicy';
import { errorMessage } from '../../utils/errorMessage';

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
  /** Identity of the card that shows this proposal, minted by {@link AiSession.enterGate} and never reused; absent while no card shows it. */
  readonly proposalId?: string;
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
  left: Omit<PendingExplorationProposal, 'revision' | 'discoverySummary' | 'proposalId'>,
  right: PendingExplorationProposal | Omit<PendingExplorationProposal, 'revision'>,
): boolean {
  const { revision: _revision, discoverySummary: _discoverySummary, proposalId: _proposalId, ...rightRest } = right as PendingExplorationProposal;
  return canonicalJson(left) === canonicalJson(rightRest);
}

/** Result of a turn-guarded session write ({@link AiSession.enterExploring} and its siblings). */
export type SessionWriteOutcome =
  | { kind: 'accepted' }
  | { kind: 'dropped_stale_turn'; op: string; captured: number; current: number };

/** Outcome of attempting to start or resume a navigation engine session. */
type ExplorationActivationOutcome =
  | { kind: 'accepted'; engine: IHopStateMachine }
  | { kind: 'dropped_stale_turn'; op: string; captured: number; current: number }
  | { kind: 'rejected'; reason: string };

/** Maximum accepted discovery observations retained in one live session — a *count* bound, so a long discovery walk cannot grow the retained set even when every result is individually small. */
const MAX_DISCOVERY_EVIDENCE_OBSERVATIONS = 24;
/**
 * Byte bounds for the discovery-evidence message, one evidence item, and the replayed transcript
 * live in `support/tokenBudget.ts` (`contextBlockBytes()`, `storedEvidenceKindBytes()`).
 */
/** Maximum complete canonical discovery turns retained in one live session — bounds cross-turn history by turn count, independently of how large any single turn is. */
export const MAX_DISCOVERY_TRANSCRIPT_TURNS = 20;

/** Provider-neutral accepted discovery result eligible for cross-turn grounding. */
interface DiscoveryEvidenceObservation {
  /** Name of the graph-owned tool that produced the result. */
  readonly toolName: string;
  /** Serialized JSON result text accepted as evidence. */
  readonly result: string;
}

/** Bounded accepted discovery evidence retained for cross-turn grounding, parsed JSON kept as-is. */
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

/** Numeric summary of the last SQL parse, kept for Copy Debug Info. Object names and reference lists stay in the Output channel. */
export interface SessionParseCounts {
  resolvedEdges: number;
  parsedRefs: number;
  /** References the parser dropped. */
  droppedRefs: number;
  /** Scripted procedures and views that were parsed. */
  scripts: number;
  /** Definitions that could not be read. */
  unreadableDefinitions: number;
}

/** Encapsulates the state and lifecycle of a single AI-driven lineage investigation. */
export class AiSession {
  /** Unique session identifier for log correlation and telemetry. */
  public id: string;
  /** Identifier of the exploration approved in this chat, or `null` before the first approval. */
  public explorationRunId: string | null = null;
  /** Count of explorations approved in this chat; the suffix that makes each run id unique. */
  private explorationCounter = 0;
  /** Orchestrates short-term narrative and long-term technical memory. */
  public readonly memory: AiMemoryManager;

  /** The current database model (nodes/edges) extracted from DDL. */
  public model: DatabaseModel | null = null;
  /** Topology-only graph used for AI navigation. */
  public graph: Graph | null = null;
  /** Active schema/object filters applied by the user. */
  public filter: SerializedFilterState | null = null;
  /** The name or ID of the language model active for the current turn. */
  public modelName?: string;
  /** Unified GUI state snapshot from the webview's `filter-changed` message, validated at the bridge against `UiStateSnapshotSchema` in [`bridgeContract.ts`](../engine/shared/bridgeContract.ts); readers stay defensive because non-bridge writers may seed it. */
  public uiState: unknown = null;
  /** Trace-mode snapshot lifted from `uiState.trace`, with no extension-host consumer beyond debug dumps. */
  public traceState: unknown = null;
  /** Render-state snapshot from the webview's `render-state` message, validated at the bridge against `RenderStateSnapshotSchema` and consumed by the screen-state presenter. */
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
  /** Counts from the last SQL parse. Names and reference lists stay in the Output channel. */
  public parseStats: SessionParseCounts | null = null;
  /** Human-readable name of the active project. */
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
  /** Control outcome of the tool call now being dispatched; the dispatcher takes it once per call. */
  private controlSignal: ToolControlSignal | null = null;

  /** Records the typed gate or refusal of the current tool call. */
  public signalControl(signal: ToolControlSignal): void {
    this.controlSignal = signal;
  }

  /** Returns and clears the current call's control outcome. */
  public takeControlSignal(): ToolControlSignal | null {
    const signal = this.controlSignal;
    this.controlSignal = null;
    return signal;
  }
  /** The synthesized findings of the session, ready for visualization. */
  public resultGraph: ResultGraph | null = null;
  /** Latest bounded discovery scope walked with `lineage_get_scope_bundle`; backs the preview offer ({@link settleDiscoveryTurn}). */
  public discoveryScopeArtifact: DiscoveryScopeArtifact | null = null;
  /** Latest validated presentation, retained for graph replay without another model call. */
  public presentationArtifact: PresentationArtifact | null = null;
  /** Exact LangGraph tool stage; the dispatcher must not infer this from the broader session phase. */
  public activeLmStage: ChatLmStage | null = null;
  /** Last `present_result` description string — consumed by `dataLineageViz.aiCreateView` when re-posting the AI preview to the webview so the narrative survives panel reveal. */
  public get lastPresentResultDescription(): string | null { return this.presentationArtifact?.aiMetadata.description ?? null; }
  /** Last `present_result` headline summary — emitted to chat after presentation so the user sees an answer to their original question without opening the description overlay. */
  public get lastPresentResultSummary(): string | null { return this.presentationArtifact?.aiMetadata.summary ?? null; }
  /** `true` when `present_result` was successfully invoked in the current turn. */
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
  /** Number of failed `present_result` invocations in the current turn. */
  private _presentResultFailureCountThisTurn = 0;
  /** Count of failed `present_result` invocations in the current turn. */
  public get presentResultFailureCountThisTurn(): number { return this._presentResultFailureCountThisTurn; }
  /** Uncommitted start fields, scoped to the turn, stage and pending proposal. */
  public readonly startExplorationDraft = new ToolDraft<Record<string, unknown>>();
  /** Uncommitted report fields; the phase schema remains complete during correction. */
  public readonly presentResultRepairDraft = new ToolDraft<PresentResultInput>();

  /** Reason the current turn's synthesis rendered the model's held text without a working preview/panel step, or `null` when the last render was clean. Set by {@link markSynthesisRenderDegraded}; read and cleared once by the participant's one-shot warning toast via {@link consumeSynthesisRenderDegraded}. */
  private _synthesisRenderDegradedReason: string | null = null;

  /** Records that a synthesis terminal path rendered the model's held text with no working render step. */
  public markSynthesisRenderDegraded(reason: string): void {
    this._synthesisRenderDegradedReason = reason;
  }

  /** Clears a render-degraded mark that a preview delivery set, leaving a mark from any other cause. */
  public clearPreviewDeliveryDegraded(): void {
    if (this._synthesisRenderDegradedReason === 'preview_post_failed'
      || this._synthesisRenderDegradedReason === 'preview_dispatch') {
      this._synthesisRenderDegradedReason = null;
    }
  }

  /** Peeks the render-degraded reason without clearing it — read by the synthesis node's own chat line. */
  public get synthesisRenderDegradedReason(): string | null {
    return this._synthesisRenderDegradedReason;
  }

  private readonly _closingNotices = new Map<string, string>();

  /** Queues a user-visible notice for the turn's closing markdown, once per `key`. */
  public queueClosingNotice(key: string, notice: string): void {
    if (!this._closingNotices.has(key)) this._closingNotices.set(key, notice);
  }

  /** Returns the queued notices in queue order, joined as markdown paragraphs, and clears the queue. */
  public takeClosingNotices(): string {
    const notices = [...this._closingNotices.values()].map(notice => `\n\n${notice}`).join('');
    this._closingNotices.clear();
    return notices;
  }

  /** Returns and clears the render-degraded reason — call exactly once, from the one-shot toast site. */
  public consumeSynthesisRenderDegraded(): string | null {
    const reason = this._synthesisRenderDegradedReason;
    this._synthesisRenderDegradedReason = null;
    return reason;
  }

  /** Origin node id walked during the most recent discovery walk. */
  public lastDiscoveryOrigin: string | null = null;

  /** Nodes in the most recent discovery walk: the walked scope's size, or the distinct objects read with `lineage_get_object_detail`. The SM-offer follow-up pill renders when this count is ≥ 2. */
  public lastDiscoveryWalkCount = 0;

  /** The user's verbatim discovery-turn prompt — stored so the post-approval discovery-summary composition round can lift it into `mission_brief` / `discoverySummary`. Cleared in {@link resetExploration}. */
  public lastDiscoveryQuestion: string | null = null;

  /** The verbatim prompt of the current turn, set at run start by the agent runtime. Host-seeded marker prompts (preview/trace re-entry) are not stored — those flows resolve their question from {@link lastDiscoveryQuestion} instead. Read by `start_exploration` to anchor the canonical user question to user-authored text for direct free-text entry rather than the model's paraphrase. */
  public currentTurnPrompt: string | null = null;

  /** The AI's discovery-turn final chat answer (Markdown). Recorded by {@link settleDiscoveryTurn} when the discover loop ends. Read by the post-approval discovery-summary composition round so the compressed memo can cite the headline finding the AI already wrote. Cleared in {@link resetExploration}. */
  public lastDiscoveryAnswer: string | null = null;
  /** Count- and byte-bounded canonical user/final-assistant discovery turns. */
  private discoveryTranscript: DiscoveryTranscriptTurn[] = [];
  /** Bounded accepted tool evidence projected independently of provider-native transcript shapes. */
  private discoveryEvidence: RetainedDiscoveryEvidence[] = [];

  /** Mission-type classification inferred at end of discovery. */
  public classification?: ClassificationValue;
  /** YAML-loaded instructions for report generation. */
  public outputTemplates: AiOutputTemplates;
  /** Section labels declared by the capture recipes; synthesis serves the active angle's list. */
  public outputSections: AiOutputSections;

  /** Sequential log of tool calls and results for the current exploration. */
  public hopLog: HopLogEntry[] = [];

  /** Unix timestamp of session creation. Pinned at creation; used for result-graft windowing. */
  public startTime: number;
  /** Total number of tool execution rounds performed. */
  public hopCount = 0;
  /** Monotonic round id incremented by the host runtime for same-round serial-tool guards. */
  public currentRoundId = 0;
  /** Round id in which start_exploration last succeeded (or was attempted). null when reset. */
  public startExplorationRoundId: number | null = null;

  /** Set-keyed notice queue to deduplicate messages across parallel tool calls. */
  public pendingUserNotice: Set<string> = new Set();

  /** Current finite-state-machine phase. Persists across VS Code chat turns. */
  public phase: SessionPhase = { kind: 'idle' };

  /** Monotonic ownership epoch, advanced when a turn starts or its loaded model is replaced. Guarded writes carry the captured value so a superseded turn cannot mutate the current session. */
  private _turnEpoch = 0;

  /** The live turn-ownership epoch (see {@link beginTurn}); always valid for the current turn's own writes. */
  public get turnEpoch(): number {
    return this._turnEpoch;
  }

  /** Opens a new turn: bumps and returns the turn-ownership epoch the caller threads into this turn's guarded session writes. */
  public beginTurn(): number {
    this.startExplorationDraft.clear();
    this._turnEpoch += 1;
    return this._turnEpoch;
  }

  /** Guards a turn-scoped write: accepts only while {@link token} still matches the live {@link turnEpoch}, otherwise reports the write as a dropped stale-turn no-op. */
  private guardTurnWrite(token: number, op: string): SessionWriteOutcome {
    if (token !== this._turnEpoch) {
      return { kind: 'dropped_stale_turn', op, captured: token, current: this._turnEpoch };
    }
    return { kind: 'accepted' };
  }

  /** Creates a new AiSession. */
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

  /** Resets every turn-scoped `present_result` field. The cross-turn artifact archive (`presentationArtifact`) deliberately survives — completed-phase follow-ups reuse it. */
  private resetPresentResultTurnState(): void {
    this._presentResultCalledThisTurn = false;
    this._presentResultAutoDispatched = false;
    this._presentResultAttemptCountThisTurn = 0;
    this._presentResultFailureCountThisTurn = 0;
    this.presentResultRepairDraft.clear();
    this._synthesisRenderDegradedReason = null;
  }

  /** Publishes prepared model data atomically, retiring prior approvals, exploration state and turn leases. */
  public replaceModel(model: DatabaseModel, graph: Graph, columnStore: ColumnStore, isDb: boolean): void {
    this.beginTurn();
    this.resetExploration();
    this.beginTurnState();
    this.clearDiscoveryTranscript();
    this.activeLmStage = null;
    this.controlSignal = null;
    this.currentTurnPrompt = null;
    this.columnStore = columnStore;
    this.model = model;
    this.graph = graph;
    this.isDbSession = isDb;
  }

  /** Clears all exploration-specific state while preserving environment metadata. */
  public resetExploration(): void {
    this.startExplorationDraft.clear();
    this.memory.reset();
    this.stateMachine = null;
    this.explorationRunId = null;
    this.pendingExploration = null;
    this.resultGraph = null;
    this.discoveryScopeArtifact = null;
    this.resetPresentResultLifecycle();
    this.hopCount = 0;
    this.hopLog = [];
    this.pendingUserNotice.clear();
    this.startExplorationRoundId = null;
    this.enterIdle(this._turnEpoch);
    this.classification = undefined;
    this.lastDiscoveryOrigin = null;
    this.lastDiscoveryWalkCount = 0;
    this.lastDiscoveryQuestion = null;
    this.lastDiscoveryAnswer = null;
  }

  /** Resets the per-turn-scoped bookkeeping at the start of every chat turn. */
  public beginTurnState(): void {
    this.resetPresentResultTurnState();
    this._bufferedFollowUpProse = null;
    this._closingNotices.clear();
  }

  /** The newest follow-up prose held back by `proseGate: 'buffer-until-tool'`, turn-scoped. */
  private _bufferedFollowUpProse: string | null = null;
  /** The newest buffered follow-up prose, or null when this turn produced none. */
  public get bufferedFollowUpProse(): string | null { return this._bufferedFollowUpProse; }
  /** Holds one generation's suppressed prose, replacing any earlier one. Blank text clears nothing. */
  public bufferFollowUpProse(text: string): void {
    if (text.trim().length > 0) this._bufferedFollowUpProse = text;
  }

  /** Enters the exact tool-policy stage for one model call. */
  public enterLmStage(stage: ChatLmStage, token: number): SessionWriteOutcome {
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

  /** Settles the post-discovery offers once a discovery turn has its answer. */
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

  /** Whether the post-discovery SM-offer may render (idle phase, multi-object walk with an origin). */
  public smOfferAvailable(): boolean {
    return this.phase.kind === 'idle'
      && Boolean(this.lastDiscoveryOrigin)
      && this.lastDiscoveryWalkCount >= 2;
  }

  /** Whether a completed bounded BFS chat answer can offer a visual-preview action. */
  public previewOfferAvailable(): boolean {
    return this.smOfferAvailable()
      && this.discoveryScopeArtifact !== null
      && !this.presentResultCalledThisTurn;
  }

  /** Appends canonical conversation text and bounded accepted discovery evidence. */
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

  /** Returns prior canonical conversation plus one bounded provider-neutral evidence projection. */
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

  /** Clears cross-turn discovery memory: on model/project (re)load, on a new native chat, and after every turn that supplied native history (which then owns cross-turn conversation). Never on SM start. */
  public clearDiscoveryTranscript(): void {
    this.discoveryTranscript = [];
    this.discoveryEvidence = [];
  }

  /** Renders the accepted-evidence projection without provider call ids or transcript roles. */
  private renderDiscoveryEvidence(): string {
    if (this.discoveryEvidence.length === 0) return '';
    return JSON.stringify({ kind: 'accepted_discovery_evidence', observations: this.discoveryEvidence });
  }

  /** Returns the gate-locked classification required by active and synthesis model calls. */
  public requireLockedClassification(): ClassificationValue {
    if (!this.classification) {
      throw new Error('AiSession: active exploration requires a locked classification.');
    }
    return this.classification;
  }

  /** Shows the pending proposal on a new card: mints a random identity that no earlier card carries, even one VS Code restores after a host reload, so every earlier card retires; enters `awaiting_gate`. */
  public enterGate(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterGate');
    if (guard.kind !== 'accepted') return guard;
    if (!this.pendingExploration) throw new InternalInvariantError('enterGate without a pending exploration proposal');
    this.pendingExploration = { ...this.pendingExploration, proposalId: randomUUID() };
    this.phase = { kind: 'awaiting_gate' };
    return guard;
  }

  /** Whether the card with `proposalId` is the one the user can still resolve. */
  public holdsProposal(proposalId: string): boolean {
    return this.phase.kind === 'awaiting_gate' && this.pendingExploration?.proposalId === proposalId;
  }

  /** Replaces the reviewable proposal without creating or publishing an exploration engine. */
  public storePendingExploration(
    proposal: Omit<PendingExplorationProposal, 'revision' | 'proposalId'>,
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

  /** Attaches the composed discovery-handoff memo to the pending proposal at `revision`. */
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
    this.startExplorationDraft.clear();
    this.pendingExploration = null;
    if (this.stateMachine?.status === 'complete' && this.resultGraph) this.enterCompleted(token);
    else this.enterIdle(token);
    return guard;
  }

  /** Atomically validates, constructs, and publishes the exact proposal reviewed at the gate. The factory runs synchronously only after the epoch and card-identity checks pass. */
  public activatePendingExploration(
    proposalId: string,
    token: number,
    factory: (proposal: PendingExplorationProposal) => IHopStateMachine | ToolRejection,
  ): ExplorationActivationOutcome {
    const guard = this.guardTurnWrite(token, 'activatePendingExploration');
    if (guard.kind !== 'accepted') return guard;
    const proposal = this.pendingExploration;
    if (!proposal) return { kind: 'rejected', reason: 'missing_pending_proposal' };
    if (!this.holdsProposal(proposalId)) {
      return { kind: 'rejected', reason: `stale_proposal:${proposalId}->${proposal.proposalId ?? 'unshown'}` };
    }
    const built = factory(proposal);
    if ('code' in built) return { kind: 'rejected', reason: built.code };
    const priorMemory = this.memory.toJSON();
    try {
      built.publishMemoryTo(this.memory);
      this.stateMachine = built;
      this.explorationCounter += 1;
      this.explorationRunId = `${this.id}:e${this.explorationCounter}`;
      this.classification = proposal.classification;
      this.pendingExploration = null;
      this.enterExploring(token);
      return { kind: 'accepted', engine: built };
    } catch (err) {
      this.memory.restoreFromJSON(priorMemory);
      return { kind: 'rejected', reason: errorMessage(err) };
    }
  }

  /** Transitions the session into `exploring` — the engine is ready to produce the next hop. Called on fresh SM start (post-confirm) and on gate-approved resume. */
  public enterExploring(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterExploring');
    if (guard.kind !== 'accepted') return guard;
    this.phase = { kind: 'exploring' };
    this._presentResultCalledThisTurn = false;
    this._presentResultAutoDispatched = false;
    this.presentResultRepairDraft.clear();
    return guard;
  }

  /** Transitions the session into `idle` — no exploration is active, next turn enters discovery. Use {@link resetExploration} when exploration state itself also needs clearing. */
  public enterIdle(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'enterIdle');
    if (guard.kind !== 'accepted') return guard;
    this.phase = { kind: 'idle' };
    return guard;
  }

  /** Transitions the session into `completed` — synthesis finished, archive survives on the session singleton. Next user turn routes through the follow-up protocol (refinement without a fresh exploration). Call only when `stateMachine?.status === 'complete'`. */
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

  /** Starts a new native chat session as one atomic session-owned transition. */
  public beginNativeChatSession(): void {
    this.regenerateSessionId();
    this.resetExploration();
    this.clearDiscoveryTranscript();
  }

  /** Clears the single-shot `present_result` guard for the current follow-up turn. */
  public clearPresentResultFlag(): void {
    this._presentResultCalledThisTurn = false;
    this._presentResultAutoDispatched = false;
  }

  /** Counts one `present_result` invocation at tool-handler entry, if the calling turn still owns the session. */
  public beginPresentResultAttempt(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'beginPresentResultAttempt');
    if (guard.kind !== 'accepted') return guard;
    this._presentResultAttemptCountThisTurn += 1;
    return guard;
  }

  /** Counts one failed `present_result` invocation, if the calling turn still owns the session. */
  public recordPresentResultFailure(token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'recordPresentResultFailure');
    if (guard.kind !== 'accepted') return guard;
    this._presentResultFailureCountThisTurn += 1;
    return guard;
  }

  /** Commits a validated presentation — artifact plus single-shot success flags — if the calling turn still owns the session. */
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

  /** Transmutes state-machine findings into the visual `ResultGraph` format. */
  public storeSmResult(fullResult: SmResult, token: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'storeSmResult');
    if (guard.kind !== 'accepted') return guard;
    const sourceMode = this.stateMachine?.columnAspect ? 'column_trace' : 'blackboard';

    const prior = this.resultGraph;
    this.resultGraph = {
      nodeIds: fullResult.fullNodes.map(n => n.id),
      evidenceNodeIds: fullResult.fullNodes.map(n => n.id),
      edges: fullResult.edges,
      source: sourceMode,
      originNodeId: fullResult.originNodeId,
      notes: prior?.notes,
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
          requested: { node: fullResult.originNodeId, columns: [...fullResult.columnAspect.target_columns] },
        },
      } : {}),
    };
    return guard;
  }

  /** The committed report sections a further render of this same run may keep instead of resending. */
  public retainableReportSections(): NonNullable<ResultGraph['sections']> | null {
    const sections = this.resultGraph?.sections;
    if (!sections?.length || !this.explorationRunId) return null;
    return this.resultGraph?.sectionsRunId === this.explorationRunId ? sections : null;
  }

  /** Mirrors the engine-derived hop count into {@link hopCount} for UI/telemetry, guarded by the turn epoch. */
  public setHopCount(token: number, count: number): SessionWriteOutcome {
    const guard = this.guardTurnWrite(token, 'setHopCount');
    if (guard.kind !== 'accepted') return guard;
    this.hopCount = count;
    return guard;
  }
}

const GLOBAL_SESSION_KEY = '__VSCODE_DL_AI_SESSION__';

/** Retrieves the global singleton instance of the `AiSession`. */
export function getSession(): AiSession {
  return getGlobalSingleton(GLOBAL_SESSION_KEY, () => new AiSession());
}
