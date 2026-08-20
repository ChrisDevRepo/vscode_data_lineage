/**
 * The headless live-provider harness command line: `npm run test:live-provider -- --lane … --prompt …`.
 *
 * @remarks
 * One run is one measurement of the *production* pipeline (discovery → consent gate → hops →
 * synthesis) against a real provider, in a plain Node process. This module owns only the orchestration
 * and the I/O: lane resolution, run directories, the trace writer, the port, the turn, the summary.
 * Every decision that could bias a measurement lives elsewhere and is imported, not re-implemented.
 *
 * Rules this file exists to keep:
 *
 * - **A failure is a result, not an exception.** `--runs N` performs N *independent* runs; a run that
 *   errors is summarized and the batch continues (DD-4 — no retries anywhere). The process exit code
 *   is the WORST outcome across runs, ranked `ok < cancelled < error < config`, so a batch can never
 *   report success because its last run happened to pass.
 * - **A missing lane is not a failure.** `resolveLane` self-skips (`exit 0`) on a machine without that
 *   lane's credentials, so the harness stays runnable everywhere; only a lane that IS configured, and
 *   configured wrongly, exits `4`.
 * - **Nothing prints an environment value.** Not the key, not the base URL. The banner names the
 *   variable and whether it is present, and that is the whole credential surface (DD-7).
 * - **`--fixture` is the offline proof.** It swaps only the transport for a rule table read from a
 *   tracked JSON file, so the CLI, the port, the runtime, the session and the summary all run exactly
 *   as they do on a credentialed lane, with zero network. It is how this path is proven before any
 *   real request is ever sent.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { AiTraceWriter } from '../../src/ai/observability/aiTraceWriter';
import type { WireRecord } from '../../src/ai/observability/wireLog';
import { ModelPortError } from '../../src/ai/model/modelPort';
import type { AiSession } from '../../src/ai/session/session';
import type { SmState } from '../../src/ai/sm/smTypes';
import { createHeadlessLogger, type HeadlessLogChannel } from './headlessLogger';
import { exportRunToLangfuse, resolveLangfuseConfig } from './langfuseExport';
import { isLaneId, laneEnvNames, LANE_IDS, LANES, resolveLane, type LaneId, type ResolvedLane } from './lanes';
import {
  OpenAiCompatiblePort,
  type FetchLike,
  type HttpRequestInit,
  type HttpResponseLike,
} from './openAiCompatiblePort';
import { describePrompts, resolvePrompt, type ResolvedPrompt } from './prompts';
import { buildRunSummary, type RunSummary, type SummaryLangfuse } from './runSummary';
import { runHarnessTurn } from './runTurn';
import { createHarnessSession } from './sessionFactory';
import { parseTrace, type ParsedRun } from './traceModel';
import { recordedNotifications, setShimLogSink, setShimSettings } from './vscodeHostShim';

/** Process exit codes, as the plan pins them. */
export const EXIT = {
  ok: 0,
  error: 2,
  cancelled: 3,
  config: 4,
} as const;

/** Worst-first ranking used to fold per-run exit codes into the process code. */
const EXIT_SEVERITY: Readonly<Record<number, number>> = {
  [EXIT.ok]: 0,
  [EXIT.cancelled]: 1,
  [EXIT.error]: 2,
  [EXIT.config]: 3,
};

/** Default whole-run watchdog: long enough for a 50-hop exploration, short enough to not hang a box. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Parsed command line, or the reason it could not be parsed. */
export type ParsedArgs =
  | {
      readonly ok: true;
      readonly lane: LaneId;
      readonly prompt: ResolvedPrompt;
      readonly runs: number;
      readonly traceVerbose: boolean;
      readonly langfuse: boolean;
      readonly out: string;
      readonly maxRounds?: number;
      readonly timeoutMs: number;
      readonly gate: 'approve' | 'deny';
      /**
       * Turns this lane's self-skip into exit `4`. Off by default so an uncredentialed machine can
       * still run everything; on when the caller means to MEASURE and a skip would be a false green.
       */
      readonly requireLane: boolean;
      /** Offline transport fixture; see the module note. */
      readonly fixture?: string;
      /** `--setting key=value` overrides, keyed by the full dotted `section.key`; see {@link setShimSettings}. */
      readonly settings: ReadonlyMap<string, string>;
      readonly help: boolean;
    }
  | { readonly ok: false; readonly message: string }
  | { readonly ok: 'help' };

const USAGE = `
Usage: npm run test:live-provider -- --lane <lane> [options]

  --lane <id>          ${LANE_IDS.join(' | ')}   (required)
  --prompt <id|text>   Registry id (P1-P3, T1-T7) or free text. Default: P1
  --runs <n>           Independent runs; never retries. Default: 1
  --trace-verbose      Capture system text and verbatim provider bodies in the trace
  --langfuse           Export each parsed run to Langfuse Cloud (self-skips without LANGFUSE_* env)
  --out <dir>          Root for run directories. Default: test-results/e2e
  --max-rounds <n>     Per-phase model-step ceiling handed to the runtime
  --timeout-ms <n>     Per-run watchdog. Default: ${DEFAULT_TIMEOUT_MS}
  --gate approve|deny  How every consent gate is answered. Default: approve
  --setting <k>=<v>    Inject a config value, repeatable (dataLineageViz.ai.outputTemplateFile=…)
  --require-lane       Treat this lane's self-skip as a configuration failure (exit 4)
  --list-prompts       Print the prompt registry and exit
  --help

Exit codes: 0 measured ok, 2 error, 3 cancelled, 4 configuration error.

A self-skipped lane also exits 0, and that is NOT a pass — it means no measurement was
taken. The roster and the closing line say so in words. Pass --require-lane wherever a
missing lane must fail loudly instead of reading as success.
`.trimStart();

/**
 * Parses the command line.
 *
 * @param argv - Arguments after the script name.
 * @returns The options, a help request, or a message naming the problem.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let lane: string | undefined;
  let prompt = 'P1';
  let runs = 1;
  let traceVerbose = false;
  let langfuse = false;
  let out = join('test-results', 'e2e');
  let maxRounds: number | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let gate: 'approve' | 'deny' = 'approve';
  let requireLane = false;
  let fixture: string | undefined;
  const settings = new Map<string, string>();

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };
  const positive = (raw: string, flag: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`${flag} must be a positive integer.`);
    }
    return value;
  };

  try {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      switch (arg) {
        case '--help':
        case '-h':
          return { ok: 'help' };
        case '--list-prompts':
          return { ok: 'help' };
        case '--lane':
          lane = next(i, arg);
          i += 1;
          break;
        case '--prompt':
          prompt = next(i, arg);
          i += 1;
          break;
        case '--runs':
          runs = positive(next(i, arg), arg);
          i += 1;
          break;
        case '--trace-verbose':
          traceVerbose = true;
          break;
        case '--langfuse':
          langfuse = true;
          break;
        case '--out':
          out = next(i, arg);
          i += 1;
          break;
        case '--max-rounds':
          maxRounds = positive(next(i, arg), arg);
          i += 1;
          break;
        case '--timeout-ms':
          timeoutMs = positive(next(i, arg), arg);
          i += 1;
          break;
        case '--gate': {
          const value = next(i, arg);
          if (value !== 'approve' && value !== 'deny') {
            throw new Error('--gate must be approve or deny.');
          }
          gate = value;
          i += 1;
          break;
        }
        case '--require-lane':
          requireLane = true;
          break;
        case '--fixture':
          fixture = next(i, arg);
          i += 1;
          break;
        case '--setting': {
          const raw = next(i, arg);
          const split = raw.indexOf('=');
          if (split < 0) throw new Error(`${arg} requires <key>=<value>.`);
          settings.set(raw.slice(0, split), raw.slice(split + 1));
          i += 1;
          break;
        }
        default:
          throw new Error(`Unknown argument: ${arg}`);
      }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!lane) return { ok: false, message: `--lane is required (${LANE_IDS.join(' | ')}).` };
  if (!isLaneId(lane)) {
    return { ok: false, message: `Unknown lane "${lane}". Known lanes: ${LANE_IDS.join(', ')}.` };
  }

  return {
    ok: true,
    lane,
    prompt: resolvePrompt(prompt),
    runs,
    traceVerbose,
    langfuse,
    out,
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    timeoutMs,
    gate,
    requireLane,
    ...(fixture !== undefined ? { fixture } : {}),
    settings,
    help: false,
  };
}

/** One canned exchange rule in a `--fixture` file. */
interface FixtureRule {
  readonly id?: string;
  readonly when?: {
    /** Every name must be among the tools this request offered. */
    readonly toolsInclude?: readonly string[];
    /** No name may be among them. */
    readonly toolsExclude?: readonly string[];
    /** Rule is skipped when the request body already contains this text (e.g. a spent call id). */
    readonly notInBody?: string;
  };
  readonly respond: FixtureResponse;
}

/** What a matched rule answers with. */
interface FixtureResponse {
  readonly text?: string;
  readonly toolCall?: {
    readonly callId: string;
    readonly name: string;
    /** Serialized verbatim into `function.arguments`; a string is sent as-is (malformed-args cases). */
    readonly arguments: unknown;
  };
  readonly finishReason?: string;
  readonly usage?: Record<string, number>;
  readonly status?: number;
}

interface FixtureFile {
  readonly description?: string;
  readonly rules: readonly FixtureRule[];
  readonly fallback: FixtureResponse;
}

/**
 * Builds an offline transport from a fixture file.
 *
 * @remarks
 * The rules are matched against the *offered tool set*, which is what names the pipeline phase
 * (`toolPolicy.ts`), so a fixture stays valid as long as the phase's tool set does — far more robust
 * than pinning a response to a call index, which any extra repair round would shift.
 */
function fixtureFetch(path: string): FetchLike {
  const file = JSON.parse(readFileSync(path, 'utf8')) as FixtureFile;
  return async (_url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
    const body = init.body;
    const request = JSON.parse(body) as {
      model?: string;
      tools?: ReadonlyArray<{ function?: { name?: string } }>;
    };
    const offered = (request.tools ?? []).map((tool) => tool.function?.name ?? '');
    const rule = file.rules.find((candidate) => {
      const when = candidate.when ?? {};
      if ((when.toolsInclude ?? []).some((name) => !offered.includes(name))) return false;
      if ((when.toolsExclude ?? []).some((name) => offered.includes(name))) return false;
      if (when.notInBody && body.includes(when.notInBody)) return false;
      return true;
    });
    const respond = rule?.respond ?? file.fallback;
    const status = respond.status ?? 200;
    const payload = {
      id: `fixture-${randomUUID()}`,
      object: 'chat.completion',
      model: request.model ?? 'fixture-model',
      choices: [{
        index: 0,
        finish_reason: respond.finishReason ?? (respond.toolCall ? 'tool_calls' : 'stop'),
        message: {
          role: 'assistant',
          content: respond.text ?? null,
          ...(respond.toolCall
            ? {
                tool_calls: [{
                  id: respond.toolCall.callId,
                  type: 'function',
                  function: {
                    name: respond.toolCall.name,
                    arguments: typeof respond.toolCall.arguments === 'string'
                      ? respond.toolCall.arguments
                      : JSON.stringify(respond.toolCall.arguments ?? {}),
                  },
                }],
              }
            : {}),
        },
      }],
      ...(respond.usage ? { usage: respond.usage } : {}),
    };
    const text = JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Fixture',
      text: async () => text,
    };
  };
}

/** Everything one run produced, before it is folded into the batch outcome. */
interface RunOutcome {
  readonly exitCode: number;
  readonly summary: RunSummary;
}

/**
 * Runs the whole batch.
 *
 * @param argv - Arguments after the script name.
 * @returns The process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.ok === 'help') {
    process.stdout.write(`${USAGE}\nPrompt registry:\n${describePrompts()}\n`);
    return EXIT.ok;
  }
  if (parsed.ok === false) {
    process.stderr.write(`[e2e] CONFIG ${parsed.message}\n${USAGE}`);
    return EXIT.config;
  }
  // Set before any run boots the extension host, so `vscode.workspace.getConfiguration` answers with
  // the injected values from the first `get` call onward.
  setShimSettings(parsed.settings);

  const env = { ...process.env };
  const names = laneEnvNames(parsed.lane);
  if (parsed.fixture) {
    // Offline: the lane's shape is still resolved and validated through the real loader, only the
    // two values a fixture run cannot have are substituted, so this path proves the real one.
    env[names.apiKey] = env[names.apiKey] ?? 'fixture-offline-not-a-credential';
    env[names.baseUrl] = env[names.baseUrl] ?? LANES[parsed.lane].defaultBaseUrl ?? 'https://fixture.invalid/v1';
  }

  printLaneRoster(parsed.lane, env);

  const resolution = resolveLane(parsed.lane, env);
  if (resolution.status === 'skipped') {
    // Exit 0 keeps an uncredentialed machine runnable — the documented contract — but the words
    // must not let that 0 be read as a pass. Nothing was measured, and the output says exactly that.
    process.stdout.write(
      `${resolution.message}\n`
      + `[e2e] RESULT: NO MEASUREMENT — lane ${parsed.lane} was skipped, prompt ${parsed.prompt.id} never ran.\n`
      + `[e2e]   This is not a pass. Re-run with --require-lane to make a skip exit ${EXIT.config}.\n`,
    );
    return parsed.requireLane ? EXIT.config : EXIT.ok;
  }
  if (resolution.status === 'config-error') {
    process.stderr.write(`${resolution.message}\n`);
    return EXIT.config;
  }
  for (const warning of resolution.warnings) process.stdout.write(`${warning}\n`);

  const lane = resolution.lane;
  const batchDir = resolve(
    isAbsolute(parsed.out) ? parsed.out : join(process.cwd(), parsed.out),
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${lane.laneId}`,
  );
  mkdirSync(batchDir, { recursive: true });

  process.stdout.write(
    `[e2e] lane=${lane.laneId} model=${lane.model} key=${names.apiKey}:present`
    + ` prompt=${parsed.prompt.id} runs=${parsed.runs} gate=${parsed.gate}`
    + ` verbose=${parsed.traceVerbose}${parsed.fixture ? ' transport=fixture' : ''}\n`
    + `[e2e] out=${batchDir}\n`,
  );

  const summaries: RunSummary[] = [];
  let worst: number = EXIT.ok;
  for (let index = 1; index <= parsed.runs; index += 1) {
    const runDir = join(batchDir, `run-${index}`);
    let outcome: RunOutcome;
    try {
      outcome = await executeRun({ args: parsed, lane, runDir, runIndex: index, env });
    } catch (error) {
      // A throw here is a harness or configuration defect, not a measurement: the port's constructor
      // rejects an unusable lane, and the session factory rejects an unreadable fixture asset.
      const code = error instanceof ModelPortError ? EXIT.config : EXIT.error;
      process.stderr.write(
        `[e2e] ${code === EXIT.config ? 'CONFIG' : 'ERROR'} run=${index}: `
        + `${error instanceof Error ? error.message : String(error)}\n`,
      );
      worst = worse(worst, code);
      continue;
    }
    summaries.push(outcome.summary);
    worst = worse(worst, outcome.exitCode);
    const summary = outcome.summary;
    process.stdout.write(
      `[e2e] run=${index}/${parsed.runs} outcome=${summary.outcome.status}`
      + ` exit=${outcome.exitCode} generations=${summary.generations.length}`
      + ` modelCalls=${summary.outcome.modelCalls}`
      + ` finishReasons=${summary.generations.map((g) => g.finishReason).join(',') || '-'}`
      + ` usageReportedBy=${summary.usage.reportedBy}`
      + ` rejections=${summary.tools.rejected}`
      + ` traceMalformed=${summary.trace.malformed}`
      + `${summary.langfuse ? ` langfuse=${summary.langfuse.exported}` : ''}\n`
      + `[e2e]     dir=${runDir}\n`,
    );
  }

  writeFileSync(
    join(batchDir, 'batch.json'),
    JSON.stringify({ lane: lane.laneId, model: lane.model, prompt: parsed.prompt, runs: summaries }, null, 2),
    'utf8',
  );

  printDoneSummary(lane.laneId, parsed.prompt.id, parsed.runs, summaries);
  return worst;
}

/**
 * Every configured lane, its status, and the cause.
 *
 * @remarks
 * Printed before anything else, on every invocation including a self-skip. A lane that simply never
 * appears in the output is indistinguishable from one that ran clean, so every lane states its own
 * status here. Names of variables only — never their values (DD-7).
 */
function printLaneRoster(requested: LaneId, env: NodeJS.ProcessEnv): void {
  process.stdout.write(`[e2e] LANE ROSTER (requested: ${requested})\n`);
  for (const id of LANE_IDS) {
    const probe = resolveLane(id, env);
    const state = probe.status === 'ready'
      ? 'READY'
      : probe.status === 'skipped'
        ? `SKIPPED       ${probe.reason}`
        : `CONFIG-ERROR  ${probe.message}`;
    process.stdout.write(`[e2e]  ${id === requested ? '→' : ' '} ${id.padEnd(14)} ${state}\n`);
  }
}

/**
 * Closing restatement, because the last line is the one that gets quoted.
 *
 * @remarks
 * Coverage is part of the result: which lane produced it, and which lanes this invocation says
 * nothing about.
 */
function printDoneSummary(
  laneId: LaneId,
  promptId: string,
  requestedRuns: number,
  summaries: readonly RunSummary[],
): void {
  const untouched = LANE_IDS.filter((id) => id !== laneId);
  const ok = summaries.filter((s) => s.outcome.status === 'ok').length;
  // A run that never produced a summary (the executeRun throw path) is missing, not passing, so the
  // verdict counts against the runs REQUESTED rather than against the ones that came back.
  const missing = requestedRuns - summaries.length;
  const failed = summaries.length - ok + missing;
  const verdict = failed === 0 && ok === requestedRuns ? 'OK' : 'FAILED';
  process.stdout.write(
    `[e2e] DONE lane=${laneId} prompt=${promptId}`
    + ` runs=${summaries.length}/${requestedRuns}`
    + ` ok=${ok} failed=${failed}`
    + ` | no result for: ${untouched.join(', ') || 'none'}\n`
    + `[e2e] RESULT: ${verdict} — success means every requested run reached terminal ok on this lane;`
    + ` it says nothing about any other lane.\n`,
  );
}

/**
 * Severity of an exit code, ranking an unmapped one as the worst rather than the best.
 *
 * @remarks
 * A code missing from {@link EXIT_SEVERITY} previously tied with `ok`, so a newly added failure
 * kind would have folded into a green process code — the one mistake this runner exists to prevent.
 */
function severity(code: number): number {
  return EXIT_SEVERITY[code] ?? Number.MAX_SAFE_INTEGER;
}

function worse(current: number, candidate: number): number {
  return severity(candidate) > severity(current) ? candidate : current;
}

interface ExecuteRunOptions {
  readonly args: Extract<ParsedArgs, { ok: true }>;
  readonly lane: ResolvedLane;
  readonly runDir: string;
  readonly runIndex: number;
  readonly env: Record<string, string | undefined>;
}

/** Executes one independent run and writes its `run.json`. */
async function executeRun(options: ExecuteRunOptions): Promise<RunOutcome> {
  const { args, lane, runDir, runIndex } = options;
  mkdirSync(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const requestId = randomUUID();

  const logger: HeadlessLogChannel = createHeadlessLogger('e2e', join(runDir, 'host.log'));
  // First line of every harness log. A capture from this runner has already been mistaken for a
  // live VS Code session once; the banner makes the producer unmissable without reading the path.
  logger.info(
    '[harness] RUN ORIGIN: headless test harness (npm run test:live-provider) — NOT a live VS Code/UAT session. '
    + 'The production runtime runs here as a plain Node process against a substituted model port, '
    + 'so transport behaviour (timeouts, retries, connection errors) is the harness\'s, not the shipped extension\'s.',
  );
  setShimLogSink((line) => logger.info(line));
  const notificationsBefore = recordedNotifications.length;

  const traceWriter = new AiTraceWriter((error, first) => {
    if (first) logger.error(`[harness] trace write failed: ${String(error)}`);
  });
  const tracePath = await traceWriter.enable(runDir, {
    verbose: args.traceVerbose,
    origin: 'headless-harness',
  });

  const session: AiSession = await createHarnessSession({ contextWindow: lane.contextWindow });
  const port = new OpenAiCompatiblePort(lane, {
    requestId,
    debugLog: (message) => logger.info(message),
    wireLog: (record: WireRecord) => {
      void traceWriter.write(record);
    },
    traceVerbose: args.traceVerbose,
    ...(args.fixture ? { fetchImpl: fixtureFetch(args.fixture) } : {}),
  });

  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), args.timeoutMs);
  let turn: Awaited<ReturnType<typeof runHarnessTurn>>;
  try {
    turn = await runHarnessTurn({
      session,
      model: port,
      prompt: args.prompt.text,
      runDir,
      logger,
      requestId,
      gate: args.gate,
      traceWriter,
      signal: controller.signal,
      ...(args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {}),
    });
  } finally {
    clearTimeout(watchdog);
  }
  await traceWriter.close();

  const trace = readTrace(tracePath, logger);
  const langfuse = args.langfuse
    ? await exportRunLangfuse(trace, options, lane.laneId)
    : undefined;

  const exitCode = turn.outcome.outcome === 'ok'
    ? EXIT.ok
    : turn.outcome.outcome === 'cancelled'
      ? EXIT.cancelled
      : EXIT.error;

  const summary = buildRunSummary({
    runIndex,
    runCount: args.runs,
    runDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    lane: { id: lane.laneId, model: lane.model, contextWindow: lane.contextWindow },
    prompt: {
      id: args.prompt.id,
      source: args.prompt.source,
      text: args.prompt.text,
      ...(args.prompt.expectsGraphPhase !== undefined ? { expectsGraphPhase: args.prompt.expectsGraphPhase } : {}),
    },
    gatePolicy: args.gate,
    traceVerbose: args.traceVerbose,
    outcome: turn.outcome.outcome,
    terminalStatus: turn.terminalStatus,
    modelCalls: turn.outcome.modelCalls,
    ...(turn.outcome.failure ? { failure: turn.outcome.failure } : {}),
    exitCode,
    // A "hollow" verdict (see runSummary.ts `checkHollow`) is a false-success class, never a pass —
    // it is folded in at the same severity as an ordinary run error, not treated as its own milder
    // outcome.
    hollowExitCode: EXIT.error,
    generations: port.generations,
    gates: turn.gates,
    trace,
    tracePath,
    smState: readSmState(turn.artifacts['sm-state.json'], logger),
    resultGraph: session.resultGraph,
    notifications: recordedNotifications.slice(notificationsBefore),
    artifacts: { ...turn.artifacts, 'host.log': join(runDir, 'host.log'), trace: tracePath },
    answerChars: turn.text.length,
    ...(langfuse ? { langfuse } : {}),
  });
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(summary, null, 2), 'utf8');
  // `summary.outcome.exitCode` is authoritative from here on — it is what buildRunSummary actually
  // wrote to run.json, hollow override included, so the batch's worst-outcome fold and the file on
  // disk can never disagree about whether this run passed.
  return { exitCode: summary.outcome.exitCode, summary };
}

/** Reads the run's own trace back; an unreadable trace degrades the summary, never the run. */
function readTrace(path: string, logger: HeadlessLogChannel): ParsedRun | null {
  try {
    return parseTrace(readFileSync(path, 'utf8'));
  } catch (error) {
    logger.error(`[harness] trace could not be read back: ${String(error)}`);
    return null;
  }
}

function readSmState(path: string | undefined, logger: HeadlessLogChannel): SmState | null {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SmState;
  } catch (error) {
    logger.error(`[harness] sm-state.json could not be read back: ${String(error)}`);
    return null;
  }
}

/** Exports one parsed run to Langfuse, self-skipping when the keys are not configured. */
async function exportRunLangfuse(
  trace: ParsedRun | null,
  options: ExecuteRunOptions,
  laneId: string,
): Promise<SummaryLangfuse> {
  if (!trace) return { attempted: false, skipped: 'no-trace', exported: 0, errors: [] };
  const config = resolveLangfuseConfig(options.env);
  if (!config) {
    return { attempted: false, skipped: 'missing-env:LANGFUSE_BASE_URL|LANGFUSE_PUBLIC_KEY|LANGFUSE_SECRET_KEY', exported: 0, errors: [] };
  }
  const result = await exportRunToLangfuse(trace, {
    ...config,
    runMetadata: { lane: laneId, promptId: options.args.prompt.id },
  });
  return { attempted: true, exported: result.exported, errors: result.errors };
}

