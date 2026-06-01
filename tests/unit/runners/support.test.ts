import { describe } from 'vitest';
import { discoverUnitTestFiles, registerModuleSuites } from '../helpers/vitestNodeSuite';

// Domain runners (bfs / parser / baseline) own these — exclude so support does not double-run them.
const supportModules = discoverUnitTestFiles([
  'expandedSchemaViewCore.test.ts',
  'graph-analysis-aw.test.ts',
  'graphAnalysis.test.ts',
  'graphBuilder.test.ts',
  'graphDisplayMode.test.ts',
  'parser-edge-cases.test.ts',
  'tsql-complex.test.ts',
]);

describe('Support tier', () => {
  registerModuleSuites(supportModules);
});
