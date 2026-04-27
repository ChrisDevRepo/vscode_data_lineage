import type Graph from 'graphology';
import type { DatabaseModel } from '../engine/types';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';
import { ColumnStore } from '../engine/columnStore';
import { AiMemoryManager } from './memoryManager';
import { type ResultGraph, type AiOutputTemplates, EMPTY_AI_TEMPLATES, type SessionSummary, type NodeRole } from './types';
import type { IHopStateMachine } from './smBase';
import type { HopLogEntry, SmResult } from './smTypes';
import type { SessionPhase, PendingGate } from './sessionPhase';
import { ClassificationSchema, type ClassificationValue } from './classification';

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
  /** Orchestrates short-term narrative and long-term technical memory. */
  public readonly memory: AiMemoryManager;
  
  // ── Environment State ──
  /** The current database model (nodes/edges) extracted from DDL. */
  public model: DatabaseModel | null = null;
  /** Topology-only graph used for AI navigation. */
  public graph: Graph | null = null;
  /** Active schema/object filters applied by the user. */
  public filter: SerializedFilterState | null = null;
  /** List of saved filter profiles (views) for the current project. */
  public views: FilterProfile[] = [];
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
  /** The active state machine controlling the hop-by-hop exploration loop. */
  public stateMachine: IHopStateMachine | null = null;
  /** The synthesized findings of the session, ready for visualization. */
  public resultGraph: ResultGraph | null = null;
  /**
   * Last `present_result` description string — consumed by `dataLineageViz.aiCreateView`
   * when re-posting the AI preview to the webview so the narrative survives panel reveal.
   */
  public lastPresentResultDescription: string | null = null;
  /**
   * `true` when `present_result` was successfully invoked in the current `runHopLoop` turn.
   *
   * @remarks
   * Reset to `false` at the start of every `runHopLoop` call. Set to `true` by the
   * `present_result` tool handler on success. The `dispatchExit` button gate reads this
   * flag so the "Show in Graph" button only appears when a graph was actually built.
   */
  public presentResultCalledThisTurn = false;
  /**
   * `true` once a synthesis-phase corrective-prompt retry has been attempted in
   * this `runHopLoop` turn.
   *
   * @remarks
   * Reset to `false` at the start of every `runHopLoop` call. Set to `true` when
   * the synthesis branch injects a "Call lineage_present_result now" corrective
   * after a toolless model response. Caps the retry at one attempt; a second
   * toolless synthesis turn falls through to {@link renderArchiveFallback}.
   */
  public synthesisCorrectiveAttempted = false;
  /**
   * One-shot guard for emitting the "Synthesizing the answer…" progress chip
   * on the first synthesis-phase round. The synthesis call to the model
   * typically takes 30–90s; without a progress signal users perceive a hang.
   */
  public synthesisProgressEmitted = false;
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
  /** Hard limit on input tokens for the underlying LLM. */
  public maxInputTokens = 32000;
  /** Name of the AI model performing the investigation. */
  public modelName = '';
  /** Sequential log of tool calls and results for the current exploration. */
  public hopLog: HopLogEntry[] = [];
  
  // ── Telemetry / Log Correlation ──
  /** Unix timestamp of session creation. */
  public startTime: number;
  /**
   * Unix timestamp of the last user-driven activity (new prompt, gate resume).
   * Drives {@link isStale}; distinct from {@link startTime}, which stays pinned to
   * session creation for result-graft windowing.
   */
  public lastActivity: number;
  /** Total number of tool execution rounds performed. */
  public hopCount = 0;
  /** Monotonic round id (bumped by participant on each LM round). Used to detect parallel calls to strictly-serial tools. */
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
   * The participant routes on `phase.kind` at turn entry: `awaiting_gate` runs gate
   * resolution, `exploring` resumes the hop loop, `idle` and `synthesis` enter the
   * normal discovery / synthesis paths. Transitions go through {@link enterGate},
   * {@link enterExploring}, and {@link enterIdle} — never mutate this field directly.
   */
  public phase: SessionPhase = { kind: 'idle' };

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
    this.lastActivity = this.startTime;
  }

  /**
   * Determines if the session has been idle past the stale threshold (30 minutes
   * since the last user activity).
   *
   * @remarks
   * Measured from {@link lastActivity}, not {@link startTime}: a user resuming a
   * long-pending gate is active, and the session should not be wiped under them.
   */
  public isStale(): boolean {
    const STALE_AFTER_MS = 30 * 60 * 1000;
    return (Date.now() - this.lastActivity) > STALE_AFTER_MS;
  }

  /**
   * Marks the session as active now. Call on every user-driven turn boundary
   * (new prompt, gate approval/redirect) so {@link isStale} measures true idle.
   */
  public touch(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Resets the session state if it is stale or if a previous exploration is complete.
   */
  public resetIfStale(): void {
    if (this.isStale() || this.stateMachine?.status === 'complete') {
      this.resetExploration();
      this.regenerateSessionId();
    }
  }

  private generateId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
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
    this.resultGraph = null;
    this.lastPresentResultDescription = null;
    this.hopCount = 0;
    this.hopLog = [];
    this.pendingUserNotice.clear();
    this.startExplorationRoundId = null;
    this.phase = { kind: 'idle' };
    this.classification = undefined;
  }

  /**
   * Stores the mission-type classification inferred at end of discovery.
   *
   * @remarks
   * Zod-validates the value at the boundary. Invalid values are rejected
   * mechanically — callers should pass only `'business' | 'technical' | 'both'`.
   * Use {@link inferClassificationFromText} for heuristic inference from mission
   * brief or question text.
   *
   * @param value - One of `business` | `technical` | `both`.
   */
  public setClassification(value: ClassificationValue): void {
    this.classification = ClassificationSchema.parse(value);
  }

  /**
   * Transitions the session into `awaiting_gate` — the engine paused on a consent
   * gate and the next user turn must resolve it (yes / no / redirect).
   *
   * @param gate - The validated consent-gate envelope produced by the engine.
   */
  public enterGate(gate: PendingGate): void {
    this.phase = { kind: 'awaiting_gate', gate };
  }

  /**
   * Transitions the session into `exploring` — the engine is ready to produce the
   * next hop. Called on fresh SM start (post-confirm) and on gate-approved resume.
   */
  public enterExploring(): void {
    this.phase = { kind: 'exploring' };
    this.presentResultCalledThisTurn = false;
  }

  /**
   * Transitions the session into `idle` — no exploration is active, next turn
   * enters discovery. Use {@link resetExploration} when exploration state itself
   * also needs clearing.
   */
  public enterIdle(): void {
    this.phase = { kind: 'idle' };
  }

  /**
   * Transitions the session into `completed` — synthesis finished, archive survives
   * on the session singleton. Next user turn routes through the follow-up protocol
   * (refinement without a fresh exploration). Call only when
   * `stateMachine?.status === 'complete'`.
   */
  public enterCompleted(): void {
    this.phase = { kind: 'completed' };
  }

  /**
   * Rotates the session identifier and resets the start timer.
   */
  public regenerateSessionId(): void {
    this.id = this.generateId();
    this.startTime = Date.now();
    this.lastActivity = this.startTime;
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
   * @param fullResult - The raw completion result from the state machine.
   */
  public storeSmResult(fullResult: SmResult): void {
    const sourceMode = this.stateMachine?.columnAspect ? 'column_trace' : 'blackboard';
    const verdicts: Record<string, NodeRole> = {};

    for (const n of fullResult.fullNodes) {
      verdicts[n.id] = (n.role as NodeRole) || 'noted';
    }

    // B-1: preserve any synthesized body fields written by a prior present_result call.
    // storeSmResult fires at exploration completion AND on supplement rounds; in the
    // supplement case the prior description should survive until the new present_result
    // overwrites it explicitly. Without this guard, follow-up rounds blank the description.
    const prior = this.resultGraph;
    this.resultGraph = {
      nodeIds: fullResult.fullNodes.map(n => n.id),
      edges: fullResult.edges,
      verdicts,
      source: sourceMode,
      originNodeId: fullResult.originNodeId,
      notes: (fullResult.detail_slots || []).map(s => ({
        nodeId: s.nodeId,
        summary: s.note_caption || s.summary || ''
      })),
      suggested_labels: (fullResult.detail_slots || [])
        .filter(s => s.badge_label)
        .map(s => ({ node_id: s.nodeId, text: s.badge_label! })),
      suggested_notes: (fullResult.detail_slots || [])
        .filter(s => s.note_caption)
        .map(s => ({ node_id: s.nodeId, text: s.note_caption! })),
      suggested_sections: fullResult.suggested_sections,
      description: prior?.description,
      summary: prior?.summary,
      title: prior?.title,
      intro: prior?.intro,
      closing: prior?.closing,
      sections: prior?.sections,
    };
  }

  /**
   * Generates a high-level summary of the session's current status.
   * 
   * @returns A `SessionSummary` object for logging and UI updates.
   */
  public getSummary(): SessionSummary {
    return {
      id: this.id,
      projectName: this.projectName,
      modelNodes: this.model?.nodes.length ?? 0,
      visitedNodes: this.memory.slotCount,
      coveragePct: this.stateMachine?.coveragePct ?? 0,
      hopCount: this.hopCount,
    };
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
  if (!(globalThis as any)[GLOBAL_SESSION_KEY]) {
    (globalThis as any)[GLOBAL_SESSION_KEY] = new AiSession();
  }
  return (globalThis as any)[GLOBAL_SESSION_KEY];
}
