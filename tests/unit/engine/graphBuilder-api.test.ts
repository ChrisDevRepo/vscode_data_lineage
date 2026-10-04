/**
 * Covers the host-side exported `graphBuilder` surface that no test named: pathfinding,
 * the layout engine and its cache (including worker-computed seeding), graph metrics, and
 * the no-layout build.
 *
 * These sit between the BFS trace and what the user sees. A defect here shows as a
 * correct trace rendered wrongly — a node missing from the view, an edge dropped —
 * which no analysis-level test can detect.
 *
 * `applyTraceToFlow` is covered in tests/unit/webview/applyTraceToFlow.test.ts: it runs
 * only under the webview hook, and its warning path reaches `window`.
 */

import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  buildGraphNoLayout,
  buildGraphologyGraph,
  buildSchemaGraph,
  buildExpandedSchemaViewGraph,
  computeShortestPath,
  dagreLayout,
  getGraphMetrics,
  hasCachedLayout,
  layoutCacheKey,
  objectLayoutInput,
  objectLayoutInputForGraph,
  runDagre,
  seedLayoutCache,
  traceNodeIdsWithLevels,
  traceNodeWithLevels,
} from '../../../src/engine/graphBuilder';
import { buildWebviewCsp } from '../../../src/utils/cspBuilder';
import { buildModel } from '../../../src/engine/modelBuilder';
import { buildColumnTraceView, columnRowKey, type ColumnTraceRelation } from '../../../src/engine/columnTraceView';
import { normalizeColName, schemaKey } from '../../../src/utils/sql';
import { DEFAULT_CONFIG, type DatabaseModel, type ExtractedObject } from '../../../src/engine/types';
import { loadAdventureWorksModel, loadParseRules, makeGraph } from '../helpers/testUtils';

/** `A → B → C`, plus `D` joining at `C`, and an unreachable `Z`. */
function chain() {
  return makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'Z' }],
    [['A', 'B'], ['B', 'C'], ['D', 'C']],
  );
}

describe('schema palette source identity', () => {
  it.each([false, true])('carries dirty SQL and metadata identity from parsing through object and column views (CS=%s)', cs => {
    loadParseRules();
    const columns = (cs ? ['Value', 'value'] : ['Value']).map((name, index) => ({
      name, type: index === 0 ? 'int' : 'money', nullable: 'No', extra: '',
    }));
    const objects: ExtractedObject[] = [
      { fullName: '[Sales].[Source]', type: 'table', columns },
      { fullName: '[sales].[Source]', type: 'table', columns },
      { fullName: '[Sales].[Report]', type: 'view', columns,
        bodyScript: 'cReAtE ViEw Sales.Report AS SELECT * FROM "Sales"."Source" /* source */ UNION ALL SELECT * FROM [sales].[Source];' },
      { fullName: '[Sales].[report]', type: 'view', columns,
        bodyScript: 'CREATE VIEW Sales.report AS SELECT * FROM Sales.Source;' },
      { fullName: '[Sales].[WrongCase]', type: 'view', columns,
        bodyScript: 'CREATE VIEW Sales.WrongCase AS SELECT * FROM [SALES].[SOURCE];' },
    ];
    const model = buildModel(objects, [], objects, undefined, true, undefined, cs);
    const { graph, flowNodes } = buildGraphNoLayout(model);
    expect(model.nodes).toHaveLength(cs ? 5 : 3);
    expect(buildSchemaGraph(graph).nodes).toHaveLength(cs ? 2 : 1);
    expect(graph.size).toBe(cs ? 3 : 2);
    expect(flowNodes.map(node => node.data.label)).toEqual(cs
      ? ['Source', 'Source', 'Report', 'report', 'WrongCase'] : ['Source', 'Report', 'WrongCase']);
    const source = model.nodes.find(node => node.schema === 'Sales' && node.name === 'Source')!;
    const target = model.nodes.find(node => node.name === 'Report')!;
    const relations: ColumnTraceRelation[] = (cs ? ['[Value]', '"value"'] : ['[VALUE]']).map(column => ({
      hopNode: target.id, fromNode: source.id, fromCol: column, toNode: target.id, toCol: column,
    }));
    if (cs) {
      const twinSource = model.nodes.find(node => node.schema === 'sales')!;
      relations.push({ hopNode: target.id, fromNode: twinSource.id, fromCol: 'Value', toNode: target.id, toCol: 'Value' });
    }
    const view = buildColumnTraceView({
      identifierCaseSensitive: model.identifierCaseSensitive, relations, config: DEFAULT_CONFIG,
      objects: new Map(model.nodes.map(node => [schemaKey(node.id, cs), {
        id: node.id, label: node.name, schema: node.schema, objectType: node.type,
        columnNames: new Map(node.columns!.map(column => [normalizeColName(column.name, cs), column.name])),
        columnTypes: new Map(node.columns!.map(column => [normalizeColName(column.name, cs), column.type])),
      }])),
    });
    expect(view.nodes.find(node => node.id === source.id)?.rows.map(row => [row.name, row.dataType]))
      .toEqual(cs ? [['Value', 'int'], ['value', 'money']] : [['Value', 'int']]);
    expect(view.edges.map(edge => [edge.sourceColumn, edge.targetColumn]))
      .toEqual(cs ? [['Value', 'Value'], ['value', 'value'], ['Value', 'Value']] : [['Value', 'Value']]);
    expect(new Set(view.nodes.flatMap(node => node.rows.map(row => columnRowKey(node.id, row.name, cs)))).size)
      .toBe(cs ? 5 : 2);
  });

  it.each([false, true])('preserves the model comparison policy across schema views (CS=%s)', cs => {
    const model: DatabaseModel = {
      identifierCaseSensitive: cs,
      nodes: ['Sales', 'sales'].map(schema => ({
        id: `[${schema}].[Orders]`, schema, name: 'Orders', type: 'table', fullName: `${schema}.Orders`,
      })),
      edges: [], schemas: [], catalog: {}, neighborIndex: {},
    };
    const graph = buildGraphologyGraph(model);
    expect(graph.getAttribute('identifierCaseSensitive')).toBe(cs);
    const overview = buildSchemaGraph(graph);
    const colors = overview.nodes.map(node => node.data.color);
    expect(colors[0] === colors[1]).toBe(!cs);
    const expanded = buildExpandedSchemaViewGraph(graph, new Set(['Sales']), null);
    const object = expanded.flowNodes.find(node => node.type !== 'schemaNode')!;
    const cluster = expanded.flowNodes.find(node => node.type === 'schemaNode')!;
    expect(object.data.schemaColor).toBe(overview.nodes.find(node => node.data.schemaName === 'Sales')?.data.color);
    expect(cluster.data.color).toBe(overview.nodes.find(node => node.data.schemaName === 'sales')?.data.color);
    expect(dagreLayout({ nodeIds: [], edges: [], config: DEFAULT_CONFIG }).size).toBe(0);
  });
});


describe('computeShortestPath', () => {
  it('returns every node and edge along a directed path', () => {
    const result = computeShortestPath(chain(), 'A', 'C');
    expect(result).not.toBeNull();
    expect([...result!.nodeIds]).toEqual(['A', 'B', 'C']);
    expect(result!.edgeIds.size).toBe(2);
  });

  it('finds the path when the endpoints are given in reverse (bidirectional retry)', () => {
    const result = computeShortestPath(chain(), 'C', 'A');
    expect(result).not.toBeNull();
    expect(result!.nodeIds).toEqual(new Set(['A', 'B', 'C']));
  });

  it('returns the single node for a path from a node to itself', () => {
    expect([...computeShortestPath(chain(), 'A', 'A')!.nodeIds]).toEqual(['A']);
  });

  it.each([
    ['unknown source', 'nope', 'C'],
    ['unknown target', 'A', 'nope'],
    ['no connecting path', 'A', 'Z'],
  ])('returns null for %s', (_label, source, target) => {
    expect(computeShortestPath(chain(), source, target)).toBeNull();
  });
});


describe('getGraphMetrics', () => {
  it('counts roots by in-degree and leaves by out-degree', () => {
    expect(getGraphMetrics(chain())).toEqual({
      totalNodes: 5,
      totalEdges: 3,
      rootNodes: 3,
      leafNodes: 2,
    });
  });

  it('reports an empty graph as all zeroes', () => {
    expect(getGraphMetrics(makeGraph([], []))).toEqual({
      totalNodes: 0, totalEdges: 0, rootNodes: 0, leafNodes: 0,
    });
  });
});


describe('layout cache seeding (worker prewarm)', () => {
  it('serves buildGraph from positions computed outside the cache', async () => {
    const model = await loadAdventureWorksModel();
    const config = { ...DEFAULT_CONFIG, layout: { ...DEFAULT_CONFIG.layout, nodeSeparation: DEFAULT_CONFIG.layout.nodeSeparation + 7 } };
    const input = objectLayoutInput(model, config);
    expect(hasCachedLayout(input)).toBe(false);
    const computed = runDagre(structuredClone(input));
    for (const pos of computed.values()) pos.x += 100_000;
    seedLayoutCache(input, computed);
    expect(hasCachedLayout(input)).toBe(true);
    const built = buildGraph(model, config);
    for (const node of built.flowNodes) {
      const seeded = computed.get(node.id);
      if (seeded) expect(node.position).toEqual(seeded);
    }
  });

  it('refuses to cache a layout that misses a node, such as a failed worker run', () => {
    const input = {
      nodeIds: ['Seed.A', 'Seed.B'],
      edges: [{ source: 'Seed.A', target: 'Seed.B' }],
      config: DEFAULT_CONFIG,
    };
    expect(seedLayoutCache(input, new Map())).toBe(false);
    expect(seedLayoutCache(input, new Map([['Seed.A', { x: 0, y: 0 }]]))).toBe(false);
    expect(hasCachedLayout(input)).toBe(false);
    expect([...dagreLayout(input).keys()].sort()).toEqual(['Seed.A', 'Seed.B']);
  });

  it('allows the inline layout worker in the webview CSP', () => {
    expect(buildWebviewCsp({ nonce: 'n', cspSource: 'vscode-resource:' })).toContain('worker-src blob:');
  });
});

describe('dagreLayout', () => {
  const input = () => ({
    nodeIds: ['A', 'B', 'C'],
    edges: [{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }],
    config: DEFAULT_CONFIG,
  });

  it('positions every requested node', () => {
    const positions = dagreLayout(input());
    expect([...positions.keys()].sort()).toEqual(['A', 'B', 'C']);
    for (const point of positions.values()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  });

  it('serves an identical request from the cache rather than re-running dagre', () => {
    const first = dagreLayout(input());
    expect(dagreLayout(input())).toBe(first);
  });

  it('treats a different direction as a different layout, not a cache hit', () => {
    const horizontal = dagreLayout({ ...input(), direction: 'LR' });
    expect(dagreLayout({ ...input(), direction: 'TB' })).not.toBe(horizontal);
  });

  it('treats different node sizes as a different layout — sizeOf is part of the cache key', () => {
    const narrow = dagreLayout({ ...input(), sizeOf: () => ({ width: 10, height: 10 }) });
    const wide = dagreLayout({ ...input(), sizeOf: () => ({ width: 400, height: 90 }) });
    expect(wide).not.toBe(narrow);
    const moved = ['A', 'B', 'C'].some(id => wide.get(id)!.x !== narrow.get(id)!.x || wide.get(id)!.y !== narrow.get(id)!.y);
    expect(moved).toBe(true);
  });

  it('returns an empty map for no nodes instead of throwing', () => {
    expect(dagreLayout({ nodeIds: [], edges: [], config: DEFAULT_CONFIG }).size).toBe(0);
  });

  it('serves the same cached layout regardless of node/edge array order', () => {
    const first = dagreLayout(input());
    const reordered = dagreLayout({
      nodeIds: ['C', 'A', 'B'],
      edges: [{ source: 'B', target: 'C' }, { source: 'A', target: 'B' }],
      config: DEFAULT_CONFIG,
    });
    expect(reordered).toBe(first);
  });

  it('treats a different edge set as a different layout, not a cache hit', () => {
    const first = dagreLayout(input());
    const extraEdge = dagreLayout({
      nodeIds: ['A', 'B', 'C'],
      edges: [{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }, { source: 'A', target: 'C' }],
      config: DEFAULT_CONFIG,
    });
    expect(extraEdge).not.toBe(first);
  });
});


describe('buildGraphNoLayout', () => {
  it('builds the full node and edge set with positions left at the origin', async () => {
    const model = await loadAdventureWorksModel();
    const result = buildGraphNoLayout(model);

    expect(result.flowNodes.length).toBeGreaterThan(0);
    expect(result.graph.order).toBe(result.flowNodes.length);
    for (const flowNode of result.flowNodes) {
      expect(flowNode.position).toEqual({ x: 0, y: 0 });
    }
  });
});


describe('traceNodeWithLevels — directional depth caps', () => {
  it('walks upstream only when the downstream cap is zero', () => {
    const result = traceNodeWithLevels(chain(), 'B', 1, 0);
    expect(result.nodeIds).toEqual(new Set(['A', 'B']));
  });

  it('walks downstream only when the upstream cap is zero', () => {
    const result = traceNodeWithLevels(chain(), 'B', 0, 1);
    expect(result.nodeIds).toEqual(new Set(['B', 'C']));
  });

  it('returns the origin alone when both caps are zero', () => {
    expect(traceNodeWithLevels(chain(), 'B', 0, 0).nodeIds).toEqual(new Set(['B']));
  });

  it('returns nothing for an unknown origin', () => {
    expect(traceNodeWithLevels(chain(), 'nope', 2, 2).nodeIds.size).toBe(0);
  });

  it('applies each cap to its own direction, admitting different node counts per side', () => {
    const longChain = makeGraph(
      [{ id: 'U2' }, { id: 'U1' }, { id: 'O' }, { id: 'D1' }, { id: 'D2' }, { id: 'D3' }],
      [['U2', 'U1'], ['U1', 'O'], ['O', 'D1'], ['D1', 'D2'], ['D2', 'D3']],
    );
    expect(traceNodeWithLevels(longChain, 'O', 1, 3).nodeIds)
      .toEqual(new Set(['U1', 'O', 'D1', 'D2', 'D3']));
    expect(traceNodeWithLevels(longChain, 'O', 2, 1).nodeIds)
      .toEqual(new Set(['U2', 'U1', 'O', 'D1']));
  });
});


describe('traceNodeWithLevels — edge membership', () => {
  const withBackEdge = () => makeGraph(
    [{ id: 'ORIGIN' }, { id: 'A' }, { id: 'S' }],
    [['A', 'ORIGIN'], ['S', 'A'], ['A', 'S']],
  );

  it('draws an edge between two admitted nodes even when it points away from the origin', () => {
    const traced = traceNodeWithLevels(withBackEdge(), 'ORIGIN', 2, 0);
    expect([...traced.nodeIds].sort()).toEqual(['A', 'ORIGIN', 'S']);
    expect([...traced.edgeIds].sort()).toEqual(['A→ORIGIN', 'A→S', 'S→A']);
  });

  it('draws the same edges upstream-only as it does with both directions active', () => {
    const upstreamOnly = traceNodeWithLevels(withBackEdge(), 'ORIGIN', 2, 0);
    const bothWays = traceNodeWithLevels(withBackEdge(), 'ORIGIN', 2, 2);
    expect([...upstreamOnly.edgeIds].sort()).toEqual([...bothWays.edgeIds].sort());
  });

  it('leaves out an edge whose other endpoint the depth cap excluded', () => {
    const traced = traceNodeWithLevels(withBackEdge(), 'ORIGIN', 1, 0);
    expect([...traced.nodeIds].sort()).toEqual(['A', 'ORIGIN']);
    expect([...traced.edgeIds].sort()).toEqual(['A→ORIGIN']);
  });
});

describe('traceNodeIdsWithLevels', () => {
  it('returns the same node set as traceNodeWithLevels and drops an unknown origin', () => {
    const graph = chain();
    expect(traceNodeIdsWithLevels(graph, 'B', 1, 1)).toEqual(traceNodeWithLevels(graph, 'B', 1, 1).nodeIds);
    expect(traceNodeIdsWithLevels(graph, 'nope', 2, 2).size).toBe(0);
  });
});

describe('layoutCacheKey', () => {
  const input = {
    nodeIds: ['B', 'A'],
    edges: [{ source: 'A', target: 'B' }],
    config: DEFAULT_CONFIG,
  };

  it('is stable under node order and changes when direction or node size changes', () => {
    const key = layoutCacheKey(input);
    expect(layoutCacheKey({ ...input, nodeIds: ['A', 'B'] })).toBe(key);
    expect(layoutCacheKey({ ...input, direction: 'TB' })).not.toBe(key);
    expect(layoutCacheKey({ ...input, sizeOf: () => ({ width: 10, height: 10 }) })).not.toBe(key);
  });
});

describe('objectLayoutInputForGraph', () => {
  it('lays out connected nodes and leaves an isolated node out of the Dagre input', () => {
    const input = objectLayoutInputForGraph(chain(), DEFAULT_CONFIG);
    expect(input.nodeIds).toEqual(expect.arrayContaining(['A', 'B', 'C', 'D']));
    expect(input.nodeIds).not.toContain('Z');
    expect(input.edges).toEqual(expect.arrayContaining([{ source: 'A', target: 'B' }]));
  });
});
