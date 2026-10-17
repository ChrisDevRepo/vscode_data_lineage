#!/usr/bin/env node
// Payload-level metrics of recorded runs: what each hop named as a column source, what it pruned,
// what synthesis cited, and how those sets differ between repeated runs of one question.
// Usage: node tests/tools/trace-metrics.mjs TRACE.ndjson [TRACE.ndjson ...]
// Reads the lm-trace NDJSON that `npm run test:ai:headless` writes (verbose or not); prints JSON.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonLines } from './json-lines.mjs';

const TRACE_LINE = Symbol('physicalTraceLine');
const SUBMIT = 'lineage_submit_findings';
const PRESENT = 'lineage_present_result';
const DIRECT = new Set(['pass_through', 'compute', 'aggregate']);
const ROW_ROLE = new Set(['combine', 'filter']);

/** Parses an lm-trace NDJSON text, skipping lines that are not JSON objects. */
export function parseTrace(text) {
  return text.split(/\r?\n/u).flatMap((line, index) => readJsonLines(line).records.map(record => {
    Object.defineProperty(record, TRACE_LINE, { value: index + 1 });
    return record;
  }));
}

/** Classifies one `column_flow` contributor by the contract: a contributor with a direct transform (or none stated) is a value input; one whose transforms are all `combine` or `filter` is a row role. */
export function contributorKind(contributor) {
  const transforms = Array.isArray(contributor.transforms) ? contributor.transforms : [];
  if (transforms.length === 0) return 'direct';
  return transforms.some(t => DIRECT.has(t)) || !transforms.every(t => ROW_ROLE.has(t)) ? 'direct' : 'row_role';
}

/** Summarises one `lineage_submit_findings` input. */
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

/** Distinct captured-snippet ids (`S<n>`) opened as ```sql fences in a text. */
export function snippetIds(text) {
  return new Set([...text.matchAll(/```sql S(\d+)/g)].map(match => `S${match[1]}`));
}

/** Computes payload metrics with tool outcomes and repairs isolated by request id. Every terminal is retained; a failed or cancelled turn makes the whole capture unsuccessful. */
export function runMetrics(records) {
  const calls = [];
  for (const record of records) {
    if (record.type !== 'wire-response') continue;
    for (const call of record.toolCalls ?? []) calls.push({ ...call, requestId: record.requestId, generation: record.generation, phase: record.phase, outputTokens: record.usage?.outputTokens });
  }
  const submits = calls.filter(call => call.name === SUBMIT);
  const measured = measureRetryEpisodes(records);
  const used = new Set();
  const hops = submits.map(call => {
    const outcome = measured.events.find(event => !used.has(event.line) && event.tool === SUBMIT && event.requestId === (call.requestId ?? null) && event.generation === (call.generation ?? null) && event.callId === (call.callId ?? null) && event.input === call.input);
    if (outcome) used.add(outcome.line);
    return {
      requestId: call.requestId, generation: call.generation,
      status: outcome?.status ?? 'unknown', rejectionCode: outcome?.code,
      ...summariseSubmission(call.input ?? {}),
    };
  });
  const rejections = {};
  const rejected = [];
  for (const record of records) {
    if (record.type === 'tool' && record.status === 'rejected') {
      const key = `${record.toolName}:${record.rejectionCode}`;
      rejections[key] = (rejections[key] ?? 0) + 1;
      rejected.push({ tool: record.toolName, code: record.rejectionCode, paths: Array.isArray(record.issuePaths) ? record.issuePaths : [] });
    }
  }
  const turns = records.filter(record => record.type === 'turn-terminal')
    .map(record => ({ requestId: record.requestId, status: record.status ?? 'unknown' }));
  const outcome = ['error', 'cancelled', 'unknown'].find(status => turns.some(turn => turn.status === status))
    ?? (turns.length ? 'ok' : 'unknown');
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
  const repair = repairChains(calls, toolRecords, measured);
  return {
    detailed: detailedMetrics(records),
    aligned: measured.ambiguities.length === 0 && repair.aligned,
    repair,
    hops,
    conflicts: hops.filter(hop => hop.prunedAndNamed.length > 0).map(hop => ({ focus: hop.focus, nodes: hop.prunedAndNamed, status: hop.status })),
    synthesis: { offered: offered.size, cited: cited.size },
    rejections,
    rejected,
    turns,
    outcome,
  };
}

/** Top-level keys a resend always carries; they identify the call and are not part of the defect. */
const IDENTITY_KEYS = new Set(['focus_node_id', 'verdict', 'is_update']);

/** Size of a rejected call, in characters of its input, from which a resend is judged on its size. A small call is cheaper to resend whole than to patch, so only a large exchange is expected to resend the defect only. */
export const LARGE_CALL_CHARS = 4000;
/** Share of the rejected call's characters above which the resend of a large call is not defect-only. */
export const MAX_RESEND_SHARE = 0.5;

/** Follows every rejected call to the call that repaired it: how many replies the repair took, and whether each resend carried only the defect. Outcomes require conservative call/generation association. */
export function repairChains(calls, toolRecords, measured = null) {
  // Legacy direct callers receive conservative associations too; no ordinal zip across missing outcomes.
  if (!measured) {
    const sequence = [];
    for (const [index, record] of toolRecords.entries()) {
      const possible = calls.filter(call => call.name === record.toolName && call.requestId === record.requestId &&
        (record.callId ? call.callId === record.callId : record.generation !== undefined && call.generation === record.generation));
      sequence.push({ type: 'wire-response', requestId: record.requestId, generation: record.generation ?? index,
        toolCalls: possible.length === 1 ? [possible[0]] : [] });
      sequence.push(record);
    }
    measured = measureRetryEpisodes(sequence);
  }

  const chains = measured.episodes.map(episode => ({ requestId: episode.requestId, tool: episode.tool, focus: episode.focus,
    rejections: episode.rejected.length, resolved: episode.terminal.kind === 'accepted_action',
    resolvedAtRetry: episode.terminal.kind === 'accepted_action' ? episode.rejected.length : null,
    paths: episode.rejected.map(event => event.paths ?? []) }));
  const steps = measured.episodes.flatMap(episode => episode.rejected.flatMap(event => {
    if (!event.repair) return [];
    const retry = measured.events.find(item => item.line === event.repair.outcomeLine);
    const defectKeys = new Set((event.paths ?? []).map(path => String(path).split('.')[0]));
    return [{ tool: episode.tool, code: event.code, paths: event.paths ?? [],
      extraFields: Object.keys(retry?.input ?? {}).filter(key => !defectKeys.has(key) && !IDENTITY_KEYS.has(key)).sort(),
      rejectedChars: event.input === null ? 0 : JSON.stringify(event.input).length,
      resentChars: retry?.input == null ? 0 : JSON.stringify(retry.input).length }];
  }));
  const retriesToResolve = { 1: 0, 2: 0, 3: 0, '4+': 0, unresolved: 0 };
  for (const chain of chains) retriesToResolve[!chain.resolved ? 'unresolved' : chain.rejections >= 4 ? '4+' : String(chain.rejections)] += 1;
  // Per-call token estimates are unavailable: generation usage may include several tools.
  return { aligned: measured.ambiguities.length === 0, rejectedCalls: measured.events.filter(event => event.status === 'rejected').length,
    chains, retriesToResolve, steps, resendTokens: { rejected: null, resent: null }, defectOnlySteps: steps.filter(step => step.extraFields.length === 0).length };
}

// Pure diagnostic logic for recorded traces. No inference, SQL interpretation, or source mutation.
// Positions are physical NDJSON lines from parseTrace, else one-based input record indexes; preserve order.
const keyOf = (requestId, generation) => JSON.stringify([requestId ?? null, generation ?? null]);
const elapsed = (from, to) => Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) && Date.parse(to) >= Date.parse(from) ? Date.parse(to) - Date.parse(from) : null;
const textParts = message => (message?.parts ?? []).filter(part => part.type === 'text').map(part => part.value ?? '');
const fieldsOf = input => Object.fromEntries(Object.entries(input ?? {}).flatMap(([key, value]) => key === 'sections' && value && !Array.isArray(value) && typeof value === 'object' ? Object.entries(value).map(([angle, text]) => [`sections.${angle}`, text]) : [[key, value]]));
const heldResend = text => {
  const match = text?.match(/\bHeld: (.*?)\. Resend: (.*?)\./s);
  return match ? { held: match[1].split(',').map(s => s.trim()), required: match[2].split(',').map(s => s.trim()) } : null;
};
function feedbackFor(request, rejection) {
  if (!request) return null;
  if (rejection.callId) {
    for (const message of request.messages ?? []) for (const part of message.parts ?? []) {
      if (part.type === 'tool-result' && part.callId === rejection.callId) return (part.content ?? []).filter(item => item.type === 'text').map(item => item.value ?? '').join('\n');
    }
    return null;
  }
  if (rejection.code === 'missing_required_tool_call') {
    const matches = (request.messages ?? []).flatMap(textParts).filter(text => text.startsWith(`Correction for ${rejection.tool}:`));
    return matches.length === 1 ? matches[0] : null;
  }
  return null;
}
function focusFrom(request) {
  const ids = new Set();
  for (const text of (request?.messages ?? []).flatMap(textParts)) {
    const match = text.match(/\n<hop_context>\n([\s\S]*?)<\/hop_context>/);
    if (!match) continue;
    try { const id = JSON.parse(match[1]).focus_node?.id; if (typeof id === 'string') ids.add(id); } catch {}
  }
  return ids.size === 1 ? [...ids][0] : null;
}
function resendMeasure(rejected, repaired, feedback) {
  const parsed = heldResend(feedback);
  const sent = fieldsOf(repaired.input);
  const base = { classification: 'unknown_no_explicit_held_resend', sentFields: Object.keys(sent), heldFields: parsed?.held ?? null, requiredResendFields: parsed?.required ?? null, additionalHeldFieldsSent: null, unchangedAdditionalHeldFields: null, changedAdditionalHeldFields: null, serializedInputUtf16CodeUnits: repaired.input === null ? null : JSON.stringify(repaired.input).length, serializedInputUtf8Bytes: repaired.input === null ? null : Buffer.byteLength(JSON.stringify(repaired.input), 'utf8') };
  if (!parsed) return base;
  const held = parsed.held.filter(field => !['none', '(none)'].includes(field));
  const extra = held.filter(field => (field in sent || field === 'sections' && Object.keys(sent).some(key => key.startsWith('sections.'))) && !parsed.required.includes(field) && !parsed.required.includes(field.split('.')[0]));
  const before = fieldsOf(rejected.input);
  const other = Object.keys(sent).filter(field => !['focus_node_id', 'verdict', 'is_update'].includes(field) && !parsed.required.includes(field) && !parsed.required.includes(field.split('.')[0]) && !held.includes(field));
  return { ...base, additionalNonHeldFieldsSent: other, onlyRequestedFieldNames: extra.length === 0 && other.length === 0, classification: extra.length === 0 ? other.length === 0 ? 'only_requested_correction' : 'correction_with_other_nonheld_fields' : extra.length === held.length ? 'resent_all_held_fields' : 'resent_some_held_fields', additionalHeldFieldsSent: extra, unchangedAdditionalHeldFields: extra.filter(field => field in before && JSON.stringify(before[field]) === JSON.stringify(sent[field])), changedAdditionalHeldFields: extra.filter(field => field in before && JSON.stringify(before[field]) !== JSON.stringify(sent[field])) };
}
/** Each event's action is isolated by request, tool, and explicit focus; accepted read calls do not end a findings episode. */
function measureRetryEpisodes(records, { trace = null, epoch = null, requestCases = {} } = {}) {
  const requests = new Map(), current = new Map(), pendingCalls = new Map(), generations = [], events = [], episodes = [], open = new Map(), ambiguities = [];
  for (const [index, record] of records.entries()) {
    const line = record[TRACE_LINE] ?? index + 1, requestId = record.requestId ?? null;
    if (record.type === 'wire-request') requests.set(keyOf(requestId, record.generation), { line, record });
    if (record.type === 'wire-response') {
      current.set(requestId, { line, record });
      pendingCalls.set(requestId, (record.toolCalls ?? []).map((call, callIndex) => ({ call, callIndex })));
      const request = requests.get(keyOf(requestId, record.generation));
      generations.push({ trace, epoch, case: requestCases[requestId] ?? null, requestId, generation: record.generation ?? null, requestLine: request?.line ?? null, responseLine: line, requestAt: request?.record.at ?? null, responseAt: record.at ?? null, generationMs: elapsed(request?.record.at, record.at), outputTokens: record.usage?.outputTokens ?? null, toolCount: record.toolCalls?.length ?? 0 });
    }
    if (record.type === 'tool') {
      const response = current.get(requestId), pool = pendingCalls.get(requestId) ?? [];
      const possible = pool.filter(item => record.callId ? item.call.callId === record.callId : item.call.name === record.toolName);
      const synthetic = record.rejectionCode === 'missing_required_tool_call';
      const matched = !synthetic && possible.length === 1 ? possible[0] : null;
      if (matched) pool.splice(pool.indexOf(matched), 1);
      const generation = response?.record.generation ?? null;
      const request = requests.get(keyOf(requestId, generation));
      const focus = matched?.call.input?.focus_node_id ?? (synthetic ? focusFrom(request?.record) : null);
      const event = { trace, epoch, case: requestCases[requestId] ?? null, line, requestId, generation, phase: response?.record.phase ?? record.phase ?? null, tool: record.toolName, focus, status: record.status ?? null, code: record.rejectionCode ?? null, paths: record.issuePaths ?? null, at: record.at ?? null, validationMs: record.durationMs ?? null, callId: matched?.call.callId ?? null, callIndex: matched?.callIndex ?? null, input: matched?.call.input ?? null, match: matched ? record.callId ? 'call_id' : 'unique_tool_current_generation' : synthetic ? 'synthetic_required_call_absent' : possible.length > 1 ? 'ambiguous' : 'missing' };
      events.push(event);
      if (!matched && !synthetic) { ambiguities.push(event); continue; }
      const actionKey = JSON.stringify([requestId, event.phase, event.tool, focus]);
      if (event.status === 'rejected') {
        let episode = open.get(actionKey);
        if (!episode) { episode = { id: `${trace ?? ''}:${requestId}:${line}`, trace, epoch, case: event.case, requestId, phase: event.phase, tool: event.tool, focus, rejected: [], terminal: null }; episodes.push(episode); open.set(actionKey, episode); }
        event.rejectionOrdinal = episode.rejected.length + 1; episode.rejected.push(event);
      } else if (['accepted', 'gate'].includes(event.status) && open.has(actionKey)) {
        open.get(actionKey).terminal = { kind: 'accepted_action', status: event.status, line, at: event.at, generation }; open.delete(actionKey);
      }
    }
    if (record.type === 'turn-terminal') for (const [key, episode] of open) if (episode.requestId === requestId) { episode.terminal = { kind: 'request_ended_without_action_acceptance', status: record.status ?? null, line, at: record.at ?? null }; open.delete(key); }
  }
  for (const episode of episodes) {
    episode.terminal ??= { kind: 'capture_ended', status: null, line: null, at: null };
    episode.outcome = episode.terminal.kind === 'accepted_action' ? `recovered_retry_${episode.rejected.length}` : episode.terminal.status === 'error' ? 'terminal_error_without_recovery' : 'ended_without_action_acceptance';
    episode.durationMs = elapsed(episode.rejected[0].at, episode.terminal.at);
    for (const rejected of episode.rejected) {
      const nextRequest = [...requests.values()].find(item => item.line > rejected.line && item.record.requestId === rejected.requestId);
      const actualFeedback = feedbackFor(nextRequest?.record, rejected);
      rejected.nextServedFeedback = { requestLine: nextRequest?.line ?? null, requestGeneration: nextRequest?.record.generation ?? null, text: actualFeedback, allowedValuesObserved: actualFeedback === null ? null : actualFeedback.includes('Allowed values for'), heldResend: heldResend(actualFeedback) };
      const next = events.find(item => item.line > rejected.line && item.requestId === episode.requestId && item.tool === episode.tool && item.phase === episode.phase && item.focus === episode.focus && ['unique_tool_current_generation', 'call_id', 'synthetic_required_call_absent'].includes(item.match));
      if (!next || (episode.terminal.line !== null && next.line > episode.terminal.line)) { rejected.repair = null; continue; }
      const request = requests.get(keyOf(next.requestId, next.generation)), generation = generations.find(item => item.requestId === next.requestId && item.generation === next.generation);
      const feedback = feedbackFor(request?.record, rejected);
      rejected.repair = { retryOrdinal: rejected.rejectionOrdinal, generation: next.generation, callId: next.callId, outcomeLine: next.line, requestLine: request?.line ?? null, requestAt: request?.record.at ?? null, responseAt: generation?.responseAt ?? null, outcomeAt: next.at, status: next.status, generationMs: generation?.generationMs ?? null, rejectionToOutcomeMs: elapsed(rejected.at, next.at), validationMs: next.validationMs, feedback, allowedValuesObserved: feedback === null ? null : feedback.includes('Allowed values for'), resend: resendMeasure(rejected, next, feedback) };
    }
  }
  return { trace, epoch, generations, episodes, events, ambiguities };
}
function sampleStatistics(values) {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  const percentile = p => { const position = (sorted.length - 1) * p, lower = Math.floor(position); return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * (position - lower); };
  return { n: sorted.length, minMs: sorted[0] ?? null, medianMs: sorted.length ? percentile(.5) : null, p90Ms: sorted.length ? percentile(.9) : null, maxMs: sorted.at(-1) ?? null };
}
function summariseRetryMeasurements(measurements) {
  const episodes = measurements.flatMap(item => item.episodes), generations = measurements.flatMap(item => item.generations), rejected = episodes.flatMap(item => item.rejected), repairs = rejected.flatMap(item => item.repair ? [item.repair] : []);
  const count = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
  return { episodes: episodes.length, rejectedEvents: rejected.length, outcomes: count(episodes.map(item => item.outcome)), generationCount: generations.length, generationLatency: sampleStatistics(generations.map(item => item.generationMs)), rejectionValidationLatency: sampleStatistics(rejected.map(item => item.validationMs)), resendClasses: count(repairs.map(item => item.resend.classification)), actualFeedbackByRejectionOrdinal: Object.fromEntries([...new Set(rejected.map(item => item.rejectionOrdinal))].sort().map(ordinal => { const own = rejected.filter(item => item.rejectionOrdinal === ordinal); return [ordinal, { rejectedEvents: own.length, feedbackCaptured: own.filter(item => item.nextServedFeedback.text !== null).length, allowedValuesObserved: own.filter(item => item.nextServedFeedback.allowedValuesObserved === true).length }]; })), additionalHeldFieldOccurrences: { unchanged: repairs.reduce((sum, item) => sum + (item.resend.unchangedAdditionalHeldFields?.length ?? 0), 0), changed: repairs.reduce((sum, item) => sum + (item.resend.changedAdditionalHeldFields?.length ?? 0), 0) }, retries: Object.fromEntries([...new Set(repairs.map(item => item.retryOrdinal))].sort().map(ordinal => { const own = repairs.filter(item => item.retryOrdinal === ordinal); return [ordinal, { attempts: own.length, outcomes: count(own.map(item => item.status)), generationLatency: sampleStatistics(own.map(item => item.generationMs)), rejectToRepairOutcomeLatency: sampleStatistics(own.map(item => item.rejectionToOutcomeMs)), validationLatency: sampleStatistics(own.map(item => item.validationMs)), actualAllowedValuesObserved: own.filter(item => item.allowedValuesObserved === true).length, missingFeedback: own.filter(item => item.feedback === null).length }]; })), ambiguities: measurements.flatMap(item => item.ambiguities).map(item => ({ trace: item.trace, line: item.line, requestId: item.requestId, tool: item.tool, match: item.match })) };
}

/** Literal authored markup measurements; these counts do not grade SQL, formula meaning or rendering. */
export function measureMarkup(text) {
  const fences = [], outside = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!open && fence) { open = { marker: fence[1][0], length: fence[1].length, label: fence[2].trim() }; continue; }
    if (open) {
      if (fence && fence[1][0] === open.marker && fence[1].length >= open.length && !fence[2].trim()) { fences.push({ ...open, closed: true }); open = null; }
    } else outside.push(line);
  }
  if (open) fences.push({ ...open, closed: false });
  const prose = outside.join('\n');
  const count = pattern => [...prose.matchAll(pattern)].length;
  return {
    utf16CodeUnits: text.length, utf8Bytes: Buffer.byteLength(text, 'utf8'),
    fences: { count: fences.length, closed: fences.filter(item => item.closed).length,
      sql: fences.filter(item => /^sql(?:\s|$)/i.test(item.label)).length,
      sqlClosed: fences.filter(item => item.closed && /^sql(?:\s|$)/i.test(item.label)).length,
      labels: fences.map(item => item.label) },
    labels: { headings: outside.filter(line => /^ {0,3}#{1,6}\s+\S/.test(line)).length, standaloneBold: outside.filter(line => /^\s*(?:\*\*[^*]+\*\*|__[^_]+__)\s*:?[ \t]*$/.test(line)).length },
    formulaMarkup: { dollarDisplay: count(/(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$/g),
      bracketDisplay: count(/\\\[[\s\S]*?\\\]/g), parenthesisInline: count(/\\\([\s\S]*?\\\)/g),
      dollarInline: [...prose.replace(/(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$/g, '').matchAll(/(?<![\\$])\$(?!\$)[^\n$]+?(?<!\\)\$(?!\$)/g)].length },
  };
}

/** Measure only an explicitly supplied canonical report; metadata array absence stays unknown. */
export function measureFinalReport(report, representation) {
  if (!['markdown', 'present_result_json'].includes(representation)) throw new Error('reportRepresentation must be markdown or present_result_json');
  const metadata = representation === 'present_result_json' ? report?.aiMetadata : null;
  const text = representation === 'present_result_json' ? metadata?.description : report;
  if (typeof text !== 'string') return null;
  return { ...measureMarkup(text), representation,
    metadataCounts: metadata ? {
      highlightGroups: Array.isArray(metadata.highlightGroups) ? metadata.highlightGroups.length : null,
      highlightGroupLabels: Array.isArray(metadata.highlightGroups) ? metadata.highlightGroups.filter(group => typeof group?.label === 'string').length : null,
      badges: Array.isArray(metadata.badges) ? metadata.badges.length : null,
      notes: Array.isArray(metadata.notes) ? metadata.notes.length : null,
    } : null };
}

const sizesOf = input => input == null ? { utf16CodeUnits: null, utf8Bytes: null } : {
  utf16CodeUnits: JSON.stringify(input).length, utf8Bytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
};
const stringLeaves = (value, path = '') => typeof value === 'string' ? [{ path, value }] :
  value && typeof value === 'object' ? Object.entries(value).flatMap(([key, child]) => stringLeaves(child, path ? `${path}.${key}` : key)) : [];

/** Counts usage once per recorded response, with explicit field coverage; absent totals remain unknown. */
function measureUsage(responses) {
  const fields = { input: ['inputTokens', 'promptTokens'], output: ['outputTokens', 'completionTokens'], total: ['totalTokens'], reasoning: ['reasoningTokens'] };
  return { generations: responses.length, cache: { supported: false, total: null, coveredGenerations: 0, missingGenerations: responses.length, reason: 'Captured TokenUsage contract does not expose cache token fields.' }, ...Object.fromEntries(Object.entries(fields).map(([name, keys]) => {
    const values = responses.map(record => keys.map(key => record.usage?.[key]).find(value => typeof value === 'number' && Number.isFinite(value)));
    const known = values.filter(value => value !== undefined);
    return [name, { total: known.length === responses.length && responses.length ? known.reduce((sum, value) => sum + value, 0) : null,
      observedTotal: known.length ? known.reduce((sum, value) => sum + value, 0) : null, coveredGenerations: known.length, missingGenerations: responses.length - known.length }];
  })) };
}

/** Deterministic per-case diagnostics. Supply only records belonging to the case. finalSnapshot is an explicitly captured final projection { nodes: [], columnEdges: [] }; omitted arrays remain unknown. Causal annotations are caller supplied, never inferred here. Raw authored text, SQL, tool arguments and feedback are deliberately excluded. */
export function detailedMetrics(records, { finalSnapshot = null, causalAnnotations = [] } = {}) {
  const measured = measureRetryEpisodes(records);
  const responses = records.filter(record => record.type === 'wire-response');
  const requests = records.filter(record => record.type === 'wire-request');
  const hasWireKey = record => record.requestId != null && record.generation != null;
  const sameWireKey = (a, b) => a.requestId === b.requestId && a.generation === b.generation;
  const unreturnedRequests = requests.filter(request => hasWireKey(request) && requests.filter(other => sameWireKey(request, other)).length === 1 && !responses.some(response => sameWireKey(request, response)));
  const wireEvents = { requests: requests.length, responses: responses.length, errors: records.filter(record => record.type === 'wire-error').length,
    requestsWithoutCapturedResponse: unreturnedRequests.length,
    unknownRequestKeys: requests.filter(request => !hasWireKey(request)).length,
    unknownResponseKeys: responses.filter(response => !hasWireKey(response)).length,
    ambiguousRequestKeys: requests.filter(request => hasWireKey(request) && (requests.filter(other => sameWireKey(request, other)).length > 1 || responses.filter(response => sameWireKey(request, response)).length > 1)).length,
    ambiguousResponseKeys: responses.filter(response => hasWireKey(response) && responses.filter(other => sameWireKey(response, other)).length > 1).length,
    unreturnedRequests: unreturnedRequests.map(request => ({ requestId: request.requestId, generation: request.generation })) };

  const reports = responses.flatMap(record => (record.toolCalls ?? []).flatMap((call, callIndex) => call.name === PRESENT ? [{ record, call, callIndex }] : []));
  const reportMeasurements = reports.map(({ record, call, callIndex }) => {
    const event = measured.events.find(item => item.requestId === (record.requestId ?? null) && item.generation === (record.generation ?? null) && item.callIndex === callIndex);
    return { requestId: record.requestId ?? null, generation: record.generation ?? null, callIndex,
      status: event?.status ?? 'unknown', serializedInput: sizesOf(call.input),
      fields: stringLeaves(call.input).map(({ path, value }) => ({ path, ...measureMarkup(value) })) };
  });
  const repairs = measured.episodes.flatMap(episode => episode.rejected.flatMap(event => event.repair ? [event.repair] : []));
  const repairGenerations = new Set(repairs.map(repair => keyOf(measured.events.find(event => event.line === repair.outcomeLine)?.requestId, repair.generation)));
  const summary = summariseRetryMeasurements([measured]);
  // Summary counts include unmatched rejected events too; episodes require a defensible action association.
  summary.rejectedEvents = measured.events.filter(event => event.status === 'rejected').length;
  summary.wireEvents = wireEvents;
  const lifecycle = records.filter(record => record.type === 'turn-start' || record.type === 'turn-terminal');
  const turns = [...new Set(lifecycle.map(record => record.requestId ?? null))].map(requestId => {
    const own = lifecycle.filter(record => (record.requestId ?? null) === requestId);
    const starts = own.filter(record => record.type === 'turn-start');
    const terminals = own.filter(record => record.type === 'turn-terminal');
    const start = starts.length === 1 ? starts[0] : null;
    const terminal = terminals.length === 1 ? terminals[0] : null;
    return { requestId, startAt: start?.at ?? null, terminalAt: terminal?.at ?? null, status: terminal?.status ?? null,
      durationMs: typeof terminal?.durationMs === 'number' && Number.isFinite(terminal.durationMs) && terminal.durationMs >= 0 ? terminal.durationMs : null,
      traceElapsedMs: elapsed(start?.at, terminal?.at) };
  });
  const recordedDurations = turns.map(turn => turn.durationMs).filter(value => value !== null);
  const observedDurationMs = recordedDurations.length ? recordedDurations.reduce((sum, value) => sum + value, 0) : null;
  const turnTiming = { traceElapsedMs: elapsed(lifecycle.find(record => record.type === 'turn-start')?.at, lifecycle.findLast(record => record.type === 'turn-terminal')?.at),
    recordedDurationMs: recordedDurations.length === turns.length && turns.length ? observedDurationMs : null,
    observedRecordedDurationMs: observedDurationMs, coveredTurns: recordedDurations.length, missingTurns: turns.length - recordedDurations.length };

  return { version: 1, definitions: { characterUnit: 'UTF-16 code units', byteUnit: 'UTF-8 bytes',
    turnTiming: 'Per-turn durationMs is the captured terminal duration; traceElapsedMs uses captured start/terminal timestamps, and the overall span includes gaps between turns. Missing, reversed or ambiguous endpoints remain null. No provider queue decomposition is inferred.',
    usage: 'Captured response usage only, not billing completeness. Unreturned requests have unknown usage. One sample per wire-response; repair usage counts each matching generation once, including all calls in that generation.',
    markup: 'Literal authored delimiters outside code fences; no SQL, formula, rendering or quality verdict.',
    lineReferences: 'Physical NDJSON lines when parsed with parseTrace; otherwise one-based supplied-record indexes.',
    labels: 'ATX headings and standalone bold text lines outside fences; literal syntax counts only.',
    matching: 'Explicit callId, else unique tool name in current response of same request; synthetic missing-required-call events do not consume authored calls.' },
    summary, usage: measureUsage(responses), repairUsage: measureUsage(responses.filter(record => repairGenerations.has(keyOf(record.requestId, record.generation)))),
    turns, turnTiming,
    generations: measured.generations,
    events: measured.events.map(({ input, ...event }) => {
      const { nextServedFeedback, repair, ...base } = event;
      return { ...base, serializedInput: sizesOf(input),
        ...(nextServedFeedback ? { nextServedFeedback: { ...nextServedFeedback, text: undefined, captured: nextServedFeedback.text !== null } } : {}),
        ...(repair ? { repair: { ...repair, feedback: undefined, feedbackCaptured: repair.feedback !== null } } : {}) };
    }),
    episodes: measured.episodes.map(({ rejected, ...episode }) => ({ ...episode, rejectionLines: rejected.map(event => event.line) })),
    reports: { attempted: reports.length, accepted: reportMeasurements.filter(report => report.status === 'accepted' || report.status === 'gate').length,
      rejected: reportMeasurements.filter(report => report.status === 'rejected').length, unknown: reportMeasurements.filter(report => report.status === 'unknown').length, measurements: reportMeasurements },
    finalGraph: { nodes: Array.isArray(finalSnapshot?.nodes) ? finalSnapshot.nodes.length : null,
      columnEdges: Array.isArray(finalSnapshot?.columnEdges) ? finalSnapshot.columnEdges.length : null, source: finalSnapshot === null ? 'unavailable' : 'explicit_final_snapshot' },
    causalAnnotations,
  };
}

/** Write exactly the same bytes for the same JSON-safe input; no generated timestamps. */
export function writeMetricsReport(path, metrics) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
}

/** Citation counts prompt manual review when many snippets were offered and few were cited. */
export const MIN_OFFERED_FOR_CITATION_CHECK = 10;
export const MIN_CITED_SHARE = 0.1;

/** Operational failures are defects; differences in authored content are signals for side-by-side SQL review. */
export const RULES = {
  run_not_completed: { kind: 'defect', correct: 'A turn ends with outcome ok, or with a stated stop reason; accepted work is not discarded by a transient fault.' },
  repair_unresolved: { kind: 'defect', correct: 'A rejected call is followed by an accepted resend, or the run ends with a stated stop reason.' },
  same_field_rejected_twice: { kind: 'signal', verify: 'Read both rejections and repairs: did the fault persist, or did the next call expose a different defect in the same field?' },
  prune_names_source: { kind: 'signal', verify: 'Compare the accepted prune with the SQL and report: was the source evidence retained?' },
  source_set_differs_between_runs: { kind: 'signal', verify: 'Confirm matching inputs and scope, then compare both source sets against the SQL.' },
  row_role_set_differs_between_runs: { kind: 'signal', verify: 'Confirm matching inputs and scope, then compare both row-role sets against the SQL.' },
  trace_misaligned: { kind: 'defect', correct: 'Every dispatched call has one tool record, so that every outcome can be read.' },
  repair_needed_several_retries: { kind: 'signal', verify: 'Read the rejection text and the resend: was the fault stated clearly, or did the model misread it?' },
  resend_not_defect_only: { kind: 'signal', verify: 'Read the resend against the rejection: did it carry content the rejection did not name, and did that content change?' },
  snippet_citations_collapsed: { kind: 'signal', verify: 'Read the report against the captured SQL: is the deciding SQL of each formula and predicate still shown, or only prose about it?' },
  snippet_citations_differ_between_runs: { kind: 'signal', verify: 'Read both reports against the captured SQL: which one keeps the deciding SQL, and does the other state anything the SQL does not show?' },
  row_role_contributors_not_kept: { kind: 'signal', verify: 'Read the report: does it state each row rule (filter, partition or order key) that decides which rows feed the traced value?' },
  rejection_answered_not_resent: { kind: 'signal', verify: 'Is the text answer a correct decline for the question (unknown object or column, a request to execute SQL)?' },
  writes_to_rejected: { kind: 'signal', verify: 'Was writes_to required for this procedure hop, and does the field description say so?' },
  discovery_budget_rejected: { kind: 'signal', verify: 'Could the call have been avoided from what the model was told about the scope size?' },
  rejections_regressed_between_runs: { kind: 'signal', verify: 'Read rejected tool calls: did candidate produce tool rejections where baseline had none or fewer?' },
  resend_tokens_regressed_between_runs: { kind: 'signal', verify: 'Compare repair token volume between runs: did candidate consume substantially more tokens repairing errors?' },
};

const finding = (rule, extra) => ({ rule, kind: RULES[rule].kind, ...extra, ...(RULES[rule].kind === 'defect' ? { correct: RULES[rule].correct } : { verify: RULES[rule].verify }) });

/** Orders findings with the defects first. */
const defectsFirst = items => [...items].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'defect' ? -1 : 1));

/** Generic rules over one run. Thresholds are declared here, before any run is read. A defect is a fault of the pipeline; a signal is a reason to read the answer against the question and the SQL, never a verdict. */
export function findings(run) {
  const out = [];
  if (run.outcome !== 'ok') out.push(finding('run_not_completed', { detail: `outcome ${run.outcome}; ${run.hops.filter(hop => hop.status === 'accepted').length} hops accepted` }));
  if (!run.aligned) out.push(finding('trace_misaligned', { detail: 'submission count differs from tool records; hop statuses may be unknown' }));
  for (const conflict of run.conflicts.filter(item => item.status === 'accepted')) {
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

/** Signals for manually selected baseline/candidate captures of the same question. */
export function spreadFindings(runs) {
  const out = [];
  for (const row of compareRuns(runs)) {
    if (!row.identicalDirect) out.push(finding('source_set_differs_between_runs', { focus: row.focus, detail: `value inputs ${row.directCounts.join('/')}; in some runs only: ${row.onlyInSome.join(', ')}` }));
    else if (!row.identicalRowRole) out.push(finding('row_role_set_differs_between_runs', { focus: row.focus, detail: 'row-role contributors differ' }));
  }
  const cited = runs.map(run => run.synthesis.cited);
  if (cited.length > 1 && Math.max(...cited) > 0 && Math.min(...cited) / Math.max(...cited) < MIN_CITED_SHARE) {
    out.push(finding('snippet_citations_differ_between_runs', { detail: `cited per run: ${runs.map(run => run.synthesis.cited).join('/')}` }));
  }
  // The first run is the baseline and the last the candidate; a drop is an improvement, not a regression.
  const rejections = runs.map(run => run.repair?.rejectedCalls ?? 0);
  if (rejections.length > 1 && rejections.at(-1) > rejections[0]) {
    out.push(finding('rejections_regressed_between_runs', { detail: `rejected calls per run: ${rejections.join('/')}` }));
  }
  const resendTokens = runs.map(run => run.repair?.resendTokens?.resent ?? null);
  if (resendTokens.length > 1 && resendTokens.every(value => value !== null) && resendTokens.at(-1) > 0 && resendTokens[0] === 0) {
    out.push(finding('resend_tokens_regressed_between_runs', { detail: `resend repair tokens per run: ${resendTokens.join('/')}` }));
  }
  return defectsFirst(out);
}

/** Compares the accepted hops of repeated runs of one question, per focus object: the sets a hop named as value inputs and row roles are reported for manual review, without judging content quality. */
export function compareRuns(runs) {
  const byFocus = new Map();
  runs.forEach((run, runIndex) => {
    for (const hop of run.hops) {
      if (hop.status !== 'accepted') continue;
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

/** Character length of the canonical preview, falling back to streamed answer text when that preview is absent. */
export function previewCharCount(runDir) {
  if (!existsSync(runDir)) return null;
  let chars = null;
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('turn-')) continue;
    const turnDir = join(runDir, entry.name);
    const reportPath = join(turnDir, 'present-result.json');
    let length = null;
    if (existsSync(reportPath)) {
      try {
        const description = JSON.parse(readFileSync(reportPath, 'utf8'))?.aiMetadata?.description;
        if (typeof description === 'string') length = description.length;
      } catch { length = null; }
    }
    if (length === null) {
      const answerPath = join(turnDir, 'answer.md');
      if (existsSync(answerPath)) length = readFileSync(answerPath, 'utf8').length;
    }
    if (length !== null) chars = (chars ?? 0) + length;
  }
  return chars;
}

/** Finds the most recent NDJSON traces in the test-results/headless directory. */
export function findLatestTraces(dir = 'test-results/headless', count = 2) {
  const traces = [];
  function walk(d) {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ndjson')) {
        traces.push({ file: full, mtime: statSync(full).mtimeMs });
      }
    }
  }
  walk(dir);
  return traces.sort((a, b) => b.mtime - a.mtime).slice(0, count).map(t => t.file).reverse();
}

/** Generates an executive BI scorecard comparing candidate run to baseline run with RAG status. */
export function generateScorecard(base, cand) {
  const diffPct = (b, c) => (b === 0 ? (c === 0 ? 0 : 100) : Number((((c - b) / b) * 100).toFixed(1)));
  const diffVal = (b, c) => c - b;

  const baseRej = base.repair?.rejectedCalls ?? 0;
  const candRej = cand.repair?.rejectedCalls ?? 0;
  const baseResend = base.repair?.resendTokens?.resent ?? null;
  const candResend = cand.repair?.resendTokens?.resent ?? null;
  const baseHops = base.hops?.length ?? 0;
  const candHops = cand.hops?.length ?? 0;
  const baseCitations = base.synthesis?.cited ?? 0;
  const candCitations = cand.synthesis?.cited ?? 0;

  const baseDurSec = base.durationMs != null ? Number((base.durationMs / 1000).toFixed(1)) : null;
  const candDurSec = cand.durationMs != null ? Number((cand.durationMs / 1000).toFixed(1)) : null;
  const baseChars = base.chars ?? null;
  const candChars = cand.chars ?? null;

  const baseTok = base.tokens?.total ?? null;
  const candTok = cand.tokens?.total ?? null;

  return {
    rejections: {
      baseline: baseRej,
      candidate: candRej,
      diff: diffVal(baseRej, candRej),
      rag: candRej > baseRej ? 'RED' : 'GREEN',
    },
    resendTokens: {
      baseline: baseResend,
      candidate: candResend,
      diff: baseResend === null || candResend === null ? null : diffVal(baseResend, candResend),
      rag: baseResend === null || candResend === null ? 'UNKNOWN' : candResend > baseResend ? 'RED' : 'GREEN',
    },
    hops: {
      baseline: baseHops,
      candidate: candHops,
      diff: diffVal(baseHops, candHops),
      rag: candHops === baseHops ? 'GREEN' : Math.abs(candHops - baseHops) <= 1 ? 'AMBER' : 'RED',
    },
    citations: {
      baseline: baseCitations,
      candidate: candCitations,
      diff: diffVal(baseCitations, candCitations),
      rag: candCitations >= baseCitations ? 'GREEN' : candCitations === 0 ? 'RED' : 'AMBER',
    },
    durationSec: candDurSec !== null && baseDurSec !== null ? {
      baseline: baseDurSec,
      candidate: candDurSec,
      diffSec: Number((candDurSec - baseDurSec).toFixed(1)),
      diffPct: diffPct(baseDurSec, candDurSec),
      rag: candDurSec <= baseDurSec * 1.2 ? 'GREEN' : candDurSec <= baseDurSec * 3 ? 'AMBER' : 'RED',
    } : undefined,
    previewChars: candChars !== null && baseChars !== null ? {
      baseline: baseChars,
      candidate: candChars,
      diff: diffVal(baseChars, candChars),
      diffPct: diffPct(baseChars, candChars),
      rag: Math.abs(diffPct(baseChars, candChars)) <= 15 ? 'GREEN' : candChars < baseChars * 0.5 ? 'RED' : 'AMBER',
    } : undefined,
    tokens: candTok !== null && baseTok !== null ? {
      baseline: baseTok,
      candidate: candTok,
      diff: diffVal(baseTok, candTok),
      diffPct: diffPct(baseTok, candTok),
      rag: candTok <= baseTok * 1.15 ? 'GREEN' : 'AMBER',
    } : undefined,
    verdict: (cand.outcome === 'ok' && candRej <= baseRej) ? 'PASS' : 'REGRESSION',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
  const manifestIndex = args.indexOf('--case-manifest');
  if (manifestIndex >= 0) {
    if (!outputPath || !args[manifestIndex + 1] || args.length !== 4) throw new Error('--case-manifest FILE requires --output FILE');
    const manifest = JSON.parse(readFileSync(args[manifestIndex + 1], 'utf8'));
    const ids = new Set(manifest.requestIds ?? []);
    const records = parseTrace(readFileSync(manifest.tracePath, 'utf8')).filter(record => manifest.requestIds === undefined || ids.has(record.requestId));
    const finalSnapshot = manifest.finalSnapshotPath && existsSync(manifest.finalSnapshotPath) ? JSON.parse(readFileSync(manifest.finalSnapshotPath, 'utf8')) : null;
    const reportText = manifest.reportPath && existsSync(manifest.reportPath) ? readFileSync(manifest.reportPath, 'utf8') : null;
    const finalReportMarkup = reportText === null ? null : measureFinalReport(manifest.reportRepresentation === 'present_result_json' ? JSON.parse(reportText) : reportText, manifest.reportRepresentation);
    writeMetricsReport(outputPath, { identity: { catalogId: manifest.catalogId ?? null, question: manifest.question ?? null, questionHash: manifest.questionHash ?? null, fixtureHash: manifest.fixtureHash ?? null, caseIdentity: manifest.caseIdentity ?? null,
      requestIds: manifest.requestIds ?? [], outcome: manifest.outcome ?? null }, context: manifest.context ?? null,
      answerMarkup: manifest.answerPath && existsSync(manifest.answerPath) ? { ...measureMarkup(readFileSync(manifest.answerPath, 'utf8')), representation: manifest.answerRepresentation ?? 'markdown', ...(manifest.answerRepresentation === 'rendered_text' ? { fences: null, formulaMarkup: null, labels: null } : {}) } : null,
      finalReportMarkup,
      ...detailedMetrics(records, { finalSnapshot, causalAnnotations: manifest.causalAnnotations ?? [] }) });
    process.exit(0);
  }
  if (outputIndex >= 0) {
    if (!outputPath || outputPath.startsWith('--')) throw new Error('--output requires a path');
    args.splice(outputIndex, 2);
  }
  const failOnDefect = args.includes('--fail-on-defect');
  const scorecard = args.includes('--scorecard');
  const latestIndex = args.indexOf('--latest');
  const latestCount = latestIndex !== -1 && /^\d+$/.test(args[latestIndex + 1] ?? '') ? Number(args[latestIndex + 1]) : 2;
  const usage = 'usage: node tests/tools/trace-metrics.mjs [--output PATH] [--case-manifest FILE] [--fail-on-defect] [--scorecard] [--latest [N] | TRACE.ndjson ...]';
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  const unknown = args.filter(arg => arg.startsWith('-') && !['--fail-on-defect', '--latest', '--scorecard'].includes(arg));
  let files = args.filter((arg, index) => !arg.startsWith('-') && !(latestIndex !== -1 && index === latestIndex + 1 && /^\d+$/.test(arg)));
  if (unknown.length > 0 || (latestIndex !== -1 && files.length > 0)) {
    console.error(unknown.length > 0 ? `unknown option: ${unknown.join(' ')}` : '--latest and explicit trace files are exclusive');
    console.error(usage);
    process.exit(2);
  }
  if (latestIndex !== -1) files = findLatestTraces('test-results/headless', latestCount);
  if (files.length === 0) {
    console.error(usage);
    process.exit(4);
  }
  const runs = files.map(file => {
    const rawTrace = parseTrace(readFileSync(file, 'utf8'));
    const metrics = runMetrics(rawTrace);

    // Contextual duration and character length from run environment if available
    let durationMs;
    let chars;

    try {
      const runDir = join(file, '..', '..');
      const runJsonPath = join(runDir, 'run.json');
      if (existsSync(runJsonPath)) {
        const runJson = JSON.parse(readFileSync(runJsonPath, 'utf8'));
        durationMs = runJson.durationMs;
      }
      chars = previewCharCount(runDir);
    } catch {}

    return {
      file,
      durationMs,
      chars,
      tokens: { input: metrics.detailed.usage.input.total, output: metrics.detailed.usage.output.total, total: metrics.detailed.usage.total.total, coverage: metrics.detailed.usage },
      ...metrics,
    };
  });
  const perRun = runs.map(run => findings(run));
  const spread = runs.length > 1 ? spreadFindings(runs) : [];
  const all = [...perRun.flat(), ...spread];

  const output = {
    defects: all.filter(item => item.kind === 'defect'),
    signals: all.filter(item => item.kind === 'signal'),
    runs: runs.map((run, index) => ({ ...run, findings: perRun[index] })),
    spread: runs.length > 1 ? compareRuns(runs) : undefined,
    scorecard: (scorecard || runs.length === 2) && runs.length >= 2 ? generateScorecard(runs[0], runs.at(-1)) : undefined,
  };

  if (outputPath) writeMetricsReport(outputPath, output);
  else console.log(JSON.stringify(output, null, 1));
  if (failOnDefect && all.some(item => item.kind === 'defect')) process.exit(1);
}
