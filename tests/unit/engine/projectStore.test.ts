/**
 * Saved project store boundary: workspace state is untrusted, so malformed input yields an empty
 * store and malformed project entries are dropped.
 */
import { describe, it, expect } from 'vitest';
import {
  createProject,
  migrateProjectStore,
} from '../../../src/engine/projectStore';
import type { DacpacConnection } from '../../../src/engine/projectStore';

const dacpacConn: DacpacConnection = {
  type: 'dacpac',
  path: '/data/AdventureWorks.dacpac',
  displayName: 'AdventureWorks',
  schemas: ['dbo', 'Sales'],
};

describe('migrateProjectStore', () => {
  it('returns empty store for invalid inputs', () => {
    for (const input of [
      null,
      undefined,
      'string-value',
      { schemaVersion: 99, projects: [], lastOpenedId: null },
      { schemaVersion: 1, projects: 'oops', lastOpenedId: null },
    ]) {
      const s = migrateProjectStore(input);
      expect(
        s.schemaVersion,
        `schemaVersion 1 for ${JSON.stringify(input)}`,
      ).toBe(1);
      expect(
        s.projects.length,
        `no projects for ${JSON.stringify(input)}`,
      ).toBe(0);
    }
  });

  it('filters out malformed project entries', () => {
    const valid = createProject('OK', dacpacConn);
    const badNoId = {
      name: 'Missing id',
      createdAt: 'x',
      updatedAt: 'x',
      connection: dacpacConn,
    };
    const badConnType = {
      id: 'x',
      name: 'Bad conn',
      createdAt: 'x',
      updatedAt: 'x',
      connection: { type: 'ftp', host: 'foo' },
    };
    const badNoPath = {
      id: 'bad',
      name: 'Bad',
      createdAt: 'x',
      updatedAt: 'x',
      connection: { type: 'dacpac', displayName: 'AW', schemas: [] },
    };
    const badConnectionInfo = {
      id: 'bad-ci',
      name: 'Malformed DB',
      createdAt: 'x',
      updatedAt: 'x',
      connection: {
        type: 'database',
        connectionInfo: 'not-an-object',
        sourceName: 'x',
        schemas: [],
      },
    };
    const raw = {
      schemaVersion: 1,
      projects: [valid, badNoId, badConnType, badNoPath, badConnectionInfo],
      lastOpenedId: null,
    };
    const s = migrateProjectStore(raw);
    expect(s.projects.length, 'only valid project retained').toBe(1);
    expect(s.projects[0].id, 'valid project preserved').toBe(valid.id);
  });
});
