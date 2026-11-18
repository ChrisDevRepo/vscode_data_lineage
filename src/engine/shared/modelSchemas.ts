/** Schema metrics shared by the model builder (host) and the in-webview Visualize scoping. */
import { LineageNode, SchemaInfo, createEmptySchemaInfo } from '../types';
import { schemaKey } from '../../utils/sql';

/** Computes schema metrics from the resolved node list, sorted by node count. */
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
