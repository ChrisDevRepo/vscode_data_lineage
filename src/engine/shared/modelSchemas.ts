import { createEmptySchemaInfo, type LineageNode, type SchemaInfo } from '../types';
import { schemaKey } from '../../utils/sql';

/**
 * Computes architectural schema metrics from the resolved node list.
 *
 * @param nodes - All discovered lineage nodes.
 * @returns An array of schema info objects, sorted by node count.
 */
export function computeSchemas(nodes: LineageNode[], identifierCaseSensitive = false): SchemaInfo[] {
  const map = new Map<string, SchemaInfo>();
  for (const node of nodes) {
    if (node.externalType === 'file' || node.externalType === 'db') continue;
    const key = schemaKey(node.schema, identifierCaseSensitive);
    let info = map.get(key);
    if (!info) {
      info = createEmptySchemaInfo(node.schema);
      map.set(key, info);
    }
    info.nodeCount++;
    info.types[node.type]++;
  }
  return Array.from(map.values()).sort((a, b) => b.nodeCount - a.nodeCount);
}
