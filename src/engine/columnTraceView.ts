/**
 * @module columnTraceView
 * Derives the column-level rendering of an AI column trace from the wire payload: a second
 * rendering of a scope the object view already shows, with each traced column a row inside its
 * object and each recorded relation an edge between two row handles. Everything derives from
 * `AIViewMetadata.columnAspect.edges` and the node verdicts; it never asks the host for more data
 * and never mutates the object-view model.
 */

import { AI_BADGE_BAND, AI_NOTE_BAND, dagreLayout } from './graphBuilder';
import { normalizeColName, schemaKey } from '../utils/sql';
import type { ColumnAspectEdge, ColumnTransformClass, NodeVerdict } from './shared/bridgeContract';
import type { ExtensionConfig } from './types';

/**
 * Whether the value arriving at a relation's target is the value that left its source. A property
 * of the two endpoint tuples, not the path: a chain of several mechanisms inside a CTE is still, at
 * the endpoints, a `transformation`. `unknown` is the result when neither a per-line label nor a
 * node verdict settles it, and renders no glyph.
 */
export type ColumnLineState = 'passthrough' | 'transformation' | 'unknown';

/**
 * One row inside a column-trace node: a traced column, or a port on a transform node. Only columns
 * the trace recorded a relation for become rows; extracted column metadata supplies display names
 * and types but never introduces an untraced row.
 */
export interface ColumnTraceRow {
  /** Extracted column name when available, else the recorded or borrowed transform-port name. */
  name: string;
  /**
   * Declared SQL data type from the extracted model (backend metadata, never an AI claim); absent
   * for borrowed transform-port names and columns the host model declares no type for.
   */
  dataType?: string;
}

/** Object identity the view needs for a node header, supplied by the caller's graph model. */
export interface ColumnTraceViewObject {
  /** Canonical node id, matching the ids used in the column relations. */
  id: string;
  label: string;
  schema: string;
  /** Object type as carried by the graph model. */
  objectType: string;
  /**
   * Declared column data types from the extracted model, keyed by {@link normalizeColName} under
   * the source policy, shown beside the row name; absent when the host model declares no columns
   * for the object.
   */
  columnTypes?: ReadonlyMap<string, string>;
  /** Extracted column display names, keyed by {@link normalizeColName} under the source policy. */
  columnNames?: ReadonlyMap<string, string>;
}

/** A node in the column-trace view, positioned and sized for the canvas. */
export interface ColumnTraceViewNode extends ColumnTraceViewObject {
  /**
   * Whether rows are ports rather than declared columns: true for procedures and for functions that
   * declare no columns (scalar UDFs). A table-valued function with extracted columns stays a column
   * card. Hub rows carry borrowed names and show no data type.
   */
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
  source: string;
  /** Handle id on the source node, from {@link columnHandleId}. */
  sourceHandle: string;
  /** Source row's display name, for callers that follow a thread across edges. */
  sourceColumn: string;
  target: string;
  /** Handle id on the target node, from {@link columnHandleId}. */
  targetHandle: string;
  /** Target row's display name, for callers that follow a thread across edges. */
  targetColumn: string;
  /** Whether the value changed between the two endpoints. */
  state: ColumnLineState;
  /**
   * Transform classes the model recorded for the relation; absent on an unclassified edge. The
   * marker chip keys its per-class glyphs off this; when present it, not the verdict-derived
   * {@link state}, decides what the chip shows.
   */
  transforms?: ColumnTransformClass[];
  /**
   * One-clause model note for the relation ("SUM of line totals"), absent when the model offered
   * none. Printed verbatim as the chip tooltip's second line; a leg two relations share carries
   * each distinct note on its own line.
   */
  note?: string;
}

/**
 * An object-level edge between two presented objects, drawn where a column edge cannot be: the same
 * dependency the Objects view draws, added only when an endpoint carries no column relation, so it
 * never duplicates a column thread.
 */
export interface ColumnTraceViewObjectEdge {
  /** Stable edge id, unique in the view and distinct from every {@link ColumnTraceViewEdge} id. */
  id: string;
  source: string;
  target: string;
  /** Handle on the source node: its first row's handle, absent on a node without rows. */
  sourceHandle?: string;
  /** Handle on the target node: its first row's handle, absent on a node without rows. */
  targetHandle?: string;
}

/**
 * Two ports of one node the same relation passes between: the hop's inside link. A relation through
 * an analysing hop lands on two ports when the column is renamed across it (`Qty` in,
 * `TotalRevenue` out). They are one continuation of a thread, but no edge is drawn (the transform
 * circle already says the change happens there); recorded so a caller following the thread crosses
 * the hop instead of dead-ending on its inbound port.
 *
 * One entry per relation, never a mesh across the hub: two relations meeting at one output port
 * stay two bridges, so unrelated threads through the same procedure do not merge.
 */
export interface ColumnTracePortBridge {
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
  nodes: ColumnTraceViewNode[];
  edges: ColumnTraceViewEdge[];
  /** Object-level edges that join an object without traced columns to its neighbours. */
  objectEdges: ColumnTraceViewObjectEdge[];
  /** Inside-the-hop port links, drawn as nothing and traversed like an edge. */
  portBridges: ColumnTracePortBridge[];
}

/**
 * One recorded column relation, as it arrives on the wire — the wire shape of
 * `AIViewMetadata.columnAspect.edges`.
 */
export type ColumnTraceRelation = ColumnAspectEdge;

export interface ColumnTraceViewInput {
  /** Checked model catalog policy; missing metadata retains CI. */
  identifierCaseSensitive?: boolean;
  /** Recorded column relations from `AIViewMetadata.columnAspect.edges`. */
  relations: ColumnTraceRelation[];
  /**
   * Object identity for every presented node, keyed by {@link schemaKey} under the source policy.
   * An object no relation touches still becomes a node with no rows, so the column view shows the
   * same objects as the object view.
   */
  objects: Map<string, ColumnTraceViewObject>;
  /**
   * Dependency edges of the object view between presented objects, by node id. Drawn only where an
   * endpoint has no column relation; endpoints missing from `objects` and self edges are ignored.
   */
  objectEdges?: ReadonlyArray<{ source: string; target: string }>;
  /**
   * Per-node trace verdict, keyed by {@link schemaKey} under the source policy. `passthrough` means
   * the node applied no logic, so every relation whose hop node carries it is a `passthrough` line;
   * absent entries yield `unknown`, which renders no glyph.
   */
  verdicts?: Map<string, NodeVerdict['verdict']>;
  /**
   * Live extension configuration (layout separations, default direction). Required, not defaulted:
   * a default would silently render the column and object views under different settings.
   */
  config: ExtensionConfig;
  /** Layout direction requested by the view; defaults to the configured direction. */
  layoutDirection?: 'LR' | 'TB';
}

/** Node width used for every column-trace node. */
export const COLUMN_NODE_WIDTH = 214;

/**
 * Node width of a transform super node (a procedure or function drawn as a circle-and-gear hub).
 * Narrower than a table card on purpose: its identity is the circle, not a column list.
 */
export const COLUMN_TRANSFORM_NODE_WIDTH = 150;

/** Diameter of a transform super node's circle, fixed however many ports run through it. */
export const COLUMN_TRANSFORM_CIRCLE_DIAMETER = 40;

/** Height of the name strip beneath a transform super node's circle. */
export const COLUMN_TRANSFORM_NAME_STRIP_HEIGHT = 20;

/**
 * Height of a transform super node: the circle, a small margin and the name strip beneath it.
 * Fixed, not grown with the port count: a procedure is a process step drawn as one small icon node,
 * and the ports compress along the circle's arc.
 */
export const COLUMN_TRANSFORM_NODE_HEIGHT = COLUMN_TRANSFORM_CIRCLE_DIAMETER + 8 + COLUMN_TRANSFORM_NAME_STRIP_HEIGHT;

/**
 * Largest vertical distance between consecutive port handles on a transform super node. When more
 * ports run through the hub than fit at this spacing on the arc, the spacing shrinks so every
 * handle stays on the stroke.
 */
export const COLUMN_TRANSFORM_PORT_SPREAD = 10;

/** Height of a column-trace node header. */
export const COLUMN_NODE_HEADER_HEIGHT = 28;

/** Height of one column row. */
export const COLUMN_ROW_HEIGHT = 22;

/**
 * Card border width of a column-trace node. Part of the node height because the card is
 * `border-box`: a height counting only header and rows would clip the last row by the border.
 */
export const COLUMN_NODE_BORDER_WIDTH = 2;

/**
 * Vertical space the AI badge and note occupy outside the card, added to the layout's vertical
 * separation. Both render through React Flow's `NodeToolbar`, outside the node box and invisible to
 * Dagre; it is added to the separation, not the node height, because Dagre returns a centred box
 * and a taller one would need a compensating offset at every position read. Sized off
 * {@link AI_BADGE_BAND} and {@link AI_NOTE_BAND}, the object view's reservation for the same
 * toolbars, so both views share one governor.
 */
export const COLUMN_AI_ANNOTATION_BAND = AI_BADGE_BAND + AI_NOTE_BAND;

/**
 * Opacity of a column-view edge outside the hovered path. An edge is decoration and can recede
 * almost to nothing, while a row carries the column name and must stay readable, so it dims to
 * {@link COLUMN_ROW_DIM_OPACITY} instead. Change together.
 */
export const COLUMN_EDGE_DIM_OPACITY = 0.25;

/** Opacity of a column row outside the hovered path; see {@link COLUMN_EDGE_DIM_OPACITY}. */
export const COLUMN_ROW_DIM_OPACITY = 0.5;

/**
 * Builds a React Flow handle id for a column row. `side` is part of the id because a row can carry
 * both an incoming and an outgoing edge, and a bare column name would collide between the two
 * handles.
 */
export function columnHandleId(column: string, side: 'source' | 'target', identifierCaseSensitive = false): string {
  return `${side}:${normalizeColName(column, identifierCaseSensitive)}`;
}

/**
 * Builds the canonical key for a node-and-column pair: the row itself, a different key space from
 * {@link columnHandleId}, which addresses one of the row's two handles.
 */
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

/**
 * Indexes a column view's edges and port bridges by direction, once per view. A port bridge runs
 * `fromColumn → toColumn` as the value crosses the hop, so it is indexed like an edge; without it a
 * thread entering a renaming procedure would stop at its inbound port.
 */
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

/**
 * Row keys in the trace cone of one row: everything it is derived from plus everything derived from
 * it. Two walks, one upstream and one downstream, each confined to its direction; a single
 * undirected walk would turn around at a fan-in (from `Qty` down to `TotalRevenue`, back up into
 * `UnitPrice`) and light unrelated inputs.
 *
 * @param index - Directed adjacency from {@link buildColumnThreadIndex}.
 * @param startKey - Row key from {@link columnRowKey}.
 */
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

/**
 * Resolves a column edge's {@link ColumnLineState} from its hop node's trace verdict only:
 * `passthrough` gives `passthrough`, `analyze` gives `transformation`, `prune` or no verdict gives
 * `unknown`. Exported for its own unit test only; a per-edge state resolved elsewhere would be a
 * second governor of the same glyph.
 *
 * @param hopNode - Hop node id, compared under the source identifier policy.
 */
export function resolveVerdictLineState(
  hopNode: string,
  verdicts?: Map<string, NodeVerdict['verdict']>,
  identifierCaseSensitive = false,
): ColumnLineState {
  const verdict = verdicts?.get(schemaKey(hopNode, identifierCaseSensitive));
  if (verdict === 'passthrough') return 'passthrough';
  if (verdict === 'analyze') return 'transformation';
  return 'unknown';
}

/**
 * Reduces every edge arriving at a row to that row's single line state: a transforming contributor
 * makes it a transformation; `passthrough` requires every contributor to agree; a disagreement with
 * no transformation is `unknown` (the honest-unknown rule of {@link resolveVerdictLineState}).
 *
 * @returns Line state keyed by the {@link columnRowKey} of each edge's target row.
 */
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

/** Per-node accumulator built while walking `input.relations`. */
interface NodeAccumulator {
  /** Object identity supplied by the caller. */
  object: ColumnTraceViewObject;
  /** Normalised row keys in first-seen order. */
  rowKeys: string[];
  /** Normalised row key to metadata display name, or first-seen spelling without metadata. */
  rowNames: Map<string, string>;
}

function touchRow(acc: NodeAccumulator, columnName: string, identifierCaseSensitive: boolean | undefined): string {
  const rowKey = normalizeColName(columnName, identifierCaseSensitive);
  if (!acc.rowNames.has(rowKey)) {
    acc.rowNames.set(rowKey, acc.object.columnNames?.get(rowKey) ?? columnName);
    acc.rowKeys.push(rowKey);
  }
  return rowKey;
}

/** Derives one node's rows: display name and declared type per touched row key. */
function buildRows(acc: NodeAccumulator): ColumnTraceRow[] {
  return acc.rowKeys.map((rowKey) => {
    const row: ColumnTraceRow = { name: acc.rowNames.get(rowKey)! };
    const dataType = acc.object.columnTypes?.get(rowKey);
    if (dataType) row.dataType = dataType;
    return row;
  });
}

/**
 * Widens the layout separation on the axis the AI annotations grow along: under `LR` the vertical
 * neighbour is the rank sibling (`nodeSeparation`), under `TB` it is `rankSeparation`. Returned as
 * a config copy, not a separate layout input, because the layout cache keys on both separations.
 */
function withAnnotationBand(config: ExtensionConfig, direction: 'LR' | 'TB'): ExtensionConfig {
  const layout = direction === 'TB'
    ? { ...config.layout, rankSeparation: config.layout.rankSeparation + COLUMN_AI_ANNOTATION_BAND }
    : { ...config.layout, nodeSeparation: config.layout.nodeSeparation + COLUMN_AI_ANNOTATION_BAND };
  return { ...config, layout };
}

/**
 * Whether an object draws as a transform hub rather than a column card. Procedures declare no
 * columns; functions do only when table-valued with host-extracted columns, so a scalar UDF (empty
 * or absent map) stays a hub.
 */
function isColumnTraceTransformNode(object: ColumnTraceViewObject): boolean {
  if (object.objectType === 'procedure') return true;
  if (object.objectType === 'function') return !object.columnTypes || object.columnTypes.size === 0;
  return false;
}

/**
 * Builds the column-level rendering of an AI column trace.
 *
 * Row order is first-seen order across `input.relations` (no declared ordinal exists here). A
 * relation recorded more than once (same endpoints, same hop node) is skipped before any
 * accumulator write, so a column re-submitted across hops counts once. A relation analysed by a hop
 * node that is neither endpoint but is on the canvas draws as two legs (source to hop, hop to
 * target) rather than one line past it; a collapsed line would leave the hop with no inbound edge,
 * parked at the left margin, and the target's incoming count and rename signal still describe the
 * original endpoint pair. A relation whose endpoint is absent from `input.objects` is skipped
 * (filtered out of the view, not a lost finding). An object no relation touches is appended as a
 * node with no rows, joined by `input.objectEdges`; a column trace is the object trace plus
 * columns, so it never loses an object.
 */
export function buildColumnTraceView(input: ColumnTraceViewInput): ColumnTraceView {
  const nodeAccs = new Map<string, NodeAccumulator>();

  function getAcc(object: ColumnTraceViewObject): NodeAccumulator {
    const key = schemaKey(object.id, input.identifierCaseSensitive);
    let acc = nodeAccs.get(key);
    if (!acc) {
      acc = { object, rowKeys: [], rowNames: new Map() };
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
    hopNode: string;
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

    touchRow(getAcc(sourceObj), relation.fromCol, input.identifierCaseSensitive);
    touchRow(getAcc(targetObj), relation.toCol, input.identifierCaseSensitive);

    let viaId: string | undefined;
    if (hopKey !== sourceKey && hopKey !== targetKey) {
      const hopObj = input.objects.get(hopKey);
      if (hopObj) {
        viaId = hopObj.id;
        const viaAcc = getAcc(hopObj);
        const inRowKey = touchRow(viaAcc, relation.fromCol, input.identifierCaseSensitive);
        const outRowKey = touchRow(viaAcc, relation.toCol, input.identifierCaseSensitive);
        if (inRowKey !== outRowKey) {
          const bridgeKey = JSON.stringify([hopKey, inRowKey, outRowKey]);
          if (!seenBridges.has(bridgeKey)) {
            seenBridges.add(bridgeKey);
            portBridges.push({ nodeId: hopObj.id, fromColumn: viaAcc.rowNames.get(inRowKey)!, toColumn: viaAcc.rowNames.get(outRowKey)! });
          }
        }
      }
    }

    normalized.push({
      index,
      sourceId: sourceObj.id,
      sourceCol: relation.fromCol,
      targetId: targetObj.id,
      targetCol: relation.toCol,
      hopNode: relation.hopNode,
      viaId,
      transforms: relation.transforms,
      note: relation.note,
    });
  });

  for (const object of input.objects.values()) getAcc(object);

  const nodes: ColumnTraceViewNode[] = Array.from(nodeAccs.values()).map((acc) => {
    const rows = buildRows(acc);
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
    const state = resolveVerdictLineState(relation.hopNode, input.verdicts, input.identifierCaseSensitive);
    if (relation.viaId) {
      pushEdge(relation.index, 'a', relation.sourceId, relation.sourceCol, relation.viaId, relation.sourceCol, state, relation.transforms, relation.note);
      pushEdge(relation.index, 'b', relation.viaId, relation.targetCol, relation.targetId, relation.targetCol, state, relation.transforms, relation.note);
      continue;
    }
    pushEdge(relation.index, '', relation.sourceId, relation.sourceCol, relation.targetId, relation.targetCol, state, relation.transforms, relation.note);
  }

  const objectEdges: ColumnTraceViewObjectEdge[] = [];
  const seenObjectEdges = new Set<string>();
  for (const { source, target } of input.objectEdges ?? []) {
    const sourceAcc = nodeAccs.get(schemaKey(source, input.identifierCaseSensitive));
    const targetAcc = nodeAccs.get(schemaKey(target, input.identifierCaseSensitive));
    if (!sourceAcc || !targetAcc || sourceAcc === targetAcc) continue;
    if (sourceAcc.rowKeys.length > 0 && targetAcc.rowKeys.length > 0) continue;
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
