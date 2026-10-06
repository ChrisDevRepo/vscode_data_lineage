/**
 * Synthetic model fixture for engine tests: a graph given as plain nodes and edges, built into the
 * `DatabaseModel` and graphology graph a `NavigationEngine` takes. NOT a test file.
 */
import { NavigationEngine } from '../../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageEdge, LineageNode, ObjectType } from '../../../../src/engine/types';
import { makeGraph } from '../../helpers/testUtils';
import { makeModel, makeNode } from './fixtures';

type NodeKind = 'table' | 'view' | 'procedure' | 'function';

/** One synthetic node. Procedures declare no columns, as in the loaded model. */
export interface GNode { id: string; type: NodeKind; columns: string[] }
/** One dependency edge `source -> target`; a procedure source is a write, anything else a read. */
export interface GEdge { source: string; target: string; type: 'body' | 'exec' }
/** A synthetic graph and its origin. */
export interface GraphSpec { nodes: GNode[]; edges: GEdge[]; origin: string }

export interface Built {
  model: DatabaseModel;
  graph: ReturnType<typeof makeGraph>;
  nodeById: Map<string, GNode>;
}

export function buildModel(spec: GraphSpec): Built {
  const column = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
  const nodes: LineageNode[] = spec.nodes.map(n => makeNode({
    id: n.id, name: n.id.slice(4), schema: 'dbo', type: n.type as ObjectType,
    columns: n.columns.map(column),
    ...(n.type === 'procedure' ? { bodyScript: `-- ${n.id}` } : {}),
  }));
  const model = makeModel(nodes, spec.edges.map(e => [e.source, e.target] as const), ['dbo']);
  (model as { edges: LineageEdge[] }).edges = spec.edges.map(e => ({ source: e.source, target: e.target, type: e.type }));
  const index: Record<string, { in: string[]; out: string[] }> = {};
  for (const n of spec.nodes) index[n.id.toLowerCase()] = { in: [], out: [] };
  for (const e of spec.edges) {
    index[e.target.toLowerCase()]?.in.push(e.source);
    index[e.source.toLowerCase()]?.out.push(e.target);
  }
  (model as { neighborIndex: unknown }).neighborIndex = index;
  const graph = makeGraph(nodes, spec.edges.map(e => [e.source, e.target] as [string, string]));
  return { model, graph, nodeById: new Map(spec.nodes.map(n => [n.id, n])) };
}

export function newEngine(built: Built): NavigationEngine {
  return new NavigationEngine(built.model, built.graph, () => {}, {});
}
