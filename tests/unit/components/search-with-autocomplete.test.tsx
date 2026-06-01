import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { SearchWithAutocomplete } from '../../../src/components/SearchWithAutocomplete';

const collapsedNode = {
  id: '[sales].[CollapsedOrder]',
  name: 'CollapsedOrder',
  schema: 'sales',
  type: 'table' as const,
};

afterEach(cleanup);

describe('SearchWithAutocomplete', () => {
  it('routes collapsed-schema click selection through the normal search callback', () => {
    const onExecuteSearch = vi.fn();
    render(
      <SearchWithAutocomplete
        onExecuteSearch={onExecuteSearch}
        allNodes={[collapsedNode]}
        visibleNodeIds={new Set([collapsedNode.id])}
        collapsedSchemaNodeIds={new Set([collapsedNode.id])}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Quick Jump...'), {
      target: { value: 'Collapsed' },
    });
    expect(screen.getByText(/In Schema Cluster/)).toBeTruthy();
    fireEvent.click(screen.getByText(collapsedNode.name));

    expect(onExecuteSearch).toHaveBeenCalledTimes(1);
    expect(onExecuteSearch).toHaveBeenCalledWith(collapsedNode.name, collapsedNode.schema);
  });

  it('routes collapsed-schema keyboard selection through the normal search callback', () => {
    const onExecuteSearch = vi.fn();
    const { getByPlaceholderText } = render(
      <SearchWithAutocomplete
        onExecuteSearch={onExecuteSearch}
        allNodes={[collapsedNode]}
        visibleNodeIds={new Set([collapsedNode.id])}
        collapsedSchemaNodeIds={new Set([collapsedNode.id])}
      />,
    );
    const input = getByPlaceholderText('Quick Jump...');

    fireEvent.change(input, { target: { value: 'Collapsed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onExecuteSearch).toHaveBeenCalledTimes(1);
    expect(onExecuteSearch).toHaveBeenCalledWith(collapsedNode.name, collapsedNode.schema);
  });
});
