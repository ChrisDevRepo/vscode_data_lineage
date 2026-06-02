import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Legend } from '../../../src/components/Legend';
import { schemaKey } from '../../../src/utils/sql';
import type { SchemaColorMap } from '../../../src/utils/schemaColors';

afterEach(cleanup);

function colorMap(): SchemaColorMap {
  return new Map([
    [schemaKey('ops'), '#335577'],
    [schemaKey('sales'), '#773355'],
  ]);
}

describe('Legend', () => {
  it('dims schemas that remain collapsed in Expanded Schema View', () => {
    render(
      <Legend
        schemas={['ops', 'sales']}
        schemaColorMap={colorMap()}
        isExpandedSchemaViewActive
        expandedSchemas={new Set(['sales'])}
      />,
    );

    const ops = screen.getByText('ops');
    const sales = screen.getByText('sales');

    expect(ops.className).toContain('ln-text-muted');
    expect(ops.getAttribute('data-schema-state')).toBe('collapsed');
    expect(ops.getAttribute('title')).toBe('Collapsed schema cluster');
    expect(sales.className).toContain('ln-text');
    expect(sales.className).not.toContain('ln-text-muted');
    expect(sales.getAttribute('data-schema-state')).toBe('expanded');
    expect(sales.getAttribute('title')).toBe('Expanded schema');
  });

  it('keeps all schema labels normal outside Expanded Schema View', () => {
    render(
      <Legend
        schemas={['ops', 'sales']}
        schemaColorMap={colorMap()}
        expandedSchemas={new Set(['sales'])}
      />,
    );

    for (const schema of ['ops', 'sales']) {
      const label = screen.getByText(schema);
      expect(label.className).toContain('ln-text');
      expect(label.className).not.toContain('ln-text-muted');
      expect(label.getAttribute('data-schema-state')).toBeNull();
      expect(label.getAttribute('title')).toBeNull();
    }
  });
});
