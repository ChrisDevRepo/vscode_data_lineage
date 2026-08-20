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

import { describe, it, expect } from 'vitest';
import { deriveLegendSchemas, deriveLegendColorMap, type LegendNode } from '../../../src/components/legendDerivation';
import { schemaKey } from '../../../src/utils/sql';

/** Asserts every schema in the list resolves to a color in the map (the Legend invariant). */
const listSubsetOfMap = (schemas: string[], map: Map<string, string>): boolean =>
  schemas.every(s => map.has(schemaKey(s)));

describe('Legend Derivation Guard', () => {
  it('overview + expanded external-only schema (the regression)', () => {
    const overviewWithExternal: LegendNode[] = [
      { type: 'schemaNode', data: { schemaName: 'Sales', color: '#4E79A7' } },
      { type: 'lineageNode', data: { schema: 'ext', objectType: 'external' } },
    ];
    const schemas = deriveLegendSchemas(overviewWithExternal, 'overview', 'none', undefined);
    const colorMap = deriveLegendColorMap(overviewWithExternal);
    expect(schemas.includes('ext'), 'external-only expanded schema is excluded from the legend list').toBe(false);
    expect(schemas.includes('Sales'), 'real collapsed schema remains in the legend list').toBe(true);
    expect(listSubsetOfMap(schemas, colorMap), 'every listed schema has a color (no throw path) — external case').toBe(true);
    expect(colorMap.has(schemaKey('ext')), 'external object node contributes no palette color').toBe(false);
  });

  it('overview + expanded REAL schema (object nodes)', () => {
    const overviewExpandedReal: LegendNode[] = [
      { type: 'schemaNode', data: { schemaName: 'Sales', color: '#4E79A7' } },
      { type: 'lineageNode', data: { schema: 'Production', objectType: 'table', schemaColor: '#59A14F' } },
      { type: 'lineageNode', data: { schema: 'Production', objectType: 'view', schemaColor: '#59A14F' } },
    ];
    const schemas = deriveLegendSchemas(overviewExpandedReal, 'overview', 'none', undefined);
    const colorMap = deriveLegendColorMap(overviewExpandedReal);
    expect(schemas.includes('Production'), 'expanded real schema appears in the legend list').toBe(true);
    expect(listSubsetOfMap(schemas, colorMap), 'every listed schema has a color — expanded-real case').toBe(true);
  });

  it('non-overview (full) mode still excludes external objects', () => {
    const fullModeNodes: LegendNode[] = [
      { type: 'lineageNode', data: { schema: 'Sales', objectType: 'table', schemaColor: '#4E79A7' } },
      { type: 'lineageNode', data: { schema: 'ext', objectType: 'external' } },
    ];
    const schemas = deriveLegendSchemas(fullModeNodes, 'full', 'none', ['Sales', 'ext']);
    const colorMap = deriveLegendColorMap(fullModeNodes);
    expect(schemas.includes('ext'), 'full mode excludes external-only schema from the legend list').toBe(false);
    expect(listSubsetOfMap(schemas, colorMap), 'every listed schema has a color — full mode case').toBe(true);
  });
});
