/**
 * Unit tests for AI Tool schemas and metadata.
 * Validates package.json tool definitions against the Grounded Router architecture.
 */

import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { assert, assertEq, rootPath, printSummary, loadAdventureWorksModel } from './helpers/testUtils';
import { buildBareGraph } from '../../src/ai/graphUtils';
import {
  getContext, searchObjects, getObjectDetail,
  runBfsTrace, runAnalysis, searchDdl, getDdlBatch, validateEnrichView,
  validateQuery, validateMarkdownFormat, orderAndAssemble,
} from '../../src/ai/tools';
import { bfsDepthMap } from '../../src/ai/smGuards';
import { getEffectiveBudget } from '../../src/ai/tokenBudget';
import { safeRegex } from '../../src/utils/modelSearch';
import type { DatabaseModel } from '../../src/engine/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isError(obj: object): obj is { error: string } {
  return 'error' in obj && typeof (obj as { error: unknown }).error === 'string';
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testContextTool(model: DatabaseModel) {
  console.log('\n── getContext ──');
  const ctx = getContext(model, null, 'TestProject', []) as Record<string, unknown>;
  assert(ctx.model_stats !== undefined, 'model_stats present');
  const tokenEst = ctx._token_estimate as Record<string, unknown>;
  assert(tokenEst !== undefined, 'token estimate present');
  assert(tokenEst.decision === 'inline' || tokenEst.decision === 'on_demand', 'decision is inline or on_demand');
}

async function testPromptRegression() {
  console.log('\n── Prompt Regression (package.json) ──');
  const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf8'));
  const tools = pkg.contributes.languageModelTools as Array<Record<string, unknown>>;
  assert(Array.isArray(tools), 'languageModelTools is array');

  const requiredTools = ['lineage_get_context', 'lineage_search_objects', 'lineage_run_bfs_trace', 'lineage_start_exploration', 'lineage_submit_findings', 'lineage_enrich_view'];
  for (const name of requiredTools) {
    assert(tools.some(t => t.name === name), `Required tool found: ${name}`);
  }

  // Obsolete tools removed
  assert(!tools.some(t => t.name === 'lineage_start_column_trace'), 'lineage_start_column_trace removed');
  assert(!tools.some(t => t.name === 'lineage_submit_hop_analysis'), 'lineage_submit_hop_analysis removed');
}

async function testGroundedRouterSchema() {
  console.log('\n── Grounded Router Schema (package.json) ──');
  const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf8'));
  const tools = pkg.contributes.languageModelTools as Array<Record<string, unknown>>;

  const submitTool = tools.find(t => t.name === 'lineage_submit_findings') as Record<string, any>;
  const props = submitTool.inputSchema.properties;
  
  assert('detail_analysis' in props, 'submit schema exposes the detail archive');
  assert('summary' in props, 'submit schema exposes the one-line summary');
  assert('route_requests' in props, 'submit schema exposes route_requests');
  
  const routeProps = props.route_requests.items.properties;
  assert('question' in routeProps, 'route_requests items require a specific question');
}

async function testSearchObjects(model: DatabaseModel) {
  console.log('\n── searchObjects ──');
  const r1 = searchObjects(model, 'Employee', ['table']) as Record<string, any>;
  assert(!isError(r1), 'searchObjects Employee/table: no error');
  assert(r1.results.length > 0, 'Found results');
}

async function testValidateEnrichView(model: DatabaseModel) {
  console.log('\n── validateEnrichView ──');
  const node = model.nodes[0];
  const ok = validateEnrichView({ name: 'My View', summary: 'Test.', description: '## Analysis\n...' }, [node.id]) as any;
  assert(ok.success === true, 'minimal enrich: success true');
}

async function testYamlTemplates() {
  console.log('\n── AI Output Templates (YAML) ──');
  const content = readFileSync(rootPath('assets/aiOutputTemplates.yaml'), 'utf8');
  const parsed = yaml.load(content) as Record<string, any>;
  assert(parsed !== null && typeof parsed === 'object', 'YAML parses as object');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══ AI Tools (Unified) Tests ═══');
  try {
    const model = await loadAdventureWorksModel();

    await testContextTool(model);
    await testPromptRegression();
    await testGroundedRouterSchema();
    await testSearchObjects(model);
    await testValidateEnrichView(model);
    await testYamlTemplates();
    
    // Core guards
    console.log('\n── Core Guards ──');
    assert(safeRegex('Employee') !== null, 'safeRegex ok');
    assert(validateQuery('revenue').ok === true, 'validateQuery ok');
    
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('AI Tools (Unified)');
}

main();
