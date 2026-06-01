import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { DetailSearchSidebar, type DetailSearchNode } from '../../../src/components/DetailSearchSidebar';

afterEach(cleanup);

const nodes: DetailSearchNode[] = [
  {
    id: '[sales].[VisibleView]',
    name: 'VisibleView',
    schema: 'sales',
    type: 'view',
    bodyScript: 'select Revenue from sales.Source',
  },
  {
    id: '[ops].[ClusteredView]',
    name: 'ClusteredView',
    schema: 'ops',
    type: 'view',
    bodyScript: 'select Revenue from ops.Source',
  },
  {
    id: '[audit].[FilteredView]',
    name: 'FilteredView',
    schema: 'audit',
    type: 'view',
    bodyScript: 'select Revenue from audit.Source',
  },
];

describe('DetailSearchSidebar', () => {
  it('separates visible, schema-clustered, and filtered-out results', async () => {
    const onResultClick = vi.fn();
    render(
      <DetailSearchSidebar
        onClose={vi.fn()}
        allNodes={nodes}
        onResultClick={onResultClick}
        visibleNodeIds={new Set(['[sales].[VisibleView]', '[ops].[ClusteredView]'])}
        collapsedSchemaNodeIds={new Set(['[ops].[ClusteredView]'])}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Search SQL bodies...'), {
      target: { value: 'Revenue' },
    });

    expect(await screen.findByText('Visible')).toBeTruthy();
    expect(screen.getByText(/In Schema Cluster/)).toBeTruthy();
    expect(screen.getByText(/Not in Current Filter/)).toBeTruthy();

    fireEvent.click(screen.getByText('[ops].ClusteredView'));

    expect(onResultClick).toHaveBeenCalledWith('[ops].[ClusteredView]', 'Revenue');
  });
});
