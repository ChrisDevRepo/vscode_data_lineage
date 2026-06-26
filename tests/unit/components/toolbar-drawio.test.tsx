import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from '../../../src/components/Toolbar';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

afterEach(cleanup);

function renderToolbar(overrides: Partial<React.ComponentProps<typeof Toolbar>> = {}) {
  const props: React.ComponentProps<typeof Toolbar> = {
    types: new Set(['table', 'view', 'procedure', 'function', 'external']),
    onToggleType: vi.fn(),
    hideIsolated: false,
    onToggleIsolated: vi.fn(),
    focusSchemas: new Set(),
    onToggleFocusSchema: vi.fn(),
    selectedSchemas: new Set(['dbo']),
    availableSchemas: ['dbo'],
    onRefresh: vi.fn(),
    onBack: vi.fn(),
    onOpenDdlViewer: vi.fn(),
    onExportDrawio: vi.fn(),
    hasHighlightedNode: false,
    onToggleDetailSearch: vi.fn(),
    showExternalRefs: true,
    externalRefTypes: new Set(['file', 'db']),
    exclusionPatterns: [],
    isModeLocked: false,
    canStartNewScopedMode: true,
    canSwitchGraphMode: true,
    isOverview: false,
    graphMode: 'full',
    metrics: { totalNodes: 1, totalEdges: 0, visibleNodes: 1, visibleEdges: 0 },
    renderedNodeCount: 1,
    overviewThreshold: 100,
    renderLimit: 5000,
    allNodes: [],
    ...overrides,
  };

  return render(
    <VsCodeProvider api={{ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }}>
      <Toolbar {...props} />
    </VsCodeProvider>,
  );
}

describe('Toolbar Draw.io export', () => {
  it('keeps DDL viewer enabled in Schema View', () => {
    const onOpenDdlViewer = vi.fn();
    renderToolbar({ isOverview: true, graphMode: 'overview', onOpenDdlViewer });

    const ddlButton = screen.getByRole<HTMLButtonElement>('button', { name: 'View DDL / SQL source' });
    expect(ddlButton.disabled).toBe(false);

    fireEvent.click(ddlButton);
    expect(onOpenDdlViewer).toHaveBeenCalledTimes(1);
  });

  it('keeps Draw.io export enabled in Schema View', () => {
    const onExportDrawio = vi.fn();
    renderToolbar({ isOverview: true, graphMode: 'overview', onExportDrawio });

    const exportButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Export as Draw.io' });
    expect(exportButton.disabled).toBe(false);

    fireEvent.click(exportButton);
    expect(onExportDrawio).toHaveBeenCalledTimes(1);
  });
});
