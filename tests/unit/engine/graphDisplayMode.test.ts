/**
 * Graph display mode: initial mode, Schema View versus Object View by object count, and the
 * render-limit fallback notice.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveGraphDisplayMode,
  deriveInitialGraphMode,
  deriveRenderLimitFallback,
} from '../../../src/engine/graphDisplayMode';
import {
  DEFAULT_CONFIG,
  type ExtensionConfig,
} from '../../../src/engine/shared/types';

const config: ExtensionConfig = {
  ...DEFAULT_CONFIG,
  overview: {
    enabled: true,
    threshold: 150,
    schemaDoubleClickBehavior: 'expandOnly',
  },
  renderLimit: 750,
};

type DisplayInput = Parameters<typeof deriveGraphDisplayMode>[0];

function displayState(overrides: Partial<DisplayInput>) {
  return deriveGraphDisplayMode({
    graphMode: 'full',
    filteredCount: 0,
    config,
    renderLimitHit: 0,
    expandedSchemaCount: 0,
    schemaOverviewRenderedCount: 0,
    ...overrides,
  });
}

describe('deriveInitialGraphMode', () => {
  it.each([
    ['Object View at or below overview.threshold', 150, config, 'full'],
    ['Schema View above overview.threshold', 151, config, 'overview'],
    [
      'Object View regardless of count when overview is disabled',
      151,
      { ...config, overview: { ...config.overview, enabled: false } },
      'full',
    ],
    [
      'Schema View when the threshold exceeds the render limit and the count is between them',
      800,
      { ...config, overview: { ...config.overview, threshold: 1000 } },
      'overview',
    ],
  ] as const)('seeds %s', (_rule, filteredCount, settings, mode) => {
    expect(deriveInitialGraphMode({ filteredCount, config: settings })).toBe(
      mode,
    );
  });
});

describe('deriveGraphDisplayMode', () => {
  const CASES: Array<{
    rule: string;
    input: Partial<DisplayInput>;
    mode: string;
    renderedCount: number;
  }> = [
    {
      rule: 'Object View exactly at renderLimit stays on the object surface',
      input: { graphMode: 'full', filteredCount: 750, renderLimitHit: 0 },
      mode: 'full',
      renderedCount: 750,
    },
    {
      rule: 'explicit Object View ignores the overview threshold after initialization',
      input: { graphMode: 'full', filteredCount: 500, renderLimitHit: 0 },
      mode: 'full',
      renderedCount: 500,
    },
    {
      rule: 'explicit Schema View stays active at or below the threshold',
      input: {
        graphMode: 'overview',
        filteredCount: 150,
        schemaOverviewRenderedCount: 2,
      },
      mode: 'schemaOverview',
      renderedCount: 2,
    },
    {
      rule: 'Expanded Schema View stays active when filters drop below the threshold',
      input: {
        graphMode: 'overview',
        filteredCount: 120,
        expandedSchemaCount: 2,
        schemaOverviewRenderedCount: 4,
        expandedSchemaViewRenderedCount: 118,
      },
      mode: 'schemaExpanded',
      renderedCount: 118,
    },
    {
      rule: 'raw object count over renderLimit still renders Schema View when the clusters fit',
      input: {
        graphMode: 'overview',
        filteredCount: 5000,
        renderLimitHit: 5000,
        schemaOverviewRenderedCount: 10,
      },
      mode: 'schemaOverview',
      renderedCount: 10,
    },
    {
      rule: 'raw object count over renderLimit still renders Expanded Schema View when the projection fits',
      input: {
        graphMode: 'overview',
        filteredCount: 5000,
        renderLimitHit: 5000,
        expandedSchemaCount: 2,
        schemaOverviewRenderedCount: 10,
        expandedSchemaViewRenderedCount: 740,
      },
      mode: 'schemaExpanded',
      renderedCount: 740,
    },
    {
      rule: 'Expanded Schema View over the projected renderLimit is blocked',
      input: {
        graphMode: 'overview',
        filteredCount: 5000,
        renderLimitHit: 5000,
        expandedSchemaCount: 3,
        schemaOverviewRenderedCount: 10,
        expandedSchemaViewRenderedCount: 751,
      },
      mode: 'renderLimit',
      renderedCount: 751,
    },
    {
      rule: 'trace/path/analysis scoped mode takes precedence over the base render limit',
      input: {
        graphMode: 'overview',
        filteredCount: 5000,
        renderLimitHit: 5000,
        expandedSchemaCount: 3,
        schemaOverviewRenderedCount: 10,
        expandedSchemaViewRenderedCount: 751,
        scopedModeActive: true,
      },
      mode: 'scoped',
      renderedCount: 751,
    },
    {
      rule: 'a scope within the render limit renders even when the base surface is far over it',
      input: {
        graphMode: 'full',
        filteredCount: 5000,
        renderLimitHit: 5000,
        schemaOverviewRenderedCount: 10,
        scopedModeActive: true,
        scopedRenderedCount: 40,
      },
      mode: 'scoped',
      renderedCount: 40,
    },
    {
      rule: 'a scope over the render limit is blocked — an all-levels trace reaches the whole model',
      input: {
        graphMode: 'full',
        filteredCount: 1000,
        renderLimitHit: 1000,
        schemaOverviewRenderedCount: 10,
        scopedModeActive: true,
        scopedRenderedCount: 1000,
      },
      mode: 'renderLimit',
      renderedCount: 1000,
    },
    {
      rule: 'Object View over renderLimit shows the limit screen instead of silently switching views',
      input: {
        graphMode: 'full',
        filteredCount: 751,
        renderLimitHit: 751,
        schemaOverviewRenderedCount: 2,
      },
      mode: 'renderLimit',
      renderedCount: 751,
    },
  ];

  it.each(CASES)('$rule', ({ input, mode, renderedCount }) => {
    expect(displayState(input)).toEqual({ mode, renderedCount });
  });
});

describe('deriveRenderLimitFallback', () => {
  it('names filter scope and VS Code settings and offers no action', () => {
    expect(deriveRenderLimitFallback()).toStrictEqual({
      message: 'Reduce filter scope or adjust VS Code settings.',
    });
  });
});
