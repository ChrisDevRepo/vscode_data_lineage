import { XMLBuilder } from 'fast-xml-parser';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData, SchemaNodeData } from '../engine/types';
import { TYPE_COLORS, createSchemaColorMap, getSchemaColorFromMap, getExternalNodeColor, getSchemaDisplayColor, isExternalOnlyTypeBreakdown, type SchemaColorMap } from '../utils/schemaColors';
import { escHtml } from '../utils/sql';

const GRAPH_OFFSET_X = 300;
const GRAPH_OFFSET_Y = 20;
const COLOR_BAND_W = 6;
const CARD_STYLE = 'rounded=1;whiteSpace=wrap;html=1;overflow=hidden;container=1;fillColor=#FFFFFF;strokeColor=#E0E0E0;strokeWidth=1;'
  + `align=left;verticalAlign=top;spacing=0;spacingLeft=${COLOR_BAND_W + 6};spacingRight=4;spacingTop=4;spacingBottom=0;`;
const TEXT_STYLE = 'text;html=1;align=left;verticalAlign=middle;resizable=0;points=[];autosize=0;strokeColor=none;fillColor=none;';
const EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;curved=1;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;'
  + 'exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;strokeColor=#999999;strokeWidth=0.8;endArrow=classic;endFill=1;';

/** One node card: an mxGraph `object` with metadata, drawn with a schema color band on its left edge. */
interface Card { label: string; tooltip: string; fullName: string; inputs: number; outputs: number; x: number; y: number; width: number; height: number; color: string }

/** XML attributes in the builder's `@_` notation, in the given key order. */
const attrs = (values: Record<string, string | number>): Record<string, string | number> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [`@_${key}`, value]));
const geometry = (x: number, y: number, width: number, height: number) => attrs({ x, y, width, height, as: 'geometry' });
const vertex = (id: string, value: string, style: string, geo: object, parent = '1') =>
  ({ ...attrs({ id, value, style, vertex: '1', parent }), mxGeometry: geo });

/** Constructs a rich HTML label for a node in the Draw.io diagram. */
function objectLabel(d: CustomNodeData, identifierCaseSensitive: boolean): string {
  const icon = TYPE_COLORS[d.objectType]?.icon || '■';
  const schemaLabel = d.externalType === 'file' ? 'FILE SOURCE'
    : d.externalType === 'db' ? 'CROSS-DATABASE'
    : identifierCaseSensitive ? d.schema : d.schema.toUpperCase();
  return (
    `<span style="color:#888888;font-size:14px;">${icon}</span>` +
    ` <span style="font-size:9px;color:#888888;">${d.inDegree}↓ ${d.outDegree}↑</span><br>` +
    `<b style="font-size:11px;color:#333333;">${escHtml(d.label)}</b><br>` +
    `<span style="font-size:9px;color:#999999;">${escHtml(schemaLabel)}</span>`
  );
}

/** The card of a schema-cluster node. */
function schemaCard(node: FlowNode<SchemaNodeData>, color: string, offsetX: number, offsetY: number): Card {
  const d = node.data;
  return {
    label: `<b style="font-size:12px;color:#333333;">${escHtml(d.schemaName)}</b><br><span style="font-size:9px;color:#999999;">${d.objectCount} OBJECTS</span>`,
    tooltip: `${d.schemaName}\nObjects: ${d.objectCount}`, fullName: d.schemaName, inputs: 0, outputs: 0,
    x: Math.round(node.position.x + offsetX), y: Math.round(node.position.y + offsetY), width: 160, height: 56, color,
  };
}

/** Builds the mxfile: a schema legend, one card per node and one edge per resolvable flow edge. Cell ids 0 and 1 are mxGraph's root and default parent. */
function buildDiagram(
  schemas: string[], colorMap: SchemaColorMap, externalSchemas: ReadonlySet<string>, identifierCaseSensitive: boolean,
  cards: ReadonlyArray<readonly [flowId: string, card: Card]>, edges: FlowEdge[],
): string {
  let nextId = 2;
  const newId = () => String(nextId++);
  const cells: object[] = [attrs({ id: '0' }), attrs({ id: '1', parent: '0' })];

  if (schemas.length > 0) {
    const rowH = 24, padX = 12, padY = 10, headerH = 28;
    const boxW = Math.max(180, Math.round(Math.max(...schemas.map(s => s.length)) * 6.5) + padX + 50);
    cells.push(vertex(newId(), '', 'rounded=1;whiteSpace=wrap;html=1;fillColor=#F8F8F8;strokeColor=#CCCCCC;strokeWidth=1;', geometry(10, 10, boxW, headerH + schemas.length * rowH + padY)));
    cells.push(vertex(newId(), '<b style="font-size:10px;color:#666666;letter-spacing:1px;">SCHEMAS</b>', TEXT_STYLE, geometry(padX + 10, padY + 10, boxW - 2 * padX, headerH)));
    schemas.forEach((schema, i) => {
      const y = padY + headerH + i * rowH + 10;
      const color = externalSchemas.has(schema) ? getExternalNodeColor() : getSchemaColorFromMap(schema, colorMap, identifierCaseSensitive);
      cells.push(vertex(newId(), '', `rounded=1;whiteSpace=wrap;html=1;fillColor=${color};strokeColor=none;arcSize=20;`, geometry(padX + 10, y, 16, 16)));
      cells.push(vertex(newId(), escHtml(schema), `${TEXT_STYLE}fontSize=11;fontColor=#333333;`, geometry(padX + 32, y, boxW - padX - 50, 16)));
    });
  }

  const cellIds = new Map<string, string>();
  const objects: object[] = [];
  const bands: object[] = [];
  for (const [flowId, card] of cards) {
    const id = newId();
    cellIds.set(flowId, id);
    objects.push({
      ...attrs({ id, label: card.label, tooltip: card.tooltip, fullName: card.fullName, inputCount: card.inputs, outputCount: card.outputs }),
      mxCell: { ...attrs({ style: CARD_STYLE, vertex: '1', parent: '1' }), mxGeometry: geometry(card.x, card.y, card.width, card.height) },
    });
    bands.push(vertex(newId(), '', `fillColor=${card.color};strokeColor=none;rounded=0;resizable=0;movable=0;deletable=0;editable=0;connectable=0;`,
      geometry(0, 0, COLOR_BAND_W, card.height), id));
  }

  const edgeCells: object[] = [];
  for (const edge of edges) {
    const source = cellIds.get(edge.source);
    const target = cellIds.get(edge.target);
    if (!source || !target) continue;
    const bidi = edge.id.includes('↔');
    edgeCells.push({
      ...attrs({ id: newId(), value: bidi ? '⇄' : '',
        style: bidi ? `${EDGE_STYLE}startArrow=classic;startFill=1;labelBackgroundColor=#ffffff;fontSize=14;fontStyle=1;fontColor=#999999;` : EDGE_STYLE,
        edge: '1', source, target, parent: '1' }),
      mxGeometry: attrs({ relative: '1', as: 'geometry' }),
    });
  }

  const root: Record<string, unknown> = { mxCell: [...cells, ...bands, ...edgeCells] };
  if (objects.length > 0) root.object = objects;
  const model = {
    ...attrs({ dx: 0, dy: 0, grid: 1, gridSize: 10, guides: 1, tooltips: 1, connect: 0, arrows: 1, fold: 1, page: 1, pageScale: 1, pageWidth: 1169, pageHeight: 827, background: '#ffffff' }),
    root,
  };
  const file = { mxfile: { ...attrs({ host: 'vscode-data-lineage', modified: new Date().toISOString(), type: 'device' }),
    diagram: { ...attrs({ name: 'Data Lineage', id: 'lineage' }), mxGraphModel: model } } };
  const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, indentBy: '  ', suppressEmptyNode: true, suppressBooleanAttributes: false });
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(file);
}

/** Converts a set of React Flow nodes and edges into a Draw.io compatible XML (mxfile) format. */
export function exportToDrawio(
  nodes: FlowNode<CustomNodeData>[],
  edges: FlowEdge[],
  schemas: string[],
  clusterNodes: FlowNode<SchemaNodeData>[] = [],
  identifierCaseSensitive = false,
): string {
  if (nodes.length === 0 && clusterNodes.length === 0) return '';

  let minX = Infinity, minY = Infinity;
  for (const { position } of [...nodes, ...clusterNodes]) { minX = Math.min(minX, position.x); minY = Math.min(minY, position.y); }
  const offsetX = GRAPH_OFFSET_X - Math.min(0, minX);
  const offsetY = GRAPH_OFFSET_Y - Math.min(0, minY);

  const realSchemas = new Set(nodes.filter(n => n.data.objectType !== 'external').map(n => n.data.schema));
  const externalSchemas = new Set(nodes.filter(n => n.data.objectType === 'external' && n.data.schema && !realSchemas.has(n.data.schema)).map(n => n.data.schema));
  const exportSchemas = Array.from(new Set([...schemas, ...realSchemas])).filter(s => !!s && s.trim().length > 0).sort();
  const colorMap = createSchemaColorMap(exportSchemas.filter(schema => !externalSchemas.has(schema)), true, identifierCaseSensitive);

  const cards = nodes.map(({ id, data: d, position }) => [id, {
    label: objectLabel(d, identifierCaseSensitive), tooltip: `${d.fullName}\nType: ${d.objectType}\nIn: ${d.inDegree}\nOut: ${d.outDegree}`,
    fullName: d.fullName, inputs: d.inDegree, outputs: d.outDegree,
    x: Math.round(position.x + offsetX), y: Math.round(position.y + offsetY), width: 180, height: 70,
    color: d.objectType === 'external' ? getExternalNodeColor() : getSchemaColorFromMap(d.schema, colorMap, identifierCaseSensitive),
  }] as const);
  const clusterCards = clusterNodes.map(node => [node.id, schemaCard(node, node.data.color, offsetX, offsetY)] as const);
  return buildDiagram(exportSchemas, colorMap, externalSchemas, identifierCaseSensitive, [...cards, ...clusterCards], edges);
}

/** Converts schema-overview cluster nodes into a Draw.io diagram showing schema-level dependencies. Schema colors use the checked source identifier policy; absent/false retains CI keys. */
export function exportSchemaOverviewToDrawio(
  nodes: FlowNode<SchemaNodeData>[],
  edges: FlowEdge[],
  schemas: string[],
  identifierCaseSensitive = false,
): string {
  if (nodes.length === 0) return '';

  const externalSchemas = new Set(nodes.filter(n => n.data.isExternalOnly || isExternalOnlyTypeBreakdown(n.data.typeBreakdown)).map(n => n.data.schemaName));
  const exportSchemas = Array.from(new Set([...schemas, ...nodes.map(n => n.data.schemaName)])).filter(Boolean).sort();
  const colorMap = createSchemaColorMap(exportSchemas.filter(schema => !externalSchemas.has(schema)), true, identifierCaseSensitive);
  const cards = nodes.map(node => [node.id, schemaCard(node,
    getSchemaDisplayColor(node.data.schemaName, colorMap, node.data.typeBreakdown, identifierCaseSensitive), GRAPH_OFFSET_X, GRAPH_OFFSET_Y)] as const);
  return buildDiagram(exportSchemas, colorMap, externalSchemas, identifierCaseSensitive, cards, edges);
}
