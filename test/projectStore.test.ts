/**
 * Tests for src/engine/projectStore.ts
 * Covers: createProject, updateProject, deleteProject, migrateProjectStore,
 *         serializeFilter/deserializeFilter roundtrips
 */

import { assert, assertEq, test, printSummary } from './testUtils';
import {
  createProject,
  updateProject,
  deleteProject,
  migrateProjectStore,
  addFilterProfile,
  deleteFilterProfile,
  serializeFilter,
  deserializeFilter,
} from '../src/engine/projectStore';
import type {
  ProjectStore,
  Project,
  DacpacConnection,
  DatabaseConnection,
  FilterProfile,
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

function makeStore(projects: Project[] = [], lastOpenedId: string | null = null): ProjectStore {
  return { schemaVersion: 1, projects, lastOpenedId };
}

// ─── createProject ────────────────────────────────────────────────────────────

console.log('\n── createProject ──────────────────────────────────────────────');

test('generates unique non-empty ids', () => {
  const p1 = createProject('A', dacpacConn);
  const p2 = createProject('B', dacpacConn);
  assert(typeof p1.id === 'string' && p1.id.length > 0, 'id is non-empty string');
  assert(p1.id !== p2.id, 'ids are distinct');
});

test('timestamps are correct on creation', () => {
  const before = Date.now();
  const p = createProject('T', dacpacConn);
  const after = Date.now();
  const ts = new Date(p.createdAt).getTime();
  assert(!isNaN(ts), 'createdAt is parseable');
  assert(ts >= before && ts <= after, 'createdAt is within call window');
  assertEq(p.updatedAt, p.createdAt, 'updatedAt equals createdAt');
});

// ─── deleteProject: lastOpenedId fallback ────────────────────────────────────

console.log('\n── deleteProject ──────────────────────────────────────────────');

test('clears lastOpenedId when deleted project was last opened and no others exist', () => {
  const p = createProject('A', dacpacConn);
  const next = deleteProject(makeStore([p], p.id), p.id);
  assertEq(next.lastOpenedId, null, 'lastOpenedId is null');
  assertEq(next.projects.length, 0, 'no projects');
});

test('falls back lastOpenedId to another project when last opened is deleted', () => {
  const p1 = createProject('A', dacpacConn);
  const p2 = createProject('B', dacpacConn);
  const next = deleteProject(makeStore([p1, p2], p1.id), p1.id);
  assertEq(next.lastOpenedId, p2.id, 'lastOpenedId falls back to p2');
  assertEq(next.projects.length, 1, 'one project remains');
});

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

test('handles lastOpenedId edge cases', () => {
  const s1 = migrateProjectStore({ schemaVersion: 1, projects: [], lastOpenedId: null });
  assertEq(s1.lastOpenedId, null, 'null preserved');
  const s2 = migrateProjectStore({ schemaVersion: 1, projects: [], lastOpenedId: 42 });
  assertEq(s2.lastOpenedId, null, 'non-string lastOpenedId becomes null');
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

// ─── addFilterProfile / deleteFilterProfile ──────────────────────────────────

console.log('\n── addFilterProfile / deleteFilterProfile ─────────────────────');

test('filter profile lifecycle: add, replace, delete', () => {
  const store: ProjectStore = {
    schemaVersion: 1,
    projects: [{ ...createProject('Test', dacpacConn), id: 'proj-1' }],
    lastOpenedId: 'proj-1',
  };
  const fp1: FilterProfile = {
    id: 'fp-1', name: 'Sales Focus', createdAt: '2026-01-01T00:00:00.000Z',
    filter: serializeFilter(sampleFilter),
  };
  const fp2: FilterProfile = {
    id: 'fp-2', name: 'All Types', createdAt: '2026-01-02T00:00:00.000Z',
    filter: serializeFilter({ ...sampleFilter, searchTerm: '' }),
  };

  // Add two profiles
  const s1 = addFilterProfile(store, 'proj-1', fp1);
  const s2 = addFilterProfile(s1, 'proj-1', fp2);
  const profiles2 = s2.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles2.length, 2, 'two profiles after adds');

  // Replace fp1
  const s3 = addFilterProfile(s2, 'proj-1', { ...fp1, name: 'Renamed' });
  const profiles3 = s3.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles3.length, 2, 'still two profiles after replace');
  assertEq(profiles3.find(p => p.id === 'fp-1')?.name, 'Renamed', 'name updated');

  // Delete fp1
  const s4 = deleteFilterProfile(s3, 'proj-1', 'fp-1');
  const profiles4 = s4.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles4.length, 1, 'one profile after delete');
  assertEq(profiles4[0].id, 'fp-2', 'correct profile remains');

  // Delete last profile
  const s5 = deleteFilterProfile(s4, 'proj-1', 'fp-2');
  const profiles5 = s5.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles5.length, 0, 'empty after removing last');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

printSummary('projectStore');
