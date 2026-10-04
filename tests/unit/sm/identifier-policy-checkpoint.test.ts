/** Source comparison policy survives navigation and saved-run boundaries without reinterpreting CI identities. */
import { describe, expect, it } from 'vitest';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { parseNavigationSnapshot } from '../../../src/ai/sm/navigationSnapshotSchema';
import { aiRunStorageKey, readStoredRun } from '../../../src/ai/session/runStore';
import { buildUnrelatedMap, buildHopFocusNode } from '../../../src/ai/tools/tools';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import type { ColumnDef } from '../../../src/engine/types';

const depthIntent = { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } as const;
const column = (name: string): ColumnDef => ({ name, type: 'int', nullable: 'NULL', extra: '' });

function world(identifierCaseSensitive: boolean) {
  const id = identifierCaseSensitive ? '[dbo].[Result]' : '[dbo].[result]';
  const nodes = [makeNode({ id, schema: 'dbo', name: 'Result', type: 'view', bodyScript: 'SELECT 1 AS Value;', columns: [column('Value')] })];
  const model = { ...makeModel(nodes, [], ['dbo']), identifierCaseSensitive };
  const graph = makeGraph(nodes, []);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: id, question: 'Inspect result', direction: 'upstream', analysisMode: 'bb', depthIntent })).toMatchObject({ ok: true });
  return { engine, model, graph };
}

describe.each([false, true])('checkpoint comparison policy (CS=%s)', policy => {
  it('round trips its recorded policy and refuses the opposite loaded policy', () => {
    const { engine, model, graph } = world(policy);
    const snapshot = JSON.parse(JSON.stringify(engine.toJSON()));
    expect(snapshot.identifierCaseSensitive).toBe(policy);
    expect(NavigationEngine.fromJSON(snapshot, model, graph, () => {}, {}).toJSON()).toEqual(snapshot);
    expect(() => NavigationEngine.fromJSON(snapshot, { ...model, identifierCaseSensitive: !policy }, graph, () => {}, {})).toThrow('invalid or incompatible');
  });
});

it('reads legacy snapshots as CI and refuses to reinterpret them as CS', () => {
  const { engine, model, graph } = world(false);
  const snapshot = engine.toJSON();
  delete snapshot.identifierCaseSensitive;
  expect(() => NavigationEngine.fromJSON(snapshot, model, graph, () => {}, {})).not.toThrow();
  expect(() => NavigationEngine.fromJSON(snapshot, { ...model, identifierCaseSensitive: true }, graph, () => {}, {})).toThrow('invalid or incompatible');
});

it.each([null, 'true', 1, {}])('rejects malformed checkpoint policy %j at both persistence boundaries', value => {
  const snapshot = { ...world(false).engine.toJSON(), identifierCaseSensitive: value };
  expect(() => parseNavigationSnapshot(snapshot)).toThrow('invalid or incompatible');
  const record = { schemaVersion: 1, runId: 'synthetic', savedAt: '2026-10-02', origin: null, ddlHashes: {}, snapshot };
  expect(readStoredRun({ get: <T,>() => record as T }, 'synthetic')).toBeUndefined();
});

describe.each([false, true])('column accounting (CS=%s)', policy => {
  it.each(['upstream', 'downstream'] as const)('accounts delimited names under the same policy as %s validation', direction => {
    const tracer = new ColumnTracer(['Value', 'value'], undefined, policy);
    const flow = direction === 'upstream'
      ? [{ out_col: '[Value]', upstream_columns: [] }]
      : [{ out_col: 'Result', upstream_columns: [{ node: '[dbo].[Input]', col: '"Value"' }] }];
    expect(tracer.unaccountedActiveColumns(flow, direction)).toEqual(policy ? ['value'] : []);
  });
});

it('reads and restores a CS scalar task with two case-distinct caller columns', () => {
  const caller = '[dbo].[Result]', fn = '[dbo].[Calc]';
  const columns = ['Value', 'value'].map(name => ({ ...column(name), expressionDependencies: [{ reference: fn, sourceElementType: 'SqlScalarFunction' }] }));
  const nodes = [
    makeNode({ id: caller, schema: 'dbo', name: 'Result', type: 'view', columns, bodyScript: `SELECT ${fn}(1) AS Value, ${fn}(2) AS value;` }),
    makeNode({ id: fn, schema: 'dbo', name: 'Calc', type: 'function', bodyScript: `CREATE FUNCTION ${fn}(@x int) RETURNS int AS BEGIN RETURN @x; END;` }),
  ];
  const pairs: [string, string][] = [[fn, caller]];
  const model = { ...makeModel(nodes, pairs, ['dbo']), identifierCaseSensitive: true };
  const graph = makeGraph(nodes, pairs);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: caller, question: 'Trace Value and value', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Value', 'value'], depthIntent })).toMatchObject({ ok: true });
  engine.getHopContext();
  expect(engine.submitFindings({ focus_node_id: caller, verdict: 'analyze', summary: 'Caller outputs', sections: [{ angle: 'technical', text: 'Two declared function outputs.' }], column_flow: columns.map(col => ({ out_col: col.name, upstream_columns: [] })) })).toMatchObject({ ok: true });
  const snapshot = engine.toJSON();
  const record = { schemaVersion: 1, runId: 'synthetic', savedAt: '2026-10-02', origin: caller, ddlHashes: {}, snapshot };
  const store = new Map([[aiRunStorageKey('synthetic'), JSON.parse(JSON.stringify(record))]]);
  const saved = readStoredRun({ get: <T,>(key: string) => store.get(key) as T }, 'synthetic');
  expect(saved).toBeDefined();
  const restored = NavigationEngine.fromJSON(saved!.snapshot, model, graph, () => {}, {});
  expect(restored.getHopContext().caller_output_targets).toEqual([{ node: caller, col: 'Value' }, { node: caller, col: 'value' }]);
});

it('routes case-distinct CS functions to their own caller outputs after restore', () => {
  const caller = '[dbo].[Result]';
  const functions = [{ id: '[dbo].[Calc]', name: 'Calc', col: 'Total' }, { id: '[dbo].[calc]', name: 'calc', col: 'total' }];
  const columns = functions.map(fn => ({ ...column(fn.col), expressionDependencies: [{ reference: fn.id, sourceElementType: 'SqlScalarFunction' }] }));
  const nodes = [
    makeNode({ id: caller, schema: 'dbo', name: 'Result', type: 'view', columns, bodyScript: 'SELECT dbo.Calc(1) AS Total, dbo.calc(2) AS total;' }),
    ...functions.map(fn => makeNode({ id: fn.id, schema: 'dbo', name: fn.name, type: 'function', bodyScript: `CREATE FUNCTION ${fn.id}(@x int) RETURNS int AS BEGIN RETURN @x; END;` })),
  ];
  const pairs: [string, string][] = functions.map(fn => [fn.id, caller]);
  const model = { ...makeModel(nodes, pairs, ['dbo']), identifierCaseSensitive: true };
  const graph = makeGraph(nodes, pairs);
  let engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: caller, question: 'Trace Total and total', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Total', 'total'], depthIntent })).toMatchObject({ ok: true });
  engine.getHopContext();
  expect(engine.submitFindings({ focus_node_id: caller, verdict: 'analyze', summary: 'Declared independent functions', sections: [{ angle: 'technical', text: 'Each output calls its own function.' }], column_flow: columns.map(col => ({ out_col: col.name, upstream_columns: [] })) })).toMatchObject({ ok: true });
  engine = NavigationEngine.fromJSON(JSON.parse(JSON.stringify(engine.toJSON())), model, graph, () => {}, {});
  const visited: string[] = [];
  for (const _ of functions) {
    const hop = engine.getHopContext();
    const fn = functions.find(candidate => candidate.id === hop.focus_node?.id);
    expect(fn).toBeDefined();
    if (!fn) throw new Error('Expected a declared function hop');
    visited.push(fn.id);
    const target = { node: caller, col: fn.col };
    expect(hop.caller_output_targets).toEqual([target]);
    expect(engine.submitFindings({ focus_node_id: fn.id, verdict: 'analyze', summary: 'Bound scalar output', sections: [{ angle: 'technical', text: 'Parameter returns directly to the declared output.' }], column_flow: [{ out_col: fn.col, returns_to: target, upstream_columns: [] }] })).toMatchObject({ ok: true });
  }
  expect(visited.sort()).toEqual(functions.map(fn => fn.id).sort());
  expect(engine.getHopContext()).toEqual({ done: true });
});

describe.each([false, true])('unresolved hop references (CS=%s)', policy => {
  it('retains each exact CS object or its normalized CI spelling in dispatched and peeked context', () => {
    const { engine, model } = world(policy);
    model.parseStats = { parsedRefs: 1, resolvedEdges: 0, droppedRefs: [], spDetails: [
      { name: 'dbo.Result', inCount: 0, outCount: 0, unrelated: ['dbo.Missing'] },
      ...(policy ? [{ name: 'dbo.result', inCount: 0, outCount: 0, unrelated: ['dbo.Other'] }] : []),
    ] };
    const hop = engine.getHopContext();
    expect(hop.focus_node?.unresolved_refs).toEqual(['dbo.Missing']);
    expect(engine.peekHopContext()?.focus_node?.unresolved_refs).toEqual(['dbo.Missing']);
    const node = model.nodes[0];
    expect(buildHopFocusNode(node, new Map([[node.id, node]]), buildUnrelatedMap(model), undefined, 'ddl', undefined, undefined, policy).unresolved_refs).toEqual(['dbo.Missing']);
  });
});

describe.each([false, true])('dirty column references in CT (CS=%s)', policy => {
  it.each(['Item.Code', '[Item.Code]', '"Item.Code"', 'ITEM.CODE'])('validates contributor %s against the catalog policy', spelling => {
    const focus = policy ? '[Report].[Result]' : '[report].[result]';
    const source = policy ? '[Sales].[Orders]' : '[sales].[orders]';
    const nodes = [
      makeNode({ id: focus, schema: 'Report', name: 'Result', type: 'view', columns: [column('Net.Total')], bodyScript: 'SELECT i.[Item.Code] AS [Net.Total] FROM [Sales].[Orders] AS i;' }),
      makeNode({ id: source, schema: 'Sales', name: 'Orders', type: 'table', columns: [column('Item.Code'), ...(policy ? [column('item.code')] : [])] }),
    ];
    const model = { ...makeModel(nodes, [[source, focus]], ['Report', 'Sales']), identifierCaseSensitive: policy };
    const tracer = new ColumnTracer(['Net.Total'], undefined, policy);
    const finding = { focus_node_id: focus, verdict: 'analyze' as const, sections: [], summary: 'Projection', column_flow: [{ out_col: '[Net.Total]', upstream_columns: [{ node: '[Sales].[Orders]', col: spelling }] }] };
    const result = tracer.validateColumnFlow(focus, finding, new Map(nodes.map(node => [node.id, node])), model, null, undefined, new Set(), 'upstream');
    if (policy && spelling === 'ITEM.CODE') {
      expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_contributor_col' }));
      expect(result.stagedEdges).toEqual([]);
    } else {
      expect(result.invalidRoutes).toEqual([]);
      expect(result.stagedEdges).toContainEqual(expect.objectContaining({ from_node: source, to_node: focus }));
    }
  });
});

it.each([
  ['Sales', 'Orders', 'Sales', 'orders'],
  ['Sales', 'Orders', 'sales', 'Orders'],
  ['Sales', 'Orders', 'sales', 'orders'],
])('keeps schema/object/column twins distinct through CT and restore: %s.%s versus %s.%s', (schemaA, nameA, schemaB, nameB) => {
  const focus = '[Report].[Result]', sourceA = `[${schemaA}].[${nameA}]`, sourceB = `[${schemaB}].[${nameB}]`;
  const nodes = [
    makeNode({ id: focus, schema: 'Report', name: 'Result', type: 'view', columns: [column('Total'), column('total')], bodyScript: `SELECT a.Value+b.value AS Total, a.value+b.Value AS total FROM ${sourceA} a JOIN ${sourceB} b ON a.Value=b.Value;` }),
    ...[[sourceA, schemaA, nameA], [sourceB, schemaB, nameB]].map(([id, schema, name]) => makeNode({ id, schema, name, type: 'table', columns: [column('Value'), column('value')] })),
  ];
  const pairs: [string, string][] = [[sourceA, focus], [sourceB, focus]];
  const model = { ...makeModel(nodes, pairs, [schemaA, schemaB, 'Report']), identifierCaseSensitive: true };
  const graph = makeGraph(nodes, pairs);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: focus, question: 'Trace Total and total', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Total', 'total'], depthIntent })).toMatchObject({ ok: true });
  engine.getHopContext();
  expect(engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: 'Distinct source identities', sections: [{ angle: 'technical', text: 'Both sources supply independently named columns.' }], column_flow: [
    { out_col: 'Total', upstream_columns: [{ node: sourceA, col: 'Value' }, { node: sourceB, col: 'value' }] },
    { out_col: 'total', upstream_columns: [{ node: sourceA, col: 'value' }, { node: sourceB, col: 'Value' }] },
  ] })).toMatchObject({ ok: true });
  const restored = NavigationEngine.fromJSON(JSON.parse(JSON.stringify(engine.toJSON())), model, graph, () => {}, {});
  expect(restored.getHopContext()).toEqual({ done: true });
  const result = restored.getResult();
  expect(result.fullNodes.map(node => node.id).sort()).toEqual([sourceA, sourceB, focus].sort());
  const endpoints = result.columnAspect!.edges.map(edge => [edge.from_node, edge.from_col, edge.to_node, edge.to_col]);
  expect(endpoints).toEqual(expect.arrayContaining([
    [sourceA, 'Value', focus, 'Total'], [sourceB, 'value', focus, 'Total'],
    [sourceA, 'value', focus, 'total'], [sourceB, 'Value', focus, 'total'],
  ]));
  expect(endpoints).toHaveLength(4);
});
