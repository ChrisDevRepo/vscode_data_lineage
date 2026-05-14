/**
 * Tests for deterministic schema palette assignment.
 * Execute with: npx tsx tests/unit/schemaColors.test.ts
 */

import assert from 'node:assert/strict';
import {
  SCHEMA_COLORS_LIGHT,
  createSchemaColorMap,
  getSchemaColor,
  getSchemaColorFromMap,
} from '../../src/utils/schemaColors';

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

function run() {
  const baseColors = assignedColors(THIRTY_SCHEMAS.slice(0, 15));
  for (const color of baseColors) {
    assert(SCHEMA_COLORS_LIGHT.includes(color), '15 or fewer schemas use only base palette colors');
  }
  assert.equal(new Set(baseColors).size, 15, '15 schemas receive unique base colors');

  const colors = assignedColors(THIRTY_SCHEMAS);
  assert.equal(new Set(colors).size, THIRTY_SCHEMAS.length, 'up to 30 schemas receive unique colors');

  const shuffled = [...THIRTY_SCHEMAS].reverse();
  const a = createSchemaColorMap(THIRTY_SCHEMAS, true);
  const b = createSchemaColorMap(shuffled, true);
  for (const schema of THIRTY_SCHEMAS) {
    assert.equal(getSchemaColorFromMap(schema, a), getSchemaColorFromMap(schema, b), `${schema} color is input-order independent`);
  }

  const caseMap = createSchemaColorMap(['Sales', 'sales', 'SALES'], true);
  assert.equal(caseMap.size, 1, 'schema color keys are case-insensitive');
  assert.equal(getSchemaColorFromMap('Sales', caseMap), getSchemaColorFromMap('sales', caseMap));

  const fortyFive = [...THIRTY_SCHEMAS, ...Array.from({ length: 15 }, (_, i) => `extra_${i}`)];
  const colorCounts = new Map<string, number>();
  for (const color of assignedColors(fortyFive)) {
    colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
  }
  const counts = [...colorCounts.values()];
  assert.equal(colorCounts.size, 30, 'more than 30 schemas use every palette color');
  assert(Math.max(...counts) - Math.min(...counts) <= 1, 'color reuse stays balanced after palette exhaustion');

  assert.equal(getSchemaColor('dbo', true), getSchemaColor('DBO', true), 'single-schema hashing is case-insensitive');
  assert.throws(() => createSchemaColorMap(['dbo', ''], true), /non-empty schema name/);

  console.log('schemaColors tests passed');
}

run();
