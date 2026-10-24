#!/usr/bin/env node
// Hard-fact comparison of one candidate run with stored previous and main runs.
// Usage: node tests/tools/lineage-score.mjs CANDIDATE --out DIR [--previous DIR] [--main DIR]
// Reads captures that already exist. It does not call a model or grade answer correctness.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { findings, measureMarkup, parseTrace, runMetrics, runTraceMetrics } from './trace-metrics.mjs';

const PRUNE_TOOL = 'lineage_prune_current';
const START_TOOL = 'lineage_start_exploration';

/** Stable identity of one column-lineage edge. */
export function pairKey(edge) {
  return `${edge?.from_node ?? ''}|${edge?.from_col ?? ''}|${edge?.to_node ?? ''}|${edge?.to_col ?? ''}`;
}

/** Edge keys in file order. `null` when this side recorded no edge list. */
export function pairSequence(edges) {
  if (!Array.isArray(edges)) return null;
  return edges.map(pairKey);
}

/** Order-sensitive list compare. Both sides absent is equal. One side absent is an unresolved difference requiring review. */
export function compareSequences(baseline, candidate) {
  if (baseline == null && candidate == null) return { status: 'absent', differs: false };
  if (baseline == null) return { status: 'missing_baseline', differs: true };
  if (candidate == null) return { status: 'missing_candidate', differs: true };
  const same = baseline.length === candidate.length && baseline.every((item, index) => item === candidate[index]);
  return { status: same ? 'equal' : 'different', differs: !same,
    lost: [...new Set(baseline)].filter(item => !candidate.includes(item)),
    added: [...new Set(candidate)].filter(item => !baseline.includes(item)) };
}

/** Compares column-edge sets. Order-only changes are signals; missing sides require review. */
export function comparePairSets(baselineEdges, candidateEdges) {
  const baseline = pairSequence(baselineEdges);
  const candidate = pairSequence(candidateEdges);
  if (baseline === null && candidate === null) return { status: 'absent', differs: false, signal: null, lost: [], added: [] };
  if (baseline === null) return { status: 'missing_baseline', differs: true, signal: null, lost: [], added: [] };
  if (candidate === null) return { status: 'missing_candidate', differs: true, signal: null, lost: [], added: [] };
  const baseSet = new Set(baseline);
  const candSet = new Set(candidate);
  const lost = [...baseSet].filter(item => !candSet.has(item)).sort();
  const added = [...candSet].filter(item => !baseSet.has(item)).sort();
  const sameSet = lost.length === 0 && added.length === 0;
  const sameOrder = sameSet && baseline.length === candidate.length && baseline.every((item, index) => item === candidate[index]);
  return {
    status: sameSet ? (sameOrder ? 'equal' : 'order_only') : 'different',
    differs: !sameSet,
    signal: sameSet && !sameOrder ? 'order_only' : null,
    lost,
    added,
  };
}

/** Reads JSON when the file exists. */
export function readJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** BFS and column-edge view of one turn. Only an explicit unopened marker proves no exploration. */
export function graphOfTurn(turnDir, records) {
  const state = readJson(join(turnDir, 'sm-state.json'));
  const snapshot = readJson(join(turnDir, 'final-snapshot.json'));
  const unopened = state?.explorationOpened === false;
  if (unopened && snapshot === undefined) return { status: 'no_exploration' };
  if (state === undefined && snapshot === undefined) return { status: provesNoExploration(records) ? 'no_exploration' : 'missing_capture' };
  return {
    status: 'present',
    visited: Array.isArray(state?.visited) ? state.visited : null,
    agenda: Array.isArray(state?.agenda) ? state.agenda.map(entry => entry?.nodeId ?? null) : null,
    finalNodes: Array.isArray(snapshot?.nodes) ? snapshot.nodes : null,
    columnEdges: state?.columnAspect?.edges ?? null,
    snapshotEdges: snapshot?.columnEdges ?? null,
  };
}

function provesNoExploration(records) {
  return Array.isArray(records) && records.length > 0
    && !findings(runMetrics(records)).some(item => item.kind === 'defect')
    && !records.some(record => record.type === 'tool' && record.toolName === 'lineage_start_exploration'
      || record.type === 'wire-response' && record.toolCalls?.some(call => call.name === 'lineage_start_exploration'));
}

/** Compares graph facts as unresolved differences, including missing sides. Visit order is significant. */
export function compareGraphs(baseline, candidate) {
  if (baseline.status === 'missing_capture' || candidate.status === 'missing_capture') {
    return { status: baseline.status === candidate.status ? 'absent' : baseline.status === 'missing_capture' ? 'missing_baseline' : 'missing_candidate',
      differs: baseline.status !== candidate.status };
  }
  if (baseline.status === 'no_exploration' && candidate.status === 'no_exploration') return { status: 'no_exploration', differs: false };
  if (baseline.status === 'no_exploration') return { status: 'missing_baseline', differs: true };
  if (candidate.status === 'no_exploration') return { status: 'missing_candidate', differs: true };
  const visited = compareSequences(baseline.visited, candidate.visited);
  const agenda = compareSequences(baseline.agenda, candidate.agenda);
  const finalNodes = compareSequences(baseline.finalNodes, candidate.finalNodes);
  const columnAspect = comparePairSets(baseline.columnEdges, candidate.columnEdges);
  const snapshotEdges = comparePairSets(baseline.snapshotEdges, candidate.snapshotEdges);
  const differs = [visited, agenda, finalNodes, columnAspect, snapshotEdges].some(item => item.differs);
  return { status: differs ? 'differs' : 'equal', differs, visited, agenda, finalNodes, columnAspect, snapshotEdges };
}

/** Preview text, chat-window text, and literal SQL-fence and formula counts. The counts do not grade meaning. */
export function turnText(turnDir) {
  const description = readJson(join(turnDir, 'present-result.json'))?.aiMetadata?.description;
  const reportPath = join(turnDir, 'report.md');
  const preview = typeof description === 'string' ? description : existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  const answerPath = ['answer.md', 'answer.txt'].map(name => join(turnDir, name)).find(path => existsSync(path));
  const chat = answerPath ? readFileSync(answerPath, 'utf8') : null;
  const markup = preview === null ? null : measureMarkup(preview);
  const formula = markup === null ? null : markup.formulaMarkup.dollarDisplay + markup.formulaMarkup.bracketDisplay
    + markup.formulaMarkup.parenthesisInline + markup.formulaMarkup.dollarInline;
  return { previewChars: preview?.length ?? null, chatChars: chat?.length ?? null, sqlFences: markup?.fences.sql ?? null, formula };
}

function missingBand(baseline, candidate) {
  return { baseline, candidate, diff: null, rag: 'UNKNOWN',
    status: baseline === null && candidate === null ? 'absent' : baseline === null ? 'missing_baseline' : 'missing_candidate',
    differs: (baseline === null) !== (candidate === null) };
}

/** Preview-size band. Within 15 percent is green. Under half the baseline is red. Other shrinkage or growth is amber. */
export function sizeRag(baseline, candidate) {
  if (baseline === null || candidate === null) return { ...missingBand(baseline, candidate), diffPct: null };
  const diffPct = baseline === 0 ? (candidate === 0 ? 0 : 100) : Number((((candidate - baseline) / baseline) * 100).toFixed(1));
  const rag = Math.abs(diffPct) <= 15 ? 'GREEN' : candidate < baseline * 0.5 ? 'RED' : 'AMBER';
  const differs = rag !== 'GREEN';
  return { rag, differs, diffPct, baseline, candidate };
}

/** Token total band. Within 15 percent above the baseline is green. A larger total is amber. */
export function tokenBand(baseline, candidate) {
  if (baseline === null || candidate === null) return { ...missingBand(baseline, candidate), diffPct: null };
  const diff = candidate - baseline;
  const diffPct = baseline === 0 ? (candidate === 0 ? 0 : 100) : Number(((diff / baseline) * 100).toFixed(1));
  const rag = diffPct <= 15 ? 'GREEN' : 'AMBER';
  const differs = rag !== 'GREEN';
  return { baseline, candidate, diff, diffPct, rag, differs };
}

/** Duration band. Within 20 percent is green. Within triple is amber. Beyond that is red. */
export function durationBand(baseline, candidate) {
  if (baseline === null || candidate === null) return missingBand(baseline, candidate);
  const rag = candidate <= baseline * 1.2 ? 'GREEN' : candidate <= baseline * 3 ? 'AMBER' : 'RED';
  const differs = rag !== 'GREEN';
  return { baseline, candidate, diff: candidate - baseline, rag, differs };
}

/** An increase requires review. A decrease stays green. */
export function worseCount(baseline, candidate) {
  const differs = candidate > baseline;
  return { baseline, candidate, diff: candidate - baseline, rag: differs ? 'RED' : 'GREEN', differs };
}

const HOP_PHASE = 'active';
const SYNTHESIS_PHASE = 'synthesis';

function emptySection() {
  return { generations: 0, input: 0, output: 0, total: 0, latencyMs: 0 };
}

/** Provider tokens and latency by phase. Missing metrics stay unknown; sections with no generations are zero. */
export function sectionUsage(records) {
  if (!records.some(record => record.type === 'generation' && typeof record.phase === 'string')) return null;
  const sections = { hop: emptySection(), synthesis: emptySection(), other: emptySection() };
  for (const record of records) {
    if (record.type !== 'generation') continue;
    const section = record.phase === HOP_PHASE ? sections.hop : record.phase === SYNTHESIS_PHASE ? sections.synthesis : sections.other;
    section.generations += 1;
    const values = { input: record.usage?.inputTokens, output: record.usage?.outputTokens,
      total: record.usage?.totalTokens, latencyMs: record.latencyMs };
    for (const [key, value] of Object.entries(values)) {
      section[key] = section[key] !== null && Number.isFinite(value) ? section[key] + value : null;
    }
  }
  return sections;
}

/** Rejected events by tool, code, ordinal, and code × ordinal. Ordinals count the repair episode. */
export function rejectionBreakdown(metrics) {
  const ordinal = { '1': 0, '2': 0, '3': 0, '4+': 0, unnumbered: 0 };
  const codes = Object.create(null), tools = Object.create(null), codeOrdinals = Object.create(null);
  for (const event of metrics.detailed?.events ?? []) {
    if (event.status !== 'rejected') continue;
    const slot = event.rejectionOrdinal >= 4 ? '4+' : String(event.rejectionOrdinal ?? '');
    if (Object.hasOwn(ordinal, slot)) ordinal[slot] += 1;
    else ordinal.unnumbered += 1;
    const code = typeof event.code === 'string' && event.code ? event.code : 'unknown';
    codes[code] = (codes[code] ?? 0) + 1;
    const tool = event.tool ?? 'unknown';
    tools[tool] = (tools[tool] ?? 0) + 1;
    const codeSlot = Object.hasOwn(ordinal, slot) ? slot : 'unnumbered';
    const counts = codeOrdinals[code] ??= Object.create(null);
    counts[codeSlot] = (counts[codeSlot] ?? 0) + 1;
  }
  return { ordinal, codes, tools, codeOrdinals };
}

/** Records that follow each `turn-start`, so a catalog trace can be scored one question at a time. */
export function splitByTurn(records) {
  const slices = [];
  let current = null;
  for (const record of records) {
    if (record.type === 'turn-start') {
      current = [];
      slices.push(current);
    }
    if (current) current.push(record);
  }
  return slices;
}

/** Any change is a stored difference. */
export function changedCount(baseline, candidate) {
  if (baseline === null || candidate === null) return missingBand(baseline, candidate);
  const diff = candidate - baseline;
  const differs = diff !== 0;
  return { baseline, candidate, diff, rag: diff === 0 ? 'GREEN' : 'AMBER', differs };
}

/** Authored prune calls, and start-exploration calls that carry a supplement. */
export function commandCounts(records) {
  let prune = 0;
  let add = 0;
  for (const record of records) {
    if (record.type !== 'wire-response') continue;
    for (const call of record.toolCalls ?? []) {
      if (call.name === PRUNE_TOOL) prune += 1;
      else if (call.name === START_TOOL && call.input && typeof call.input === 'object' && 'supplement' in call.input) add += 1;
    }
  }
  return { prune, add };
}

/** Episodes that stayed unresolved or needed a second or later retry. */
export function escalationCount(chains) {
  return (chains ?? []).filter(chain => !chain.resolved || chain.rejections >= 2).length;
}

/** Recorded usage, duration, rejections, escalation, and command counts. */
export function traceFacts(records) {
  const metrics = runMetrics(records);
  const usage = metrics.detailed.usage;
  const rejected = rejectionBreakdown(metrics);
  return {
    metrics,
    tokens: { input: usage.input.total, output: usage.output.total, total: usage.total.total },
    durationMs: metrics.detailed.turnTiming.recordedDurationMs,
    rejections: metrics.repair.rejectedCalls,
    escalation: escalationCount(metrics.repair.chains),
    commands: commandCounts(records),
    sections: sectionUsage(records),
    rejectionOrdinals: rejected.ordinal,
    rejectionCodes: rejected.codes,
    rejectionTools: rejected.tools,
    rejectionCodeOrdinals: rejected.codeOrdinals,
    hopAverage: logicalHopAverage(metrics.detailed.generations),
    exchangeCounts: metrics.detailed.summary.exchangeCounts,
  };
}

/** Mean total provider tokens per distinct active request/focus, including repair generations. Unknown without complete attribution. */
function logicalHopAverage(generations) {
  const active = generations.filter(row => row.phase === HOP_PHASE);
  if (!active.length || active.some(row => row.requestId == null || row.focus == null || !Number.isFinite(row.totalTokens))) {
    return { hops: null, totalTokens: null, tokensPerHop: null };
  }
  const hops = new Set(active.map(row => JSON.stringify([row.requestId, row.focus]))).size;
  const totalTokens = active.reduce((sum, row) => sum + row.totalTokens, 0);
  return { hops, totalTokens, tokensPerHop: totalTokens / hops };
}

function communicationFacts(metrics) {
  const events = metrics.detailed.events.filter(event => event.status === 'rejected');
  const feedback = events.map(event => event.nextServedFeedback);
  const replies = [...new Map(feedback.filter(row => row?.reply).map(row => [
    JSON.stringify([row.reply.providerUsage.requestId, row.reply.providerUsage.generation]), row.reply,
  ])).values()];
  const samples = values => {
    const known = values.filter(Number.isFinite);
    const observed = known.reduce((sum, value) => sum + value, 0);
    return { total: known.length === values.length ? observed : null, observedTotal: observed, missing: values.length - known.length };
  };
  const exchanges = events.flatMap(event => event.repair ? [event.repair.exchange] : []);
  return { backendRequestChars: samples(feedback.map(row => row?.size?.utf16CodeUnits)),
    backendRequestBytes: samples(feedback.map(row => row?.size?.utf8Bytes)),
    generationReplyTextChars: samples(replies.map(reply => reply.textSize?.utf16CodeUnits)),
    generationReplyTextBytes: samples(replies.map(reply => reply.textSize?.utf8Bytes)),
    generationReplyToolInputChars: samples(replies.map(reply => reply.toolInputsSize?.utf16CodeUnits)),
    generationReplyToolInputBytes: samples(replies.map(reply => reply.toolInputsSize?.utf8Bytes)),
    backendToolProcessingMs: samples(events.map(event => event.validationMs)),
    replyBackendToolProcessingMs: samples(exchanges.map(exchange => exchange.durations.replyBackendToolProcessingMs)),
    modelResponseMs: samples(replies.map(reply => reply.modelResponseMs)),
    ownerFeedbackRoundTripMs: samples(exchanges.map(exchange => exchange.durations.ownerFeedbackToValidatedReplyMs)),
    servedFeedbackRoundTripMs: samples(exchanges.map(exchange => exchange.durations.servedFeedbackToValidatedReplyMs)),
    dispatchRejectionRoundTripMs: samples(exchanges.map(exchange => exchange.durations.dispatchRejectionToValidatedReplyMs)),
    feedbackGenerationUsage: metrics.detailed.feedbackUsage, exchangeGenerationUsage: metrics.detailed.exchangeUsage };
}

/** Compare aggregate measurements without pairing unrelated cross-run model calls. */
function compareCommunication(baseline, candidate) {
  const changedPaths = [];
  const compare = (before, after, path = '') => {
    if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
      return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].map(key =>
        [key, compare(before[key] ?? null, after[key] ?? null, path ? `${path}.${key}` : key)]));
    }
    if ((typeof before === 'number' || before == null) && (typeof after === 'number' || after == null)) {
      const known = Number.isFinite(before) && Number.isFinite(after);
      const differs = known ? before !== after : (before == null) !== (after == null);
      if (differs) changedPaths.push(path);
      return { baseline: before ?? null, candidate: after ?? null, diff: known ? after - before : null,
        status: known ? differs ? 'differs' : 'equal' : before == null && after == null ? 'absent' : before == null ? 'missing_baseline' : 'missing_candidate', differs };
    }
    return { baseline: before, candidate: after };
  };
  const deltas = compare(baseline, candidate);
  return { baseline, candidate, deltas, changedPaths, differs: changedPaths.length > 0,
    exchangePartsComparison: 'unpaired: cross-run call identity is not established' };
}

function numberDelta(baseline, candidate) {
  if (baseline === null || candidate === null) return { baseline, candidate, diff: null };
  return { baseline, candidate, diff: candidate - baseline };
}

function defectNames(metrics) {
  return [...new Set(findings(metrics).filter(item => item.kind === 'defect').map(item => item.rule))];
}

/** Hard-fact delta of two parsed traces. `defects` names only the candidate's operational faults. Baseline faults stay on `baselineDefects` and do not fail the candidate. */
export function compareTraceFacts(baselineRecords, candidateRecords) {
  const baseline = traceFacts(baselineRecords);
  const candidate = traceFacts(candidateRecords);
  const baselineDefects = defectNames(baseline.metrics);
  const candidateDefects = defectNames(candidate.metrics);
  const defects = candidateDefects;
  const facts = {
    communication: compareCommunication(communicationFacts(baseline.metrics), communicationFacts(candidate.metrics)),
    tokens: {
      input: numberDelta(baseline.tokens.input, candidate.tokens.input),
      output: numberDelta(baseline.tokens.output, candidate.tokens.output),
      total: tokenBand(baseline.tokens.total, candidate.tokens.total),
    },
    durationMs: durationBand(baseline.durationMs, candidate.durationMs),
    rejections: worseCount(baseline.rejections, candidate.rejections),
    escalation: worseCount(baseline.escalation, candidate.escalation),
    commands: { prune: changedCount(baseline.commands.prune, candidate.commands.prune), add: changedCount(baseline.commands.add, candidate.commands.add) },
  };
  const differs = [];
  if (facts.communication.differs) differs.push({ label: 'communication', changedPaths: facts.communication.changedPaths });
  if (facts.tokens.total.differs) differs.push({ label: 'tokens', status: facts.tokens.total.status, rag: facts.tokens.total.rag, diffPct: facts.tokens.total.diffPct });
  if (facts.durationMs.differs) differs.push({ label: 'duration', status: facts.durationMs.status, rag: facts.durationMs.rag, diff: facts.durationMs.diff });
  if (facts.rejections.differs) differs.push({ label: 'rejections', diff: facts.rejections.diff });
  if (facts.escalation.differs) differs.push({ label: 'escalation', diff: facts.escalation.diff });
  if (facts.commands.prune.differs) differs.push({ label: 'prune', diff: facts.commands.prune.diff });
  if (facts.commands.add.differs) differs.push({ label: 'add', diff: facts.commands.add.diff });
  const sections = bandSections(baseline.sections, candidate.sections);
  facts.sections = sections;
  if (sections.compared) {
    for (const name of ['hop', 'synthesis', 'other']) {
      if (sections[name].tokens.differs) differs.push({ label: `tokens.${name}`, rag: sections[name].tokens.rag, diffPct: sections[name].tokens.diffPct });
      if (sections[name].latencyMs.differs) differs.push({ label: `latency.${name}`, rag: sections[name].latencyMs.rag, diff: sections[name].latencyMs.diff });
    }
  }
  facts.rejectionOrdinals = bandCounts(baseline.rejectionOrdinals, candidate.rejectionOrdinals);
  facts.rejectionCodes = bandCounts(baseline.rejectionCodes, candidate.rejectionCodes);
  facts.rejectionTools = bandCounts(baseline.rejectionTools, candidate.rejectionTools);
  facts.exchangeCounts = Object.fromEntries(Object.keys(candidate.exchangeCounts).map(key => [key,
    changedCount(baseline.exchangeCounts[key], candidate.exchangeCounts[key])]));
  for (const [kind, band] of Object.entries(facts.exchangeCounts)) {
    if (band.differs) differs.push({ label: `exchanges.${kind}`, diff: band.diff });
  }
  facts.rejectionCodeOrdinals = Object.fromEntries([...new Set([
    ...Object.keys(baseline.rejectionCodeOrdinals), ...Object.keys(candidate.rejectionCodeOrdinals),
  ])].sort().map(code => [code, bandCounts(baseline.rejectionCodeOrdinals[code], candidate.rejectionCodeOrdinals[code])]));
  facts.hopAverage = { baseline: baseline.hopAverage, candidate: candidate.hopAverage,
    tokens: tokenBand(baseline.hopAverage.tokensPerHop, candidate.hopAverage.tokensPerHop) };
  if (facts.hopAverage.tokens.differs) differs.push({ label: 'tokens.averagePerHop', ...facts.hopAverage.tokens });
  for (const [tool, band] of Object.entries(facts.rejectionTools)) {
    if (band.differs) differs.push({ label: `rejections.tool.${tool}`, diff: band.diff });
  }
  for (const [code, ordinals] of Object.entries(facts.rejectionCodeOrdinals)) {
    for (const [ordinal, band] of Object.entries(ordinals)) {
      if (band.differs) differs.push({ label: `rejection.${code}.ordinal.${ordinal}`, diff: band.diff });
    }
  }
  for (const [ordinal, band] of Object.entries(facts.rejectionOrdinals)) {
    if (band.differs) differs.push({ label: `rejections.${ordinal}`, diff: band.diff });
  }
  for (const [code, band] of Object.entries(facts.rejectionCodes)) {
    if (band.differs) differs.push({ label: `rejection.${code}`, diff: band.diff });
  }
  return { facts, differs, defects, baselineDefects, candidateDefects };
}

function bandSections(baseline, candidate) {
  if (!baseline || !candidate) return { compared: false };
  const band = section => ({ tokens: tokenBand(sectionBaseline(baseline, section), sectionBaseline(candidate, section)), latencyMs: durationBand(baseline[section].latencyMs, candidate[section].latencyMs) });
  return { compared: true, hop: band('hop'), synthesis: band('synthesis'), other: band('other') };
}

function sectionBaseline(sections, name) {
  return sections[name].total;
}

function bandCounts(baseline, candidate) {
  const keys = [...new Set([...Object.keys(baseline ?? {}), ...Object.keys(candidate ?? {})])].sort();
  return Object.fromEntries(keys.map(key => [key, worseCount(baseline?.[key] ?? 0, candidate?.[key] ?? 0)]));
}

/** Per-turn hard facts when both traces opened the same number of turns. */
export function compareTurnSections(baselineRecords, candidateRecords) {
  const baseline = splitByTurn(baselineRecords);
  const candidate = splitByTurn(candidateRecords);
  if (!baseline.length || baseline.length !== candidate.length) return { compared: false, turns: [], differs: [] };
  const turns = [];
  const differs = [];
  for (let index = 0; index < candidate.length; index += 1) {
    const compared = compareTraceFacts(baseline[index], candidate[index]);
    turns.push({ turn: index + 1, facts: compared.facts });
    for (const item of compared.differs) differs.push({ turn: index + 1, ...item });
  }
  return { compared: true, turns, differs };
}

/** `matched` when question and fixture hashes agree, `different` when both sides named them and they disagree, otherwise `unknown`. */
export function identitiesMatch(baseline, candidate) {
  if (!baseline?.questionHash || !baseline?.fixtureHash || !candidate?.questionHash || !candidate?.fixtureHash) return 'unknown';
  return baseline.questionHash === candidate.questionHash && baseline.fixtureHash === candidate.fixtureHash ? 'matched' : 'different';
}

/** Turn directory names in index order. A native chat capture stores its one turn at `case-1`. */
export function turnNames(runDir) {
  if (!existsSync(runDir)) return [];
  if (existsSync(join(runDir, 'trace.ndjson')) && existsSync(join(runDir, 'metrics-manifest.json'))) return ['.'];
  const turns = readdirSync(runDir).filter(name => /^turn-\d+$/.test(name)).sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)));
  if (turns.length) return turns;
  return existsSync(join(runDir, 'case-1')) ? ['case-1'] : [];
}

/** Question and fixture hashes from `run.json`, or from that turn's metrics manifest when the run file has none. */
function turnIdentity(runDir, slot, index) {
  const fromRun = readJson(join(runDir, 'run.json'))?.turns?.[index] ?? {};
  if (fromRun.questionHash && fromRun.fixtureHash) return fromRun;
  if (!slot) return fromRun;
  const manifest = readJson(join(runDir, slot, 'metrics-manifest.json'));
  if (manifest?.questionHash && manifest?.fixtureHash) return { questionHash: manifest.questionHash, fixtureHash: manifest.fixtureHash };
  return fromRun;
}

/** Always reports recorded graph/text measurements; only matched identities contribute paired differences. */
export function compareRunPair(candidateDir, baselineDir, baselineTurns) {
  const candidateTraceTurns = splitByTurn(readTrace(candidateDir) ?? []);
  const baselineTraceTurns = splitByTurn(readTrace(baselineDir) ?? []);
  const candidateRun = readJson(join(candidateDir, 'run.json')) ?? { turns: [] };
  const baselineRun = readJson(join(baselineDir, 'run.json')) ?? { turns: [] };
  const candidateSlots = turnNames(candidateDir);
  const baselineSlots = turnNames(baselineDir);
  const candidateCount = Math.max(candidateSlots.length, candidateRun.turns?.length ?? 0);
  const count = baselineTurns ? candidateCount : Math.max(candidateCount, baselineSlots.length, baselineRun.turns?.length ?? 0);
  const turns = [];
  const differs = [];
  for (let index = 0; index < count; index++) {
    const baselineIndex = baselineTurns ? baselineTurns[index] - 1 : index;
    const baselineIdentity = turnIdentity(baselineDir, baselineSlots[baselineIndex], baselineIndex);
    const candidateIdentity = turnIdentity(candidateDir, candidateSlots[index], index);
    const identity = identitiesMatch(baselineIdentity, candidateIdentity);
    const turn = index + 1;
    const baselineTurn = join(baselineDir, baselineSlots[baselineIndex] ?? `turn-${baselineIndex + 1}`);
    const candidateTurn = join(candidateDir, candidateSlots[index] ?? `turn-${turn}`);
    const graph = compareGraphs(graphOfTurn(baselineTurn, baselineTraceTurns[baselineIndex]), graphOfTurn(candidateTurn, candidateTraceTurns[index]));
    const baselineText = turnText(baselineTurn);
    const candidateText = turnText(candidateTurn);
    const text = {
      preview: sizeRag(baselineText.previewChars, candidateText.previewChars),
      chat: sizeRag(baselineText.chatChars, candidateText.chatChars),
      sqlFences: changedCount(baselineText.sqlFences, candidateText.sqlFences),
      formula: changedCount(baselineText.formula, candidateText.formula),
    };
    if (identity === 'matched' && graph.differs) {
      for (const field of ['visited', 'agenda', 'finalNodes', 'columnAspect', 'snapshotEdges']) {
        if (graph[field]?.differs) differs.push({ turn, label: field, status: graph[field].status, lost: graph[field].lost, added: graph[field].added });
      }
      if (!graph.visited && (graph.status === 'missing_baseline' || graph.status === 'missing_candidate' || graph.status === 'missing_side')) {
        differs.push({ turn, label: 'exploration', status: graph.status });
      }
    }
    for (const label of ['preview', 'chat', 'sqlFences', 'formula']) {
      if (identity === 'matched' && text[label].differs) differs.push({ turn, label, status: text[label].status, rag: text[label].rag, diff: text[label].diff, diffPct: text[label].diffPct });
    }
    turns.push({ turn, identity, graph, text });
  }
  return { turns, differs };
}

/** Newest trace in a run directory. A native chat capture stores one trace at `case-1/trace.ndjson`. */
export function newestNdjson(runDir) {
  const dir = join(runDir, 'lm-trace');
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter(name => name.endsWith('.ndjson')).map(name => join(dir, name));
    files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    if (files[0]) return files[0];
  }
  const direct = join(runDir, 'trace.ndjson');
  if (existsSync(direct)) return direct;
  const native = join(runDir, 'case-1', 'trace.ndjson');
  return existsSync(native) ? native : null;
}

/** Parses `CANDIDATE --out DIR [--previous DIR] [--main DIR]`. */
export function parseScoreArgs(args) {
  const valueAfter = flag => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const flags = new Set(['--out', '--previous', '--main', '--previous-turns', '--main-turns']);
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && flags.has(args[index - 1])));
  const out = valueAfter('--out');
  const previous = valueAfter('--previous');
  const main = valueAfter('--main');
  if (args.includes('--help') || positional.length !== 1 || !out || out.startsWith('--')) return null;
  if (args.includes('--previous') && !previous) return null;
  if (args.includes('--main') && !main) return null;
  if (!previous && !main) return null;
  const turns = flag => {
    const value = valueAfter(flag);
    if (value === undefined) return undefined;
    if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(value)) throw new Error(`${flag} requires comma-separated 1-based turn numbers.`);
    return value.split(',').map(Number);
  };
  return { candidate: positional[0], out, previous, main, previousTurns: turns('--previous-turns'), mainTurns: turns('--main-turns') };
}

function readTrace(runDir) {
  const tracePath = newestNdjson(runDir);
  if (!tracePath) return null;
  return parseTrace(readFileSync(tracePath, 'utf8'));
}

/** Deduplicate only equal immutable records; a conflicting identity supplies no derived observation. */
function immutableObservations(rows) {
  const byId = new Map();
  const conflicts = new Set();
  for (const row of rows) {
    const key = JSON.stringify([row.traceId, row.id]);
    if (!byId.has(key)) byId.set(key, row);
    else if (!isDeepStrictEqual(byId.get(key), row)) conflicts.add(key);
  }
  return { unique: [...byId].filter(([key]) => !conflicts.has(key)).map(([, row]) => row),
    conflicts: [...conflicts].map(key => JSON.parse(key)) };
}

// The general API budget is shared across baseline sources in this process.
let nextLangfuseReadAt = 0;

/** Read-only hydration of a stored baseline into a disposable standard capture directory. */
export async function hydrateLangfuseRun(runDir, config, { fetchImpl = fetch, intervalMs = 2100, cacheDir } = {}) {
  const remoteReference = typeof runDir === 'string' && runDir.startsWith('langfuse:');
  const referenceIds = remoteReference ? runDir.slice('langfuse:'.length).split(',') : null;
  if (referenceIds?.some(id => !/^[A-Za-z0-9_-]+$/.test(id))) throw new Error('Invalid Langfuse trace reference.');
  const receipt = remoteReference ? { source: 'server_read', traceIds: referenceIds } : readJson(join(runDir, 'langfuse.json'));
  if (!Array.isArray(receipt?.traceIds) || !receipt.traceIds.length) throw new Error('Stored trace references are unavailable.');
  const base = new URL(config.baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || !config.publicKey || !config.secretKey) throw new Error('Invalid Langfuse read configuration.');
  const directory = cacheDir ?? mkdtempSync(join(tmpdir(), 'lineage-stored-baseline-'));
  mkdirSync(directory, { recursive: true });
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}`;
  const get = async path => {
    let delay;
    while ((delay = nextLangfuseReadAt - Date.now()) > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    nextLangfuseReadAt = Date.now() + intervalMs;
    let response;
    try { response = await fetchImpl(new URL(path, base), { headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error('Langfuse stored evidence read failed.'); }
    if (!response.ok) throw new Error(`Langfuse stored evidence read HTTP ${response.status}.`);
    return response.json();
  };
  const originalTrace = remoteReference ? [] : readTrace(runDir) ?? [];
  const times = originalTrace.map(record => Date.parse(record.at)).filter(Number.isFinite);
  const from = times.length ? new Date(Math.min(...times) - 60000) : new Date(Date.now() - 29 * 86400000);
  const to = times.length ? new Date(Math.max(...times) + 60000) : new Date();
  const observations = [];
  for (const traceId of [...new Set(receipt.traceIds)]) {
    let cursor;
    const seenCursors = new Set();
    do {
      const query = new URLSearchParams({ traceId, fromStartTime: from.toISOString(), toStartTime: to.toISOString(), fields: 'core,basic,usage,metadata,io,metrics', expandMetadata: 'attachments', limit: '1000', ...(cursor ? { cursor } : {}) });
      const page = await get(`/api/public/v2/observations?${query}`);
      if (!Array.isArray(page?.data) || page.data.some(row => row.traceId !== traceId)) throw new Error('Invalid stored observation identity.');
      observations.push(...page.data);
      cursor = page.meta?.cursor;
      if (cursor && (typeof cursor !== 'string' || seenCursors.has(cursor))) throw new Error('Invalid stored observation pagination.');
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
  }
  if (receipt.traceIds.some(id => !observations.some(row => row.traceId === id))) throw new Error('Stored observations do not cover every referenced trace.');
  writeFileSync(join(directory, 'langfuse-observations.json'), JSON.stringify({ data: observations, meta: { cursor: null } }, null, 2) + '\n');
  const { unique, conflicts } = immutableObservations(observations);
  if (conflicts.length) throw new Error(`Conflicting immutable Langfuse observation identities: ${JSON.stringify(conflicts)}.`);
  const native = unique.some(row => row.metadata?.lane === 'native');
  const recovered = [];
  const media = new Map();
  for (const observation of unique) {
    let metadata = observation.metadata;
    if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = null; } }
    let attachments = metadata?.attachments;
    if (typeof attachments === 'string') { try { attachments = JSON.parse(attachments); } catch { attachments = null; } }
    for (const [name, token] of Object.entries(attachments ?? {})) {
      if (token && typeof token === 'object' && token.empty === true) {
        const bytes = Buffer.alloc(0);
        if (token.contentLength !== 0 || token.sha256Hash !== createHash('sha256').update(bytes).digest('base64')
          || !['text/plain', 'text/markdown', 'application/json'].includes(token.contentType)) throw new Error('Invalid stored empty attachment descriptor.');
        recovered.push({ name, contentType: token.contentType, mediaId: null, requestId: metadata?.requestId ?? null, traceId: observation.traceId, bytes });
        continue;
      }
      const match = typeof token === 'string' && token.match(/^@@@langfuseMedia:type=([^|]+)\|id=([A-Za-z0-9_-]+)\|source=bytes@@@$/);
      if (!match) continue;
      let bytes = media.get(match[2]);
      if (!bytes) {
        const info = await get(`/api/public/media/${encodeURIComponent(match[2])}`);
        if (!info?.uploadedAt || typeof info.url !== 'string') throw new Error('Stored attachment upload was not confirmed.');
        const url = new URL(info.url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid stored media URL.');
        let downloaded;
        try { downloaded = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000) }); }
        catch { throw new Error('Stored attachment download failed.'); }
        if (!downloaded.ok) throw new Error(`Stored attachment download HTTP ${downloaded.status}.`);
        bytes = Buffer.from(await downloaded.arrayBuffer());
        if (!Number.isFinite(info.contentLength) || bytes.length !== info.contentLength) throw new Error('Stored attachment length mismatch.');
        media.set(match[2], bytes);
      }
      recovered.push({ name, contentType: match[1], mediaId: match[2], requestId: metadata?.requestId ?? null, traceId: observation.traceId, bytes });
    }
  }
  const eventTraces = recovered.filter(row => row.name === 'event-trace');
  if (!eventTraces.length || eventTraces.some(row => !row.bytes.equals(eventTraces[0].bytes))) throw new Error('Stored NDJSON attachment missing or inconsistent.');
  const sourceRecords = parseTrace(eventTraces[0].bytes.toString('utf8'));
  const selectedRequests = new Set(unique.flatMap(row => row.metadata?.requestId ? [row.metadata.requestId] : []));
  const records = remoteReference ? sourceRecords.filter(row => row.type === 'trace-open' || selectedRequests.has(row.requestId)) : sourceRecords;
  if (!records.some(row => row.type === 'turn-start')) throw new Error('Stored NDJSON does not cover requested traces.');
  const starts = records.filter(row => row.type === 'turn-start');
  const captureRoot = native ? join(directory, 'case-1') : directory;
  const destinations = { answer: 'answer.md', 'hop-log': 'hop-log.json', 'state-dump': 'sm-state.json', result: 'present-result.json', identity: 'metrics-manifest.json', 'final-snapshot': 'final-snapshot.json', report: 'report.md' };
  mkdirSync(captureRoot, { recursive: true });
  mkdirSync(join(directory, 'lm-trace'), { recursive: true });
  const traceBytes = remoteReference ? Buffer.from(eventTraces[0].bytes.toString('utf8').split('\n').filter(line => {
    if (!line.trim()) return false;
    const row = JSON.parse(line);
    return row.type === 'trace-open' || selectedRequests.has(row.requestId);
  }).join('\n') + '\n') : eventTraces[0].bytes;
  writeFileSync(join(directory, 'lm-trace', 'trace.ndjson'), traceBytes);
  if (native) writeFileSync(join(captureRoot, 'trace.ndjson'), traceBytes);
  if (remoteReference) writeFileSync(join(directory, 'source-event-trace.ndjson'), eventTraces[0].bytes);
  const saved = [];
  for (const file of recovered) {
    let path;
    if (file.name === 'event-trace') path = remoteReference ? join(directory, 'source-event-trace.ndjson') : join(directory, 'lm-trace', 'trace.ndjson');
    else if (file.name === 'debug-log') path = join(directory, 'host.log');
    else if (destinations[file.name]) {
      const index = starts.findIndex(start => start.requestId === file.requestId);
      if (index < 0) throw new Error('Stored attachment request identity is absent from NDJSON.');
      // Native answer/report/identity/projection are case summaries; only state is per request.
      const turn = native && file.name !== 'state-dump' ? captureRoot : join(captureRoot, `turn-${index + 1}`);
      mkdirSync(turn, { recursive: true });
      const filename = file.name === 'result' && file.contentType !== 'application/json' ? 'report.md'
        : file.name === 'answer' && file.contentType === 'text/plain' ? 'answer.txt' : destinations[file.name];
      path = join(turn, filename);
    } else continue;
    if (existsSync(path) && !readFileSync(path).equals(file.bytes)) throw new Error('Stored attachment content conflicts.');
    writeFileSync(path, file.bytes);
    saved.push({ path, mediaId: file.mediaId, requestId: file.requestId, traceId: file.traceId, sha256: createHash('sha256').update(file.bytes).digest('hex') });
  }
  // A no-hop trace still needs an addressable turn slot, without inventing a state dump.
  starts.forEach((_, index) => mkdirSync(join(captureRoot, `turn-${index + 1}`), { recursive: true }));
  if (native) {
    const actualLastState = join(captureRoot, `turn-${starts.length}`, 'sm-state.json');
    if (existsSync(actualLastState)) writeFileSync(join(captureRoot, 'sm-state.json'), readFileSync(actualLastState));
    const summary = readJson(join(captureRoot, 'metrics-manifest.json'));
    if (Array.isArray(summary?.requestIds) && summary.requestIds.some(id => !starts.some(start => start.requestId === id))) {
      throw new Error('Native case references do not cover the captured case summary.');
    }
  }
  writeFileSync(join(directory, 'langfuse.json'), JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(join(directory, 'stored-evidence.json'), JSON.stringify({ source: 'Langfuse observations v2 and confirmed media', originalRunDir: runDir, traceIds: receipt.traceIds, files: saved }, null, 2) + '\n');
  return { directory, evidence: auditRunEvidence(directory), observations: observations.length, uniqueObservations: unique.length };
}

/** Resolves either a local capture or explicit `langfuse:traceId[,traceId]` references. */
export async function resolveRunSource(source, { config, ...options } = {}) {
  if (!source.startsWith('langfuse:') && existsSync(source) && auditRunEvidence(source).comparable) {
    return { source, directory: source, hydrated: false };
  }
  if (!source.startsWith('langfuse:') && !existsSync(join(source, 'langfuse.json'))) return { source, directory: source, hydrated: false };
  const resolvedConfig = config ?? { baseUrl: process.env.LANGFUSE_BASE_URL, publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY };
  const hydrated = await hydrateLangfuseRun(source, resolvedConfig, options);
  return { source, ...hydrated, hydrated: true };
}

/** Correlates locally captured evidence only. An export receipt does not contain Langfuse spans. */
export function auditRunEvidence(runDir, selectedTurns) {
  const source = path => ({ path, sha256: path && existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null });
  const tracePath = newestNdjson(runDir);
  let records = tracePath ? parseTrace(readFileSync(tracePath, 'utf8')) : [];
  if (selectedTurns) {
    const slices = splitByTurn(records);
    records = selectedTurns.flatMap(turn => slices[turn - 1] ?? []);
  }
  const ids = field => [...new Set(records.map(record => record[field]).filter(value => typeof value === 'string' && value.length))];
  const requestIds = ids('requestId');
  const hostPath = join(runDir, 'host.log');
  const host = existsSync(hostPath) ? readFileSync(hostPath, 'utf8') : null;
  let receiptPath = join(runDir, 'langfuse.json');
  let receipt;
  try { receipt = readJson(receiptPath); } catch { receipt = null; }
  let payloadPath = join(runDir, 'langfuse-otlp.json');
  let payload;
  try { payload = readJson(payloadPath); } catch { payload = null; }
  const observationsPath = join(runDir, 'langfuse-observations.json');
  let remote;
  try { remote = readJson(observationsPath); } catch { remote = null; }
  const remoteRows = Array.isArray(remote?.data) && !remote.meta?.cursor ? remote.data : [];
  const { unique: uniqueRemoteRows, conflicts: remoteConflicts } = immutableObservations(remoteRows);
  const remoteSpans = uniqueRemoteRows.map(row => {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const usage = row.usageDetails ?? (Number.isFinite(row.totalUsage) ? { input: row.inputUsage, output: row.outputUsage, total: row.totalUsage } : null);
    return { traceId: row.traceId, spanId: row.id, startTimeUnixNano: Number.isFinite(Date.parse(row.startTime)) ? String(BigInt(Date.parse(row.startTime)) * 1000000n) : null,
      endTimeUnixNano: Number.isFinite(Date.parse(row.endTime)) ? String(BigInt(Date.parse(row.endTime)) * 1000000n) : null,
      attributes: [
        { key: 'langfuse.trace.metadata.requestId', value: { stringValue: metadata.requestId } },
        { key: 'langfuse.observation.type', value: { stringValue: row.type === 'GENERATION' ? 'generation' : row.type === 'TOOL' ? 'tool' : 'span' } },
        { key: 'langfuse.observation.usage_details', value: { stringValue: JSON.stringify(usage) } },
      ] };
  });
  const payloadSpans = Array.isArray(payload?.resourceSpans) ? payload.resourceSpans.flatMap(resource => Array.isArray(resource?.scopeSpans)
    ? resource.scopeSpans.flatMap(scope => Array.isArray(scope?.spans) ? scope.spans : []) : []) : [];
  const spans = remoteConflicts.length ? [] : remoteSpans.length ? remoteSpans : payloadSpans;
  const spanTraceIds = [...new Set(spans.map(span => span.traceId).filter(id => typeof id === 'string'))];
  const requestTracePairs = spans.flatMap(span => {
    const requestId = Array.isArray(span.attributes) ? span.attributes.find(attribute => attribute.key === 'langfuse.trace.metadata.requestId')?.value?.stringValue : null;
    return typeof requestId === 'string' ? [{ requestId, traceId: span.traceId, spanId: span.spanId }] : [];
  });
  const exportOk = remoteConflicts.length ? false : receipt?.source === 'server_read' ? remoteSpans.length > 0
    && receipt.traceIds.every(id => spanTraceIds.includes(id))
    && requestIds.length > 0 && requestIds.every(id => requestTracePairs.some(pair => pair.requestId === id))
    : Number.isFinite(receipt?.exported) && receipt.exported > 0
    && Array.isArray(receipt?.errors) && receipt.errors.length === 0
    && Array.isArray(receipt?.traceIds) && receipt.traceIds.length >= requestIds.length && requestIds.length > 0;
  const names = turnNames(runDir);
  const selectedNames = selectedTurns ? selectedTurns.map(turn => names[turn - 1]).filter(Boolean) : names;
  const selected = selectedNames.flatMap(name => {
    const nested = readdirSync(join(runDir, name)).filter(child => /^turn-\d+$/.test(child)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    return nested.length ? nested.map(child => join(name, child)) : [name];
  });
  const traceTurns = splitByTurn(records);
  const states = selected.map((turn, index) => {
    const path = join(runDir, turn, 'sm-state.json');
    let state;
    try { state = readJson(path); } catch { state = null; }
    const valid = state && typeof state === 'object' && (state.explorationOpened === false || Array.isArray(state.visited));
    const notApplicable = state === undefined && provesNoExploration(traceTurns[index]);
    const manifest = readJson(join(runDir, turn, 'metrics-manifest.json'));
    const caseManifest = readJson(join(runDir, dirname(turn), 'metrics-manifest.json'));
    const capturedIds = manifest?.requestIds ?? (caseManifest?.requestIds?.[index] ? [caseManifest.requestIds[index]] : []);
    const traceIds = [...new Set((traceTurns[index] ?? []).map(record => record.requestId).filter(id => typeof id === 'string'))];
    const manifestMatches = capturedIds.length === 1 && traceIds.length === 1 && capturedIds[0] === traceIds[0];
    return { turn, ...source(path), status: valid ? 'present' : notApplicable ? 'not_applicable' : state === undefined ? 'missing_or_unknown' : 'invalid',
      explorationOpened: state?.explorationOpened === false ? false : Array.isArray(state?.visited) ? true : null,
      requestId: typeof state?.requestId === 'string' ? state.requestId : null,
      correlation: typeof state?.requestId === 'string' ? traceTurns[index]?.some(record => record.requestId === state.requestId) ? 'matched' : 'mismatch'
        : notApplicable ? 'not_applicable' : manifestMatches ? 'matched_by_capture_manifest' : 'unverified' };
  });
  const metrics = records.length ? runMetrics(records) : null;
  const lifecycleValid = requestIds.length > 0 && requestIds.every(id => {
    const own = records.filter(record => record.requestId === id);
    const starts = own.filter(record => record.type === 'turn-start');
    const ends = own.filter(record => record.type === 'turn-terminal');
    return starts.length === 1 && ends.length === 1 && ['ok', 'error', 'cancelled'].includes(ends[0].status)
      && own.indexOf(starts[0]) < own.indexOf(ends[0]);
  });
  const issues = [];
  if (remoteConflicts.length) issues.push(`Conflicting immutable Langfuse observation identities: ${JSON.stringify(remoteConflicts)}`);
  if (!tracePath || !records.length || !lifecycleValid) issues.push('NDJSON lifecycle missing or incomplete');
  if (!host?.trim()) issues.push('VS Code debug log missing or empty');
  if (!states.length || states.some(state => !['present', 'not_applicable'].includes(state.status))) issues.push('Per-turn state evidence missing or invalid');
  if (!exportOk) issues.push('Langfuse successful export receipt missing or incomplete');
  if (states.some(state => state.correlation === 'mismatch')) issues.push('State request identity mismatch');
  if (payload && (!spans.length || spanTraceIds.some(id => !receipt?.traceIds?.includes(id))
    || requestIds.some(id => !requestTracePairs.some(pair => pair.requestId === id)))) issues.push('Langfuse outgoing payload identities do not cover captured requests');
  const unverified = [];
  if (!spans.length) unverified.push('Langfuse span content unavailable');
  if (!requestIds.length || !host || requestIds.some(id => !host.includes(id))) unverified.push('Debug log request correlation incomplete');
  if (states.some(state => state.correlation === 'unverified')) unverified.push('State request identity unavailable');
  const attribute = (span, key) => Array.isArray(span.attributes) ? span.attributes.find(item => item.key === key)?.value?.stringValue : null;
  const selectedTraceIds = new Set(requestTracePairs.filter(pair => requestIds.includes(pair.requestId)).map(pair => pair.traceId));
  const generations = spans.filter(span => attribute(span, 'langfuse.observation.type') === 'generation' && (!selectedTurns || selectedTraceIds.has(span.traceId)));
  const generationUsage = generations.map(span => { try { return JSON.parse(attribute(span, 'langfuse.observation.usage_details')); } catch { return null; } });
  const usageTotal = key => generations.length && generationUsage.every(usage => Number.isFinite(usage?.[key]))
    ? generationUsage.reduce((sum, usage) => sum + usage[key], 0) : null;
  const traceUsage = metrics?.detailed.usage;
  const usageCrosscheck = Object.fromEntries(['input', 'output', 'total'].map(key => [key,
    numberDelta(traceUsage?.[key]?.total ?? null, usageTotal(key))]));
  return { captured: issues.length === 0, comparable: issues.length === 0 && spans.length > 0,
    complete: issues.length === 0 && unverified.length === 0, issues, unverified,
    ndjson: { ...source(tracePath), status: records.length ? 'present' : 'missing', lifecycleValid,
      identities: { requestIds, traceIds: ids('traceId'), spanIds: ids('spanId'), callIds: ids('callId') } },
    debugLog: { ...source(hostPath), status: host?.trim() ? 'present' : 'missing',
      correlatedRequestIds: host ? requestIds.filter(id => host.includes(id)) : [],
      lifecycleLines: host ? host.split('\n').filter(line => /turn.start|turn.terminal|request.start|request.end/i.test(line)).length : null,
      lexicalErrorMentions: host ? host.split('\n').filter(line => /\berror\b/i.test(line)).length : null,
      correlation: host && requestIds.length && requestIds.every(id => host.includes(id)) ? 'all_request_ids_observed' : 'unverified' },
    states, langfuse: { ...source(receiptPath), status: remoteConflicts.length ? 'ambiguous_observation_ids' : exportOk ? receipt.source === 'server_read' ? 'server_observations_received' : 'export_receipt_valid' : 'missing_or_invalid_receipt',
      exported: Number.isFinite(receipt?.exported) ? receipt.exported : null,
      errors: Array.isArray(receipt?.errors) ? receipt.errors.length : null,
      traceIds: Array.isArray(receipt?.traceIds) ? receipt.traceIds : [],
      content: remoteConflicts.length ? 'ambiguous: conflicting immutable stored observations' : remoteSpans.length ? 'server_observations: retrieved persisted Langfuse observations' : spans.length ? 'outgoing_payload: local exact export body; remote persisted content unverified'
        : 'unavailable: local receipt contains no exported span content',
      payload: { ...source(payloadPath), status: payloadSpans.length ? 'outgoing_payload_present' : existsSync(payloadPath) ? 'invalid' : 'unavailable',
        spans: payloadSpans.length, traceIds: [...new Set(payloadSpans.map(span => span.traceId))] },
      identities: { traceIds: spanTraceIds, spanIds: spans.map(span => span.spanId), requestTracePairs },
      storedObservations: { ...source(observationsPath), status: remoteConflicts.length ? 'ambiguous' : remoteSpans.length ? 'present' : 'unavailable',
        observations: remoteRows.length, uniqueObservations: uniqueRemoteRows.length, conflictingObservationIds: remoteConflicts },
      generationUsageCrosscheck: usageCrosscheck,
      generationDurationsMs: remoteConflicts.length ? null : generations.map(span => {
        try { return Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6; } catch { return null; }
      }),
      requestTracePairing: requestTracePairs.length ? 'recorded_in_outgoing_payload' : 'unverified: receipt does not map request IDs to trace IDs' } };
}

/** Builds the hard-fact report for the named baselines. */
export function scoreCandidate(candidateDir, baselines, outDir) {
  mkdirSync(outDir, { recursive: true });
  const arms = [];
  const differs = [];
  let operationalDefects = false;
  let toolFailure = false;
  const candidateTrace = readTrace(candidateDir);
  const measurements = records => {
    if (!records) return null;
    const { metrics: _metrics, ...facts } = traceFacts(records);
    return facts;
  };
  const candidateMeasurements = measurements(candidateTrace);
  const candidateRun = readJson(join(candidateDir, 'run.json'));
  if (candidateTrace) operationalDefects = defectNames(runMetrics(candidateTrace)).length > 0;
  const candidateEvidence = auditRunEvidence(candidateDir);
  if (!candidateEvidence.comparable) toolFailure = true;
  for (const baseline of baselines) {
    if (!existsSync(baseline.dir)) {
      arms.push({ name: baseline.name, dir: baseline.dir, compared: false, reason: 'directory missing',
        workloadStatus: 'unknown', measurements: { baseline: null, candidate: candidateMeasurements } });
      toolFailure = true;
      continue;
    }
    const baselineEvidence = auditRunEvidence(baseline.dir, baseline.turns);
    const evidenceComplete = candidateEvidence.comparable && baselineEvidence.comparable;
    if (!evidenceComplete) toolFailure = true;
    const candidateCount = turnNames(candidateDir).length || candidateRun?.turns?.length || 0;
    if (baseline.turns && baseline.turns.length !== candidateCount) {
      arms.push({ name: baseline.name, dir: baseline.dir, compared: false, workloadStatus: 'unknown',
        reason: 'Selected baseline turn count does not match the candidate.',
        measurements: { baseline: measurements(readTrace(baseline.dir)), candidate: candidateMeasurements }, measurementScope: 'all_recorded_turns' });
      toolFailure = true;
      continue;
    }
    const pair = compareRunPair(candidateDir, baseline.dir, baseline.turns);
    const workload = (candidateRun?.turns ?? []).flatMap(turn => (turn.baselineComparisons ?? [])
      .filter(comparison => comparison.source === baseline.dir));
    const workloadStatus = pair.turns.some(turn => turn.identity === 'different')
      || workload.some(comparison => comparison.status === 'different_workload' || comparison.differences?.length)
      ? 'different_workload' : workload.length === candidateCount && candidateCount > 0
        && workload.every(comparison => comparison.status === 'aligned') && pair.turns.every(turn => turn.identity === 'matched') ? 'aligned' : 'unknown';
    const paired = evidenceComplete && workloadStatus === 'aligned';
    if (paired) for (const item of pair.differs) differs.push({ arm: baseline.name, ...item });
    const arm = { name: baseline.name, dir: baseline.dir, turns: pair.turns, facts: null, defects: [], baselineDefects: [],
      evidence: baselineEvidence, workloadStatus, workload,
      ...(!evidenceComplete ? { reason: 'Comparison evidence is incomplete; available measurements are reported without paired conclusions.' } : {}) };
    let baselineTrace = readTrace(baseline.dir);
    if (baselineTrace && baseline.turns) {
      const slices = splitByTurn(baselineTrace);
      baselineTrace = baseline.turns.every(turn => slices[turn - 1]) ? baseline.turns.flatMap(turn => slices[turn - 1]) : null;
    }
    arm.measurements = { baseline: measurements(baselineTrace), candidate: candidateMeasurements };
    if (!candidateTrace || !baselineTrace) {
      arm.facts = { compared: false, reason: 'NDJSON trace is missing.' };
      toolFailure = true;
    } else {
      const compared = compareTraceFacts(baselineTrace, candidateTrace);
      arm.facts = compared.facts;
      arm.defects = compared.candidateDefects;
      arm.baselineDefects = compared.baselineDefects;
      const turnSections = compareTurnSections(baselineTrace, candidateTrace);
      arm.turnSectionsCompared = turnSections.compared;
      arm.turnSections = turnSections.turns;
      if (paired) {
        for (const item of compared.differs) differs.push({ arm: baseline.name, ...item });
        for (const item of turnSections.differs) differs.push({ arm: baseline.name, ...item });
      }
      if (compared.candidateDefects.length) operationalDefects = true;
    }
    arms.push(arm);
  }
  const report = { candidate: candidateDir, evidence: candidateEvidence, measurements: candidateMeasurements, arms, differs, operationalDefects, toolFailure,
    reviewStatus: toolFailure || !candidateEvidence.complete || arms.some(arm => arm.evidence?.complete === false || arm.workloadStatus !== 'aligned') ? 'Comparison incomplete; content unverified' : differs.length
      ? 'Unresolved differences — review required' : 'No measured difference; content unverified' };
  writeFileSync(join(outDir, 'score.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === '--trace') {
    runTraceMetrics(process.argv.slice(3));
    process.exit(0);
  }
  const usage = 'usage: node tests/tools/lineage-score.mjs CANDIDATE --out DIR [--previous DIR] [--main DIR]';
  const parsed = parseScoreArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(usage);
    process.exit(process.argv.includes('--help') ? 0 : 2);
  }
  const baselines = [
    ...(parsed.previous ? [{ name: 'previous', dir: parsed.previous, turns: parsed.previousTurns }] : []),
    ...(parsed.main ? [{ name: 'main', dir: parsed.main, turns: parsed.mainTurns }] : []),
  ];
  let report;
  try {
    const { loadTestEnv } = await import('./load-test-env.mjs');
    loadTestEnv();
    const references = [];
    for (const source of [parsed.candidate, ...baselines.map(baseline => baseline.dir)]) {
      try { references.push(await resolveRunSource(source)); }
      catch { references.push({ source, directory: source, hydrated: false, resolution: 'unavailable; local measurements only' }); }
    }
    const [candidate, ...resolvedBaselines] = references;
    for (const [index, baseline] of baselines.entries()) baseline.dir = resolvedBaselines[index].directory;
    report = scoreCandidate(candidate.directory, baselines, parsed.out);
    report.sources = references.map(({ source, directory, hydrated, resolution }) => ({ source, directory, hydrated, ...(resolution ? { resolution } : {}) }));
    writeFileSync(join(parsed.out, 'score.json'), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    console.error('Stored evidence could not be resolved; no comparison computed. Check Langfuse configuration, source references and retained attachments.');
    process.exit(2);
  }
  if (report.operationalDefects) process.exit(1);
  if (report.toolFailure) process.exit(2);
}
