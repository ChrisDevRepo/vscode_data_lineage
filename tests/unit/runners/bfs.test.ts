import { describe } from 'vitest';
import { registerModuleSuites } from '../helpers/vitestNodeSuite';

const bfsModules = [
  'expandedSchemaViewCore.test.ts',
  'graph-analysis-aw.test.ts',
  'graphAnalysis.test.ts',
  'graphBuilder.test.ts',
  'graphDisplayMode.test.ts',
];

describe('BFS tier', () => {
  registerModuleSuites(bfsModules);
});
