/** Proof test for N2 normalization: focus_node_id normalized at the model boundary and engine sees only canonical ids. */
import { describe, expect, it } from 'vitest';
import { normalizeModelInput } from '../../../src/ai/tools/normalizeModelInput';
import {
  submitFindingsSchemaForMode,
  toHopFinding,
} from '../../../src/ai/tools/toolSchemas';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph, makeModel, makeNode } from '../helpers/modelFixtures';

describe('N2 focus_node_id boundary normalization proof', () => {
  it('submits boundary-normalized findings to NavigationEngine with direct canonical matching', () => {
    const origin = '[dbo].[OrdersView]';
    const nodes = [
      makeNode({ id: origin, schema: 'dbo', name: 'OrdersView', type: 'view' }),
    ];
    const model = makeModel(nodes, [], ['dbo']);
    const graph = makeGraph(nodes, []);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin,
      question: 'Trace OrdersView',
      direction: 'upstream',
      analysisMode: 'bb',
      depthIntent: {
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    });
    const ctx = engine.getHopContext();
    expect(ctx).toMatchObject({ focus_node: { id: origin } });

    const hop = engine.hopSubmitColumns;
    expect(hop.focusNodeId).toBe(origin);

    const schema = submitFindingsSchemaForMode('bb', undefined, true, hop);
    const normalized = normalizeModelInput(schema, {
      focus_node_id: 'dbo.ordersview',
      summary: 'View of orders table.',
      sections: { technical: 'Orders view SQL.' },
    });

    expect(normalized.input).toMatchObject({ focus_node_id: origin });
    expect(
      normalized.fixes.some(
        (f) => f.path === 'focus_node_id' && f.after === origin,
      ),
    ).toBe(true);
    const result = engine.submitFindings(
      toHopFinding(schema.parse(normalized.input)),
    );
    expect(result).toMatchObject({ ok: true });
  });
});
