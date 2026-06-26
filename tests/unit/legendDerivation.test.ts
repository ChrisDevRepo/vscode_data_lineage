/**
 * Legend derivation guard test.
 *
 * Enforces the invariant the Legend depends on: every schema in the legend LIST
 * (`deriveLegendSchemas`) must have a color in the legend MAP (`deriveLegendColorMap`).
 *
 * Regression context: in overview mode an expanded external-only schema (e.g. `ext`,
 * one external object) used to enter the list while the map skipped external object
 * nodes, so the Legend threw `No legend color assigned for "ext"` and crashed the
 * whole webview. Externals are not palette schemas — they must never appear in the
 * colorful legend, in lockstep across both derivations.
 */

import { printSummary, resetCounters, assert } from './helpers/testUtils';
import { deriveLegendSchemas, deriveLegendColorMap, type LegendNode } from '../../src/components/legendDerivation';
import { schemaKey } from '../../src/utils/sql';

console.log('Legend Derivation Guard');
console.log('='.repeat(40));
resetCounters();

/** Asserts every schema in the list resolves to a color in the map (the Legend invariant). */
const listSubsetOfMap = (schemas: string[], map: Map<string, string>): boolean =>
  schemas.every(s => map.has(schemaKey(s)));

// ── Case 1: overview + expanded external-only schema (the regression) ──
const overviewWithExternal: LegendNode[] = [
  { type: 'schemaNode', data: { schemaName: 'Sales', color: '#4E79A7' } },
  { type: 'lineageNode', data: { schema: 'ext', objectType: 'external' } },
];
{
  const schemas = deriveLegendSchemas(overviewWithExternal, 'overview', 'none', undefined);
  const colorMap = deriveLegendColorMap(overviewWithExternal);
  assert(!schemas.includes('ext'), 'external-only expanded schema is excluded from the legend list');
  assert(schemas.includes('Sales'), 'real collapsed schema remains in the legend list');
  assert(listSubsetOfMap(schemas, colorMap), 'every listed schema has a color (no throw path) — external case');
  assert(!colorMap.has(schemaKey('ext')), 'external object node contributes no palette color');
}

// ── Case 2: overview + expanded REAL schema (object nodes) ──
const overviewExpandedReal: LegendNode[] = [
  { type: 'schemaNode', data: { schemaName: 'Sales', color: '#4E79A7' } },
  { type: 'lineageNode', data: { schema: 'Production', objectType: 'table', schemaColor: '#59A14F' } },
  { type: 'lineageNode', data: { schema: 'Production', objectType: 'view', schemaColor: '#59A14F' } },
];
{
  const schemas = deriveLegendSchemas(overviewExpandedReal, 'overview', 'none', undefined);
  const colorMap = deriveLegendColorMap(overviewExpandedReal);
  assert(schemas.includes('Production'), 'expanded real schema appears in the legend list');
  assert(listSubsetOfMap(schemas, colorMap), 'every listed schema has a color — expanded-real case');
}

// ── Case 3: non-overview (full) mode still excludes external objects ──
const fullModeNodes: LegendNode[] = [
  { type: 'lineageNode', data: { schema: 'Sales', objectType: 'table', schemaColor: '#4E79A7' } },
  { type: 'lineageNode', data: { schema: 'ext', objectType: 'external' } },
];
{
  const schemas = deriveLegendSchemas(fullModeNodes, 'full', 'none', ['Sales', 'ext']);
  const colorMap = deriveLegendColorMap(fullModeNodes);
  assert(!schemas.includes('ext'), 'full mode excludes external-only schema from the legend list');
  assert(listSubsetOfMap(schemas, colorMap), 'every listed schema has a color — full mode case');
}

printSummary('Legend Derivation Guard');
