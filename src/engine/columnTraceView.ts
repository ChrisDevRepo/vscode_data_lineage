/**
 * @module columnTraceView
 * Derives the column-level rendering of an AI column trace from the wire payload.
 *
 * The column view is a second rendering of a scope the object view already shows: each traced
 * column becomes a row inside its object, and each recorded column relation becomes an edge between
 * two row handles. Every value here is derived from `AIViewMetadata.columnAspect.edges` and the
 * node verdicts that accompany them — this module never asks the host for more data and never
 * mutates the object-view model.
 */

import { dagreLayout } from './graphBuilder';
import { normalizeColName } from '../utils/sql';
import type { ColumnTransformClass } from './shared/bridgeContract';
import type { ExtensionConfig } from './types';

/**
 * Whether the value arriving at a relation's target is the value that left its source.
 *
 * @remarks
 * A property of the two endpoint tuples, never of the path between them: a chain of several
 * mechanisms inside a CTE is still, at the endpoints, a `transformation`. `unknown` is the honest
 * result when neither a per-line label nor a node verdict settles it, and renders no glyph.
 */
export type ColumnLineState = 'passthrough' | 'transformation' | 'unknown';

/**
 * Structural shape of a row, derived from the relation set alone.
 *
 * @remarks
 * Never authored by the model — `renamed` means an inbound relation's endpoint names differ,
 * `incoming` that several
 * upstream columns feed this one, `outgoing` that one upstream column feeds several downstream
 * columns, and `terminal` that the trace recorded no upstream for it.
 */
type ColumnRowShape = 'renamed' | 'incoming' | 'outgoing' | 'terminal';

/**
 * One row inside a column-trace node: a traced column, or a port on a transform node.
 *
 * @remarks
 * Only columns the trace recorded a relation for become rows — declared column lists are host-only
 * and never reach this module, so a row is by construction a traced one.
 */
export interface ColumnTraceRow {
  /** Column name as recorded, or the borrowed name flowing through a transform node. */
  name: string;
  /** Derived structural shape; absent when none applies. */
  shape?: ColumnRowShape;
  /** Contributing upstream (`incoming`) or feeding downstream (`outgoing`) column count. */
  contributors?: number;
  /**
   * Declared SQL data type from the extracted model — backend metadata, never an AI claim. Absent
   * for borrowed transform-port names and for columns the host model declares no type for.
   */
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
  /**
   * Declared column data types from the extracted model, keyed by {@link normalizeColName}. Row
   * rows join against this to show the type beside the name; absent when the host model declares
   * no columns for the object.
   */
  columnTypes?: ReadonlyMap<string, string>;
}

/** A node in the column-trace view, positioned and sized for the canvas. */
export interface ColumnTraceViewNode extends ColumnTraceViewObject {
  /**
   * Whether rows are ports rather than declared columns.
   *
   * @remarks
   * True for procedures and for functions that declare no columns (scalar UDFs). A table-valued
   * function with extracted columns stays a column card. Hub rows carry borrowed names, show no
   * data type, and are never dimmed against a declared set.
   */
  isTransformNode: boolean;
  /** Rows to render, in declared ordinal order where a declared order is known. */
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
  /** Source column name as recorded, for callers that follow a thread across edges. */
  sourceColumn: string;
  /** Target node id. */
  target: string;
  /** Handle id on the target node, from {@link columnHandleId}. */
  targetHandle: string;
  /** Target column name as recorded, for callers that follow a thread across edges. */
  targetColumn: string;
  /** Whether the value changed between the two endpoints. */
  state: ColumnLineState;
  /**
   * Transform classes the model recorded for the relation, absent on an unclassified edge. The
   * marker chip keys its per-class glyphs off this; the verdict-derived {@link state} alone no
   * longer decides what the chip shows when a classification exists.
   */
  transforms?: ColumnTransformClass[];
  /**
   * One-clause model note for the relation ("SUM of line totals"), absent whenever the model
   * offered none. Printed verbatim as the chip tooltip's second line; a leg two relations share
   * carries each distinct note on its own line.
   */
  note?: string;
}

/**
 * Two ports of one node the same relation passes between — the hop's inside link.
 *
 * @remarks
 * A relation drawn through an analysing hop lands on two ports of that hop when the column is
 * renamed across it (`Qty` in, `TotalRevenue` out). The two are one continuation of a single
 * thread, but no edge is drawn between them: the transform circle already says the change happens
 * there. Recorded here so a caller following the thread crosses the hop instead of dead-ending on
 * the port it arrived at.
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
  /** Positioned nodes. */
  nodes: ColumnTraceViewNode[];
  /** Per-column edges between row handles. */
  edges: ColumnTraceViewEdge[];
  /** Inside-the-hop port links, drawn as nothing and traversed like an edge. */
  portBridges: ColumnTracePortBridge[];
}

/** One recorded column relation, as it arrives on the wire. */
export interface ColumnTraceRelation {
  /** Node that analysed the hop producing this relation. */
  hopNode: string;
  /** Source node id. */
  fromNode: string;
  /** Source column name. */
  fromCol: string;
  /** Target node id. */
  toNode: string;
  /** Target column name. */
  toCol: string;
  /** Transform classes the model recorded for this relation; absent on an unclassified edge. */
  transforms?: ColumnTransformClass[];
  /** One-clause model note for the relation; absent whenever the model offered none. */
  note?: string;
}

/** Input to {@link buildColumnTraceView}. */
export interface ColumnTraceViewInput {
  /** Recorded column relations from `AIViewMetadata.columnAspect.edges`. */
  relations: ColumnTraceRelation[];
  /** Object identity for every node the relations reference, keyed by lower-cased node id. */
  objects: Map<string, ColumnTraceViewObject>;
  /**
   * Per-node trace verdict, keyed by lower-cased node id.
   *
   * @remarks
   * `passthrough` means the node applied no logic to the columns flowing through it, so every
   * relation whose hop node carries that verdict is a `passthrough` line. Absent entries yield
   * `unknown`, which renders no glyph.
   */
  verdicts?: Map<string, 'analyze' | 'passthrough' | 'prune'>;
  /**
   * Live extension configuration, supplying the layout separations and the default direction.
   *
   * @remarks
   * Required rather than defaulted: the column view is a second rendering of a scope the object
   * view already lays out, so a default here would silently render the two views under different
   * settings.
   */
  config: ExtensionConfig;
  /** Layout direction requested by the view; defaults to the configured direction. */
  layoutDirection?: 'LR' | 'TB';
}

/** Node width used for every column-trace node. */
export const COLUMN_NODE_WIDTH = 214;

/**
 * Node width used for a transform super node — a procedure or function rendered as a circle-and-gear
 * hub rather than a column-port card. Narrower than a table card on purpose: the node's identity is
 * the circle, not a column list.
 */
export const COLUMN_TRANSFORM_NODE_WIDTH = 150;

/**
 * Minimum height of a transform super node — room for the circle, the name strip beneath it, and
 * one port even when the trace records a single column through the node.
 */
export const COLUMN_TRANSFORM_NODE_MIN_HEIGHT = 96;

/**
 * Vertical distance between consecutive port handles on a transform super node. The handles stay
 * the edges' attachment points (invisible, fanned across the circle), so the spread — not the
 * circle's radius — decides how far apart two lines through the same hub land.
 */
export const COLUMN_TRANSFORM_PORT_SPREAD = 26;

/** Height of a column-trace node header. */
export const COLUMN_NODE_HEADER_HEIGHT = 28;

/** Height of one column row. */
export const COLUMN_ROW_HEIGHT = 22;

/**
 * Card border width of a column-trace node.
 *
 * @remarks
 * Part of the node height because the card is laid out `border-box`: the header and rows occupy the
 * padding box, so a height that counted only them would clip the last row by the border.
 */
export const COLUMN_NODE_BORDER_WIDTH = 2;

/**
 * Vertical space the AI badge and note occupy outside the card, added to the layout's vertical
 * separation.
 *
 * @remarks
 * Both annotations render through React Flow's `NodeToolbar` (`AiNodeAnnotations.tsx`), which is
 * positioned outside the node box and therefore invisible to Dagre: the badge above (~16px plus its
 * 2px offset) and the note below (~12px plus 2px) draw ~32px that no node height accounts for. At
 * the default `nodeSeparation` of 30 that guarantees a collision — the reported symptom is one
 * node's note landing on the next node's badge. The band is added to the separation rather than to
 * the node height because Dagre returns a centred box: a taller box would move the card inside the
 * reserved space and need a compensating offset at every read of the position.
 *
 * Applied unconditionally in the column view, which is only ever built from AI metadata, so every
 * column-trace graph is an AI view.
 */
export const COLUMN_AI_ANNOTATION_BAND = 32;

/**
 * Opacity of a column-view edge outside the hovered path.
 *
 * @remarks
 * One concept — de-emphasis while a column path is lit — governed here for both of its render
 * targets, because they read as a single visual effect and drifted apart once already. The two
 * values differ deliberately: an edge is pure decoration and can recede almost to nothing, while a
 * row carries the column name and has to stay readable, so it dims to
 * {@link COLUMN_ROW_DIM_OPACITY} instead. Change them together.
 */
export const COLUMN_EDGE_DIM_OPACITY = 0.25;

/** Opacity of a column row outside the hovered path; see {@link COLUMN_EDGE_DIM_OPACITY}. */
export const COLUMN_ROW_DIM_OPACITY = 0.5;

/**
 * Builds a React Flow handle id for a column row.
 *
 * @remarks
 * A row can carry both an incoming and an outgoing edge, so `side` is part of the id — a bare
 * column name would collide between the two handles on the same row. The column name is compared
 * via {@link normalizeColName} so a relation's raw spelling (bracketed, differently cased) resolves
 * to the same handle as the row it targets.
 *
 * @param column - Column name as it appears on the relation or row.
 * @param side - Which handle on the row this id addresses.
 * @returns A deterministic, stable handle id.
 */
export function columnHandleId(column: string, side: 'source' | 'target'): string {
  return `${side}:${normalizeColName(column)}`;
}

/**
 * Builds the canonical key for a node-and-column pair.
 *
 * @remarks
 * A different key space from {@link columnHandleId} — that one addresses one of the two handles on a
 * row, this one identifies the row itself — but both normalise the column the same way, so a
 * relation's raw spelling resolves to the row it names.
 *
 * @param nodeId - Canonical node id.
 * @param column - Column name as it appears on the relation or row.
 * @returns A deterministic key for set and map membership.
 */
export function columnRowKey(nodeId: string, column: string): string {
  return `${nodeId.toLowerCase()}.${normalizeColName(column)}`;
}

/**
 * Resolves a column edge's {@link ColumnLineState} from its hop node's trace verdict.
 *
 * @remarks
 * Verdict-only resolution: `passthrough` yields `passthrough`, `analyze` yields `transformation`,
 * and a `prune` verdict or no verdict at all yields `unknown`. Isolated in its own function so a
 * future per-line label (a more precise, line-level signal than the node-level verdict) can take
 * precedence over this result without touching the verdict lookup itself.
 *
 * Exported for its own unit test, not for use elsewhere: no production caller outside this module
 * imports it, and a per-edge state resolved anywhere but here would be a second governor of the
 * same glyph. Read the state off the built view instead.
 *
 * @param hopNode - Hop node id from the relation, compared case-insensitively.
 * @param verdicts - Per-node trace verdicts, keyed by lower-cased node id.
 * @returns The resolved line state.
 */
export function resolveVerdictLineState(
  hopNode: string,
  verdicts?: Map<string, 'analyze' | 'passthrough' | 'prune'>,
): ColumnLineState {
  const verdict = verdicts?.get(hopNode.toLowerCase());
  if (verdict === 'passthrough') return 'passthrough';
  if (verdict === 'analyze') return 'transformation';
  return 'unknown';
}

/**
 * Reduces every edge arriving at a row to that row's single line state.
 *
 * @remarks
 * An `incoming` row carries several inbound edges by construction, so a per-row indicator must reduce
 * them rather than keep whichever the relation list happened to end on — that would make the glyph
 * depend on hop order rather than on the trace. A transforming contributor makes the value arriving
 * at the row a transformation; `passthrough` requires every contributor to agree; a disagreement
 * that involves no transformation is `unknown`, which renders no glyph, matching the honest-unknown
 * rule {@link resolveVerdictLineState} already applies per edge.
 *
 * @param edges - The view's per-column edges.
 * @returns Line state keyed by the {@link columnRowKey} of each edge's target row.
 */
export function resolveRowLineStates(
  edges: readonly ColumnTraceViewEdge[],
): Map<string, ColumnLineState> {
  const byRow = new Map<string, ColumnLineState>();
  for (const edge of edges) {
    const key = columnRowKey(edge.target, edge.targetColumn);
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
  /** Lower-cased canonical id of the node at the other end of the relation. */
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
  /** Normalised row key to first-seen display name. */
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

function touchRow(acc: NodeAccumulator, columnName: string): string {
  const rowKey = normalizeColName(columnName);
  if (!acc.rowNames.has(rowKey)) {
    acc.rowNames.set(rowKey, columnName);
    acc.rowKeys.push(rowKey);
  }
  return rowKey;
}

/**
 * Derives one node's rows from its accumulated relations.
 *
 * @remarks
 * Shape precedence, most to least specific, applied when more than one condition holds for a row:
 * `incoming` (multiple distinct upstream tuples) outranks `outgoing` (one upstream column feeding
 * multiple targets), which outranks `renamed` (an inbound relation whose endpoint names differ),
 * which outranks `terminal` (no inbound relation at all) — a structural multiplicity is a stronger
 * signal than a naming difference, which is itself stronger than the mere absence of an upstream
 * relation.
 *
 * `renamed` is derived from inbound relations only: the name change happens at the target tuple, so
 * tagging the source row as well would mark a column that was never renamed.
 */
function buildRows(acc: NodeAccumulator): ColumnTraceRow[] {
  return acc.rowKeys.map((rowKey) => {
    const name = acc.rowNames.get(rowKey)!;
    const inbound = acc.inbound.get(rowKey) ?? [];
    const upstreamTuples = new Set(inbound.map((x) => `${x.otherNodeKey}::${x.otherColKey}`));
    const downstreamTuples = acc.outbound.get(rowKey) ?? new Set<string>();
    const renamed = inbound.some((x) => normalizeColName(x.fromColRaw) !== normalizeColName(x.toColRaw));

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

/**
 * Widens the layout separation on the axis the AI annotations grow along.
 *
 * @remarks
 * Under `LR` the ranks are columns and a node's vertical neighbour is its rank sibling, so the band
 * belongs to `nodeSeparation`; under `TB` the vertical neighbour is the next rank, so it belongs to
 * `rankSeparation`. Returned as a config copy rather than a separate layout input because the layout
 * cache keys on both separations — a banded layout would otherwise reuse an unbanded cache entry.
 *
 * @param config - Live extension configuration.
 * @param direction - Resolved rankdir for this view.
 * @returns A config carrying {@link COLUMN_AI_ANNOTATION_BAND} on the vertical separation.
 */
function withAnnotationBand(config: ExtensionConfig, direction: 'LR' | 'TB'): ExtensionConfig {
  const layout = direction === 'TB'
    ? { ...config.layout, rankSeparation: config.layout.rankSeparation + COLUMN_AI_ANNOTATION_BAND }
    : { ...config.layout, nodeSeparation: config.layout.nodeSeparation + COLUMN_AI_ANNOTATION_BAND };
  return { ...config, layout };
}

/**
 * Whether an object draws as a transform hub rather than a column card.
 *
 * @remarks
 * Procedures declare no columns. Functions do only when they are table-valued and the host
 * extracted those columns — a scalar UDF has an empty or absent map and stays a hub.
 */
function isColumnTraceTransformNode(object: ColumnTraceViewObject): boolean {
  if (object.objectType === 'procedure') return true;
  if (object.objectType === 'function') return !object.columnTypes || object.columnTypes.size === 0;
  return false;
}

/**
 * Builds the column-level rendering of an AI column trace.
 *
 * @remarks
 * Row order is first-seen order across `input.relations` — there is no declared ordinal
 * information available at this stage, so rows are never sorted alphabetically or by relevance.
 *
 * A relation recorded more than once — the same endpoints and the same hop node — is skipped before
 * any node accumulator is written, so a column re-submitted across hops counts once for the rows a
 * node derives as well as for the edges drawn on the canvas.
 *
 * A relation analysed by a hop node that is neither endpoint but is itself on the canvas is drawn
 * through that node as two legs, source to hop and hop to target, rather than as one line past it.
 * A collapsed line would leave the hop with no inbound edge, which ranks a procedure as a source and
 * parks it at the left margin with a canvas-spanning line to its output. The split is a drawing
 * decision only: the target's incoming count and rename signal still describe the original endpoint
 * pair, since that is where the value came from.
 *
 * A relation whose source or target node is absent from `input.objects` is skipped: it has no node
 * to draw a row in. The trace scope is derived from the same relation list that produced these
 * edges, so an endpoint missing from the caller's graph means the object was filtered out of the
 * view, not that a finding was lost.
 *
 * @param input - Recorded column relations, object identities, and verdicts for one trace.
 * @returns Positioned nodes and per-column edges ready to render.
 */
export function buildColumnTraceView(input: ColumnTraceViewInput): ColumnTraceView {
  const nodeAccs = new Map<string, NodeAccumulator>();

  function getAcc(object: ColumnTraceViewObject): NodeAccumulator {
    const key = object.id.toLowerCase();
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
    const sourceObj = input.objects.get(relation.fromNode.toLowerCase());
    const targetObj = input.objects.get(relation.toNode.toLowerCase());
    if (!sourceObj || !targetObj) return;

    const sourceKey = sourceObj.id.toLowerCase();
    const targetKey = targetObj.id.toLowerCase();
    const hopKey = relation.hopNode.toLowerCase();

    // Ahead of every accumulator write, so a repeat is one fact for the rows a node derives as well
    // as for the edges drawn: `inbound` is a plain array, and a duplicate push would be counted by
    // any reader that looks at its length or order rather than reducing it.
    const identity = [sourceKey, normalizeColName(relation.fromCol), targetKey, normalizeColName(relation.toCol), hopKey].join('->');
    if (seenRelations.has(identity)) return;
    seenRelations.add(identity);

    const sourceAcc = getAcc(sourceObj);
    const targetAcc = getAcc(targetObj);
    const sourceRowKey = touchRow(sourceAcc, relation.fromCol);
    const targetRowKey = touchRow(targetAcc, relation.toCol);

    // The semantic relation stays source-to-target even when the drawing goes through a hop: the
    // target's incoming count and rename signal describe where its value came from, not which node
    // carried it there.
    addOutbound(sourceAcc.outbound, sourceRowKey, `${targetKey}::${targetRowKey}`);
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
        // One port per column passing through, under the name it carries on each side: a rename
        // inside the hop shows as two ports, an unchanged name as one.
        const inRowKey = touchRow(viaAcc, relation.fromCol);
        const outRowKey = touchRow(viaAcc, relation.toCol);
        pushInbound(viaAcc.inbound, inRowKey, {
          otherNodeKey: sourceKey,
          otherColKey: sourceRowKey,
          fromColRaw: relation.fromCol,
          toColRaw: relation.fromCol,
        });
        addOutbound(viaAcc.outbound, outRowKey, `${targetKey}::${targetRowKey}`);
        if (inRowKey !== outRowKey) {
          // The two ports are one thread through the hub; nothing is drawn between them, so the
          // link is recorded for whoever follows the thread.
          const bridgeKey = `${hopKey}::${inRowKey}->${outRowKey}`;
          if (!seenBridges.has(bridgeKey)) {
            seenBridges.add(bridgeKey);
            portBridges.push({ nodeId: hopObj.id, fromColumn: relation.fromCol, toColumn: relation.toCol });
          }
          addOutbound(viaAcc.outbound, inRowKey, `${hopKey}::${outRowKey}`);
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
      hopNode: relation.hopNode,
      viaId,
      transforms: relation.transforms,
      note: relation.note,
    });
  });

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
      // A table card sizes to its header and rows; a transform super node sizes to a circle with the
      // port spread fanned across it, so the box stays compact and symmetric however few ports run
      // through it.
      height: isTransform
        ? Math.max(COLUMN_TRANSFORM_NODE_MIN_HEIGHT, rows.length * COLUMN_TRANSFORM_PORT_SPREAD + 34)
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
    // Two relations through the same hop share a leg — the two inbound halves stay distinct, their
    // outbound halves are one line. Drawing both would stack identical lines on the same handles, so
    // the shared line carries the union of both relations' transform classes and of their notes —
    // a class on the chip is never left without the note that explains it.
    const legKey = `${source.toLowerCase()}::${normalizeColName(sourceCol)}->${target.toLowerCase()}::${normalizeColName(targetCol)}`;
    const shared = edgeByLeg.get(legKey);
    if (shared) {
      if (transforms) shared.transforms = [...new Set([...(shared.transforms ?? []), ...transforms])];
      if (note && !shared.note?.split('\n').includes(note)) shared.note = shared.note ? `${shared.note}\n${note}` : note;
      return;
    }
    const edge: ColumnTraceViewEdge = {
      id: `${source}::${normalizeColName(sourceCol)}->${target}::${normalizeColName(targetCol)}#${index}${leg}`,
      source,
      sourceHandle: columnHandleId(sourceCol, 'source'),
      sourceColumn: sourceCol,
      target,
      targetHandle: columnHandleId(targetCol, 'target'),
      targetColumn: targetCol,
      state,
    };
    // Both legs of a hop-routed relation carry the same classification: the split is a drawing
    // decision, and the value's story is one fact about the original endpoint pair.
    if (transforms) edge.transforms = transforms;
    if (note) edge.note = note;
    edgeByLeg.set(legKey, edge);
    edges.push(edge);
  }

  for (const relation of normalized) {
    const state = resolveVerdictLineState(relation.hopNode, input.verdicts);
    if (relation.viaId) {
      pushEdge(relation.index, 'a', relation.sourceId, relation.sourceCol, relation.viaId, relation.sourceCol, state, relation.transforms, relation.note);
      pushEdge(relation.index, 'b', relation.viaId, relation.targetCol, relation.targetId, relation.targetCol, state, relation.transforms, relation.note);
      continue;
    }
    pushEdge(relation.index, '', relation.sourceId, relation.sourceCol, relation.targetId, relation.targetCol, state, relation.transforms, relation.note);
  }

  // Laid out by graphBuilder's dagreLayout so the column view shares the object view's
  // rankdir/separation/margins; only the per-node box differs (rows give variable heights) and the
  // vertical separation carries the AI annotation band the node box cannot express.
  const boxes = new Map(nodes.map(n => [n.id, { width: n.width, height: n.height }]));
  const direction = input.layoutDirection ?? input.config.layout.direction;
  const positions = dagreLayout({
    nodeIds: nodes.map(n => n.id),
    edges: edges.filter(e => e.source !== e.target).map(e => ({ source: e.source, target: e.target })),
    config: withAnnotationBand(input.config, direction),
    direction,
    sizeOf: id => boxes.get(id) ?? { width: COLUMN_NODE_WIDTH, height: 0 },
  });
  for (const node of nodes) {
    const positioned = positions.get(node.id);
    if (positioned) node.position = positioned;
  }

  return { nodes, edges, portBridges };
}
