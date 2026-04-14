import type Graph from 'graphology';
import type { DatabaseModel } from '../engine/types';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';
import type { ColumnStore } from '../engine/columnStore';
import { AiMemoryManager } from './memoryManager';
import type { ResultGraph, AiOutputTemplates, EMPTY_AI_TEMPLATES, SessionSummary, NodeRole } from './types';
import type { IHopStateMachine } from './smBase';

/**
 * AI Session Container — The "Clean Slate" for @lineage investigations.
 * 
 * Replaces global module-level variables in extension.ts to ensure
 * atomic session wipes and thread-safe exploration of complex lineages.
 */
export class AiSession {
  public readonly id: string;
  public readonly memory: AiMemoryManager;
  
  // ── Environment State ──
  public model: DatabaseModel | null = null;
  public graph: Graph | null = null;
  public filter: SerializedFilterState | null = null;
  public views: FilterProfile[] = [];
  public projectName: string | null = null;
  public currentProjectId: string | null = null;
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
    this.id = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.memory = new AiMemoryManager();
    this.columnStore = new ColumnStore();
    this.outputTemplates = templates ?? { 
      summary: '', description: '', sections: '', highlights: '', notes: '' 
    };
    this.startTime = Date.now();
  }

  /** Wipe memory and state machines for a fresh start within the same model/project. */
  public resetExploration(): void {
    this.memory.reset();
    this.stateMachine = null;
    this.resultGraph = null;
    this.hopCount = 0;
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
