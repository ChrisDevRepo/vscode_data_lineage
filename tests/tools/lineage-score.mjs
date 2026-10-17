#!/usr/bin/env node
// Hard-fact comparison of one candidate run with stored previous and main runs.
// Usage: node tests/tools/lineage-score.mjs CANDIDATE --out DIR [--previous DIR] [--main DIR]
// Reads captures that already exist. It does not call a model or grade answer correctness.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findings, measureMarkup, parseTrace, runMetrics, spreadFindings } from './trace-metrics.mjs';

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

/** Order-sensitive list compare. Both sides absent is equal. One side absent is a regression. */
export function compareSequences(baseline, candidate) {
  if (baseline == null && candidate == null) return { status: 'absent', regression: false };
  if (baseline == null || candidate == null) return { status: 'missing_side', regression: true };
  const same = baseline.length === candidate.length && baseline.every((item, index) => item === candidate[index]);
  return { status: same ? 'equal' : 'different', regression: !same };
}

/** Set compare of column edges. The same pairs in a different order are a signal, not a regression. */
export function comparePairSets(baselineEdges, candidateEdges) {
  const baseline = pairSequence(baselineEdges);
  const candidate = pairSequence(candidateEdges);
  if (baseline === null && candidate === null) return { status: 'absent', regression: false, signal: null, lost: [], added: [] };
  if (baseline === null || candidate === null) return { status: 'missing_side', regression: true, signal: null, lost: [], added: [] };
  const baseSet = new Set(baseline);
  const candSet = new Set(candidate);
  const lost = [...baseSet].filter(item => !candSet.has(item)).sort();
  const added = [...candSet].filter(item => !baseSet.has(item)).sort();
  const sameSet = lost.length === 0 && added.length === 0;
  const sameOrder = sameSet && baseline.length === candidate.length && baseline.every((item, index) => item === candidate[index]);
  return {
    status: sameSet ? (sameOrder ? 'equal' : 'order_only') : 'different',
    regression: !sameSet,
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

/** BFS and column-edge view of one turn. Both files absent means the turn did not open an exploration. */
export function graphOfTurn(turnDir) {
  const state = readJson(join(turnDir, 'sm-state.json'));
  const snapshot = readJson(join(turnDir, 'final-snapshot.json'));
  if (state === undefined && snapshot === undefined) return { status: 'no_exploration' };
  return {
    status: 'present',
    visited: Array.isArray(state?.visited) ? state.visited : null,
    agenda: Array.isArray(state?.agenda) ? state.agenda.map(entry => entry?.nodeId ?? null) : null,
    finalNodes: Array.isArray(snapshot?.nodes) ? snapshot.nodes : null,
    columnEdges: state?.columnAspect?.edges ?? null,
    snapshotEdges: snapshot?.columnEdges ?? null,
  };
}

/** Compares two turn views. A lost or added column pair is a regression. Visit order is order-sensitive. */
export function compareGraphs(baseline, candidate) {
  if (baseline.status === 'no_exploration' && candidate.status === 'no_exploration') return { status: 'no_exploration', regression: false };
  if (baseline.status === 'no_exploration' || candidate.status === 'no_exploration') return { status: 'missing_side', regression: true };
  const visited = compareSequences(baseline.visited, candidate.visited);
  const agenda = compareSequences(baseline.agenda, candidate.agenda);
  const finalNodes = compareSequences(baseline.finalNodes, candidate.finalNodes);
  const columnAspect = comparePairSets(baseline.columnEdges, candidate.columnEdges);
  const snapshotEdges = comparePairSets(baseline.snapshotEdges, candidate.snapshotEdges);
  const regression = [visited, agenda, finalNodes, columnAspect, snapshotEdges].some(item => item.regression);
  return { status: regression ? 'regression' : 'equal', regression, visited, agenda, finalNodes, columnAspect, snapshotEdges };
}

/** Preview text, chat-window text, and literal SQL-fence and formula counts. The counts do not grade meaning. */
export function turnText(turnDir) {
  const description = readJson(join(turnDir, 'present-result.json'))?.aiMetadata?.description;
  const preview = typeof description === 'string' ? description : null;
  const answerPath = join(turnDir, 'answer.md');
  const chat = existsSync(answerPath) ? readFileSync(answerPath, 'utf8') : null;
  const markup = preview === null ? null : measureMarkup(preview);
  const formula = markup === null ? null : markup.formulaMarkup.dollarDisplay + markup.formulaMarkup.bracketDisplay
    + markup.formulaMarkup.parenthesisInline + markup.formulaMarkup.dollarInline;
  return { previewChars: preview?.length ?? null, chatChars: chat?.length ?? null, sqlFences: markup?.fences.sql ?? null, formula };
}

/** Preview-size band. Within 15 percent is green. Under half the baseline is red. Other shrinkage or growth is amber. */
export function sizeRag(baseline, candidate) {
  if (baseline === null || candidate === null) return { rag: 'UNKNOWN', regression: false, diffPct: null, baseline, candidate };
  const diffPct = baseline === 0 ? (candidate === 0 ? 0 : 100) : Number((((candidate - baseline) / baseline) * 100).toFixed(1));
  const rag = Math.abs(diffPct) <= 15 ? 'GREEN' : candidate < baseline * 0.5 ? 'RED' : 'AMBER';
  return { rag, regression: rag !== 'GREEN', diffPct, baseline, candidate };
}

/** Token total band. Within 15 percent above the baseline is green. A larger total is amber. */
export function tokenBand(baseline, candidate) {
  if (baseline === null || candidate === null) return { baseline, candidate, diff: null, diffPct: null, rag: 'UNKNOWN', regression: false };
  const diff = candidate - baseline;
  const diffPct = baseline === 0 ? (candidate === 0 ? 0 : 100) : Number(((diff / baseline) * 100).toFixed(1));
  const rag = diffPct <= 15 ? 'GREEN' : 'AMBER';
  return { baseline, candidate, diff, diffPct, rag, regression: rag !== 'GREEN' };
}

/** Duration band. Within 20 percent is green. Within triple is amber. Beyond that is red. */
export function durationBand(baseline, candidate) {
  if (baseline === null || candidate === null) return { baseline, candidate, diff: null, rag: 'UNKNOWN', regression: false };
  const rag = candidate <= baseline * 1.2 ? 'GREEN' : candidate <= baseline * 3 ? 'AMBER' : 'RED';
  return { baseline, candidate, diff: candidate - baseline, rag, regression: rag !== 'GREEN' };
}

/** An increase is a regression. A decrease stays green. */
export function worseCount(baseline, candidate) {
  return { baseline, candidate, diff: candidate - baseline, rag: candidate > baseline ? 'RED' : 'GREEN', regression: candidate > baseline };
}

/** Any change is a stored difference. */
export function changedCount(baseline, candidate) {
  if (baseline === null || candidate === null) return { baseline, candidate, diff: null, rag: 'UNKNOWN', regression: false };
  const diff = candidate - baseline;
  return { baseline, candidate, diff, rag: diff === 0 ? 'GREEN' : 'AMBER', regression: diff !== 0 };
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
  return {
    metrics,
    tokens: { input: usage.input.total, output: usage.output.total, total: usage.total.total },
    durationMs: metrics.detailed.turnTiming.recordedDurationMs,
    rejections: metrics.repair.rejectedCalls,
    escalation: escalationCount(metrics.repair.chains),
    commands: commandCounts(records),
  };
}

function numberDelta(baseline, candidate) {
  if (baseline === null || candidate === null) return { baseline, candidate, diff: null };
  return { baseline, candidate, diff: candidate - baseline };
}

/** Hard-fact delta of two parsed traces, plus operational defect rule names. */
export function compareTraceFacts(baselineRecords, candidateRecords) {
  const baseline = traceFacts(baselineRecords);
  const candidate = traceFacts(candidateRecords);
  const defects = [...new Set([...findings(baseline.metrics), ...findings(candidate.metrics), ...spreadFindings([baseline.metrics, candidate.metrics])]
    .filter(item => item.kind === 'defect').map(item => item.rule))];
  const facts = {
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
  const regressions = [];
  if (facts.tokens.total.regression) regressions.push({ label: 'tokens', rag: facts.tokens.total.rag, diffPct: facts.tokens.total.diffPct });
  if (facts.durationMs.regression) regressions.push({ label: 'duration', rag: facts.durationMs.rag, diff: facts.durationMs.diff });
  if (facts.rejections.regression) regressions.push({ label: 'rejections', diff: facts.rejections.diff });
  if (facts.escalation.regression) regressions.push({ label: 'escalation', diff: facts.escalation.diff });
  if (facts.commands.prune.regression) regressions.push({ label: 'prune', diff: facts.commands.prune.diff });
  if (facts.commands.add.regression) regressions.push({ label: 'add', diff: facts.commands.add.diff });
  return { facts, regressions, defects };
}

/** `matched` when question and fixture hashes agree, `different` when both sides named them and they disagree, otherwise `unknown`. */
export function identitiesMatch(baseline, candidate) {
  if (!baseline?.questionHash || !baseline?.fixtureHash || !candidate?.questionHash || !candidate?.fixtureHash) return 'unknown';
  return baseline.questionHash === candidate.questionHash && baseline.fixtureHash === candidate.fixtureHash ? 'matched' : 'different';
}

/** Turn directory names in index order. */
export function turnNames(runDir) {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir).filter(name => /^turn-\d+$/.test(name)).sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)));
}

/** Per-turn graph and text comparison. A different fixture stays out of the regression list. */
export function compareRunPair(candidateDir, baselineDir) {
  const candidateRun = readJson(join(candidateDir, 'run.json')) ?? { turns: [] };
  const baselineRun = readJson(join(baselineDir, 'run.json')) ?? { turns: [] };
  const count = Math.max(turnNames(candidateDir).length, turnNames(baselineDir).length, candidateRun.turns?.length ?? 0, baselineRun.turns?.length ?? 0);
  const turns = [];
  const regressions = [];
  for (let index = 0; index < count; index++) {
    const baselineIdentity = baselineRun.turns?.[index] ?? {};
    const candidateIdentity = candidateRun.turns?.[index] ?? {};
    const identity = identitiesMatch(baselineIdentity, candidateIdentity);
    const turn = index + 1;
    if (identity === 'different') {
      turns.push({ turn, identity, graph: { status: 'excluded', regression: false }, text: { status: 'excluded' } });
      continue;
    }
    const graph = compareGraphs(graphOfTurn(join(baselineDir, `turn-${turn}`)), graphOfTurn(join(candidateDir, `turn-${turn}`)));
    const baselineText = turnText(join(baselineDir, `turn-${turn}`));
    const candidateText = turnText(join(candidateDir, `turn-${turn}`));
    const text = {
      preview: sizeRag(baselineText.previewChars, candidateText.previewChars),
      chat: sizeRag(baselineText.chatChars, candidateText.chatChars),
      sqlFences: changedCount(baselineText.sqlFences, candidateText.sqlFences),
      formula: changedCount(baselineText.formula, candidateText.formula),
    };
    if (graph.regression) {
      for (const field of ['visited', 'agenda', 'finalNodes', 'columnAspect', 'snapshotEdges']) {
        if (graph[field]?.regression) regressions.push({ turn, label: field, lost: graph[field].lost, added: graph[field].added });
      }
      if (!graph.visited && graph.status === 'missing_side') regressions.push({ turn, label: 'exploration' });
    }
    for (const label of ['preview', 'chat', 'sqlFences', 'formula']) {
      if (text[label].regression) regressions.push({ turn, label, rag: text[label].rag, diff: text[label].diff, diffPct: text[label].diffPct });
    }
    turns.push({ turn, identity, graph, text });
  }
  return { turns, regressions };
}

/** Newest trace in a run directory. */
export function newestNdjson(runDir) {
  const dir = join(runDir, 'lm-trace');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(name => name.endsWith('.ndjson')).map(name => join(dir, name));
  files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return files[0] ?? null;
}

/** Parses `CANDIDATE --out DIR [--previous DIR] [--main DIR]`. */
export function parseScoreArgs(args) {
  const valueAfter = flag => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const flags = new Set(['--out', '--previous', '--main']);
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && flags.has(args[index - 1])));
  const out = valueAfter('--out');
  const previous = valueAfter('--previous');
  const main = valueAfter('--main');
  if (args.includes('--help') || positional.length !== 1 || !out || out.startsWith('--')) return null;
  if (args.includes('--previous') && !previous) return null;
  if (args.includes('--main') && !main) return null;
  if (!previous && !main) return null;
  return { candidate: positional[0], out, previous, main };
}

function readTrace(runDir) {
  const tracePath = newestNdjson(runDir);
  if (!tracePath) return null;
  return parseTrace(readFileSync(tracePath, 'utf8'));
}

/** Builds the hard-fact report for the named baselines. */
export function scoreCandidate(candidateDir, baselines, outDir) {
  mkdirSync(outDir, { recursive: true });
  const arms = [];
  const regressions = [];
  let operationalDefects = false;
  let toolFailure = false;
  const candidateTrace = readTrace(candidateDir);
  for (const baseline of baselines) {
    if (!existsSync(baseline.dir)) {
      arms.push({ name: baseline.name, dir: baseline.dir, compared: false, reason: 'directory missing' });
      toolFailure = true;
      continue;
    }
    const pair = compareRunPair(candidateDir, baseline.dir);
    for (const item of pair.regressions) regressions.push({ arm: baseline.name, ...item });
    const excluded = pair.turns.some(turn => turn.identity === 'different');
    const arm = { name: baseline.name, dir: baseline.dir, turns: pair.turns, facts: null, defects: [] };
    const baselineTrace = readTrace(baseline.dir);
    if (!candidateTrace || !baselineTrace) {
      arm.facts = { compared: false, reason: 'NDJSON trace is missing.' };
      toolFailure = true;
    } else {
      const compared = compareTraceFacts(baselineTrace, candidateTrace);
      arm.facts = compared.facts;
      arm.defects = compared.defects;
      if (!excluded) for (const item of compared.regressions) regressions.push({ arm: baseline.name, ...item });
      if (compared.defects.length) operationalDefects = true;
    }
    arms.push(arm);
  }
  const report = { candidate: candidateDir, arms, regressions, operationalDefects, toolFailure };
  writeFileSync(join(outDir, 'score.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const usage = 'usage: node tests/tools/lineage-score.mjs CANDIDATE --out DIR [--previous DIR] [--main DIR]';
  const parsed = parseScoreArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(usage);
    process.exit(process.argv.includes('--help') ? 0 : 2);
  }
  const baselines = [
    ...(parsed.previous ? [{ name: 'previous', dir: parsed.previous }] : []),
    ...(parsed.main ? [{ name: 'main', dir: parsed.main }] : []),
  ];
  const report = scoreCandidate(parsed.candidate, baselines, parsed.out);
  if (report.operationalDefects) process.exit(1);
  if (report.toolFailure) process.exit(2);
}
