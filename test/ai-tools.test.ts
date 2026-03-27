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
  runBfsTrace, runAnalysis, searchDdl, getDdlBatch, validateCreateAiView,
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
  assert(stats.schemas > 0, `model_stats.schemas > 0 (got ${stats.schemas})`);
  assertEq(ctx.project_name as string, 'TestProject', 'project_name matches');
  assert(ctx.filter === null, 'filter null when none passed');
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
  // Results use compact keys: t (type), n (name), s (schema), deg (degree)
  assert(results1.every(n => n.t === 'table'), 'all results are t=table');
  assert(results1.every(n => typeof n.deg === 'number'), 'all results have numeric deg');
  assert(results1.every(n => n.match === 'name'), 'all name results have match=name');

  // empty result → hint present
  const r2 = searchObjects(model, 'xyznosuchthing12345') as Record<string, unknown>;
  assert('hint' in r2, 'empty result includes hint');
  assertEq((r2.results as unknown[]).length, 0, 'empty result has 0 results');

  // externalSubtypes filter
  const r3 = searchObjects(model, '', undefined, undefined, ['et']) as Record<string, unknown>;
  assert(!isError(r3), 'externalSubtypes filter: no error');

  // include_body — body hits include match='body' and snippet
  const r4 = searchObjects(model, 'Employee', undefined, undefined, undefined, true) as Record<string, unknown>;
  assert(!isError(r4), 'include_body search: no error');
  const results4 = r4.results as Array<Record<string, unknown>>;
  assert(results4.length > 0, `include_body Employee results > 0 (got ${results4.length})`);
  const bodyHits = results4.filter(n => n.match === 'body');
  const nameHits = results4.filter(n => n.match === 'name');
  assert(nameHits.length > 0, 'include_body: name hits present');
  if (bodyHits.length > 0) {
    assert(bodyHits.every(n => typeof n.snippet === 'string'), 'body hits have snippet');
  }

  // exclude_schemas — SQL LIKE: exclude HumanResources schema, verify none appear
  const r5 = searchObjects(model, 'Employee', undefined, undefined, undefined, false, ['HumanResources']) as Record<string, unknown>;
  assert(!isError(r5), 'exclude_schemas search: no error');
  const results5 = r5.results as Array<Record<string, unknown>>;
  assert(results5.every(n => n.s !== 'HumanResources'), 'exclude_schemas: no HumanResources results');

  // exclude_schemas SQL LIKE pattern: '%Human%' should also exclude HumanResources
  const r6 = searchObjects(model, 'Employee', undefined, undefined, undefined, false, ['%Human%']) as Record<string, unknown>;
  const results6 = r6.results as Array<Record<string, unknown>>;
  assert(results6.every(n => !(n.s as string).toLowerCase().includes('human')), 'exclude_schemas LIKE %Human%: no human* schemas');

  // exclude_types — exclude 'table': only non-table results
  const r7 = searchObjects(model, 'Employee', undefined, undefined, undefined, false, undefined, ['table']) as Record<string, unknown>;
  const results7 = r7.results as Array<Record<string, unknown>>;
  assert(results7.every(n => n.t !== 'table'), 'exclude_types table: no table results');
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
  console.log('\n── runBfsTrace (structure + DDL) ──');
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
  const rDdl = runBfsTrace(model, graph, node.id, 2, 2) as Record<string, unknown>; // default includeDdl=true
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

  // ── exclude_schemas SQL LIKE: trace then exclude HumanResources ──
  const rExcludeSchema = runBfsTrace(model, graph, node.id, 2, 2, undefined, undefined, false, ['HumanResources']) as Record<string, unknown>;
  assert(!isError(rExcludeSchema), 'exclude_schemas trace: no error');
  const nodesExcl = rExcludeSchema.nodes as Array<Record<string, unknown>>;
  // Origin (HumanResources.Employee) itself is excluded — so it should be absent
  const hasHRNodes = nodesExcl.some(n => n.s === 'HumanResources');
  assert(!hasHRNodes, 'exclude_schemas HumanResources: no HR nodes in result');
  // excluded_count and excluded_note present when nodes were removed
  assert(typeof rExcludeSchema.excluded_count === 'number' && (rExcludeSchema.excluded_count as number) > 0,
    'excluded_count > 0 when exclusions applied');
  assert(typeof rExcludeSchema.excluded_note === 'string', 'excluded_note present when exclusions applied');

  // ── exclude_schemas SQL LIKE pattern: '%Human%' same effect ──
  const rExcludePattern = runBfsTrace(model, graph, node.id, 2, 2, undefined, undefined, false, ['%Human%']) as Record<string, unknown>;
  const nodesExclPattern = rExcludePattern.nodes as Array<Record<string, unknown>>;
  assert(nodesExclPattern.every(n => !(n.s as string ?? '').toLowerCase().includes('human')),
    'exclude_schemas LIKE %Human%: no human* schema nodes');

  // ── exclude_types: exclude 'table' ──
  const rExcludeType = runBfsTrace(model, graph, node.id, 2, 2, undefined, undefined, false, undefined, ['table']) as Record<string, unknown>;
  const nodesExclType = rExcludeType.nodes as Array<Record<string, unknown>>;
  assert(nodesExclType.every(n => n.t !== 'table'), 'exclude_types table: no table nodes');

  // ── No excluded_count when no exclusions ──
  const rNoExcl = runBfsTrace(model, graph, node.id, 1, 1, undefined, undefined, false) as Record<string, unknown>;
  assert(!('excluded_count' in rNoExcl), 'no excluded_count when no exclusions applied');
}

async function testRunBfsTruncation(model: DatabaseModel, graph: Graph) {
  console.log('\n── runBfsTrace truncation cap ──');
  let hubId = model.nodes[0].id;
  let maxDegree = 0;
  for (const id of Object.keys(model.neighborIndex)) {
    const n = model.neighborIndex[id];
    const deg = n.in.length + n.out.length;
    if (deg > maxDegree) { maxDegree = deg; hubId = id; }
  }

  const r = runBfsTrace(model, graph, hubId, 10, 10, undefined, undefined, false) as Record<string, unknown>;
  assert(!isError(r), 'large BFS: no error');
  assert((r.nodes as unknown[]).length <= AI_CAPS.BFS_MAX_NODES, `nodes capped at ${AI_CAPS.BFS_MAX_NODES}`);
  assert((r.edges as unknown[]).length <= AI_CAPS.BFS_MAX_EDGES, `edges capped at ${AI_CAPS.BFS_MAX_EDGES}`);
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

async function testValidateCreateAiView(model: DatabaseModel) {
  console.log('\n── validateCreateAiView ──');
  const node = model.nodes[0];

  // Valid minimal: name + node_ids only (no narrative, highlights, or badges)
  const ok = validateCreateAiView(model, { name: 'My View', node_ids: [node.id] }) as Record<string, unknown>;
  assert(ok.success === true, 'minimal create: success true');
  assertEq(ok.name as string, 'My View', 'minimal create: name matches');
  assert(Array.isArray(ok.node_ids), 'minimal create: node_ids is array');

  // Empty name
  const noName = validateCreateAiView(model, { name: '', node_ids: [node.id] }) as Record<string, unknown>;
  assert(noName.success === false, 'empty name: success false');

  // Name too long
  const longName = validateCreateAiView(model, { name: 'x'.repeat(61), node_ids: [node.id] }) as Record<string, unknown>;
  assert(longName.success === false, 'name >60 chars: success false');

  // Empty node_ids
  const noIds = validateCreateAiView(model, { name: 'Test', node_ids: [] }) as Record<string, unknown>;
  assert(noIds.success === false, 'empty node_ids: success false');

  // Unknown node id
  const badIds = validateCreateAiView(model, { name: 'Ghost', node_ids: ['[ghost].[nothing]'] }) as Record<string, unknown>;
  assert(badIds.success === false, 'unknown id: success false');
  assert(Array.isArray(badIds.errors), 'unknown id: errors array present');
  assert('hint' in badIds, 'unknown id: hint present');

  // Realistic: Person.EmailAddress + neighbors with narrative
  const emailNode = model.nodes.find(n => n.schema === 'Person' && n.name === 'EmailAddress');
  assert(emailNode !== undefined, 'Person.EmailAddress node found in model');
  if (emailNode) {
    const nb = model.neighborIndex[emailNode.id];
    const neighborIds = [...(nb?.in ?? []), ...(nb?.out ?? [])].slice(0, 4);
    const lineageIds = [emailNode.id, ...neighborIds];

    const richInput: CreateAiViewInput = {
      name: 'EmailAddress Full Lineage',
      node_ids: lineageIds,
      narrative: 'Traces all dependencies of the EmailAddress table.',
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
    await testRunBfsTrace(model, graph);
    await testRunBfsTruncation(model, graph);
    await testRunAnalysis(model, graph);
    await testSearchDdl(model);
    await testGetDdlBatch(model);
    await testValidateCreateAiView(model);
    await testSafeRegex();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('AI Tools');
}

main();
