import type Graph from 'graphology';
import type { DatabaseModel } from '../engine/types';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';
import { ColumnStore } from '../engine/columnStore';
import { AiMemoryManager } from './memoryManager';
import { type ResultGraph, type AiOutputTemplates, EMPTY_AI_TEMPLATES, type SessionSummary, type NodeRole } from './types';
import type { IHopStateMachine } from './smBase';
import type { HopLogEntry } from './smTypes';

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

  // ── User-facing notice queue (drained by runWithTools into stream.markdown) ──
  /** Set-keyed notice queue — natural de-dupe across parallel tool calls. */
  public pendingUserNotice: Set<string> = new Set();

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
   */
  public resetExploration(): void {
    this.memory.reset();
    this.stateMachine = null;
    this.resultGraph = null;
    this.hopCount = 0;
    this.hopLog = [];
    this.pendingUserNotice.clear();
    this.startExplorationRoundId = null;
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
   * standard contract consumed by `ViewSynthesisService` and the React webview.
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
   * Persists a partial `resultGraph` when the exploration loop exits without the
   * state machine reaching `complete` (e.g. `MAX_ROUNDS` cap hit).
   *
   * @remarks
   * Delegates to {@link storeBbResult} with whatever `getResult()` assembles from
   * the analyzed detail slots, then flags the graph `partial: true` with coverage
   * counts so downstream consumers (`enrich_view`, the "Show in Graph" button)
   * can surface the partial state instead of erroring out.
   */
  public storeBbResultPartial(): void {
    const sm = this.stateMachine;
    if (!sm) return;
    const dump = sm.toJSON() as { scopeSize?: number; visited?: string[] };
    const analyzed = this.memory.slotCount;
    const total = dump.scopeSize ?? analyzed;
    const partialResult: any = (sm as any).getResult?.();
    if (!partialResult || !partialResult.fullNodes?.length) return;

    this.storeBbResult(partialResult);
    if (this.resultGraph) {
      this.resultGraph.partial = true;
      this.resultGraph.partialCoverage = { analyzed, total };
    }
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
