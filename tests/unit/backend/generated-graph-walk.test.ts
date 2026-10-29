// Owner: src/ai/sm/smBase.ts, columnTracer.ts and src/engine/columnTraceView.ts; the graph a walk delivers over generated topologies, authored votes and column relations.
/** Walks generated graphs (hand-picked and seeded DAGs, every four-node DAG, every three-branch vote mask) through the registered tools with the invariants of `walkRows.ts` except its `offers` field, which `lineage-walk.test.ts` asserts on the catalog rows; the delivered graph must equal the independent directed closure of the origin (invariant e) or the literal graph authored here. */
import { describe, expect, it } from 'vitest';
import type { WalkCase, WalkDecision, WalkHop, WalkRefusal } from '../../cases/loadCases.cjs';
import { findDisconnectedViewNodes } from '../../../src/ai/tools/presentResult';
import { buildColumnTraceView, buildColumnThreadIndex, columnRowKey, columnThread } from '../../../src/engine/columnTraceView';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { closureOutcome, directedClosure, walkRow } from './helpers/walkRows';

type Edge = [string, string];
type Direction = WalkCase['direction'];
type Graph = WalkCase['graph'];
const modes = ['bb', 'ct'] as const;
const directions = ['upstream', 'downstream', 'bidirectional'] as const;

const rowOf = (id: string, mode: WalkCase['mode'], direction: Direction, graph: Graph, hops: WalkHop[] = [], expectNodes: string[] = [], expectEdges: Edge[] = [], columnEdges: Array<[string, string, string, string]> = []): WalkCase =>
  ({ id, contract: 'walk', mode, direction, graph, hops, expect: { nodes: expectNodes, edges: expectEdges, column_edges: columnEdges } });

/** `edges` are written upstream of `o`; a downstream walk gets them flipped so each shape is walked from both sides. */
function generated(name: string, edges: Edge[], mode: WalkCase['mode'], direction: Direction, reverse: boolean, options: { tables?: string[]; excluded?: string[]; levels?: number } = {}): WalkCase {
  const oriented = direction === 'downstream' ? edges.map(([a, b]): Edge => [b, a]) : edges;
  const ids = [...new Set(['o', 'disconnected', ...oriented.flat()])];
  const ordered = reverse ? [...ids].reverse() : ids;
  return rowOf(name, mode, direction, {
    origin: 'o', columns: ['X'], excluded: options.excluded, levels: options.levels,
    nodes: Object.fromEntries(ordered.map(id => [id, options.tables?.includes(id) ? 'table' : 'view'])),
    edges: reverse ? [...oriented].reverse() : oriented,
  });
}

/** Every delivered object is connected to the origin through the delivered edges. */
const expectConnected = (row: WalkCase, outcome: Awaited<ReturnType<typeof walkRow>>) =>
  expect(findDisconnectedViewNodes(outcome.nodes, outcome.edges.map(pair => [...pair.split('>'), 'read'] as [string, string, string]), row.graph.origin), row.id).toEqual([]);

/** Walks the row's own decisions: every hop invariant holds and the literal graph authored in the row results. */
async function expectScripted(row: WalkCase) {
  const outcome = await walkRow(row, true);
  expect(outcome.violations, row.id).toEqual([]);
  expectConnected(row, outcome);
  expect(outcome.nodes, row.id).toEqual([...row.expect.nodes].sort());
  expect(outcome.edges, row.id).toEqual(row.expect.edges.map(([a, b]) => `${a}>${b}`).sort());
  expect(outcome.columnEdges, row.id).toEqual((row.expect.column_edges ?? []).map(([a, ac, b, bc]) => `${a}.${ac}>${b}.${bc}`).sort());
  return outcome;
}

/** Asking every open neighbor ahead must deliver the directed closure with every other hop invariant holding. */
async function expectClosure(row: WalkCase) {
  const outcome = await walkRow(row, false);
  const oracle = closureOutcome(row);
  expect(outcome.violations, row.id).toEqual([]);
  expectConnected(row, outcome);
  expect(outcome.nodes, row.id).toEqual(oracle.nodes);
  expect(outcome.edges, row.id).toEqual(oracle.edges);
}

const complexGraphs: Array<{ name: string; edges: Edge[]; tables?: string[]; excluded?: string[]; levels?: number }> = [
  { name: 'nested diamonds with overlap and rejoin', edges: [['a', 'o'], ['b', 'o'], ['c', 'a'], ['d', 'a'], ['d', 'b'], ['e', 'b'], ['f', 'c'], ['f', 'd'], ['g', 'd'], ['g', 'e'], ['h', 'f'], ['h', 'g']] },
  { name: 'storage fan-in and fan-out', edges: [['a', 'o'], ['b', 'o'], ['t', 'a'], ['t', 'b'], ['c', 't'], ['d', 't'], ['u', 'c'], ['u', 'd'], ['e', 'u']], tables: ['t', 'u'] },
  { name: 'origin storage with shared SQL', edges: [['a', 'o'], ['b', 'o'], ['c', 'a'], ['c', 'b']], tables: ['o'] },
  { name: 'cycle with rejoining tail', edges: [['a', 'o'], ['b', 'a'], ['c', 'b'], ['a', 'c'], ['d', 'b'], ['d', 'c'], ['e', 'd']] },
  { name: 'mixed upstream downstream and sideways', edges: [['a', 'o'], ['b', 'a'], ['o', 'c'], ['c', 'd'], ['a', 'side'], ['side', 'tail']] },
  { name: 'excluded shared carrier blocks tail', edges: [['a', 'o'], ['b', 'o'], ['t', 'a'], ['t', 'b'], ['c', 't']], tables: ['t'], excluded: ['t'] },
  { name: 'exact border through storage', edges: [['a', 'o'], ['b', 'o'], ['t', 'a'], ['t', 'b'], ['c', 't'], ['d', 'c']], tables: ['t'], levels: 2 },
];

// Fixed seeds generate topology only; the expected result still comes from the independent directed closure.
for (let seed = 1; seed <= 12; seed++) {
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const ids = ['o', ...Array.from({ length: 17 }, (_, i) => `n${i + 1}`)];
  const edges: Edge[] = ids.slice(1).map((id, i) => [id, ids[i]]);
  for (let high = 2; high < ids.length; high++) for (let low = 0; low < high - 1; low++)
    if (random() % 5 === 0) edges.push([ids[high], ids[low]]);
  complexGraphs.push({ name: `seeded overlapping DAG ${seed}`, edges, ...(seed % 2 === 0 ? { tables: ['n3', 'n7', 'n11'] } : {}) });
}

describe('generated graphs deliver the directed closure (invariant e)', () => {
  // One test per graph, mode and direction keeps every test far inside the per-test budget when the machine is loaded.
  it.each(complexGraphs.flatMap(graph => modes.flatMap(mode => directions.map(direction => ({ ...graph, mode, direction })))))('$name: $mode $direction', async ({ name, edges, mode, direction, ...options }) => {
    for (const reverse of [false, true]) await expectClosure(generated(`${name}${reverse ? '/reversed' : ''}`, edges, mode, direction, reverse, options));
  });

  // All 64 edge subsets of one fixed topological order on four nodes, including disconnected components.
  it.each(Array.from({ length: 64 }, (_, mask) => mask))('every fixed-order four-node DAG: mask %i', async mask => {
    const possible: Edge[] = [['a', 'o'], ['b', 'o'], ['c', 'o'], ['b', 'a'], ['c', 'a'], ['c', 'b']];
    const edges = possible.filter((_, bit) => mask & (1 << bit));
    for (const mode of modes) for (const direction of directions) for (const reverse of [false, true])
      await expectClosure(generated(`dag-${mask}/${mode}/${direction}${reverse ? '/reversed' : ''}`, edges, mode, direction, reverse));
  });
});

/** Mechanical authored votes over three branches that share one join with a tail; not an oracle for SQL relevance. */
describe('three-branch vote matrix', () => {
  const branches = ['a', 'b', 'c'];
  const ask = (...nodes: string[]): WalkDecision => ({ ask: nodes, map: [] });
  const original: Edge[] = [['a', 'o'], ['b', 'o'], ['c', 'o'], ['j', 'a'], ['j', 'b'], ['j', 'c'], ['tail', 'j']];

  it.each(Array.from({ length: 8 }, (_, keepMask) => keepMask))('keep mask %i: one keep retains the join and tail, unanimous prune cuts both, whatever the order', async keepMask => {
    for (const mode of modes) for (const direction of directions) for (const reversed of [false, true]) {
      const edges = direction === 'downstream' ? original.map(([a, b]): Edge => [b, a]) : original;
      const order = reversed ? ['tail', 'j', 'c', 'b', 'a', 'o'] : ['o', 'a', 'b', 'c', 'j', 'tail'];
      const kept = keepMask ? ['a', 'b', 'c', 'j', 'o', 'tail'] : ['a', 'b', 'c', 'o'];
      const hops: WalkHop[] = [{ at: 'o', decide: ask('a', 'b', 'c') }, ...branches.map((at, bit): WalkHop => {
        const decide: WalkDecision = keepMask & (1 << bit) ? ask('j') : { prune: ['j'], map: [] };
        // The first branch first answers with no vote about the join: refused, then corrected.
        return at === 'a' ? { at, refuse: { map: [], kind: 'route_validation_failed', field: '', issue: 'neighbor_undecided' }, decide } : { at, decide };
      }), ...(keepMask ? [{ at: 'j', decide: ask('tail') }, { at: 'tail', decide: ask() }] : [])];
      const row = rowOf(`votes-${keepMask}/${mode}/${direction}${reversed ? '/reversed' : ''}`, mode, direction, {
        origin: 'o', columns: ['X'], nodes: Object.fromEntries(order.map(id => [id, 'view'])), edges: reversed ? [...edges].reverse() : edges,
      }, hops, kept.sort(), edges.filter(([a, b]) => kept.includes(a) && kept.includes(b)));
      await expectScripted(row);
    }
  });
});

/** Row-only objects own only `Region`: they restrict rows and carry no Amount value, so their flow is empty and no one maps them. */
const decisions = (graph: Graph, direction: 'upstream' | 'downstream', mode: WalkCase['mode'], rowOnly: string[] = [], prune: Record<string, string[]> = {}): Record<string, WalkDecision> => {
  const entries = Object.keys(graph.nodes).filter(id => graph.nodes[id] !== 'table').map((id): [string, WalkDecision] => {
    const ahead = graph.edges.filter(([from, to]) => (direction === 'upstream' ? to : from) === id).map(([from, to]) => (direction === 'upstream' ? from : to));
    const behind = direction === 'upstream' ? [] : graph.edges.filter(([, to]) => to === id).map(([from]) => from).filter(from => !rowOnly.includes(from));
    const open = ahead.filter(node => !(prune[id] ?? []).includes(node));
    const mapped = mode === 'ct' && direction === 'upstream' ? open.filter(node => !rowOnly.includes(node)) : [];
    const asked = open.filter(node => !mapped.includes(node));
    return [id, { ...(prune[id] ? { prune: prune[id] } : {}), ...(asked.length ? { ask: asked } : {}),
      ...(mode === 'ct' ? { map: rowOnly.includes(id) ? [] : [{ col: 'Amount', from: [...mapped, ...behind].map(node => ({ node, col: 'Amount' })) }] } : {}) }];
  });
  return Object.fromEntries(entries);
};

/** BB and CT deliver one object graph under the same approved scope and prune decisions. */
describe('BB and CT object graph parity', () => {
  const shapes: Array<{ name: string; edges: Edge[]; rowOnly: string[]; prune?: Record<string, string[]>; nodes: string[]; order: Record<'upstream' | 'downstream', string[]> }> = [
    { name: 'row branch', edges: [['carrier', 'root'], ['side', 'root'], ['behind', 'side']], rowOnly: ['side', 'behind'], nodes: ['behind', 'carrier', 'root', 'side'],
      order: { upstream: ['root', 'carrier', 'side', 'behind'], downstream: ['root', 'carrier', 'side', 'behind'] } },
    { name: 'dead end', edges: [['focus', 'root'], ['off', 'focus'], ['exclusive', 'off']], rowOnly: [], prune: { focus: ['off'] }, nodes: ['focus', 'root'],
      order: { upstream: ['root', 'focus'], downstream: ['root', 'focus'] } },
    { name: 'diamond', edges: [['left', 'root'], ['right', 'root'], ['shared', 'left'], ['shared', 'right'], ['source', 'shared']], rowOnly: [], nodes: ['left', 'right', 'root', 'shared', 'source'],
      order: { upstream: ['root', 'left', 'right', 'shared', 'source'], downstream: ['root', 'left', 'right', 'shared', 'source'] } },
  ];
  it.each(shapes.flatMap(shape => (['upstream', 'downstream'] as const).flatMap(direction => modes.map(mode => ({ shape, direction, mode })))))('$shape.name, $direction, $mode', async ({ shape, direction, mode }) => {
    const edges = direction === 'upstream' ? shape.edges : shape.edges.map(([a, b]): Edge => [b, a]);
    const ids = [...new Set(edges.flat())];
    const graph: Graph = { origin: 'root', columns: ['Amount'], nodes: Object.fromEntries(ids.map(id => [id, 'view'])), edges,
      node_columns: Object.fromEntries(shape.rowOnly.map(id => [id, ['Region']])) };
    const decide = decisions(graph, direction, mode, shape.rowOnly, shape.prune);
    const row = rowOf(`${shape.name}/${direction}/${mode}`, mode, direction, graph, shape.order[direction].map(at => ({ at, decide: decide[at] })),
      shape.nodes, edges.filter(([a, b]) => shape.nodes.includes(a) && shape.nodes.includes(b)),
      // The mapped legs are exactly the decisions authored for the visited objects.
      shape.order[direction].flatMap(at => (decide[at].map ?? []).flatMap(entry => entry.from.map(ref => [ref.node, ref.col, at, entry.col] as [string, string, string, string]))));
    // Every delivered object owns a detail slot: all of these objects are visited.
    expect((await expectScripted(row)).detailNodes, row.id).toEqual(shape.nodes);
  });
});

const view = (...ids: string[]) => Object.fromEntries(ids.map(id => [id, 'view' as const]));
const flowOf = (...from: Array<string | [string, string[]]>) => [{ col: 'X', from: from.map(entry => typeof entry === 'string' ? { node: entry, col: 'X' } : { node: entry[0], col: 'X', transforms: entry[1] }) }];

/** An authored filter or combine neighbor stays in the result as a row-influence leg without its own branch being walked. */
describe('authored row-influence neighbor', () => {
  it.each(['filter', 'combine'])('keeps a %s neighbor without walking its branch', async role => {
    await expectScripted(rowOf(`influence/${role}`, 'ct', 'upstream', {
      origin: 'root', columns: ['Amount'], node_columns: { side: ['Region'], behind: ['Region'] },
      nodes: { source: 'table', carrier: 'view', root: 'view', side: 'view', behind: 'view' },
      edges: [['source', 'carrier'], ['carrier', 'root'], ['side', 'root'], ['behind', 'side']],
    }, [
      { at: 'root', decide: { map: [{ col: 'Amount', from: [{ node: 'carrier', col: 'Amount', transforms: ['compute'] }, { node: 'side', col: 'Region', transforms: [role] }] }] } },
      { at: 'carrier', decide: { map: [{ col: 'Amount', from: [{ node: 'source', col: 'Amount', transforms: ['pass_through'] }] }] } },
    ], ['source', 'carrier', 'root', 'side'], [['source', 'carrier'], ['carrier', 'root'], ['side', 'root']],
    [['carrier', 'Amount', 'root', 'Amount'], ['side', 'Region', 'root', 'Amount'], ['source', 'Amount', 'carrier', 'Amount']]));
  });
});

/** A branch vote is valid in either order and another branch's keep prevents removal of the shared neighbor. */
describe('shared neighbor losing prune votes', () => {
  it.each((['bb-question', 'ct-question', 'ct-mapping'] as const).flatMap(keep => [false, true].map(pruneFirst => ({ keep, pruneFirst }))))('$keep, prune first=$pruneFirst', async ({ keep, pruneFirst }) => {
    const mode = keep === 'bb-question' ? 'bb' : 'ct', keeper = pruneFirst ? 'b' : 'a';
    const branch = (at: string): WalkHop => ({ at, decide: at !== keeper ? { prune: ['j'], map: [] }
      : keep === 'ct-mapping' ? { map: flowOf('j') } : { ask: ['j'], map: [] } });
    await expectScripted(rowOf(`votes/${keep}/${pruneFirst}`, mode, 'upstream', {
      origin: 'o', columns: ['X'], nodes: view('o', 'a', 'b', 'j'), edges: [['a', 'o'], ['b', 'o'], ['j', 'a'], ['j', 'b']],
    }, [{ at: 'o', decide: mode === 'bb' ? { ask: ['a', 'b'] } : { map: flowOf('a', 'b') } }, branch('a'), branch('b'), { at: 'j', decide: { ask: [], map: [] } }],
    ['o', 'a', 'b', 'j'], [['a', 'o'], ['b', 'o'], ['j', 'a'], ['j', 'b']],
    mode === 'bb' ? [] : [['a', 'X', 'o', 'X'], ['b', 'X', 'o', 'X'], ...(keep === 'ct-mapping' ? [['j', 'X', keeper, 'X'] as [string, string, string, string]] : [])]));
  });
});

/** A prune that cannot be accepted beside a prior branch keep is refused at its own field and corrected there. */
describe('losing votes preserve local conflicts', () => {
  const keepJ: WalkDecision = { ask: ['j'], map: [] };
  it.each([
    { fault: 'mapping', refuse: { prune: ['j'], map: flowOf('j'), kind: 'route_validation_failed', field: 'prune_neighbors.0.id', issue: 'prune_target' }, decide: { map: flowOf('j') }, columnEdges: [['j', 'X', 'b', 'X']] },
    { fault: 'question', refuse: { prune: ['j'], ...keepJ, kind: 'route_validation_failed', field: 'questions.0.nodeId', issue: 'conflict' }, decide: keepJ, columnEdges: [] },
    ...['unknown', 'origin', 'out-of-scope'].map(fault => ({ fault, refuse: { prune: [{ unknown: 'missing', origin: 'o', 'out-of-scope': 'x' }[fault]!], ...keepJ, kind: 'invalid_input', field: 'prune_neighbors.0.id', issue: 'prune_target' }, decide: keepJ, columnEdges: [] })),
  ] as Array<{ fault: string; refuse: WalkRefusal; decide: WalkDecision; columnEdges: Array<[string, string, string, string]> }>)('refuses $fault beside a prior branch keep', async ({ fault, refuse, decide, columnEdges }) => {
    await expectScripted(rowOf(`conflict/${fault}`, 'ct', 'upstream', {
      origin: 'o', columns: ['X'], nodes: view('o', 'a', 'b', 'j', 'x'), excluded: ['x'], edges: [['a', 'o'], ['b', 'o'], ['j', 'a'], ['j', 'b'], ['x', 'b']],
    }, [
      { at: 'o', decide: { map: flowOf('a', 'b') } },
      { at: 'a', decide: { map: flowOf('j') } },
      { at: 'b', refuse, decide },
      { at: 'j', decide: { ask: [], map: [] } },
    ], ['o', 'a', 'b', 'j'], [['a', 'o'], ['b', 'o'], ['j', 'a'], ['j', 'b']],
    [['a', 'X', 'o', 'X'], ['b', 'X', 'o', 'X'], ['j', 'X', 'a', 'X'], ...columnEdges]));
  });
});

/** The same declared object graph with any subset of authored column relations: an object dependency stays visible unless a directed column leg covers it, and never joins a value thread. */
describe('column view over every four-node DAG', () => {
  it.each(Array.from({ length: 64 }, (_, mask) => mask))('mask %i', mask => {
    const possible: Edge[] = [['a', 'o'], ['b', 'o'], ['c', 'o'], ['b', 'a'], ['c', 'a'], ['c', 'b']];
    const edges = possible.filter((_, bit) => mask & (1 << bit));
    const weakClosure = (pairs: Edge[]) => {
      const reached = new Set(['o']);
      for (let pass = 0; pass < 4; pass++) for (const [a, b] of pairs) if (reached.has(a) || reached.has(b)) { reached.add(a); reached.add(b); }
      return reached;
    };
    if (weakClosure(edges).size !== 4) return;
    const objects = new Map(['o', 'a', 'b', 'c'].map(id => [id, { id, label: id, schema: 'dbo', objectType: 'view' }]));
    for (let columnMask = 0; columnMask < (1 << edges.length); columnMask++) {
      const selected = edges.filter((_edge, bit) => columnMask & (1 << bit));
      const view = buildColumnTraceView({ objects, config: DEFAULT_CONFIG, requested: { node: 'o', columns: ['X'] },
        objectEdges: edges.map(([source, target]) => ({ source, target })),
        relations: selected.map(([fromNode, toNode]) => ({ hopNode: toNode, fromNode, fromCol: 'X', toNode, toCol: 'X' })),
      });
      const rendered = [...view.edges, ...view.objectEdges].map(({ source, target }): Edge => [source, target]);
      expect(rendered.map(pair => pair.join('>')).sort(), `dag${mask}/columns${columnMask}`).toEqual(edges.map(pair => pair.join('>')).sort());
      expect([...weakClosure(rendered)].sort()).toEqual(['a', 'b', 'c', 'o']);
      expect(columnThread(buildColumnThreadIndex(view), columnRowKey('o', 'X')))
        .toEqual(new Set([...directedClosure('o', selected, true), ...directedClosure('o', selected, false)].map(id => columnRowKey(id, 'X'))));
    }
  });
});
