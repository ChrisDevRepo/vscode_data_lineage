/** Optional service runners. An AI run captures its trace and, when baseline directories are set, scores that capture without another model call. */
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
import { exportBudgetMs, exportRunToLangfuse, resolveLangfuseConfig, type LangfuseAttachment, type LangfuseAttachments } from './langfuseExport';
import { OpenAiCompatiblePort } from './openAiCompatiblePort';
import { runHarnessTurn, nativeHarnessPrompt } from './runTurn';
import { createHarnessSession, repoPath } from './sessionFactory';
import { parseTrace } from './traceModel';
import { setShimLogSink, Uri } from './vscodeHostShim';
import { createRequire } from 'node:module';
import { modelUserMessage, modelAssistantMessage, type ModelMessage } from '../../src/ai/model/modelPort';

interface CatalogCase {
  readonly id: string;
  readonly prompt?: string;
  readonly followup?: readonly string[];
  readonly dacpac?: string;
  readonly gate?: readonly import('./runTurn').GateRoundPolicy[];
  readonly expect?: {
    readonly terminal?: string;
    readonly tokens_max?: number;
    readonly rejections_max?: number;
    readonly preview_chars_min?: number;
    readonly must_contain?: readonly string[];
    readonly sql_blocks_min?: number;
  };
}

/** Reads the catalog from the repository, including after this file is compiled under out/. */
function headlessCases(): CatalogCase[] {
  const loader = repoPath('tests', 'cases', 'loadCases.cjs');
  return (createRequire(loader)(loader) as { loadCases: (runner?: string) => CatalogCase[] }).loadCases('headless');
}

/** Reasoning effort a hosted provider profile accepts. */
type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'off';

/** Hosted provider profiles the AI runner accepts. */
const AI_PROVIDERS = ['azure', 'fireworks', 'openrouter', 'openai-compatible'] as const;

const HELP = `Optional testing toolset; it records checks and does not grade answers:
  npm run test:ai:headless -- [--dacpac FILE] [--prompt TEXT] [--followup TEXT ...]
                            [--effort LEVEL]
                            [--timeout-ms N] [--request-timeout-ms N]
                            [--label ID] [--session ID] [--tag TEXT ...]
  npm run test:db:smoke -- [--timeout-ms N]
With no --prompt, the AI runner loops the headless rows in
tests/cases/lineage-cases.yaml. Every turn is checked against the row's expect.terminal and
rejections_max; the first answer of a row against its content checks. A failed check is
recorded in run.json and exits 2 after the trace export. Failed turns end that row's
dependent follow-ups; independent rows continue unless the run is cancelled.
--prompt runs that question instead of the catalog.
--timeout-ms bounds the entire run; --request-timeout-ms independently bounds each
provider request. AI_TEST_TIMEOUT_MS and AI_TEST_REQUEST_TIMEOUT_MS set defaults;
AI defaults to two hours with requests bounded by the same budget.
AI requires a hosted provider: AI_TEST_PROVIDER (azure, fireworks, openrouter or
openai-compatible) with its AI_TEST_ENDPOINT, AI_TEST_API_KEY and AI_TEST_MODEL. There is no
default provider.
An AI run always writes a verbose NDJSON trace, host.log, and sm-state.json when an
exploration opens, then exports those files to Langfuse. Set LANGFUSE_BASE_URL,
LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY before the first model call. --langfuse,
--trace-verbose and --attach remain accepted and do not turn that capture off.
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
      ];
    }),
  };
}

/** True when this turn published an exploration. A discovery search writes hop-log entries and still has no state dump. */
function turnOpenedExploration(turnDir: string): boolean {
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

/** Names missing AI-run evidence. `explorations` records turns that never opened an engine so the run does not invent an empty state dump. */
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
    if (opened && !existsSync(join(turnDir, 'sm-state.json'))) gaps.push(`Turn ${turn} opened an exploration without sm-state.json.`);
  }
  return { gaps, explorations };
}

/** Writes the baseline comparison for directories the operator already captured. Unset directories record that no comparison ran. */
function recordBaselineScore(runDir: string, result: Record<string, unknown>, logger: { error(message: string): void }): void {
  const previous = process.env.AI_TEST_PREVIOUS_RUN?.trim();
  const mainBaseline = process.env.AI_TEST_MAIN_RUN?.trim();
  const summaryPath = join(runDir, 'baseline-score.json');
  if (!previous && !mainBaseline) {
    writeFileSync(summaryPath, `${JSON.stringify({ compared: false, reason: 'AI_TEST_PREVIOUS_RUN and AI_TEST_MAIN_RUN are unset' }, null, 2)}\n`);
    return;
  }
  const outDir = join(runDir, 'baseline-score');
  const args = [repoPath('tests', 'tools', 'lineage-score.mjs'), runDir, '--out', outDir];
  if (previous) args.push('--previous', previous);
  if (mainBaseline) args.push('--main', mainBaseline);
  const score = spawnSync(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    shell: false,
  });
  const operational = score.status === 1;
  if (score.status !== 0 && result.runtime === 'ok') result.runtime = 'error';
  if (score.status !== 0) logger.error(operational ? 'Operational trace defect against a stored baseline.' : 'Baseline score did not complete.');
  const reportPath = join(outDir, 'score.json');
  let regressionCount: number | null = null;
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { regressions?: unknown[] };
      regressionCount = report.regressions?.length ?? null;
    } catch {
      regressionCount = null;
    }
  }
  writeFileSync(summaryPath, `${JSON.stringify({
    compared: existsSync(reportPath),
    report: 'baseline-score/score.json',
    operationalDefects: operational,
    regressionCount,
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
  let attach = kind === 'ai';
  let effort: ThinkingLevel | undefined;
  const followups: string[] = [];
  const tags: string[] = [];
  let label: string | undefined;
  let session: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (kind === 'ai' && ['--langfuse', '--trace-verbose', '--attach'].includes(flag)) {
      if (flag === '--langfuse') langfuse = true;
      else if (flag === '--attach') attach = true;
      else verbose = true;
      continue;
    }
    if (!(flag === '--timeout-ms' || kind === 'ai' && ['--request-timeout-ms', '--dacpac', '--prompt', '--followup', '--label', '--session', '--tag', '--effort', '--thinking'].includes(flag))) {
      throw new Error(`Unknown option ${flag}. Use --help.`);
    }
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (flag === '--timeout-ms') timeoutMs = value;
    if (flag === '--request-timeout-ms') requestTimeoutMs = value;
    if (flag === '--dacpac') { dacpac = resolve(value); dacpacFromCli = true; }
    if (flag === '--prompt') { prompt = value; promptFromCli = true; }
    if (flag === '--effort' || flag === '--thinking') {
      effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'off']).parse(value.toLowerCase());
    }
    if (flag === '--followup') followups.push(value);
    if (flag === '--label') label = z.string().trim().min(1).max(100).parse(value);
    if (flag === '--session') session = z.string().trim().min(1).max(190).parse(value);
    if (flag === '--tag') tags.push(z.string().trim().min(1).max(100).parse(value));
  }
  if (attach && !langfuse) throw new Error('--attach requires --langfuse.');
  return { dacpac, prompt, promptFromCli, dacpacFromCli, followups, timeoutMs: testTimeoutSchema.parse(timeoutMs), requestTimeoutMs: testTimeoutSchema.parse(requestTimeoutMs ?? timeoutMs), langfuse, verbose, label, session, tags, attach, effort };
}


/** One AI question sequence. Catalog rows set `expectTerminal`; a `--prompt` run does not. */
export interface AiRun {
  readonly id: string;
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
  const rows = headlessCases();
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
  turn: { terminalStatus?: string | null; outcome: { outcome: string }; events: ReadonlyArray<{ type: string; recoverable?: boolean }>; text: string; gates?: readonly { decision: string; instruction?: string }[] },
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
      const gate = turn.gates?.[index];
      const round = index + 1;
      if (!gate) failures.push(`gate round ${round} was not exercised`);
      else if (gate.decision !== policy.kind) failures.push(`gate round ${round} decision ${gate.decision}, expected ${policy.kind}`);
      else if (policy.kind === 'refine' && gate.instruction !== policy.instruction) failures.push(`gate round ${round} refinement differs from catalog`);
    }
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

/** Runs one selected smoke with explicit configuration and independent runtime/export outcomes. */
export async function main(kind: 'ai' | 'db', args: readonly string[]): Promise<number> {
  if (args.includes('--help')) { console.log(HELP); return 0; }
  let options: ReturnType<typeof parseOptions>;
  let runs: AiRun[] = [];
  let provider: { provider: string; model: string } | undefined;
  let db: ReturnType<typeof databaseConfig> | undefined;
  let langfuse: ReturnType<typeof resolveLangfuseConfig>;
  try {
    options = parseOptions(kind, args);
    if (kind === 'ai') runs = aiRuns(options);
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
  const result: Record<string, unknown> = { kind, runtime: 'error', export: 'disabled', durationMs: 0 };
  const started = Date.now();
  let traceWriter: AiTraceWriter | undefined;
  let tracePath: string | undefined;
  const metricManifests: string[] = [];
  try {
    if (db) {
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
        const previewResults = await executeDmvQueries(session, [previewQuery], outputChannel, undefined, options.timeoutMs);
        const preview = buildSchemaPreview(previewResults.get('schema-preview')!);
        if (!preview.totalObjects) throw new Error('No visible test objects; check metadata permissions.');
        const rows = await executeDmvQueriesFiltered(session, queries, preview.schemas.map(s => s.name), outputChannel, undefined, options.timeoutMs);
        for (const name of ['nodes', 'columns', 'dependencies']) {
          const value = rows.get(name);
          if (!value || validateQueryResult(name, value).length) throw new Error('Invalid metadata result.');
        }
        const model = buildModelFromDmv({
          nodes: rows.get('nodes')!, columns: rows.get('columns')!, dependencies: rows.get('dependencies')!,
          allObjects: rows.get('all-objects'), constraints: rows.get('constraints'),
        } satisfies DmvResults, db.database);
        if (!model.nodes.length) throw new Error('Metadata import returned no objects.');
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
      const { providerEndpoint } = require(repoPath('tests', 'fixtures', 'lm-provider-extension', 'live-provider-adapter.js')) as {
        providerEndpoint: (endpoint: string, provider: string, model: string) => string;
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
      const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath(), encoding: 'utf8' });
      const sourceDiff = spawnSync('git', ['diff', 'HEAD', '--', 'src', 'assets'], { cwd: repoPath() });
      const context = { provider: provider!.provider, model: provider!.model, reasoningEffort: reasoningEffort ?? null,
        executionMode: result.executionMode, settings: { timeoutMs: options.timeoutMs, requestTimeoutMs: options.requestTimeoutMs, temperature: null },
        promptAssets: Object.fromEntries(['src/ai/prompting/prompts.ts', 'src/ai/prompting/smPrompts.ts', 'assets/aiOutputTemplates.yaml']
          .map(file => [file, createHash('sha256').update(readFileSync(repoPath(file))).digest('hex')])),
        source: { revision: revision.status === 0 ? revision.stdout.trim() : null,
          trackedSourceDiffHash: sourceDiff.status === 0 ? createHash('sha256').update(sourceDiff.stdout).digest('hex') : null } };
      result.context = context;
      const turns: Array<{ id: string; outcome: string; modelCalls: number; failedChecks: string[]; gates: readonly import('./runTurn').HarnessGateDecision[] }> = [];
      result.turns = turns;
      let turnIndex = 0;
      let stop = false;
      for (const run of runs) {
        if (stop) break;
        const { session, budget } = await createHarnessSession({ dacpacPath: run.dacpac, contextWindow: Infinity });
        const fixtureHash = createHash('sha256').update(readFileSync(run.dacpac ?? repoPath('assets', 'demo.dacpac'))).digest('hex');
        const priorMessages: ModelMessage[] = [];
        result.sections ??= [...new Set(Object.values(session.outputSections).flat())];
        for (const [promptIndex, prompt] of run.prompts.entries()) {
          turnIndex += 1;
          const requestId = randomUUID();
          const port = new OpenAiCompatiblePort({
            baseUrl: process.env.AI_TEST_ENDPOINT!, chatCompletionsUrl: endpoint, apiKey: process.env.AI_TEST_API_KEY!,
            model: provider!.model, laneId: provider!.provider, requestTimeoutMs: options.requestTimeoutMs,
            ...(provider!.provider === 'azure' ? { apiKeyHeader: 'api-key' as const } : {}),
            ...(reasoningEffort ? { requestTuning: { reasoning: { effort: reasoningEffort } } } : {}),
          }, { requestId, budget, traceVerbose: options.verbose, debugLog: message => logger.debug(message),
            wireLog: record => { void traceWriter!.write(record); } });
          const turnDir = join(runDir, `turn-${turnIndex}`);
          mkdirSync(turnDir, { recursive: true });
          const questionHash = createHash('sha256').update(prompt).digest('hex');
          const identity = { catalogId: run.id, questionHash, fixtureHash, caseIdentity: `${run.id}:${questionHash}:${fixtureHash}`, requestId };
          const manifestPath = join(turnDir, 'metrics-manifest.json');
          const manifest = { ...identity, context, tracePath, requestIds: [requestId], question: prompt, outcome: 'error',
            answerPath: join(turnDir, 'answer.md'), answerRepresentation: 'markdown',
            reportPath: join(turnDir, 'present-result.json'), reportRepresentation: 'present_result_json', finalSnapshotPath: join(turnDir, 'final-snapshot.json') };
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
          metricManifests.push(manifestPath);
          const turn = await runHarnessTurn({ session, model: port, requestId, prompt, priorMessages: [...priorMessages], gate: run.gate, runDir: turnDir, logger, signal: controller.signal, traceWriter });
          if (session.resultGraph) writeFileSync(manifest.finalSnapshotPath, JSON.stringify({
            nodes: session.resultGraph.nodeIds, columnEdges: session.stateMachine?.columnAspect?.edges ?? null,
          }, null, 2) + '\n');
          manifest.outcome = turn.outcome.outcome;
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
          const failedChecks = turnChecks(run, turn, promptIndex === 0);
          for (const failure of failedChecks) logger.error(`${run.id} turn ${turnIndex}: ${failure}`);
          turns.push({ ...identity, id: run.id, outcome: turn.outcome.outcome, modelCalls: turn.outcome.modelCalls, failedChecks, gates: turn.gates });
          const next = nextAiRunStep(turn.outcome.outcome, controller.signal.aborted);
          if (next !== 'prompt') {
            stop = next === 'stop';
            break;
          }
          priorMessages.push(modelUserMessage(nativeHarnessPrompt(prompt)), modelAssistantMessage(turn.text));
        }
      }
      result.turns = turns;
      result.runtime = aiRunStatus(turns);
      result.failedChecks = turns.reduce((total, turn) => total + turn.failedChecks.length, 0);
      await traceWriter.close();
      if (langfuse && tracePath) {
        const exportController = new AbortController();
        const redact = process.env.AI_TEST_API_KEY ? [process.env.AI_TEST_API_KEY] : [];
        const attachments = collectAttachments(runDir, tracePath, turns.length, redact);
        const attachmentCount = (attachments.run?.length ?? 0) + (attachments.turns ?? []).reduce((total, turn) => total + turn.length, 0);
        const exportTimeout = setTimeout(() => exportController.abort(), exportBudgetMs(attachmentCount));
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const exported = await exportRunToLangfuse(parseTrace(readFileSync(tracePath, 'utf8')), {
                ...langfuse,
                runMetadata: { lane: provider!.provider, promptId: options.label, sessionId: options.session, tags: options.tags },
                attachments,
                fetchImpl: (url, init) => fetch(url, { ...init, signal: exportController.signal }),
              });
              result.export = exported.errors.length ? 'error' : 'ok';
              writeFileSync(join(runDir, 'langfuse.json'), JSON.stringify(exported, null, 2) + '\n');
              result.exportedSpans = exported.exported;
              result.traceIds = exported.traceIds;
              if (!exported.errors.length) break;
            } catch { result.export = 'error'; }
          }
        } finally { clearTimeout(exportTimeout); }
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
    clearTimeout(watchdog);
    process.removeListener('SIGINT', interrupt);
    await traceWriter?.close();
    for (const manifestPath of metricManifests) {
      const metrics = spawnSync(process.execPath, [repoPath('tests', 'tools', 'trace-metrics.mjs'),
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
      recordBaselineScore(runDir, result, logger);
    }
    setShimLogSink(() => {});
    result.durationMs = Date.now() - started;
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, artifacts: runDir }));
  }
  return result.runtime === 'cancelled' ? 3 : result.runtime !== 'ok' || result.export === 'error' || Number(result.failedChecks ?? 0) > 0 ? 2 : 0;
}
