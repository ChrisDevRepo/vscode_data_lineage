/** A recorded column link is admitted only when it attaches to the tracked roots in the approved direction. */
import { describe, expect, it } from 'vitest';
import { ColumnTracer, columnAttachment, columnClosure, columnEndpointKeyFactory } from '../../../src/ai/sm/columnTracer';
import type { HopFindingKept } from '../../../src/ai/sm/smTypes';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeModel, makeNode } from './helpers/fixtures';
import { makeGraph } from '../helpers/testUtils';

const column = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
const tables = ['staging', 'archive', 'source', 'report', 'origin'];
const nodes = [
  makeNode({ id: 'writer', name: 'writer', schema: 'dbo', type: 'procedure', columns: [], bodyScript: 'INSERT dbo.archive SELECT OrderQty, OrderDate FROM dbo.staging WHERE OrderDate < @Cutoff;' }),
  ...tables.map(id => makeNode({ id, name: id, schema: 'dbo', type: 'table' as const,
    columns: ['OrderQty', 'OrderDate', 'KeyCol', 'DateCol'].map(column) })),
];
const model = makeModel(nodes, [['staging', 'writer'], ['source', 'writer'], ['writer', 'archive'], ['writer', 'staging'], ['report', 'writer'], ['writer', 'report'], ['writer', 'source']], ['dbo']);
const map = new Map(nodes.map(n => [n.id, n]));
type Ref = { node: string; col: string };
type Entry = HopFindingKept['column_flow'] extends Array<infer E> | undefined ? E : never;
const finding = (column_flow: Entry[]): HopFindingKept => ({ focus_node_id: 'writer', verdict: 'analyze', summary: 'Declared SQL', sections: [], column_flow });
const validate = (active: string[], direction: 'upstream' | 'downstream', incoming: Ref[], flow: Entry[], roots: Ref[] = incoming) =>
  new ColumnTracer(active).validateColumnFlow('writer', finding(flow), map, model, null, undefined, undefined, direction, incoming, [], [], [], roots);

describe('column link attachment', () => {
  it('rejects an upstream contributor link whose destination feeds no tracked endpoint', () => {
    const result = validate(['OrderQty'], 'upstream', [{ node: 'staging', col: 'OrderQty' }], [
      { out_col: 'OrderQty', writes_to: { node: 'archive', col: 'OrderQty' }, upstream_columns: [{ node: 'staging', col: 'OrderQty' }, { node: 'staging', col: 'OrderDate', transforms: ['compute'] }] },
    ]);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({
      kind: 'untracked_out_col',
      path: 'column_flow.0.upstream_columns',
      reason: expect.stringContaining('staging.OrderDate -> archive.OrderQty'),
    }));
    expect(result.stagedEdges.some(edge => edge.to_node === 'archive')).toBe(false);
  });

  it('rejects the whole call for its detached entry while the attached entry stays staged', () => {
    const result = validate(['OrderQty'], 'upstream', [{ node: 'report', col: 'OrderQty' }], [
      { out_col: 'OrderQty', writes_to: { node: 'report', col: 'OrderQty' }, upstream_columns: [{ node: 'staging', col: 'OrderQty' }] },
      { out_col: 'OrderQty', writes_to: { node: 'archive', col: 'OrderQty' }, upstream_columns: [{ node: 'source', col: 'OrderQty' }] },
    ]);
    expect(result.invalidRoutes.map(route => route.path)).toEqual(['column_flow.1.upstream_columns']);
    expect(result.invalidRoutes[0].reason).toContain('source.OrderQty -> archive.OrderQty');
  });

  it('admits a same-table step into a tracked column', () => {
    const result = validate(['KeyCol'], 'upstream', [{ node: 'staging', col: 'KeyCol' }], [
      { out_col: 'KeyCol', writes_to: { node: 'staging', col: 'KeyCol' }, upstream_columns: [{ node: 'staging', col: 'DateCol' }] },
    ]);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toContainEqual(expect.objectContaining({ from_node: 'staging', from_col: 'DateCol', to_node: 'staging', to_col: 'KeyCol' }));
  });

  it('admits a value contributor into a tracked output and stages no column edge for a row-selection contributor', () => {
    const result = validate(['OrderQty'], 'upstream', [{ node: 'staging', col: 'OrderQty' }], [
      { out_col: 'OrderQty', writes_to: { node: 'staging', col: 'OrderQty' }, upstream_columns: [{ node: 'source', col: 'OrderQty' }, { node: 'source', col: 'OrderDate', transforms: ['filter'] }] },
    ]);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toContainEqual(expect.objectContaining({ from_node: 'source', from_col: 'OrderQty', to_node: 'staging', to_col: 'OrderQty' }));
    expect(result.stagedEdges.some(edge => edge.from_col === 'OrderDate')).toBe(false);
  });

  it('admits the contributors of a procedure origin\'s explicit write of its requested output, and nothing else', () => {
    const origin = [{ node: 'writer', col: 'OrderQty' }];
    const write = (col: string): Entry => ({ out_col: 'OrderQty', writes_to: { node: 'report', col }, upstream_columns: [{ node: 'source', col: 'OrderQty' }] });
    const admitted = validate(['OrderQty'], 'upstream', origin, [write('OrderQty')]);
    expect(admitted.invalidRoutes).toEqual([]);
    expect(admitted.stagedEdges).toContainEqual(expect.objectContaining({ from_node: 'writer', from_col: 'OrderQty', to_node: 'report', to_col: 'OrderQty' }));
    expect(validate(['OrderQty'], 'upstream', origin, [{ ...write('OrderQty'), upstream_columns: [] }]).invalidRoutes).toEqual([]);
  });

  it('downstream: keeps a second contributor to a reached output and rejects a link into an unrelated branch', () => {
    const accepted = validate(['OrderQty'], 'downstream', [{ node: 'staging', col: 'OrderQty' }], [
      { out_col: 'OrderQty', writes_to: { node: 'archive', col: 'OrderQty' }, upstream_columns: [{ node: 'staging', col: 'OrderQty' }, { node: 'source', col: 'OrderDate', transforms: ['filter'] }] },
    ]);
    expect(accepted.invalidRoutes).toEqual([]);
    const rejected = validate(['OrderQty'], 'downstream', [{ node: 'staging', col: 'OrderQty' }], [
      { out_col: 'OrderQty', writes_to: { node: 'archive', col: 'OrderQty' }, upstream_columns: [{ node: 'staging', col: 'OrderQty' }, { node: 'source', col: 'OrderDate' }] },
      { out_col: 'OrderDate', writes_to: { node: 'archive', col: 'OrderDate' }, upstream_columns: [{ node: 'source', col: 'OrderDate' }] },
    ]);
    expect(rejected.invalidRoutes.map(route => route.path)).toEqual(['column_flow.1.upstream_columns']);
    expect(rejected.invalidRoutes[0].reason).toContain('source.OrderDate -> archive.OrderDate');
  });
});

describe('one closure per call', () => {
  const root = [{ node: 'report', col: 'OrderQty' }];
  const step = (to: string, from: string): Entry => ({ out_col: 'OrderQty', writes_to: { node: to, col: 'OrderQty' }, upstream_columns: [{ node: from, col: 'OrderQty' }] });
  const chain = [step('report', 'staging'), step('staging', 'source'), step('source', 'archive')];
  it.each([[0, 1, 2], [2, 1, 0], [1, 2, 0]])('admits a chain into the root whatever the entry order (%i, %i, %i)', (...order) => {
    const result = validate(['OrderQty'], 'upstream', root, order.map(index => chain[index]), root);
    expect(result.invalidRoutes).toEqual([]);
    expect(result.stagedEdges).toHaveLength(6);
  });
  it('rejects a link that would attach only through a rejected link of the same call', () => {
    const result = validate(['OrderQty'], 'upstream', root, [chain[0], chain[2]], root);
    expect(result.invalidRoutes.map(route => route.path)).toEqual(['column_flow.1.upstream_columns']);
  });
  it('rejects a cycle that never reaches the root and admits one through it', () => {
    const detached = validate(['OrderQty'], 'upstream', root, [chain[0], step('source', 'archive'), step('archive', 'source')], root);
    expect(detached.invalidRoutes.map(route => route.path)).toEqual(['column_flow.1.upstream_columns', 'column_flow.2.upstream_columns']);
    expect(validate(['OrderQty'], 'upstream', root, [chain[0], step('staging', 'report')], root).invalidRoutes).toEqual([]);
  });
  it('matches endpoints case-insensitively', () => {
    const result = validate(['OrderQty'], 'upstream', root, [{ out_col: 'orderqty', writes_to: { node: 'REPORT', col: 'ORDERQTY' }, upstream_columns: [{ node: 'Staging', col: 'orderQTY' }] }], root);
    expect(result.invalidRoutes).toEqual([]);
  });
});

describe('column closure', () => {
  const edge = (from: string, to: string, hop = 'h') => ({ hop_node: hop, from_node: from, from_col: 'c', to_node: to, to_col: 'c' });
  const edges = [edge('a', 'root'), edge('b', 'a'), edge('root', 'out'), edge('in', 'out'), edge('x', 'in'), edge('out', 'far'), edge('q', 'z')];
  const roots = [{ node: 'root', col: 'c' }];
  const names = (set: Set<string>) => [...set].map(k => (JSON.parse(k) as string[])[0]).sort();
  it.each([
    ['upstream', ['a', 'b', 'root']],
    ['downstream', ['a', 'b', 'far', 'in', 'out', 'root', 'x']],
    ['both', ['a', 'b', 'far', 'in', 'out', 'root', 'x']],
  ] as const)('%s closure of the roots', (direction, expected) => {
    expect(names(columnClosure(roots, edges, direction, columnEndpointKeyFactory(new Map())))).toEqual(expected);
  });
  it('attaches the destination of the origin\'s own write of a root with that hop\'s inputs, and no other hop\'s link into it', () => {
    const own = edge('m', 'dest', 'root'), foreign = edge('n', 'dest'), feeder = edge('k', 'm');
    const withWrite = [...edges, edge('root', 'dest', 'root'), own, foreign, feeder, edge('other', 'dest2', 'other'), edge('root', 'dest3', 'elsewhere')];
    const upstream = columnAttachment(roots, withWrite, 'upstream', columnEndpointKeyFactory(new Map()));
    expect(names(upstream.endpoints)).toEqual(['a', 'b', 'dest', 'k', 'm', 'root']);
    expect([own, feeder, foreign].map(upstream.attaches)).toEqual([true, true, false]);
    expect(columnAttachment(roots, withWrite, 'downstream', columnEndpointKeyFactory(new Map())).attaches(foreign)).toBe(true);
  });
});

function navigation() {
  const ns = [
    makeNode({ id: 'root', name: 'root', schema: 'dbo', type: 'view', columns: [column('Net')] }),
    ...['owed', 'other', 'source'].map(id => makeNode({ id, name: id, schema: 'dbo', type: 'table' as const, columns: [column('Amount'), column('Stamp')] })),
    makeNode({ id: 'producer', name: 'producer', schema: 'dbo', type: 'procedure', columns: [], bodyScript: 'INSERT dbo.owed SELECT Amount, Stamp FROM dbo.source WHERE Stamp > @Cutoff; INSERT dbo.other SELECT Amount, Stamp FROM dbo.source;' }),
  ];
  const ps: Array<[string, string]> = [['owed', 'root'], ['source', 'producer'], ['producer', 'owed'], ['producer', 'other']];
  const m = makeModel(ns, ps, ['dbo']);
  const e = new NavigationEngine(m, makeGraph(ns, ps), () => {}, {});
  expect(e.init({ origin: 'root', question: 'Trace Net', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Net'], depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  e.getHopContext();
  expect(e.submitFindings({ focus_node_id: 'root', verdict: 'analyze', summary: 'Net uses owed Amount', sections: [{ angle: 'technical', text: 'Declared SQL' }], column_flow: [{ out_col: 'Net', upstream_columns: [{ node: 'owed', col: 'Amount' }] }] })).toMatchObject({ ok: true });
  expect(e.getHopContext()).toMatchObject({ focus_node: { id: 'producer' } });
  return e;
}

describe('carried columns', () => {
  it('rejects a detached link at the engine and carries only columns attached to the root', () => {
    const e = navigation();
    const edgesBefore = JSON.stringify(e.columnAspect?.edges);
    const rejection = e.submitFindings({ focus_node_id: 'producer', verdict: 'analyze', summary: 'Loads owed and other', sections: [{ angle: 'technical', text: 'Two writes' }], column_flow: [
      { out_col: 'Amount', writes_to: { node: 'owed', col: 'Amount' }, upstream_columns: [{ node: 'source', col: 'Amount' }] },
      { out_col: 'Amount', writes_to: { node: 'other', col: 'Amount' }, upstream_columns: [{ node: 'source', col: 'Stamp' }] },
    ] });
    expect(rejection).toMatchObject({ code: 'out_col_not_tracked' });
    expect(JSON.stringify(e.columnAspect?.edges)).toBe(edgesBefore);
    expect(e.submitFindings({ focus_node_id: 'producer', verdict: 'analyze', summary: 'Loads owed', sections: [{ angle: 'technical', text: 'Source Stamp selects rows' }], column_flow: [
      { out_col: 'Amount', writes_to: { node: 'owed', col: 'Amount' }, upstream_columns: [{ node: 'source', col: 'Amount' }, { node: 'source', col: 'Stamp', transforms: ['filter'] }] },
    ] })).toMatchObject({ ok: true });
    const endpointKey = columnEndpointKeyFactory(new Map());
    const closure = columnClosure([{ node: 'root', col: 'Net' }], e.columnAspect?.edges ?? [], 'upstream', endpointKey);
    const carried = e.getCurrentTasks().flatMap(task => task.kind === 'column_lineage' ? task.sourceRefs ?? [] : []);
    expect(carried.length).toBeGreaterThan(0);
    for (const ref of carried) expect(closure.has(endpointKey(ref.node, ref.col))).toBe(true);
  });
});

describe('no island after admission and delivery', () => {
  const NODES = ['staging', 'archive', 'source', 'report', 'origin', 'writer'];
  const COLS = ['OrderQty', 'OrderDate', 'KeyCol'];
  const seeded = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const key = (node: string, col: string) => `${node}|${col.toLowerCase()}`;
  type PlainEdge = { hop_node: string; from_node: string; from_col: string; to_node: string; to_col: string };
  /** Independent walk, never the production helper. */
  function walk(edges: PlainEdge[], starts: Iterable<string>, forward: boolean): Set<string> {
    const seen = new Set(starts); const todo = [...seen];
    while (todo.length) {
      const at = todo.pop()!;
      for (const e of edges) {
        const from = key(e.from_node, e.from_col), to = key(e.to_node, e.to_col);
        const next = forward ? (from === at ? to : null) : (to === at ? from : null);
        if (next !== null && !seen.has(next)) { seen.add(next); todo.push(next); }
      }
    }
    return seen;
  }
  /** Detached edges and endpoints: the direction rule from the roots, then the origin's own write of a root with that hop's inputs. */
  function islands(edges: PlainEdge[], roots: Ref[], direction: 'upstream' | 'downstream' | 'both'): string[] {
    const rootKeys = roots.map(r => key(r.node, r.col));
    const attached = new Set<string>(rootKeys);
    if (direction !== 'downstream') walk(edges, rootKeys, false).forEach(k => attached.add(k));
    if (direction !== 'upstream') walk(edges, walk(edges, rootKeys, true), false).forEach(k => attached.add(k));
    const own = new Map<string, string>();
    for (const e of edges) if (e.hop_node === e.from_node && e.to_node !== e.from_node && rootKeys.includes(key(e.from_node, e.from_col)) && !attached.has(key(e.to_node, e.to_col))) own.set(key(e.to_node, e.to_col), e.hop_node);
    const inputs = edges.filter(e => own.get(key(e.to_node, e.to_col)) === e.hop_node).map(e => key(e.from_node, e.from_col));
    for (const k of own.keys()) attached.add(k);
    walk(edges.filter(e => !own.has(key(e.to_node, e.to_col))), inputs, false).forEach(k => attached.add(k));
    return edges.flatMap(e => {
      const from = key(e.from_node, e.from_col), to = key(e.to_node, e.to_col);
      const foreign = own.has(to) && own.get(to) !== e.hop_node;
      return [...(attached.has(from) ? [] : [from]), ...(attached.has(to) && !foreign ? [] : [`${from}>${to}`])];
    });
  }

  it.each(['upstream', 'downstream', 'both'] as const)('random %s submissions, with writer aliases, leave the committed and delivered edge sets island-free', session => {
    const random = seeded({ upstream: 7, downstream: 11, both: 13 }[session]);
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    let admitted = 0;
    for (let trial = 0; trial < 150; trial++) {
      const tracer = new ColumnTracer([...COLS]);
      const roots = [{ node: pick(['origin', 'writer']), col: pick(COLS) }];
      tracer.setActiveColumns([...COLS]);
      for (let call = 0; call < 6; call++) {
        const hop = session === 'both' ? pick(['upstream', 'downstream'] as const) : session;
        const flow: Entry[] = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
          out_col: pick(COLS),
          ...(random() < 0.7 ? { writes_to: { node: pick(NODES), col: pick(COLS) } } : {}),
          upstream_columns: Array.from({ length: Math.floor(random() * 3) }, () => ({ node: pick(NODES), col: pick(COLS) })),
        }));
        // Arriving obligations: everything attached on the hop's side, as the carry hands it over.
        const rootKeys = roots.map(r => key(r.node, r.col));
        const reached = hop === 'downstream' ? walk(tracer.edges, walk(tracer.edges, rootKeys, true), false) : walk(tracer.edges, rootKeys, false);
        const incoming = [...reached].map(k => { const [node, col] = k.split('|'); return { node, col: COLS.find(c => c.toLowerCase() === col)! }; });
        const result = tracer.validateColumnFlow('writer', finding(flow), map, model, null, undefined, undefined, hop, incoming, [], [], [], roots);
        if (result.invalidRoutes.length > 0) continue;
        admitted += result.stagedEdges.length > 0 ? 1 : 0;
        tracer.edges.push(...result.stagedEdges.map(edge => ({ ...edge, hop: call + 1 })));
        expect(islands(tracer.edges, roots, session)).toEqual([]);
        expect(islands(tracer.deliveredState(new Set([pick(NODES)]), roots, session).edges, roots, session)).toEqual([]);
      }
    }
    expect(admitted).toBeGreaterThan(0);
  });

  const edge = (from_node: string, from_col: string, to_node: string, to_col: string) => ({ hop: 1, hop_node: 'writer', from_node, from_col, to_node, to_col });
  const aspect = (...edges: ReturnType<typeof edge>[]) => ({ target_columns: ['OrderQty'], active_columns: ['OrderQty'], edges });
  it('delivery withholding a border sink does not strand the tuples that only attached through it', () => {
    const tracer = new ColumnTracer(['OrderQty'], aspect(edge('staging', 'OrderQty', 'archive', 'OrderQty'), edge('source', 'OrderQty', 'archive', 'OrderQty'), edge('report', 'KeyCol', 'source', 'OrderQty')));
    const logs: string[] = [];
    const delivered = tracer.deliveredState(new Set(['archive']), [{ node: 'staging', col: 'OrderQty' }], 'downstream', (_level, message) => logs.push(message));
    expect(delivered.edges).toEqual([]);
    expect(logs.join('\n')).toContain('report.KeyCol -> source.OrderQty');
    expect(tracer.edges).toHaveLength(3);
  });
  it('delivery projects a restored aspect that already holds a detached edge, with nothing withheld', () => {
    const tracer = new ColumnTracer(['OrderQty'], aspect(edge('source', 'OrderQty', 'report', 'OrderQty'), edge('source', 'OrderDate', 'archive', 'OrderQty')));
    const logs: string[] = [];
    const delivered = tracer.deliveredState(new Set(), [{ node: 'report', col: 'OrderQty' }], 'upstream', (_level, message) => logs.push(message));
    expect(delivered.edges).toEqual([expect.objectContaining({ to_node: 'report' })]);
    expect(logs.join('\n')).toContain('source.OrderDate -> archive.OrderQty');
    expect(tracer.edges).toHaveLength(2);
    expect(tracer.deliveredState(new Set(), [{ node: 'report', col: 'OrderQty' }, { node: 'archive', col: 'OrderQty' }], 'upstream')).toBe(tracer.state);
  });
});

describe('origin write and delivered membership', () => {
  const sections = [{ angle: 'technical' as const, text: 'Declared SQL' }];
  const table = (id: string, cols: string[]) => makeNode({ id, name: id, schema: 'dbo', type: 'table' as const, columns: cols.map(column) });
  const procedure = (id: string) => makeNode({ id, name: id, schema: 'dbo', type: 'procedure' as const, columns: [], bodyScript: 'INSERT dbo.t SELECT 1;' });
  const levels = (upstream: number | 'all', downstream: number | 'all') => ({ upstream: { levels: upstream, exactness: 'exact' as const }, downstream: { levels: downstream, exactness: 'exact' as const } });
  function start(ns: ReturnType<typeof makeNode>[], ps: Array<[string, string]>, origin: string, col: string, direction: 'upstream' | 'downstream' | 'bidirectional', depthIntent: ReturnType<typeof levels>) {
    const logs: string[] = [];
    const e = new NavigationEngine(makeModel(ns, ps, ['dbo']), makeGraph(ns, ps), (_level, message) => { logs.push(message); }, {});
    expect(e.init({ origin, question: `Trace ${col}`, direction, analysisMode: 'ct', targetColumns: [col], depthIntent })).toMatchObject({ ok: true });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: origin } });
    return { e, logs };
  }

  it('rejects an origin write into a node the origin has no recorded dependency into', () => {
    const ns = [makeNode({ id: 'v1', name: 'v1', schema: 'dbo', type: 'view', columns: [column('e')], bodyScript: 'SELECT c AS e FROM dbo.f2;' }), table('f2', ['c', 'd']), table('t3', ['c']), procedure('p4')];
    const { e } = start(ns, [['f2', 'v1'], ['p4', 't3']], 'v1', 'e', 'bidirectional', levels(1, 0));
    const rejection = e.submitFindings({ focus_node_id: 'v1', verdict: 'analyze', summary: 'e reads f2', sections, column_flow: [
      { out_col: 'e', writes_to: { node: 't3', col: 'c' }, upstream_columns: [{ node: 'v1', col: 'e' }] },
      { out_col: 'e', upstream_columns: [{ node: 'f2', col: 'c' }] },
    ] });
    expect(rejection).toMatchObject({ code: 'writes_to_names_reader', reason: expect.stringContaining('no recorded dependency') });
    expect(e.columnAspect?.edges).toEqual([]);
  });

  it('upstream: another hop\'s link into the procedure origin\'s write destination is refused; the origin\'s own inputs continue', () => {
    const ns = [procedure('p'), table('owed', ['Amount']), table('source', ['Amount']), procedure('w2'), table('src2', ['X'])];
    const { e } = start(ns, [['source', 'p'], ['p', 'owed'], ['w2', 'source'], ['src2', 'w2'], ['w2', 'owed']], 'p', 'Amount', 'upstream', levels('all', 0));
    expect(e.submitFindings({ focus_node_id: 'p', verdict: 'analyze', summary: 'Writes owed', sections, column_flow: [{ out_col: 'Amount', writes_to: { node: 'owed', col: 'Amount' }, upstream_columns: [{ node: 'source', col: 'Amount' }] }] })).toMatchObject({ ok: true });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: 'w2' } });
    const intoSource = { out_col: 'Amount', writes_to: { node: 'source', col: 'Amount' }, upstream_columns: [{ node: 'src2', col: 'X' }] };
    const before = JSON.stringify(e.columnAspect?.edges);
    expect(e.submitFindings({ focus_node_id: 'w2', verdict: 'analyze', summary: 'Writes source and owed', sections, column_flow: [intoSource,
      { out_col: 'Amount', writes_to: { node: 'owed', col: 'Amount' }, upstream_columns: [{ node: 'src2', col: 'X' }] }] }))
      .toMatchObject({ code: 'out_col_not_tracked', reason: expect.stringContaining('src2.X -> owed.Amount') });
    expect(JSON.stringify(e.columnAspect?.edges)).toBe(before);
    expect(e.submitFindings({ focus_node_id: 'w2', verdict: 'analyze', summary: 'Writes source', sections, column_flow: [intoSource] })).toMatchObject({ ok: true });
    expect(e.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: 'src2', from_col: 'X', to_node: 'source', to_col: 'Amount' }));
  });

  it('delivery withholds and names a column edge whose destination is not in the delivered object result', () => {
    const ns = [makeNode({ id: 'root', name: 'root', schema: 'dbo', type: 'view', columns: [column('a')], bodyScript: 'SELECT a FROM dbo.t2;' }), procedure('p'), table('t2', ['a'])];
    const { e, logs } = start(ns, [['root', 'p'], ['p', 't2'], ['t2', 'root']], 'root', 'a', 'downstream', levels(0, 1));
    expect(e.submitFindings({ focus_node_id: 'root', verdict: 'analyze', summary: 'Produces a', sections, column_flow: [{ out_col: 'a', upstream_columns: [] }] })).toMatchObject({ ok: true });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: 'p' } });
    expect(e.submitFindings({ focus_node_id: 'p', verdict: 'analyze', summary: 'Writes t2', sections, column_flow: [{ out_col: 'a', writes_to: { node: 't2', col: 'a' }, upstream_columns: [{ node: 'root', col: 'a' }] }] })).toMatchObject({ ok: true });
    expect(e.getHopContext()).toMatchObject({ done: true });
    const result = e.getResult();
    const ids = new Set(result.fullNodes.map(n => n.id));
    expect(ids.has('t2')).toBe(false);
    expect(result.columnAspect?.edges.filter(edge => !ids.has(edge.to_node) || !ids.has(edge.hop_node))).toEqual([]);
    expect(logs.join('\n')).toContain('root.a -> t2.a (hop p)');
    expect(e.columnAspect?.edges).toHaveLength(2);
  });

  it('a supplemented node receives no origin anchor for a column that was never requested', () => {
    const ns = [table('t0', ['b', 'a']), procedure('p3'), table('t4', ['a'])];
    const { e } = start(ns, [['p3', 't0'], ['t4', 'p3']], 't0', 'b', 'upstream', levels('all', 0));
    expect(e.submitFindings({ focus_node_id: 't0', verdict: 'analyze', summary: 'b is written by p3', sections, column_flow: [{ out_col: 'b', upstream_columns: [{ node: 'p3', col: 'a' }] }], prune_neighbors: [{ id: 'p3', reason: 'off the answer' }] })).toMatchObject({ ok: true });
    expect(e.getHopContext()).toMatchObject({ done: true });
    expect(e.supplementAgenda(['p3'])).toMatchObject({ ok: true, agendaed: 1 });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: 'p3' } });
    const refs = (e as unknown as { incomingColumnRefs(): Ref[] }).incomingColumnRefs();
    expect(refs).not.toContainEqual({ node: 't0', col: 'a' });
  });
});
