import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import React, { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchemaNode } from '../../../src/components/SchemaNode';
import type { SchemaNodeData } from '../../../src/engine/types';

vi.mock('@xyflow/react', async () => ({
  Position: { Top: 'top', Left: 'left', Right: 'right', Bottom: 'bottom' },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Handle: () => <span data-testid="handle" />,
  NodeToolbar: ({ children, isVisible }: { children: ReactNode; isVisible?: boolean }) => (
    isVisible === false ? null : <div data-testid="node-toolbar">{children}</div>
  ),
}));

afterEach(cleanup);

function renderSchemaNode(
  data: SchemaNodeData & {
    onExpandSchema?: (schema: string) => void;
    onMakeSchemaCenter?: (schema: string) => void;
  },
  selected = false,
) {
  render(
    <ReactFlowProvider>
      <SchemaNode
        id="schema-sales"
        type="schemaNode"
        selected={selected}
        dragging={false}
        zIndex={0}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={data}
      />
    </ReactFlowProvider>,
  );
}

describe('SchemaNode', () => {
  it('opens the schema with Enter and Space when expansion is available', () => {
    const onExpandSchema = vi.fn();
    renderSchemaNode({
      schemaName: 'sales',
      objectCount: 12,
      typeBreakdown: { table: 10, view: 2 },
      color: '#336699',
      isExpandedSchemaViewCluster: true,
      onExpandSchema,
    });

    const node = screen.getByRole('button', { name: 'Expand schema sales' });
    fireEvent.keyDown(node, { key: 'Enter' });
    fireEvent.keyDown(node, { key: ' ' });

    expect(onExpandSchema).toHaveBeenCalledTimes(2);
    expect(onExpandSchema).toHaveBeenNthCalledWith(1, 'sales');
    expect(onExpandSchema).toHaveBeenNthCalledWith(2, 'sales');
  });

  it('hides schema actions until a collapsed schema cluster is selected', () => {
    renderSchemaNode({
      schemaName: 'sales',
      objectCount: 12,
      typeBreakdown: { table: 10, view: 2 },
      color: '#336699',
      isExpandedSchemaViewCluster: true,
      onExpandSchema: vi.fn(),
      onMakeSchemaCenter: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand Only' })).toBeNull();
  });

  it('shows selected collapsed schema cluster actions and routes clicks', () => {
    const onExpandSchema = vi.fn();
    const onMakeSchemaCenter = vi.fn();
    renderSchemaNode({
      schemaName: 'sales',
      objectCount: 12,
      typeBreakdown: { table: 10, view: 2 },
      color: '#336699',
      isExpandedSchemaViewCluster: true,
      onExpandSchema,
      onMakeSchemaCenter,
    }, true);

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Only' }));

    expect(onExpandSchema).toHaveBeenCalledTimes(1);
    expect(onExpandSchema).toHaveBeenCalledWith('sales');
    expect(onMakeSchemaCenter).toHaveBeenCalledTimes(1);
    expect(onMakeSchemaCenter).toHaveBeenCalledWith('sales');
  });

  it('renders collapsed schema clusters with secondary visual treatment', () => {
    renderSchemaNode({
      schemaName: 'sales',
      objectCount: 12,
      typeBreakdown: { table: 10, view: 2 },
      color: '#336699',
      isExpandedSchemaViewCluster: true,
      onExpandSchema: vi.fn(),
    });

    const node = screen.getByRole('button', { name: 'Expand schema sales' });
    const style = node.getAttribute('style') ?? '';
    expect(style).toContain('border: 1px dashed color-mix(in srgb, #336699 48%, var(--ln-border))');
    expect(style).toContain('background: color-mix(in srgb, #336699 12%, var(--ln-bg-elevated))');
    expect(style).toContain('box-shadow: var(--ln-node-shadow-dimmed)');
  });
});
