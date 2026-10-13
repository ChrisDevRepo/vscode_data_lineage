/**
 * `lineage_detect_graph_patterns` runs the engine analyses on the AI's bare graph, so that graph
 * must carry every node attribute the analyses read: a hub label names its object, and an external
 * reference keeps its kind and database.
 */
import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../../../src/ai/tools/tools';
import { buildBareGraph } from '../../../src/ai/support/graphUtils';
import { DEFAULT_TURN_TOKEN_BUDGET as BUDGET } from '../../../src/ai/support/tokenBudget';
import { makeModel, makeNode } from '../sm/helpers/fixtures';

const hub = '[sales].[orders]';
const readers = ['[sales].[v1]', '[sales].[v2]', '[sales].[v3]'];
const remote = '[otherdb].[dbo].[customers]';

function model() {
  return makeModel([
    makeNode({ id: hub, schema: 'sales', name: 'Orders', type: 'table' }),
    ...readers.map((id, index) => makeNode({ id, schema: 'sales', name: `v${index + 1}`, type: 'view' })),
    makeNode({ id: remote, schema: 'dbo', name: 'Customers', type: 'external', externalType: 'db', externalDatabase: 'OtherDb' }),
  ], [...readers.map(reader => [hub, reader] as const), [remote, hub]], ['sales', 'dbo']);
}

type Groups = { groups: Array<{ id: string; label: string; meta: Record<string, unknown> }> };

describe('graph pattern labels on the bare graph', () => {
  it('labels a hub with its schema and object name', () => {
    const result = runAnalysis(buildBareGraph(model()), 'hubs', BUDGET, 4) as Groups;
    expect(result.groups).toEqual([expect.objectContaining({ id: `hub-${hub}`, label: '[sales].Orders' })]);
    expect(JSON.stringify(result)).not.toContain('undefined');
  });

  it('reports a cross-database reference with its kind and database', () => {
    const result = runAnalysis(buildBareGraph(model()), 'external-refs', BUDGET) as Groups;
    expect(result.groups).toEqual([expect.objectContaining({ meta: expect.objectContaining({ kind: 'db', database: 'OtherDb' }) })]);
  });
});
