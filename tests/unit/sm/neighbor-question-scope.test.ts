/** Neighbor question capability reflects deferred scope work without widening approval or reopening closed nodes. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

type Mode = 'bb' | 'ct';
type Boundary = 'schema' | 'exclusion' | 'direction' | 'depth';
const depth = (levels: number | 'all') => ({
  upstream: { levels, exactness: 'exact' as const },
  downstream: { levels: 0, exactness: 'exact' as const },
});
function setup(mode: Mode, boundary: Boundary) {
  const nodes = ['origin', 'focus', 'outside'].map(id => makeNode({
    id, name: id, schema: id === 'outside' && boundary === 'schema' ? 'external' : 'dbo', type: 'view',
    columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }],
  }));
  const pairs: Array<[string, string]> = [['focus', 'origin'],
    boundary === 'direction' ? ['focus', 'outside'] : ['outside', 'focus']];
  const model = makeModel(nodes, pairs, ['dbo', 'external']);
  const graph = makeGraph(nodes, pairs);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.classification = 'technical';
  expect(engine.init({ origin: 'origin', question: 'Trace Amount upstream', direction: 'upstream',
    analysisMode: mode, ...(mode === 'ct' ? { targetColumns: ['Amount'] } : {}),
    ...(boundary === 'schema' ? { excludeSchemas: ['external'] } : {}),
    ...(boundary === 'exclusion' ? { excludeNodeIds: ['outside'] } : {}),
    depthIntent: depth(boundary === 'depth' ? 1 : 'all'),
  })).toMatchObject({ ok: true });
  expect(engine.getHopContext().focus_node?.id).toBe('origin');
  expect(engine.submitFindings({ focus_node_id: 'origin', verdict: 'analyze', summary: 'Origin reads focus.',
    sections: [{ angle: 'technical', text: 'Origin reads Amount from focus.' }],
    questions: [{ nodeId: 'focus', question: 'Explain its Amount calculation.' }],
    ...(mode === 'ct' ? { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'focus', col: 'Amount' }] }] } : {}),
  })).toMatchObject({ ok: true });
  const context = engine.getHopContext();
  expect(context.focus_node?.id).toBe('focus');
  return { engine, context, model, graph };
}

const finding = {
  focus_node_id: 'focus', verdict: 'analyze' as const, summary: 'Focus reads its source.',
  sections: [{ angle: 'technical' as const, text: 'The outside neighbor may explain the approved source.' }],
};

describe('question eligibility across approval boundaries', () => {
  it.each((['bb', 'ct'] as const).flatMap(mode =>
    (['schema', 'exclusion', 'direction', 'depth'] as const).map(boundary => [mode, boundary] as const),
  ))('discloses and defers the %s question at a %s boundary', (mode, boundary) => {
      const { engine, context, model, graph } = setup(mode, boundary);
      const outside = context.neighbors?.find(neighbor => neighbor.id === 'outside');
      expect(outside, boundary).toMatchObject({ can_question: true, can_prune: false, in_approved_scope: false });
      const before = engine.toJSON().scopeNodeIds;
      expect(engine.submitFindings({ ...finding,
        questions: [{ nodeId: 'outside', question: 'Explain its contribution if a later scope approves it.' }],
        ...(mode === 'ct' ? { column_flow: [] } : {}),
      })).toMatchObject({ ok: true });
      const reason = boundary === 'schema' || boundary === 'exclusion' ? 'excluded'
        : boundary === 'direction' ? 'direction' : 'depth';
      expect(engine.deferredQuestions, boundary).toContainEqual(expect.objectContaining({ nodeId: 'outside', reason }));
      expect(engine.toJSON().scopeNodeIds, boundary).toEqual(before);
      expect(engine.toJSON().scopeNodeIds, boundary).not.toContain('outside');
      const restored = NavigationEngine.fromJSON(engine.toJSON(), model, graph, () => {}, {});
      expect(restored.deferredQuestions).toEqual(engine.deferredQuestions);
  });

  it.each(['bb', 'ct'] as const)('rejects a question for a visited neighbor in %s', mode => {
    const { engine, context } = setup(mode, 'exclusion');
    expect(context.neighbors?.find(neighbor => neighbor.id === 'origin')).toMatchObject({ can_question: false, can_prune: false, already_visited: true });
    const before = engine.toJSON();
    expect(engine.submitFindings({ ...finding, questions: [{ nodeId: 'origin', question: 'Visit the origin again.' }],
      ...(mode === 'ct' ? { column_flow: [] } : {}),
    })).toMatchObject({ code: 'route_validation_failed', issuePaths: ['questions.0.nodeId'] });
    expect(engine.toJSON().scopeNodeIds).toEqual(before.scopeNodeIds);
    expect(engine.deferredQuestions).not.toContainEqual(expect.objectContaining({ nodeId: 'origin' }));
  });

  it.each(['bb', 'ct'] as const)('rejects a scope-boundary neighbor in both prune and questions in %s', mode => {
    const { engine } = setup(mode, 'exclusion');
    const before = engine.toJSON();
    expect(engine.submitFindings({ ...finding,
      prune_neighbors: [{ id: 'outside', reason: 'Off this answer.' }],
      questions: [{ nodeId: 'outside', question: 'Investigate it anyway.' }],
      ...(mode === 'ct' ? { column_flow: [] } : {}),
    })).toMatchObject({ code: 'route_validation_failed', issuePaths: expect.arrayContaining(['questions.0.nodeId']) });
    expect(engine.toJSON().scopeNodeIds).toEqual(before.scopeNodeIds);
    expect(engine.toJSON().removedSet).toEqual(before.removedSet);
    expect(engine.deferredQuestions).toEqual([]);
  });

  
});
