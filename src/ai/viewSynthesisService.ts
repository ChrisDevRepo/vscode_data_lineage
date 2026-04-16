import * as vscode from 'vscode';
import { DatabaseModel } from '../engine/types';
import { AiSession } from './session';
import { autoFixEnrichView, validateEnrichView, orderAndAssemble, EnrichViewInput } from './tools';
import { edgeApiType } from './aiPresenter';
import { AIViewMetadata } from '../engine/projectStore';

export class ViewSynthesisService {
  constructor(
    private session: AiSession,
    private getPanel: () => vscode.WebviewPanel | undefined
  ) {}

  public synthesizeView(
    model: DatabaseModel,
    input: EnrichViewInput
  ): { success: boolean; view_name?: string; node_count?: number; graph_source?: string; errors?: string[] } {
    let resolvedNodeIds: string[];
    let resolvedEdges: [string, string, string][];
    let graphSource: string;

    if (this.session.resultGraph) {
      resolvedNodeIds = [...this.session.resultGraph.nodeIds];
      resolvedEdges = [...this.session.resultGraph.edges];
      graphSource = this.session.resultGraph.source;

      if (input.is_update) {
        // Incremental add
        if (input.add_node_ids?.length) {
          const currentSet = new Set(resolvedNodeIds);
          const toAdd = input.add_node_ids.filter(id => model.nodes.some(n => n.id === id) && !currentSet.has(id));
          resolvedNodeIds.push(...toAdd);
          // Discover edges between existing and new nodes
          const newSet = new Set(resolvedNodeIds);
          const allPossibleEdges: [string, string, string][] = [];
          for (const e of model.edges) {
            if (newSet.has(e.source) && newSet.has(e.target)) {
              allPossibleEdges.push([e.source, e.target, edgeApiType(e.type)]);
            }
          }
          resolvedEdges = allPossibleEdges;
        }
      }

      if (input.prune_node_ids?.length) {
        const pruneSet = new Set(input.prune_node_ids);
        resolvedNodeIds = resolvedNodeIds.filter(id => !pruneSet.has(id));
        resolvedEdges = resolvedEdges.filter(([src, tgt]) => !pruneSet.has(src) && !pruneSet.has(tgt));
      }
    } else {
      return {
        success: false,
        errors: ['No state-machine result available — enrich_view requires a completed column_trace or blackboard exploration.'],
      };
    }

    if (this.session.resultGraph?.notes?.length) {
      const userNoteIds = new Set((input.notes ?? []).map(n => (n as any).node_id as string));
      const autoNotes: Array<{ node_id: string; text: string }> = [];
      const resolvedSet = new Set(resolvedNodeIds);
      for (const { nodeId, summary } of this.session.resultGraph.notes) {
        if (resolvedSet.has(nodeId) && !userNoteIds.has(nodeId) && summary) {
          autoNotes.push({ node_id: nodeId, text: summary });
        }
      }
      if (autoNotes.length > 0) input.notes = [...(input.notes ?? []), ...autoNotes];
    }

    if (this.session.resultGraph?.suggested_labels?.length && input.sections?.length) {
      const hasNodeIds = input.sections.some(s => s.node_ids && s.node_ids.length > 0);
      if (!hasNodeIds) {
        const stripNum = (s: string) => s.replace(/^\d+[\.\s]+/, '').trim();
        const labelToNodeIds = new Map<string, string[]>();
        for (const sl of this.session.resultGraph.suggested_labels) {
          if (!sl.text) continue;
          const label = stripNum(sl.text);
          if (!labelToNodeIds.has(label)) labelToNodeIds.set(label, []);
          labelToNodeIds.get(label)!.push(sl.node_id);
        }
        input.sections = input.sections.map(sec => {
          const norm = stripNum(sec.label);
          const ids = labelToNodeIds.get(norm);
          if (ids?.length) return { ...sec, node_ids: ids };
          return sec;
        });
      }
    }

    let assembledBadges: Array<{ node_id: string; text: string }> = [];
    if (input.sections?.length) {
      const assembled = orderAndAssemble(input.sections, { title: input.title, intro: input.intro, closing: input.closing });
      assembledBadges = assembled.badges;
      if (!input.description) input.description = assembled.description;
      input.sections = undefined;
    }

    const { input: fixedInput } = autoFixEnrichView(model, input, resolvedNodeIds);
    const validation = validateEnrichView(fixedInput, resolvedNodeIds, assembledBadges);
    
    if (!validation.success) {
        // We handle the return shape that caller expects
        return validation as any;
    }

    const aiMetadata: AIViewMetadata = {
      summary: validation.summary,
      description: validation.description,
      createdAt: new Date().toISOString(),
      modelName: this.session.modelName || 'unknown',
      highlightGroups: validation.highlight_groups.map(g => ({ label: g.label, color: g.color, nodeIds: g.node_ids })),
      badges: validation.badges.map(b => ({ nodeId: b.node_id, text: b.text })),
      notes: validation.notes.map(n => ({ nodeId: n.node_id, text: n.text })),
      layoutDirection: validation.layout_direction,
    };
    
    const panel = this.getPanel();
    if (panel) {
      panel.webview.postMessage({ type: 'ai-view-preview', name: validation.name, nodeIds: validation.node_ids, aiMetadata });
      panel.reveal(vscode.ViewColumn.One);
    }

    // Persist the updated state back to sess.resultGraph if it's an update
    if (input.is_update && this.session.resultGraph) {
      this.session.resultGraph.nodeIds = resolvedNodeIds;
      this.session.resultGraph.edges = resolvedEdges;
      // Merge notes
      const existingNotes = new Map((this.session.resultGraph.notes || []).map(n => [n.nodeId, n]));
      for (const n of validation.notes) {
        existingNotes.set(n.node_id, { nodeId: n.node_id, summary: n.text });
      }
      this.session.resultGraph.notes = Array.from(existingNotes.values());
    }

    return { success: true, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource };
  }
}
