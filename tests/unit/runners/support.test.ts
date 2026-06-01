import { describe } from 'vitest';
import { discoverUnitTestFiles, registerModuleSuites } from '../helpers/vitestNodeSuite';

// Domain runners (bfs / parser / baseline) own these — exclude so support does not double-run them.
const supportModules = discoverUnitTestFiles([
  'column-flow-validation.test.ts',
  'expandedSchemaViewCore.test.ts',
  'graph-analysis-aw.test.ts',
  'graphAnalysis.test.ts',
  'graphBuilder.test.ts',
  'graphDisplayMode.test.ts',
  'navigation-engine-bipartite.test.ts',
  'navigation-engine-cascade.test.ts',
  'navigation-engine-supplement.test.ts',
  'navigation-engine-synthesis-regression.test.ts',
  'navigation-engine.test.ts',
  'parser-edge-cases.test.ts',
  'present-result-closure.test.ts',
  'refine-loop.test.ts',
  'start-exploration-schema.test.ts',
  'submit-findings-schema.test.ts',
  'tsql-complex.test.ts',
]);

describe('Support tier', () => {
  registerModuleSuites(supportModules);
});
