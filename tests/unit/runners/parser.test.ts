import { describe } from 'vitest';
import { registerModuleSuites } from '../helpers/vitestNodeSuite';

const parserModules = [
  'parser-edge-cases.test.ts',
  'tsql-complex.test.ts',
  'snapshot-aw-baseline.ts',
];

describe('Parser tier', () => {
  registerModuleSuites(parserModules);
});
