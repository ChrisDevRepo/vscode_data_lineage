import type Graph from 'graphology';
import type { DatabaseModel } from '../engine/types';
import type { FilterProfile, SerializedFilterState } from '../engine/projectStore';
import type { ColumnStore } from '../engine/columnStore';
import type { ShortMemory, DetailSlot } from './memoryManager';

/** Node roles for graph visualization and AI reasoning. */
export type NodeRole = 'trace' | 'pass' | 'prune' | 'noted' | 'bridge' | 'origin' | 'relevant';

/** 
 * Stored result graph — populated by CT/BB, consumed by enrich_view.
 * This represents the "grounded findings" of an AI session.
 */
export interface ResultGraph {
  nodeIds: string[];
  edges: [string, string, string][];
  verdicts: Record<string, NodeRole>;
  source: 'column_trace' | 'blackboard';
  originNodeId?: string;  // root node — needed by bfsDepthMap() in orderAndAssemble()
  notes?: Array<{ nodeId: string; summary: string }>;  // BB/CT note summaries for enrich_view auto-populate
  suggested_labels?: Array<{ node_id: string; text: string }>;  // SM: BB from badge_label, CT from chain name
  suggested_notes?: Array<{ node_id: string; text: string }>;   // SM: BB from note_caption, CT from notes/summary
  suggested_sections?: Array<{ label: string; node_ids: string[] }>;  // SM: grouped badge_labels, depth-ordered
}

/** AI output template instructions — loaded from YAML at activation. */
export interface AiOutputTemplates {
  summary: string;
  description: string;
  sections: string;
  highlights: string;
  notes: string;
}

export const EMPTY_AI_TEMPLATES: AiOutputTemplates = { 
  summary: '', 
  description: '', 
  sections: '', 
  highlights: '', 
  notes: '' 
};

/** High-level summary of a session's state for logging and UI. */
export interface SessionSummary {
  id: string;
  projectName: string | null;
  modelNodes: number;
  visitedNodes: number;
  coveragePct: number;
  hopCount: number;
}
