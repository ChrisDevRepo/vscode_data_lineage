/** Proven source identifier policy preserves distinct AI endpoints and their tasks across restore. */
import { describe, expect, it } from 'vitest';
import { normalizeSubmitFindingsInputIds, resolveModelNodeIds } from '../../../src/ai/support/inputNormalization';
import { AgendaManager } from '../../../src/ai/sm/agendaManager';
import { columnEndpointKeyFactory } from '../../../src/ai/sm/columnTracer';
import { reconcileAiView } from '../../../src/components/aiViewReconcile';
import { TaskLedger } from '../../../src/ai/sm/taskLedger';
import { uniqueScalarReturnTargets } from '../../../src/ai/sm/scalarReturnBinding';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const upper = '[dbo].[Widget]', lower = '[dbo].[widget]', origin = '[dbo].[Result]';
const nodeMap = new Map([upper, lower].map(id => [id, {}]));

describe('source identifier policy in AI', () => {
  it('normalizes encoding without redirecting unknown CS spelling to a twin', () => {
    expect(resolveModelNodeIds(['dbo.Widget', 'dbo.widget', 'dbo.WIDGET'], nodeMap, true)).toEqual({ resolved: [upper, lower], unresolved: ['dbo.WIDGET'] });
    const raw = { focus_node_id: 'dbo.Widget', verdict: 'analyze', questions: [{ nodeId: 'dbo.widget', question: 'Inspect lower.' }], column_flow: [{ out_col: 'Value', upstream_columns: [{ node: 'dbo.Widget', col: 'Value' }] }] };
    expect(normalizeSubmitFindingsInputIds(raw, nodeMap, true).input).toMatchObject({ focus_node_id: upper, questions: [{ nodeId: lower }], column_flow: [{ upstream_columns: [{ node: 'dbo.Widget' }] }] });
    expect(raw.focus_node_id).toBe('dbo.Widget');
  });

  it('keeps the existing missing/false policy case-insensitive', () => {
    const map = new Map([[lower, {}]]);
    expect(resolveModelNodeIds(['DBO.WIDGET'], map)).toEqual(resolveModelNodeIds(['DBO.WIDGET'], map, false));
    expect(resolveModelNodeIds(['DBO.WIDGET'], map).resolved).toEqual([lower]);
  });

  it('keeps CS object and column destinations distinct', () => {
    const targets = [{ node: upper, col: 'Value' }, { node: lower, col: 'Value' }, { node: upper, col: 'value' }];
    expect(uniqueScalarReturnTargets(targets, true)).toEqual(targets);
    expect(uniqueScalarReturnTargets(targets)).toHaveLength(1);
    const ledger = new TaskLedger(true);
    const tasks = targets.map(target => ledger.ensureTask({ kind: 'column_lineage', source: 'engine', question: 'Inspect result', nodeId: origin, activeColumns: ['Value'], returnTargets: [target], createdHop: 0 }));
    expect(new Set(tasks.map(task => task.id)).size).toBe(3);
  });

  it('merges qualified scalar carries without dropping CS twins', () => {
    const agenda = new AgendaManager(true);
    const outputs = [{ node: upper, col: 'Value' }, { node: lower, col: 'Value' }, { node: upper, col: 'value' }];
    for (const target of outputs) agenda.push({ nodeId: origin, taskIds: [], depth: 0, priority: 0, columnCarry: { kind: 'scalar_return', outputs: [target] } });
    expect(agenda.entries[0].columnCarry).toEqual({ kind: 'scalar_return', outputs });
    const nodes = [upper, lower].map(id => makeNode({ id, schema: 'dbo', name: id, type: 'view' }));
    const key = columnEndpointKeyFactory(new Map(nodes.map(node => [node.id, node])), true);
    expect(new Set(outputs.map(target => key(target.node, target.col))).size).toBe(3);
  });

  it('reconciles saved UI references against the current model policy', () => {
    const nodes = [upper, lower].map(id => makeNode({ id, schema: 'dbo', name: id, type: 'view' }));
    const model = { ...makeModel(nodes, [], ['dbo']), identifierCaseSensitive: true };
    const metadata = { createdAt: '2026-10-02', modelName: 'test', highlightGroups: [], badges: [{ nodeId: 'dbo.Widget', text: 'Upper' }, { nodeId: 'dbo.widget', text: 'Lower' }], nodeVerdicts: [{ nodeId: 'dbo.Widget', verdict: 'analyze' as const }, { nodeId: 'dbo.widget', verdict: 'passthrough' as const }] };
    const reconciled = reconcileAiView(['dbo.Widget', 'dbo.widget', 'dbo.WIDGET'], metadata, model);
    expect(reconciled.nodeIds).toEqual([upper, lower]);
    expect(reconciled.unresolved).toEqual(['dbo.WIDGET']);
    expect(reconciled.metadata.badges.map(badge => badge.nodeId)).toEqual([upper, lower]);
    expect(reconciled.metadata.nodeVerdicts?.map(verdict => verdict.nodeId)).toEqual([upper, lower]);
  });

  it('routes both CS twins once and keeps them distinct', () => {
    const nodes = [upper, lower, origin].map(id => makeNode({ id, schema: 'dbo', name: id, type: 'view' }));
    const pairs: [string, string][] = [[upper, origin], [lower, origin]];
    const model = { ...makeModel(nodes, pairs, ['dbo']), identifierCaseSensitive: true };
    const graph = makeGraph(nodes, pairs);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    expect(engine.init({ origin, question: 'Inspect both inputs', direction: 'upstream', analysisMode: 'bb', depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      engine.getHopContext();
      const focus = engine.currentFocus!;
      seen.push(focus);
      expect(engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: `Observed ${focus}`, sections: [{ angle: 'technical', text: `Observed ${focus}` }] })).toMatchObject({ ok: true });
    }
    expect(new Set(seen)).toEqual(new Set([upper, lower, origin]));
    expect(engine.getHopContext()).toMatchObject({ done: true });
    expect(engine.getResult().fullNodes.map(node => node.id)).toEqual(expect.arrayContaining([upper, lower, origin]));
  });
});
