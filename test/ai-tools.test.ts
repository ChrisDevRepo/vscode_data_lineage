/**
 * Unit tests for src/ai/tools.ts — all 9 pure AI tool functions.
 * Execute with: npx tsx test/ai-tools.test.ts
 * Requires: test/AdventureWorks.dacpac
 */

import { assert, assertEq, testPath, printSummary, loadAdventureWorksModel } from './testUtils';
import { buildBareGraph } from '../src/ai/graphUtils';
import {
  AI_CAPS,
  getContext, getSchemasSummary, searchObjects, getObjectDetail,
  getNeighbors, runBfsTrace, runAnalysis, searchDdl, validateSaveView,
} from '../src/ai/tools';
import { safeRegex } from '../src/utils/modelSearch';
import { addFilterProfile, createProject } from '../src/engine/projectStore';
import type { FilterProfile, ProjectStore } from '../src/engine/projectStore';
import type { DatabaseModel } from '../src/engine/types';
import type Graph from 'graphology';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isError(obj: object): obj is { error: string } {
  return 'error' in obj;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testContextTool(model: DatabaseModel) {
  console.log('\n── getContext ──');
  const ctx = getContext(model, null, 'TestProject', []) as Record<string, unknown>;
  assert(ctx.model_stats !== undefined, 'model_stats present');
  const stats = ctx.model_stats as Record<string, number>;
  assertEq(typeof stats.nodes, 'number', 'model_stats.nodes is number');
  assert(stats.nodes > 0, `model_stats.nodes > 0 (got ${stats.nodes})`);
  assert(stats.edges > 0, `model_stats.edges > 0 (got ${stats.edges})`);
  assert(stats.schemas > 0, `model_stats.schemas > 0 (got ${stats.schemas})`);
  assertEq(ctx.project_name as string, 'TestProject', 'project_name matches');
  assert(ctx.active_filter === null, 'active_filter null when none passed');
  assert(Array.isArray(ctx.saved_views), 'saved_views is array');
}

async function testSchemasSummary(model: DatabaseModel) {
  console.log('\n── getSchemasSummary ──');
  const result = getSchemasSummary(model) as Record<string, unknown>;
  const schemas = result.schemas as Array<Record<string, unknown>>;
  assertEq(schemas.length, 6, 'AdventureWorks has 6 schemas');
  assert(typeof result.total_nodes === 'number', 'total_nodes is number');
  assert(typeof result.total_edges === 'number', 'total_edges is number');

  const dbo = schemas.find(s => s.name === 'dbo');
  assert(dbo !== undefined, 'schema dbo present');

  const humanResources = schemas.find(s => s.name === 'HumanResources');
  assert(humanResources !== undefined, 'schema HumanResources present');
  const hrTables = humanResources?.t as number;
  assert(hrTables > 0, `HumanResources.t > 0 (got ${hrTables})`);
}

async function testSearchObjects(model: DatabaseModel) {
  console.log('\n── searchObjects ──');
  const r1 = searchObjects(model, 'Employee', ['table']) as Record<string, unknown>;
  assert(!isError(r1), 'searchObjects Employee/table: no error');
  const results1 = r1.results as Array<Record<string, unknown>>;
  assert(results1.length > 0, `Employee/table results > 0 (got ${results1.length})`);
  assert(results1.every(n => n.type === 'table'), 'all results are type=table');

  // empty result → hint present
  const r2 = searchObjects(model, 'xyznosuchthing12345') as Record<string, unknown>;
  assert('hint' in r2, 'empty result includes hint');
  assertEq((r2.results as unknown[]).length, 0, 'empty result has 0 results');

  // externalSubtypes filter
  const r3 = searchObjects(model, '', undefined, undefined, ['et']) as Record<string, unknown>;
  assert(!isError(r3), 'externalSubtypes filter: no error');
}

async function testGetObjectDetail(model: DatabaseModel) {
  console.log('\n── getObjectDetail ──');
  // Find [HumanResources].[Employee]
  const node = model.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  assert(node !== undefined, 'HumanResources.Employee node found');
  if (!node) return;

  const detail = getObjectDetail(model, node.id) as Record<string, unknown>;
  assert(!isError(detail), 'getObjectDetail: no error');
  assertEq(detail.id as string, node.id, 'id matches');
  assertEq(detail.schema as string, 'HumanResources', 'schema matches');
  assertEq(detail.name as string, 'Employee', 'name matches');
  assert(detail.columns !== null, 'columns present for table');

  const columns = detail.columns as Array<Record<string, unknown>>;
  assert(columns.length > 0, `columns.length > 0 (got ${columns.length})`);
  assert(columns.every(c => 'n' in c && 't' in c), 'all columns have n (name) and t (type)');
  const pkCols = columns.filter(c => c.pk !== undefined);
  assert(pkCols.length > 0, `at least one PK column (got ${pkCols.length})`);

  // FK list
  assert(detail.foreign_keys !== null, 'foreign_keys present for Employee');

  // not_found error
  const notFound = getObjectDetail(model, '[nonexistent].[ghost]') as Record<string, unknown>;
  assertEq(notFound.error as string, 'not_found', 'unknown id returns not_found error');
}

async function testGetNeighbors(model: DatabaseModel) {
  console.log('\n── getNeighbors ──');
  const node = model.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  if (!node) { assert(false, 'HumanResources.Employee not found'); return; }

  const r = getNeighbors(model, node.id) as Record<string, unknown>;
  assert(!isError(r), 'getNeighbors: no error');
  assertEq(r.id as string, node.id, 'id matches');
  const upArr = r.up as unknown[] | undefined;
  const dnArr = r.dn as unknown[] | undefined;
  assert(upArr === undefined || Array.isArray(upArr), 'up is array or absent');
  assert(dnArr === undefined || Array.isArray(dnArr), 'dn is array or absent');
  assert(
    (upArr?.length ?? 0) + (dnArr?.length ?? 0) > 0,
    'Employee has at least one neighbor',
  );

  // direction filter
  const downOnly = getNeighbors(model, node.id, 'downstream') as Record<string, unknown>;
  assert(Array.isArray(downOnly.dn), 'downstream-only: dn present');
  assert(downOnly.up === undefined, 'downstream-only: up absent');

  // not_found
  const bad = getNeighbors(model, '[ghost].[node]') as Record<string, unknown>;
  assertEq(bad.error as string, 'not_found', 'unknown node returns not_found');
}

async function testRunBfsTrace(model: DatabaseModel, graph: Graph) {
  console.log('\n── runBfsTrace ──');
  const node = model.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  if (!node) { assert(false, 'HumanResources.Employee not found'); return; }

  const r = runBfsTrace(model, graph, node.id, 2, 2) as Record<string, unknown>;
  assert(!isError(r), 'runBfsTrace: no error');
  assert((r.nodes as unknown[]).length > 1, `BFS returned > 1 node (got ${(r.nodes as unknown[]).length})`);
  assert(Array.isArray(r.edges), 'edges is array');

  // edge triples: [source, target, type]
  const edges = r.edges as Array<[string, string, string]>;
  if (edges.length > 0) {
    assert(Array.isArray(edges[0]) && edges[0].length === 3, 'edge is [src, tgt, type] triple');
    const edgeType = edges[0][2];
    assert(edgeType === 'read' || edgeType === 'exec', `edge type is read or exec (got ${edgeType})`);
    assert(edgeType !== 'body', "edge type is never raw 'body' (mapped to 'read')");
  }

  assert('truncated' in r, 'truncated field present');
  assert(typeof r.total_nodes === 'number', 'total_nodes is number');
  assert(typeof r.total_edges === 'number', 'total_edges is number');

  // truncation test: 0 hops → only origin node
  const single = runBfsTrace(model, graph, node.id, 0, 0) as Record<string, unknown>;
  assertEq((single.nodes as unknown[]).length, 1, '0-hop BFS returns only the origin node');

  // not_found
  const bad = runBfsTrace(model, graph, '[ghost].[node]', 1, 1) as Record<string, unknown>;
  assertEq(bad.error as string, 'not_found', 'unknown node returns not_found');
}

async function testRunBfsTruncation(model: DatabaseModel, graph: Graph) {
  console.log('\n── runBfsTrace truncation cap ──');
  // Use max hops on a well-connected node — should trigger cap for large enough graphs
  const allNodes = model.nodes;
  // Try from a hub node with many connections
  let hubId = model.nodes[0].id;
  let maxDegree = 0;
  for (const id of Object.keys(model.neighborIndex)) {
    const n = model.neighborIndex[id];
    const deg = n.in.length + n.out.length;
    if (deg > maxDegree) { maxDegree = deg; hubId = id; }
  }

  const r = runBfsTrace(model, graph, hubId, 10, 10) as Record<string, unknown>;
  assert(!isError(r), 'large BFS: no error');
  assert((r.nodes as unknown[]).length <= AI_CAPS.BFS_MAX_NODES, `nodes capped at ${AI_CAPS.BFS_MAX_NODES}`);
  assert((r.edges as unknown[]).length <= AI_CAPS.BFS_MAX_EDGES, `edges capped at ${AI_CAPS.BFS_MAX_EDGES}`);
  // Whether truncated depends on graph size; just ensure the field is present and boolean
  assert(typeof r.truncated === 'boolean', 'truncated is boolean');
}

async function testRunAnalysis(model: DatabaseModel, graph: Graph) {
  console.log('\n── runAnalysis ──');
  const r = runAnalysis(model, graph, 'orphans') as Record<string, unknown>;
  assert(!isError(r), 'runAnalysis orphans: no error');
  assertEq(r.type as string, 'orphans', 'type matches');
  assert(typeof r.summary === 'string', 'summary is string');
  assert(Array.isArray(r.groups), 'groups is array');
  assert(typeof r.total_groups === 'number', 'total_groups is number');
  assert(typeof r.truncated === 'boolean', 'truncated is boolean');
}

async function testSearchDdl(model: DatabaseModel) {
  console.log('\n── searchDdl ──');
  const r = searchDdl(model, 'Employee') as Record<string, unknown>;
  assert(!isError(r), 'searchDdl Employee: no error');
  const results = r.results as Array<Record<string, unknown>>;
  assert(results.length > 0, `searchDdl Employee: matches found (got ${results.length})`);
  assert(results.every(m => m.matches !== undefined), 'each result has matches');

  // invalid regex syntax
  const bad = searchDdl(model, '[unclosed') as Record<string, unknown>;
  assertEq(bad.error as string, 'invalid_regex', 'invalid regex syntax returns invalid_regex');

  // empty result → hint
  const empty = searchDdl(model, 'xyznosuchthing99999') as Record<string, unknown>;
  assert('hint' in empty, 'empty DDL result includes hint');
}

async function testValidateSaveView(model: DatabaseModel) {
  console.log('\n── validateSaveView ──');
  const node = model.nodes[0];
  const ok = validateSaveView(model, [node.id], 'My View') as Record<string, unknown>;
  assert(ok.success === true, 'valid save: success true');
  assertEq(ok.name as string, 'My View', 'valid save: name matches');
  assert(Array.isArray(ok.node_ids), 'valid save: node_ids is array');

  // empty name
  const noName = validateSaveView(model, [node.id], '') as Record<string, unknown>;
  assert(noName.success === false, 'empty name: success false');

  // name too long
  const longName = validateSaveView(model, [node.id], 'x'.repeat(61)) as Record<string, unknown>;
  assert(longName.success === false, 'name >60 chars: success false');

  // empty node_ids
  const noIds = validateSaveView(model, [], 'Test') as Record<string, unknown>;
  assert(noIds.success === false, 'empty node_ids: success false');

  // unknown node id
  const badIds = validateSaveView(model, ['[ghost].[nothing]'], 'Ghost View') as Record<string, unknown>;
  assert(badIds.success === false, 'unknown id: success false');
  assert(Array.isArray(badIds.errors), 'unknown id: errors array present');
  assert('hint' in badIds, 'unknown id: hint present');

  // Realistic: Person.EmailAddress + neighbors — "EmailAddress Full Lineage"
  const emailNode = model.nodes.find(n => n.schema === 'Person' && n.name === 'EmailAddress');
  assert(emailNode !== undefined, 'Person.EmailAddress node found in model');
  if (emailNode) {
    const nb = model.neighborIndex[emailNode.id];
    const neighborIds = [...(nb?.in ?? []), ...(nb?.out ?? [])].slice(0, 4);
    const lineageIds = [emailNode.id, ...neighborIds];

    const aiResult = validateSaveView(model, lineageIds, 'EmailAddress Full Lineage') as Record<string, unknown>;
    assert(aiResult.success === true, 'EmailAddress lineage: validateSaveView succeeds');
    assertEq(aiResult.name as string, 'EmailAddress Full Lineage', 'EmailAddress lineage: name trimmed and returned');
    const resultIds = aiResult.node_ids as string[];
    assertEq(resultIds.length, lineageIds.length, `EmailAddress lineage: all ${lineageIds.length} node_ids returned`);
    assert(resultIds.includes(emailNode.id), 'EmailAddress lineage: origin node present in node_ids');

    // Verify the FilterProfile that extension.ts would create has source:'ai' and allowlistNodeIds
    const mockStore: ProjectStore = { schemaVersion: 1, projects: [], lastOpenedId: null };
    const project = createProject('Test', { type: 'dacpac', path: 'test.dacpac', dspName: 'Test' });
    const storeWithProject: ProjectStore = { schemaVersion: 1, projects: [project], lastOpenedId: null };
    const profile: FilterProfile = {
      id: 'test-ai-profile',
      name: (aiResult.name as string),
      createdAt: new Date().toISOString(),
      source: 'ai',
      filter: {
        schemas: [],
        types: ['table', 'view', 'procedure', 'function', 'external'],
        searchTerm: '',
        hideIsolated: false,
        focusSchemas: [],
        showExternalRefs: true,
        externalRefTypes: ['file', 'db'],
        exclusionPatterns: [],
        allowlistNodeIds: resultIds,
      },
    };
    const updated = addFilterProfile(storeWithProject, project.id, profile);
    const stored = updated.projects[0].filterProfiles?.find(fp => fp.id === 'test-ai-profile');
    assert(stored !== undefined, 'AI profile stored in project');
    assertEq(stored?.source, 'ai', 'stored profile has source="ai"');
    assert(Array.isArray(stored?.filter.allowlistNodeIds), 'stored profile has allowlistNodeIds array');
    assertEq(stored?.filter.allowlistNodeIds?.length, lineageIds.length, 'stored allowlistNodeIds length matches lineage');
  }
}

async function testSafeRegex() {
  console.log('\n── safeRegex (pattern guard) ──');
  assert(safeRegex('Employee') !== null, 'simple pattern: non-null');
  assert(safeRegex('[A-Z]+') !== null, 'char class pattern: non-null');
  assert(safeRegex('\\w+\\.\\w+') !== null, 'dot-qualified pattern: non-null');
  // Invalid regex syntax must return null
  assert(safeRegex('[unclosed') === null, 'invalid syntax: null');
  assert(safeRegex('(?P<name>x)') === null, 'invalid named capture: null');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══ AI Tools Tests ═══');
  try {
    const model = await loadAdventureWorksModel();
    const graph = buildBareGraph(model);

    await testContextTool(model);
    await testSchemasSummary(model);
    await testSearchObjects(model);
    await testGetObjectDetail(model);
    await testGetNeighbors(model);
    await testRunBfsTrace(model, graph);
    await testRunBfsTruncation(model, graph);
    await testRunAnalysis(model, graph);
    await testSearchDdl(model);
    await testValidateSaveView(model);
    await testSafeRegex();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('AI Tools');
}

main();
