import type Graph from 'graphology';
import type { DatabaseModel } from '../engine/types';
import type { SerializedFilterState, FilterProfile } from '../engine/projectStore';
import { ColumnStore } from '../engine/columnStore';
import { AiMemoryManager } from './memoryManager';
import { type ResultGraph, type AiOutputTemplates, EMPTY_AI_TEMPLATES, type SessionSummary, type NodeRole } from './types';
import type { IHopStateMachine } from './smBase';
import type { HopLogEntry } from './smTypes';

/**
 * AI Session Container — The "Clean Slate" for @lineage investigations.
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
  public hopLog: HopLogEntry[] = [];
  
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

  public isStale(): boolean {
    const ONE_HOUR_MS = 1 * 60 * 60 * 1000;
    return (Date.now() - this.startTime) > ONE_HOUR_MS;
  }

  public resetIfStale(): void {
    if (this.isStale() || this.stateMachine?.status === 'complete') {
      this.resetExploration();
      this.regenerateSessionId();
    }
  }

  private generateId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  }

  public resetExploration(): void {
    this.memory.reset();
    this.stateMachine = null;
    this.resultGraph = null;
    this.hopCount = 0;
    this.hopLog = [];
  }

  public regenerateSessionId(): void {
    this.id = this.generateId();
    this.startTime = Date.now();
  }

  /** 
   * Unified result storage.
   * Maps NavigationEngine output to the ResultGraph format used by ViewSynthesisService.
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

  /** Legacy CT mapping — now redirects to unified storeBbResult. */
  public storeCtResult(fullResult: any): void {
    this.storeBbResult(fullResult);
  }

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

export function getSession(): AiSession {
  if (!(globalThis as any)[GLOBAL_SESSION_KEY]) {
    (globalThis as any)[GLOBAL_SESSION_KEY] = new AiSession();
  }
  return (globalThis as any)[GLOBAL_SESSION_KEY];
}
