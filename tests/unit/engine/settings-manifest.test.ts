/**
 * Verifies VS Code setting defaults against runtime constants.
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { rootPath } from '../helpers/testUtils';
import { DEFAULT_CONFIG } from '../../../src/engine/types';

type Setting = { default?: unknown };

const runtimeDefaults: Record<string, unknown> = {
  'dataLineageViz.excludePatterns': DEFAULT_CONFIG.excludePatterns,
  'dataLineageViz.maxNodes': DEFAULT_CONFIG.maxNodes,
  'dataLineageViz.dmvQueryTimeout': DEFAULT_CONFIG.dmvQueryTimeout,
  'dataLineageViz.layout.direction': DEFAULT_CONFIG.layout.direction,
  'dataLineageViz.layout.rankSeparation': DEFAULT_CONFIG.layout.rankSeparation,
  'dataLineageViz.layout.nodeSeparation': DEFAULT_CONFIG.layout.nodeSeparation,
  'dataLineageViz.layout.edgeAnimation': DEFAULT_CONFIG.layout.edgeAnimation,
  'dataLineageViz.layout.highlightAnimation': DEFAULT_CONFIG.layout.highlightAnimation,
  'dataLineageViz.layout.minimapEnabled': DEFAULT_CONFIG.layout.minimapEnabled,
  'dataLineageViz.layout.edgeStyle': DEFAULT_CONFIG.layout.edgeStyle,
  'dataLineageViz.trace.defaultUpstreamLevels': DEFAULT_CONFIG.trace.defaultUpstreamLevels,
  'dataLineageViz.trace.defaultDownstreamLevels': DEFAULT_CONFIG.trace.defaultDownstreamLevels,
  'dataLineageViz.analysis.hubMinDegree': DEFAULT_CONFIG.analysis.hubMinDegree,
  'dataLineageViz.analysis.islandMaxSize': DEFAULT_CONFIG.analysis.islandMaxSize,
  'dataLineageViz.analysis.longestPathMinNodes': DEFAULT_CONFIG.analysis.longestPathMinNodes,
  'dataLineageViz.tableStatistics.enabled': DEFAULT_CONFIG.tableStatistics.enabled,
  'dataLineageViz.tableStatistics.standardModeEnabled': DEFAULT_CONFIG.tableStatistics.standardModeEnabled,
  'dataLineageViz.tableStatistics.excludeExternalTables': DEFAULT_CONFIG.tableStatistics.excludeExternalTables,
  'dataLineageViz.tableStatistics.queryTimeout': DEFAULT_CONFIG.tableStatistics.queryTimeout,
  'dataLineageViz.tableStatistics.sampleThreshold': DEFAULT_CONFIG.tableStatistics.sampleThreshold,
  'dataLineageViz.tableStatistics.sampleSize': DEFAULT_CONFIG.tableStatistics.sampleSize,
  'dataLineageViz.tableStatistics.useApproxDistinct': DEFAULT_CONFIG.tableStatistics.useApproxDistinct,
  'dataLineageViz.tableStatistics.maxColumns': DEFAULT_CONFIG.tableStatistics.maxColumns,
  'dataLineageViz.externalRefs.enabled': DEFAULT_CONFIG.externalRefs.enabled,
  'dataLineageViz.overview.enabled': DEFAULT_CONFIG.overview.enabled,
  'dataLineageViz.overview.threshold': DEFAULT_CONFIG.overview.threshold,
  'dataLineageViz.overview.schemaDoubleClickBehavior': DEFAULT_CONFIG.overview.schemaDoubleClickBehavior,
  'dataLineageViz.renderLimit': DEFAULT_CONFIG.renderLimit,
};

describe('VS Code settings manifest consistency', () => {
  it('package.json defaults match every shared runtime default', () => {
    const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf-8')) as {
      contributes?: { configuration?: Array<{ properties?: Record<string, Setting> }> };
    };
    const settings = Object.assign({}, ...(pkg.contributes?.configuration ?? []).map((section) => section.properties ?? {})) as Record<string, Setting>;

    for (const [key, expected] of Object.entries(runtimeDefaults)) {
      expect(settings[key]?.default, `${key} default matches runtime`).toEqual(expected);
    }
  });
});
