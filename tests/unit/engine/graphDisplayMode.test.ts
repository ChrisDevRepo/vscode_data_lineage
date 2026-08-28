/**
 * Tests for the graph display mode contract.
 *
 * @remarks
 * The mode derivation is a decision table, so it is tested as one. Each row is its own
 * `it`, named for the rule it encodes, so a regression names the rule that broke rather
 * than the first row that happened to be checked.
 */

import { describe, expect, it } from 'vitest';
import { deriveGraphDisplayMode, deriveInitialGraphMode } from '../../../src/engine/graphDisplayMode';
import { DEFAULT_CONFIG, type ExtensionConfig } from '../../../src/engine/types';

const config: ExtensionConfig = {
  ...DEFAULT_CONFIG,
  overview: { enabled: true, threshold: 150, schemaDoubleClickBehavior: 'expandOnly' },
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
  it('seeds Object View at or below overview.threshold', () => {
    expect(deriveInitialGraphMode({ filteredCount: 150, config })).toBe('full');
  });

  it('seeds Schema View above overview.threshold', () => {
    expect(deriveInitialGraphMode({ filteredCount: 151, config })).toBe('overview');
  });

  it('seeds Object View regardless of count when overview is disabled', () => {
    const disabled = { ...config, overview: { ...config.overview, enabled: false, threshold: 150 } };
    expect(deriveInitialGraphMode({ filteredCount: 151, config: disabled })).toBe('full');
  });

  it('defaults schema double-click to Expand Only', () => {
    expect(DEFAULT_CONFIG.overview.schemaDoubleClickBehavior).toBe('expandOnly');
  });
});

describe('deriveGraphDisplayMode', () => {
  const CASES: Array<{ rule: string; input: Partial<DisplayInput>; mode: string }> = [
    {
      rule: 'explicit Object View ignores the overview threshold after initialization',
      input: { graphMode: 'full', filteredCount: 500, renderLimitHit: 0 },
      mode: 'full',
    },
    {
      rule: 'explicit Schema View stays active at or below the threshold',
      input: { graphMode: 'overview', filteredCount: 150, schemaOverviewRenderedCount: 2 },
      mode: 'schemaOverview',
    },
    {
      rule: 'Expanded Schema View stays active when filters drop below the threshold',
      input: {
        graphMode: 'overview', filteredCount: 120, expandedSchemaCount: 2,
        schemaOverviewRenderedCount: 4, expandedSchemaViewRenderedCount: 118,
      },
      mode: 'schemaExpanded',
    },
    {
      rule: 'raw object count over renderLimit still renders Schema View when the clusters fit',
      input: {
        graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000,
        schemaOverviewRenderedCount: 10,
      },
      mode: 'schemaOverview',
    },
    {
      rule: 'raw object count over renderLimit still renders Expanded Schema View when the projection fits',
      input: {
        graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000, expandedSchemaCount: 2,
        schemaOverviewRenderedCount: 10, expandedSchemaViewRenderedCount: 740,
      },
      mode: 'schemaExpanded',
    },
    {
      rule: 'Expanded Schema View over the projected renderLimit is blocked',
      input: {
        graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000, expandedSchemaCount: 3,
        schemaOverviewRenderedCount: 10, expandedSchemaViewRenderedCount: 751,
      },
      mode: 'renderLimit',
    },
    {
      rule: 'trace/path/analysis scoped mode takes precedence over the base render limit',
      input: {
        graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000, expandedSchemaCount: 3,
        schemaOverviewRenderedCount: 10, expandedSchemaViewRenderedCount: 751, scopedModeActive: true,
      },
      mode: 'scoped',
    },
    {
      rule: 'a scope within the render limit renders even when the base surface is far over it',
      input: {
        graphMode: 'full', filteredCount: 5000, renderLimitHit: 5000,
        schemaOverviewRenderedCount: 10, scopedModeActive: true, scopedRenderedCount: 40,
      },
      mode: 'scoped',
    },
    {
      rule: 'a scope over the render limit is blocked — an all-levels trace reaches the whole model',
      input: {
        graphMode: 'full', filteredCount: 1000, renderLimitHit: 1000,
        schemaOverviewRenderedCount: 10, scopedModeActive: true, scopedRenderedCount: 1000,
      },
      mode: 'renderLimit',
    },
    {
      rule: 'Object View over renderLimit shows the limit screen instead of silently switching views',
      input: {
        graphMode: 'full', filteredCount: 751, renderLimitHit: 751, schemaOverviewRenderedCount: 2,
      },
      mode: 'renderLimit',
    },
  ];

  it.each(CASES)('$rule', ({ input, mode }) => {
    expect(displayState(input).mode).toBe(mode);
  });
});

describe('deriveGraphDisplayMode — reported rendered count', () => {
  it('a blocked Expanded Schema View reports its projected rendered count', () => {
    expect(displayState({
      graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000, expandedSchemaCount: 3,
      schemaOverviewRenderedCount: 10, expandedSchemaViewRenderedCount: 751,
    }).renderedCount).toBe(751);
  });

  it('a blocked Object View reports the render-limited node count', () => {
    expect(displayState({
      graphMode: 'full', filteredCount: 751, renderLimitHit: 751, schemaOverviewRenderedCount: 2,
    }).renderedCount).toBe(751);
  });

  it('Schema View reports the rendered cluster count, not the object count', () => {
    expect(displayState({
      graphMode: 'overview', filteredCount: 150, schemaOverviewRenderedCount: 2,
    }).renderedCount).toBe(2);
  });
});
