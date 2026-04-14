/**
 * Unit tests for src/ai/tools.ts — 8 pure tool functions + safeRegex.
 * Execute with: npx tsx test-internal/ai-tools.test.ts  OR  npm run test:ai
 * Requires: test/AdventureWorks.dacpac
 */

import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { assert, assertEq, testPath, rootPath, printSummary, loadAdventureWorksModel } from '../test/testUtils';
import { buildBareGraph } from '../src/ai/graphUtils';
import {
  getContext, searchObjects, getObjectDetail,
  runBfsTrace, runAnalysis, searchDdl, getDdlBatch, autoFixEnrichView, validateEnrichView,
  validateQuery, validateMarkdownFormat, orderAndAssemble,
  type EnrichViewInput,
} from '../src/ai/tools';
import { bfsDepthMap } from '../src/ai/smGuards';
import { estimateTokens, shouldInline, getEffectiveBudget } from '../src/ai/tokenBudget';
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

  // Token budget gate: model_size + decision depend on catalog size vs effective budget
  const tokenEst = ctx._token_estimate as Record<string, unknown>;
  assert(tokenEst !== undefined, 'token estimate present');
  assert(typeof tokenEst.catalog_chars === 'number', 'catalog_chars is number');
  assert(typeof tokenEst.estimated_tokens === 'number', 'estimated_tokens is number');
  assert(tokenEst.decision === 'inline' || tokenEst.decision === 'on_demand', 'decision is inline or on_demand');
  const isInline = tokenEst.decision === 'inline';
  assertEq(ctx.model_size as string, isInline ? 'small' : 'large', 'model_size consistent with decision');

  if (isInline) {
    assert((tokenEst.estimated_tokens as number) <= getEffectiveBudget(), 'inline: tokens within budget');
    const objects = ctx.objects as Array<Record<string, unknown>>;
    assert(Array.isArray(objects), 'inline: objects[] present');
    assert(objects.length > 0, 'inline: objects not empty');

    // SPs/views/functions should have DDL
    const spObj = objects.find(o => o.t === 'procedure');
    assert(spObj !== undefined, 'inline: has a procedure object');
    assert(typeof spObj?.ddl === 'string' && (spObj.ddl as string).length > 0,
      'inline: procedure has non-empty DDL');

    // Tables should have columns
    const tblObj = objects.find(o => o.t === 'table');
    assert(tblObj !== undefined, 'inline: has a table object');
    assert(Array.isArray(tblObj?.cols), 'inline: table has cols[]');
    const cols = tblObj?.cols as Array<Record<string, unknown>>;
    assert(cols.length > 0, 'inline: table cols not empty');
    assert(cols[0].n !== undefined, 'inline: column has name');

    // Edges included for inline model
    const edges = ctx.edges as Array<unknown>;
    assert(Array.isArray(edges), 'inline: edges[] present');
    assert(edges.length > 0, 'inline: edges not empty');
  } else {
    // On-demand: no objects/edges, just summary
    assert(ctx.objects === undefined, 'on_demand: no objects[]');
    assert(ctx.edges === undefined, 'on_demand: no edges[]');
    assert(Array.isArray(ctx.schemas), 'on_demand: schemas[] present for tool navigation');
  }
}

async function testSearchObjects(model: DatabaseModel) {
  console.log('\n── searchObjects ──');
  const r1 = searchObjects(model, 'Employee', ['table']) as Record<string, unknown>;
  assert(!isError(r1), 'searchObjects Employee/table: no error');
  const results1 = r1.results as Array<Record<string, unknown>>;
  assert(results1.length > 0, `Employee/table results > 0 (got ${results1.length})`);
  // Results use compact keys: t (type), n (name), s (schema), deg (degree)
  assert(results1.every(n => n.t === 'table'), 'all results are t=table');
  assert(results1.every(n => n.deg === undefined || typeof n.deg === 'number'), 'all results have numeric deg or undefined');
  assert(results1.every(n => n.match === 'name' || n.match === 'column'), 'all results have match=name or match=column');

  // empty result → ai_hint present (B8: no action_required gate for search)
  const r2 = searchObjects(model, 'xyznosuchthing12345') as Record<string, unknown>;
  assert('ai_hint' in r2, 'empty result includes ai_hint');
  assert(!('action_required' in r2), 'empty result has no action_required gate');
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
  assert(rStruct.delivery === 'inline', 'small BFS delivery is inline');

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
  assert((rHub.nodes as unknown[]).length > 0, 'large BFS returns nodes');
  assert(rHub.delivery === 'inline', 'structure-only BFS (no DDL) is always inline');
}

async function testRunAnalysis(model: DatabaseModel, graph: Graph) {
  console.log('\n── runAnalysis ──');
  const r = runAnalysis(model, graph, 'orphans') as Record<string, unknown>;
  assert(!isError(r), 'runAnalysis orphans: no error');
  assertEq(r.type as string, 'orphans', 'type matches');
  assert(typeof r.summary === 'string', 'summary is string');
  assert(Array.isArray(r.groups), 'groups is array');
  assert(typeof r.total_groups === 'number', 'total_groups is number');
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

async function testValidateEnrichView(model: DatabaseModel) {
  console.log('\n── validateEnrichView ──');
  const node = model.nodes[0];

  const VALID_SUMMARY = 'Test graph purpose.';
  const VALID_DESC = '## Analysis\nStructured answer.\n\n## Details\nMore content.';

  // Valid minimal: name + summary (description is optional now)
  const ok = validateEnrichView({ name: 'My View', summary: VALID_SUMMARY, description: VALID_DESC }, [node.id]) as Record<string, unknown>;
  assert(ok.success === true, 'minimal enrich: success true');
  assertEq(ok.name as string, 'My View', 'minimal enrich: name matches');
  assert(Array.isArray(ok.node_ids), 'minimal enrich: node_ids is array');

  // Empty name
  const noName = validateEnrichView({ name: '', summary: VALID_SUMMARY }, [node.id]) as Record<string, unknown>;
  assert(noName.success === false, 'empty name: success false');

  // Name too long
  const longName = validateEnrichView({ name: 'x'.repeat(61), summary: VALID_SUMMARY }, [node.id]) as Record<string, unknown>;
  assert(longName.success === false, 'name >60 chars: success false');

  // Empty resolved node set
  const noIds = validateEnrichView({ name: 'Test', summary: VALID_SUMMARY }, []) as Record<string, unknown>;
  assert(noIds.success === false, 'empty resolved nodes: success false');

  // ── Content validation: summary + description ──

  // Missing summary → rejected
  const noSummary = validateEnrichView({ name: 'Test', summary: '' }, [node.id]) as Record<string, unknown>;
  assert(noSummary.success === false, 'missing summary: rejected');

  // Missing description → accepted (optional now)
  const noDesc = validateEnrichView({ name: 'Test', summary: VALID_SUMMARY }, [node.id]) as Record<string, unknown>;
  assert(noDesc.success === true, 'missing description: accepted (optional)');

  // Single paragraph description (no ## or \n\n) → rejected when provided
  const singleParagraph = validateEnrichView({
    name: 'Test', summary: VALID_SUMMARY,
    description: 'Revenue flows from staging through transformation to the fact table.',
  }, [node.id]) as Record<string, unknown>;
  assert(singleParagraph.success === false, 'single paragraph description: rejected');

  // Walkthrough prefix → rejected
  const walkthrough = validateEnrichView({
    name: 'Test', summary: VALID_SUMMARY,
    description: 'Traces how Revenue is calculated\n\n## Details\nMore...',
  }, [node.id]) as Record<string, unknown>;
  assert(walkthrough.success === false, 'walkthrough prefix: rejected');

  // Multi-paragraph without headings → passes (has \n\n)
  const multiPara = validateEnrichView({
    name: 'Test', summary: VALID_SUMMARY,
    description: 'Revenue uses EV methodology.\n\nThe formula applies PlannedValue × EH/PH.',
  }, [node.id]) as Record<string, unknown>;
  assert(multiPara.success === true, 'multi-paragraph without ##: passes');

  // Markdown format validation (validateMarkdownFormat)
  assertEq(validateMarkdownFormat('## Heading\nNormal markdown with $x^2$ inline math.').length, 0, 'clean markdown: no errors');
  assertEq(validateMarkdownFormat('## Heading\n```math\nRevenue = PV \\times \\frac{EH}{PH}\n```').length, 0, 'valid ```math fence: no errors');
  assertEq(validateMarkdownFormat('## Heading\n\\begin{cases} 0 \\\\ 1 \\end{cases}').length, 0, '\\begin{cases}: accepted (KaTeX renders natively)');
  assertEq(validateMarkdownFormat('## Heading\n\\begin{align*} x \\\\ y \\end{align*}').length, 0, '\\begin{align*}: accepted (KaTeX renders natively)');
  assertEq(validateMarkdownFormat('## Heading\n$$formula$$\n$$orphan').length, 0, 'unbalanced $$: no longer rejected ($$ converted to fences by fixLatex)');
  assert(validateMarkdownFormat('## Heading\n```math\nformula').length > 0, 'unclosed ```math fence: rejected');
  assertEq(validateMarkdownFormat('## Heading\n```sql\nSELECT 1\n```').length, 0, 'closed ```sql fence: no errors');

  // Validate accepts description with \begin{cases} (KaTeX renders natively)
  const beginCases = validateEnrichView({
    name: 'Test', summary: VALID_SUMMARY,
    description: '## Formula\nThe result is:\n\\begin{cases} 0 & \\text{if x=0} \\\\ 1 & \\text{otherwise} \\end{cases}',
  }, [node.id]) as Record<string, unknown>;
  assert(beginCases.success === true, 'description with \\begin{cases}: accepted (KaTeX renders natively)');

  // Realistic: Person.EmailAddress + neighbors
  const emailNode = model.nodes.find(n => n.schema === 'Person' && n.name === 'EmailAddress');
  assert(emailNode !== undefined, 'Person.EmailAddress node found in model');
  if (emailNode) {
    const nb = model.neighborIndex[emailNode.id];
    const neighborIds = [...(nb?.in ?? []), ...(nb?.out ?? [])].slice(0, 4);
    const lineageIds = [emailNode.id, ...neighborIds];

    const richInput: EnrichViewInput = {
      name: 'EmailAddress Full Lineage',
      summary: 'EmailAddress dependency chain in Person schema.',
      description: '## Data Flow\nTraces how EmailAddress dependencies flow through the Person schema.',
    };
    const aiResult = validateEnrichView(richInput, lineageIds) as Record<string, unknown>;
    assert(aiResult.success === true, 'EmailAddress lineage: validateEnrichView succeeds');
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

  // No truncation — all IDs returned in full
  const allIds = model.nodes.map(n => n.id);
  const bigResult = getDdlBatch(model, allIds) as Record<string, unknown>;
  const bigResults = bigResult.results as unknown[];
  assertEq(bigResults.length, allIds.length, 'all IDs returned — no batch cap');

  // Empty batch
  const emptyResult = getDdlBatch(model, []) as Record<string, unknown>;
  assertEq((emptyResult.results as unknown[]).length, 0, 'empty ids: 0 results');
}

async function testAutoFixEnrichView(model: DatabaseModel) {
  console.log('\n── autoFixEnrichView ──');
  const node = model.nodes[0];
  const node2 = model.nodes[1];

  // ── With resolvedNodeIds (stored graph path) ──

  // Clean input with resolved graph: 0 fixes
  const { fixes: noFixes } = autoFixEnrichView(model, {
    name: 'Clean', summary: 'Test.',
    badges: [{ node_id: node.id, text: 'Keep' }],
  }, [node.id]);
  assertEq(noFixes.length, 0, 'clean input (resolved): 0 fixes');

  // Empty notes: dropped
  const { input: fixedNote, fixes: noteFixes } = autoFixEnrichView(model, {
    name: 'Test', summary: 'Test.',
    notes: [
      { node_id: node.id, text: 'Valid note' },
      { node_id: node.id, text: '' },
      { node_id: node.id, text: '   ' },
    ],
  }, [node.id]);
  assert(noteFixes.length > 0, 'empty notes: fixes reported');
  assertEq(fixedNote.notes!.length, 1, 'empty notes: 2 dropped, 1 kept');

  // Highlight groups pruned against resolved node set
  const { input: fixedHl, fixes: hlFixes } = autoFixEnrichView(model, {
    name: 'Test', summary: 'Test.',
    highlight_groups: [
      { label: 'All ghosts', color: 'source', node_ids: ['[ghost].[x]'] },
      { label: 'Valid', color: 'target', node_ids: [node.id] },
    ],
  }, [node.id]);
  assert(hlFixes.length > 0, 'highlight prune: fixes reported');
  assertEq(fixedHl.highlight_groups!.length, 1, 'highlight prune: ghost group removed');
  assertEq(fixedHl.highlight_groups![0].label, 'Valid', 'highlight prune: valid group kept');

  // ── Validate integration ──

  // Summary passthrough
  const withSummary = validateEnrichView({
    name: 'Test', summary: 'Revenue lineage from SAP invoices.',
    description: '## Revenue Calculation\nDetailed explanation...',
  }, [node.id]) as Record<string, unknown>;
  assert(withSummary.success === true, 'summary+description: success');
  assertEq(withSummary.summary as string, 'Revenue lineage from SAP invoices.', 'summary: passed through');
  assert((withSummary.description as string).startsWith('## Revenue'), 'description: passed through');

  // Summary length: autoFix passes through (no truncation), validate rejects >300
  const longSummary = 'x'.repeat(150);
  const { input: fixedSummary, fixes: summaryFixes } = autoFixEnrichView(model, {
    name: 'Test', summary: longSummary,
  }, [node.id]);
  assertEq(summaryFixes.length, 0, 'long summary: no auto-fix (validation handles length)');
  assertEq(fixedSummary.summary!.length, 150, 'long summary: passed through unchanged');

  // Summary >300 chars: hard rejected by validate
  const tooLongSummary = validateEnrichView({
    name: 'Test', summary: 'x'.repeat(301),
  }, [node.id]) as Record<string, unknown>;
  assert(tooLongSummary.success === false, 'summary >300 chars: rejected');

  // Short summary: no fixes
  const { fixes: noSummaryFixes } = autoFixEnrichView(model, {
    name: 'Test', summary: 'Short summary.',
  }, [node.id]);
  assertEq(noSummaryFixes.length, 0, 'short summary: no fixes');

  // End-to-end: auto-fix cleans input (orphaned notes/highlights), validate passes
  const rawBadInput: EnrichViewInput = {
    name: 'Revenue Pipeline',
    summary: 'Revenue pipeline from staging to fact tables.',
    description: '## Revenue Flow\nStructured answer.\n\n## Details\nMore.',
    notes: [{ node_id: node.id, text: '' }],
  };
  const resolvedIds = [node.id];
  const { input: autoFixed, fixes: e2eFixes } = autoFixEnrichView(model, rawBadInput, resolvedIds);
  assert(e2eFixes.length > 0, 'e2e: auto-fix applied changes (empty note dropped)');
  const fixedValidation = validateEnrichView(autoFixed, resolvedIds) as Record<string, unknown>;
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
  // B8 fix: fallback results returned as PRIMARY (no action_required gate, ai_hint instead)
  const mismatch = searchObjects(model, 'SalesOrderDetail', undefined, ['HumanResources']) as Record<string, unknown>;
  assert(!isError(mismatch), 'mismatch: no error');
  assert((mismatch.total as number) > 0, 'mismatch: fallback results returned as primary');
  assert('ai_hint' in mismatch, 'mismatch: ai_hint present (not action_required)');
  assert(!('action_required' in mismatch), 'mismatch: no action_required gate');
  assert('schema_correction' in mismatch, 'mismatch: schema_correction present');
  const sc = mismatch.schema_correction as Record<string, unknown>;
  assert((sc.actual_schemas as string[]).includes('Sales'), 'mismatch: found in Sales');
  assert('filter_context' in mismatch, 'mismatch: filter_context present');

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

  // No mismatch when name doesn't exist anywhere — should have ai_hint, not action_required
  const nowhere = searchObjects(model, 'xyznonexistent', undefined, ['HumanResources']) as Record<string, unknown>;
  assertEq(nowhere.total, 0, 'nowhere: 0 results');
  assert(!('schema_correction' in nowhere), 'nowhere: no schema_correction when name not found anywhere');
  assert('ai_hint' in nowhere, 'nowhere: ai_hint present for guidance');
  assert(!('action_required' in nowhere), 'nowhere: no action_required gate');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function testBfsDepthMap() {
  console.log('\n── bfsDepthMap ──');

  // Linear chain: A→B→C
  const chain: ReadonlyArray<readonly [string, string, string]> = [
    ['A', 'B', 'read'] as const,
    ['B', 'C', 'read'] as const,
  ];
  const depths = bfsDepthMap(chain, 'A');
  assertEq(depths.get('A'), 0, 'origin depth=0');
  assertEq(depths.get('B'), 1, 'B depth=1');
  assertEq(depths.get('C'), 2, 'C depth=2');

  // Disconnected node is absent
  assert(!depths.has('D'), 'disconnected node absent');

  // Diamond: A→B, A→C, B→D, C→D
  const diamond: ReadonlyArray<readonly [string, string, string]> = [
    ['A', 'B', 'read'] as const,
    ['A', 'C', 'read'] as const,
    ['B', 'D', 'read'] as const,
    ['C', 'D', 'read'] as const,
  ];
  const dd = bfsDepthMap(diamond, 'A');
  assertEq(dd.get('D'), 2, 'diamond sink depth=2 (BFS shortest)');
  assertEq(dd.get('B'), 1, 'diamond B depth=1');

  // Empty edges
  const empty = bfsDepthMap([], 'X');
  assertEq(empty.get('X'), 0, 'origin with no edges depth=0');
  assertEq(empty.size, 1, 'only origin in map');
}

function testOrderAndAssemble() {
  console.log('\n── orderAndAssemble ──');

  // Basic 3-group case — sections[] order is Target(0), Source(1), ETL(2)
  // System must number them 1 Target, 2 Source, 3 ETL — AI's narrative order, not graph topology
  const sections = [
    { label: 'Target', node_ids: ['C'], text: 'Target receives data from ETL.' },
    { label: 'Source', node_ids: ['A'], text: 'Raw data from Source tables.' },
    { label: 'ETL', node_ids: ['B'], text: 'Transformation logic in ETL.' },
  ];
  const result = orderAndAssemble(sections);

  // Badges numbered in AI's sections[] order: Target(0)→1, Source(1)→2, ETL(2)→3
  const badgeOrder = result.badges.map(b => b.text);
  assert(badgeOrder[0].startsWith('1 Target'), `first badge is "1 Target", got "${badgeOrder[0]}"`);
  assert(badgeOrder[1].startsWith('2 Source'), `second badge is "2 Source", got "${badgeOrder[1]}"`);
  assert(badgeOrder[2].startsWith('3 ETL'), `third badge is "3 ETL", got "${badgeOrder[2]}"`);

  // Description headings in AI's sections[] order
  assert(result.description.includes('## 1 Target'), 'description has ## 1 Target');
  assert(result.description.includes('## 2 Source'), 'description has ## 2 Source');
  assert(result.description.includes('## 3 ETL'), 'description has ## 3 ETL');
  const tgt = result.description.indexOf('## 1 Target');
  const src = result.description.indexOf('## 2 Source');
  const etl = result.description.indexOf('## 3 ETL');
  assert(tgt < src && src < etl, 'headings appear in AI sections[] order');

  // Grouping: same label on multiple node_ids within a section
  const groupSections = [
    { label: 'Source', node_ids: ['A', 'B'], text: 'Both A and B are source tables.' },
    { label: 'Target', node_ids: ['C'], text: 'C is the target.' },
  ];
  const gr = orderAndAssemble(groupSections);
  const nums = gr.badges.map(b => b.text.split(' ')[0]);
  assert(nums[0] === nums[1], 'grouped badges share same step number');
  assert(nums[2] !== nums[0], 'target has different step number');

  // Strip AI-provided leading numbers from section labels
  const numberedSections = [
    { label: '1 Source', node_ids: ['A'], text: 'Source stripped correctly.' },
    { label: '3 Target', node_ids: ['C'], text: 'Target stripped correctly.' },
  ];
  const stripped = orderAndAssemble(numberedSections);
  assert(!stripped.description.includes('## 1 1 Source'), 'no double number in heading');
  assert(stripped.description.includes('## 1 Source'), 'correct heading after strip');
}

async function main() {
async function testPromptRegression() {
  console.log('\n── Prompt Regression (package.json) ──');
  const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf8'));
  const tools = pkg.contributes.languageModelTools as Array<Record<string, unknown>>;
  assert(Array.isArray(tools), 'languageModelTools is array');

  const enrichTool = tools.find(t => t.name === 'lineage_enrich_view') as Record<string, unknown>;
  assert(enrichTool !== undefined, 'lineage_enrich_view tool found');

  // summary is required in schema, description is optional
  const schema = enrichTool.inputSchema as Record<string, unknown>;
  const required = schema.required as string[];
  assert(required.includes('summary'), 'summary is required in schema');
  assert(!required.includes('description'), 'description is NOT required in schema (optional)');
  assert(required.includes('name'), 'name is required in schema');
  assert(!required.includes('node_ids'), 'node_ids is NOT required in schema (fallback only)');

  // modelDescription contains BAD/GOOD and mentions enrichment
  const desc = enrichTool.modelDescription as string;
  assert(desc.includes('BAD'), 'modelDescription has BAD example');
  assert(desc.includes('GOOD'), 'modelDescription has GOOD example');
  assert(desc.includes('summary'), 'modelDescription mentions summary');
  assert(desc.includes('prune_node_ids'), 'modelDescription mentions prune_node_ids');

  // All tools have tags and when clause
  for (const tool of tools) {
    const tags = tool.tags as string[];
    assert(tags?.includes('lineage') || tags?.includes('lineage-ct') || tags?.includes('lineage-bb'), `${tool.name}: has lineage, lineage-ct, or lineage-bb tag`);
    assertEq(tool.when as string, 'dataLineageViz.modelLoaded', `${tool.name}: has when clause`);
  }

  // Key parameters exist in schema properties
  const props = (schema.properties as Record<string, unknown>);
  assert('summary' in props, 'summary in schema properties');
  assert('description' in props, 'description in schema properties');
  assert('prune_node_ids' in props, 'prune_node_ids in schema properties');
  assert('sections' in props, 'sections in schema properties');
}

async function testMultiModeSchema() {
  console.log('\n── Multi-Mode Schema (package.json) ──');
  const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf8'));
  const tools = pkg.contributes.languageModelTools as Array<Record<string, unknown>>;

  // route_mode tool removed — explore-first design, no upfront routing
  assert(!tools.find(t => t.name === 'lineage_route_mode'), 'route_mode tool removed');

  // submit_hop_analysis has notes + question + trace/prune/pass verdicts
  const submitTool = tools.find(t => t.name === 'lineage_submit_hop_analysis') as Record<string, unknown>;
  assert(submitTool !== undefined, 'lineage_submit_hop_analysis tool found');
  const submitSchema = submitTool.inputSchema as Record<string, unknown>;
  const submitProps = (submitSchema.properties as Record<string, unknown>);
  assert('notes' in submitProps, 'submit schema has notes field');
  assert('verdicts' in submitProps, 'submit schema has verdicts field');

  // Verdict enum is trace/prune/pass/revisit
  const verdictItems = ((submitProps.verdicts as Record<string, unknown>).items as Record<string, unknown>);
  const verdictProps = (verdictItems.properties as Record<string, { enum?: string[] }>);
  const verdictEnum = verdictProps.verdict.enum!;
  assertEq(verdictEnum.length, 4, 'verdict enum has 4 values');
  assert(verdictEnum.includes('trace'), 'verdict enum includes trace');
  assert(verdictEnum.includes('prune'), 'verdict enum includes prune');
  assert(verdictEnum.includes('pass'), 'verdict enum includes pass');
  assert(verdictEnum.includes('revisit'), 'verdict enum includes revisit');
  assert(!verdictEnum.includes('relevant'), 'verdict enum does NOT include old name "relevant"');
  assert('question' in verdictProps, 'verdict item has question field');

  // Chat participant has new slash commands
  const participants = pkg.contributes.chatParticipants as Array<Record<string, unknown>>;
  const lineageParticipant = participants.find(p => p.name === 'lineage') as Record<string, unknown>;
  const commands = lineageParticipant.commands as Array<{ name: string }>;
  const cmdNames = commands.map(c => c.name);
  // /impact and /column-trace removed — merged into /trace (explore-first design)
  assert(!cmdNames.includes('impact'), '/impact removed');
  assert(!cmdNames.includes('column-trace'), '/column-trace removed');
  assert(!cmdNames.includes('biz'), 'chat commands do NOT include /biz (consolidated to free-form)');
  assert(!cmdNames.includes('doc'), 'chat commands do NOT include /doc (consolidated to free-form)');
  assert(!cmdNames.includes('sql'), 'chat commands do NOT include /sql (consolidated to free-form)');

  // modelDescription mentions BAD/GOOD question examples
  const submitDesc = submitTool.modelDescription as string;
  assert(submitDesc.includes('BAD question'), 'submit modelDescription has BAD question example');
  assert(submitDesc.includes('GOOD question'), 'submit modelDescription has GOOD question example');
  assert(submitDesc.includes('notes'), 'submit modelDescription mentions notes');
}

async function testYamlTemplates() {
  console.log('\n── AI Output Templates (YAML) ──');
  const content = readFileSync(rootPath('assets/aiOutputTemplates.yaml'), 'utf8');
  const parsed = yaml.load(content) as Record<string, { instruction?: string }>;
  assert(parsed !== null && typeof parsed === 'object', 'YAML parses as object');

  const REQUIRED_KEYS = ['summary', 'title', 'intro', 'closing', 'description', 'sections', 'highlights', 'notes'];
  for (const key of REQUIRED_KEYS) {
    assert(key in parsed, `YAML: ${key} key present`);
    const entry = parsed[key];
    assert(typeof entry.instruction === 'string', `YAML: ${key}.instruction is string`);
    assert(entry.instruction.trim().length > 0, `YAML: ${key}.instruction non-empty`);
  }

  // Description instruction must mention supported formats
  const descInstr = parsed.description.instruction!;
  assert(descInstr.includes('##') || descInstr.includes('heading'), 'YAML: description mentions headings');
  assert(descInstr.includes('LaTeX') || descInstr.includes('$'), 'YAML: description mentions LaTeX');

  // Sections instruction must mention "label" as key concept
  const secInstr = parsed.sections.instruction!;
  assert(secInstr.toLowerCase().includes('label'), 'YAML: sections mention label');
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
    await testValidateEnrichView(model);
    await testAutoFixEnrichView(model);
    await testSafeRegex();
    await testValidateQuery();
    await testSearchWithSchemas(model);
    await testSchemaMismatchDetection(model);
    await testPromptRegression();
    await testMultiModeSchema();
    await testYamlTemplates();
    testBfsDepthMap();
    testOrderAndAssemble();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('AI Tools');
}

main();
