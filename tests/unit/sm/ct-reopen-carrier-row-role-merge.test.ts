/**
 * A column a committed `column_flow` edge leaves open at a non-bodied carrier stays owed by that
 * carrier's producer. The reopen that edge triggers must still dispatch the producer with the
 * column active when a different router later states a row role about another carrier the producer
 * reads: that statement is about the other branch, and a row role never outranks a committed edge.
 * Without the column the producer's hop is served "declares none of the traced columns" beside a
 * lineage question asking for that column's origin, and the chain ends at the carrier.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

const col = (name: string) => ({ name, type: 'int', nullable: 'NULL', extra: '' });

/**
 * Dispatch invariant: every column a hop's `<lineage_questions>` names is in that hop's active
 * columns, so the completeness check validates the submission against the columns the hop is asked
 * about, never against a set a merge erased.
 */
function expectQuestionColumnsActive(engine: NavigationEngine, focusId: string, active: readonly string[]): number {
  const questions = engine.toJSON().lineageQuestionsLastHop ?? [];
  for (const question of questions) {
    const named = /^Column `([^`]+)`/.exec(question)?.[1];
    expect(named, `lineage question has a column label: ${question}`).toBeDefined();
    expect(active, `${focusId}: the lineage question column ${named} is active (active ${JSON.stringify(active)})`).toContain(named);
  }
  return questions.length;
}

type Flow = NonNullable<Parameters<NavigationEngine['submitFindings']>[0]['column_flow']>;
type Routes = NonNullable<Parameters<NavigationEngine['submitFindings']>[0]['route_requests']>;

/**
 * calc (origin view) ← staging ← loader ← rawview ← cleaned ← cleaner ← rawsrc ← importer ← extsrc,
 * and calc ← master → cleaner. `cleaner` is visited first as a co-reader of `master`; `rawview`
 * then leaves `cleaned.Amount` open, reopening `cleaner`; `importer`, queued earlier through
 * `rawsrc`, states a row role for `rawsrc` before the reopened hop runs.
 */
function buildWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'calc', schema: 'ct', name: 'calc', type: 'view', columns: [col('Discount')] }),
    makeNode({ id: 'staging', schema: 'ct', name: 'staging', type: 'table', columns: [col('Amount')] }),
    makeNode({ id: 'master', schema: 'ct', name: 'master', type: 'table', columns: [col('Tier')] }),
    makeNode({ id: 'loader', schema: 'ct', name: 'loader', type: 'procedure', columns: [] }),
    makeNode({ id: 'rawview', schema: 'ct', name: 'rawview', type: 'view', columns: [col('Amount')] }),
    makeNode({ id: 'cleaned', schema: 'ct', name: 'cleaned', type: 'table', columns: [col('Amount')] }),
    makeNode({ id: 'cleaner', schema: 'ct', name: 'cleaner', type: 'procedure', columns: [] }),
    makeNode({ id: 'rawsrc', schema: 'ct', name: 'rawsrc', type: 'table', columns: [col('RawAmount')] }),
    makeNode({ id: 'importer', schema: 'ct', name: 'importer', type: 'procedure', columns: [] }),
    makeNode({ id: 'extsrc', schema: 'ct', name: 'extsrc', type: 'table', columns: [col('Value')] }),
  ];
  const edges: Array<[string, string]> = [
    ['staging', 'calc'],
    ['master', 'calc'],
    ['loader', 'staging'],
    ['rawview', 'loader'],
    ['cleaned', 'rawview'],
    ['cleaner', 'cleaned'],
    ['rawsrc', 'cleaner'],
    ['master', 'cleaner'],
    ['importer', 'rawsrc'],
    ['extsrc', 'importer'],
  ];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}

/** What each bodied focus states about the columns it is dispatched with. */
function scriptFor(focusId: string, active: readonly string[]): { flow: Flow; routes: Routes } {
  switch (focusId) {
    case 'calc':
      return {
        flow: [{ out_col: 'Discount', upstream_columns: [{ node: 'staging', col: 'Amount' }, { node: 'master', col: 'Tier' }] }],
        routes: [
          { nodeId: 'staging', question: 'Where does staging.Amount come from?', columns: ['Amount'] },
          { nodeId: 'master', question: 'Where does master.Tier come from?', columns: ['Tier'] },
        ],
      };
    case 'loader':
      return {
        flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'rawview', col: 'Amount' }], writes_to: { node: 'staging', col: 'Amount' } }],
        routes: [{ nodeId: 'rawview', question: 'Where does rawview.Amount come from?', columns: ['Amount'] }],
      };
    case 'rawview':
      return {
        flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'cleaned', col: 'Amount' }] }],
        routes: [{ nodeId: 'cleaned', question: 'Where does cleaned.Amount come from?', columns: ['Amount'] }],
      };
    case 'cleaner':
      return active.includes('Amount')
        ? {
          flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'rawsrc', col: 'RawAmount' }], writes_to: { node: 'cleaned', col: 'Amount' } }],
          routes: [{ nodeId: 'rawsrc', question: 'Is rawsrc.RawAmount the terminal source?', columns: ['RawAmount'] }],
        }
        : { flow: [], routes: [] };
    case 'importer':
      // A row-role statement about the carriers this router touches — not about `cleaner`. Once the
      // chain has reached rawsrc, importer is its producer and answers for the column too.
      return {
        flow: active.map(column => ({ out_col: column, upstream_columns: [], writes_to: { node: 'rawsrc', col: column } })),
        routes: [
          { nodeId: 'rawsrc', question: 'Which rows does importer append to rawsrc?', columns: 'none' },
          { nodeId: 'extsrc', question: 'Which extsrc rows does importer admit?', columns: 'none' },
        ],
      };
    default:
      throw new Error(`no script for focus ${focusId}`);
  }
}

/** Runs the exploration, returning the focus order and the active set each hop was dispatched with. */
function walk(engine: NavigationEngine): Array<{ focusId: string; active: string[]; lineageQuestions: number }> {
  const dispatched: Array<{ focusId: string; active: string[]; lineageQuestions: number }> = [];
  for (let hop = 0; hop < 30; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return dispatched;
    const focusId = ctx.focus_node.id;
    const active = [...(engine.columnAspect?.active_columns ?? [])];
    const lineageQuestions = expectQuestionColumnsActive(engine, focusId, active);
    dispatched.push({ focusId, active, lineageQuestions });

    const { flow, routes } = scriptFor(focusId, active);
    const named = new Set(routes.map(route => route.nodeId));
    for (const id of engine.requiredNeighborIds(focusId)) {
      if (!named.has(id)) routes.push({ nodeId: id, question: `What does ${id} do on this path?` });
    }
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId} on the Discount path`,
      verdict: 'analyze',
      column_flow: flow,
      route_requests: routes,
    });
    expect('error' in outcome, `hop ${hop} at ${focusId} is accepted: ${JSON.stringify(outcome)}`).toBe(false);
  }
  throw new Error('the walk did not complete within 30 hops');
}

function startEngine(): NavigationEngine {
  const { model, graph } = buildWorld();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const init = engine.init({
    origin: 'calc',
    question: 'Trace calc.Discount back to its original sources',
    direction: 'bidirectional',
    analysisMode: 'ct',
    targetColumns: ['Discount'],
    depthIntent: { kind: 'full_frontier' },
  });
  expect('ok' in init, 'CT init succeeds').toBe(true);
  return engine;
}

describe('CT reopen — a row role stated by another router does not erase the column a committed edge left open', () => {
  it('dispatches the reopened producer with the owed column and reaches the terminal source', () => {
    const dispatched = walk(startEngine());
    const order = dispatched.map(d => d.focusId);
    const cleanerHops = dispatched.filter(d => d.focusId === 'cleaner');
    const rawviewAt = order.indexOf('rawview');
    const importerAt = order.indexOf('importer');
    const reopenAt = order.lastIndexOf('cleaner');

    // The scenario: cleaner first visited before the column reached it, then reopened after rawview
    // committed, with importer's row-role statement landing between the reopen and its dispatch.
    expect(cleanerHops.length, `cleaner is visited early and reopened (order ${JSON.stringify(order)})`).toBe(2);
    expect(order.indexOf('cleaner') < rawviewAt && rawviewAt < importerAt && importerAt < reopenAt,
      `order is cleaner, rawview, importer, cleaner (got ${JSON.stringify(order)})`).toBe(true);

    const reopened = cleanerHops[1];
    expect(reopened.lineageQuestions, 'the reopened hop carries the continuation question').toBeGreaterThan(0);
    expect(reopened.active, `the reopened hop asks the column its lineage question names (got ${JSON.stringify(reopened.active)})`)
      .toEqual(['Amount']);
  });

  it('the chain reaches the terminal source behind the reopened producer (reopen first, row role second)', () => {
    const engine = startEngine();
    walk(engine);
    const edges = engine.columnAspect?.edges ?? [];
    expect(
      edges.some(edge => edge.from_node === 'rawsrc' && edge.from_col === 'RawAmount'),
      `edges: ${JSON.stringify(edges.map(e => `${e.from_node}.${e.from_col}→${e.to_node}.${e.to_col}`))}`,
    ).toBe(true);
  });
});

/**
 * First-visit arrival orders. calc (origin view) reads mid (view), cleaned (table) and feed (table);
 * mid reads cleaned; cleaner writes cleaned and reads rawsrc; importer writes rawsrc and feed.
 * calc commits `Region ← cleaned.Region`, mid commits `Amount ← cleaned.Amount`, and importer —
 * reached only through calc's row-role route to feed — states a row role for rawsrc, which lands on
 * cleaner's queued entry. The route order at calc decides whether that row role arrives before or
 * after mid's column demand: the agenda keeps the origin's seed order, so the order of calc's
 * inputs does.
 */
function buildArrivalWorld(rowRoleFirst: boolean): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'calc', schema: 'ct', name: 'calc', type: 'view', columns: [col('Discount')] }),
    makeNode({ id: 'mid', schema: 'ct', name: 'mid', type: 'view', columns: [col('Amount')] }),
    makeNode({ id: 'cleaned', schema: 'ct', name: 'cleaned', type: 'table', columns: [col('Amount'), col('Region')] }),
    makeNode({ id: 'feed', schema: 'ct', name: 'feed', type: 'table', columns: [col('BatchId')] }),
    makeNode({ id: 'cleaner', schema: 'ct', name: 'cleaner', type: 'procedure', columns: [] }),
    makeNode({ id: 'rawsrc', schema: 'ct', name: 'rawsrc', type: 'table', columns: [col('RawAmount'), col('RawRegion')] }),
    makeNode({ id: 'importer', schema: 'ct', name: 'importer', type: 'procedure', columns: [] }),
  ];
  const originInputs: Array<[string, string]> = rowRoleFirst
    ? [['feed', 'calc'], ['mid', 'calc'], ['cleaned', 'calc']]
    : [['mid', 'calc'], ['feed', 'calc'], ['cleaned', 'calc']];
  const edges: Array<[string, string]> = [
    ...originInputs,
    ['cleaned', 'mid'],
    ['cleaner', 'cleaned'],
    ['rawsrc', 'cleaner'],
    ['importer', 'rawsrc'],
    ['importer', 'feed'],
  ];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}

type Dispatch = { focusId: string; active: string[]; lineageQuestions: number };

function walkArrival(rowRoleFirst: boolean): { engine: NavigationEngine; dispatched: Dispatch[] } {
  const { model, graph } = buildArrivalWorld(rowRoleFirst);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect('ok' in engine.init({
    origin: 'calc', question: 'Trace calc.Discount back to its original sources', direction: 'bidirectional',
    analysisMode: 'ct', targetColumns: ['Discount'], depthIntent: { kind: 'full_frontier' },
  }), 'CT init succeeds').toBe(true);

  const rawOf: Record<string, string> = { Amount: 'RawAmount', Region: 'RawRegion' };
  const script = (focusId: string, active: readonly string[]): { flow: Flow; routes: Routes } => {
    switch (focusId) {
      case 'calc':
        return {
          flow: [{ out_col: 'Discount', upstream_columns: [{ node: 'mid', col: 'Amount' }, { node: 'cleaned', col: 'Region' }] }],
          routes: [
            { nodeId: 'mid', question: 'Where does mid.Amount come from?', columns: ['Amount'] },
            { nodeId: 'feed', question: 'Which feed rows does calc admit?', columns: 'none' },
            { nodeId: 'cleaned', question: 'Where does cleaned.Region come from?', columns: ['Region'] },
          ],
        };
      case 'mid':
        return {
          flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'cleaned', col: 'Amount' }] }],
          routes: [{ nodeId: 'cleaned', question: 'Where does cleaned.Amount come from?', columns: ['Amount'] }],
        };
      case 'importer':
        return {
          flow: active.map(column => ({ out_col: column, upstream_columns: [], writes_to: { node: 'rawsrc', col: column } })),
          routes: [{ nodeId: 'rawsrc', question: 'Which rows does importer append to rawsrc?', columns: 'none' }],
        };
      case 'cleaner':
        return {
          flow: active.map(column => ({
            out_col: column,
            upstream_columns: [{ node: 'rawsrc', col: rawOf[column] }],
            writes_to: { node: 'cleaned', col: column },
          })),
          routes: active.length > 0
            ? [{ nodeId: 'rawsrc', question: 'Is rawsrc the terminal source?', columns: active.map(column => rawOf[column]) }]
            : [],
        };
      default:
        throw new Error(`no script for focus ${focusId}`);
    }
  };

  const dispatched: Dispatch[] = [];
  for (let hop = 0; hop < 30; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) return { engine, dispatched };
    const focusId = ctx.focus_node.id;
    const active = [...(engine.columnAspect?.active_columns ?? [])];
    dispatched.push({ focusId, active, lineageQuestions: expectQuestionColumnsActive(engine, focusId, active) });
    const { flow, routes } = script(focusId, active);
    const named = new Set(routes.map(route => route.nodeId));
    for (const id of engine.requiredNeighborIds(focusId)) {
      if (!named.has(id)) routes.push({ nodeId: id, question: `What does ${id} do on this path?` });
    }
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `capture for ${focusId}` }],
      summary: `${focusId} on the Discount path`,
      verdict: 'analyze',
      column_flow: flow,
      route_requests: routes,
    });
    expect('error' in outcome, `hop ${hop} at ${focusId} is accepted: ${JSON.stringify(outcome)}`).toBe(false);
  }
  throw new Error('the walk did not complete within 30 hops');
}

describe('CT column demand — order-independent union of committed edges', () => {
  for (const rowRoleFirst of [true, false]) {
    const label = rowRoleFirst ? 'row role before the column demand' : 'column demand before the row role';
    it(`${label}: the producer dispatches every column committed edges demand of it`, () => {
      const { engine, dispatched } = walkArrival(rowRoleFirst);
      const order = dispatched.map(d => d.focusId);
      const midAt = order.indexOf('mid');
      const importerAt = order.indexOf('importer');
      const cleanerAt = order.indexOf('cleaner');
      expect(rowRoleFirst ? importerAt < midAt && midAt < cleanerAt : midAt < importerAt && importerAt < cleanerAt,
        `arrival order holds (got ${JSON.stringify(order)})`).toBe(true);

      const cleaner = dispatched[cleanerAt];
      expect(cleaner.lineageQuestions, 'the producer carries its continuation questions').toBeGreaterThan(0);
      expect([...cleaner.active].sort(), `both demanded columns are active (got ${JSON.stringify(cleaner.active)})`)
        .toEqual(['Amount', 'Region']);

      const edges = engine.columnAspect?.edges ?? [];
      for (const raw of ['RawAmount', 'RawRegion']) {
        expect(edges.some(edge => edge.from_node === 'rawsrc' && edge.from_col === raw), `the chain reaches rawsrc.${raw}`).toBe(true);
      }
    });

    it(`${label}: a node reached only by a row-role route, with no committed demand, still dispatches none`, () => {
      const { dispatched } = walkArrival(rowRoleFirst);
      const importer = dispatched.find(d => d.focusId === 'importer');
      expect(importer?.active, 'importer is a row-role hop on its first dispatch').toEqual([]);
    });
  }
});
