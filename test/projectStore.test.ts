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
} from '../src/engine/projectStore';
import type {
  ProjectStore,
  Project,
  DacpacConnection,
  DatabaseConnection,
} from '../src/engine/projectStore';

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

test('sets a non-empty string id', () => {
  const p = createProject('Test', dacpacConn);
  assert(typeof p.id === 'string' && p.id.length > 0, 'id is non-empty string');
});

test('generates unique ids on successive calls', () => {
  const p1 = createProject('A', dacpacConn);
  const p2 = createProject('B', dacpacConn);
  assert(p1.id !== p2.id, 'ids are distinct');
});

test('sets createdAt to an ISO 8601 string', () => {
  const before = Date.now();
  const p = createProject('T', dacpacConn);
  const after = Date.now();
  const ts = new Date(p.createdAt).getTime();
  assert(!isNaN(ts), 'createdAt is parseable');
  assert(ts >= before && ts <= after, 'createdAt is within call window');
});

test('sets updatedAt equal to createdAt on creation', () => {
  const p = createProject('T', dacpacConn);
  assertEq(p.updatedAt, p.createdAt, 'updatedAt equals createdAt');
});

test('stores the provided name', () => {
  const p = createProject('My Project', dacpacConn);
  assertEq(p.name, 'My Project', 'name matches');
});

test('stores a dacpac connection', () => {
  const p = createProject('T', dacpacConn);
  assert(p.connection.type === 'dacpac', 'type is dacpac');
  const c = p.connection as DacpacConnection;
  assertEq(c.path, dacpacConn.path, 'path matches');
  assertEq(c.displayName, dacpacConn.displayName, 'displayName matches');
  assertEq(c.schemas.length, 2, 'schemas length matches');
});

test('stores a database connection', () => {
  const p = createProject('T', dbConn);
  assert(p.connection.type === 'database', 'type is database');
  const c = p.connection as DatabaseConnection;
  assertEq(c.sourceName, dbConn.sourceName, 'sourceName matches');
  assertEq(c.connectionInfo.server, dbConn.connectionInfo.server, 'server matches');
  assertEq(c.connectionInfo.database, dbConn.connectionInfo.database, 'database matches');
});

test('stored connection info has no password field', () => {
  const p = createProject('T', dbConn);
  const c = p.connection as DatabaseConnection;
  assert(!('password' in c.connectionInfo), 'no password field');
  assert(!('connectionString' in c.connectionInfo), 'no connectionString field');
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

test('returns empty store for null input', () => {
  const s = migrateProjectStore(null);
  assertEq(s.schemaVersion, 1, 'schemaVersion 1');
  assertEq(s.projects.length, 0, 'no projects');
  assertEq(s.lastOpenedId, null, 'lastOpenedId null');
});

test('returns empty store for undefined input', () => {
  const s = migrateProjectStore(undefined);
  assertEq(s.projects.length, 0, 'no projects');
});

test('returns empty store for non-object input', () => {
  const s = migrateProjectStore('string-value');
  assertEq(s.projects.length, 0, 'no projects');
});

test('returns empty store for unknown schemaVersion', () => {
  const s = migrateProjectStore({ schemaVersion: 99, projects: [], lastOpenedId: null });
  assertEq(s.projects.length, 0, 'no projects (version unknown)');
});

test('returns empty store when projects is not an array', () => {
  const s = migrateProjectStore({ schemaVersion: 1, projects: 'oops', lastOpenedId: null });
  assertEq(s.projects.length, 0, 'no projects');
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

test('filters out malformed project entries (missing id)', () => {
  const valid = createProject('OK', dacpacConn);
  const bad = { name: 'Missing id', createdAt: 'x', updatedAt: 'x', connection: dacpacConn };
  const raw = { schemaVersion: 1, projects: [valid, bad], lastOpenedId: null };
  const s = migrateProjectStore(raw);
  assertEq(s.projects.length, 1, 'only valid project retained');
  assertEq(s.projects[0].id, valid.id, 'valid project preserved');
});

test('filters out malformed project entries (invalid connection type)', () => {
  const valid = createProject('OK', dacpacConn);
  const bad = { id: 'x', name: 'Bad conn', createdAt: 'x', updatedAt: 'x', connection: { type: 'ftp', host: 'foo' } };
  const raw = { schemaVersion: 1, projects: [valid, bad], lastOpenedId: null };
  const s = migrateProjectStore(raw);
  assertEq(s.projects.length, 1, 'only valid project retained');
});

test('filters out malformed project entries (dacpac missing path)', () => {
  const bad = {
    id: 'bad', name: 'Bad', createdAt: 'x', updatedAt: 'x',
    connection: { type: 'dacpac', displayName: 'AW', schemas: [] },  // no path
  };
  const raw = { schemaVersion: 1, projects: [bad], lastOpenedId: null };
  const s = migrateProjectStore(raw);
  assertEq(s.projects.length, 0, 'malformed dacpac filtered out');
});

test('treats null lastOpenedId gracefully', () => {
  const s = migrateProjectStore({ schemaVersion: 1, projects: [], lastOpenedId: null });
  assertEq(s.lastOpenedId, null, 'null preserved');
});

test('ignores non-string lastOpenedId', () => {
  const s = migrateProjectStore({ schemaVersion: 1, projects: [], lastOpenedId: 42 });
  assertEq(s.lastOpenedId, null, 'non-string lastOpenedId becomes null');
});

// ─── generateProjectName ──────────────────────────────────────────────────────

console.log('\n── generateProjectName ────────────────────────────────────────');

test('dacpac name uses displayName as prefix', () => {
  const name = generateProjectName(dacpacConn);
  assert(name.startsWith('AdventureWorks '), 'starts with displayName');
});

test('database name uses sourceName as prefix', () => {
  const name = generateProjectName(dbConn);
  assert(name.startsWith('SalesDB (myserver) '), 'starts with sourceName');
});

test('name contains a timestamp in YYYY-MM-DD HH:mm format', () => {
  const name = generateProjectName(dacpacConn);
  // Timestamp pattern: " 2026-03-24 14:35"
  assert(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(name), 'ends with timestamp');
});

test('two calls within same minute produce identical timestamp suffix', () => {
  // Both calls happen within the same second, so same minute
  const n1 = generateProjectName(dacpacConn);
  const n2 = generateProjectName(dacpacConn);
  const ts1 = n1.slice(-16);  // last 16 chars = "YYYY-MM-DD HH:mm"
  const ts2 = n2.slice(-16);
  assertEq(ts1, ts2, 'same-minute calls share timestamp');
});

test('does not include seconds in timestamp', () => {
  const name = generateProjectName(dacpacConn);
  // HH:mm:ss would be 19 chars after the date separator; HH:mm is 16
  assert(!/\d{2}:\d{2}:\d{2}/.test(name), 'no seconds in timestamp');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

printSummary('projectStore');
