/**
 * Unit tests for the template renderer.
 *
 * Covers:
 *   renderMetadataBand — SP-only Loading Pattern line (In/Out rows removed)
 *   shouldEmitLoadingPattern — SP-only gate
 */

import { assert, printSummary } from './helpers/testUtils';
import {
  renderMetadataBand,
  shouldEmitLoadingPattern,
  type NodeMap,
} from '../../src/ai/templateRenderer';
import type { LineageNode } from '../../src/engine/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNode(id: string, schema: string, name: string, type: LineageNode['type']): LineageNode {
  return { id, schema, name, fullName: `[${schema}].[${name}]`, type };
}

function makeFixture(): { nodeMap: NodeMap } {
  const nodes: LineageNode[] = [
    makeNode('[dbo].[DimCustomer]', 'dbo', 'DimCustomer', 'table'),
    makeNode('[dbo].[spLoadFact]', 'dbo', 'spLoadFact', 'procedure'),
    makeNode('[dbo].[FactSalesReport]', 'dbo', 'FactSalesReport', 'table'),
    makeNode('[Reporting].[vMonthlyRevenue]', 'Reporting', 'vMonthlyRevenue', 'view'),
  ];
  const nodeMap: NodeMap = new Map(nodes.map(n => [n.id, n]));
  return { nodeMap };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════ templateRenderer tests ══════');

  // shouldEmitLoadingPattern
  console.log('\n── shouldEmitLoadingPattern ──');
  const { nodeMap } = makeFixture();
  assert(shouldEmitLoadingPattern(nodeMap.get('[dbo].[spLoadFact]')) === true, 'procedure → true');
  assert(shouldEmitLoadingPattern(nodeMap.get('[Reporting].[vMonthlyRevenue]')) === false, 'view → false');
  assert(shouldEmitLoadingPattern(nodeMap.get('[dbo].[FactSalesReport]')) === false, 'table → false');
  assert(shouldEmitLoadingPattern(undefined) === false, 'undefined → false');

  // renderMetadataBand — SP origin with loading pattern
  console.log('\n── renderMetadataBand (SP with LP) ──');
  {
    const { nodeMap } = makeFixture();
    const md = renderMetadataBand('[dbo].[spLoadFact]', nodeMap, 'reload');
    assert(md === '**Loading Pattern:** reload', 'Emits exactly the Loading Pattern line');
    assert(!md.includes('**In:**'), 'In line removed');
    assert(!md.includes('**Out:**'), 'Out line removed');
  }

  // renderMetadataBand — SP origin, no loading pattern → empty
  console.log('\n── renderMetadataBand (SP, no LP) ──');
  {
    const { nodeMap } = makeFixture();
    const md = renderMetadataBand('[dbo].[spLoadFact]', nodeMap);
    assert(md === '', 'Empty when no loading pattern provided');
  }

  // renderMetadataBand — view origin → empty even with LP
  console.log('\n── renderMetadataBand (view origin) ──');
  {
    const { nodeMap } = makeFixture();
    const md = renderMetadataBand('[Reporting].[vMonthlyRevenue]', nodeMap, 'reload');
    assert(md === '', 'View origin suppresses Loading Pattern');
  }

  // renderMetadataBand — table origin → empty even with LP
  console.log('\n── renderMetadataBand (table origin) ──');
  {
    const { nodeMap } = makeFixture();
    const md = renderMetadataBand('[dbo].[FactSalesReport]', nodeMap, 'reload');
    assert(md === '', 'Table origin suppresses Loading Pattern');
  }

  // renderMetadataBand — unknown origin → empty (defensive)
  console.log('\n── renderMetadataBand (unknown origin) ──');
  {
    const { nodeMap } = makeFixture();
    const md = renderMetadataBand('[dbo].[Missing]', nodeMap, 'reload');
    assert(md === '', 'Empty when origin id not in nodeMap');
  }

  // renderMetadataBand — empty loading pattern string treated as absent
  console.log('\n── renderMetadataBand (empty LP string) ──');
  {
    const { nodeMap } = makeFixture();
    const md = renderMetadataBand('[dbo].[spLoadFact]', nodeMap, '   ');
    assert(md === '', 'Whitespace-only loading pattern is treated as absent');
  }

  printSummary('templateRenderer');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
