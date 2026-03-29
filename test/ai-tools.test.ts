/**
 * Unit tests for src/ai/tools.ts — 8 pure tool functions + safeRegex.
 * Execute with: npx tsx test/ai-tools.test.ts  OR  npm run test:ai
 * Requires: test/AdventureWorks.dacpac
 */

import { readFileSync } from 'fs';
import { assert, assertEq, testPath, rootPath, printSummary, loadAdventureWorksModel } from './testUtils';
import { buildBareGraph } from '../src/ai/graphUtils';
import {
  AI_CAPS,
  getContext, searchObjects, getObjectDetail,
  runBfsTrace, runAnalysis, searchDdl, getDdlBatch, autoFixCreateAiView, validateCreateAiView,
  validateQuery,
  type CreateAiViewInput,
} from '../src/ai/tools';
import { safeRegex } from '../src/utils/modelSearch';
import { addFilterProfile, createProject } from '../src/engine/projectStore';
import type { FilterProfile, ProjectStore } from '../src/engine/projectStore';
import type { DatabaseModel } from '../src/engine/types';
import type Graph from 'graphology';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isError(obj: object): obj is { error: string } {
  return 'error' in obj && typeof (obj as { error: unknown }).error === 'string';
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
  const schemas = ctx.schemas as Array<Record<string, unknown>>;
  assert(Array.isArray(schemas), 'schemas is array');
  assert(schemas.length > 0, `schemas.length > 0 (got ${schemas.length})`);
  assert(schemas[0].name !== undefined, 'schema has name');
  assertEq(ctx.project_name as string, 'TestProject', 'project_name matches');
  assert(ctx.filter === null, 'filter null when none passed');
  assert(Array.isArray(ctx.saved_views), 'saved_views is array');

  // Small model (AW has 112 nodes < 150 threshold): objects[] includes DDL + columns + edges
  assertEq(ctx.model_size as string, 'small', 'AW is a small model');
  const objects = ctx.objects as Array<Record<string, unknown>>;
  assert(Array.isArray(objects), 'small model: objects[] present');
  assert(objects.length > 0, 'small model: objects not empty');

  // SPs/views/functions should have DDL
  const spObj = objects.find(o => o.t === 'procedure');
  assert(spObj !== undefined, 'small model: has a procedure object');
  assert(typeof spObj?.ddl === 'string' && (spObj.ddl as string).length > 0,
    'small model: procedure has non-empty DDL');

  // Tables should have columns
  const tblObj = objects.find(o => o.t === 'table');
  assert(tblObj !== undefined, 'small model: has a table object');
  assert(Array.isArray(tblObj?.cols), 'small model: table has cols[]');
  const cols = tblObj?.cols as Array<Record<string, unknown>>;
  assert(cols.length > 0, 'small model: table cols not empty');
  assert(cols[0].n !== undefined, 'small model: column has name');

  // Edges included for small model
  const edges = ctx.edges as Array<unknown>;
  assert(Array.isArray(edges), 'small model: edges[] present');
  assert(edges.length > 0, 'small model: edges not empty');
}

async function testSearchObjects(model: DatabaseModel) {
  console.log('\n── searchObjects ──');
  const r1 = searchObjects(model, 'Employee', ['table']) as Record<string, unknown>;
  assert(!isError(r1), 'searchObjects Employee/table: no error');
  const results1 = r1.results as Array<Record<string, unknown>>;
  assert(results1.length > 0, `Employee/table results > 0 (got ${results1.length})`);
  // Results use compact keys: t (type), n (name), s (schema), deg (degree)
  assert(results1.every(n => n.t === 'table'), 'all results are t=table');
  assert(results1.every(n => typeof n.deg === 'number'), 'all results have numeric deg');
  assert(results1.every(n => n.match === 'name'), 'all name results have match=name');

  // empty result → hint present
  const r2 = searchObjects(model, 'xyznosuchthing12345') as Record<string, unknown>;
  assert('action_required' in r2, 'empty result includes action_required');
  assertEq((r2.results as unknown[]).length, 0, 'empty result has 0 results');

  // schemas[] filter — include only HumanResources
  const r3 = searchObjects(model, 'Employee', undefined, ['HumanResources']) as Record<string, unknown>;
  assert(!isError(r3), 'schemas filter: no error');
  const results3 = r3.results as Array<Record<string, unknown>>;
  assert(results3.length > 0, 'schemas filter: found results');
  assert(results3.every(n => n.s === 'HumanResources'), 'schemas filter: all in HumanResources');

  // types[] filter — only tables
  const r4 = searchObjects(model, 'Employee', ['table']) as Record<string, unknown>;
  assert(!isError(r4), 'types filter: no error');
  const results4 = r4.results as Array<Record<string, unknown>>;
  assert(results4.every(n => n.t === 'table'), 'types filter: all tables');

  // mode=regex — multi-pattern
  const r5 = searchObjects(model, 'Employee|Address', undefined, undefined, 'regex') as Record<string, unknown>;
  assert(!isError(r5), 'regex mode: no error');
  const results5 = r5.results as Array<Record<string, unknown>>;
  assert(results5.length > 2, `regex mode: found multiple (got ${results5.length})`);

  // Garbage query rejection (substring mode only)
  const garbage = searchObjects(model, '.') as Record<string, unknown>;
  assert(isError(garbage), 'dot query rejected');
  const star = searchObjects(model, '*') as Record<string, unknown>;
  assert(isError(star), 'star query rejected');
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
  assert(detail.foreign_keys !== null && detail.foreign_keys !== undefined, 'foreign_keys present for Employee');

  // Inline neighbors — up/dn arrays with compact neighbor shape
  const neighbors = model.neighborIndex[node.id] ?? { in: [], out: [] };
  const hasNeighbors = neighbors.in.length + neighbors.out.length > 0;
  if (hasNeighbors) {
    const upArr = detail.up as Array<Record<string, unknown>> | undefined;
    const dnArr = detail.dn as Array<Record<string, unknown>> | undefined;
    assert((upArr?.length ?? 0) + (dnArr?.length ?? 0) > 0, 'Employee has at least one inline neighbor');
    const allNeighbors = [...(upArr ?? []), ...(dnArr ?? [])];
    assert(allNeighbors.every(nb => typeof nb.id === 'string'), 'all neighbors have id');
    assert(allNeighbors.every(nb => typeof nb.n === 'string'), 'all neighbors have n (name)');
    assert(allNeighbors.every(nb => typeof nb.t === 'string'), 'all neighbors have t (type)');
    assert(allNeighbors.every(nb => nb.e === 'read' || nb.e === 'exec'), 'all neighbors have valid e (edge type)');
  }

  // up_more / dn_more only present when cap exceeded
  const upMore = detail.up_more as number | undefined;
  const dnMore = detail.dn_more as number | undefined;
  assert(upMore === undefined || typeof upMore === 'number', 'up_more is number or absent');
  assert(dnMore === undefined || typeof dnMore === 'number', 'dn_more is number or absent');

  // No upstream_count/downstream_count in new shape
  assert(!('upstream_count' in detail), 'upstream_count removed from shape');
  assert(!('downstream_count' in detail), 'downstream_count removed from shape');

  // not_found error
  const notFound = getObjectDetail(model, '[nonexistent].[ghost]') as Record<string, unknown>;
  assertEq(notFound.error as string, 'not_found', 'unknown id returns not_found error');
}

async function testRunBfsTrace(model: DatabaseModel, graph: Graph) {
  console.log('\n── runBfsTrace ──');
  const node = model.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  if (!node) { assert(false, 'HumanResources.Employee not found'); return; }

  // ── include_ddl=false (structure only) ──
  const rStruct = runBfsTrace(model, graph, node.id, 2, 2, undefined, undefined, false) as Record<string, unknown>;
  assert(!isError(rStruct), 'runBfsTrace structure: no error');
  const nodesStruct = rStruct.nodes as Array<Record<string, unknown>>;
  assert(nodesStruct.length > 1, `BFS returned > 1 node (got ${nodesStruct.length})`);
  assert(Array.isArray(rStruct.edges), 'edges is array');
  // Structure-only: nodes must NOT have ddl or cols fields
  assert(nodesStruct.every(n => !('ddl' in n)), 'structure-only: no ddl on any node');
  assert(nodesStruct.every(n => !('cols' in n)), 'structure-only: no cols on any node');
  // All nodes have BFS depth (up or dn)
  assert(nodesStruct.every(n => typeof n.up === 'number' || typeof n.dn === 'number'), 'all nodes have up or dn depth');

  // edge triples: [source, target, type]
  const edges = rStruct.edges as Array<[string, string, string]>;
  if (edges.length > 0) {
    assert(Array.isArray(edges[0]) && edges[0].length === 3, 'edge is [src, tgt, type] triple');
    const edgeType = edges[0][2];
    assert(edgeType === 'read' || edgeType === 'exec', `edge type is read or exec (got ${edgeType})`);
    assert(edgeType !== 'body', "edge type is never raw 'body'");
  }
  assert('truncated' in rStruct, 'truncated field present');
  assert(typeof rStruct.total_nodes === 'number', 'total_nodes is number');
  assert(typeof rStruct.total_edges === 'number', 'total_edges is number');

  // ── include_ddl=true (default) — scriptable nodes get DDL, tables get cols ──
  const rDdl = runBfsTrace(model, graph, node.id, 2, 2) as Record<string, unknown>;
  assert(!isError(rDdl), 'runBfsTrace DDL: no error');
  const nodesDdl = rDdl.nodes as Array<Record<string, unknown>>;
  assert(nodesDdl.length > 0, 'DDL trace: nodes present');

  // Origin node (Employee = table) should have cols
  const originNode = nodesDdl.find(n => n.id === node.id);
  assert(originNode !== undefined, 'origin node present in DDL trace');
  if (originNode && 'cols' in originNode) {
    assert(Array.isArray(originNode.cols), 'table origin has cols array');
    const cols = originNode.cols as Array<Record<string, unknown>>;
    assert(cols.every(c => 'n' in c && 't' in c), 'table cols have n and t');
  }

  // Scriptable nodes (procedure/view/function) have ddl or ddl_too_large
  const scriptableNodes = nodesDdl.filter(n => n.t === 'procedure' || n.t === 'view' || n.t === 'function');
  for (const sn of scriptableNodes) {
    const hasDdl = typeof sn.ddl === 'string';
    const tooLarge = sn.ddl_too_large === true;
    assert(hasDdl || tooLarge, `scriptable node ${sn.id} has ddl or ddl_too_large`);
    if (hasDdl) assert((sn.ddl as string).length > 0, 'ddl non-empty');
  }

  // Table nodes: no ddl field
  const tableNodes = nodesDdl.filter(n => n.t === 'table');
  for (const tn of tableNodes) {
    assert(!('ddl' in tn), `table node ${tn.id} has no ddl field`);
  }

  // ── 0 hops → only origin node ──
  const single = runBfsTrace(model, graph, node.id, 0, 0) as Record<string, unknown>;
  assertEq((single.nodes as unknown[]).length, 1, '0-hop BFS returns only the origin node');

  // ── not_found ──
  const bad = runBfsTrace(model, graph, '[ghost].[node]', 1, 1) as Record<string, unknown>;
  assertEq(bad.error as string, 'not_found', 'unknown node returns not_found');

  // ── schemas[] include filter ──
  const rSchemaFilter = runBfsTrace(model, graph, node.id, 2, 2, undefined, ['dbo']) as Record<string, unknown>;
  assert(!isError(rSchemaFilter), 'schemas filter trace: no error');
  const nodesFiltered = rSchemaFilter.nodes as Array<Record<string, unknown>>;
  assert(nodesFiltered.every(n => n.s === 'dbo'), 'schemas filter: all nodes in dbo');

  // ── types[] include filter ──
  const rTypeFilter = runBfsTrace(model, graph, node.id, 2, 2, ['procedure']) as Record<string, unknown>;
  assert(!isError(rTypeFilter), 'types filter trace: no error');
  const nodesTyped = rTypeFilter.nodes as Array<Record<string, unknown>>;
  assert(nodesTyped.every(n => n.t === 'procedure'), 'types filter: all nodes are procedures');

  // ── Truncation cap: trace from hub node with high hop depth ──
  console.log('\n── runBfsTrace truncation cap ──');
  let hubId = model.nodes[0].id;
  let maxDegree = 0;
  for (const id of Object.keys(model.neighborIndex)) {
    const n = model.neighborIndex[id];
    const deg = n.in.length + n.out.length;
    if (deg > maxDegree) { maxDegree = deg; hubId = id; }
  }
  const rHub = runBfsTrace(model, graph, hubId, 10, 10, undefined, undefined, false) as Record<string, unknown>;
  assert(!isError(rHub), 'large BFS: no error');
  assert((rHub.nodes as unknown[]).length <= AI_CAPS.BFS_MAX_NODES, `nodes capped at ${AI_CAPS.BFS_MAX_NODES}`);
  assert((rHub.edges as unknown[]).length <= AI_CAPS.BFS_MAX_EDGES, `edges capped at ${AI_CAPS.BFS_MAX_EDGES}`);
  assert(typeof rHub.truncated === 'boolean', 'truncated is boolean');
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

async function testValidateCreateAiView(model: DatabaseModel) {
  console.log('\n── validateCreateAiView ──');
  const node = model.nodes[0];

  const VALID_SUMMARY = 'Test graph purpose.';
  const VALID_DESC = '## Analysis\nStructured answer.\n\n## Details\nMore content.';

  // Valid minimal: name + node_ids + summary + description
  const ok = validateCreateAiView(model, { name: 'My View', node_ids: [node.id], summary: VALID_SUMMARY, description: VALID_DESC }) as Record<string, unknown>;
  assert(ok.success === true, 'minimal create: success true');
  assertEq(ok.name as string, 'My View', 'minimal create: name matches');
  assert(Array.isArray(ok.node_ids), 'minimal create: node_ids is array');

  // Empty name
  const noName = validateCreateAiView(model, { name: '', node_ids: [node.id], summary: VALID_SUMMARY, description: VALID_DESC }) as Record<string, unknown>;
  assert(noName.success === false, 'empty name: success false');

  // Name too long
  const longName = validateCreateAiView(model, { name: 'x'.repeat(61), node_ids: [node.id], summary: VALID_SUMMARY, description: VALID_DESC }) as Record<string, unknown>;
  assert(longName.success === false, 'name >60 chars: success false');

  // Empty node_ids
  const noIds = validateCreateAiView(model, { name: 'Test', node_ids: [], summary: VALID_SUMMARY, description: VALID_DESC }) as Record<string, unknown>;
  assert(noIds.success === false, 'empty node_ids: success false');

  // Unknown node id — validation no longer rejects (auto-fix handles it upstream)
  const badIds = validateCreateAiView(model, { name: 'Ghost', node_ids: ['[ghost].[nothing]'], summary: VALID_SUMMARY, description: VALID_DESC }) as Record<string, unknown>;
  assert(badIds.success === true, 'unknown id: validation passes (auto-fix handles upstream)');

  // ── Content validation: summary + description ──

  // Missing summary → rejected
  const noSummary = validateCreateAiView(model, { name: 'Test', node_ids: [node.id], description: VALID_DESC }) as Record<string, unknown>;
  assert(noSummary.success === false, 'missing summary: rejected');

  // Missing description → rejected
  const noDesc = validateCreateAiView(model, { name: 'Test', node_ids: [node.id], summary: VALID_SUMMARY }) as Record<string, unknown>;
  assert(noDesc.success === false, 'missing description: rejected');

  // Single paragraph (no ## or \n\n) → rejected
  const singleParagraph = validateCreateAiView(model, {
    name: 'Test', node_ids: [node.id], summary: VALID_SUMMARY,
    description: 'Revenue flows from staging through transformation to the fact table.',
  }) as Record<string, unknown>;
  assert(singleParagraph.success === false, 'single paragraph description: rejected');

  // Walkthrough prefix → rejected
  const walkthrough = validateCreateAiView(model, {
    name: 'Test', node_ids: [node.id], summary: VALID_SUMMARY,
    description: 'Traces how Revenue is calculated\n\n## Details\nMore...',
  }) as Record<string, unknown>;
  assert(walkthrough.success === false, 'walkthrough prefix: rejected');

  // Multi-paragraph without headings → passes (has \n\n)
  const multiPara = validateCreateAiView(model, {
    name: 'Test', node_ids: [node.id], summary: VALID_SUMMARY,
    description: 'Revenue uses EV methodology.\n\nThe formula applies PlannedValue × EH/PH.',
  }) as Record<string, unknown>;
  assert(multiPara.success === true, 'multi-paragraph without ##: passes');

  // Realistic: Person.EmailAddress + neighbors with description
  const emailNode = model.nodes.find(n => n.schema === 'Person' && n.name === 'EmailAddress');
  assert(emailNode !== undefined, 'Person.EmailAddress node found in model');
  if (emailNode) {
    const nb = model.neighborIndex[emailNode.id];
    const neighborIds = [...(nb?.in ?? []), ...(nb?.out ?? [])].slice(0, 4);
    const lineageIds = [emailNode.id, ...neighborIds];

    const richInput: CreateAiViewInput = {
      name: 'EmailAddress Full Lineage',
      node_ids: lineageIds,
      summary: 'EmailAddress dependency chain in Person schema.',
      description: '## Data Flow\nTraces how EmailAddress dependencies flow through the Person schema.',
    };
    const aiResult = validateCreateAiView(model, richInput) as Record<string, unknown>;
    assert(aiResult.success === true, 'EmailAddress lineage: validateCreateAiView succeeds');
    assertEq(aiResult.name as string, 'EmailAddress Full Lineage', 'EmailAddress lineage: name returned');
    const resultIds = aiResult.node_ids as string[];
    assertEq(resultIds.length, lineageIds.length, `EmailAddress lineage: all ${lineageIds.length} node_ids returned`);
    assert(resultIds.includes(emailNode.id), 'EmailAddress lineage: origin node in node_ids');

    // Verify a FilterProfile built from this result has source:'ai' and allowlistNodeIds
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
  assert(safeRegex('[unclosed') === null, 'invalid syntax: null');
  assert(safeRegex('(?P<name>x)') === null, 'invalid named capture: null');
}

async function testGetDdlBatch(model: DatabaseModel) {
  console.log('\n── getDdlBatch ──');

  const spNode  = model.nodes.find(n => n.type === 'procedure' && n.bodyScript);
  const tblNode = model.nodes.find(n => n.type === 'table');
  assert(spNode !== undefined,  'test requires at least one procedure');
  assert(tblNode !== undefined, 'test requires at least one table');
  if (!spNode || !tblNode) return;

  // Basic batch: one SP + one table + one unknown
  const result = getDdlBatch(model, [spNode.id, tblNode.id, '[ghost].[nope]']) as Record<string, unknown>;
  assert(!('error' in result), 'getDdlBatch: top-level no error');
  assertEq(result.total as number, 3, 'getDdlBatch: total=3');
  assert(typeof result.truncated === 'boolean', 'truncated is boolean');

  const results = result.results as Array<Record<string, unknown>>;
  assertEq(results.length, 3, 'results array has 3 entries');

  const spEntry = results.find(r => r.id === spNode.id);
  assert(spEntry !== undefined, 'SP entry present');
  assertEq(spEntry?.t as string, 'procedure', 'SP entry has t=procedure');
  assert(typeof spEntry?.ddl === 'string' && (spEntry.ddl as string).length > 0, 'SP entry has non-empty ddl');

  const tblEntry = results.find(r => r.id === tblNode.id);
  assert(tblEntry !== undefined, 'table entry present');
  assertEq(tblEntry?.t as string, 'table', 'table entry has t=table');
  assert(!('ddl' in (tblEntry ?? {})), 'table entry has no ddl field');

  const ghostEntry = results.find(r => r.id === '[ghost].[nope]');
  assert(ghostEntry !== undefined, 'ghost entry present');
  assertEq(ghostEntry?.error as string, 'not_found', 'ghost entry has error=not_found');

  // Truncation
  const allIds = model.nodes.map(n => n.id);
  const bigResult = getDdlBatch(model, allIds) as Record<string, unknown>;
  const bigResults = bigResult.results as unknown[];
  assert(bigResults.length <= AI_CAPS.DDL_BATCH_CAP, `results capped at ${AI_CAPS.DDL_BATCH_CAP}`);
  if (allIds.length > AI_CAPS.DDL_BATCH_CAP) {
    assert(bigResult.truncated === true, 'truncated=true when ids exceed cap');
    assert(typeof bigResult.truncation_note === 'string', 'truncation_note present when truncated');
  }

  // Empty batch
  const emptyResult = getDdlBatch(model, []) as Record<string, unknown>;
  assertEq((emptyResult.results as unknown[]).length, 0, 'empty ids: 0 results');
  assert(emptyResult.truncated === false, 'empty ids: not truncated');
}

async function testAutoFixCreateAiView(model: DatabaseModel) {
  console.log('\n── autoFixCreateAiView ──');
  const node = model.nodes[0];
  const node2 = model.nodes[1];

  // Clean input: 0 fixes
  const { input: clean, fixes: noFixes } = autoFixCreateAiView(model, {
    name: 'Clean', node_ids: [node.id],
  });
  assertEq(noFixes.length, 0, 'clean input: 0 fixes');
  assertEq(clean.node_ids.length, 1, 'clean input: node_ids unchanged');

  // Long badge text: passed through (no truncation — UI handles overflow)
  const { input: fixedBadge, fixes: badgeFixes } = autoFixCreateAiView(model, {
    name: 'Test', node_ids: [node.id],
    badges: [{ node_id: node.id, text: 'Step 10 – Aggregate' }],
  });
  assertEq(badgeFixes.length, 0, 'long badge: no fixes (no truncation)');
  assertEq(fixedBadge.badges![0].text, 'Step 10 – Aggregate', 'long badge: text unchanged');

  // Empty notes: dropped
  const { input: fixedNote, fixes: noteFixes } = autoFixCreateAiView(model, {
    name: 'Test', node_ids: [node.id],
    notes: [
      { node_id: node.id, text: 'Valid note' },
      { node_id: node.id, text: '' },
      { node_id: node.id, text: '   ' },
    ],
  });
  assert(noteFixes.length > 0, 'empty notes: fixes reported');
  assertEq(fixedNote.notes!.length, 1, 'empty notes: 2 dropped, 1 kept');

  // Long note text: passed through (no truncation — UI handles overflow)
  const longNoteText = 'x'.repeat(250);
  const { input: fixedLongNote, fixes: longNoteFixes } = autoFixCreateAiView(model, {
    name: 'Test', node_ids: [node.id],
    notes: [{ node_id: node.id, text: longNoteText }],
  });
  assertEq(fixedLongNote.notes![0].text.length, 250, 'long note: text unchanged');
  assertEq(longNoteFixes.length, 0, 'long note: no fixes');

  // Unknown IDs (minority): removed
  const { input: fixedIds, fixes: idFixes } = autoFixCreateAiView(model, {
    name: 'Test', node_ids: [node.id, node2.id, '[ghost].[nothing]'],
  });
  assert(idFixes.length > 0, 'unknown ID minority: fixes reported');
  assertEq(fixedIds.node_ids.length, 2, 'unknown ID minority: ghost removed');

  // Unknown IDs (majority): now removed as long as >= 1 valid ID remains
  const { input: majorityFixed, fixes: majorityFixes } = autoFixCreateAiView(model, {
    name: 'Test', node_ids: ['[ghost].[a]', '[ghost].[b]', node.id],
  });
  assert(majorityFixes.length > 0, 'unknown ID majority: fixes applied');
  assertEq(majorityFixed.node_ids.length, 1, 'unknown ID majority: only valid ID kept');

  // Badges for removed nodes: dropped
  const { input: fixedOrphan, fixes: orphanFixes } = autoFixCreateAiView(model, {
    name: 'Test', node_ids: [node.id, '[ghost].[x]'],
    badges: [
      { node_id: node.id, text: 'Keep' },
      { node_id: '[ghost].[x]', text: 'Drop' },
    ],
  });
  assert(orphanFixes.some(f => f.includes('badge')), 'orphan badge: dropped');
  assertEq(fixedOrphan.badges!.length, 1, 'orphan badge: only valid badge kept');

  // Highlight groups pruned after ID removal
  const { input: fixedHl, fixes: hlFixes } = autoFixCreateAiView(model, {
    name: 'Test', node_ids: [node.id, '[ghost].[x]'],
    highlight_groups: [
      { label: 'All ghosts', color: 'source', node_ids: ['[ghost].[x]'] },
      { label: 'Valid', color: 'target', node_ids: [node.id] },
    ],
  });
  assert(hlFixes.length > 0, 'highlight prune: fixes reported');
  assertEq(fixedHl.highlight_groups!.length, 1, 'highlight prune: ghost group removed');
  assertEq(fixedHl.highlight_groups![0].label, 'Valid', 'highlight prune: valid group kept');

  // Summary passthrough in validate
  const withSummary = validateCreateAiView(model, {
    name: 'Test', node_ids: [node.id],
    summary: 'Revenue lineage from SAP invoices.',
    description: '## Revenue Calculation\nDetailed explanation...',
  }) as Record<string, unknown>;
  assert(withSummary.success === true, 'summary+description: success');
  assertEq(withSummary.summary as string, 'Revenue lineage from SAP invoices.', 'summary: passed through');
  assert((withSummary.description as string).startsWith('## Revenue'), 'description: passed through');

  // Summary truncation in autoFix
  const longSummary = 'x'.repeat(150);
  const { input: fixedSummary, fixes: summaryFixes } = autoFixCreateAiView(model, {
    name: 'Test', node_ids: [node.id], summary: longSummary,
  });
  assert(summaryFixes.length > 0, 'long summary: fixes reported');
  assertEq(fixedSummary.summary!.length, 120, 'long summary: truncated to 120');

  // Short summary: no truncation
  const { fixes: noSummaryFixes } = autoFixCreateAiView(model, {
    name: 'Test', node_ids: [node.id], summary: 'Short summary.',
  });
  assertEq(noSummaryFixes.length, 0, 'short summary: no fixes');

  // End-to-end: auto-fix cleans input, validate passes
  const rawBadInput: CreateAiViewInput = {
    name: 'Revenue Pipeline',
    node_ids: [node.id, '[ghost].[missing]'],
    summary: 'Revenue pipeline from staging to fact tables.',
    description: '## Revenue Flow\nStructured answer.\n\n## Details\nMore.',
    badges: [{ node_id: node.id, text: 'Step 1 – Source Table' }],
    notes: [{ node_id: node.id, text: '' }],
  };
  const { input: autoFixed, fixes: e2eFixes } = autoFixCreateAiView(model, rawBadInput);
  assert(e2eFixes.length > 0, 'e2e: auto-fix applied changes');
  assertEq(autoFixed.node_ids.length, 1, 'e2e: ghost ID removed');
  const fixedValidation = validateCreateAiView(model, autoFixed) as Record<string, unknown>;
  assert(fixedValidation.success === true, 'e2e: auto-fixed input passes validation');

}

async function testValidateQuery() {
  console.log('\n── validateQuery ──');

  assert(validateQuery('Employee').ok === true, 'normal query ok');
  assert(validateQuery('revenue').ok === true, 'revenue ok');
  assert(validateQuery('.').ok === false, 'dot rejected');
  assert(validateQuery('.*').ok === false, '.* rejected');
  assert(validateQuery('').ok === false, 'empty rejected');
  assert(validateQuery('x').ok === false, 'single char rejected');
  assert(validateQuery('ab').ok === true, '2 chars ok');
}

async function testSearchWithSchemas(model: DatabaseModel) {
  console.log('\n── Search with schemas[] param ──');

  // schemas[] filters results to specified schemas
  const result = searchObjects(model, 'Employee', undefined, ['HumanResources']) as Record<string, unknown>;
  assert(!isError(result), 'Employee + schemas=[HR] succeeds');
  const results = result.results as Array<Record<string, unknown>>;
  assert(results.length > 0, 'found results');
  for (const r of results) {
    assertEq(r.s as string, 'HumanResources', `result in HumanResources schema: ${r.n}`);
  }
}

async function testSchemaMismatchDetection(model: DatabaseModel) {
  console.log('\n── Schema Mismatch Detection ──');

  // Schema mismatch: SalesOrderDetail is in Sales, not HumanResources
  const mismatch = searchObjects(model, 'SalesOrderDetail', undefined, ['HumanResources']) as Record<string, unknown>;
  assert(!isError(mismatch), 'mismatch: no error');
  assertEq(mismatch.total, 0, 'mismatch: 0 results in HumanResources');
  assert('schema_mismatch' in mismatch, 'mismatch: schema_mismatch present');
  assert('action_required' in mismatch, 'mismatch: action_required present');
  assert((mismatch.action_required as string).includes('SCHEMA MISMATCH'), 'mismatch: action_required contains directive');
  const mm = mismatch.schema_mismatch as Record<string, unknown>;
  assert((mm.found_in_schemas as string[]).includes('Sales'), 'mismatch: found in Sales');
  assert((mm.fallback_results as unknown[]).length > 0, 'mismatch: fallback results returned');

  // No mismatch when object IS in stated schema
  const noMismatch = searchObjects(model, 'Employee', undefined, ['HumanResources']) as Record<string, unknown>;
  assert(!isError(noMismatch), 'no mismatch: search succeeds');
  assert((noMismatch.results as unknown[]).length > 0, 'no mismatch: found results');
  assert(!('schema_mismatch' in noMismatch), 'no mismatch: field absent');

  // No mismatch without schema filter (plain query)
  const noFilter = searchObjects(model, 'SalesOrderDetail') as Record<string, unknown>;
  assert(!isError(noFilter), 'no filter: search succeeds');
  assert((noFilter.results as unknown[]).length > 0, 'no filter: found results');
  assert(!('schema_mismatch' in noFilter), 'no filter: no mismatch');

  // No mismatch when name doesn't exist anywhere
  const nowhere = searchObjects(model, 'xyznonexistent', undefined, ['HumanResources']) as Record<string, unknown>;
  assertEq(nowhere.total, 0, 'nowhere: 0 results');
  assert(!('schema_mismatch' in nowhere), 'nowhere: no mismatch when name not found anywhere');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
async function testPromptRegression() {
  console.log('\n── Prompt Regression (package.json) ──');
  const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf8'));
  const tools = pkg.contributes.languageModelTools as Array<Record<string, unknown>>;
  assert(Array.isArray(tools), 'languageModelTools is array');

  const createTool = tools.find(t => t.name === 'lineage_create_ai_view') as Record<string, unknown>;
  assert(createTool !== undefined, 'lineage_create_ai_view tool found');

  // summary is required in schema
  const schema = createTool.inputSchema as Record<string, unknown>;
  const required = schema.required as string[];
  assert(required.includes('summary'), 'summary is required in schema');
  assert(required.includes('name'), 'name is required in schema');
  assert(required.includes('node_ids'), 'node_ids is required in schema');

  // modelDescription contains BAD/GOOD and validation warning
  const desc = createTool.modelDescription as string;
  assert(desc.includes('BAD'), 'modelDescription has BAD example');
  assert(desc.includes('GOOD'), 'modelDescription has GOOD example');
  assert(desc.includes('VALIDATED') || desc.includes('REJECTED'), 'modelDescription warns about validation');
  assert(desc.includes('summary'), 'modelDescription mentions summary');
  assert(desc.includes('description'), 'modelDescription mentions description');

  // All tools have tags and when clause
  for (const tool of tools) {
    const tags = tool.tags as string[];
    assert(tags?.includes('lineage'), `${tool.name}: has lineage tag`);
    assertEq(tool.when as string, 'dataLineageViz.modelLoaded', `${tool.name}: has when clause`);
  }

  // summary parameter exists in schema properties
  const props = (schema.properties as Record<string, unknown>);
  assert('summary' in props, 'summary in schema properties');
  assert('description' in props, 'description in schema properties');
}

  console.log('═══ AI Tools Tests ═══');
  try {
    const model = await loadAdventureWorksModel();
    const graph = buildBareGraph(model);

    await testContextTool(model);
    await testSearchObjects(model);
    await testGetObjectDetail(model);
    await testRunBfsTrace(model, graph);
    await testRunAnalysis(model, graph);
    await testSearchDdl(model);
    await testGetDdlBatch(model);
    await testValidateCreateAiView(model);
    await testAutoFixCreateAiView(model);
    await testSafeRegex();
    await testValidateQuery();
    await testSearchWithSchemas(model);
    await testSchemaMismatchDetection(model);
    await testPromptRegression();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('AI Tools');
}

main();
