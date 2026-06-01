import { describe } from 'vitest';
import { registerModuleSuites } from '../helpers/vitestNodeSuite';

const baselineModules = [
  'graph-analysis-aw.test.ts',
  'snapshot-aw-baseline.ts',
];

describe('Baseline tier', () => {
  registerModuleSuites(baselineModules);
});
