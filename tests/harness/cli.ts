/** Optional service runners. An AI run captures its trace and, when baseline directories are set, scores that capture without another model call. */
import type { DatabaseModel } from '../../src/engine/types';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as vscode from 'vscode';
import { z } from 'zod';
import { sanitizeProviderErrorDiagnostic } from '../../src/ai/support/text';
import { AiTraceWriter } from '../../src/ai/observability/aiTraceWriter';
import { BuiltInConnectionSchema } from '../../src/engine/db/connectionSettings';
import { openBuiltInSession } from '../../src/engine/db/builtInProvider';
import { loadDmvQueries, executeDmvQueries, executeDmvQueriesFiltered } from '../../src/engine/connectionManager';
import { buildModelFromDmv, buildSchemaPreview, validateQueryResult, type DmvResults } from '../../src/engine/dmvExtractor';
import { createHeadlessLogger } from './headlessLogger';
import { exportBudgetMs, exportRunToLangfuse, baselineSession, BASELINE_BRANCH, freezeRunEvidence, resolveLangfuseConfig, type LangfuseAttachment, type LangfuseAttachments } from './langfuseExport';
import { OpenAiCompatiblePort } from './openAiCompatiblePort';
import { runHarnessTurn, nativeHarnessPrompt, approvalWorkload, approvalWorkloadDifferences, requiredApprovalRefinement, type ApprovalWorkload } from './runTurn';
import { AiGateRefineSchema, type AiGateRefine } from '../../src/engine/shared/bridgeContract';
import { StartExplorationInputSchema } from '../../src/ai/tools/toolSchemas';
import { directionFromDepth } from '../../src/engine/shared/explorationDepthContract';
import { createHarnessSession, loadHarnessParseRules, repoPath } from './sessionFactory';
import { parseTrace } from './traceModel';
import { setShimLogSink, Uri } from './vscodeHostShim';
import { createRequire } from 'node:module';
import { modelUserMessage, modelAssistantMessage, type ModelMessage } from '../../src/ai/model/modelPort';

interface CatalogCase {
  readonly id: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly followup?: readonly string[];
  readonly dacpac?: string;
  readonly gate?: readonly import('./runTurn').GateRoundPolicy[];
  readonly expect?: {
    readonly terminal?: string;
    /** Case-authored approval intent; omitted lens defaults to business when a gate appears. */
    readonly approval?: Partial<ApprovalWorkload>;
    readonly tokens_max?: number;
    readonly rejections_max?: number;
    readonly preview_chars_min?: number;
    readonly must_contain?: readonly string[];
    readonly missing_columns?: readonly string[];
    readonly sql_blocks_min?: number;
  };
}

/** Reads the catalog from the repository, including after this file is compiled under out/. */
function headlessCases(): CatalogCase[] {
  const loader = repoPath('tests', 'cases', 'loadCases.cjs');
  return (createRequire(loader)(loader) as { loadCases: (runner?: string) => CatalogCase[] }).loadCases('headless');
}

/** Reports other declared test surfaces and unavailable fixtures without running or omitting them. */
export function caseInventory() {
  const loader = repoPath('tests', 'cases', 'loadCases.cjs');
  const inventory = (createRequire(loader)(loader) as { loadInventory: () => {
    additional_cases: Array<{ id: string; description: string; runner: string; command: string }>;
    unavailable_cases: Array<{ id: string; description: string; reason: string }>;
  } }).loadInventory();
  return {
    additionalCases: inventory.additional_cases.map(row => ({ ...row, execution: 'not_run' as const })),
    unavailableCases: inventory.unavailable_cases.map(row => ({ ...row, execution: 'not_runnable' as const })),
  };
}

/** Reasoning effort a hosted provider profile accepts. */
type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'off';

/** Hosted provider profiles the AI runner accepts. */
const AI_PROVIDERS = ['azure', 'fireworks', 'openrouter', 'openai-compatible'] as const;

const HELP = `Optional testing toolset; it records checks and does not grade answers:
  npm run test:ai:headless -- [--all | --case ID] [--list] [--baselines FILE] [--dacpac FILE] [--prompt TEXT] [--followup TEXT ...]
                            [--effort LEVEL] [--attach] [--baseline --branch NAME]
                            [--timeout-ms N] [--request-timeout-ms N]
                            [--label ID] [--session ID] [--tag TEXT ...]
  npm run test:db:smoke -- [--timeout-ms N]
With no --prompt, the AI runner loops the headless rows in
tests/cases/lineage-cases.yaml. Every turn is checked against the row's expect.terminal and
rejections_max; the first answer of a row against its content checks. A failed check is
recorded in run.json and exits 2 after the trace export. Failed turns end that row's
dependent follow-ups; independent rows continue unless the run is cancelled.
--all explicitly selects every headless catalog row (also the default); --case selects one exact ID.
--list prints the selected headless inventory and hashes without contacting any service.
--all invokes the existing single-case runner serially, retaining separate captures and scores.
--baselines reads {cases:{ID:{main:{runDir,turns?},previous:{runDir,turns?}}}};
turns are explicit 1-based indices; paths are relative to the repository or absolute.
Missing pairs remain unpaired; content is unverified until reviewed against SQL.
--prompt runs that question instead of the catalog; it cannot be combined with catalog selectors.
Other test surfaces and unavailable historical fixtures are listed in docs/testing/INVENTORY.md.
--timeout-ms bounds the entire run; --request-timeout-ms independently bounds each
provider request. AI_TEST_TIMEOUT_MS and AI_TEST_REQUEST_TIMEOUT_MS set defaults;
AI defaults to two hours with requests bounded by the same budget.
AI requires a hosted provider: AI_TEST_PROVIDER (azure, fireworks, openrouter or
openai-compatible) with its AI_TEST_ENDPOINT, AI_TEST_API_KEY and AI_TEST_MODEL. There is no
default provider.
An AI run always writes a verbose NDJSON trace, host.log, and sm-state.json for every
turn and exports trace spans to Langfuse. --attach uploads the captured source files to the
trace of an ordinary run (tag verification). --baseline is a separate owner-requested step per
branch: it requires --branch NAME, uploads the files, uses session baseline-NAME-COMMIT and tag
baseline:NAME, and rejects --session. Daily and verification runs never use --baseline. A turn that did not open an exploration still
writes sm-state.json with explorationOpened false. Set LANGFUSE_BASE_URL,
LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY before the first model call. --langfuse,
--trace-verbose remain accepted and do not turn that capture off.
A missing artifact or an export other than ok fails the run. One export retry stays
inside the free-plan export budget and does not call the model again.
Set AI_TEST_PREVIOUS_RUN and AI_TEST_MAIN_RUN to existing run directories to write
baseline-score.json beside the new run. Unset directories record that no comparison ran.
A database smoke does not call a model and does not export. The installed extension does not upload traces.
DB uses DB_TEST_SERVER, DB_TEST_DATABASE, DB_TEST_USER, DB_TEST_PASSWORD,
optional DB_TEST_AUTH_TYPE (sqlLogin, or entraId with a DB_TEST_TOKEN access token), DB_TEST_TENANT_ID,
DB_TEST_PORT, DB_TEST_ENCRYPT and DB_TEST_TRUST_SERVER_CERTIFICATE.
For noninteractive Entra test login, set DB_TEST_CLIENT_ID, DB_TEST_TENANT_ID,
DB_TEST_USER and DB_TEST_PASSWORD; the launcher acquires a token only in memory.
All services require explicit setup. Artifacts are written only under ignored
test-results/headless. AI gates are simulated approvals; this runner does not
test interactive VS Code consent.`;


/** Database smoke deadline. */
const DEFAULT_DB_TIMEOUT_MS = 300_000;
/** Configurable budget for multi-turn AI runs, including slower local providers. */
const DEFAULT_AI_TIMEOUT_MS = 7_200_000;
const testTimeoutSchema = z.coerce.number().int().min(1).max(2_147_423_647, 'test timeout must be at most 2147423647');

/** Reads the run's evidence files for upload to the trace backend; missing files are skipped. */
function collectAttachments(runDir: string, tracePath: string, turnCount: number, redact: readonly string[]): LangfuseAttachments {
  const read = (name: string, contentType: LangfuseAttachment['contentType'], path: string): LangfuseAttachment[] =>
    existsSync(path) ? [{ name, contentType, content: readFileSync(path, 'utf8') }] : [];
  return {
    redact,
    run: [...read('event-trace', 'text/plain', tracePath), ...read('debug-log', 'text/plain', join(runDir, 'host.log'))],
    turns: Array.from({ length: turnCount }, (_, index) => {
      const dir = join(runDir, `turn-${index + 1}`);
      return [
        ...read('answer', 'text/markdown', join(dir, 'answer.md')),
        ...read('hop-log', 'application/json', join(dir, 'hop-log.json')),
        ...read('state-dump', 'application/json', join(dir, 'sm-state.json')),
        ...read('result', 'application/json', join(dir, 'present-result.json')),
        ...read('identity', 'application/json', join(dir, 'metrics-manifest.json')),
        ...read('final-snapshot', 'application/json', join(dir, 'final-snapshot.json')),
      ];
    }),
  };
}

/** Actual state establishes exploration even when the turn failed before publishing a result. */
function turnOpenedExploration(turnDir: string): boolean {
  try {
    const state = JSON.parse(readFileSync(join(turnDir, 'sm-state.json'), 'utf8')) as { explorationOpened?: unknown; visited?: unknown };
    if (state.explorationOpened === false) return false;
    if (Array.isArray(state.visited)) return true;
  } catch { /* Older captures may only retain published artifacts. */ }
  if (existsSync(join(turnDir, 'present-result.json'))) return true;
  const snapshotPath = join(turnDir, 'final-snapshot.json');
  if (!existsSync(snapshotPath)) return false;
  try {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { nodes?: unknown };
    return Array.isArray(snapshot.nodes);
  } catch {
    return true;
  }
}

/** Names missing AI-run evidence. Every turn must have a non-empty `sm-state.json`. */
export function assessCapture(
  runDir: string,
  tracePath: string | undefined,
  exportStatus: string,
  turnCount: number,
): { gaps: string[]; explorations: Array<{ turn: number; opened: boolean }> } {
  const gaps: string[] = [];
  const explorations: Array<{ turn: number; opened: boolean }> = [];
  if (!tracePath || !existsSync(tracePath) || statSync(tracePath).size === 0) gaps.push('NDJSON trace is missing.');
  else {
    const first = readFileSync(tracePath, 'utf8').split('\n').find(line => line.trim());
    let verbose = false;
    try {
      const record = JSON.parse(first ?? '') as { type?: string; verbose?: boolean };
      verbose = record.type === 'trace-open' && record.verbose === true;
    } catch {
      verbose = false;
    }
    if (!verbose) gaps.push('Opening trace record is not verbose.');
  }
  const hostLog = join(runDir, 'host.log');
  if (!existsSync(hostLog) || statSync(hostLog).size === 0) gaps.push('Debug log is missing.');
  if (exportStatus !== 'ok') gaps.push(`Trace export is ${exportStatus}.`);
  const listed = existsSync(runDir)
    ? readdirSync(runDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^turn-\d+$/.test(entry.name)).length
    : 0;
  for (let turn = 1; turn <= Math.max(turnCount, listed); turn++) {
    const turnDir = join(runDir, `turn-${turn}`);
    const opened = turnOpenedExploration(turnDir);
    explorations.push({ turn, opened });
    const statePath = join(turnDir, 'sm-state.json');
    if (!existsSync(statePath) || statSync(statePath).size === 0) gaps.push(`Turn ${turn} has no sm-state.json.`);
  }
  return { gaps, explorations };
}

/** Writes the baseline comparison for directories the operator already captured. Unset directories record that no comparison ran. */
export function recordBaselineScore(runDir: string, result: Record<string, unknown>, logger: { info(message: string): void }, pairing?: BaselinePair): void {
  const previous = pairing ? pairing.previous?.runDir : process.env.AI_TEST_PREVIOUS_RUN?.trim();
  const mainBaseline = pairing ? pairing.main?.runDir : process.env.AI_TEST_MAIN_RUN?.trim();
  const summaryPath = join(runDir, 'baseline-score.json');
  if (!previous && !mainBaseline) {
    writeFileSync(summaryPath, `${JSON.stringify({ compared: false, reason: pairing ? 'Selected case has no paired baseline in the supplied map; content unverified.' : 'AI_TEST_PREVIOUS_RUN and AI_TEST_MAIN_RUN are unset' }, null, 2)}\n`);
    return;
  }
  const outDir = join(runDir, 'baseline-score');
  const args = [repoPath('tests', 'tools', 'lineage-score.mjs'), runDir, '--out', outDir];
  if (previous) args.push('--previous', previous);
  if (mainBaseline) args.push('--main', mainBaseline);
  if (pairing?.previous?.turns) args.push('--previous-turns', pairing.previous.turns.join(','));
  if (pairing?.main?.turns) args.push('--main-turns', pairing.main.turns.join(','));
  // The scorer reads the current approval comparisons from this manifest.
  // Finalization overwrites it after recording the remaining run metadata.
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(result, null, 2) + '\n');
  const score = spawnSync(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    shell: false,
  });
  const operational = score.status === 1;
  if (score.status !== 0) logger.info(operational ? 'Baseline comparison recorded operational differences; review the qualified measurements.' : 'Baseline comparison evidence is incomplete; candidate runtime status is unchanged.');
  const reportPath = join(outDir, 'score.json');
  let differenceCount: number | null = null;
  let reviewStatus = 'Comparison incomplete; content unverified';
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { differs?: unknown[]; reviewStatus?: string };
      differenceCount = report.differs?.length ?? null;
      reviewStatus = report.reviewStatus ?? reviewStatus;
    } catch {
      differenceCount = null;
    }
  }
  writeFileSync(summaryPath, `${JSON.stringify({
    compared: existsSync(reportPath),
    report: 'baseline-score/score.json',
    operationalDefects: operational,
    comparisonOnly: true,
    workloadEquivalent: result.workloadEquivalent ?? null,
    differenceCount,
    reviewStatus,
    exitCode: score.status,
  }, null, 2)}\n`);
}

/** Parses bounded runner options; rejects unknown flags before any service call. */
export function parseOptions(kind: string, args: readonly string[]) {
  let dacpac = repoPath('assets', 'demo.dacpac');
  let prompt: string | undefined;
  let promptFromCli = false;
  let dacpacFromCli = false;
  let timeoutMs: number | string = kind === 'ai' ? process.env.AI_TEST_TIMEOUT_MS?.trim() || DEFAULT_AI_TIMEOUT_MS : DEFAULT_DB_TIMEOUT_MS;
  let requestTimeoutMs: string | undefined = kind === 'ai' ? process.env.AI_TEST_REQUEST_TIMEOUT_MS?.trim() || undefined : undefined;
  let langfuse = kind === 'ai';
  let verbose = kind === 'ai';
  let attach = false;
  let baseline = false;
  let branch: string | undefined;
  let effort: ThinkingLevel | undefined;
  let caseId: string | undefined;
  let baselines: string | undefined;
  let all = false;
  let list = false;
  const followups: string[] = [];
  const tags: string[] = [];
  let label: string | undefined;
  let session: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (kind === 'ai' && (flag === '--all' || flag === '--list')) {
      if (flag === '--all') all = true;
      else list = true;
      continue;
    }
    if (kind === 'ai' && ['--langfuse', '--trace-verbose', '--attach', '--baseline'].includes(flag)) {
      if (flag === '--langfuse') langfuse = true;
      else if (flag === '--attach') attach = true;
      else if (flag === '--baseline') baseline = true;
      else verbose = true;
      continue;
    }
    if (!(flag === '--timeout-ms' || kind === 'ai' && ['--baselines', '--case', '--request-timeout-ms', '--dacpac', '--prompt', '--followup', '--label', '--session', '--tag', '--branch', '--effort', '--thinking'].includes(flag))) {
      throw new Error(`Unknown option ${flag}. Use --help.`);
    }
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (flag === '--timeout-ms') timeoutMs = value;
    if (flag === '--request-timeout-ms') requestTimeoutMs = value;
    if (flag === '--dacpac') { dacpac = resolve(value); dacpacFromCli = true; }
    if (flag === '--prompt') { prompt = value; promptFromCli = true; }
    if (flag === '--baselines') baselines = resolve(value);
    if (flag === '--case') {
      if (caseId) throw new Error('--case selects one catalog ID.');
      caseId = value;
    }
    if (flag === '--effort' || flag === '--thinking') {
      effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'off']).parse(value.toLowerCase());
    }
    if (flag === '--followup') followups.push(value);
    if (flag === '--label') label = z.string().trim().min(1).max(100).parse(value);
    if (flag === '--session') session = z.string().trim().min(1).max(190).parse(value);
    if (flag === '--branch') branch = z.string().regex(BASELINE_BRANCH, '--branch must be a plain branch name such as main or testing01.').parse(value);
    if (flag === '--tag') tags.push(z.string().trim().min(1).max(100).parse(value));
  }
  if (caseId && all || promptFromCli && (caseId || all || list)) throw new Error('Choose --all, --case, or --prompt without mixing selectors.');
  if (baseline && !branch) throw new Error('--baseline requires --branch NAME.');
  if (branch && !baseline) throw new Error('--branch is only for --baseline.');
  if (baseline && session) throw new Error('--baseline sets its own session; do not pass --session.');
  if (baseline) attach = true;
  if (attach && !langfuse) throw new Error('--attach requires --langfuse.');
  return { dacpac, prompt, promptFromCli, dacpacFromCli, caseId, baselines, all, list, followups, timeoutMs: testTimeoutSchema.parse(timeoutMs), requestTimeoutMs: testTimeoutSchema.parse(requestTimeoutMs ?? timeoutMs), langfuse, verbose, label, session, tags, attach, baseline, branch, effort };
}


/** One AI question sequence. Catalog rows set `expectTerminal`; a `--prompt` run does not. */
export interface AiRun {
  readonly id: string;
  readonly description?: string;
  readonly dacpac: string;
  readonly prompts: readonly string[];
  readonly gate?: readonly import('./runTurn').GateRoundPolicy[];
  readonly expectTerminal?: string;
  readonly expectMetrics?: CatalogCase['expect'];
}

/** Headless questions to execute. */
export function aiRuns(options: ReturnType<typeof parseOptions>): AiRun[] {
  if (options.promptFromCli) {
    return [{ id: 'cli-prompt', dacpac: options.dacpac, prompts: [options.prompt!, ...options.followups] }];
  }
  if (options.followups.length) throw new Error('--followup requires --prompt.');
  const catalog = headlessCases();
  const rows = options.caseId ? catalog.filter(row => row.id === options.caseId) : catalog;
  if (options.caseId && !rows.length) throw new Error(`Unknown headless case ${options.caseId}. Use --list.`);
  if (!rows.length) throw new Error('tests/cases/lineage-cases.yaml has no headless row.');
  return rows.map(row => {
    if (!row.prompt?.trim()) throw new Error(`${row.id} needs a prompt.`);
    if (!row.dacpac?.trim()) throw new Error(`${row.id} needs a dacpac.`);
    if (!row.expect?.terminal?.trim()) throw new Error(`${row.id} needs expect.terminal.`);
    if (row.expect.tokens_max !== undefined) {
      throw new Error(`${row.id}: expect.tokens_max is unsupported; the runner does not measure aggregate token usage.`);
    }
    return {
      id: row.id,
      description: row.description,
      dacpac: options.dacpacFromCli ? options.dacpac : repoPath(row.dacpac),
      prompts: [row.prompt, ...(row.followup ?? [])],
      gate: row.gate,
      expectTerminal: row.expect.terminal,
      expectMetrics: row.expect,
    };
  });
}

/** Selects the next catalog step without running dependent follow-ups after a failed turn. */
export function nextAiRunStep(outcome: string, aborted: boolean): 'prompt' | 'case' | 'stop' {
  if (aborted || outcome === 'cancelled') return 'stop';
  return outcome === 'ok' ? 'prompt' : 'case';
}

/** Keeps a failed or cancelled turn visible even when later independent cases succeed. */
export function aiRunStatus(turns: readonly { readonly outcome: string }[]): string {
  if (turns.some(turn => turn.outcome === 'cancelled')) return 'cancelled';
  return turns.find(turn => turn.outcome !== 'ok')?.outcome ?? (turns.length ? 'ok' : 'error');
}

/** Checks one finished turn against its catalog row. Terminal status and the rejection ceiling apply to every turn; the content checks (`preview_chars_min`, `must_contain`, `sql_blocks_min`) describe the row's question and apply to its first answer only. */
export function turnChecks(
  run: Pick<AiRun, 'expectTerminal' | 'expectMetrics' | 'gate'>,
  turn: { terminalStatus?: string | null; outcome: { outcome: string }; events: ReadonlyArray<{ type: string; recoverable?: boolean }>; text: string; gates?: readonly { requiredApproval?: { expected: Partial<ApprovalWorkload>; actual: ApprovalWorkload; differences: readonly string[] }; decision: string; instruction?: string; policyIndex?: number; expectation?: { ok: boolean }; refine?: unknown }[] },
  firstTurn: boolean,
): string[] {
  const failures: string[] = [];
  const actual = turn.terminalStatus ?? turn.outcome.outcome;
  if (turn.terminalStatus && turn.terminalStatus !== turn.outcome.outcome) {
    failures.push(`sink terminal ${turn.terminalStatus} disagrees with outcome ${turn.outcome.outcome}`);
  }
  if (run.expectTerminal && actual !== run.expectTerminal) failures.push(`terminal ${actual}, catalog expects ${run.expectTerminal}`);
  if (firstTurn) {
    for (const [index, policy] of (run.gate ?? []).entries()) {
      const receipts = turn.gates?.filter((gate, receiptIndex) => (gate.policyIndex ?? receiptIndex) === index) ?? [];
      const gate = receipts.at(-1);
      const round = index + 1;
      const changes = receipts.slice(0, -1);
      const caseChanges = changes.filter(change => change.decision === 'refine' && change.requiredApproval?.differences.length
        && isDeepStrictEqual(change.refine, requiredApprovalRefinement(change.requiredApproval.expected, change.requiredApproval.actual)));
      const catalogChanges = changes.filter(change => !caseChanges.includes(change));
      if (caseChanges.length > 1 || (caseChanges.length && policy.kind !== 'approve')) failures.push(`gate round ${round} case Change exceeds its single approval correction`);
      if (catalogChanges.length && (catalogChanges.length !== 1 || policy.kind !== 'approve' || !policy.onMismatch
        || catalogChanges[0].decision !== 'refine' || catalogChanges[0].expectation?.ok !== false
        || !isDeepStrictEqual(catalogChanges[0].refine, policy.onMismatch))) failures.push(`gate round ${round} conditional Change differs from catalog`);
      if (!gate) failures.push(`gate round ${round} was not exercised`);
      else if (gate.decision !== policy.kind) failures.push(`gate round ${round} decision ${gate.decision}, expected ${policy.kind}`);
      else if (policy.kind === 'refine' && gate.instruction !== policy.instruction) failures.push(`gate round ${round} refinement differs from catalog`);
    }
  }
  for (const gate of turn.gates ?? []) {
    if (gate.requiredApproval?.differences.length && (gate.decision === 'approve' || gate.decision === 'deny')) failures.push(`case approval mismatch (${gate.decision}): ${gate.requiredApproval.differences.join(', ')}`);
  }
  const expect = run.expectMetrics;
  if (expect?.rejections_max !== undefined) {
    const rejections = turn.events.filter(event => event.type === 'error' && event.recoverable).length;
    if (rejections > expect.rejections_max) failures.push(`rejections ${rejections} exceeded max ${expect.rejections_max}`);
  }
  if (!firstTurn || !expect) return failures;
  if (expect.preview_chars_min !== undefined && turn.text.length < expect.preview_chars_min) {
    failures.push(`output length ${turn.text.length} below min ${expect.preview_chars_min}`);
  }
  const lowerText = turn.text.toLowerCase();
  for (const keyword of expect.must_contain ?? []) {
    if (!lowerText.includes(keyword.toLowerCase())) failures.push(`output missing required keyword "${keyword}"`);
  }
  if (expect.sql_blocks_min !== undefined) {
    const sqlCount = (turn.text.match(/```(?:sql)?[\s\S]*?```/gi) ?? []).length;
    if (sqlCount < expect.sql_blocks_min) failures.push(`sql blocks count ${sqlCount} below min ${expect.sql_blocks_min}`);
  }
  return failures;
}

/** Verifies production-import graph integrity and reports actual SQL parser evidence without asserting a database-specific golden. */
export function databaseImportEvidence(model: DatabaseModel) {
  if (!model.nodes.length) throw new Error('Metadata import returned no objects.');
  const nodeIds = new Set(model.nodes.map(node => node.id));
  if (nodeIds.size !== model.nodes.length || model.edges.some(edge => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
    throw new Error('Imported graph has duplicate nodes or unresolved edge endpoints.');
  }
  if (model.source !== 'database' || !model.parseStats) throw new Error('Production database model build evidence is missing.');
  const scripted = model.nodes.filter(node => ['procedure', 'view', 'function'].includes(node.type));
  const readable = scripted.filter(node => !!node.bodyScript?.trim());
  return { source: model.source, platform: model.dbPlatform ?? null,
    identifierMatching: model.identifierCaseSensitive ? 'case_sensitive' : 'case_insensitive',
    columns: model.nodes.reduce((count, node) => count + (node.columns?.length ?? 0), 0),
    scriptedObjects: scripted.length, readableDefinitions: readable.length,
    sqlBodyParsing: readable.length ? 'exercised' : 'not_exercised',
    parsedReferences: model.parseStats.parsedRefs, resolvedEdges: model.parseStats.resolvedEdges,
    graphEndpoints: 'verified' };
}

/** Resolves database configuration (SQL login or Microsoft Entra ID) without provisioning a database or persisting credentials. */
export function databaseConfig(env: NodeJS.ProcessEnv) {
  for (const key of ['DB_TEST_SERVER', 'DB_TEST_DATABASE']) {
    if (!env[key]?.trim()) throw new Error(`Set ${key} for the database smoke.`);
  }
  const bool = (key: string, fallback: boolean) => {
    if (env[key] === undefined || env[key] === '') return fallback;
    return z.enum(['true', 'false']).parse(env[key]) === 'true';
  };
  const authType = env.DB_TEST_AUTH_TYPE
    ? z.enum(['sqlLogin', 'entraId']).parse(env.DB_TEST_AUTH_TYPE)
    : 'sqlLogin';

  const required = authType === 'sqlLogin' ? ['DB_TEST_USER', 'DB_TEST_PASSWORD'] : ['DB_TEST_TOKEN'];
  for (const key of required) {
    if (!env[key]?.trim()) throw new Error(`Set ${key} for the database smoke.`);
  }

  return BuiltInConnectionSchema.parse({
    id: 'headless-smoke', name: 'Headless smoke', authenticationType: authType,
    server: env.DB_TEST_SERVER, database: env.DB_TEST_DATABASE,
    ...(env.DB_TEST_USER ? { user: env.DB_TEST_USER } : {}),
    ...(env.DB_TEST_TENANT_ID ? { tenantId: env.DB_TEST_TENANT_ID } : {}),
    ...(env.DB_TEST_PORT ? { port: z.coerce.number().int().min(1).max(65535).parse(env.DB_TEST_PORT) } : {}),
    encrypt: bool('DB_TEST_ENCRYPT', true), trustServerCertificate: bool('DB_TEST_TRUST_SERVER_CERTIFICATE', false),
  });
}

const baselineArmSchema = z.object({ runDir: z.string().min(1), turns: z.array(z.number().int().positive()).min(1).optional() }).strict();
const baselineMapSchema = z.object({ cases: z.record(z.string(), z.object({ main: baselineArmSchema.optional(), previous: baselineArmSchema.optional() }).strict()) }).strict();
type BaselinePair = z.infer<typeof baselineMapSchema>['cases'][string];
/** Reads the same baseline map for launch preflight and the selected case. */
export function readBaselineMap(path: string) {
  return baselineMapSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Evidence qualification for one stored baseline; never a simulated consent policy. */
export interface BaselineApprovalReview {
  readonly source: string;
  readonly status: 'aligned' | 'different_workload' | 'unknown';
  readonly expected?: ApprovalWorkload;
  readonly actual?: ApprovalWorkload;
  readonly differences: readonly string[];
  readonly reason?: string;
  readonly approvalSequence?: readonly { readonly decision: string; readonly refine?: AiGateRefine }[];
}

/** Reads the approved workload from an existing selected baseline, before any provider call. */
export function baselineApprovalForTurn(
  runDir: string, turn: number,
  expected: { questionHash: string; questionHashPrefix: readonly string[]; fixtureHash: string; provider: string; model: string; reasoningEffort: string | null },
): BaselineApprovalReview {
  const differences = new Set<string>();
  try {
    const manifest = z.object({ provider: z.string(), turns: z.array(z.object({
      questionHash: z.string(), fixtureHash: z.string(), requestId: z.string(),
      gates: z.array(z.object({ gate: z.string(), gateId: z.string(), decision: z.enum(['approve', 'deny', 'refine']), proposalRevision: z.number().int().positive().optional(), refine: AiGateRefineSchema.optional(), approval: z.object({ actual: z.record(z.string(), z.unknown()) }).passthrough().optional() }).passthrough()).optional(),
    }).passthrough()) }).passthrough().parse(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')));
    const selected = manifest.turns[turn - 1];
    if (!selected) throw new Error('Selected baseline turn is unavailable.');
    if (selected.questionHash !== expected.questionHash) differences.add('questionHash');
    if (selected.fixtureHash !== expected.fixtureHash) differences.add('fixtureHash');
    const baselinePrefix = manifest.turns.slice(0, turn).map(entry => entry.questionHash);
    if (baselinePrefix.length !== expected.questionHashPrefix.length
      || baselinePrefix.some((hash, index) => hash !== expected.questionHashPrefix[index]))
      differences.add('questionHistory');
    if (manifest.provider !== expected.provider) differences.add('provider');
    const traces = readdirSync(join(runDir, 'lm-trace')).filter(name => name.endsWith('.ndjson'));
    if (traces.length !== 1) throw new Error('Baseline must contain one unambiguous captured trace.');
    const trace = parseTrace(readFileSync(join(runDir, 'lm-trace', traces[0]), 'utf8'));
    const requests = trace.wire.filter(e => e.type === 'provider-raw' && e.direction === 'request' && e.requestId === selected.requestId);
    if (!requests.length) throw new Error('Baseline actual provider settings are unavailable.');
    for (const request of requests) {
      if (request.type !== 'provider-raw') continue;
      const settings = z.object({ model: z.string(), reasoning_effort: z.string().optional() }).passthrough().parse(request.body);
      if (settings.model !== expected.model) differences.add('model');
      if ((settings.reasoning_effort ?? null) !== expected.reasoningEffort) differences.add('reasoningEffort');
    }
    const state = z.object({ engineInternals: z.object({
      initSnapshot: z.record(z.string(), z.unknown()).optional(), originNodeId: z.string(), excludedTypes: z.array(z.string()), excludedSchemas: z.array(z.string()),
      excludedNodeIds: z.array(z.string()), passNodeIds: z.array(z.string()),
    }).passthrough() }).passthrough().parse(JSON.parse(readFileSync(join(runDir, `turn-${turn}`, 'sm-state.json'), 'utf8')));
    const project = (start: z.output<typeof StartExplorationInputSchema>): ApprovalWorkload => {
      if (!start.origin || !start.depth || !start.classification || !start.analysisMode)
        throw new Error('Baseline lacks a complete approved workload.');
      return approvalWorkload({ classification: start.classification, init: {
        question: '', origin: start.origin, analysisMode: start.analysisMode, targetColumns: start.targetColumns ?? undefined,
        direction: directionFromDepth(start.depth), depthIntent: start.depth, excludeTypes: start.excludeTypes ?? undefined,
        excludeSchemas: start.excludeSchemas ?? undefined, excludeNodeIds: start.excludeNodeIds ?? undefined, passNodeIds: start.passNodeIds ?? undefined,
      } });
    };
    const gates = trace.gates.filter(e => e.requestId === selected.requestId && e.phase === 'confirm_sm_start');
    const receipts = selected.gates?.filter(gate => gate.gate === 'confirm_sm_start');
    const finalReceipt = receipts?.at(-1);
    if (gates.length > 1 || (finalReceipt?.proposalRevision !== undefined && finalReceipt.approval !== undefined)) {
      if (!receipts || !finalReceipt?.approval || !finalReceipt.proposalRevision || finalReceipt.decision !== 'approve'
        || receipts.length !== gates.length || receipts.some((receipt, index) => receipt.gateId !== gates[index].gateId
          || !receipt.proposalRevision || (index > 0 && receipt.proposalRevision <= receipts[index - 1].proposalRevision!)
          || (index < receipts.length - 1 && (receipt.decision !== 'refine' || !receipt.refine))))
        throw new Error('Baseline modern approval receipt is missing or inconsistent with its traced gates.');
      const finalGate = gates.at(-1)!;
      const response = trace.wire.filter(entry => entry.type === 'wire-response' && entry.requestId === selected.requestId && entry.lineIndex < finalGate.lineIndex).at(-1);
      const calls = response?.type === 'wire-response' ? response.toolCalls.filter(call => call.name === 'lineage_start_exploration') : [];
      if (calls.length !== 1 || !state.engineInternals.initSnapshot) throw new Error('Baseline modern approval lacks its consumed proposal or initial scope snapshot.');
      const authored = StartExplorationInputSchema.parse(calls[0].input);
      if (authored.proposalRevision !== undefined && finalReceipt.proposalRevision !== authored.proposalRevision + 1)
        throw new Error('Baseline modern approval revision differs from its consumed refinement.');
      if (trace.wire.some(entry => entry.type === 'wire-response' && entry.requestId === selected.requestId && entry.lineIndex > finalGate.lineIndex
        && entry.toolCalls.some(call => call.name === 'lineage_start_exploration')))
        throw new Error('Baseline scope changed after the final approval.');
      const { depthIntent, direction, ...fields } = finalReceipt.approval.actual;
      const saved = StartExplorationInputSchema.parse({ ...fields, depth: depthIntent });
      const workload = project(saved);
      const { depthIntent: snapshotDepth, direction: _snapshotDirection, ...snapshotFields } = state.engineInternals.initSnapshot;
      const snapshot = project(StartExplorationInputSchema.parse({ ...snapshotFields, classification: saved.classification, depth: snapshotDepth,
        excludeTypes: state.engineInternals.excludedTypes, excludeSchemas: state.engineInternals.excludedSchemas,
        excludeNodeIds: state.engineInternals.excludedNodeIds, passNodeIds: state.engineInternals.passNodeIds }));
      const { proposalRevision: _revision, ...authoredFields } = authored;
      if (direction !== workload.direction || !isDeepStrictEqual(workload, snapshot)
        || !isDeepStrictEqual(workload, project(StartExplorationInputSchema.parse({ ...saved, ...authoredFields }))))
        throw new Error('Baseline modern approval differs from its captured scope or consumed proposal.');
      return { source: runDir, status: differences.size ? 'different_workload' : 'aligned', expected: workload, differences: [...differences],
        approvalSequence: receipts.map(receipt => ({ decision: receipt.decision, ...(receipt.refine ? { refine: receipt.refine } : {}) })) };
    }
    // Historical traces do not retain a resolved snapshot at every refined gate. Never guess it.
    if (gates.length !== 1) throw new Error('Baseline approved workload is missing or ambiguous across gate revisions.');
    const decisions = selected.gates?.filter(gate => gate.gate === 'confirm_sm_start' && gate.gateId === gates[0].gateId);
    let approved = decisions?.length === 1 && decisions[0].decision === 'approve';
    // Legacy headless manifests omitted gate receipts. A unique timestamp-correlated host
    // decision proves this one gate; never let it override a modern refusal or ambiguous run.
    const hostPath = join(runDir, 'host.log');
    if (!approved && selected.gates === undefined && manifest.turns.length === 1 && trace.gates.length === 1
      && trace.traceOpen.length === 1 && trace.traceOpen[0].origin === 'headless-harness'
      && trace.turns.filter(entry => entry.type === 'turn-start').length === 1
      && trace.turns.some(entry => entry.type === 'turn-start' && entry.requestId === selected.requestId)
      && trace.generations.some(entry => entry.requestId === selected.requestId && entry.phase === 'active' && entry.lineIndex > gates[0].lineIndex)
      && existsSync(hostPath)) {
      const hostDecisions = [...readFileSync(hostPath, 'utf8').matchAll(/^(\S+) .*\[harness\] gate confirm_sm_start → (approve|deny|refine)(?:\s|$)/gm)];
      approved = hostDecisions.length === 1 && hostDecisions[0][2] === 'approve'
        && Date.parse(hostDecisions[0][1]) === Date.parse(gates[0].at);
    }
    if (!approved) throw new Error('Baseline gate lacks matching explicit approval evidence.');
    if (trace.wire.some(e => e.type === 'wire-response' && e.requestId === selected.requestId && e.lineIndex > gates[0].lineIndex
      && e.toolCalls.some(call => call.name === 'lineage_start_exploration')))
      throw new Error('Baseline scope changed after approval; final filters do not prove the approved contract.');
    const response = trace.wire.filter(e => e.type === 'wire-response' && e.requestId === selected.requestId && e.lineIndex < gates[0].lineIndex).at(-1);
    if (!response || response.type !== 'wire-response') throw new Error('Baseline approved proposal is unavailable.');
    const calls = response.toolCalls.filter(call => call.name === 'lineage_start_exploration');
    if (calls.length !== 1) throw new Error('Baseline gate has no unambiguous start proposal.');
    const start = StartExplorationInputSchema.parse(calls[0].input);
    if (!start.origin || !start.depth || !start.classification || !start.analysisMode || start.proposalRevision)
      throw new Error('Baseline lacks a complete fresh approved proposal.');
    const approvedWorkload = project({ ...start, origin: state.engineInternals.originNodeId,
      excludeTypes: state.engineInternals.excludedTypes, excludeSchemas: state.engineInternals.excludedSchemas,
      excludeNodeIds: state.engineInternals.excludedNodeIds, passNodeIds: state.engineInternals.passNodeIds });
    return { source: runDir, status: differences.size ? 'different_workload' : 'aligned', expected: approvedWorkload, differences: [...differences], approvalSequence: [{ decision: 'approve' }] };
  } catch (error) {
    return { source: runDir, status: 'unknown', differences: [...differences], reason: error instanceof Error ? error.message : 'Baseline evidence is unavailable.' };
  }
}

/** Runs one selected smoke; the optional observer receives its persisted result without changing execution. */
export async function main(kind: 'ai' | 'db', args: readonly string[], onResult?: (result: Readonly<Record<string, unknown>>) => void): Promise<number> {
  if (args.includes('--help')) { console.log(HELP); return 0; }
  let options: ReturnType<typeof parseOptions>;
  let runs: AiRun[] = [];
  let pairing: BaselinePair | undefined;
  let provider: { provider: string; model: string } | undefined;
  let db: ReturnType<typeof databaseConfig> | undefined;
  let langfuse: ReturnType<typeof resolveLangfuseConfig>;
  try {
    options = parseOptions(kind, args);
    if (kind === 'ai') {
      runs = aiRuns(options);
      if (!options.list && runs.length > 1 && (process.env.AI_TEST_MAIN_RUN || process.env.AI_TEST_PREVIOUS_RUN)) {
        throw new Error('Multiple catalog cases require --all --baselines FILE for per-case comparison.');
      }
      if (options.baselines && !options.list) {
        if (runs.length !== 1) throw new Error('--baselines requires --case, or use the launcher --all to run cases serially.');
        pairing = readBaselineMap(options.baselines).cases[runs[0].id] ?? {};
      }
      if (options.list) {
        console.log(JSON.stringify({ runner: 'headless', cases: runs.map(run => ({ id: run.id,
          description: run.description ?? null, turns: run.prompts.length,
          questionHashes: run.prompts.map(prompt => createHash('sha256').update(prompt).digest('hex')),
          fixture: run.dacpac, fixtureHash: createHash('sha256').update(readFileSync(run.dacpac)).digest('hex'),
        })), caseCount: runs.length, turnCount: runs.reduce((sum, run) => sum + run.prompts.length, 0),
          ...caseInventory(), otherSurfaces: 'docs/testing/INVENTORY.md', execution: 'not_run', contentVerdict: 'unreviewed' }, null, 2));
        return 0;
      }
    }
    if (kind === 'db') db = databaseConfig(process.env);
    else {
      const providerName = process.env.AI_TEST_PROVIDER?.trim();
      if (!AI_PROVIDERS.includes(providerName as typeof AI_PROVIDERS[number])) {
        throw new Error(`Set AI_TEST_PROVIDER to a hosted provider: ${AI_PROVIDERS.join(', ')}.`);
      }
      provider = {
        provider: providerName!,
        model: z.string().trim().min(1).parse(process.env.AI_TEST_MODEL),
      };
      z.string().trim().min(1).parse(process.env.AI_TEST_API_KEY);
      const endpoint = new URL(process.env.AI_TEST_ENDPOINT!);
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw new Error('AI_TEST_ENDPOINT must use HTTP(S) without embedded credentials.');
      }
    }

    langfuse = kind === 'ai' ? resolveLangfuseConfig(process.env) : null;
    if (kind === 'ai' && !langfuse) throw new Error('Set all LANGFUSE_* connection variables before an AI run.');
    if (langfuse) {
      const url = new URL(langfuse.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('LANGFUSE_BASE_URL must use HTTP(S) without embedded credentials.');
    }
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? `Invalid configuration fields: ${error.issues.map(issue => issue.path.length ? issue.path.join('.') : issue.message).join(', ')}.`
      : error instanceof TypeError ? 'Invalid service URL.' : error instanceof Error ? error.message : 'Invalid configuration.';
    console.error(`CONFIG: ${detail} Use --help and .env.example.`);
    return 4;
  }
  const runDir = repoPath('test-results', 'headless', `${kind}-${randomUUID()}`);
  mkdirSync(runDir, { recursive: true });
  const logger = createHeadlessLogger('headless', join(runDir, 'host.log'));
  setShimLogSink(line => logger.info(line));
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), options.timeoutMs);
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  const result: Record<string, unknown> = { kind, runtime: 'error', export: 'disabled', durationMs: 0, isBaseline: options.baseline };
  const started = Date.now();
  let traceWriter: AiTraceWriter | undefined;
  let tracePath: string | undefined;
  const metricManifests: string[] = [];
  const providerPorts: OpenAiCompatiblePort[] = [];
  try {
    if (db) {
      await loadHarnessParseRules();
      const outputChannel = logger as unknown as vscode.LogOutputChannel;
      const queries = await loadDmvQueries(outputChannel, Uri.file(repoPath()) as vscode.Uri);
      const token: vscode.CancellationToken = {
        get isCancellationRequested() { return controller.signal.aborted; },
        onCancellationRequested: listener => {
          controller.signal.addEventListener('abort', listener, { once: true });
          return { dispose: () => controller.signal.removeEventListener('abort', listener) };
        },
      };
      const session = await openBuiltInSession(db, {
        outputChannel, loadQueries: async () => queries,
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } as unknown as vscode.SecretStorage,
      }, { password: process.env.DB_TEST_PASSWORD, token });
      if (!session) throw new Error('Database connection cancelled.');
      if (controller.signal.aborted) { await session.dispose(); throw new Error('Database connection cancelled.'); }
      const closeOnAbort = () => { void session.dispose().catch(() => logger.error('Database session cleanup failed.')); };
      controller.signal.addEventListener('abort', closeOnAbort, { once: true });
      try {
        const previewQuery = queries.find(q => q.name === 'schema-preview');
        if (!previewQuery) throw new Error('Missing schema preview query.');
        const platformQuery = queries.find(q => q.name === 'platform-info');
        let platformInfo: import('../../src/types/database').SimpleExecuteResult | undefined;
        if (platformQuery) {
          try {
            const platform = (await executeDmvQueries(session, [platformQuery], outputChannel, undefined, Math.min(options.timeoutMs, 10_000))).get('platform-info');
            if (platform?.rows.length && validateQueryResult('platform-info', platform).length === 0) platformInfo = platform;
          } catch { logger.warn('Database platform metadata unavailable; platform and collation remain unknown.'); }
        }
        const previewResults = await executeDmvQueries(session, [previewQuery], outputChannel, undefined, options.timeoutMs);
        const preview = buildSchemaPreview(previewResults.get('schema-preview')!, platformInfo);
        if (!preview.totalObjects) throw new Error('No visible test objects; check metadata permissions.');
        const rows = await executeDmvQueriesFiltered(session, queries, preview.schemas.map(s => s.name), outputChannel, undefined, options.timeoutMs);
        for (const name of ['nodes', 'columns', 'dependencies']) {
          const value = rows.get(name);
          if (!value || validateQueryResult(name, value).length) throw new Error('Invalid metadata result.');
        }
        const model = buildModelFromDmv({
          nodes: rows.get('nodes')!, columns: rows.get('columns')!, dependencies: rows.get('dependencies')!,
          allObjects: rows.get('all-objects'), constraints: rows.get('constraints'), platformInfo,
        } satisfies DmvResults, db.database);
        result.importEvidence = databaseImportEvidence(model);
        result.platformMetadata = platformInfo ? 'captured' : 'unavailable';
        result.runtime = controller.signal.aborted ? 'cancelled' : 'ok';
        result.objects = model.nodes.length;
        result.edges = model.edges.length;
      } finally {
        controller.signal.removeEventListener('abort', closeOnAbort);
        await session.dispose();
      }
    } else {
      traceWriter = new AiTraceWriter();
      tracePath = await traceWriter.enable(runDir, { origin: 'headless-harness', verbose: options.verbose });
      const envEffort = process.env.AI_TEST_REASONING_EFFORT || process.env.AI_TEST_THINKING_LEVEL;
      const reasoningEffort: ThinkingLevel | undefined = options.effort
        ?? (envEffort ? z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'off']).parse(envEffort.toLowerCase()) : undefined);
      const { providerEndpoint, isResponsesEndpoint } = require(repoPath('tests', 'fixtures', 'lm-provider-extension', 'live-provider-adapter.js')) as {
        providerEndpoint: (endpoint: string, provider: string, model: string) => string;
        isResponsesEndpoint: (endpoint: string) => boolean;
      };
      const endpoint = providerEndpoint(process.env.AI_TEST_ENDPOINT!, provider!.provider, provider!.model);
      result.provider = provider!.provider;
      result.model = provider!.model;
      result.executionMode = options.promptFromCli ? 'cli-prompt-live' : 'catalog-live';
      result.timeoutMs = options.timeoutMs;
      result.requestTimeoutMs = options.requestTimeoutMs;
      if (reasoningEffort) result.thinkingLevel = reasoningEffort;
      result.endpoint = endpoint;
      result.cases = runs.map(run => run.id);
      result.selection = { mode: options.promptFromCli ? 'prompt' : options.caseId ? 'case' : 'all',
        plannedCases: runs.length, plannedTurns: runs.reduce((sum, run) => sum + run.prompts.length, 0) };
      result.contentVerdict = 'unreviewed';
      const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath(), encoding: 'utf8' });
      if (options.baseline && revision.status !== 0) throw new Error('--baseline needs a readable git commit.');
      const sourceDiff = spawnSync('git', ['diff', 'HEAD', '--', 'src', 'assets'], { cwd: repoPath() });
      const context = { provider: provider!.provider, model: provider!.model, reasoningEffort: reasoningEffort ?? null,
        executionMode: result.executionMode, settings: { timeoutMs: options.timeoutMs, requestTimeoutMs: options.requestTimeoutMs, temperature: null },
        promptAssets: Object.fromEntries(['src/ai/prompting/prompts.ts', 'src/ai/prompting/smPrompts.ts', 'assets/aiOutputTemplates.yaml']
          .map(file => [file, createHash('sha256').update(readFileSync(repoPath(file))).digest('hex')])),
        source: { revision: revision.status === 0 ? revision.stdout.trim() : null,
          trackedSourceDiffHash: sourceDiff.status === 0 ? createHash('sha256').update(sourceDiff.stdout).digest('hex') : null } };
      result.context = context;
      const turns: Array<{ id: string; outcome: string; modelCalls: number; failedChecks: string[]; gates: readonly import('./runTurn').HarnessGateDecision[]; baselineComparisons: readonly BaselineApprovalReview[] }> = [];
      result.turns = turns;
      let turnIndex = 0;
      let stop = false;
      for (const run of runs) {
        if (stop) break;
        const fixtureHash = createHash('sha256').update(readFileSync(run.dacpac ?? repoPath('assets', 'demo.dacpac'))).digest('hex');
        const baselineReviews = run.prompts.map((prompt, promptIndex) => {
          const questionHash = createHash('sha256').update(prompt).digest('hex');
          const arms = pairing ? Object.values(pairing) : [
            process.env.AI_TEST_MAIN_RUN ? { runDir: process.env.AI_TEST_MAIN_RUN } : undefined,
            process.env.AI_TEST_PREVIOUS_RUN ? { runDir: process.env.AI_TEST_PREVIOUS_RUN } : undefined,
          ];
          return arms.flatMap((arm): BaselineApprovalReview[] => {
            if (!arm) return [];
            const selectedTurn = 'turns' in arm && arm.turns ? arm.turns[promptIndex] : promptIndex + 1;
            const review = selectedTurn ? baselineApprovalForTurn(arm.runDir, selectedTurn, {
              questionHash, questionHashPrefix: run.prompts.slice(0, promptIndex + 1).map(question => createHash('sha256').update(question).digest('hex')),
              fixtureHash, provider: provider!.provider, model: provider!.model, reasoningEffort: reasoningEffort ?? null,
            }) : { source: arm.runDir, status: 'unknown' as const, differences: [], reason: 'Baseline turn selection does not cover the requested turn.' };
            logger.info(`[harness] baseline preflight source=${arm.runDir} status=${review.status} differences=${review.differences.join(',')}${review.reason ? ` reason=${review.reason}` : ''}`);
            return [review];
          });
        });
        result.baselinePreflight = baselineReviews;
        const { session, budget } = await createHarnessSession({ dacpacPath: run.dacpac, contextWindow: Infinity });
        const priorMessages: ModelMessage[] = [];
        result.sections ??= [...new Set(Object.values(session.outputSections).flat())];
        for (const [promptIndex, prompt] of run.prompts.entries()) {
          turnIndex += 1;
          const requestId = randomUUID();
          const questionHash = createHash('sha256').update(prompt).digest('hex');
          const expectedApproval = baselineReviews[promptIndex].find(review => review.expected)?.expected;
          const port = new OpenAiCompatiblePort({
            baseUrl: process.env.AI_TEST_ENDPOINT!, chatCompletionsUrl: endpoint, wire: isResponsesEndpoint(endpoint) ? 'responses' as const : 'chat_completions' as const, apiKey: process.env.AI_TEST_API_KEY!,
            model: provider!.model, laneId: provider!.provider, requestTimeoutMs: options.requestTimeoutMs,
            ...(provider!.provider === 'azure' ? { apiKeyHeader: 'api-key' as const } : {}),
            ...(reasoningEffort ? { requestTuning: { reasoning: { effort: reasoningEffort } } } : {}),
          }, { requestId, budget, traceVerbose: options.verbose, debugLog: message => logger.debug(message),
            wireLog: record => { void traceWriter!.write(record); } });
          providerPorts.push(port);
          const turnDir = join(runDir, `turn-${turnIndex}`);
          mkdirSync(turnDir, { recursive: true });
          const identity = { catalogId: run.id, questionHash, fixtureHash, caseIdentity: `${run.id}:${questionHash}:${fixtureHash}`, requestId };
          const manifestPath = join(turnDir, 'metrics-manifest.json');
          const manifest = { ...identity, context, tracePath, requestIds: [requestId], question: prompt, outcome: 'error',
            answerPath: join(turnDir, 'answer.md'), answerRepresentation: 'markdown',
            reportPath: join(turnDir, 'present-result.json'), reportRepresentation: 'present_result_json', finalSnapshotPath: join(turnDir, 'final-snapshot.json') };
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
          metricManifests.push(manifestPath);
          const turn = await runHarnessTurn({ session, model: port, requestId, prompt, priorMessages: [...priorMessages], gate: run.gate, expectedApproval, requiredApproval: { classification: 'business', ...run.expectMetrics?.approval }, runDir: turnDir, logger, signal: controller.signal, traceWriter });
          if (session.resultGraph) writeFileSync(manifest.finalSnapshotPath, JSON.stringify({
            nodes: session.resultGraph.nodeIds, columnEdges: session.stateMachine?.columnAspect?.edges ?? null,
          }, null, 2) + '\n');
          manifest.outcome = turn.outcome.outcome;
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
          const failedChecks = turnChecks(run, turn, promptIndex === 0);
          const actualGate = turn.gates.at(-1);
          const actual = actualGate?.approval?.actual;
          const baselineComparisons = baselineReviews[promptIndex].map((review): BaselineApprovalReview => {
            const differences = [...new Set([...review.differences, ...(review.expected && actual ? approvalWorkloadDifferences(review.expected, actual) : []),
              ...(actualGate && actualGate.decision !== 'approve' ? ['approvalDecision'] : []),
              ...(review.approvalSequence && !isDeepStrictEqual(review.approvalSequence, turn.gates.map(gate => ({ decision: gate.decision, ...(gate.refine ? { refine: gate.refine } : {}) }))) ? ['approvalSequence'] : [])])];
            return { ...review, ...(actual ? { actual } : {}), differences,
              status: !review.expected || !actual ? 'unknown' : differences.length ? 'different_workload' : 'aligned',
              ...(!actual ? { reason: 'This turn emitted no comparable approval proposal.' } : {}),
            };
          });
          for (const failure of failedChecks) logger.error(`${run.id} turn ${turnIndex}: ${failure}`);
          for (const comparison of baselineComparisons) logger.info(`[harness] baseline comparison source=${comparison.source} status=${comparison.status} differences=${comparison.differences.join(',')}`);
          turns.push({ ...identity, id: run.id, outcome: turn.outcome.outcome, modelCalls: turn.outcome.modelCalls, failedChecks, gates: turn.gates, baselineComparisons });
          const comparisons = turns.flatMap(item => item.baselineComparisons);
          result.workloadEquivalent = comparisons.some(item => item.status === 'different_workload') ? false
            : !comparisons.length || comparisons.some(item => item.status === 'unknown') ? null : true;
          const next = nextAiRunStep(turn.outcome.outcome, controller.signal.aborted);
          if (next !== 'prompt') {
            stop = next === 'stop';
            break;
          }
          priorMessages.push(modelUserMessage(nativeHarnessPrompt(prompt)), modelAssistantMessage(turn.text));
        }
      }
      result.turns = turns;
      result.unexecutedCases = runs.filter(run => !turns.some(turn => turn.id === run.id)).map(run => run.id);
      result.runtime = aiRunStatus(turns);
      result.failedChecks = turns.reduce((total, turn) => total + turn.failedChecks.length, 0);
      await traceWriter.close();
      if (langfuse && tracePath) {
        const redact = process.env.AI_TEST_API_KEY ? [process.env.AI_TEST_API_KEY] : [];
        const frozen = freezeRunEvidence(runDir, collectAttachments(runDir, tracePath, turns.length, redact),
          options.attach, [langfuse.secretKey]);
        logger.redirect(join(runDir, 'runner-diagnostics.log'));
        const frozenTrace = frozen.attachments.run!.find(file => file.name === 'event-trace')!.content;
        const attachments = frozen.isBaseline ? frozen.attachments : undefined;
        const attachmentCount = (attachments?.run?.length ?? 0) + (attachments?.turns ?? []).reduce((total, turn) => total + turn.length, 0);
        for (let attempt = 0; attempt < 2; attempt++) {
          const exportController = new AbortController();
          const exportTimeout = setTimeout(() => exportController.abort(), exportBudgetMs(attachmentCount));
          try {
            const exported = await exportRunToLangfuse(parseTrace(frozenTrace), {
              ...langfuse,
              runMetadata: { lane: provider!.provider, promptId: options.label, sessionId: options.baseline ? baselineSession(options.branch!, revision.stdout) : options.session,
                isBaseline: options.baseline, tags: [...options.tags, options.baseline ? `baseline:${options.branch}` : 'verification'] },
              attachments,
              onPayload: body => writeFileSync(join(runDir, 'langfuse-otlp.json'), body + '\n'),
              fetchImpl: (url, init) => fetch(url, { ...init, signal: exportController.signal }),
            });
            result.export = exported.errors.length ? 'error' : 'ok';
            writeFileSync(join(runDir, 'langfuse.json'), JSON.stringify(exported, null, 2) + '\n');
            result.exportedSpans = exported.exported;
            result.traceIds = exported.traceIds;
            if (!exported.errors.length) break;
          } catch { result.export = 'error'; }
          finally { clearTimeout(exportTimeout); }
        }
      } else result.export = 'error';
    }
  } catch (error) {
    const diagnostic = sanitizeProviderErrorDiagnostic(error, kind);
    const safeDiagnostic = JSON.stringify(diagnostic, (_key, value: unknown) => {
      if (typeof value !== 'string') return value;
      for (const key of ['DB_TEST_PASSWORD', 'AI_TEST_API_KEY', 'LANGFUSE_SECRET_KEY']) {
        const secret = process.env[key];
        if (secret) value = (value as string).split(secret).join('[redacted]');
      }
      return value;
    });
    logger.error(`Smoke failed: ${safeDiagnostic}`);
    result.runtime = controller.signal.aborted ? 'cancelled' : 'error';
  } finally {
    const cleanup = await Promise.allSettled(providerPorts.map(port => port.close()));
    if (cleanup.some(item => item.status === 'rejected')) {
      result.transportCleanup = 'error';
      result.runtime = 'error';
      logger.error('AI provider transport cleanup failed.');
    }
    clearTimeout(watchdog);
    process.removeListener('SIGINT', interrupt);
    await traceWriter?.close();
    for (const manifestPath of metricManifests) {
      const metrics = spawnSync(process.execPath, [repoPath('tests', 'tools', 'lineage-score.mjs'), '--trace',
        '--case-manifest', manifestPath, '--output', join(manifestPath, '..', 'metrics.json')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', shell: false,
      });
      if (metrics.status !== 0) {
        result.runtime = 'error';
        logger.error('Deterministic case metrics could not be persisted.');
      }
    }
    if (kind === 'ai' && result.runtime !== 'cancelled') {
      const recordedTurns = Array.isArray(result.turns) ? result.turns.length : 0;
      const assessment = assessCapture(runDir, tracePath, String(result.export ?? 'disabled'), recordedTurns);
      result.explorations = assessment.explorations;
      if (assessment.gaps.length) {
        result.captureGaps = assessment.gaps;
        if (result.runtime === 'ok') result.runtime = 'error';
        for (const gap of assessment.gaps) logger.error(gap);
      }
      recordBaselineScore(runDir, result, logger, pairing);
    }
    setShimLogSink(() => {});
    result.durationMs = Date.now() - started;
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(result, null, 2) + '\n');
    const completed = { ...result, artifacts: runDir };
    onResult?.(completed);
    console.log(JSON.stringify(completed));
  }
  return result.runtime === 'cancelled' ? 3 : result.runtime !== 'ok' || result.export === 'error' || Number(result.failedChecks ?? 0) > 0 ? 2 : 0;
}
