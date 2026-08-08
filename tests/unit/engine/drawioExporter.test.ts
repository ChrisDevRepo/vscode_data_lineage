/**
 * Unit tests for the Draw.io XML export functions.
 *
 * Tests the pure export logic in src/export/drawioExporter.ts against synthetic
 * React Flow node/edge inputs — no VS Code or webview required.
 */

import { describe, it, expect } from 'vitest';
import { exportToDrawio, exportSchemaOverviewToDrawio } from '../../../src/export/drawioExporter';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../../../src/components/CustomNode';
import type { SchemaNodeData } from '../../../src/engine/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(id: string, label: string, schema: string, x = 0, y = 0): FlowNode<CustomNodeData> {
  return {
    id,
    type: 'custom',
    position: { x, y },
    data: {
      label,
      schema,
      fullName: `${schema}.${label}`,
      objectType: 'table',
      inDegree: 0,
      outDegree: 0,
    },
  };
}

function makeEdge(id: string, source: string, target: string): FlowEdge {
  return { id, source, target };
}

/** Count occurrences of a substring in a string. */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    n++;
    pos += needle.length;
  }
  return n;
}

describe('Draw.io Exporter', () => {
  it('empty nodes returns empty string', () => {
    const result = exportToDrawio([], [], []);
    expect(result, 'empty node list returns empty string').toBe('');
  });

  it('structural XML frame', () => {
    const nodes = [makeNode('n1', 'Orders', 'Sales', 100, 50)];
    const xml = exportToDrawio(nodes, [], ['Sales']);
    expect(xml.startsWith('<?xml version="1.0"'), 'output starts with XML declaration').toBe(true);
    expect(xml.includes('<mxfile'), 'output contains mxfile element').toBe(true);
    expect(xml.includes('<mxGraphModel'), 'output contains mxGraphModel element').toBe(true);
    expect(xml.includes('<root>'), 'output contains root element').toBe(true);
  });

  it('one node produces the correct mxCell / object count', () => {
    const nodes = [makeNode('n1', 'Orders', 'Sales', 100, 50)];
    const xml = exportToDrawio(nodes, [], ['Sales']);
    // Each node becomes one <object> element and one color-band mxCell child.
    // The root also always has two base mxCell entries (id=0, id=1).
    expect(xml.includes('object'), 'output contains object wrapper for the node').toBe(true);
    expect(xml.includes('mxCell'), 'output contains mxCell entries').toBe(true);
    // 1 vertex node = 1 object element
    expect(countOccurrences(xml, '<object'), 'exactly one object element for one node').toBe(1);
  });

  it('node label appears in the output', () => {
    const nodes = [makeNode('n1', 'OrderDetails', 'Sales', 0, 0)];
    const xml = exportToDrawio(nodes, [], []);
    expect(xml.includes('OrderDetails'), 'node label is present in the XML output').toBe(true);
  });

  it('multiple nodes — correct object count', () => {
    const nodes = [
      makeNode('n1', 'Customer', 'dbo', 0, 0),
      makeNode('n2', 'Order', 'dbo', 200, 0),
      makeNode('n3', 'Product', 'Sales', 400, 0),
    ];
    const xml = exportToDrawio(nodes, [], ['dbo', 'Sales']);
    expect(countOccurrences(xml, '<object'), 'three nodes produce three object elements').toBe(3);
  });

  it('edge produces an edge mxCell with source/target wired', () => {
    const nodes = [
      makeNode('n1', 'Customer', 'dbo', 0, 0),
      makeNode('n2', 'Order', 'dbo', 200, 0),
    ];
    const edges = [makeEdge('e1', 'n1', 'n2')];
    const xml = exportToDrawio(nodes, edges, ['dbo']);
    expect(xml.includes('edge='), 'output contains an edge attribute').toBe(true);
    // source and target attributes must reference numeric IDs (not original node ids)
    expect(xml.includes('source='), 'edge cell has a source attribute').toBe(true);
    expect(xml.includes('target='), 'edge cell has a target attribute').toBe(true);
  });

  it('edge count matches', () => {
    const nodes = [
      makeNode('n1', 'A', 'dbo', 0, 0),
      makeNode('n2', 'B', 'dbo', 100, 0),
      makeNode('n3', 'C', 'dbo', 200, 0),
    ];
    const edges = [makeEdge('e1', 'n1', 'n2'), makeEdge('e2', 'n2', 'n3')];
    const xml = exportToDrawio(nodes, edges, ['dbo']);
    expect(countOccurrences(xml, 'edge='), 'two edges produce two edge= attributes').toBe(2);
  });

  it('multi-schema nodes — each schema name appears in legend', () => {
    const nodes = [
      makeNode('n1', 'FactSales', 'fact', 0, 0),
      makeNode('n2', 'DimProduct', 'dim', 200, 0),
    ];
    const xml = exportToDrawio(nodes, [], ['fact', 'dim']);
    expect(xml.includes('fact'), 'first schema name appears in the output').toBe(true);
    expect(xml.includes('dim'), 'second schema name appears in the output').toBe(true);
  });

  it('bidirectional edge carries ⇄ label', () => {
    const nodes = [
      makeNode('n1', 'A', 'dbo', 0, 0),
      makeNode('n2', 'B', 'dbo', 100, 0),
    ];
    // A bidirectional edge uses the ↔ marker in its id (mirroring buildFlowEdges convention)
    const bidiEdge: FlowEdge = { id: 'n1↔n2', source: 'n1', target: 'n2' };
    const xml = exportToDrawio(nodes, [bidiEdge], ['dbo']);
    expect(xml.includes('⇄'), 'bidirectional edge carries the ⇄ label').toBe(true);
    expect(xml.includes('startArrow=classic'), 'bidirectional edge has startArrow style').toBe(true);
  });

  it('edge referencing unknown node ids is silently skipped', () => {
    const nodes = [makeNode('n1', 'A', 'dbo', 0, 0)];
    const badEdge: FlowEdge = { id: 'e-bad', source: 'n1', target: 'ghost' };
    const xml = exportToDrawio(nodes, [badEdge], ['dbo']);
    // No edge should be emitted (ghost has no mapping)
    expect(countOccurrences(xml, 'edge='), 'edge with unknown target id is silently skipped').toBe(0);
  });

  it('full-name attribute is embedded in node object', () => {
    const nodes = [makeNode('n1', 'Orders', 'Sales', 0, 0)];
    const xml = exportToDrawio(nodes, [], ['Sales']);
    expect(xml.includes('Sales.Orders'), 'fullName attribute is embedded in the node object').toBe(true);
  });

  it('exportSchemaOverviewToDrawio — empty returns empty', () => {
    const result = exportSchemaOverviewToDrawio([], [], []);
    expect(result, 'schema overview export returns empty string for no nodes').toBe('');
  });

  it('exportSchemaOverviewToDrawio — schema node produces object', () => {
    const schemaNode: FlowNode<SchemaNodeData> = {
      id: 'schema-Sales',
      type: 'schemaNode',
      position: { x: 100, y: 100 },
      data: {
        schemaName: 'Sales',
        objectCount: 5,
        typeBreakdown: { table: 3, view: 2, procedure: 0, function: 0, external: 0 },
        isExternalOnly: false,
        color: '#4E79A7',
      },
    };
    const xml = exportSchemaOverviewToDrawio([schemaNode], [], ['Sales']);
    expect(xml.includes('<mxGraphModel'), 'schema overview output contains mxGraphModel').toBe(true);
    expect(xml.includes('Sales'), 'schema name appears in schema-overview XML').toBe(true);
    expect(countOccurrences(xml, '<object'), 'one schema node produces one object element').toBe(1);
  });

  it('exportSchemaOverviewToDrawio — edge between schemas', () => {
    const nodeA: FlowNode<SchemaNodeData> = {
      id: 'schema-dbo',
      type: 'schemaNode',
      position: { x: 0, y: 0 },
      data: {
        schemaName: 'dbo',
        objectCount: 10,
        typeBreakdown: { table: 10, view: 0, procedure: 0, function: 0, external: 0 },
        isExternalOnly: false,
        color: '#4E79A7',
      },
    };
    const nodeB: FlowNode<SchemaNodeData> = {
      id: 'schema-Sales',
      type: 'schemaNode',
      position: { x: 200, y: 0 },
      data: {
        schemaName: 'Sales',
        objectCount: 3,
        typeBreakdown: { table: 3, view: 0, procedure: 0, function: 0, external: 0 },
        isExternalOnly: false,
        color: '#59A14F',
      },
    };
    const schemaEdge: FlowEdge = { id: 'se1', source: 'schema-dbo', target: 'schema-Sales' };
    const xml = exportSchemaOverviewToDrawio([nodeA, nodeB], [schemaEdge], ['dbo', 'Sales']);
    expect(countOccurrences(xml, '<object'), 'two schema nodes produce two object elements').toBe(2);
    expect(countOccurrences(xml, 'edge='), 'one schema edge produces one edge= attribute').toBe(1);
  });

  it('exportToDrawio — mixed object/schema-expanded view', () => {
    const object = makeNode('sales.orders', 'Orders', 'Sales', 0, 0);
    const schemaNode: FlowNode<SchemaNodeData> = {
      id: '__expandedschemaviewcluster__hr',
      type: 'schemaNode',
      position: { x: 240, y: 0 },
      data: {
        schemaName: 'HR',
        objectCount: 4,
        typeBreakdown: { table: 4, view: 0, procedure: 0, function: 0, external: 0 },
        isExternalOnly: false,
        color: '#59A14F',
      },
    };
    const edge: FlowEdge = { id: 'mixed-edge', source: 'sales.orders', target: '__expandedschemaviewcluster__hr' };
    const xml = exportToDrawio([object], [edge], ['Sales', 'HR'], [schemaNode]);

    expect(xml.includes('Orders'), 'mixed export includes object node').toBe(true);
    expect(xml.includes('HR'), 'mixed export includes collapsed schema cluster').toBe(true);
    expect(countOccurrences(xml, '<object'), 'mixed export produces object and schema-cluster objects').toBe(2);
    expect(countOccurrences(xml, 'edge='), 'mixed export includes edge to visible schema cluster').toBe(1);
    expect(xml.includes('rounded=1'), 'draw.io node and schema styles use the valid rounded property').toBe(true);
    expect(xml.includes('rounded-sm='), 'Tailwind utility names never leak into draw.io style properties').toBe(false);
  });
});
