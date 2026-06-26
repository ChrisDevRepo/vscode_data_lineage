/**
 * Unit tests for the Draw.io XML export functions.
 *
 * Tests the pure export logic in src/export/drawioExporter.ts against synthetic
 * React Flow node/edge inputs — no VS Code or webview required.
 */

import { printSummary, resetCounters, assert, assertEq } from './helpers/testUtils';
import { exportToDrawio, exportSchemaOverviewToDrawio } from '../../src/export/drawioExporter';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../../src/components/CustomNode';
import type { SchemaNodeData } from '../../src/engine/types';

console.log('Draw.io Exporter Tests');
console.log('='.repeat(40));
resetCounters();

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

// ── Test 1: empty nodes returns empty string ─────────────────────────────────
{
  const result = exportToDrawio([], [], []);
  assertEq(result, '', 'empty node list returns empty string');
}

// ── Test 2: structural XML frame ─────────────────────────────────────────────
{
  const nodes = [makeNode('n1', 'Orders', 'Sales', 100, 50)];
  const xml = exportToDrawio(nodes, [], ['Sales']);
  assert(xml.startsWith('<?xml version="1.0"'), 'output starts with XML declaration');
  assert(xml.includes('<mxfile'), 'output contains mxfile element');
  assert(xml.includes('<mxGraphModel'), 'output contains mxGraphModel element');
  assert(xml.includes('<root>'), 'output contains root element');
}

// ── Test 3: one node produces the correct mxCell / object count ───────────────
{
  const nodes = [makeNode('n1', 'Orders', 'Sales', 100, 50)];
  const xml = exportToDrawio(nodes, [], ['Sales']);
  // Each node becomes one <object> element and one color-band mxCell child.
  // The root also always has two base mxCell entries (id=0, id=1).
  assert(xml.includes('object'), 'output contains object wrapper for the node');
  assert(xml.includes('mxCell'), 'output contains mxCell entries');
  // 1 vertex node = 1 object element
  assertEq(countOccurrences(xml, '<object'), 1, 'exactly one object element for one node');
}

// ── Test 4: node label appears in the output ─────────────────────────────────
{
  const nodes = [makeNode('n1', 'OrderDetails', 'Sales', 0, 0)];
  const xml = exportToDrawio(nodes, [], []);
  assert(xml.includes('OrderDetails'), 'node label is present in the XML output');
}

// ── Test 5: multiple nodes — correct object count ─────────────────────────────
{
  const nodes = [
    makeNode('n1', 'Customer', 'dbo', 0, 0),
    makeNode('n2', 'Order', 'dbo', 200, 0),
    makeNode('n3', 'Product', 'Sales', 400, 0),
  ];
  const xml = exportToDrawio(nodes, [], ['dbo', 'Sales']);
  assertEq(countOccurrences(xml, '<object'), 3, 'three nodes produce three object elements');
}

// ── Test 6: edge produces an edge mxCell with source/target wired ─────────────
{
  const nodes = [
    makeNode('n1', 'Customer', 'dbo', 0, 0),
    makeNode('n2', 'Order', 'dbo', 200, 0),
  ];
  const edges = [makeEdge('e1', 'n1', 'n2')];
  const xml = exportToDrawio(nodes, edges, ['dbo']);
  assert(xml.includes('edge='), 'output contains an edge attribute');
  // source and target attributes must reference numeric IDs (not original node ids)
  assert(xml.includes('source='), 'edge cell has a source attribute');
  assert(xml.includes('target='), 'edge cell has a target attribute');
}

// ── Test 7: edge count matches ────────────────────────────────────────────────
{
  const nodes = [
    makeNode('n1', 'A', 'dbo', 0, 0),
    makeNode('n2', 'B', 'dbo', 100, 0),
    makeNode('n3', 'C', 'dbo', 200, 0),
  ];
  const edges = [makeEdge('e1', 'n1', 'n2'), makeEdge('e2', 'n2', 'n3')];
  const xml = exportToDrawio(nodes, edges, ['dbo']);
  assertEq(countOccurrences(xml, 'edge='), 2, 'two edges produce two edge= attributes');
}

// ── Test 8: multi-schema nodes — each schema name appears in legend ───────────
{
  const nodes = [
    makeNode('n1', 'FactSales', 'fact', 0, 0),
    makeNode('n2', 'DimProduct', 'dim', 200, 0),
  ];
  const xml = exportToDrawio(nodes, [], ['fact', 'dim']);
  assert(xml.includes('fact'), 'first schema name appears in the output');
  assert(xml.includes('dim'), 'second schema name appears in the output');
}

// ── Test 9: bidirectional edge carries ⇄ label ──────────────────────────────
{
  const nodes = [
    makeNode('n1', 'A', 'dbo', 0, 0),
    makeNode('n2', 'B', 'dbo', 100, 0),
  ];
  // A bidirectional edge uses the ↔ marker in its id (mirroring buildFlowEdges convention)
  const bidiEdge: FlowEdge = { id: 'n1↔n2', source: 'n1', target: 'n2' };
  const xml = exportToDrawio(nodes, [bidiEdge], ['dbo']);
  assert(xml.includes('⇄'), 'bidirectional edge carries the ⇄ label');
  assert(xml.includes('startArrow=classic'), 'bidirectional edge has startArrow style');
}

// ── Test 10: edge referencing unknown node ids is silently skipped ────────────
{
  const nodes = [makeNode('n1', 'A', 'dbo', 0, 0)];
  const badEdge: FlowEdge = { id: 'e-bad', source: 'n1', target: 'ghost' };
  const xml = exportToDrawio(nodes, [badEdge], ['dbo']);
  // No edge should be emitted (ghost has no mapping)
  assertEq(countOccurrences(xml, 'edge='), 0, 'edge with unknown target id is silently skipped');
}

// ── Test 11: full-name attribute is embedded in node object ──────────────────
{
  const nodes = [makeNode('n1', 'Orders', 'Sales', 0, 0)];
  const xml = exportToDrawio(nodes, [], ['Sales']);
  assert(xml.includes('Sales.Orders'), 'fullName attribute is embedded in the node object');
}

// ── Test 12: exportSchemaOverviewToDrawio — empty returns empty ───────────────
{
  const result = exportSchemaOverviewToDrawio([], [], []);
  assertEq(result, '', 'schema overview export returns empty string for no nodes');
}

// ── Test 13: exportSchemaOverviewToDrawio — schema node produces object ───────
{
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
  assert(xml.includes('<mxGraphModel'), 'schema overview output contains mxGraphModel');
  assert(xml.includes('Sales'), 'schema name appears in schema-overview XML');
  assertEq(countOccurrences(xml, '<object'), 1, 'one schema node produces one object element');
}

// ── Test 14: exportSchemaOverviewToDrawio — edge between schemas ──────────────
{
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
  assertEq(countOccurrences(xml, '<object'), 2, 'two schema nodes produce two object elements');
  assertEq(countOccurrences(xml, 'edge='), 1, 'one schema edge produces one edge= attribute');
}

printSummary('Draw.io Exporter');
