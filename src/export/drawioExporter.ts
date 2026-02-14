import { XMLBuilder } from 'fast-xml-parser';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../components/CustomNode';
import { TYPE_COLORS, hashString, SCHEMA_COLORS_LIGHT } from '../utils/schemaColors';

// ─── Constants ───────────────────────────────────────────────────────────────

const GRAPH_OFFSET_X = 300;
const NODE_W = 180;
const NODE_H = 70;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSchemaColor(schema: string): string {
  return SCHEMA_COLORS_LIGHT[Math.abs(hashString(schema)) % SCHEMA_COLORS_LIGHT.length];
}

/** Escape user-provided text for safe HTML embedding inside Draw.io labels. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Node HTML label (with left colored band via HTML table) ─────────────────

function buildLabel(d: CustomNodeData, schemaColor: string): string {
  const icon = TYPE_COLORS[d.objectType]?.icon || '■';
  return (
    '<table border="0" cellpadding="0" cellspacing="0" width="100%" height="100%">' +
    '<tr>' +
    `<td width="6" height="100%" style="background:${schemaColor};"></td>` +
    '<td valign="top" align="left" style="padding:6px 8px;">' +
    `<span style="color:#888888;font-size:14px;">${icon}</span>` +
    ` <span style="font-size:9px;color:#888888;">${d.inDegree}↓ ${d.outDegree}↑</span><br>` +
    `<b style="font-size:11px;color:#333333;">${esc(d.label)}</b><br>` +
    `<span style="font-size:9px;color:#999999;">${esc(d.schema.toUpperCase())}</span>` +
    '</td></tr></table>'
  );
}

// ─── Legend builder ──────────────────────────────────────────────────────────

function buildLegend(schemas: string[], startId: number): { cells: any[]; nextId: number } {
  const cells: any[] = [];
  let id = startId;

  if (schemas.length === 0) return { cells, nextId: id };

  const rowH = 24;
  const padX = 12;
  const padY = 10;
  const headerH = 28;
  const boxW = 180;
  const boxH = headerH + schemas.length * rowH + padY;

  // Background rectangle
  cells.push({
    '@_id': String(id++),
    '@_value': '',
    '@_style': 'rounded=1;whiteSpace=wrap;html=1;fillColor=#F8F8F8;strokeColor=#CCCCCC;strokeWidth=1;',
    '@_vertex': '1',
    '@_parent': '1',
    mxGeometry: { '@_x': '10', '@_y': '10', '@_width': String(boxW), '@_height': String(boxH), '@_as': 'geometry' },
  });

  // Title: "SCHEMAS"
  cells.push({
    '@_id': String(id++),
    '@_value': '<b style="font-size:10px;color:#666666;letter-spacing:1px;">SCHEMAS</b>',
    '@_style': 'text;html=1;align=left;verticalAlign=middle;resizable=0;points=[];autosize=0;strokeColor=none;fillColor=none;',
    '@_vertex': '1',
    '@_parent': '1',
    mxGeometry: { '@_x': String(padX + 10), '@_y': String(padY + 10), '@_width': String(boxW - 2 * padX), '@_height': String(headerH), '@_as': 'geometry' },
  });

  // One row per schema: colored square + label
  for (let i = 0; i < schemas.length; i++) {
    const y = padY + headerH + i * rowH + 10;
    const color = getSchemaColor(schemas[i]);

    // Colored square
    cells.push({
      '@_id': String(id++),
      '@_value': '',
      '@_style': `rounded=1;whiteSpace=wrap;html=1;fillColor=${color};strokeColor=none;arcSize=20;`,
      '@_vertex': '1',
      '@_parent': '1',
      mxGeometry: { '@_x': String(padX + 10), '@_y': String(y), '@_width': '16', '@_height': '16', '@_as': 'geometry' },
    });

    // Schema name text
    cells.push({
      '@_id': String(id++),
      '@_value': esc(schemas[i]),
      '@_style': 'text;html=1;align=left;verticalAlign=middle;resizable=0;points=[];autosize=0;strokeColor=none;fillColor=none;fontSize=11;fontColor=#333333;',
      '@_vertex': '1',
      '@_parent': '1',
      mxGeometry: { '@_x': String(padX + 32), '@_y': String(y), '@_width': String(boxW - padX - 50), '@_height': '16', '@_as': 'geometry' },
    });
  }

  return { cells, nextId: id };
}

// ─── Edge builder ────────────────────────────────────────────────────────────

function buildEdge(edge: FlowEdge, cellId: string, sourceId: string, targetId: string): any {
  const isBidi = edge.id.includes('↔');

  let style =
    'edgeStyle=orthogonalEdgeStyle;curved=1;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;' +
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

// ─── Main export ─────────────────────────────────────────────────────────────

export function exportToDrawio(
  nodes: FlowNode<CustomNodeData>[],
  edges: FlowEdge[],
  schemas: string[],
): string {
  if (nodes.length === 0) return '';

  const idMap = new Map<string, string>();
  let nextId = 2; // 0 and 1 are reserved base cells

  // Normalize positions so all coordinates are positive
  const minX = Math.min(...nodes.map(n => n.position.x));
  const minY = Math.min(...nodes.map(n => n.position.y));
  const offsetX = GRAPH_OFFSET_X - Math.min(0, minX);
  const offsetY = 20 - Math.min(0, minY);

  // 1. Legend
  const legend = buildLegend(schemas, nextId);
  nextId = legend.nextId;

  // 2. Nodes (as <object> elements for metadata)
  const nodeObjects: any[] = [];
  for (const node of nodes) {
    const d = node.data as CustomNodeData;
    const nodeId = String(nextId++);
    idMap.set(node.id, nodeId);

    const schemaColor = getSchemaColor(d.schema);

    nodeObjects.push({
      '@_id': nodeId,
      '@_label': buildLabel(d, schemaColor),
      '@_tooltip': `${d.fullName}\nType: ${d.objectType}\nIn: ${d.inDegree}\nOut: ${d.outDegree}`,
      '@_fullName': d.fullName,
      '@_inputCount': String(d.inDegree),
      '@_outputCount': String(d.outDegree),
      mxCell: {
        '@_style':
          'rounded=1;whiteSpace=wrap;html=1;overflow=hidden;' +
          'fillColor=#FFFFFF;strokeColor=#E0E0E0;strokeWidth=1;' +
          'align=left;verticalAlign=top;' +
          'spacing=0;spacingLeft=0;spacingRight=0;spacingTop=0;spacingBottom=0;',
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
  }

  // 3. Edges
  const edgeCells: any[] = [];
  for (const edge of edges) {
    const src = idMap.get(edge.source);
    const tgt = idMap.get(edge.target);
    if (!src || !tgt) continue;
    edgeCells.push(buildEdge(edge, String(nextId++), src, tgt));
  }

  // 4. Assemble XML
  const baseCells = [
    { '@_id': '0' },
    { '@_id': '1', '@_parent': '0' },
  ];

  const data = {
    mxfile: {
      '@_host': 'vscode-data-lineage',
      '@_modified': new Date().toISOString(),
      '@_type': 'device',
      diagram: {
        '@_name': 'Data Lineage',
        '@_id': 'lineage',
        mxGraphModel: {
          '@_dx': '0',
          '@_dy': '0',
          '@_grid': '1',
          '@_gridSize': '10',
          '@_guides': '1',
          '@_tooltips': '1',
          '@_connect': '0',
          '@_arrows': '1',
          '@_fold': '1',
          '@_page': '1',
          '@_pageScale': '1',
          '@_pageWidth': '1169',
          '@_pageHeight': '827',
          '@_background': '#ffffff',
          root: {
            mxCell: [...baseCells, ...legend.cells, ...edgeCells],
            object: nodeObjects,
          },
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
