/**
 * Tests for deterministic schema palette assignment.
 */

import { describe, it, expect } from 'vitest';
import {
  SCHEMA_COLORS_LIGHT,
  createSchemaColorMap,
  getSchemaColor,
  getSchemaColorFromMap,
  getReadableTextColor,
} from '../../../src/utils/schemaColors';

const THIRTY_SCHEMAS = [
  'dbo',
  'sales',
  'staging',
  'stage',
  'raw',
  'landing',
  'ods',
  'edw',
  'dwh',
  'dm',
  'mart',
  'finance',
  'hr',
  'humanresources',
  'production',
  'purchasing',
  'person',
  'ai',
  'ext',
  'audit',
  'archive',
  'bronze',
  'silver',
  'gold',
  'core',
  'ref',
  'reference',
  'dim',
  'fact',
  'etl',
];

function assignedColors(schemas: string[]): string[] {
  const map = createSchemaColorMap(schemas, true);
  return schemas.map(schema => getSchemaColorFromMap(schema, map));
}

describe('schemaColors', () => {
  it('assigns unique base palette colors to 15 or fewer schemas', () => {
    const baseColors = assignedColors(THIRTY_SCHEMAS.slice(0, 15));
    for (const color of baseColors) {
      expect(SCHEMA_COLORS_LIGHT.includes(color), '15 or fewer schemas use only base palette colors').toBe(true);
    }
    expect(new Set(baseColors).size, '15 schemas receive unique base colors').toBe(15);
  });

  it('gives up to 30 schemas unique colors', () => {
    const colors = assignedColors(THIRTY_SCHEMAS);
    expect(new Set(colors).size, 'up to 30 schemas receive unique colors').toBe(THIRTY_SCHEMAS.length);
  });

  it('is input-order independent', () => {
    const shuffled = [...THIRTY_SCHEMAS].reverse();
    const a = createSchemaColorMap(THIRTY_SCHEMAS, true);
    const b = createSchemaColorMap(shuffled, true);
    for (const schema of THIRTY_SCHEMAS) {
      expect(getSchemaColorFromMap(schema, a), `${schema} color is input-order independent`)
        .toBe(getSchemaColorFromMap(schema, b));
    }
  });

  it('uses case-insensitive schema color keys', () => {
    const caseMap = createSchemaColorMap(['Sales', 'sales', 'SALES'], true);
    expect(caseMap.size, 'schema color keys are case-insensitive').toBe(1);
    expect(getSchemaColorFromMap('Sales', caseMap)).toBe(getSchemaColorFromMap('sales', caseMap));
  });

  it('reuses palette colors in balance after exhaustion', () => {
    const fortyFive = [...THIRTY_SCHEMAS, ...Array.from({ length: 15 }, (_, i) => `extra_${i}`)];
    const colorCounts = new Map<string, number>();
    for (const color of assignedColors(fortyFive)) {
      colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
    }
    const counts = [...colorCounts.values()];
    expect(colorCounts.size, 'more than 30 schemas use every palette color').toBe(30);
    expect(Math.max(...counts) - Math.min(...counts) <= 1, 'color reuse stays balanced after palette exhaustion').toBe(true);
  });

  it('hashes a single schema case-insensitively and rejects empty names', () => {
    expect(getSchemaColor('dbo', true), 'single-schema hashing is case-insensitive').toBe(getSchemaColor('DBO', true));
    expect(() => createSchemaColorMap(['dbo', ''], true)).toThrow(/non-empty schema name/);
  });

  it('picks header text that meets WCAG AA on every schema palette color', () => {
    const lum = (hex: string) => [1, 3, 5]
      .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const colors = new Set([...createSchemaColorMap(THIRTY_SCHEMAS, true).values(), '#FFAD5C', '#F7E589', '#8AB8E6']);
    for (const bg of colors) {
      expect(ratio(bg, getReadableTextColor(bg)), `text on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(getReadableTextColor('#ffffff')).toBe('#000000');
    expect(getReadableTextColor('#000000')).toBe('#ffffff');
  });
});
