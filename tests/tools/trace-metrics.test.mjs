// Covers the payload metrics of recorded runs on synthetic traces: value inputs against row roles,
// a prune of a node the same payload names as a source, a missing writes_to, repeated-run spread and
// the captured-snippet counts of synthesis.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRuns, contributorKind, findings, parseTrace, repairChains, runMetrics, snippetIds, spreadFindings, summariseSubmission } from './trace-metrics.mjs';

const submitInput = (focus, sources, extra = {}) => ({
  focus_node_id: focus,
  verdict: 'analyze',
  column_flow: [{ out_col: 'Result', writes_to: { node: '[d].[target]', col: 'Result' }, upstream_columns: sources }],
  ...extra,
});

const response = (generation, name, input) => ({ type: 'wire-response', generation, phase: 'active', toolCalls: [{ callId: `c${generation}`, name, input }] });
const tool = (toolName, status, rejectionCode) => ({ type: 'tool', toolName, status, ...(rejectionCode ? { rejectionCode } : {}) });
const lines = records => records.map(r => JSON.stringify(r)).join('\n');

test('a contributor with a direct transform, or none stated, is a value input; combine and filter alone are row roles', () => {
  assert.equal(contributorKind({}), 'direct');
  assert.equal(contributorKind({ transforms: ['compute'] }), 'direct');
  assert.equal(contributorKind({ transforms: ['filter', 'aggregate'] }), 'direct');
  assert.equal(contributorKind({ transforms: ['combine'] }), 'row_role');
  assert.equal(contributorKind({ transforms: ['filter', 'combine'] }), 'row_role');
});

test('a submission reports value inputs, row roles, a prune of a named source and a missing writes_to', () => {
  const summary = summariseSubmission({
    focus_node_id: '[d].[proc]',
    column_flow: [
      { out_col: 'A', upstream_columns: [
        { node: '[d].[dim]', col: 'Code', transforms: ['compute'] },
        { node: '[d].[keys]', col: 'Region', transforms: ['combine'] },
      ] },
    ],
    prune_neighbors: [{ id: '[d].[dim]', reason: 'fully captured here' }, { id: '[d].[other]', reason: 'off path' }],
    questions: [{ nodeId: '[d].[keys]', question: 'q' }],
  });
  assert.deepEqual(summary.direct, ['[d].[dim].Code']);
  assert.deepEqual(summary.rowRole, ['[d].[keys].Region']);
  assert.deepEqual(summary.prunedAndNamed, ['[d].[dim]']);
  assert.equal(summary.entriesWithoutWritesTo, 1);
  assert.deepEqual(summary.questions, ['[d].[keys]']);
});

test('snippet ids are read from sql fences that carry an id and nothing else', () => {
  assert.deepEqual([...snippetIds('```sql S7\nSELECT 1\n```\n```sql\nSELECT 2\n```\n```sql S12\nx\n```')].sort(), ['S12', 'S7']);
});

test('a run reports accepted and rejected hops, conflicts, rejections and synthesis snippet citations', () => {
  const records = parseTrace(lines([
    response(3, 'lineage_submit_findings', submitInput('[d].[proc]', [{ node: '[d].[dim]', col: 'Code', transforms: ['compute'] }], { prune_neighbors: [{ id: '[d].[dim]', reason: 'done' }] })),
    tool('lineage_submit_findings', 'rejected', 'invalid_input'),
    response(4, 'lineage_submit_findings', submitInput('[d].[proc]', [{ node: '[d].[dim]', col: 'Code', transforms: ['compute'] }])),
    tool('lineage_submit_findings', 'accepted'),
    { type: 'provider-raw', direction: 'request', body: { messages: [{ content: '{"detail_slots":[{"text":"```sql S1\\nA\\n```\\n```sql S2\\nB\\n```"}]}' }] } },
    response(5, 'lineage_present_result', { sections: [{ text: '```sql S1\n```' }] }),
    tool('lineage_present_result', 'accepted'),
  ]));
  const run = runMetrics(records);
  assert.equal(run.aligned, true);
  assert.deepEqual(run.hops.map(h => h.status), ['rejected', 'accepted']);
  assert.deepEqual(run.conflicts, [{ focus: '[d].[proc]', nodes: ['[d].[dim]'], status: 'rejected' }]);
  assert.deepEqual(run.rejections, { 'lineage_submit_findings:invalid_input': 1 });
  assert.deepEqual(run.synthesis, { offered: 2, cited: 1 });
});

test('repeated runs are compared per focus object on their accepted hops', () => {
  const run = sources => runMetrics(parseTrace(lines([
    response(3, 'lineage_submit_findings', submitInput('[d].[proc]', sources)),
    tool('lineage_submit_findings', 'accepted'),
  ])));
  const a = run([{ node: '[d].[x]', col: 'A', transforms: ['compute'] }, { node: '[d].[y]', col: 'B', transforms: ['compute'] }]);
  const b = run([{ node: '[d].[x]', col: 'A', transforms: ['compute'] }]);
  const same = compareRuns([a, a]);
  assert.equal(same[0].identicalDirect, true);
  const spread = compareRuns([a, b]);
  assert.equal(spread[0].identicalDirect, false);
  assert.deepEqual(spread[0].directCounts, [2, 1]);
  assert.deepEqual(spread[0].onlyInSome, ['[d].[y].B']);
});

test('a truncated trailing line is not a record and a missing tool record leaves the hop status unknown', () => {
  const text = `${lines([response(3, 'lineage_submit_findings', submitInput('[d].[proc]', []))])}\n{"type":"tool","toolN`;
  const run = runMetrics(parseTrace(text));
  assert.equal(run.aligned, false);
  assert.equal(run.hops[0].status, 'unknown');
});

test('findings name the generic symptoms: a prune of a named source, a repeated field, lost citations, an unfinished run', () => {
  const rejected = (tool, code, issuePaths) => ({ type: 'tool', toolName: tool, status: 'rejected', rejectionCode: code, issuePaths });
  const offered = Array.from({ length: 12 }, (_, i) => `\`\`\`sql S${i + 1}\nx\n\`\`\``).join('\n');
  const records = parseTrace(lines([
    response(3, 'lineage_submit_findings', submitInput('[d].[proc]', [{ node: '[d].[dim]', col: 'Code', transforms: ['compute'] }, { node: '[d].[keys]', col: 'K', transforms: ['combine'] }], { prune_neighbors: [{ id: '[d].[dim]', reason: 'done' }] })),
    rejected('lineage_submit_findings', 'invalid_input', ['column_flow.0.writes_to']),
    response(4, 'lineage_submit_findings', submitInput('[d].[proc]', [])),
    rejected('lineage_submit_findings', 'invalid_input', ['column_flow.0.writes_to']),
    rejected('lineage_get_scope_bundle', 'over_discovery_budget', []),
    { type: 'provider-raw', direction: 'request', body: { messages: [{ content: `{"detail_slots":["${offered.replace(/\n/g, '\\n')}"]}` }] } },
    response(5, 'lineage_present_result', { sections: [{ text: '```sql S1\n```' }] }),
    { type: 'turn-terminal', status: 'error' },
  ]));
  const rules = findings(runMetrics(records)).map(item => item.rule).sort();
  assert.deepEqual(rules, ['discovery_budget_rejected', 'prune_names_source', 'repair_unresolved', 'run_not_completed', 'same_field_rejected_twice', 'snippet_citations_collapsed', 'trace_misaligned', 'writes_to_rejected', 'writes_to_rejected']);
});

test('a clean run has no finding above info and spread findings flag a differing source set', () => {
  const run = sources => runMetrics(parseTrace(lines([
    response(3, 'lineage_submit_findings', submitInput('[d].[proc]', sources)),
    tool('lineage_submit_findings', 'accepted'),
    { type: 'turn-terminal', status: 'ok' },
  ])));
  const a = run([{ node: '[d].[x]', col: 'A', transforms: ['compute'] }, { node: '[d].[y]', col: 'B', transforms: ['compute'] }]);
  const b = run([{ node: '[d].[x]', col: 'A', transforms: ['compute'] }]);
  assert.deepEqual(findings(a), []);
  assert.deepEqual(spreadFindings([a, a]), []);
  const spread = spreadFindings([a, b]);
  assert.equal(spread.length, 1);
  assert.equal(spread[0].rule, 'source_set_differs_between_runs');
  assert.equal(spread[0].kind, 'defect');
  assert.match(spread[0].correct, /same value inputs/);
});

test('a rejected call is followed to its repair: replies taken, and whether the resend carried the defect only', () => {
  const reply = (generation, name, input, outputTokens) => ({ ...response(generation, name, input), usage: { outputTokens } });
  const rejected = (paths) => ({ type: 'tool', toolName: 'lineage_submit_findings', status: 'rejected', rejectionCode: 'invalid_input', issuePaths: paths });
  const records = parseTrace(lines([
    reply(3, 'lineage_submit_findings', { focus_node_id: '[d].[p]', verdict: 'analyze', summary: 's', sections: { technical: 'x'.repeat(4000) } }, 3000),
    rejected(['summary']),
    reply(4, 'lineage_submit_findings', { focus_node_id: '[d].[p]', verdict: 'analyze', summary: 'fixed' }, 120),
    rejected(['summary']),
    reply(5, 'lineage_submit_findings', { focus_node_id: '[d].[p]', verdict: 'analyze', summary: 'fixed', sections: { technical: 'x'.repeat(4000) } }, 2900),
    tool('lineage_submit_findings', 'accepted'),
    reply(6, 'lineage_submit_findings', { focus_node_id: '[d].[q]', verdict: 'analyze', summary: 's' }, 100),
    rejected(['summary']),
  ]));
  const run = runMetrics(records);
  assert.deepEqual(run.repair.chains.map(c => [c.focus, c.rejections, c.resolved, c.resolvedAtRetry]), [['[d].[p]', 2, true, 2], ['[d].[q]', 1, false, null]]);
  assert.deepEqual(run.repair.retriesToResolve, { 1: 0, 2: 1, 3: 0, '4+': 0, unresolved: 1 });
  assert.deepEqual(run.repair.steps.map(s => s.extraFields), [[], ['sections']]);
  assert.deepEqual(run.repair.resendTokens, { rejected: 3000 + 120, resent: 120 + 2900 });
  const rules = findings(run).map(item => item.rule).sort();
  assert.deepEqual(rules, ['repair_needed_several_retries', 'repair_unresolved', 'run_not_completed', 'same_field_rejected_twice']);
});

test('a repair on the first retry with a defect-only resend raises no finding', () => {
  const run = repairChains(
    [{ name: 'lineage_present_result', input: { sections: [{ text: 'a' }] }, outputTokens: 900 }, { name: 'lineage_present_result', input: { sections: [{ text: 'b' }], is_update: true }, outputTokens: 40 }],
    [{ toolName: 'lineage_present_result', status: 'rejected', rejectionCode: 'validation', issuePaths: ['sections.0.text'] }, { toolName: 'lineage_present_result', status: 'accepted' }],
  );
  assert.deepEqual(run.retriesToResolve, { 1: 1, 2: 0, 3: 0, '4+': 0, unresolved: 0 });
  assert.equal(run.defectOnlySteps, 1);
  assert.deepEqual(run.steps[0].extraFields, []);
});

test('a rejection followed by a finished run and no resend is information, not a failed repair', () => {
  const run = runMetrics(parseTrace(lines([
    response(3, 'lineage_start_exploration', { origin: '[d].[t]', targetColumns: ['Bogus'] }),
    { type: 'tool', toolName: 'lineage_start_exploration', status: 'rejected', rejectionCode: 'unknown_columns', issuePaths: [] },
    { type: 'turn-terminal', status: 'ok' },
  ])));
  assert.deepEqual(findings(run).map(item => [item.rule, item.kind]), [['rejection_answered_not_resent', 'signal']]);
});

test('the forced structured-output call has no tool record and does not misalign a run', () => {
  const run = runMetrics(parseTrace(lines([
    response(1, 'structured_output', { entry: 'discovery' }),
    response(2, 'lineage_search_objects', { query: 'x' }),
    tool('lineage_search_objects', 'accepted'),
    { type: 'turn-terminal', status: 'ok' },
  ])));
  assert.equal(run.aligned, true);
  assert.deepEqual(findings(run), []);
});

test('citation collapse is flagged against the production-derived share, not against ordinary reports', () => {
  const offered = n => ({ type: 'provider-raw', direction: 'request', body: { messages: [{ content: `{"detail_slots":["${Array.from({ length: n }, (_, i) => `\`\`\`sql S${i + 1}\\nx\\n\`\`\``).join('')}"]}` }] } });
  const cite = n => response(9, 'lineage_present_result', { sections: [{ text: Array.from({ length: n }, (_, i) => `\`\`\`sql S${i + 1}\n\`\`\``).join('\n') }] });
  const run = (n, cited) => runMetrics(parseTrace(lines([offered(n), cite(cited), tool('lineage_present_result', 'accepted'), { type: 'turn-terminal', status: 'ok' }])));
  assert.deepEqual(findings(run(60, 15)), []);
  assert.deepEqual(findings(run(76, 1)).map(item => item.rule), ['snippet_citations_collapsed']);
});

test('only a large exchange is expected to resend the defect only; a small call is resent whole without a finding', () => {
  const run = (rejectedInput, resentInput) => runMetrics(parseTrace(lines([
    response(3, 'lineage_submit_findings', rejectedInput),
    { type: 'tool', toolName: 'lineage_submit_findings', status: 'rejected', rejectionCode: 'invalid_input', issuePaths: ['summary'] },
    response(4, 'lineage_submit_findings', resentInput),
    tool('lineage_submit_findings', 'accepted'),
    { type: 'turn-terminal', status: 'ok' },
  ])));
  const small = run({ focus_node_id: '[d].[p]', verdict: 'analyze', summary: 's', sections: { technical: 'x'.repeat(300) } }, { focus_node_id: '[d].[p]', verdict: 'analyze', summary: 'fixed', sections: { technical: 'x'.repeat(300) } });
  assert.deepEqual(findings(small), []);
  const large = run({ focus_node_id: '[d].[p]', verdict: 'analyze', summary: 's', sections: { technical: 'x'.repeat(6000) } }, { focus_node_id: '[d].[p]', verdict: 'analyze', summary: 'fixed', sections: { technical: 'x'.repeat(6000) } });
  assert.deepEqual(findings(large).map(item => [item.rule, item.kind]), [['resend_not_defect_only', 'signal']]);
  const patched = run({ focus_node_id: '[d].[p]', verdict: 'analyze', summary: 's', sections: { technical: 'x'.repeat(6000) } }, { focus_node_id: '[d].[p]', verdict: 'analyze', summary: 'fixed' });
  assert.deepEqual(findings(patched), []);
});

test('defects come before signals and every finding states what is correct or how to verify it', () => {
  const records = parseTrace(lines([
    response(3, 'lineage_submit_findings', submitInput('[d].[proc]', [{ node: '[d].[dim]', col: 'Code', transforms: ['compute'] }, { node: '[d].[keys]', col: 'K', transforms: ['combine'] }])),
    tool('lineage_submit_findings', 'accepted'),
    { type: 'turn-terminal', status: 'error' },
  ]));
  const items = findings(runMetrics(records));
  assert.deepEqual(items.map(item => [item.kind, item.rule]), [['defect', 'run_not_completed'], ['signal', 'row_role_contributors_not_kept']]);
  assert.ok(items.every(item => (item.kind === 'defect' ? item.correct : item.verify)));
});
