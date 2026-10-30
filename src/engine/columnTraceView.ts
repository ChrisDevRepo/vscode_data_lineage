/**
 * @module columnTraceView
 * Derives the column-level rendering of an AI column trace from the wire payload.
 *
 * The column view is a second rendering of a scope the object view already shows: each traced
 * column becomes a row inside its object, and each recorded column relation becomes an edge between
 * two row handles. Rows also retain explicitly asked columns from `AIViewMetadata.columnAspect`.
 * Edges and transform classes remain recorded facts. This module never asks the host for more data
 * and never mutates the object-view model.
 */

import { AI_BADGE_BAND, AI_NOTE_BAND, dagreLayout } from './graphBuilder';
import { normalizeColName, schemaKey } from '../utils/sql';
import type { ColumnAspectEdge, ColumnTransformClass } from './shared/bridgeContract';
import type { ExtensionConfig } from './types';

/** Whether the value arriving at a relation's target is the value that left its source. */
export type ColumnLineState = 'passthrough' | 'transformation' | 'unknown';

/** Structural shape of a row, derived from the relation set alone. */
type ColumnRowShape = 'renamed' | 'incoming' | 'outgoing' | 'terminal';

/** One row inside a column-trace node: a traced column, or a port on a transform node. */
export interface ColumnTraceRow {
  /** Extracted column name when available, otherwise the recorded or borrowed transform-port name. */
  name: string;
  /** Derived structural shape; absent when none applies. */
  shape?: ColumnRowShape;
  /** Contributing upstream (`incoming`) or feeding downstream (`outgoing`) column count. */
  contributors?: number;
  /** Declared SQL data type from the extracted model — backend metadata, never an AI claim. Absent for borrowed transform-port names and for columns the host model declares no type for. */
  dataType?: string;
}

/** Object identity the view needs for a node header, supplied by the caller's graph model. */
export interface ColumnTraceViewObject {
  /** Canonical node id, matching the ids used in the column relations. */
  id: string;
  /** Display label for the node header. */
  label: string;
  /** Schema the object belongs to. */
  schema: string;
  /** Object type as carried by the graph model. */
  objectType: string;
  /** Declared column data types from the extracted model, keyed by {@link normalizeColName} under the source policy. Rows join against this to show the type beside the name; absent when the host model declares no columns for the object. */
  columnTypes?: ReadonlyMap<string, string>;
  /** Extracted column display names, keyed by {@link normalizeColName} under the source policy. */
  columnNames?: ReadonlyMap<string, string>;
}

/** A node in the column-trace view, positioned and sized for the canvas. */
export interface ColumnTraceViewNode extends ColumnTraceViewObject {
  /** Whether rows are ports rather than declared columns. */
  isTransformNode: boolean;
  /** Rows to render, in first-seen order. */
  rows: ColumnTraceRow[];
  /** Node width in canvas units. */
  width: number;
  /** Node height in canvas units, derived from the row count. */
  height: number;
  /** Layout position assigned by this module. */
  position: { x: number; y: number };
}

/** A per-column edge in the column-trace view, addressing row handles rather than nodes. */
export interface ColumnTraceViewEdge {
  /** Stable edge id, unique across the view. */
  id: string;
  /** Source node id. */
  source: string;
  /** Handle id on the source node, from {@link columnHandleId}. */
  sourceHandle: string;
  /** Source row's display name, for callers that follow a thread across edges. */
  sourceColumn: string;
  /** Target node id. */
  target: string;
  /** Handle id on the target node, from {@link columnHandleId}. */
  targetHandle: string;
  /** Target row's display name, for callers that follow a thread across edges. */
  targetColumn: string;
  /** Whether the value changed between the two endpoints. */
  state: ColumnLineState;
  /** Transform classes the model recorded for the relation, absent on an unclassified edge. The marker chip keys its per-class glyphs off this; when a classification exists it, not the {@link state}, decides what the chip shows. */
  transforms?: ColumnTransformClass[];
  /** One-clause model note for the relation ("SUM of line totals"), absent whenever the model offered none. Printed verbatim as the chip tooltip's second line; a leg two relations share carries each distinct note on its own line. */
  note?: string;
}

/** A declared object dependency not already represented by a directed rendered column leg. */
interface ColumnTraceViewObjectEdge {
  /** Stable edge id, unique across the view and distinct from every {@link ColumnTraceViewEdge} id. */
  id: string;
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Handle on the source node: its first row's handle, absent on a node without rows. */
  sourceHandle?: string;
  /** Handle on the target node: its first row's handle, absent on a node without rows. */
  targetHandle?: string;
}

/** Two ports of one node the same relation passes between — the hop's inside link. */
interface ColumnTracePortBridge {
  /** Node whose two ports the bridge links. */
  nodeId: string;
  /** Column name of the port the relation enters on. */
  fromColumn: string;
  /** Column name of the port the relation leaves on. */
  toColumn: string;
}

/** The complete column-level rendering of one trace. */
interface ColumnTraceView {
  identifierCaseSensitive?: boolean;
  /** Positioned nodes. */
  nodes: ColumnTraceViewNode[];
  /** Per-column edges between row handles. */
  edges: ColumnTraceViewEdge[];
  /** Declared object dependencies not already represented by a directed rendered column leg. */
  objectEdges: ColumnTraceViewObjectEdge[];
  /** Inside-the-hop port links, drawn as nothing and traversed like an edge. */
  portBridges: ColumnTracePortBridge[];
}

/** One recorded column relation, as it arrives on the wire — the wire shape of `AIViewMetadata.columnAspect.edges`. */
export type ColumnTraceRelation = ColumnAspectEdge;

/** Input to {@link buildColumnTraceView}. */
export interface ColumnTraceViewInput {
  /** Checked model catalog policy; missing metadata retains CI. */
  identifierCaseSensitive?: boolean;
  /** Recorded column relations from `AIViewMetadata.columnAspect.edges`. */
  relations: ColumnTraceRelation[];
  /** Frozen asked identities, retained as rows without inventing relations. */
  requested?: { node: string; columns: readonly string[] };
  /** Object identity for every presented node, keyed by {@link schemaKey} under the source policy. */
  objects: Map<string, ColumnTraceViewObject>;
  /** Dependency edges of the object view between presented objects, by node id. */
  objectEdges?: ReadonlyArray<{ source: string; target: string }>;
  /** Live extension configuration, supplying the layout separations and the default direction. */
  config: ExtensionConfig;
  /** Layout direction requested by the view; defaults to the configured direction. */
  layoutDirection?: 'LR' | 'TB';
}

/** Node width used for every column-trace node. */
export const COLUMN_NODE_WIDTH = 214;

/** Node width used for a transform super node — a procedure or function rendered as a circle-and-gear hub rather than a column-port card. Narrower than a table card on purpose: the node's identity is the circle, not a column list. */
export const COLUMN_TRANSFORM_NODE_WIDTH = 150;

/** Diameter of a transform super node's circle, fixed however many ports run through it. */
export const COLUMN_TRANSFORM_CIRCLE_DIAMETER = 40;

/** Height of the name strip beneath a transform super node's circle. */
export const COLUMN_TRANSFORM_NAME_STRIP_HEIGHT = 20;

/** Height of a transform super node — the circle, a small margin, and the name strip beneath it. */
export const COLUMN_TRANSFORM_NODE_HEIGHT = COLUMN_TRANSFORM_CIRCLE_DIAMETER + 8 + COLUMN_TRANSFORM_NAME_STRIP_HEIGHT;

/** Largest vertical distance between consecutive port handles on a transform super node. The handles are the edges' attachment points on the circle; when more ports run through the hub than this spacing fits on the arc, the spacing shrinks so every handle stays on the stroke. */
export const COLUMN_TRANSFORM_PORT_SPREAD = 10;

/** Height of a column-trace node header. */
export const COLUMN_NODE_HEADER_HEIGHT = 28;

/** Height of one column row. */
export const COLUMN_ROW_HEIGHT = 22;

/** Card border width of a column-trace node. */
export const COLUMN_NODE_BORDER_WIDTH = 2;

/** Vertical space the AI badge and note occupy outside the card, added to the layout's vertical separation. */
export const COLUMN_AI_ANNOTATION_BAND = AI_BADGE_BAND + AI_NOTE_BAND;

/** Opacity of a column-view edge outside the hovered path. */
export const COLUMN_EDGE_DIM_OPACITY = 0.25;

/** Opacity of a column row outside the hovered path; see {@link COLUMN_EDGE_DIM_OPACITY}. */
export const COLUMN_ROW_DIM_OPACITY = 0.5;

/** Builds a React Flow handle id for a column row. */
export function columnHandleId(column: string, side: 'source' | 'target', identifierCaseSensitive = false): string {
  return `${side}:${normalizeColName(column, identifierCaseSensitive)}`;
}

/** Builds the canonical key for a node-and-column pair. */
export function columnRowKey(nodeId: string, column: string, identifierCaseSensitive = false): string {
  return JSON.stringify([schemaKey(nodeId, identifierCaseSensitive), normalizeColName(column, identifierCaseSensitive)]);
}

/** Row-key adjacency of a column view, one map per direction the value flows. */
export interface ColumnThreadIndex {
  /** Row key → the row keys it feeds. */
  down: Map<string, string[]>;
  /** Row key → the row keys it is fed by. */
  up: Map<string, string[]>;
}

/** Indexes a column view's edges and port bridges by direction, once per view. */
export function buildColumnThreadIndex(view: Pick<ColumnTraceView, 'edges' | 'portBridges' | 'identifierCaseSensitive'>): ColumnThreadIndex {
  const index: ColumnThreadIndex = { down: new Map(), up: new Map() };
  const link = (from: string, to: string): void => {
    const down = index.down.get(from);
    if (down) down.push(to); else index.down.set(from, [to]);
    const up = index.up.get(to);
    if (up) up.push(from); else index.up.set(to, [from]);
  };
  for (const edge of view.edges) link(columnRowKey(edge.source, edge.sourceColumn, view.identifierCaseSensitive), columnRowKey(edge.target, edge.targetColumn, view.identifierCaseSensitive));
  for (const bridge of view.portBridges) link(columnRowKey(bridge.nodeId, bridge.fromColumn, view.identifierCaseSensitive), columnRowKey(bridge.nodeId, bridge.toColumn, view.identifierCaseSensitive));
  return index;
}

/** Row keys in the trace cone of one row: everything it is derived from plus everything derived from it. */
export function columnThread(index: ColumnThreadIndex, startKey: string): Set<string> {
  const cone = new Set<string>([startKey]);
  for (const adjacency of [index.up, index.down]) {
    const seen = new Set<string>([startKey]);
    const stack = [startKey];
    while (stack.length > 0) {
      for (const next of adjacency.get(stack.pop()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        cone.add(next);
        stack.push(next);
      }
    }
  }
  return cone;
}

/** Resolves whether a relation changes its value from its recorded transform classes. */
export function resolveColumnLineState(
  transforms?: readonly ColumnTransformClass[],
): ColumnLineState {
  if (transforms?.some(transform => transform === 'compute' || transform === 'aggregate')) return 'transformation';
  if (transforms?.includes('pass_through')) return 'passthrough';
  return 'unknown';
}

/** Reduces every edge arriving at a row to that row's single line state. */
export function resolveRowLineStates(
  edges: readonly ColumnTraceViewEdge[],
  identifierCaseSensitive = false,
): Map<string, ColumnLineState> {
  const byRow = new Map<string, ColumnLineState>();
  for (const edge of edges) {
    const key = columnRowKey(edge.target, edge.targetColumn, identifierCaseSensitive);
    const seen = byRow.get(key);
    if (seen === undefined || seen === edge.state) {
      byRow.set(key, edge.state);
      continue;
    }
    byRow.set(key, seen === 'transformation' || edge.state === 'transformation' ? 'transformation' : 'unknown');
  }
  return byRow;
}

/** One inbound relation, reduced to what shape derivation needs from it. */
interface RowRelation {
  /** Source-policy comparison key of the node at the other end of the relation. */
  otherNodeKey: string;
  /** Normalised column key at the other end of the relation. */
  otherColKey: string;
  /** Raw source-column name, for the renamed comparison. */
  fromColRaw: string;
  /** Raw target-column name, for the renamed comparison. */
  toColRaw: string;
}

/** Per-node accumulator built while walking `input.relations`. */
interface NodeAccumulator {
  /** Object identity supplied by the caller. */
  object: ColumnTraceViewObject;
  /** Normalised row keys in first-seen order. */
  rowKeys: string[];
  /** Normalised row key to metadata display name, or first-seen spelling when metadata is absent. */
  rowNames: Map<string, string>;
  /** Normalised row key to the relations that fed it from upstream. */
  inbound: Map<string, RowRelation[]>;
  /** Normalised row key to the distinct downstream tuples it feeds. */
  outbound: Map<string, Set<string>>;
}

function pushInbound(map: Map<string, RowRelation[]>, rowKey: string, entry: RowRelation): void {
  const existing = map.get(rowKey);
  if (existing) existing.push(entry);
  else map.set(rowKey, [entry]);
}

function addOutbound(map: Map<string, Set<string>>, rowKey: string, tupleKey: string): void {
  const existing = map.get(rowKey);
  if (existing) existing.add(tupleKey);
  else map.set(rowKey, new Set([tupleKey]));
}

function touchRow(acc: NodeAccumulator, columnName: string, identifierCaseSensitive: boolean | undefined): string {
  const rowKey = normalizeColName(columnName, identifierCaseSensitive);
  if (!acc.rowNames.has(rowKey)) {
    acc.rowNames.set(rowKey, acc.object.columnNames?.get(rowKey) ?? columnName);
    acc.rowKeys.push(rowKey);
  }
  return rowKey;
}

/** Derives one node's rows from its accumulated relations. */
function buildRows(acc: NodeAccumulator, identifierCaseSensitive: boolean | undefined): ColumnTraceRow[] {
  return acc.rowKeys.map((rowKey) => {
    const name = acc.rowNames.get(rowKey)!;
    const inbound = acc.inbound.get(rowKey) ?? [];
    const upstreamTuples = new Set(inbound.map((x) => JSON.stringify([x.otherNodeKey, x.otherColKey])));
    const downstreamTuples = acc.outbound.get(rowKey) ?? new Set<string>();
    const renamed = inbound.some((x) => normalizeColName(x.fromColRaw, identifierCaseSensitive) !== normalizeColName(x.toColRaw, identifierCaseSensitive));

    let shape: ColumnRowShape | undefined;
    let contributors: number | undefined;
    if (upstreamTuples.size > 1) {
      shape = 'incoming';
      contributors = upstreamTuples.size;
    } else if (downstreamTuples.size > 1) {
      shape = 'outgoing';
      contributors = downstreamTuples.size;
    } else if (renamed) {
      shape = 'renamed';
    } else if (inbound.length === 0) {
      shape = 'terminal';
    }

    const row: ColumnTraceRow = { name };
    if (shape) row.shape = shape;
    if (contributors !== undefined) row.contributors = contributors;
    const dataType = acc.object.columnTypes?.get(rowKey);
    if (dataType) row.dataType = dataType;
    return row;
  });
}

/** Widens the layout separation on the axis the AI annotations grow along. */
function withAnnotationBand(config: ExtensionConfig, direction: 'LR' | 'TB'): ExtensionConfig {
  const layout = direction === 'TB'
    ? { ...config.layout, rankSeparation: config.layout.rankSeparation + COLUMN_AI_ANNOTATION_BAND }
    : { ...config.layout, nodeSeparation: config.layout.nodeSeparation + COLUMN_AI_ANNOTATION_BAND };
  return { ...config, layout };
}

/** Whether an object draws as a transform hub rather than a column card. */
function isColumnTraceTransformNode(object: ColumnTraceViewObject): boolean {
  if (object.objectType === 'procedure') return true;
  if (object.objectType === 'function') return !object.columnTypes || object.columnTypes.size === 0;
  return false;
}

/** Builds the column-level rendering of an AI column trace. */
export function buildColumnTraceView(input: ColumnTraceViewInput): ColumnTraceView {
  const nodeAccs = new Map<string, NodeAccumulator>();

  function getAcc(object: ColumnTraceViewObject): NodeAccumulator {
    const key = schemaKey(object.id, input.identifierCaseSensitive);
    let acc = nodeAccs.get(key);
    if (!acc) {
      acc = { object, rowKeys: [], rowNames: new Map(), inbound: new Map(), outbound: new Map() };
      nodeAccs.set(key, acc);
    }
    return acc;
  }

  interface NormalizedRelation {
    index: number;
    sourceId: string;
    sourceCol: string;
    targetId: string;
    targetCol: string;
    /** Rendered hop node the relation is drawn through; unset when the hop is an endpoint. */
    viaId?: string;
    /** Transform classes the model recorded, carried to every leg the relation is drawn as. */
    transforms?: ColumnTransformClass[];
    /** One-clause model note, carried beside the classes to every leg. */
    note?: string;
  }

  const normalized: NormalizedRelation[] = [];
  const seenRelations = new Set<string>();
  const portBridges: ColumnTracePortBridge[] = [];
  const seenBridges = new Set<string>();

  input.relations.forEach((relation, index) => {
    const sourceObj = input.objects.get(schemaKey(relation.fromNode, input.identifierCaseSensitive));
    const targetObj = input.objects.get(schemaKey(relation.toNode, input.identifierCaseSensitive));
    if (!sourceObj || !targetObj) return;

    const sourceKey = schemaKey(sourceObj.id, input.identifierCaseSensitive);
    const targetKey = schemaKey(targetObj.id, input.identifierCaseSensitive);
    const hopKey = schemaKey(relation.hopNode, input.identifierCaseSensitive);

    const identity = JSON.stringify([sourceKey, normalizeColName(relation.fromCol, input.identifierCaseSensitive), targetKey, normalizeColName(relation.toCol, input.identifierCaseSensitive), hopKey]);
    if (seenRelations.has(identity)) return;
    seenRelations.add(identity);

    const sourceAcc = getAcc(sourceObj);
    const targetAcc = getAcc(targetObj);
    const sourceRowKey = touchRow(sourceAcc, relation.fromCol, input.identifierCaseSensitive);
    const targetRowKey = touchRow(targetAcc, relation.toCol, input.identifierCaseSensitive);

    addOutbound(sourceAcc.outbound, sourceRowKey, JSON.stringify([targetKey, targetRowKey]));
    pushInbound(targetAcc.inbound, targetRowKey, {
      otherNodeKey: sourceKey,
      otherColKey: sourceRowKey,
      fromColRaw: relation.fromCol,
      toColRaw: relation.toCol,
    });

    let viaId: string | undefined;
    if (hopKey !== sourceKey && hopKey !== targetKey) {
      const hopObj = input.objects.get(hopKey);
      if (hopObj) {
        viaId = hopObj.id;
        const viaAcc = getAcc(hopObj);
        const inRowKey = touchRow(viaAcc, relation.fromCol, input.identifierCaseSensitive);
        const outRowKey = touchRow(viaAcc, relation.toCol, input.identifierCaseSensitive);
        pushInbound(viaAcc.inbound, inRowKey, {
          otherNodeKey: sourceKey,
          otherColKey: sourceRowKey,
          fromColRaw: relation.fromCol,
          toColRaw: relation.fromCol,
        });
        addOutbound(viaAcc.outbound, outRowKey, JSON.stringify([targetKey, targetRowKey]));
        if (inRowKey !== outRowKey) {
          const bridgeKey = JSON.stringify([hopKey, inRowKey, outRowKey]);
          if (!seenBridges.has(bridgeKey)) {
            seenBridges.add(bridgeKey);
            portBridges.push({ nodeId: hopObj.id, fromColumn: viaAcc.rowNames.get(inRowKey)!, toColumn: viaAcc.rowNames.get(outRowKey)! });
          }
          addOutbound(viaAcc.outbound, inRowKey, JSON.stringify([hopKey, outRowKey]));
          pushInbound(viaAcc.inbound, outRowKey, {
            otherNodeKey: hopKey,
            otherColKey: inRowKey,
            fromColRaw: relation.fromCol,
            toColRaw: relation.toCol,
          });
        }
      }
    }

    normalized.push({
      index,
      sourceId: sourceObj.id,
      sourceCol: relation.fromCol,
      targetId: targetObj.id,
      targetCol: relation.toCol,
      viaId,
      transforms: relation.transforms,
      note: relation.note,
    });
  });

  const requested = input.requested;
  const origin = requested && input.objects.get(schemaKey(requested.node, input.identifierCaseSensitive));
  if (origin && requested) {
    for (const column of requested.columns) touchRow(getAcc(origin), column, input.identifierCaseSensitive);
  }

  for (const object of input.objects.values()) getAcc(object);

  const nodes: ColumnTraceViewNode[] = Array.from(nodeAccs.values()).map((acc) => {
    const rows = buildRows(acc, input.identifierCaseSensitive);
    const isTransform = isColumnTraceTransformNode(acc.object);
    return {
      id: acc.object.id,
      label: acc.object.label,
      schema: acc.object.schema,
      objectType: acc.object.objectType,
      isTransformNode: isTransform,
      rows,
      width: isTransform ? COLUMN_TRANSFORM_NODE_WIDTH : COLUMN_NODE_WIDTH,
      height: isTransform
        ? COLUMN_TRANSFORM_NODE_HEIGHT
        : COLUMN_NODE_HEADER_HEIGHT + rows.length * COLUMN_ROW_HEIGHT + 2 * COLUMN_NODE_BORDER_WIDTH,
      position: { x: 0, y: 0 },
    };
  });

  const edges: ColumnTraceViewEdge[] = [];
  const edgeByLeg = new Map<string, ColumnTraceViewEdge>();

  function pushEdge(
    index: number,
    leg: string,
    source: string,
    sourceCol: string,
    target: string,
    targetCol: string,
    state: ColumnLineState,
    transforms?: ColumnTransformClass[],
    note?: string,
  ): void {
    const legKey = JSON.stringify([schemaKey(source, input.identifierCaseSensitive), normalizeColName(sourceCol, input.identifierCaseSensitive), schemaKey(target, input.identifierCaseSensitive), normalizeColName(targetCol, input.identifierCaseSensitive)]);
    const shared = edgeByLeg.get(legKey);
    if (shared) {
      if (transforms) shared.transforms = [...new Set([...(shared.transforms ?? []), ...transforms])];
      shared.state = resolveColumnLineState(shared.transforms);
      if (note && !shared.note?.split('\n').includes(note)) shared.note = shared.note ? `${shared.note}\n${note}` : note;
      return;
    }
    const edge: ColumnTraceViewEdge = {
      id: `${source}::${normalizeColName(sourceCol, input.identifierCaseSensitive)}->${target}::${normalizeColName(targetCol, input.identifierCaseSensitive)}#${index}${leg}`,
      source,
      sourceHandle: columnHandleId(sourceCol, 'source', input.identifierCaseSensitive),
      sourceColumn: nodeAccs.get(schemaKey(source, input.identifierCaseSensitive))!.rowNames.get(normalizeColName(sourceCol, input.identifierCaseSensitive))!,
      target,
      targetHandle: columnHandleId(targetCol, 'target', input.identifierCaseSensitive),
      targetColumn: nodeAccs.get(schemaKey(target, input.identifierCaseSensitive))!.rowNames.get(normalizeColName(targetCol, input.identifierCaseSensitive))!,
      state,
    };
    if (transforms) edge.transforms = transforms;
    if (note) edge.note = note;
    edgeByLeg.set(legKey, edge);
    edges.push(edge);
  }

  for (const relation of normalized) {
    const state = resolveColumnLineState(relation.transforms);
    if (relation.viaId) {
      pushEdge(relation.index, 'a', relation.sourceId, relation.sourceCol, relation.viaId, relation.sourceCol, state, relation.transforms, relation.note);
      pushEdge(relation.index, 'b', relation.viaId, relation.targetCol, relation.targetId, relation.targetCol, state, relation.transforms, relation.note);
      continue;
    }
    pushEdge(relation.index, '', relation.sourceId, relation.sourceCol, relation.targetId, relation.targetCol, state, relation.transforms, relation.note);
  }

  const objectEdges: ColumnTraceViewObjectEdge[] = [];
  // A rendered column leg covers only its directed object pair, including each leg through a procedure.
  const seenObjectEdges = new Set(edges.map(({ source, target }) =>
    JSON.stringify([schemaKey(source, input.identifierCaseSensitive), schemaKey(target, input.identifierCaseSensitive)])));
  for (const { source, target } of input.objectEdges ?? []) {
    const sourceAcc = nodeAccs.get(schemaKey(source, input.identifierCaseSensitive));
    const targetAcc = nodeAccs.get(schemaKey(target, input.identifierCaseSensitive));
    if (!sourceAcc || !targetAcc || sourceAcc === targetAcc) continue;
    const pair = JSON.stringify([schemaKey(source, input.identifierCaseSensitive), schemaKey(target, input.identifierCaseSensitive)]);
    if (seenObjectEdges.has(pair)) continue;
    seenObjectEdges.add(pair);
    const firstRow = (acc: NodeAccumulator) => acc.rowKeys.length > 0 ? acc.rowNames.get(acc.rowKeys[0]) : undefined;
    const sourceRow = firstRow(sourceAcc);
    const targetRow = firstRow(targetAcc);
    objectEdges.push({
      id: `object::${sourceAcc.object.id}->${targetAcc.object.id}`,
      source: sourceAcc.object.id,
      target: targetAcc.object.id,
      ...(sourceRow !== undefined ? { sourceHandle: columnHandleId(sourceRow, 'source', input.identifierCaseSensitive) } : {}),
      ...(targetRow !== undefined ? { targetHandle: columnHandleId(targetRow, 'target', input.identifierCaseSensitive) } : {}),
    });
  }

  const boxes = new Map(nodes.map(n => [n.id, { width: n.width, height: n.height }]));
  const direction = input.layoutDirection ?? input.config.layout.direction;
  const positions = dagreLayout({
    nodeIds: nodes.map(n => n.id),
    edges: [...edges, ...objectEdges].filter(e => e.source !== e.target).map(e => ({ source: e.source, target: e.target })),
    config: withAnnotationBand(input.config, direction),
    direction,
    sizeOf: id => boxes.get(id) ?? { width: COLUMN_NODE_WIDTH, height: 0 },
  });
  for (const node of nodes) {
    const positioned = positions.get(node.id);
    if (positioned) node.position = positioned;
  }

  return { nodes, edges, objectEdges, portBridges, identifierCaseSensitive: input.identifierCaseSensitive };
}
