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
  type ColumnLineState,
  type ColumnTraceRelation,
  type ColumnTraceViewEdge,
  type ColumnTraceViewInput,
  type ColumnTraceViewObject,
} from '../../../src/engine/columnTraceView';

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
    });
    const viaNodeView = buildColumnTraceView({
      relations: viaNodeShape,
      objects,
      verdicts: new Map([['dbo.p', 'analyze']]),
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

    // The only structural difference is the viaNode annotation.
    expect(endpointEdge.viaNode).toBeUndefined();
    expect(viaEdge.viaNode).toBe('dbo.p');
  });

  it('marks a procedure as a transform node', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.p', 'procedure'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.p', fromNode: 'dbo.s', fromCol: 'Amount', toNode: 'dbo.p', toCol: 'Amount' },
    ];

    const view = buildColumnTraceView({ relations, objects });
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

    const view = buildColumnTraceView({ relations, objects });
    const row = findRow(view, 'dbo.t', 'Amount');
    expect(row.shape).toBe('renamed');
  });

  it('derives fan-in with the correct contributor count', () => {
    const objects = mkObjects(mkObj('dbo.s1'), mkObj('dbo.s2'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.t', fromNode: 'dbo.s1', fromCol: 'A', toNode: 'dbo.t', toCol: 'X' },
      { hopNode: 'dbo.t', fromNode: 'dbo.s2', fromCol: 'A', toNode: 'dbo.t', toCol: 'X' },
    ];

    const view = buildColumnTraceView({ relations, objects });
    const row = findRow(view, 'dbo.t', 'X');
    expect(row.shape).toBe('fan-in');
    expect(row.contributors).toBe(2);
  });

  it('derives fan-out when one upstream column feeds multiple targets', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t1'), mkObj('dbo.t2'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.s', fromNode: 'dbo.s', fromCol: 'A', toNode: 'dbo.t1', toCol: 'X' },
      { hopNode: 'dbo.s', fromNode: 'dbo.s', fromCol: 'A', toNode: 'dbo.t2', toCol: 'Y' },
    ];

    const view = buildColumnTraceView({ relations, objects });
    const row = findRow(view, 'dbo.s', 'A');
    expect(row.shape).toBe('fan-out');
    expect(row.contributors).toBeUndefined();
  });

  it('marks a column with no inbound relation as terminal', () => {
    const objects = mkObjects(mkObj('dbo.s'), mkObj('dbo.t'));
    const relations: ColumnTraceRelation[] = [
      { hopNode: 'dbo.s', fromNode: 'dbo.s', fromCol: 'A', toNode: 'dbo.t', toCol: 'A' },
    ];

    const view = buildColumnTraceView({ relations, objects });
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

    const view = buildColumnTraceView({ relations, objects });
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
    const input: ColumnTraceViewInput = { relations: [], objects: new Map() };
    expect(() => buildColumnTraceView(input)).not.toThrow();
    const view = buildColumnTraceView(input);
    expect(view.nodes).toEqual([]);
    expect(view.edges).toEqual([]);
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

  it('resolves a fan-in row to transformation when any contributor transforms', () => {
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
