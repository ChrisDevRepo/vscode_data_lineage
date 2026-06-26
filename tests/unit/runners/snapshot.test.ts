import { describe } from 'vitest';
import { registerModuleSuites } from '../helpers/vitestNodeSuite';

const snapshotModules = [
  'snapshot-aw-baseline.ts',
];

describe('Snapshot tier', () => {
  registerModuleSuites(snapshotModules);
});
