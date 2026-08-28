/**
 * Tests for the graph display mode contract.
 */

import { describe, it } from 'vitest';
import { deriveGraphDisplayMode, deriveInitialGraphMode } from '../../../src/engine/graphDisplayMode';
import { DEFAULT_CONFIG, type ExtensionConfig } from '../../../src/engine/types';
import { assertEq } from '../helpers/testUtils';

describe('Graph Display Mode', () => {
  it('runs all graph display mode assertions', () => {

console.log('\n-- Graph Display Mode --');

const config: ExtensionConfig = {
  ...DEFAULT_CONFIG,
  overview: { enabled: true, threshold: 150, schemaDoubleClickBehavior: 'expandOnly' },
  renderLimit: 750,
};

function displayState(overrides: Partial<Parameters<typeof deriveGraphDisplayMode>[0]>) {
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

function displayMode(overrides: Partial<Parameters<typeof deriveGraphDisplayMode>[0]>) {
  return displayState(overrides).mode;
}

assertEq(
  deriveInitialGraphMode({ filteredCount: 150, config }),
  'full',
  '<= overview.threshold seeds Object View',
);

assertEq(
  deriveInitialGraphMode({ filteredCount: 151, config }),
  'overview',
  '> overview.threshold seeds Schema View',
);

assertEq(
  deriveInitialGraphMode({ filteredCount: 151, config: { ...config, overview: { ...config.overview, enabled: false, threshold: 150 } } }),
  'full',
  'overview.enabled=false seeds Object View',
);

assertEq(
  DEFAULT_CONFIG.overview.schemaDoubleClickBehavior,
  'expandOnly',
  'schema double-click defaults to Expand Only',
);

assertEq(
  displayMode({ graphMode: 'full', filteredCount: 500, renderLimitHit: 0 }),
  'full',
  'explicit Object View ignores overview threshold after initialization',
);

assertEq(
  displayMode({ graphMode: 'overview', filteredCount: 150, schemaOverviewRenderedCount: 2 }),
  'schemaOverview',
  'explicit Schema View stays active at or below the threshold',
);

assertEq(
  displayMode({ graphMode: 'overview', filteredCount: 120, expandedSchemaCount: 2, schemaOverviewRenderedCount: 4, expandedSchemaViewRenderedCount: 118 }),
  'schemaExpanded',
  'Expanded Schema View stays active when filters drop below the threshold',
);

assertEq(
  displayMode({ graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000, schemaOverviewRenderedCount: 10 }),
  'schemaOverview',
  'raw object count over renderLimit still renders Schema View when rendered clusters fit',
);

assertEq(
  displayMode({ graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000, expandedSchemaCount: 2, schemaOverviewRenderedCount: 10, expandedSchemaViewRenderedCount: 740 }),
  'schemaExpanded',
  'raw object count over renderLimit still renders Expanded Schema View when projected nodes fit',
);

assertEq(
  displayMode({ graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000, expandedSchemaCount: 3, schemaOverviewRenderedCount: 10, expandedSchemaViewRenderedCount: 751 }),
  'renderLimit',
  'Expanded Schema View over projected renderLimit is blocked',
);

assertEq(
  displayMode({ graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000, expandedSchemaCount: 3, schemaOverviewRenderedCount: 10, expandedSchemaViewRenderedCount: 751, scopedModeActive: true }),
  'scoped',
  'trace/path/analysis scoped mode takes precedence over base render limit',
);

assertEq(
  displayMode({ graphMode: 'full', filteredCount: 751, renderLimitHit: 751, schemaOverviewRenderedCount: 2 }),
  'renderLimit',
  'Object View over renderLimit shows limit screen instead of silently switching views',
);

assertEq(
  displayState({ graphMode: 'overview', filteredCount: 5000, renderLimitHit: 5000, expandedSchemaCount: 3, schemaOverviewRenderedCount: 10, expandedSchemaViewRenderedCount: 751 }).renderedCount,
  751,
  'blocked Expanded Schema View reports its projected rendered count',
);

assertEq(
  displayState({ graphMode: 'full', filteredCount: 751, renderLimitHit: 751, schemaOverviewRenderedCount: 2 }).renderedCount,
  751,
  'blocked Object View reports the render-limited node count',
);

assertEq(
  displayState({ graphMode: 'overview', filteredCount: 150, schemaOverviewRenderedCount: 2 }).renderedCount,
  2,
  'Schema View reports the rendered cluster count',
);

  });
});
