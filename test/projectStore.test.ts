/**
 * Tests for src/engine/projectStore.ts
 * Covers: createProject, updateProject, deleteProject, migrateProjectStore, generateProjectName
 */

import { assert, assertEq, test, printSummary } from './testUtils';
import {
  createProject,
  updateProject,
  deleteProject,
  migrateProjectStore,
  generateProjectName,
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

test('stores the provided name', () => {
  const p = createProject('My Project', dacpacConn);
  assertEq(p.name, 'My Project', 'name matches');
});

test('stores connection data correctly', () => {
  // Dacpac connection
  const pd = createProject('T', dacpacConn);
  assert(pd.connection.type === 'dacpac', 'type is dacpac');
  const cd = pd.connection as DacpacConnection;
  assertEq(cd.path, dacpacConn.path, 'path matches');
  assertEq(cd.displayName, dacpacConn.displayName, 'displayName matches');
  assertEq(cd.schemas.length, 2, 'schemas length matches');
  // Database connection
  const pdb = createProject('T', dbConn);
  assert(pdb.connection.type === 'database', 'type is database');
  const cdb = pdb.connection as DatabaseConnection;
  assertEq(cdb.sourceName, dbConn.sourceName, 'sourceName matches');
  assertEq(cdb.connectionInfo.server, dbConn.connectionInfo.server, 'server matches');
  assertEq(cdb.connectionInfo.database, dbConn.connectionInfo.database, 'database matches');
  // No sensitive fields
  assert(!('password' in cdb.connectionInfo), 'no password field');
  assert(!('connectionString' in cdb.connectionInfo), 'no connectionString field');
});

// ─── updateProject ────────────────────────────────────────────────────────────

console.log('\n── updateProject ──────────────────────────────────────────────');

test('appends a new project when id is not in store', () => {
  const store = makeStore();
  const p = createProject('New', dacpacConn);
  const next = updateProject(store, p);
  assertEq(next.projects.length, 1, 'one project in store');
  assertEq(next.projects[0].id, p.id, 'project id matches');
});

test('sets lastOpenedId on append', () => {
  const store = makeStore();
  const p = createProject('New', dacpacConn);
  const next = updateProject(store, p);
  assertEq(next.lastOpenedId, p.id, 'lastOpenedId is the new project');
});

test('replaces existing project by id', () => {
  const p = createProject('Original', dacpacConn);
  const store = makeStore([p]);
  const renamed = { ...p, name: 'Renamed', updatedAt: new Date().toISOString() };
  const next = updateProject(store, renamed);
  assertEq(next.projects.length, 1, 'still one project');
  assertEq(next.projects[0].name, 'Renamed', 'name updated');
});

test('preserves id and createdAt when updating', () => {
  const p = createProject('Original', dacpacConn);
  const store = makeStore([p]);
  const updated = { ...p, name: 'New Name', updatedAt: new Date().toISOString() };
  const next = updateProject(store, updated);
  assertEq(next.projects[0].id, p.id, 'id unchanged');
  assertEq(next.projects[0].createdAt, p.createdAt, 'createdAt unchanged');
});

test('sets lastOpenedId when updating existing', () => {
  const p1 = createProject('A', dacpacConn);
  const p2 = createProject('B', dacpacConn);
  const store = makeStore([p1, p2], p2.id);
  const updated = { ...p1, updatedAt: new Date().toISOString() };
  const next = updateProject(store, updated);
  assertEq(next.lastOpenedId, p1.id, 'lastOpenedId switches to updated project');
});

test('preserves other projects when updating one', () => {
  const p1 = createProject('A', dacpacConn);
  const p2 = createProject('B', dacpacConn);
  const store = makeStore([p1, p2]);
  const updated = { ...p1, name: 'A-updated' };
  const next = updateProject(store, updated);
  assertEq(next.projects.length, 2, 'two projects remain');
  assertEq(next.projects.find(p => p.id === p2.id)?.name, 'B', 'p2 unchanged');
});

// ─── deleteProject ────────────────────────────────────────────────────────────

console.log('\n── deleteProject ──────────────────────────────────────────────');

test('removes the correct project', () => {
  const p1 = createProject('A', dacpacConn);
  const p2 = createProject('B', dacpacConn);
  const store = makeStore([p1, p2]);
  const next = deleteProject(store, p1.id);
  assertEq(next.projects.length, 1, 'one project remains');
  assertEq(next.projects[0].id, p2.id, 'remaining project is p2');
});

test('leaves other projects untouched', () => {
  const p1 = createProject('A', dacpacConn);
  const p2 = createProject('B', dacpacConn);
  const p3 = createProject('C', dacpacConn);
  const store = makeStore([p1, p2, p3]);
  const next = deleteProject(store, p2.id);
  assertEq(next.projects.length, 2, 'two projects remain');
  assert(next.projects.some(p => p.id === p1.id), 'p1 remains');
  assert(next.projects.some(p => p.id === p3.id), 'p3 remains');
});

test('handles deleting nonexistent id gracefully', () => {
  const p = createProject('A', dacpacConn);
  const store = makeStore([p]);
  const next = deleteProject(store, 'nonexistent-id');
  assertEq(next.projects.length, 1, 'project count unchanged');
});

test('clears lastOpenedId when deleted project was last opened and no others exist', () => {
  const p = createProject('A', dacpacConn);
  const store = makeStore([p], p.id);
  const next = deleteProject(store, p.id);
  assertEq(next.lastOpenedId, null, 'lastOpenedId is null');
});

test('updates lastOpenedId to another project when last opened is deleted', () => {
  const p1 = createProject('A', dacpacConn);
  const p2 = createProject('B', dacpacConn);
  const store = makeStore([p1, p2], p1.id);
  const next = deleteProject(store, p1.id);
  assertEq(next.lastOpenedId, p2.id, 'lastOpenedId falls back to p2');
});

test('preserves lastOpenedId when a different project is deleted', () => {
  const p1 = createProject('A', dacpacConn);
  const p2 = createProject('B', dacpacConn);
  const store = makeStore([p1, p2], p2.id);
  const next = deleteProject(store, p1.id);
  assertEq(next.lastOpenedId, p2.id, 'lastOpenedId unchanged');
});

test('returns empty store when last project is deleted', () => {
  const p = createProject('A', dacpacConn);
  const store = makeStore([p], p.id);
  const next = deleteProject(store, p.id);
  assertEq(next.projects.length, 0, 'no projects');
  assertEq(next.lastOpenedId, null, 'lastOpenedId null');
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

test('returns identity for valid v1 data with dacpac project', () => {
  const proj = createProject('AW', dacpacConn);
  const raw = { schemaVersion: 1, projects: [proj], lastOpenedId: proj.id };
  const s = migrateProjectStore(raw);
  assertEq(s.projects.length, 1, 'one project');
  assertEq(s.projects[0].id, proj.id, 'project id preserved');
  assertEq(s.lastOpenedId, proj.id, 'lastOpenedId preserved');
});

test('returns identity for valid v1 data with database project', () => {
  const proj = createProject('DB', dbConn);
  const raw = { schemaVersion: 1, projects: [proj], lastOpenedId: null };
  const s = migrateProjectStore(raw);
  assertEq(s.projects.length, 1, 'one project');
  const c = s.projects[0].connection as DatabaseConnection;
  assertEq(c.sourceName, dbConn.sourceName, 'sourceName preserved');
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

// ─── generateProjectName ──────────────────────────────────────────────────────

console.log('\n── generateProjectName ────────────────────────────────────────');

test('uses connection display name as prefix', () => {
  const dacName = generateProjectName(dacpacConn);
  assert(dacName.startsWith('AdventureWorks '), 'dacpac: starts with displayName');
  const dbName = generateProjectName(dbConn);
  assert(dbName.startsWith('SalesDB (myserver) '), 'database: starts with sourceName');
});

test('timestamp format is YYYY-MM-DD HH:mm without seconds', () => {
  const n1 = generateProjectName(dacpacConn);
  const n2 = generateProjectName(dacpacConn);
  assert(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(n1), 'ends with YYYY-MM-DD HH:mm');
  assert(!/\d{2}:\d{2}:\d{2}/.test(n1), 'no seconds in timestamp');
  const ts1 = n1.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/)![1];
  const ts2 = n2.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/)![1];
  assertEq(ts1, ts2, 'same-minute calls share timestamp');
});

// ─── serializeFilter / deserializeFilter ──────────────────────────────────────

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

test('serializeFilter converts Sets to arrays and preserves values', () => {
  const s = serializeFilter(sampleFilter);
  // Structure: Sets become arrays
  assert(Array.isArray(s.schemas), 'schemas is array');
  assert(Array.isArray(s.types), 'types is array');
  assert(Array.isArray(s.focusSchemas), 'focusSchemas is array');
  assert(Array.isArray(s.externalRefTypes), 'externalRefTypes is array');
  // Values preserved
  assertEq([...s.schemas].sort().join(','), 'Sales,dbo', 'schemas preserved');
  assertEq([...s.types].sort().join(','), 'table,view', 'types preserved');
  assertEq(s.searchTerm, 'Order', 'searchTerm preserved');
  assertEq(s.hideIsolated, false, 'hideIsolated preserved');
  assertEq(s.focusSchemas.join(','), 'dbo', 'focusSchemas preserved');
  assertEq(s.showExternalRefs, true, 'showExternalRefs preserved');
  assertEq(s.externalRefTypes.join(','), 'file', 'externalRefTypes preserved');
  assertEq(s.exclusionPatterns?.join(','), '%tmp%,^etl\\.', 'exclusionPatterns preserved');
  // Deserialize restores Sets
  const restored = deserializeFilter(s);
  assert(restored.schemas instanceof Set, 'schemas is Set');
  assert(restored.types instanceof Set, 'types is Set');
  assert(restored.focusSchemas instanceof Set, 'focusSchemas is Set');
  assert(restored.externalRefTypes instanceof Set, 'externalRefTypes is Set');
});

test('roundtrip: serialize then deserialize is identity', () => {
  const s = serializeFilter(sampleFilter);
  const restored = deserializeFilter(s);
  assertEq(restored.searchTerm, sampleFilter.searchTerm, 'searchTerm roundtrip');
  assertEq(restored.hideIsolated, sampleFilter.hideIsolated, 'hideIsolated roundtrip');
  assertEq(restored.showExternalRefs, sampleFilter.showExternalRefs, 'showExternalRefs roundtrip');
  assertEq(restored.schemas.has('dbo'), true, 'dbo in schemas');
  assertEq(restored.schemas.has('Sales'), true, 'Sales in schemas');
  assertEq(restored.types.has('table'), true, 'table in types');
  assertEq(restored.focusSchemas.has('dbo'), true, 'dbo in focusSchemas');
  assertEq(restored.externalRefTypes.has('file'), true, 'file in externalRefTypes');
  assertEq(restored.exclusionPatterns[0], '%tmp%', 'first exclusionPattern roundtrip');
  assertEq(restored.exclusionPatterns.length, 2, 'exclusionPatterns count roundtrip');
});

test('deserializeFilter defaults exclusionPatterns when absent', () => {
  const s: SerializedFilterState = {
    schemas: ['dbo'], types: ['table'], searchTerm: '', hideIsolated: false,
    focusSchemas: [], showExternalRefs: true, externalRefTypes: [],
    // No exclusionPatterns field
  };
  const restored = deserializeFilter(s);
  assertEq(restored.exclusionPatterns.length, 0, 'defaults to empty array');
});

// ─── addFilterProfile ──────────────────────────────────────────────────────────

const storeForViews: ProjectStore = {
  schemaVersion: 1,
  projects: [{ ...createProject('Test', dacpacConn), id: 'proj-1' }],
  lastOpenedId: 'proj-1',
};

const fp1: FilterProfile = {
  id: 'fp-1',
  name: 'Sales Focus',
  createdAt: '2026-01-01T00:00:00.000Z',
  filter: serializeFilter(sampleFilter),
};

const fp2: FilterProfile = {
  id: 'fp-2',
  name: 'All Types',
  createdAt: '2026-01-02T00:00:00.000Z',
  filter: serializeFilter({ ...sampleFilter, searchTerm: '' }),
};

test('addFilterProfile adds a profile to the project', () => {
  const updated = addFilterProfile(storeForViews, 'proj-1', fp1);
  const profiles = updated.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles.length, 1, 'one profile added');
  assertEq(profiles[0].id, 'fp-1', 'profile id matches');
  assertEq(profiles[0].name, 'Sales Focus', 'profile name matches');
});

test('addFilterProfile appends multiple profiles', () => {
  const s1 = addFilterProfile(storeForViews, 'proj-1', fp1);
  const s2 = addFilterProfile(s1, 'proj-1', fp2);
  const profiles = s2.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles.length, 2, 'two profiles');
});

test('addFilterProfile replaces existing profile with same id', () => {
  const s1 = addFilterProfile(storeForViews, 'proj-1', fp1);
  const updated = { ...fp1, name: 'Renamed' };
  const s2 = addFilterProfile(s1, 'proj-1', updated);
  const profiles = s2.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles.length, 1, 'still one profile (replaced)');
  assertEq(profiles[0].name, 'Renamed', 'name updated');
});

test('addFilterProfile does not affect other projects', () => {
  const storeTwo: ProjectStore = {
    schemaVersion: 1,
    projects: [
      { ...createProject('P1', dacpacConn), id: 'proj-1' },
      { ...createProject('P2', dbConn), id: 'proj-2' },
    ],
    lastOpenedId: 'proj-1',
  };
  const updated = addFilterProfile(storeTwo, 'proj-1', fp1);
  const p2Profiles = updated.projects.find(p => p.id === 'proj-2')?.filterProfiles;
  assert(!p2Profiles || p2Profiles.length === 0, 'other project unaffected');
});

test('addFilterProfile on unknown projectId is a no-op', () => {
  const updated = addFilterProfile(storeForViews, 'no-such-id', fp1);
  assertEq(updated.projects.length, storeForViews.projects.length, 'project count unchanged');
  const proj = updated.projects[0];
  assert(!proj.filterProfiles || proj.filterProfiles.length === 0, 'no profiles added');
});

// ─── deleteFilterProfile ──────────────────────────────────────────────────────

test('deleteFilterProfile removes the profile', () => {
  const s1 = addFilterProfile(storeForViews, 'proj-1', fp1);
  const s2 = addFilterProfile(s1, 'proj-1', fp2);
  const s3 = deleteFilterProfile(s2, 'proj-1', 'fp-1');
  const profiles = s3.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles.length, 1, 'one profile remaining');
  assertEq(profiles[0].id, 'fp-2', 'correct profile remains');
});

test('deleteFilterProfile on unknown profileId is a no-op', () => {
  const s1 = addFilterProfile(storeForViews, 'proj-1', fp1);
  const s2 = deleteFilterProfile(s1, 'proj-1', 'no-such-fp');
  const profiles = s2.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles.length, 1, 'profile count unchanged');
});

test('deleteFilterProfile leaves empty array when last profile removed', () => {
  const s1 = addFilterProfile(storeForViews, 'proj-1', fp1);
  const s2 = deleteFilterProfile(s1, 'proj-1', 'fp-1');
  const profiles = s2.projects.find(p => p.id === 'proj-1')?.filterProfiles ?? [];
  assertEq(profiles.length, 0, 'empty array after removing last');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

printSummary('projectStore');
