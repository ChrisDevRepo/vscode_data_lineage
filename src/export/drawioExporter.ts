import { XMLBuilder } from 'fast-xml-parser';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../components/CustomNode';
import type { SchemaNodeData } from '../engine/types';
import { TYPE_COLORS, createSchemaColorMap, getSchemaColorFromMap, getExternalNodeColor, getSchemaDisplayColor, isExternalOnlyTypeBreakdown, type SchemaColorMap } from '../utils/schemaColors';
import { escHtml } from '../utils/sql';

/**
 * Geometry data for an mxGraph cell.
 */
interface MxGeometry {
  '@_x'?: string;
  '@_y'?: string;
  '@_width'?: string;
  '@_height'?: string;
  '@_as': string;
  '@_relative'?: string;
}

/**
 * Represents a standard cell in an mxGraph XML structure.
 */
interface MxCell {
  '@_id': string;
  '@_value'?: string;
  '@_style'?: string;
  '@_vertex'?: string;
  '@_edge'?: string;
  '@_source'?: string;
  '@_target'?: string;
  '@_parent'?: string;
  mxGeometry?: MxGeometry;
}

/**
 * Represents an object cell (vertex with metadata) in an mxGraph XML structure.
 * Used for storing additional attributes like tooltips and full names.
 */
interface MxObject {
  '@_id': string;
  '@_label': string;
  '@_tooltip': string;
  '@_fullName': string;
  '@_inputCount': string;
  '@_outputCount': string;
  mxCell: {
    '@_style': string;
    '@_vertex': string;
    '@_parent': string;
    mxGeometry: MxGeometry;
  };
}

const GRAPH_OFFSET_X = 300;
const NODE_W = 180;
const NODE_H = 70;
const COLOR_BAND_W = 6;

/**
 * Constructs a rich HTML label for a node in the Draw.io diagram.
 *
 * @param d - The custom data associated with the lineage node.
 * @returns A string containing HTML for the node label.
 */
function buildLabel(d: CustomNodeData): string {
  const icon = TYPE_COLORS[d.objectType]?.icon || '■';
  const schemaLabel = d.externalType === 'file' ? 'FILE SOURCE'
    : d.externalType === 'db' ? 'CROSS-DATABASE'
    : d.schema.toUpperCase();
  return (
    `<span style="color:#888888;font-size:14px;">${icon}</span>` +
    ` <span style="font-size:9px;color:#888888;">${d.inDegree}↓ ${d.outDegree}↑</span><br>` +
    `<b style="font-size:11px;color:#333333;">${escHtml(d.label)}</b><br>` +
    `<span style="font-size:9px;color:#999999;">${escHtml(schemaLabel)}</span>`
  );
}

/**
 * Generates the legend section of the Draw.io diagram, mapping schema names to their assigned colors.
 *
 * @param schemas - List of unique schema names in the graph.
 * @param colorMap - Display colors keyed by schema name.
 * @param startId - The starting ID for XML elements in this section.
 * @param externalSchemas - Schema names rendered with the external-node color.
 * @returns An object containing the generated cells and the next available ID.
 */
function buildLegend(schemas: string[], colorMap: SchemaColorMap, startId: number, externalSchemas: ReadonlySet<string> = new Set()): { cells: MxCell[]; nextId: number } {
  const cells: MxCell[] = [];
  let id = startId;

  if (schemas.length === 0) return { cells, nextId: id };

  const rowH = 24;
  const padX = 12;
  const padY = 10;
  const headerH = 28;
  const maxSchemaLen = Math.max(...schemas.map(s => s.length));
  const boxW = Math.max(180, Math.round(maxSchemaLen * 6.5) + padX + 50);
  const boxH = headerH + schemas.length * rowH + padY;

  cells.push({
    '@_id': String(id++),
    '@_value': '',
    '@_style': 'rounded=1;whiteSpace=wrap;html=1;fillColor=#F8F8F8;strokeColor=#CCCCCC;strokeWidth=1;',
    '@_vertex': '1',
    '@_parent': '1',
    mxGeometry: { '@_x': '10', '@_y': '10', '@_width': String(boxW), '@_height': String(boxH), '@_as': 'geometry' },
  });

  cells.push({
    '@_id': String(id++),
    '@_value': '<b style="font-size:10px;color:#666666;letter-spacing:1px;">SCHEMAS</b>',
    '@_style': 'text;html=1;align=left;verticalAlign=middle;resizable=0;points=[];autosize=0;strokeColor=none;fillColor=none;',
    '@_vertex': '1',
    '@_parent': '1',
    mxGeometry: { '@_x': String(padX + 10), '@_y': String(padY + 10), '@_width': String(boxW - 2 * padX), '@_height': String(headerH), '@_as': 'geometry' },
  });

  for (let i = 0; i < schemas.length; i++) {
    const y = padY + headerH + i * rowH + 10;
    const color = externalSchemas.has(schemas[i]) ? getExternalNodeColor() : getSchemaColorFromMap(schemas[i], colorMap);

    cells.push({
      '@_id': String(id++),
      '@_value': '',
      '@_style': `rounded=1;whiteSpace=wrap;html=1;fillColor=${color};strokeColor=none;arcSize=20;`,
      '@_vertex': '1',
      '@_parent': '1',
      mxGeometry: { '@_x': String(padX + 10), '@_y': String(y), '@_width': '16', '@_height': '16', '@_as': 'geometry' },
    });

    cells.push({
      '@_id': String(id++),
      '@_value': escHtml(schemas[i]),
      '@_style': 'text;html=1;align=left;verticalAlign=middle;resizable=0;points=[];autosize=0;strokeColor=none;fillColor=none;fontSize=11;fontColor=#333333;',
      '@_vertex': '1',
      '@_parent': '1',
      mxGeometry: { '@_x': String(padX + 32), '@_y': String(y), '@_width': String(boxW - padX - 50), '@_height': '16', '@_as': 'geometry' },
    });
  }

  return { cells, nextId: id };
}

/**
 * Constructs an mxGraph edge cell.
 *
 * @param edge - The React Flow edge data.
 * @param cellId - Unique ID for the XML cell.
 * @param sourceId - ID of the source node.
 * @param targetId - ID of the target node.
 * @returns A compiled `MxCell` representing the edge.
 */
function buildEdge(edge: FlowEdge, cellId: string, sourceId: string, targetId: string): MxCell {
  const isBidi = edge.id.includes('↔');

  let style =
    'edgeStyle=orthogonalEdgeStyle;curved=1;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;' +
    'exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;' +
    'strokeColor=#999999;strokeWidth=0.8;endArrow=classic;endFill=1;';

  if (isBidi) {
    style += 'startArrow=classic;startFill=1;';
  }

  return {
    '@_id': cellId,
    '@_value': isBidi ? '⇄' : '',
    '@_style': isBidi
      ? style + 'labelBackgroundColor=#ffffff;fontSize=14;fontStyle=1;fontColor=#999999;'
      : style,
    '@_edge': '1',
    '@_source': sourceId,
    '@_target': targetId,
    '@_parent': '1',
    mxGeometry: { '@_relative': '1', '@_as': 'geometry' },
  };
}

/**
 * Converts a set of React Flow nodes and edges into a Draw.io compatible XML (mxfile) format.
 *
 * The output includes:
 * - A persistent schema legend.
 * - Styled vertices with custom HTML labels and color bands.
 * - Orthogonal edges with bidirectional support.
 * - Embedded metadata (tooltips, full names) using `<object>` containers.
 *
 * @param nodes - Array of nodes from the graph state.
 * @param edges - Array of edges from the graph state.
 * @param schemas - List of schema names for the legend.
 * @param clusterNodes - Optional schema-overview nodes included in the export.
 * @returns A full XML string ready for import into Draw.io.
 */
export function exportToDrawio(
  nodes: FlowNode<CustomNodeData>[],
  edges: FlowEdge[],
  schemas: string[],
  clusterNodes?: FlowNode<SchemaNodeData>[],
): string {
  if (nodes.length === 0 && (!clusterNodes || clusterNodes.length === 0)) return '';

  const idMap = new Map<string, string>();
  let nextId = 2; // 0 and 1 are reserved base cells

  const minX = Math.min(...nodes.map(n => n.position.x));
  const minY = Math.min(...nodes.map(n => n.position.y));
  const offsetX = GRAPH_OFFSET_X - Math.min(0, minX);
  const offsetY = 20 - Math.min(0, minY);

  const realNodeSchemas = nodes
    .map(n => n.data)
    .filter(d => d.objectType !== 'external')
    .map(d => d.schema);
  const realSchemaSet = new Set(realNodeSchemas);
  const externalSchemas = new Set(nodes
    .map(n => n.data)
    .filter(d => d.objectType === 'external' && d.schema && !realSchemaSet.has(d.schema))
    .map(d => d.schema));
  const exportSchemas = Array.from(new Set([...schemas, ...realNodeSchemas]))
    .filter(s => !!s && s.trim().length > 0)
    .sort();
  const schemaColorMap = createSchemaColorMap(exportSchemas.filter(schema => !externalSchemas.has(schema)), true);

  const legend = buildLegend(exportSchemas, schemaColorMap, nextId, externalSchemas);
  nextId = legend.nextId;

  const nodeObjects: MxObject[] = [];
  const colorBandCells: MxCell[] = [];
  for (const node of nodes) {
    const d = node.data;
    const nodeId = String(nextId++);
    idMap.set(node.id, nodeId);

    const isExternal = d.objectType === 'external';
    const schemaColor = isExternal ? getExternalNodeColor() : getSchemaColorFromMap(d.schema, schemaColorMap);

    nodeObjects.push({
      '@_id': nodeId,
      '@_label': buildLabel(d),
      '@_tooltip': `${d.fullName}\nType: ${d.objectType}\nIn: ${d.inDegree}\nOut: ${d.outDegree}`,
      '@_fullName': d.fullName,
      '@_inputCount': String(d.inDegree),
      '@_outputCount': String(d.outDegree),
      mxCell: {
        '@_style':
          'rounded=1;whiteSpace=wrap;html=1;overflow=hidden;container=1;' +
          'fillColor=#FFFFFF;strokeColor=#E0E0E0;strokeWidth=1;' +
          'align=left;verticalAlign=top;' +
          `spacing=0;spacingLeft=${COLOR_BAND_W + 6};spacingRight=4;spacingTop=4;spacingBottom=0;`,
        '@_vertex': '1',
        '@_parent': '1',
        mxGeometry: {
          '@_x': String(Math.round(node.position.x + offsetX)),
          '@_y': String(Math.round(node.position.y + offsetY)),
          '@_width': String(NODE_W),
          '@_height': String(NODE_H),
          '@_as': 'geometry',
        },
      },
    });

    colorBandCells.push({
      '@_id': String(nextId++),
      '@_value': '',
      '@_style':
        `fillColor=${schemaColor};strokeColor=none;` +
        'rounded=0;resizable=0;movable=0;deletable=0;editable=0;connectable=0;',
      '@_vertex': '1',
      '@_parent': nodeId,
      mxGeometry: {
        '@_x': '0',
        '@_y': '0',
        '@_width': String(COLOR_BAND_W),
        '@_height': String(NODE_H),
        '@_as': 'geometry',
      },
    });
  }

  const clusterObjects: MxObject[] = [];
  const clusterBandCells: MxCell[] = [];
  for (const node of clusterNodes ?? []) {
    const nodeId = String(nextId++);
    const bandId = String(nextId++);
    idMap.set(node.id, nodeId);
    const { obj, band } = buildSchemaClusterObject(node, nodeId, bandId, node.data.color);
    clusterObjects.push(obj);
    clusterBandCells.push(band);
  }

  const edgeCells: MxCell[] = [];
  for (const edge of edges) {
    const src = idMap.get(edge.source);
    const tgt = idMap.get(edge.target);
    if (!src || !tgt) continue;
    edgeCells.push(buildEdge(edge, String(nextId++), src, tgt));
  }

  const baseCells: MxCell[] = [
    { '@_id': '0' },
    { '@_id': '1', '@_parent': '0' },
  ];
  return buildMxFile(
    [...baseCells, ...legend.cells, ...colorBandCells, ...clusterBandCells, ...edgeCells],
    [...nodeObjects, ...clusterObjects],
  );
}

function buildMxFile(cells: MxCell[], objects: MxObject[]): string {
  const root: Record<string, unknown> = { mxCell: cells };
  if (objects.length > 0) root['object'] = objects;

  const data = {
    mxfile: {
      '@_host': 'vscode-data-lineage',
      '@_modified': new Date().toISOString(),
      '@_type': 'device',
      diagram: {
        '@_name': 'Data Lineage',
        '@_id': 'lineage',
        mxGraphModel: {
          '@_dx': '0', '@_dy': '0', '@_grid': '1', '@_gridSize': '10',
          '@_guides': '1', '@_tooltips': '1', '@_connect': '0', '@_arrows': '1',
          '@_fold': '1', '@_page': '1', '@_pageScale': '1',
          '@_pageWidth': '1169', '@_pageHeight': '827', '@_background': '#ffffff',
          root,
        },
      },
    },
  };

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
    suppressBooleanAttributes: false,
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(data);
}

function buildSchemaClusterObject(
  node: FlowNode<SchemaNodeData>,
  nodeId: string,
  bandId: string,
  color: string,
): { obj: MxObject; band: MxCell } {
  const d = node.data;
  const label =
    `<b style="font-size:12px;color:#333333;">${escHtml(d.schemaName)}</b><br>` +
    `<span style="font-size:9px;color:#999999;">${d.objectCount} OBJECTS</span>`;

  const obj: MxObject = {
    '@_id': nodeId,
    '@_label': label,
    '@_tooltip': `${d.schemaName}\nObjects: ${d.objectCount}`,
    '@_fullName': d.schemaName,
    '@_inputCount': '0',
    '@_outputCount': '0',
    mxCell: {
      '@_style':
        'rounded=1;whiteSpace=wrap;html=1;overflow=hidden;container=1;' +
        'fillColor=#FFFFFF;strokeColor=#E0E0E0;strokeWidth=1;' +
        'align=left;verticalAlign=top;' +
        `spacing=0;spacingLeft=${COLOR_BAND_W + 6};spacingRight=4;spacingTop=4;spacingBottom=0;`,
      '@_vertex': '1',
      '@_parent': '1',
      mxGeometry: {
        '@_x': String(Math.round(node.position.x + GRAPH_OFFSET_X)),
        '@_y': String(Math.round(node.position.y + 20)),
        '@_width': '160',
        '@_height': '56',
        '@_as': 'geometry',
      },
    },
  };

  const band: MxCell = {
    '@_id': bandId,
    '@_value': '',
    '@_style': `fillColor=${color};strokeColor=none;rounded=0;resizable=0;movable=0;deletable=0;editable=0;connectable=0;`,
    '@_vertex': '1',
    '@_parent': nodeId,
    mxGeometry: { '@_x': '0', '@_y': '0', '@_width': String(COLOR_BAND_W), '@_height': '56', '@_as': 'geometry' },
  };

  return { obj, band };
}

/**
 * Converts schema-overview cluster nodes into a Draw.io diagram showing schema-level dependencies.
 *
 * @param nodes - Schema cluster nodes from the schemaOverview display mode.
 * @param edges - Aggregated edges between schema clusters.
 * @param schemas - Schema names for the legend.
 *
 * @returns Draw.io XML document, or an empty string when no schema nodes exist.
 */
export function exportSchemaOverviewToDrawio(
  nodes: FlowNode<SchemaNodeData>[],
  edges: FlowEdge[],
  schemas: string[],
): string {
  if (nodes.length === 0) return '';

  let nextId = 2;
  const idMap = new Map<string, string>();

  const externalSchemas = new Set(nodes
    .filter(n => n.data.isExternalOnly || isExternalOnlyTypeBreakdown(n.data.typeBreakdown))
    .map(n => n.data.schemaName));
  const exportSchemas = Array.from(
    new Set([...schemas, ...nodes.map(n => n.data.schemaName)])
  ).filter(Boolean).sort();
  const realSchemas = exportSchemas.filter(schema => !externalSchemas.has(schema));
  const colorMap = createSchemaColorMap(realSchemas, true);
  const legend = buildLegend(exportSchemas, colorMap, nextId, externalSchemas);
  nextId = legend.nextId;

  const schemaObjects: MxObject[] = [];
  const bandCells: MxCell[] = [];
  for (const node of nodes) {
    const nodeId = String(nextId++);
    const bandId = String(nextId++);
    idMap.set(node.id, nodeId);
    const color = getSchemaDisplayColor(node.data.schemaName, colorMap, node.data.typeBreakdown);
    const { obj, band } = buildSchemaClusterObject(node, nodeId, bandId, color);
    schemaObjects.push(obj);
    bandCells.push(band);
  }

  const edgeCells: MxCell[] = [];
  for (const edge of edges) {
    const src = idMap.get(edge.source);
    const tgt = idMap.get(edge.target);
    if (!src || !tgt) continue;
    edgeCells.push(buildEdge(edge, String(nextId++), src, tgt));
  }

  const baseCells: MxCell[] = [
    { '@_id': '0' },
    { '@_id': '1', '@_parent': '0' },
  ];
  return buildMxFile([...baseCells, ...legend.cells, ...bandCells, ...edgeCells], schemaObjects);
}
