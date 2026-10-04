/** Contradictory prune/investigate decisions reject atomically; branch cuts refuse neighbor work. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { SubmitFindingsBbInputSchema, SubmitFindingsCtInputSchema } from '../../../src/ai/tools/toolSchemas';
import type { HopFindingKept } from '../../../src/ai/sm/smTypes';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

function setup(caseSensitive = false) {
  const nodes = ['origin', 'writer', 'other'].map(name => makeNode({
    id: `[dbo].[${name}]`, name, schema: 'dbo', type: 'procedure',
  }));
  const pairs: Array<[string, string]> = [
    ['[dbo].[writer]', '[dbo].[origin]'], ['[dbo].[other]', '[dbo].[origin]'],
  ];
  const model = { ...makeModel(nodes, pairs, ['dbo']), identifierCaseSensitive: caseSensitive };
  const graph = makeGraph(nodes, pairs);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({
    origin: '[dbo].[origin]', question: 'Investigate upstream writers', direction: 'upstream',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  expect(engine.getHopContext().focus_node?.id).toBe('[dbo].[origin]');
  return { engine, model, graph };
}

const kept: HopFindingKept = {
  focus_node_id: '[dbo].[origin]', verdict: 'analyze', summary: 'Origin writes the result',
  sections: [{ angle: 'technical', text: 'Investigate the supplied upstream writers.' }],
};

function committedState(engine: NavigationEngine) {
  const state = engine.toJSON();
  return {
    status: state.status, hopCount: state.hopCount, agenda: state.agenda,
    scope: state.scopeNodeIds, removed: state.removedSet, visited: state.visited,
    nodes: state.nodeStates, leads: engine.pendingLeads, deferred: engine.deferredQuestions,
  };
}

describe('neighbor action conflicts', () => {
  it.each([false, true])('rejects the same resolved node in prune and questions (CS=%s), preserving commit state and allowing repair', caseSensitive => {
    const { engine, model, graph } = setup(caseSensitive);
    const before = committedState(engine);
    const result = engine.submitFindings({
      ...kept,
      prune_neighbors: [{ id: caseSensitive ? 'dbo.writer' : 'dbo.WRITER', reason: 'Off the answer' }],
      questions: [{ nodeId: '[dbo].[writer]', question: 'Analyze the writer load.' }],
    });
    expect(result).toMatchObject({ code: 'route_validation_failed', issuePaths: ['questions.0.nodeId', 'prune_neighbors'],
      detail: [expect.objectContaining({ id: '[dbo].[writer]', path: 'questions.0.nodeId' })] });
    expect(committedState(engine)).toEqual(before);
    const restored = NavigationEngine.fromJSON(engine.toJSON(), model, graph, () => {}, {});
    const repaired = restored.applyHeldContent({ ...kept, prune_neighbors: [] });
    if ('code' in repaired) throw new Error(repaired.reason);
    expect(restored.submitFindings(repaired)).toMatchObject({ ok: true });
    expect(restored.toJSON().removedSet).not.toContain('[dbo].[writer]');
    expect(restored.getHopContext().focus_node?.id).toBe('[dbo].[other]');
    expect(restored.submitFindings({ ...kept, focus_node_id: '[dbo].[other]' })).toMatchObject({ ok: true });
    expect(restored.getHopContext().focus_node?.id).toBe('[dbo].[writer]');
  });

  it.each([
    { restore: false, explicitEmpty: false },
    { restore: true, explicitEmpty: false },
    { restore: false, explicitEmpty: true },
    { restore: true, explicitEmpty: true },
  ])('does not resurrect a conflicting prune after a question-only retry ($restore, $explicitEmpty)', ({ restore, explicitEmpty }) => {
    const { engine, model, graph } = setup();
    const before = committedState(engine);
    const rejected = engine.submitFindings({
      ...kept, badge_label: 'Origin report',
      prune_neighbors: [{ id: '[dbo].[writer]', reason: 'Off the answer' }],
      questions: [{ nodeId: '[dbo].[writer]', question: 'Analyze the writer load.' }],
    });
    expect(rejected).toMatchObject({ code: 'route_validation_failed' });
    expect(committedState(engine)).toEqual(before);
    if (!('code' in rejected)) throw new Error('Expected a conflicting decision rejection');
    engine.holdRejectedSubmission({
      ...kept, sections: { technical: kept.sections[0].text }, badge_label: 'Origin report',
      prune_neighbors: [{ id: '[dbo].[writer]', reason: 'Off the answer' }],
      questions: [{ nodeId: '[dbo].[writer]', question: 'Analyze the writer load.' }],
    }, rejected.issuePaths ?? []);
    const retryEngine = restore ? NavigationEngine.fromJSON(engine.toJSON(), model, graph, () => {}, {}) : engine;
    const repaired = retryEngine.applyHeldContent({
      focus_node_id: kept.focus_node_id, verdict: 'analyze', summary: '', sections: [],
      questions: [{ nodeId: '[dbo].[writer]', question: 'Analyze the writer load.' }],
      ...(explicitEmpty ? { prune_neighbors: [] } : {}),
    });
    if ('code' in repaired) throw new Error(repaired.reason);
    expect(repaired).toMatchObject({ summary: kept.summary, sections: kept.sections, badge_label: 'Origin report' });
    expect(repaired.prune_neighbors ?? []).toEqual([]);
    expect(retryEngine.submitFindings(repaired)).toMatchObject({ ok: true });
    expect(retryEngine.toJSON().removedSet).not.toContain('[dbo].[writer]');
  });

  it('allows pruning one neighbor while investigating a different neighbor', () => {
    const { engine } = setup();
    expect(engine.submitFindings({
      ...kept, prune_neighbors: [{ id: '[dbo].[other]', reason: 'Off the answer' }],
      questions: [{ nodeId: '[dbo].[writer]', question: 'Analyze the writer load.' }],
    })).toMatchObject({ ok: true });
    expect(engine.toJSON().removedSet).toContain('[dbo].[other]');
    expect(engine.getHopContext().focus_node?.id).toBe('[dbo].[writer]');
  });

  it('does not invent a deferred follow-up for a terminal table inside the approved scope', () => {
    const nodes = [makeNode({ id: 'origin', name: 'origin', schema: 'dbo', type: 'procedure' }),
      makeNode({ id: 'leaf', name: 'leaf', schema: 'dbo', type: 'table' })];
    const pairs: Array<[string, string]> = [['leaf', 'origin']];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
    engine.init({ origin: 'origin', question: 'Trace upstream', direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
    engine.getHopContext();
    expect(engine.submitFindings({ ...kept, focus_node_id: 'origin',
      questions: [{ nodeId: 'leaf', question: 'Establish the stored upstream source.' }],
    })).toMatchObject({ ok: true });
    expect(engine.toJSON().scopeNodeIds).toContain('leaf');
    expect(engine.pendingLeads).toEqual([]);
    expect(engine.deferredQuestions).toEqual([]);
  });

  it('defers a relevant question at an excluded schema without adding that neighbor to scope', () => {
    const nodes = [makeNode({ id: 'origin', name: 'origin', schema: 'dbo', type: 'procedure' }),
      makeNode({ id: 'outside', name: 'outside', schema: 'external', type: 'view' })];
    const pairs: Array<[string, string]> = [['outside', 'origin']];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo', 'external']), makeGraph(nodes, pairs), () => {}, {});
    engine.init({ origin: 'origin', question: 'Trace upstream', direction: 'upstream', excludeSchemas: ['external'],
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
    engine.getHopContext();
    expect(engine.submitFindings({ ...kept, focus_node_id: 'origin',
      questions: [{ nodeId: 'outside', question: 'Establish how the excluded source supplies the origin.' }],
    })).toMatchObject({ ok: true });
    expect(engine.toJSON().scopeNodeIds).not.toContain('outside');
    expect(engine.deferredQuestions).toContainEqual(expect.objectContaining({ nodeId: 'outside', reason: 'excluded' }));
  });

  it('keeps case-distinct nodes independent under a CS identifier policy', () => {
    const { model } = setup(true);
    const twin = makeNode({ id: '[dbo].[Writer]', name: 'Writer', schema: 'dbo', type: 'procedure' });
    const nodes = [...model.nodes, twin];
    const pairs: Array<[string, string]> = [
      ['[dbo].[writer]', '[dbo].[origin]'], ['[dbo].[Writer]', '[dbo].[origin]'],
    ];
    const distinct = new NavigationEngine({ ...model, nodes }, makeGraph(nodes, pairs), () => {}, {});
    distinct.init({ origin: '[dbo].[origin]', question: 'Trace', direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
    distinct.getHopContext();
    expect(distinct.submitFindings({ ...kept,
      prune_neighbors: [{ id: '[dbo].[writer]', reason: 'Off the answer' }],
      questions: [{ nodeId: '[dbo].[Writer]', question: 'Analyze the other writer.' }],
    })).toMatchObject({ ok: true });
    expect(distinct.getHopContext().focus_node?.id).toBe('[dbo].[Writer]');
  });

  it.each(['bb', 'ct'] as const)('rejects end_branch at the %s input boundary', mode => {
    const schema = mode === 'ct' ? SubmitFindingsCtInputSchema : SubmitFindingsBbInputSchema;
    const result = schema.safeParse({ focus_node_id: '[dbo].[writer]', verdict: 'end_branch', reason: 'Off the answer',
      ...(mode === 'ct' ? { column_flow: [] } : {}),
      questions: [{ nodeId: '[dbo].[other]', question: 'Analyze this neighbor.' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['verdict'] }));
  });
});
