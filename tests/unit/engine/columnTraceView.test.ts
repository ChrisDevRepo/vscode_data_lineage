/**
 * Tests for the pure column-trace-view derivation: relation normalisation, row/shape derivation,
 * verdict-to-state resolution, deterministic ordering, and handle id uniqueness.
 */

import { describe, it, expect } from 'vitest';
import {
  buildColumnTraceView,
  columnHandleId,
  columnRowKey,
  resolveRowLineStates,
  resolveVerdictLineState,
  COLUMN_NODE_BORDER_WIDTH,
  COLUMN_NODE_HEADER_HEIGHT,
  COLUMN_ROW_HEIGHT,
  type ColumnLineState,
  type ColumnTraceRelation,
  type ColumnTraceViewEdge,
  type ColumnTraceViewInput,
  type ColumnTraceViewObject,
  COLUMN_NODE_WIDTH,
} from '../../../src/engine/columnTraceView';
import { DEFAULT_CONFIG, type ExtensionConfig } from '../../../src/engine/types';

function mkObj(id: string, objectType = 'table', label?: string): ColumnTraceViewObject {
  return { id, label: label ?? id, schema: 'dbo', objectType };
}

function mkObjects(...objs: ColumnTraceViewObject[]): Map<string, ColumnTraceViewObject> {
  const map = new Map<string, ColumnTraceViewObject>();
  for (const o of objs) map.set(o.id.toLowerCase(), o);
  return map;
}

function findNode(view: ReturnType<typeof buildColumnTraceView>, id: string) {
  const node = view.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node ${id} not found`);
  return node;
}

function findRow(view: ReturnType<typeof buildColumnTraceView>, nodeId: string, colName: string) {
  const node = findNode(view, nodeId);
  const row = node.rows.find((r) => r.name.toLowerCase() === colName.toLowerCase());
  if (!row) throw new Error(`row ${colName} not found on ${nodeId}`);
  return row;
}

describe('columnTraceView', () => {
  it('normalises the viaNode shape and the endpoint shape to the same rendering', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));

    const endpointShape: ColumnTraceRelation[] = [
      { hopNode: 'dbo.t', fromNode: 'dbo.s', fromCol: 'Amount', toNode: 'dbo.t', toCol: 'Amount' },
    ];
    const viaNodeShape: ColumnTraceRelation[] = [
      { hopNode: 'dbo.p', fromNode: 'dbo.s', fromCol: 'Amount', toNode: 'dbo.t', toCol: 'Amount' },
    ];

    const endpointView = buildColumnTraceView({
      relations: endpointShape,
      objects,
      verdicts: new Map([['dbo.t', 'analyze']]),
      config: DEFAULT_CONFIG,
    });
    const viaNodeView = buildColumnTraceView({
      relations: viaNodeShape,
      objects,
      verdicts: new Map([['dbo.p', 'analyze']]),
      config: DEFAULT_CONFIG,
    });

    // Neither shape invents a node for a hop that isn't a real endpoint.
    expect(endpointView.nodes.map((n) => n.id).sort()).toEqual(['dbo.s', 'dbo.t']);
    expect(viaNodeView.nodes.map((n) => n.id).sort()).toEqual(['dbo.s', 'dbo.t']);

    expect(endpointView.edges).toHaveLength(1);
    expect(viaNodeView.edges).toHaveLength(1);
    const endpointEdge = endpointView.edges[0];
    const viaEdge = viaNodeView.edges[0];

    // Same rendering for the shared parts of the two shapes.
    expect(viaEdge.source).toBe(endpointEdge.source);
    expect(viaEdge.target).toBe(endpointEdge.target);
    expect(viaEdge.sourceHandle).toBe(endpointEdge.sourceHandle);
    expect(viaEdge.targetHandle).toBe(endpointEdge.targetHandle);
    expect(viaEdge.state).toBe(endpointEdge.state);
  });

  it('marks a procedure as a transform node', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.p', 'procedure'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.p', fromNode: 'dbo.s', fromCol: 'Amount', toNode: 'dbo.p', toCol: 'Amount' },
    ];

    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    const procNode = findNode(view, 'dbo.p');

    expect(procNode.isTransformNode).toBe(true);
    expect(procNode.rows).toHaveLength(1);

    const tableNode = findNode(view, 'dbo.s');
    expect(tableNode.isTransformNode).toBe(false);
  });

  it('derives renamed when endpoint column names differ', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.t', fromNode: 'dbo.s', fromCol: 'Amt', toNode: 'dbo.t', toCol: 'Amount' },
    ];

    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    const row = findRow(view, 'dbo.t', 'Amount');
    expect(row.shape).toBe('renamed');
  });

  it('derives incoming with the correct contributor count', () => {
    const objects = mkObjects(mkObj('dbo.s1'), mkObj('dbo.s2'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.t', fromNode: 'dbo.s1', fromCol: 'A', toNode: 'dbo.t', toCol: 'X' },
      { hopNode: 'dbo.t', fromNode: 'dbo.s2', fromCol: 'A', toNode: 'dbo.t', toCol: 'X' },
    ];

    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    const row = findRow(view, 'dbo.t', 'X');
    expect(row.shape).toBe('incoming');
    expect(row.contributors).toBe(2);
  });

  it('derives outgoing when one upstream column feeds multiple targets', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t1'), mkObj('dbo.t2'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.s', fromNode: 'dbo.s', fromCol: 'A', toNode: 'dbo.t1', toCol: 'X' },
      { hopNode: 'dbo.s', fromNode: 'dbo.s', fromCol: 'A', toNode: 'dbo.t2', toCol: 'Y' },
    ];

    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    const row = findRow(view, 'dbo.s', 'A');
    expect(row.shape).toBe('outgoing');
    expect(row.contributors).toBe(2);
  });

  it('marks a column with no inbound relation as terminal', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.s', fromNode: 'dbo.s', fromCol: 'A', toNode: 'dbo.t', toCol: 'A' },
    ];

    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    const row = findRow(view, 'dbo.s', 'A');
    expect(row.shape).toBe('terminal');
  });

  describe('resolveVerdictLineState', () => {
    it('resolves passthrough verdict to passthrough state', () => {
      expect(resolveVerdictLineState('dbo.p', new Map([['dbo.p', 'passthrough']]))).toBe('passthrough');
    });

    it('resolves analyze verdict to transformation state', () => {
      expect(resolveVerdictLineState('dbo.p', new Map([['dbo.p', 'analyze']]))).toBe('transformation');
    });

    it('resolves a missing verdict to unknown state', () => {
      expect(resolveVerdictLineState('dbo.p', new Map())).toBe('unknown');
      expect(resolveVerdictLineState('dbo.p', undefined)).toBe('unknown');
    });

    it('resolves prune verdict to unknown state', () => {
      expect(resolveVerdictLineState('dbo.p', new Map([['dbo.p', 'prune']]))).toBe('unknown');
    });
  });

  it('orders rows in first-seen order, not alphabetical order', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.t', fromNode: 'dbo.s', fromCol: 'Zebra', toNode: 'dbo.t', toCol: 'Zebra' },
      { hopNode: 'dbo.t', fromNode: 'dbo.s', fromCol: 'Apple', toNode: 'dbo.t', toCol: 'Apple' },
    ];

    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    const node = findNode(view, 'dbo.t');
    expect(node.rows.map((r) => r.name)).toEqual(['Zebra', 'Apple']);
  });

  it('produces distinct handle ids for the source and target side of the same column', () => {
    const sourceHandle = columnHandleId('Amount', 'source');
    const targetHandle = columnHandleId('Amount', 'target');
    expect(sourceHandle).not.toBe(targetHandle);
    // Same normalised column identity underlies both handles.
    expect(columnHandleId('[Amount]', 'source')).toBe(sourceHandle);
  });

  it('yields an empty view for an empty relation list without throwing', () => {
    const input: ColumnTraceViewInput = { relations: [], objects: new Map(), config: DEFAULT_CONFIG };
    expect(() => buildColumnTraceView(input)).not.toThrow();
    const view = buildColumnTraceView(input);
    expect(view.nodes).toEqual([]);
    expect(view.edges).toEqual([]);
  });

  it('includes the card border in the node height so the last row is not clipped', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.t', fromNode: 'dbo.s', fromCol: 'A', toNode: 'dbo.t', toCol: 'A' },
      { hopNode: 'dbo.t', fromNode: 'dbo.s', fromCol: 'B', toNode: 'dbo.t', toCol: 'B' },
    ];

    const node = findNode(buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG }), 'dbo.t');
    expect(node.rows).toHaveLength(2);
    expect(node.height).toBe(
      COLUMN_NODE_HEADER_HEIGHT + 2 * COLUMN_ROW_HEIGHT + 2 * COLUMN_NODE_BORDER_WIDTH,
    );
  });
});

/**
 * Lane for the transform node's place in the chain.
 *
 * A relation names the hop that produced it. Drawing the source straight to the target left that
 * hop with no inbound edge, so dagre ranked the procedure as a source and parked it at the left
 * margin with a single line spanning the canvas to its own output. The procedure is on the path, so
 * the path is drawn through it.
 */
describe('buildColumnTraceView — routing through the analysing hop', () => {
  const objects = mkObjects(mkObj('dbo.s1'), mkObj('dbo.s2'), mkObj('dbo.p', 'procedure'), mkObj('dbo.t'));

  // The shape from a real trace: two feeders whose values a procedure combines into one output.
  const relations: ColumnTraceRelation[] = [
    { hopNode: 'dbo.p', fromNode: 'dbo.s1', fromCol: 'Qty', toNode: 'dbo.t', toCol: 'Total' },
    { hopNode: 'dbo.p', fromNode: 'dbo.s2', fromCol: 'Price', toNode: 'dbo.t', toCol: 'Total' },
  ];

  it('draws each relation as two legs through the hop rather than past it', () => {
    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    const legs = view.edges.map((e) => `${e.source}.${e.sourceColumn}->${e.target}.${e.targetColumn}`);

    expect(legs).toContain('dbo.s1.Qty->dbo.p.Qty');
    expect(legs).toContain('dbo.s2.Price->dbo.p.Price');
    expect(legs).toContain('dbo.p.Total->dbo.t.Total');
    // No line goes straight from a feeder to the target.
    expect(legs.some((leg) => leg.startsWith('dbo.s1.Qty->dbo.t'))).toBe(false);
  });

  it('gives the hop an inbound edge, which is what puts it mid-chain', () => {
    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    expect(view.edges.some((e) => e.target === 'dbo.p')).toBe(true);
  });

  it('draws the shared outbound leg once', () => {
    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    const outbound = view.edges.filter((e) => e.source === 'dbo.p' && e.target === 'dbo.t');
    expect(outbound).toHaveLength(1);
    expect(new Set(view.edges.map((e) => e.id)).size).toBe(view.edges.length);
  });

  it('keeps the target incoming shape on the original endpoints, not on the legs', () => {
    const view = buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG });
    const row = findRow(view, 'dbo.t', 'Total');
    expect(row.shape).toBe('incoming');
    expect(row.contributors).toBe(2);
  });

  it('keeps the rename signal across the split', () => {
    const view = buildColumnTraceView({
      relations: [{ hopNode: 'dbo.p', fromNode: 'dbo.s1', fromCol: 'Amt', toNode: 'dbo.t', toCol: 'Amount' }],
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(findRow(view, 'dbo.t', 'Amount').shape).toBe('renamed');
  });

  it('gives the hop one port per name the column carries, so a rename shows two', () => {
    const renaming = buildColumnTraceView({
      relations: [{ hopNode: 'dbo.p', fromNode: 'dbo.s1', fromCol: 'Amt', toNode: 'dbo.t', toCol: 'Amount' }],
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(findNode(renaming, 'dbo.p').rows.map((r) => r.name)).toEqual(['Amt', 'Amount']);

    const unchanged = buildColumnTraceView({
      relations: [{ hopNode: 'dbo.p', fromNode: 'dbo.s1', fromCol: 'Amount', toNode: 'dbo.t', toCol: 'Amount' }],
      objects,
      config: DEFAULT_CONFIG,
    });
    expect(findNode(unchanged, 'dbo.p').rows.map((r) => r.name)).toEqual(['Amount']);
  });

  it('renders a hop outside the view as a direct edge, having nothing to route through', () => {
    const withoutProc = mkObjects(mkObj('dbo.s1'), mkObj('dbo.t'));
    const view = buildColumnTraceView({
      relations: [{ hopNode: 'dbo.p', fromNode: 'dbo.s1', fromCol: 'Qty', toNode: 'dbo.t', toCol: 'Qty' }],
      objects: withoutProc,
      config: DEFAULT_CONFIG,
    });
    expect(view.nodes.map((n) => n.id).sort()).toEqual(['dbo.s1', 'dbo.t']);
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0].source).toBe('dbo.s1');
    expect(view.edges[0].target).toBe('dbo.t');
  });
});

describe('resolveRowLineStates', () => {
  function edge(target: string, targetColumn: string, state: ColumnLineState): ColumnTraceViewEdge {
    return {
      id: `${target}:${targetColumn}:${state}`,
      source: 'dbo.s',
      sourceHandle: columnHandleId(targetColumn, 'source'),
      sourceColumn: targetColumn,
      target,
      targetHandle: columnHandleId(targetColumn, 'target'),
      targetColumn,
      state,
    };
  }

  it('keeps the state of a row fed by a single edge', () => {
    const states = resolveRowLineStates([edge('dbo.t', 'Amount', 'passthrough')]);
    expect(states.get(columnRowKey('dbo.t', 'Amount'))).toBe('passthrough');
  });

  it('resolves an incoming row to transformation when any contributor transforms', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', 'NetAmount', 'passthrough'),
      edge('dbo.t', 'NetAmount', 'transformation'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'NetAmount'))).toBe('transformation');
  });

  it('is independent of edge order — the glyph must not follow hop order', () => {
    const forward = resolveRowLineStates([
      edge('dbo.t', 'NetAmount', 'transformation'),
      edge('dbo.t', 'NetAmount', 'passthrough'),
    ]);
    const reversed = resolveRowLineStates([
      edge('dbo.t', 'NetAmount', 'passthrough'),
      edge('dbo.t', 'NetAmount', 'transformation'),
    ]);
    expect(forward.get(columnRowKey('dbo.t', 'NetAmount')))
      .toBe(reversed.get(columnRowKey('dbo.t', 'NetAmount')));
  });

  it('keeps passthrough only when every contributor agrees', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', 'Qty', 'passthrough'),
      edge('dbo.t', 'Qty', 'passthrough'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'Qty'))).toBe('passthrough');
  });

  it('degrades a passthrough/unknown disagreement to unknown rather than claiming either', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', 'Qty', 'passthrough'),
      edge('dbo.t', 'Qty', 'unknown'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'Qty'))).toBe('unknown');
  });

  it('keys rows by normalised column identity so a bracketed spelling lands on the same row', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', '[Amount]', 'transformation'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'amount'))).toBe('transformation');
  });

  it('scopes rows per node — the same column name on two nodes stays separate', () => {
    const states = resolveRowLineStates([
      edge('dbo.t', 'Amount', 'passthrough'),
      edge('dbo.u', 'Amount', 'transformation'),
    ]);
    expect(states.get(columnRowKey('dbo.t', 'Amount'))).toBe('passthrough');
    expect(states.get(columnRowKey('dbo.u', 'Amount'))).toBe('transformation');
  });

  it('returns an empty map for no edges', () => {
    expect(resolveRowLineStates([]).size).toBe(0);
  });
});

describe('columnTraceView layout settings', () => {
  /** Horizontal distance between the two ranks of a two-node left-to-right view. */
  function rankGap(view: ReturnType<typeof buildColumnTraceView>): number {
    return findNode(view, 'dbo.t').position.x - findNode(view, 'dbo.s').position.x;
  }

  const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
  const relations: ColumnTraceRelation[] = [
    { hopNode: 'dbo.t', fromNode: 'dbo.s', fromCol: 'Amount', toNode: 'dbo.t', toCol: 'Amount' },
  ];

  it('spaces ranks by the caller rank separation, not by a built-in default', () => {
    const wide: ExtensionConfig = {
      ...DEFAULT_CONFIG,
      layout: { ...DEFAULT_CONFIG.layout, rankSeparation: DEFAULT_CONFIG.layout.rankSeparation + 200 },
    };
    const defaultGap = rankGap(buildColumnTraceView({ relations, objects, config: DEFAULT_CONFIG }));
    const wideGap = rankGap(buildColumnTraceView({ relations, objects, config: wide }));

    expect(defaultGap).toBe(COLUMN_NODE_WIDTH + DEFAULT_CONFIG.layout.rankSeparation);
    expect(wideGap).toBe(COLUMN_NODE_WIDTH + wide.layout.rankSeparation);
  });

  it('takes the layout direction from the configuration when the view requests none', () => {
    const topDown: ExtensionConfig = {
      ...DEFAULT_CONFIG,
      layout: { ...DEFAULT_CONFIG.layout, direction: 'TB' },
    };
    const view = buildColumnTraceView({ relations, objects, config: topDown });
    const source = findNode(view, 'dbo.s');
    const target = findNode(view, 'dbo.t');

    expect(target.position.y).toBeGreaterThan(source.position.y);
    expect(target.position.x).toBe(source.position.x);
  });

  it('lets an explicit view direction override the configured one', () => {
    const topDown: ExtensionConfig = {
      ...DEFAULT_CONFIG,
      layout: { ...DEFAULT_CONFIG.layout, direction: 'TB' },
    };
    const view = buildColumnTraceView({ relations, objects, config: topDown, layoutDirection: 'LR' });

    expect(rankGap(view)).toBe(COLUMN_NODE_WIDTH + topDown.layout.rankSeparation);
  });
});
