#!/usr/bin/env node
// Payload-level metrics of recorded runs: what each hop named as a column source, what it pruned,
// what synthesis cited, and how those sets differ between repeated runs of one question.
// Usage: node tests/tools/trace-metrics.mjs TRACE.ndjson [TRACE.ndjson ...]
// Reads the lm-trace NDJSON that `npm run test:ai:headless` writes (verbose or not); prints JSON.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SUBMIT = 'lineage_submit_findings';
/** The port's synthetic forced-output call: it is parsed by the port and never dispatched, so it has no tool record. */
const STRUCTURED_OUTPUT = 'structured_output';
const PRESENT = 'lineage_present_result';
const DIRECT = new Set(['pass_through', 'compute', 'aggregate']);
const ROW_ROLE = new Set(['combine', 'filter']);

/**
 * Parses an lm-trace NDJSON text, skipping lines that are not JSON objects.
 *
 * @param {string} text
 * @returns {object[]}
 */
export function parseTrace(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') records.push(value);
    } catch { /* a truncated trailing line is not a record */ }
  }
  return records;
}

/**
 * Classifies one `column_flow` contributor by the contract: a contributor with a direct transform
 * (or none stated) is a value input; one whose transforms are all `combine` or `filter` is a row role.
 *
 * @param {{ transforms?: string[] }} contributor
 * @returns {'direct' | 'row_role'}
 */
export function contributorKind(contributor) {
  const transforms = Array.isArray(contributor.transforms) ? contributor.transforms : [];
  if (transforms.length === 0) return 'direct';
  return transforms.some(t => DIRECT.has(t)) || !transforms.every(t => ROW_ROLE.has(t)) ? 'direct' : 'row_role';
}

/**
 * Summarises one `lineage_submit_findings` input.
 *
 * @param {object} input
 * @returns {{ focus: string, direct: string[], rowRole: string[], pruned: string[], prunedAndNamed: string[], entries: number, entriesWithoutWritesTo: number, questions: string[] }}
 */
export function summariseSubmission(input) {
  const direct = new Set();
  const rowRole = new Set();
  const named = new Set();
  const flow = Array.isArray(input.column_flow) ? input.column_flow : [];
  for (const entry of flow) {
    for (const source of Array.isArray(entry?.upstream_columns) ? entry.upstream_columns : []) {
      if (typeof source?.node !== 'string' || typeof source?.col !== 'string') continue;
      named.add(source.node);
      (contributorKind(source) === 'direct' ? direct : rowRole).add(`${source.node}.${source.col}`);
    }
  }
  const pruned = (Array.isArray(input.prune_neighbors) ? input.prune_neighbors : [])
    .map(entry => entry?.id).filter(id => typeof id === 'string');
  return {
    focus: String(input.focus_node_id ?? ''),
    direct: [...direct].sort(),
    rowRole: [...rowRole].sort(),
    pruned: [...pruned].sort(),
    prunedAndNamed: pruned.filter(id => named.has(id)).sort(),
    entries: flow.length,
    entriesWithoutWritesTo: flow.filter(entry => entry?.writes_to === undefined).length,
    questions: (Array.isArray(input.questions) ? input.questions : []).map(q => String(q?.nodeId ?? '')).sort(),
  };
}

/**
 * Distinct captured-snippet ids (`S<n>`) opened as ```sql fences in a text.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function snippetIds(text) {
  return new Set([...text.matchAll(/```sql S(\d+)/g)].map(match => `S${match[1]}`));
}

/**
 * Computes the payload metrics of one run.
 *
 * @param {object[]} records - Parsed lm-trace records.
 * @returns {object} Hops in submission order with their outcome, prune-versus-source conflicts,
 *   synthesis snippet counts, rejections by code and whether submissions and tool records aligned.
 */
export function runMetrics(records) {
  const calls = [];
  for (const record of records) {
    if (record.type !== 'wire-response') continue;
    for (const call of record.toolCalls ?? []) calls.push({ ...call, generation: record.generation, phase: record.phase, outputTokens: record.usage?.outputTokens });
  }
  const submits = calls.filter(call => call.name === SUBMIT);
  const submitTools = records.filter(record => record.type === 'tool' && record.toolName === SUBMIT);
  const hops = submits.map((call, index) => ({
    generation: call.generation,
    status: submitTools[index]?.status ?? 'unknown',
    rejectionCode: submitTools[index]?.rejectionCode,
    ...summariseSubmission(call.input ?? {}),
  }));
  const rejections = {};
  const rejected = [];
  for (const record of records) {
    if (record.type === 'tool' && record.status === 'rejected') {
      const key = `${record.toolName}:${record.rejectionCode}`;
      rejections[key] = (rejections[key] ?? 0) + 1;
      rejected.push({ tool: record.toolName, code: record.rejectionCode, paths: Array.isArray(record.issuePaths) ? record.issuePaths : [] });
    }
  }
  const terminal = records.find(record => record.type === 'turn-terminal');
  const presents = calls.filter(call => call.name === PRESENT);
  const offered = new Set();
  for (const record of records) {
    if (record.type !== 'provider-raw' || record.direction !== 'request') continue;
    const body = JSON.stringify(record.body ?? {});
    if (body.includes('detail_slots')) for (const id of snippetIds(body)) offered.add(id);
  }
  const cited = new Set();
  for (const call of presents) for (const id of snippetIds(JSON.stringify(call.input ?? {}))) cited.add(id);
  const toolRecords = records.filter(record => record.type === 'tool');
  const repair = repairChains(calls, toolRecords);
  return {
    aligned: submits.length === submitTools.length && repair.aligned,
    repair,
    hops,
    conflicts: hops.filter(hop => hop.prunedAndNamed.length > 0).map(hop => ({ focus: hop.focus, nodes: hop.prunedAndNamed, status: hop.status })),
    synthesis: { offered: offered.size, cited: cited.size },
    rejections,
    rejected,
    outcome: terminal?.status ?? 'unknown',
  };
}

/** Top-level keys a resend always carries; they identify the call and are not part of the defect. */
const IDENTITY_KEYS = new Set(['focus_node_id', 'verdict', 'is_update']);

/**
 * Size of a rejected call, in characters of its input, from which a resend is judged on its size. A small
 * call is cheaper to resend whole than to patch, so only a large exchange is expected to resend the defect only.
 */
export const LARGE_CALL_CHARS = 4000;
/** Share of the rejected call's characters above which the resend of a large call is not defect-only. */
export const MAX_RESEND_SHARE = 0.5;

/**
 * Follows every rejected call to the call that repaired it: how many replies the repair took, and
 * whether each resend carried only the defect. Calls and tool records of one tool are aligned by order.
 *
 * @param {object[]} calls - Calls of the run in order, with `name`, `input`, `outputTokens`.
 * @param {object[]} toolRecords - `tool` records in order.
 * @returns {{ aligned: boolean, rejectedCalls: number, chains: object[], retriesToResolve: Record<string, number>, steps: object[], resendTokens: { rejected: number, resent: number }, defectOnlySteps: number }}
 */
export function repairChains(calls, toolRecords) {
  const names = new Set(calls.map(call => call.name).filter(name => name !== STRUCTURED_OUTPUT));
  const chains = [];
  const steps = [];
  let aligned = true;
  for (const name of names) {
    const own = calls.filter(call => call.name === name);
    const records = toolRecords.filter(record => record.toolName === name);
    if (own.length !== records.length) aligned = false;
    const length = Math.min(own.length, records.length);
    for (let i = 0; i < length; i += 1) {
      if (records[i].status !== 'rejected' || (i > 0 && records[i - 1].status === 'rejected' && sameFocus(own[i - 1], own[i]))) continue;
      let end = i;
      while (end < length && records[end].status === 'rejected' && sameFocus(own[i], own[end])) end += 1;
      const resolved = end < length && sameFocus(own[i], own[end]) && records[end].status === 'accepted';
      const rejections = end - i;
      chains.push({ tool: name, focus: focusOf(own[i]), rejections, resolved, resolvedAtRetry: resolved ? rejections : null, paths: records.slice(i, end).map(record => (Array.isArray(record.issuePaths) ? record.issuePaths : [])) });
      for (let k = i; k < end; k += 1) {
        const retry = own[k + 1];
        if (!retry || k + 1 > end) continue;
        const paths = Array.isArray(records[k].issuePaths) ? records[k].issuePaths : [];
        const defectKeys = new Set(paths.map(path => String(path).split('.')[0]));
        const extraFields = Object.keys(retry.input ?? {}).filter(key => !defectKeys.has(key) && !IDENTITY_KEYS.has(key)).sort();
        steps.push({
          tool: name, code: records[k].rejectionCode, paths, extraFields,
          rejectedTokens: own[k].outputTokens, resentTokens: retry.outputTokens,
          rejectedChars: JSON.stringify(own[k].input ?? {}).length, resentChars: JSON.stringify(retry.input ?? {}).length,
        });
      }
    }
  }
  const retriesToResolve = { 1: 0, 2: 0, 3: 0, '4+': 0, unresolved: 0 };
  for (const chain of chains) {
    const key = !chain.resolved ? 'unresolved' : chain.rejections >= 4 ? '4+' : String(chain.rejections);
    retriesToResolve[key] += 1;
  }
  const sum = key => steps.reduce((n, step) => n + (step[key] ?? 0), 0);
  return {
    aligned,
    rejectedCalls: chains.reduce((n, chain) => n + chain.rejections, 0),
    chains,
    retriesToResolve,
    steps,
    resendTokens: { rejected: sum('rejectedTokens'), resent: sum('resentTokens') },
    defectOnlySteps: steps.filter(step => step.extraFields.length === 0).length,
  };
}

const focusOf = call => String(call.input?.focus_node_id ?? '');
const sameFocus = (a, b) => focusOf(a) === focusOf(b);

/**
 * Offered snippets from which a report citing less than {@link MIN_CITED_SHARE} of them is flagged.
 * The share is set from a production run, not from this repository's runs: a report that cited 33 of 70
 * offered snippets was sound and one that cited 1 of 76 had lost its SQL evidence, so a tenth separates
 * them. Reports of this repository's fixtures cite roughly a fifth to a quarter.
 */
export const MIN_OFFERED_FOR_CITATION_CHECK = 10;
export const MIN_CITED_SHARE = 0.1;

/**
 * What a finding means. A `defect` is a technical fault of the pipeline that a trace shows without reading
 * the answer: it has a stated correct behavior and blocks a push until its root cause is fixed. A `signal`
 * says an answer may be incomplete or wrong; it proves nothing and is verified by reasoning on the question
 * and the SQL before it is called a fault. Neither is a score.
 */
export const RULES = {
  run_not_completed: { kind: 'defect', correct: 'A turn ends with outcome ok, or with a stated stop reason; accepted work is not discarded by a transient fault.' },
  repair_unresolved: { kind: 'defect', correct: 'A rejected call is followed by an accepted resend, or the run ends with a stated stop reason.' },
  same_field_rejected_twice: { kind: 'defect', correct: 'A rejection names the offending field so that the next resend corrects it; one field is not rejected twice in a row.' },
  prune_names_source: { kind: 'defect', correct: 'A node that supplies a column of the trace does not leave the graph without a trace in the report.' },
  source_set_differs_between_runs: { kind: 'defect', correct: 'Repeated runs of one question name the same value inputs for each object.' },
  row_role_set_differs_between_runs: { kind: 'defect', correct: 'Repeated runs of one question name the same row-role contributors for each object.' },
  trace_misaligned: { kind: 'defect', correct: 'Every dispatched call has one tool record, so that every outcome can be read.' },
  repair_needed_several_retries: { kind: 'signal', verify: 'Read the rejection text and the resend: was the fault stated clearly, or did the model misread it?' },
  resend_not_defect_only: { kind: 'signal', verify: 'Read the resend against the rejection: did it carry content the rejection did not name, and did that content change?' },
  snippet_citations_collapsed: { kind: 'signal', verify: 'Read the report against the captured SQL: is the deciding SQL of each formula and predicate still shown, or only prose about it?' },
  snippet_citations_differ_between_runs: { kind: 'signal', verify: 'Read both reports against the captured SQL: which one keeps the deciding SQL, and does the other state anything the SQL does not show?' },
  row_role_contributors_not_kept: { kind: 'signal', verify: 'Read the report: does it state each row rule (filter, partition or order key) that decides which rows feed the traced value?' },
  rejection_answered_not_resent: { kind: 'signal', verify: 'Is the text answer a correct decline for the question (unknown object or column, a request to execute SQL)?' },
  writes_to_rejected: { kind: 'signal', verify: 'Was writes_to required for this procedure hop, and does the field description say so?' },
  discovery_budget_rejected: { kind: 'signal', verify: 'Could the call have been avoided from what the model was told about the scope size?' },
};

const finding = (rule, extra) => ({ rule, kind: RULES[rule].kind, ...extra, ...(RULES[rule].kind === 'defect' ? { correct: RULES[rule].correct } : { verify: RULES[rule].verify }) });

/**
 * Orders findings with the defects first.
 *
 * @param {{ kind: string }[]} items
 */
const defectsFirst = items => [...items].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'defect' ? -1 : 1));

/**
 * Generic rules over one run. Thresholds are declared here, before any run is read. A defect is a fault of
 * the pipeline; a signal is a reason to read the answer against the question and the SQL, never a verdict.
 *
 * @param {ReturnType<typeof runMetrics>} run
 * @returns {{ rule: string, kind: 'defect' | 'signal', focus?: string, detail: string, correct?: string, verify?: string }[]}
 */
export function findings(run) {
  const out = [];
  if (run.outcome !== 'ok') out.push(finding('run_not_completed', { detail: `outcome ${run.outcome}; ${run.hops.filter(hop => hop.status === 'accepted').length} hops accepted` }));
  if (!run.aligned) out.push(finding('trace_misaligned', { detail: 'submission count differs from tool records; hop statuses may be unknown' }));
  for (const conflict of run.conflicts) {
    out.push(finding('prune_names_source', { focus: conflict.focus, detail: `pruned and named as a source in one call: ${conflict.nodes.join(', ')} (${conflict.status})` }));
  }
  for (const chain of run.repair.chains) {
    for (let i = 1; i < chain.paths.length; i += 1) {
      const shared = chain.paths[i - 1].filter(path => chain.paths[i].includes(path));
      if (shared.length > 0) out.push(finding('same_field_rejected_twice', { focus: chain.focus, detail: `${chain.tool}: ${shared.join(', ')}` }));
    }
    if (!chain.resolved && run.outcome === 'ok') out.push(finding('rejection_answered_not_resent', { focus: chain.focus, detail: `${chain.tool} rejected ${chain.rejections} times and the run finished without a resend` }));
    else if (!chain.resolved) out.push(finding('repair_unresolved', { focus: chain.focus, detail: `${chain.tool} rejected ${chain.rejections} times without an accepted resend` }));
    else if (chain.rejections >= 2) out.push(finding('repair_needed_several_retries', { focus: chain.focus, detail: `${chain.tool} accepted at retry ${chain.rejections}` }));
  }
  for (const item of run.rejected) {
    if (item.paths.some(path => path === 'writes_to' || path.endsWith('.writes_to'))) out.push(finding('writes_to_rejected', { detail: `${item.tool}: ${item.paths.join(', ')}` }));
    if (item.code === 'over_discovery_budget') out.push(finding('discovery_budget_rejected', { detail: item.tool }));
  }
  for (const step of run.repair.steps) {
    if (step.rejectedChars < LARGE_CALL_CHARS) continue;
    if (step.extraFields.length > 0 || step.resentChars / step.rejectedChars > MAX_RESEND_SHARE) {
      out.push(finding('resend_not_defect_only', { detail: `${step.tool}: resent ${step.resentChars} of ${step.rejectedChars} characters${step.extraFields.length > 0 ? `; fields beyond the defect: ${step.extraFields.join(', ')}` : ''}` }));
    }
  }
  const dropped = run.hops.filter(hop => hop.status === 'accepted' && hop.rowRole.length > 0);
  if (dropped.length > 0) {
    out.push(finding('row_role_contributors_not_kept', { detail: `${dropped.reduce((n, hop) => n + hop.rowRole.length, 0)} row-role contributors in ${dropped.length} accepted hops reach no column edge` }));
  }
  const { offered, cited } = run.synthesis;
  if (offered >= MIN_OFFERED_FOR_CITATION_CHECK && cited / offered < MIN_CITED_SHARE) {
    out.push(finding('snippet_citations_collapsed', { detail: `${cited} of ${offered} offered snippets cited` }));
  }
  return defectsFirst(out);
}

/**
 * Generic rules over repeated runs of one question.
 *
 * @param {ReturnType<typeof runMetrics>[]} runs
 * @returns {{ rule: string, kind: 'defect' | 'signal', focus?: string, detail: string, correct?: string, verify?: string }[]}
 */
export function spreadFindings(runs) {
  const out = [];
  for (const row of compareRuns(runs)) {
    if (!row.identicalDirect) out.push(finding('source_set_differs_between_runs', { focus: row.focus, detail: `value inputs ${row.directCounts.join('/')}; in some runs only: ${row.onlyInSome.join(', ')}` }));
    else if (!row.identicalRowRole) out.push(finding('row_role_set_differs_between_runs', { focus: row.focus, detail: 'row-role contributors differ' }));
  }
  const cited = runs.map(run => run.synthesis.cited).filter(n => n > 0);
  if (cited.length > 1 && Math.min(...cited) / Math.max(...cited) < MIN_CITED_SHARE) {
    out.push(finding('snippet_citations_differ_between_runs', { detail: `cited per run: ${runs.map(run => run.synthesis.cited).join('/')}` }));
  }
  return defectsFirst(out);
}

/**
 * Compares the accepted hops of repeated runs of one question, per focus object: the sets a hop named as
 * value inputs and as row roles must be identical across runs.
 *
 * @param {object[]} runs - Results of {@link runMetrics}.
 * @returns {{ focus: string, runs: number, identicalDirect: boolean, identicalRowRole: boolean, directCounts: number[], onlyInSome: string[] }[]}
 */
export function compareRuns(runs) {
  const byFocus = new Map();
  runs.forEach((run, runIndex) => {
    const seen = new Set();
    for (const hop of run.hops) {
      if (hop.status !== 'accepted' || seen.has(hop.focus)) continue;
      seen.add(hop.focus);
      if (!byFocus.has(hop.focus)) byFocus.set(hop.focus, []);
      byFocus.get(hop.focus)[runIndex] = hop;
    }
  });
  const rows = [];
  for (const [focus, hops] of byFocus) {
    const present = hops.filter(Boolean);
    if (present.length < 2) continue;
    const same = key => present.every(hop => hop[key].join('|') === present[0][key].join('|'));
    const everySet = present.map(hop => new Set(hop.direct));
    const union = new Set(everySet.flatMap(set => [...set]));
    rows.push({
      focus,
      runs: present.length,
      identicalDirect: same('direct'),
      identicalRowRole: same('rowRole'),
      directCounts: present.map(hop => hop.direct.length),
      onlyInSome: [...union].filter(item => !everySet.every(set => set.has(item))).sort(),
    });
  }
  return rows.sort((a, b) => a.focus.localeCompare(b.focus));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const failOnDefect = args.includes('--fail-on-defect');
  const files = args.filter(arg => arg !== '--fail-on-defect');
  if (files.length === 0) {
    console.error('usage: node tests/tools/trace-metrics.mjs [--fail-on-defect] TRACE.ndjson [TRACE.ndjson ...]');
    process.exit(4);
  }
  const runs = files.map(file => ({ file, ...runMetrics(parseTrace(readFileSync(file, 'utf8'))) }));
  const perRun = runs.map(run => findings(run));
  const spread = runs.length > 1 ? spreadFindings(runs) : [];
  const all = [...perRun.flat(), ...spread];
  console.log(JSON.stringify({
    defects: all.filter(item => item.kind === 'defect'),
    signals: all.filter(item => item.kind === 'signal'),
    runs: runs.map((run, index) => ({ ...run, findings: perRun[index] })),
    spread: runs.length > 1 ? compareRuns(runs) : undefined,
  }, null, 1));
  if (failOnDefect && all.some(item => item.kind === 'defect')) process.exit(1);
}
