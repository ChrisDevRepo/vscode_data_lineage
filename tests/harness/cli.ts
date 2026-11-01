/** Optional service runner: one headless AI question against a DACPAC. */
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { sanitizeProviderErrorDiagnostic } from '../../src/ai/support/text';
import { harnessSecrets, redactSecret } from './harnessSecrets';
import { AiTraceWriter } from '../../src/ai/observability/aiTraceWriter';
import {
  createHeadlessLogger,
  type HeadlessLogChannel,
} from './headlessLogger';
import { OpenAiCompatiblePort } from './openAiCompatiblePort';
import {
  runHarnessTurn,
  nativeHarnessPrompt,
  requiredApprovalRefinement,
  type ApprovalWorkload,
  type HarnessTurnResult,
} from './runTurn';
import { createHarnessSession, repoPath } from './sessionFactory';
import { setShimLogSink } from './vscodeHostShim';
import { createRequire } from 'node:module';
import {
  providerEndpoint,
  isResponsesEndpoint,
} from '../fixtures/lm-provider-extension/live-provider-adapter.js';
import {
  modelUserMessage,
  modelAssistantMessage,
  type ModelMessage,
} from '../../src/ai/model/modelPort';

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
  };
}

/** Reads the catalog from the repository, including after this file is compiled under out/. */
function headlessCases(): CatalogCase[] {
  const loader = repoPath('tests', 'cases', 'loadCases.cjs');
  return (
    createRequire(loader)(loader) as {
      loadCases: (runner?: string) => CatalogCase[];
    }
  ).loadCases('headless');
}

/** Reasoning effort a hosted provider profile accepts. */
type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'off';

/** Hosted provider profiles the AI runner accepts. */
const AI_PROVIDERS = [
  'azure',
  'fireworks',
  'openrouter',
  'openai-compatible',
] as const;

const HELP = `Optional testing toolset; it records checks and does not grade answers:
  npm run test:ai:headless -- (--prompt TEXT [--followup TEXT ...] [--dacpac FILE] | --case ID)
                            [--effort LEVEL] [--timeout-ms N] [--request-timeout-ms N]
--prompt asks one question (default fixture assets/demo.dacpac); --followup adds ordered
follow-up turns. --case runs one headless row of tests/cases/lineage-cases.yaml and checks
every turn against the row's expect.terminal and rejections_max, and its first turn against
its gate rounds. A failed check is recorded in run.json and exits 2.
--timeout-ms bounds the entire run; --request-timeout-ms independently bounds each
provider request. AI_TEST_TIMEOUT_MS and AI_TEST_REQUEST_TIMEOUT_MS set defaults;
AI defaults to two hours with requests bounded by the same budget.
AI requires a hosted provider: AI_TEST_PROVIDER (azure, fireworks, openrouter or
openai-compatible) with its AI_TEST_ENDPOINT, AI_TEST_API_KEY and AI_TEST_MODEL. There is no
default provider.
An AI run writes a verbose NDJSON trace, host.log, and per turn answer.md and sm-state.json
(explorationOpened false when the turn opened no exploration). Nothing is uploaded.
The provider requires explicit setup. Artifacts are written only under ignored
test-results/headless. AI gates are simulated approvals; this runner does not
test interactive VS Code consent.`;

/** Configurable budget for multi-turn AI runs, including slower local providers. */
const DEFAULT_AI_TIMEOUT_MS = 7_200_000;
const testTimeoutSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(2_147_423_647, 'test timeout must be at most 2147423647');

/** Actual state establishes exploration even when the turn failed before publishing a result. */
function turnOpenedExploration(turnDir: string): boolean {
  try {
    const state = JSON.parse(
      readFileSync(join(turnDir, 'sm-state.json'), 'utf8'),
    ) as { explorationOpened?: unknown; visited?: unknown };
    if (state.explorationOpened === false) return false;
    if (Array.isArray(state.visited)) return true;
  } catch {
    /* Older captures may only retain published artifacts. */
  }
  if (existsSync(join(turnDir, 'present-result.json'))) return true;
  const snapshotPath = join(turnDir, 'final-snapshot.json');
  if (!existsSync(snapshotPath)) return false;
  try {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      nodes?: unknown;
    };
    return Array.isArray(snapshot.nodes);
  } catch {
    return true;
  }
}

/** Names missing AI-run evidence. Every turn must have a non-empty `sm-state.json`.
 * @public Also checked by the wrapping runners' tests.
 */
export function assessCapture(
  runDir: string,
  tracePath: string | undefined,
  turnCount: number,
): { gaps: string[]; explorations: Array<{ turn: number; opened: boolean }> } {
  const gaps: string[] = [];
  const explorations: Array<{ turn: number; opened: boolean }> = [];
  if (!tracePath || !existsSync(tracePath) || statSync(tracePath).size === 0)
    gaps.push('NDJSON trace is missing.');
  else {
    const first = readFileSync(tracePath, 'utf8')
      .split('\n')
      .find((line) => line.trim());
    let verbose = false;
    try {
      const record = JSON.parse(first ?? '') as {
        type?: string;
        verbose?: boolean;
      };
      verbose = record.type === 'trace-open' && record.verbose === true;
    } catch {
      verbose = false;
    }
    if (!verbose) gaps.push('Opening trace record is not verbose.');
  }
  const hostLog = join(runDir, 'host.log');
  if (!existsSync(hostLog) || statSync(hostLog).size === 0)
    gaps.push('Debug log is missing.');
  const listed = existsSync(runDir)
    ? readdirSync(runDir, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && /^turn-\d+$/.test(entry.name),
      ).length
    : 0;
  for (let turn = 1; turn <= Math.max(turnCount, listed); turn++) {
    const turnDir = join(runDir, `turn-${turn}`);
    const opened = turnOpenedExploration(turnDir);
    explorations.push({ turn, opened });
    const statePath = join(turnDir, 'sm-state.json');
    if (!existsSync(statePath) || statSync(statePath).size === 0)
      gaps.push(`Turn ${turn} has no sm-state.json.`);
  }
  return { gaps, explorations };
}

/** Parses bounded runner options; rejects unknown flags before any service call.
 * @public Also checked by the wrapping runners' tests.
 */
export function parseOptions(args: readonly string[]) {
  let dacpac = repoPath('assets', 'demo.dacpac');
  let prompt: string | undefined;
  let dacpacFromCli = false;
  let timeoutMs: number | string =
    process.env.AI_TEST_TIMEOUT_MS?.trim() || DEFAULT_AI_TIMEOUT_MS;
  let requestTimeoutMs: string | undefined =
    process.env.AI_TEST_REQUEST_TIMEOUT_MS?.trim() || undefined;
  let effort: ThinkingLevel | undefined;
  let caseId: string | undefined;
  const followups: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (
      ![
        '--timeout-ms',
        '--case',
        '--request-timeout-ms',
        '--dacpac',
        '--prompt',
        '--followup',
        '--effort',
        '--thinking',
      ].includes(flag)
    ) {
      throw new Error(`Unknown option ${flag}. Use --help.`);
    }
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--'))
      throw new Error(`${flag} requires a value.`);
    if (flag === '--timeout-ms') timeoutMs = value;
    if (flag === '--request-timeout-ms') requestTimeoutMs = value;
    if (flag === '--dacpac') {
      dacpac = resolve(value);
      dacpacFromCli = true;
    }
    if (flag === '--prompt') prompt = value;
    if (flag === '--case') {
      if (caseId) throw new Error('--case selects one catalog ID.');
      caseId = value;
    }
    if (flag === '--effort' || flag === '--thinking') {
      effort = z
        .enum(['low', 'medium', 'high', 'xhigh', 'max', 'off'])
        .parse(value.toLowerCase());
    }
    if (flag === '--followup') followups.push(value);
  }
  if ((prompt === undefined) === (caseId === undefined))
    throw new Error('Choose --prompt TEXT or --case ID.');
  if (caseId && followups.length)
    throw new Error('--followup requires --prompt.');
  return {
    dacpac,
    prompt,
    dacpacFromCli,
    caseId,
    followups,
    timeoutMs: testTimeoutSchema.parse(timeoutMs),
    requestTimeoutMs: testTimeoutSchema.parse(requestTimeoutMs ?? timeoutMs),
    effort,
  };
}

/** One AI question sequence. Catalog rows set `expectTerminal`; a `--prompt` run does not.
 * @public Passed to wrapping-runner hooks.
 */
export interface AiRun {
  readonly id: string;
  readonly description?: string;
  readonly dacpac: string;
  readonly prompts: readonly string[];
  readonly gate?: readonly import('./runTurn').GateRoundPolicy[];
  readonly expectTerminal?: string;
  readonly expectMetrics?: CatalogCase['expect'];
}

/** The selected question sequence: the `--prompt` turns, or one catalog row.
 * @public Also checked by the wrapping runners' tests.
 */
export function aiRun(options: ReturnType<typeof parseOptions>): AiRun {
  if (options.prompt !== undefined)
    return {
      id: 'cli-prompt',
      dacpac: options.dacpac,
      prompts: [options.prompt, ...options.followups],
    };
  const row = headlessCases().find((item) => item.id === options.caseId);
  if (!row) throw new Error(`Unknown headless case ${options.caseId}.`);
  if (!row.prompt?.trim()) throw new Error(`${row.id} needs a prompt.`);
  if (!row.dacpac?.trim()) throw new Error(`${row.id} needs a dacpac.`);
  if (!row.expect?.terminal?.trim())
    throw new Error(`${row.id} needs expect.terminal.`);
  if (row.expect.tokens_max !== undefined) {
    throw new Error(
      `${row.id}: expect.tokens_max is unsupported; the runner does not measure aggregate token usage.`,
    );
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
}

/** Whether the next follow-up runs: a failed, cancelled or aborted turn ends the sequence.
 * @public Also checked by the wrapping runners' tests.
 */
export function continuesAfterTurn(outcome: string, aborted: boolean): boolean {
  return outcome === 'ok' && !aborted;
}

/** The run status: a cancelled turn wins, then the first failed turn; no turn is an error.
 * @public Also checked by the wrapping runners' tests.
 */
export function aiRunStatus(turns: readonly Record<string, unknown>[]): string {
  if (turns.some((turn) => turn.outcome === 'cancelled')) return 'cancelled';
  return String(
    turns.find((turn) => turn.outcome !== 'ok')?.outcome ??
      (turns.length ? 'ok' : 'error'),
  );
}

/** Checks one finished turn against its catalog row. Terminal status and the rejection ceiling
 * apply to every turn; gate rounds apply to the first. Only measurable run facts are checked;
 * answer content is not graded here.
 * @public Also checked by the wrapping runners' tests.
 */
export function turnChecks(
  run: Pick<AiRun, 'expectTerminal' | 'expectMetrics' | 'gate'>,
  turn: {
    terminalStatus?: string | null;
    outcome: { outcome: string };
    events: ReadonlyArray<{ type: string; recoverable?: boolean }>;
    text: string;
    gates?: readonly {
      requiredApproval?: {
        expected: Partial<ApprovalWorkload>;
        actual: ApprovalWorkload;
        differences: readonly string[];
      };
      decision: string;
      instruction?: string;
      policyIndex?: number;
      expectation?: { ok: boolean };
      refine?: unknown;
    }[];
  },
  firstTurn: boolean,
): string[] {
  const failures: string[] = [];
  const actual = turn.terminalStatus ?? turn.outcome.outcome;
  if (turn.terminalStatus && turn.terminalStatus !== turn.outcome.outcome) {
    failures.push(
      `sink terminal ${turn.terminalStatus} disagrees with outcome ${turn.outcome.outcome}`,
    );
  }
  if (run.expectTerminal && actual !== run.expectTerminal)
    failures.push(`terminal ${actual}, catalog expects ${run.expectTerminal}`);
  if (firstTurn) {
    for (const [index, policy] of (run.gate ?? []).entries()) {
      const receipts =
        turn.gates?.filter(
          (gate, receiptIndex) => (gate.policyIndex ?? receiptIndex) === index,
        ) ?? [];
      const gate = receipts.at(-1);
      const round = index + 1;
      const changes = receipts.slice(0, -1);
      const caseChanges = changes.filter(
        (change) =>
          change.decision === 'refine' &&
          change.requiredApproval?.differences.length &&
          isDeepStrictEqual(
            change.refine,
            requiredApprovalRefinement(
              change.requiredApproval.expected,
              change.requiredApproval.actual,
            ),
          ),
      );
      const catalogChanges = changes.filter(
        (change) => !caseChanges.includes(change),
      );
      if (
        caseChanges.length > 1 ||
        (caseChanges.length && policy.kind !== 'approve')
      )
        failures.push(
          `gate round ${round} case Change exceeds its single approval correction`,
        );
      if (
        catalogChanges.length &&
        (catalogChanges.length !== 1 ||
          policy.kind !== 'approve' ||
          !policy.onMismatch ||
          catalogChanges[0].decision !== 'refine' ||
          catalogChanges[0].expectation?.ok !== false ||
          !isDeepStrictEqual(catalogChanges[0].refine, policy.onMismatch))
      )
        failures.push(
          `gate round ${round} conditional Change differs from catalog`,
        );
      if (!gate) failures.push(`gate round ${round} was not exercised`);
      else if (gate.decision !== policy.kind)
        failures.push(
          `gate round ${round} decision ${gate.decision}, expected ${policy.kind}`,
        );
      else if (
        policy.kind === 'refine' &&
        gate.instruction !== policy.instruction
      )
        failures.push(`gate round ${round} refinement differs from catalog`);
    }
  }
  for (const gate of turn.gates ?? []) {
    if (
      gate.requiredApproval?.differences.length &&
      (gate.decision === 'approve' || gate.decision === 'deny')
    )
      failures.push(
        `case approval mismatch (${gate.decision}): ${gate.requiredApproval.differences.join(', ')}`,
      );
  }
  const expect = run.expectMetrics;
  if (expect?.rejections_max !== undefined) {
    const rejections = turn.events.filter(
      (event) => event.type === 'error' && event.recoverable,
    ).length;
    if (rejections > expect.rejections_max)
      failures.push(
        `rejections ${rejections} exceeded max ${expect.rejections_max}`,
      );
  }
  return failures;
}

/** Extension points for a wrapping runner, for example one that compares or uploads captures; this
 * runner uses none.
 * @public
 */
export interface HeadlessHooks {
  /** Additional credential values removed from provider diagnostics. */
  readonly secrets?: readonly string[];
  /** Called after option parsing and before any service call; a throw is a configuration error
   * (exit 4).
   */
  readonly prepare?: (result: Record<string, unknown>) => void;
  /** Called once before the first turn; its observer's fields are merged into each recorded turn.
   */
  readonly observeRun?: (input: {
    readonly run: AiRun;
    readonly fixtureHash: string;
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: string | null;
    readonly result: Record<string, unknown>;
    readonly logger: HeadlessLogChannel;
  }) => (
    turn: HarnessTurnResult,
    promptIndex: number,
    turns: readonly Record<string, unknown>[],
  ) => Record<string, unknown>;
  /** Runs after the trace is closed; returned strings are capture gaps. */
  readonly afterTrace?: (input: {
    readonly runDir: string;
    readonly tracePath: string;
    readonly turnCount: number;
    readonly result: Record<string, unknown>;
    readonly revision: string;
    readonly logger: ReturnType<typeof createHeadlessLogger>;
  }) => Promise<readonly string[]>;
  /** Receives the persisted result without changing execution. */
  readonly onResult?: (result: Readonly<Record<string, unknown>>) => void;
}

/** Runs one AI question sequence; hooks let a wrapping runner add evidence without changing
 * execution.
 * @public Used by the launcher and wrapping runners.
 */
export async function main(
  kind: 'ai',
  args: readonly string[],
  hooks: HeadlessHooks = {},
): Promise<number> {
  if (args.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  let options: ReturnType<typeof parseOptions>;
  let run: AiRun;
  let provider: { provider: string; model: string };
  const result: Record<string, unknown> = {
    kind,
    runtime: 'error',
    durationMs: 0,
  };
  try {
    options = parseOptions(args);
    run = aiRun(options);
    const providerName = process.env.AI_TEST_PROVIDER?.trim();
    if (!AI_PROVIDERS.includes(providerName as (typeof AI_PROVIDERS)[number])) {
      throw new Error(
        `Set AI_TEST_PROVIDER to a hosted provider: ${AI_PROVIDERS.join(', ')}.`,
      );
    }
    provider = {
      provider: providerName!,
      model: z.string().trim().min(1).parse(process.env.AI_TEST_MODEL),
    };
    z.string().trim().min(1).parse(process.env.AI_TEST_API_KEY);
    const endpoint = new URL(process.env.AI_TEST_ENDPOINT!);
    if (
      !['https:', 'http:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new Error(
        'AI_TEST_ENDPOINT must use HTTP(S) without embedded credentials.',
      );
    }
    hooks.prepare?.(result);
  } catch (error) {
    const detail =
      error instanceof z.ZodError
        ? `Invalid configuration fields: ${error.issues.map((issue) => (issue.path.length ? issue.path.join('.') : issue.message)).join(', ')}.`
        : error instanceof TypeError
          ? 'Invalid service URL.'
          : error instanceof Error
            ? error.message
            : 'Invalid configuration.';
    console.error(`CONFIG: ${detail} Use --help and .env.example.`);
    return 4;
  }
  const runDir = repoPath(
    'test-results',
    'headless',
    `${kind}-${randomUUID()}`,
  );
  mkdirSync(runDir, { recursive: true });
  const logger = createHeadlessLogger('headless', join(runDir, 'host.log'));
  setShimLogSink((line) => logger.info(line));
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), options.timeoutMs);
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  const started = Date.now();
  let traceWriter: AiTraceWriter | undefined;
  let tracePath: string | undefined;
  let extraGaps: readonly string[] = [];
  let revisionText = '';
  const providerPorts: OpenAiCompatiblePort[] = [];
  try {
    traceWriter = new AiTraceWriter();
    tracePath = await traceWriter.enable(runDir, {
      origin: 'headless-harness',
      verbose: true,
    });
    const envEffort =
      process.env.AI_TEST_REASONING_EFFORT ||
      process.env.AI_TEST_THINKING_LEVEL;
    const reasoningEffort: ThinkingLevel | undefined =
      options.effort ??
      (envEffort
        ? z
            .enum(['low', 'medium', 'high', 'xhigh', 'max', 'off'])
            .parse(envEffort.toLowerCase())
        : undefined);
    const endpoint = providerEndpoint(
      process.env.AI_TEST_ENDPOINT!,
      provider!.provider,
      provider!.model,
    );
    result.provider = provider!.provider;
    result.model = provider!.model;
    result.executionMode =
      run.id === 'cli-prompt' ? 'cli-prompt-live' : 'catalog-live';
    result.timeoutMs = options.timeoutMs;
    result.requestTimeoutMs = options.requestTimeoutMs;
    if (reasoningEffort) result.thinkingLevel = reasoningEffort;
    result.cases = [run.id];
    result.contentVerdict = 'unreviewed';
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath(),
      encoding: 'utf8',
    });
    revisionText = revision.status === 0 ? revision.stdout : '';
    const sourceDiff = spawnSync(
      'git',
      ['diff', 'HEAD', '--', 'src', 'assets'],
      { cwd: repoPath() },
    );
    const context = {
      provider: provider!.provider,
      model: provider!.model,
      reasoningEffort: reasoningEffort ?? null,
      executionMode: result.executionMode,
      settings: {
        timeoutMs: options.timeoutMs,
        requestTimeoutMs: options.requestTimeoutMs,
        temperature: null,
      },
      promptAssets: Object.fromEntries(
        [
          'src/ai/prompting/prompts.ts',
          'src/ai/prompting/smPrompts.ts',
          'assets/aiOutputTemplates.yaml',
        ].map((file) => [
          file,
          createHash('sha256')
            .update(readFileSync(repoPath(file)))
            .digest('hex'),
        ]),
      ),
      source: {
        revision: revision.status === 0 ? revision.stdout.trim() : null,
        trackedSourceDiffHash:
          sourceDiff.status === 0
            ? createHash('sha256').update(sourceDiff.stdout).digest('hex')
            : null,
      },
    };
    result.context = context;
    const turns: Array<Record<string, unknown> & { failedChecks: string[] }> =
      [];
    result.turns = turns;
    const fixtureHash = createHash('sha256')
      .update(readFileSync(run.dacpac))
      .digest('hex');
    const observe = hooks.observeRun?.({
      run,
      fixtureHash,
      provider: provider!.provider,
      model: provider!.model,
      reasoningEffort: reasoningEffort ?? null,
      result,
      logger,
    });
    const { session, budget } = await createHarnessSession({
      dacpacPath: run.dacpac,
      contextWindow: Infinity,
    });
    const priorMessages: ModelMessage[] = [];
    result.sections = [
      ...new Set(Object.values(session.outputSections).flat()),
    ];
    for (const [promptIndex, prompt] of run.prompts.entries()) {
      const requestId = randomUUID();
      const questionHash = createHash('sha256').update(prompt).digest('hex');
      const port = new OpenAiCompatiblePort(
        {
          baseUrl: process.env.AI_TEST_ENDPOINT!,
          chatCompletionsUrl: endpoint,
          wire: isResponsesEndpoint(endpoint)
            ? ('responses' as const)
            : ('chat_completions' as const),
          apiKey: process.env.AI_TEST_API_KEY!,
          redact: [...harnessSecrets(), ...(hooks.secrets ?? [])],
          model: provider!.model,
          laneId: provider!.provider,
          requestTimeoutMs: options.requestTimeoutMs,
          ...(provider!.provider === 'azure'
            ? { apiKeyHeader: 'api-key' as const }
            : {}),
          ...(reasoningEffort
            ? { requestTuning: { reasoning: { effort: reasoningEffort } } }
            : {}),
        },
        {
          requestId,
          budget,
          traceVerbose: true,
          debugLog: (message) => logger.debug(message),
          wireLog: (record) => {
            void traceWriter!.write(record);
          },
        },
      );
      providerPorts.push(port);
      const turnDir = join(runDir, `turn-${promptIndex + 1}`);
      mkdirSync(turnDir, { recursive: true });
      const identity = {
        catalogId: run.id,
        questionHash,
        fixtureHash,
        caseIdentity: `${run.id}:${questionHash}:${fixtureHash}`,
        requestId,
      };
      const manifestPath = join(turnDir, 'metrics-manifest.json');
      const manifest = {
        ...identity,
        context,
        tracePath,
        requestIds: [requestId],
        question: prompt,
        outcome: 'error',
        answerPath: join(turnDir, 'answer.md'),
        answerRepresentation: 'markdown',
        reportPath: join(turnDir, 'present-result.json'),
        reportRepresentation: 'present_result_json',
        finalSnapshotPath: join(turnDir, 'final-snapshot.json'),
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const turn = await runHarnessTurn({
        session,
        model: port,
        requestId,
        prompt,
        priorMessages: [...priorMessages],
        gate: run.gate,
        requiredApproval: {
          classification: 'business',
          ...run.expectMetrics?.approval,
        },
        runDir: turnDir,
        logger,
        signal: controller.signal,
        traceWriter,
      });
      if (session.resultGraph)
        writeFileSync(
          manifest.finalSnapshotPath,
          JSON.stringify(
            {
              nodes: session.resultGraph.nodeIds,
              columnEdges: session.stateMachine?.columnAspect?.edges ?? null,
            },
            null,
            2,
          ) + '\n',
        );
      manifest.outcome = turn.outcome.outcome;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const failedChecks = turnChecks(run, turn, promptIndex === 0);
      for (const failure of failedChecks)
        logger.error(`${run.id} turn ${promptIndex + 1}: ${failure}`);
      turns.push({
        ...identity,
        id: run.id,
        outcome: turn.outcome.outcome,
        modelCalls: turn.outcome.modelCalls,
        failedChecks,
        gates: turn.gates,
        ...observe?.(turn, promptIndex, turns),
      });
      if (!continuesAfterTurn(turn.outcome.outcome, controller.signal.aborted))
        break;
      priorMessages.push(
        modelUserMessage(nativeHarnessPrompt(prompt)),
        modelAssistantMessage(turn.text),
      );
    }
    result.runtime = aiRunStatus(turns);
    result.failedChecks = turns.reduce(
      (total, turn) => total + turn.failedChecks.length,
      0,
    );
    await traceWriter.close();
    if (hooks.afterTrace)
      extraGaps = await hooks.afterTrace({
        runDir,
        tracePath,
        turnCount: turns.length,
        result,
        revision: revisionText,
        logger,
      });
  } catch (error) {
    const diagnostic = sanitizeProviderErrorDiagnostic(error, kind);
    const safeDiagnostic = JSON.stringify(
      diagnostic,
      (_key, value: unknown) => {
        if (typeof value !== 'string') return value;
        for (const secret of [...harnessSecrets(), ...(hooks.secrets ?? [])])
          value = redactSecret(value as string, secret);
        return value;
      },
    );
    logger.error(`Smoke failed: ${safeDiagnostic}`);
    result.runtime = controller.signal.aborted ? 'cancelled' : 'error';
  } finally {
    const cleanup = await Promise.allSettled(
      providerPorts.map((port) => port.close()),
    );
    if (cleanup.some((item) => item.status === 'rejected')) {
      result.transportCleanup = 'error';
      result.runtime = 'error';
      logger.error('AI provider transport cleanup failed.');
    }
    clearTimeout(watchdog);
    process.removeListener('SIGINT', interrupt);
    await traceWriter?.close();
    if (result.runtime !== 'cancelled') {
      const recordedTurns = Array.isArray(result.turns)
        ? result.turns.length
        : 0;
      const assessment = assessCapture(runDir, tracePath, recordedTurns);
      const gaps = [...assessment.gaps, ...extraGaps];
      result.explorations = assessment.explorations;
      if (gaps.length) {
        result.captureGaps = gaps;
        if (result.runtime === 'ok') result.runtime = 'error';
        for (const gap of gaps) logger.error(gap);
      }
    }
    setShimLogSink(() => {});
    result.durationMs = Date.now() - started;
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    const completed = { ...result, artifacts: runDir };
    hooks.onResult?.(completed);
    console.log(JSON.stringify(completed));
  }
  return result.runtime === 'cancelled'
    ? 3
    : result.runtime !== 'ok' || Number(result.failedChecks ?? 0) > 0
      ? 2
      : 0;
}
