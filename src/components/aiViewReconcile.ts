import type { DatabaseModel } from '../engine/types';
import type { AIViewMetadata } from '../engine/projectStore';
import { resolveModelNodeId } from '../ai/infra/inputNormalization';

export interface ReconciledAiView {
  nodeIds: string[];
  unresolved: string[];
  metadata: AIViewMetadata;
}

/** Canonicalizes every AI-preview node reference against the loaded render model. */
export function reconcileAiView(nodeIds: string[], metadata: AIViewMetadata, model: DatabaseModel): ReconciledAiView {
  const nodeMap = new Map<string, unknown>(model.nodes.map(node => [node.id, node]));
  const canonicalize = (id: string): string | null => resolveModelNodeId(id, nodeMap);

  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of nodeIds) {
    const id = canonicalize(raw);
    if (!id) {
      unresolved.push(raw);
    } else if (!seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  }

  const mapIds = (ids: string[]): string[] => ids.map(canonicalize).filter((id): id is string => id !== null);
  const remapNodeText = <T extends { nodeId: string }>(items: T[]): T[] => items.flatMap(item => {
    const nodeId = canonicalize(item.nodeId);
    return nodeId ? [{ ...item, nodeId }] : [];
  });

  const reconciled: AIViewMetadata = {
    ...metadata,
    highlightGroups: metadata.highlightGroups.map(group => ({ ...group, nodeIds: mapIds(group.nodeIds) })),
    badges: remapNodeText(metadata.badges),
    ...(metadata.notes ? { notes: remapNodeText(metadata.notes) } : {}),
    ...(metadata.columnAspect ? {
      columnAspect: {
        edges: metadata.columnAspect.edges.map(edge => ({
          ...edge,
          hopNode: canonicalize(edge.hopNode) ?? edge.hopNode,
          fromNode: canonicalize(edge.fromNode) ?? edge.fromNode,
          toNode: canonicalize(edge.toNode) ?? edge.toNode,
        })),
      },
    } : {}),
  };

  return { nodeIds: resolved, unresolved, metadata: reconciled };
}
