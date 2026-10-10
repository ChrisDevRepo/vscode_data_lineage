/**
 * Hop facts that synthesis and the completed chat need survive the commit: every incoming
 * sub-question with its asking hop on the archived detail slot, and each resolved AI prune with the
 * sender's own reason as a `pruned_by_ai` lead.
 */
import { describe, expect, it } from 'vitest';
import { expandNextQuestionSuggestions } from '../../../src/ai/prompting/followupSuggestions';
import type { AiSession } from '../../../src/ai/session/session';
import { AiMemoryManager } from '../../../src/ai/session/memoryManager';
import type { NavigationEngine } from '../../../src/ai/sm/smBase';
import { parseNavigationSnapshot } from '../../../src/ai/sm/navigationSnapshotSchema';
import { NavigationEngine as Engine } from '../../../src/ai/sm/smBase';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { world, type DepthSide } from './helpers/bbShapes';
import { makeModel, makeNode } from './helpers/fixtures';

const CLOSED: DepthSide = { levels: 0, exactness: 'exact' };
const ALL: DepthSide = { levels: 'all', exactness: 'approximate' };

/** Diamond `o → a, o → b, a → j, b → j`: `j` is reached by two senders. */
const diamond = () => world({ o: 'view', a: 'view', b: 'view', j: 'view' }, [['o', 'a'], ['o', 'b'], ['a', 'j'], ['b', 'j']], 'o', CLOSED, ALL);

type Hop = { ask?: Record<string, string>; prune?: Record<string, string> };

/** Drains the run, submitting each focus with its scripted neighbour questions and prunes. */
function run(engine: NavigationEngine, script: Record<string, Hop>): void {
  for (let guard = 0; guard < 20; guard++) {
    const context = engine.getHopContext();
    if (context.done || !context.focus_node) return;
    const focus = String(context.focus_node.id);
    const hop = script[focus] ?? {};
    const result = engine.submitFindings({
      focus_node_id: focus, verdict: 'analyze', summary: `Observed ${focus}`,
      sections: [{ angle: 'technical', text: `SQL at ${focus}` }],
      ...(hop.ask ? { questions: Object.entries(hop.ask).map(([nodeId, question]) => ({ nodeId, question })) } : {}),
      ...(hop.prune ? { prune_neighbors: Object.entries(hop.prune).map(([id, reason]) => ({ id, reason })) } : {}),
    });
    if (!('ok' in result)) throw new Error(`hop ${focus} rejected: ${JSON.stringify(result)}`);
  }
  throw new Error('hop loop did not end');
}

const slot = (engine: NavigationEngine, id: string) => engine.getResult().detail_slots.find(s => s.nodeId === id);

describe('incoming questions on the detail archive', () => {
  it('keeps both senders\' questions on a shared receiver, each with its asking hop', () => {
    const { engine } = diamond();
    run(engine, {
      a: { ask: { j: 'How is Amount computed at j?' } },
      b: { ask: { j: 'Does j filter IsActive?' } },
    });

    expect(slot(engine, 'j')?.incoming_questions).toEqual(expect.arrayContaining([
      { question: 'How is Amount computed at j?', from_node: 'a' },
      { question: 'Does j filter IsActive?', from_node: 'b' },
    ]));
    expect(slot(engine, 'j')?.incoming_questions).toHaveLength(2);
    expect(slot(engine, 'j')).not.toHaveProperty('reason_for_visit');
  });

  it('keeps a later sender\'s question when the first route carried no question', () => {
    const { engine } = diamond();
    run(engine, { b: { ask: { j: 'Does j filter IsActive?' } } });

    expect(slot(engine, 'j')?.incoming_questions).toEqual([{ question: 'Does j filter IsActive?', from_node: 'b' }]);
  });

  it('archives no root question on the origin and no entry for a hop dispatched without one', () => {
    const { engine } = diamond();
    run(engine, {});

    expect(slot(engine, 'o')).not.toHaveProperty('incoming_questions');
    expect(slot(engine, 'j')).not.toHaveProperty('incoming_questions');
  });

  it('archives no mission question on the origin of a column trace', () => {
    const column = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
    const nodes = [
      makeNode({ id: 'origin', name: 'origin', schema: 'dbo', type: 'view', columns: [column('Total')], bodyScript: 'SELECT Amount AS Total FROM dbo.stage;' }),
      makeNode({ id: 'stage', name: 'stage', schema: 'dbo', type: 'table', columns: [column('Amount')] }),
    ];
    const pairs: Array<[string, string]> = [['stage', 'origin']];
    const engine = new Engine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
    const depthIntent = { upstream: { levels: 'all' as const, exactness: 'exact' as const }, downstream: { levels: 0 as const, exactness: 'exact' as const } };
    expect(engine.init({ origin: 'origin', question: 'Where does Total come from?', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Total'], depthIntent })).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.submitFindings({
      focus_node_id: 'origin', verdict: 'analyze', summary: 'Total reads Amount',
      sections: [{ angle: 'technical', text: 'SELECT Amount AS Total FROM dbo.stage;' }],
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'stage', col: 'Amount' }] }],
    })).toMatchObject({ ok: true });

    expect(engine.getDetailSlots().find(entry => entry.nodeId === 'origin')).not.toHaveProperty('incoming_questions');
  });

  it('archives no mission question that routing re-sends, as a refused prune does', () => {
    const { engine } = world({ o: 'view', a: 'view' }, [['o', 'a']], 'o', CLOSED, ALL);
    engine.getHopContext();
    engine.submitFindings({ focus_node_id: 'o', verdict: 'analyze', summary: 'Observed o', sections: [{ angle: 'technical', text: 'SQL at o' }], questions: [{ nodeId: 'a', question: 'Does a filter rows?' }] });
    // The refused-prune retain path routes the node with the mission question (smBase `tryResolvePrunes`).
    (engine as unknown as { enqueueHop(id: string, q: string, depth: number, priority: number, opts: object): void })
      .enqueueHop('a', 'Trace the lineage', 0, 2, { carry: { kind: 'carry', columns: [] } });
    run(engine, {});

    expect(slot(engine, 'a')?.incoming_questions).toEqual([{ question: 'Does a filter rows?', from_node: 'o' }]);
  });

    it('round-trips through the persisted snapshot schema', () => {
    const { engine } = diamond();
    run(engine, { a: { ask: { j: 'How is Amount computed at j?' } } });

    const parsed = parseNavigationSnapshot(JSON.parse(JSON.stringify(engine.toJSON())));
    expect(parsed.memory.detailSlots.j?.incoming_questions).toEqual([{ question: 'How is Amount computed at j?', from_node: 'a' }]);
  });
});

describe('AiMemoryManager incoming-question merge', () => {
  const node = { id: 'n', schema: 'dbo', name: 'n', type: 'view' } as LineageNode;

  it('appends a revisit\'s new questions and drops exact repeats', () => {
    const memory = AiMemoryManager.fromJSON({
      userQuestion: 'q', missionBrief: '', scopeNotes: [], verdictCounts: { analyze: 0, passthrough: 0, prune: 0 }, recentRejections: [], slotCount: 1,
      detailSlots: { n: { nodeId: 'n', schema: 'dbo', name: 'n', type: 'view', sections: [], summary: 's' } },
    });
    memory.storeDetail(node, [], 's1', { incoming_questions: [{ question: 'Q1', from_node: 'a' }] });
    memory.storeDetail(node, [], 's2', { incoming_questions: [{ question: 'Q1 ', from_node: 'a' }, { question: 'Q1', from_node: 'b' }] });

    const stored = memory.getResult().detail_slots[0];
    expect(stored?.incoming_questions).toEqual([{ question: 'Q1', from_node: 'a' }, { question: 'Q1', from_node: 'b' }]);
  });
});

describe('AI prune reasons as pruned branches', () => {
  it('records the sender\'s reason for a resolved prune and passes it to follow-up suggestions', () => {
    const { engine } = world({ o: 'view', a: 'view', b: 'view' }, [['o', 'a'], ['o', 'b']], 'o', CLOSED, ALL);
    run(engine, { o: { prune: { a: 'a only writes the run log' } } });

    expect(engine.prunedBranches).toEqual([{ nodeId: 'a', fromFocusNodeId: 'o', reason: 'a only writes the run log' }]);
    expect(engine.deferredQuestions).toEqual([]);

    const session = {
      memory: { getUserQuestion: () => 'Trace the lineage', getResult: () => ({ detail_slots: [] }) },
      lastPresentResultSummary: 'summary',
      stateMachine: engine,
    } as unknown as AiSession;
    expect(expandNextQuestionSuggestions(session)).toContain('Pruned branches: [{"nodeId":"a","fromFocusNodeId":"o","reason":"a only writes the run log"}].');
  });

  it('re-arms a dismissed reason when the same sender prunes again, and dismisses it when the node returns', () => {
    const { engine } = world({ o: 'view', a: 'view' }, [['o', 'a']], 'o', CLOSED, ALL);
    run(engine, { o: { prune: { a: 'a only writes the run log' } } });
    const internals = engine as unknown as { taskLedger: { dismissNodeLeads(id: string, reason: string): void }; unprune(id: string): void; recordPruneLead(id: string, from: string, reason: string): void };

    internals.taskLedger.dismissNodeLeads('a', 'pruned_by_ai');
    expect(engine.prunedBranches).toEqual([]);
    internals.recordPruneLead('a', 'o', 'a only writes the run log');
    expect(engine.prunedBranches).toEqual([{ nodeId: 'a', fromFocusNodeId: 'o', reason: 'a only writes the run log' }]);

    internals.unprune('a');
    expect(engine.toJSON().engineInternals.pendingLeads.filter(lead => lead.reason === 'pruned_by_ai').map(lead => lead.status)).toEqual(['dismissed']);
  });

    it('dismisses the reason when another sender\'s keep vote retains the node', () => {
    const { engine } = world({ o: 'view', a: 'view', b: 'view', j: 'view' }, [['o', 'a'], ['o', 'b'], ['a', 'j'], ['b', 'j']], 'o', CLOSED, ALL);
    run(engine, { a: { prune: { j: 'j is off the answer' } } });

    expect(engine.prunedBranches).toEqual([]);
    expect(engine.toJSON().engineInternals.pendingLeads.filter(lead => lead.reason === 'pruned_by_ai').map(lead => lead.status)).toEqual(['dismissed']);
  });
});
