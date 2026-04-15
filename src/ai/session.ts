import type Graph from 'graphology';
import type { DatabaseModel } from '../engine/types';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';
import { ColumnStore } from '../engine/columnStore';
import { AiMemoryManager } from './memoryManager';
import { type ResultGraph, type AiOutputTemplates, EMPTY_AI_TEMPLATES, type SessionSummary, type NodeRole } from './types';
import type { IHopStateMachine } from './smBase';

/**
 * AI Session Container — The "Clean Slate" for @lineage investigations.
 * 
 * Replaces global module-level variables in extension.ts to ensure
 * atomic session wipes and thread-safe exploration of complex lineages.
 */
export class AiSession {
  public id: string;
  public readonly memory: AiMemoryManager;
  
  // ── Environment State ──
  public model: DatabaseModel | null = null;
  public graph: Graph | null = null;
  public filter: SerializedFilterState | null = null;
  public views: FilterProfile[] = [];
  public projectName: string | null = null;
  public currentProjectId: string | null = null;
  public isDbSession = false;
  public columnStore: ColumnStore;

  // ── AI reasoning State ──
  public stateMachine: IHopStateMachine | null = null;
  public resultGraph: ResultGraph | null = null;
  public outputTemplates: AiOutputTemplates;
  public maxInputTokens = 32000;
  public modelName = '';
  
  // ── Telemetry / Log Correlation ──
  public startTime: number;
  public hopCount = 0;

  constructor(templates?: AiOutputTemplates) {
    this.id = this.generateId();
    this.memory = new AiMemoryManager();
    this.columnStore = new ColumnStore();
    this.outputTemplates = templates ?? { ...EMPTY_AI_TEMPLATES };
    this.startTime = Date.now();
  }

  /** Check if the session is older than 2 hours (stale). */
  public isStale(): boolean {
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    return (Date.now() - this.startTime) > TWO_HOURS_MS;
  }

  /** Silently reset the session if it is stale or already complete. */
  public resetIfStale(): void {
    if (this.isStale() || this.stateMachine?.status === 'complete') {
      this.resetExploration();
      this.regenerateSessionId();
    }
  }

  private generateId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  }

  /** Wipe memory and state machines for a fresh start within the same model/project. */
  public resetExploration(): void {
    this.memory.reset();
    this.stateMachine = null;
    this.resultGraph = null;
    this.hopCount = 0;
  }

  /** Generate a new session ID to distinguish independent chat sessions. */
  public regenerateSessionId(): void {
    this.id = this.generateId();
    this.startTime = Date.now();
  }

  /** Store a result graph from Blackboard mode. */
  public storeBbResult(fullResult: {
    originNodeId: string;
    notes: Array<{ nodeId: string; summary: string }>;
    fullNodes: Array<Record<string, unknown>>;
    edges: [string, string, string][];
    suggested_labels?: Array<{ node_id: string; text: string }>;
    suggested_notes?: Array<{ node_id: string; text: string }>;
    suggested_sections?: Array<{ label: string; node_ids: string[] }>;
  }): void {
    const verdicts: Record<string, NodeRole> = {};
    for (const n of fullResult.fullNodes) {
      const id = n.id as string;
      verdicts[id] = ((n.role as string | undefined) ?? 'noted') as NodeRole;
    }
    const nodeIds = fullResult.fullNodes.map(n => n.id as string);
    
    this.resultGraph = {
      nodeIds,
      edges: fullResult.edges,
      verdicts,
      source: 'blackboard',
      originNodeId: fullResult.originNodeId,
      notes: fullResult.notes.map(n => ({ nodeId: n.nodeId, summary: n.summary })),
      suggested_labels: fullResult.suggested_labels,
      suggested_notes: fullResult.suggested_notes,
      suggested_sections: fullResult.suggested_sections,
    };
  }

  /** Store a result graph from Column Trace mode. */
  public storeCtResult(fullResult: {
    originNodeId: string;
    chain: Array<{ nodeId: string; name: string; summary: string; notes?: string }>;
    fullNodes: Array<Record<string, unknown>>;
    edges: [string, string, string][];
    outOfScope: Array<{ nodeId: string }>;
    suggested_labels: Array<{ node_id: string; text: string }>;
    suggested_notes:  Array<{ node_id: string; text: string }>;
    suggested_sections: Array<{ label: string; node_ids: string[] }>;
  }): void {
    const chainIds = new Set(fullResult.chain.map(c => c.nodeId));
    const allNodeIds = fullResult.fullNodes.map(n => n.id as string);
    const verdicts: Record<string, NodeRole> = {};
    
    for (const id of allNodeIds) {
      verdicts[id] = chainIds.has(id) ? 'trace' : 'pass';
    }
    for (const o of fullResult.outOfScope) {
      verdicts[o.nodeId] = 'prune';
    }

    this.resultGraph = {
      nodeIds: allNodeIds,
      edges: fullResult.edges,
      verdicts,
      source: 'column_trace',
      originNodeId: fullResult.originNodeId,
      notes: fullResult.chain.map(c => ({ nodeId: c.nodeId, summary: c.summary })),
      suggested_labels: fullResult.suggested_labels,
      suggested_notes:  fullResult.suggested_notes,
      suggested_sections: fullResult.suggested_sections,
    };
  }

  /** Get high-level summary for display or debugging. */
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

// ─── Singleton Management ────────────────────────────────────────────────────

const GLOBAL_SESSION_KEY = '__VSCODE_DL_AI_SESSION__';

/**
 * Get the global AI session singleton.
 * Note: Only one model/panel is active at a time, so a global singleton is safe.
 * Chat sessions are reset based on history age to prevent cross-window leaks.
 */
export function getSession(): AiSession {
  if (!(globalThis as any)[GLOBAL_SESSION_KEY]) {
    (globalThis as any)[GLOBAL_SESSION_KEY] = new AiSession();
  }
  return (globalThis as any)[GLOBAL_SESSION_KEY];
}
