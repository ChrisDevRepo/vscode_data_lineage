import type Graph from 'graphology';
import type { DatabaseModel } from '../engine/types';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';
import { ColumnStore } from '../engine/columnStore';
import { AiMemoryManager } from './memoryManager';
import { type ResultGraph, type AiOutputTemplates, EMPTY_AI_TEMPLATES, type SessionSummary, type NodeRole } from './types';
import type { IHopStateMachine } from './smBase';
import type { HopLogEntry } from './smTypes';
import type { SessionPhase, PendingGate } from './sessionPhase';

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
  /** Last enrich_view description string — surfaced in chat by the "Show full description" chip. */
  public lastEnrichViewDescription: string | null = null;
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
  }

  /**
   * Determines if the session has exceeded its maximum operational lifetime.
   *
   * @returns `true` if the session is older than 30 minutes.
   */
  public isStale(): boolean {
    const STALE_AFTER_MS = 30 * 60 * 1000;
    return (Date.now() - this.startTime) > STALE_AFTER_MS;
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
    this.lastEnrichViewDescription = null;
    this.hopCount = 0;
    this.hopLog = [];
    this.pendingUserNotice.clear();
    this.startExplorationRoundId = null;
    this.phase = { kind: 'idle' };
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
   * Rotates the session identifier and resets the start timer.
   */
  public regenerateSessionId(): void {
    this.id = this.generateId();
    this.startTime = Date.now();
  }

  /** 
   * Transmutes State Machine findings into the visual ResultGraph format.
   * 
   * @remarks
   * Maps navigation engine output (nodes, edges, detail slots) to the
   * standard contract consumed by the `enrich_view` tool handler and the React webview.
   * 
   * @param fullResult - The raw completion result from the State Machine.
   */
  public storeBbResult(fullResult: any): void {
    const sourceMode = this.stateMachine?.mode ?? 'blackboard';
    const verdicts: Record<string, NodeRole> = {};
    
    for (const n of fullResult.fullNodes) {
      verdicts[n.id] = (n.role as NodeRole) || 'noted';
    }

    this.resultGraph = {
      nodeIds: fullResult.fullNodes.map((n: any) => n.id),
      edges: fullResult.edges,
      verdicts,
      source: sourceMode,
      originNodeId: fullResult.originNodeId,
      notes: (fullResult.detail_slots || []).map((s: any) => ({
        nodeId: s.nodeId,
        summary: s.note_caption || s.summary || ''
      })),
      suggested_labels: (fullResult.detail_slots || [])
        .filter((s: any) => s.badge_label)
        .map((s: any) => ({ node_id: s.nodeId, text: s.badge_label })),
      suggested_notes: (fullResult.detail_slots || [])
        .filter((s: any) => s.note_caption)
        .map((s: any) => ({ node_id: s.nodeId, text: s.note_caption })),
      suggested_sections: fullResult.suggested_sections,
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
