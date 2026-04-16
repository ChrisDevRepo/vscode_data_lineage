/**
 * Tests for src/engine/projectStore.ts
 * Focus: Migration and Serialization (Core Data Integrity)
 */

import { assert, assertEq, test, printSummary } from './testUtils';
import {
  createProject,
  migrateProjectStore,
  serializeFilter,
  deserializeFilter,
} from '../src/engine/projectStore';
import type {
  Project,
  DacpacConnection,
  DatabaseConnection,
  SerializedFilterState,
} from '../src/engine/projectStore';
import type { FilterState } from '../src/engine/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const dacpacConn: DacpacConnection = {
  type: 'dacpac',
  path: '/data/AdventureWorks.dacpac',
  displayName: 'AdventureWorks',
  schemas: ['dbo', 'Sales'],
};

const dbConn: DatabaseConnection = {
  type: 'database',
  connectionInfo: {
    server: 'myserver',
    database: 'SalesDB',
    user: 'sa',
    authenticationType: 'SqlLogin',
    port: 1433,
  },
  sourceName: 'SalesDB (myserver)',
  schemas: ['dbo', 'Sales'],
};

// ─── migrateProjectStore ──────────────────────────────────────────────────────

console.log('\n── migrateProjectStore ────────────────────────────────────────');

test('returns empty store for invalid inputs', () => {
  for (const input of [
    null, undefined, 'string-value',
    { schemaVersion: 99, projects: [], lastOpenedId: null },
    { schemaVersion: 1, projects: 'oops', lastOpenedId: null },
  ]) {
    const s = migrateProjectStore(input);
    assertEq(s.schemaVersion, 1, `schemaVersion 1 for ${JSON.stringify(input)}`);
    assertEq(s.projects.length, 0, `no projects for ${JSON.stringify(input)}`);
  }
});

test('preserves valid v1 data for both connection types', () => {
  // Dacpac
  const projD = createProject('AW', dacpacConn);
  const sD = migrateProjectStore({ schemaVersion: 1, projects: [projD], lastOpenedId: projD.id });
  assertEq(sD.projects.length, 1, 'dacpac: one project');
  assertEq(sD.projects[0].id, projD.id, 'dacpac: id preserved');
  assertEq(sD.lastOpenedId, projD.id, 'dacpac: lastOpenedId preserved');
  // Database
  const projDb = createProject('DB', dbConn);
  const sDb = migrateProjectStore({ schemaVersion: 1, projects: [projDb], lastOpenedId: null });
  assertEq(sDb.projects.length, 1, 'database: one project');
  const c = sDb.projects[0].connection as DatabaseConnection;
  assertEq(c.sourceName, dbConn.sourceName, 'database: sourceName preserved');
});

test('filters out malformed project entries', () => {
  const valid = createProject('OK', dacpacConn);
  const badNoId = { name: 'Missing id', createdAt: 'x', updatedAt: 'x', connection: dacpacConn };
  const badConnType = { id: 'x', name: 'Bad conn', createdAt: 'x', updatedAt: 'x', connection: { type: 'ftp', host: 'foo' } };
  const badNoPath = { id: 'bad', name: 'Bad', createdAt: 'x', updatedAt: 'x', connection: { type: 'dacpac', displayName: 'AW', schemas: [] } };
  const raw = { schemaVersion: 1, projects: [valid, badNoId, badConnType, badNoPath], lastOpenedId: null };
  const s = migrateProjectStore(raw);
  assertEq(s.projects.length, 1, 'only valid project retained');
  assertEq(s.projects[0].id, valid.id, 'valid project preserved');
});

// ─── serializeFilter / deserializeFilter ──────────────────────────────────────

console.log('\n── serializeFilter / deserializeFilter ────────────────────────');

const sampleFilter: FilterState = {
  schemas: new Set(['dbo', 'Sales']),
  types: new Set(['table', 'view']),
  searchTerm: 'Order',
  hideIsolated: false,
  focusSchemas: new Set(['dbo']),
  showExternalRefs: true,
  externalRefTypes: new Set(['file']),
  exclusionPatterns: ['%tmp%', '^etl\\.'],
};

test('roundtrip: serialize then deserialize preserves all fields', () => {
  const s = serializeFilter(sampleFilter);
  // Serialized form uses arrays
  assert(Array.isArray(s.schemas), 'schemas is array');
  assert(Array.isArray(s.types), 'types is array');
  // Roundtrip
  const restored = deserializeFilter(s);
  assert(restored.schemas instanceof Set, 'schemas restored to Set');
  assert(restored.types instanceof Set, 'types restored to Set');
  assertEq(restored.schemas.has('dbo'), true, 'dbo in schemas');
  assertEq(restored.schemas.has('Sales'), true, 'Sales in schemas');
  assertEq(restored.types.has('table'), true, 'table in types');
  assertEq(restored.searchTerm, 'Order', 'searchTerm roundtrip');
  assertEq(restored.hideIsolated, false, 'hideIsolated roundtrip');
  assertEq(restored.focusSchemas.has('dbo'), true, 'dbo in focusSchemas');
  assertEq(restored.showExternalRefs, true, 'showExternalRefs roundtrip');
  assertEq(restored.externalRefTypes.has('file'), true, 'file in externalRefTypes');
  assertEq(restored.exclusionPatterns.length, 2, 'exclusionPatterns count');
  assertEq(restored.exclusionPatterns[0], '%tmp%', 'first exclusionPattern');
});

test('deserializeFilter defaults exclusionPatterns when absent', () => {
  const s: SerializedFilterState = {
    schemas: ['dbo'], types: ['table'], searchTerm: '', hideIsolated: false,
    focusSchemas: [], showExternalRefs: true, externalRefTypes: [],
  };
  const restored = deserializeFilter(s);
  assertEq(restored.exclusionPatterns.length, 0, 'defaults to empty array');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

printSummary('projectStore');
