import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../components/CustomNode';

/**
 * Export the current React Flow graph to Draw.io (.drawio) XML format.
 * TODO: Full implementation pending.
 */
export function exportToDrawio(
  _nodes: FlowNode<CustomNodeData>[],
  _edges: FlowEdge[],
  _schemas: string[],
): string {
  return '';
}
