/** Optional service runners; no question registry, scoring, campaign scheduling, or default service calls. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type * as vscode from 'vscode';
import { z } from 'zod';
import { sanitizeProviderErrorDiagnostic } from '../../src/ai/support/text';
import { AiTraceWriter } from '../../src/ai/observability/aiTraceWriter';
import { parseModelEntries, type OpenAiModelEntry } from '../../src/ai/providers/modelEntries';
import { createProviderModelPort } from '../../src/ai/providers/openAiTransport';
import { RUN_TRACE_TRIGGER, expandRunTracePrompt } from '../../src/ai/prompting/prompts';
import type { AiSession } from '../../src/ai/session/session';
import { followupButtons } from '../../src/bridge/followupButtons';
import { BuiltInConnectionSchema } from '../../src/engine/db/connectionSettings';
import { openBuiltInSession } from '../../src/engine/db/builtInProvider';
import { loadDmvQueries } from '../../src/host/dbHost';
import { DEFAULT_CONFIG } from '../../src/engine/types';
import { executeDmvQueries, executeDmvQueriesFiltered } from '../../src/engine/connectionManager';
import { buildModelFromDmv, buildSchemaPreview, validateQueryResult, type DmvResults } from '../../src/engine/dmvExtractor';
import { createHeadlessLogger } from './headlessLogger';
import { exportRunToLangfuse, resolveLangfuseConfig } from './langfuseExport';
import { GateRoundSchema, type GateRoundPolicy } from './gatePolicy';
import { runHarnessTurn } from './runTurn';
import { createHarnessSession, repoPath } from './sessionFactory';
import { parseTrace } from './traceModel';
import { setShimLogSink, Uri } from './vscodeHostShim';

const DEFAULT_PROMPT = 'Summarize the loaded database and its main dependencies.';
const HELP = `Optional testing toolset (no scoring):
  npm run test:ai:headless -- [--dacpac FILE] [--prompt TEXT] [--followup TEXT|click:LABEL ...]
                            [--gate JSON] [--cards open|closed]
                            [--timeout-ms N] [--langfuse] [--trace-verbose]
  npm run test:db:smoke -- [--timeout-ms N]
AI runs one model entry on the product provider port: AI_TEST_ENDPOINT (the entry url),
AI_TEST_API_KEY, AI_TEST_MODEL, AI_TEST_API_TYPE (chat-completions|responses),
AI_TEST_MAX_INPUT_TOKENS, AI_TEST_MAX_OUTPUT_TOKENS, optional AI_TEST_REASONING_EFFORT,
AI_TEST_FORCED_TOOL_CHOICE (false sends auto) and AI_TEST_REQUEST_BODY (JSON).
DB uses DB_TEST_SERVER, DB_TEST_DATABASE, DB_TEST_USER, DB_TEST_PASSWORD, optional
DB_TEST_PORT, DB_TEST_ENCRYPT and DB_TEST_TRUST_SERVER_CERTIFICATE. Langfuse uses LANGFUSE_BASE_URL,
LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY. All services require explicit setup.
Artifacts are written only under ignored test-results/headless. AI gates are
simulated: --gate takes a JSON array of rounds, round N answering card N across the run's turns;
a card past the list is held open (run.json turns[].unansweredCard). A round is
{"kind":"approve","expect":"classification~technical","onMismatch":{"instruction":"..."}}, which
approves; a card that misses expect is answered once with the onMismatch Change, then the revised
card is approved and the miss recorded. Others: {"kind":"deny"} and
{"kind":"refine","instruction":"..."}. Without --gate every card is approved.
--cards closed (default) stops before the next --followup once a card is held open (run.json
stoppedAfterTurn, stopReason unanswered_card); --cards open continues with it.
--followup click:LABEL is the user's click on the chat panel's follow-up button LABEL: the session must
offer that button after the previous turn (else the run fails as a harness error naming the label), and
the button's prompt is sent as the panel does. Only the Run trace button ("Start deeper hop-by-hop
analysis") is supported; the other buttons take panel paths this runner does not run.
This runner does not test interactive VS Code consent.`;

/** Parses bounded runner options; rejects unknown flags before any service call. */
export function parseOptions(kind: string, args: readonly string[]) {
  let dacpac = repoPath('assets', 'demo.dacpac');
  let prompt = DEFAULT_PROMPT;
  let timeoutMs = 300_000;
  let langfuse = false;
  let verbose = false;
  let gate: GateRoundPolicy[] | undefined;
  let cards: 'open' | 'closed' = 'closed';
  const followups: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (kind === 'ai' && ['--langfuse', '--trace-verbose'].includes(flag)) {
      if (flag === '--langfuse') langfuse = true;
      else verbose = true;
      continue;
    }
    if (!(flag === '--timeout-ms' || kind === 'ai' && ['--dacpac', '--prompt', '--followup', '--gate', '--cards'].includes(flag))) {
      throw new Error(`Unknown option ${flag}. Use --help.`);
    }
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (flag === '--timeout-ms') timeoutMs = z.coerce.number().int().min(1).max(7_200_000).parse(value);
    if (flag === '--dacpac') dacpac = resolve(value);
    if (flag === '--prompt') prompt = value;
    if (flag === '--followup') followups.push(value);
    if (flag === '--cards') cards = z.enum(['open', 'closed']).parse(value);
    if (flag === '--gate') {
      try {
        gate = z.array(GateRoundSchema).parse(JSON.parse(value));
      } catch (error) {
        throw error instanceof z.ZodError ? error : new Error('--gate must be a JSON array of gate rounds.');
      }
    }
  }
  return { dacpac, prompt, followups, gate, cards, timeoutMs, langfuse, verbose };
}

/** The text a follow-up step sends: the step itself, or for `click:LABEL` the prompt of the panel button LABEL that the session offers (followupButtons), expanded as the panel's turn expands it. */
export function followupPrompt(step: string, session: AiSession): string {
  if (!step.startsWith('click:')) return step;
  const label = step.slice('click:'.length).trim();
  const button = followupButtons(session).find(candidate => candidate.label === label);
  if (!button) throw new Error(`Harness error: follow-up click "${label}" is not offered by the session.`);
  if (button.prompt !== RUN_TRACE_TRIGGER) throw new Error(`Harness error: follow-up click "${label}" is not supported by this runner.`);
  return expandRunTracePrompt(button.prompt, session);
}

/** Resolves SQL-login configuration without provisioning a database or persisting credentials. */
export function databaseConfig(env: NodeJS.ProcessEnv) {
  for (const key of ['DB_TEST_SERVER', 'DB_TEST_DATABASE', 'DB_TEST_USER', 'DB_TEST_PASSWORD']) {
    if (!env[key]?.trim()) throw new Error(`Set ${key} for the database smoke.`);
  }
  const bool = (key: string, fallback: boolean) => {
    if (env[key] === undefined || env[key] === '') return fallback;
    return z.enum(['true', 'false']).parse(env[key]) === 'true';
  };
  return BuiltInConnectionSchema.parse({
    id: 'headless-smoke', name: 'Headless smoke', authenticationType: 'sqlLogin',
    server: env.DB_TEST_SERVER, database: env.DB_TEST_DATABASE, user: env.DB_TEST_USER,
    ...(env.DB_TEST_PORT ? { port: z.coerce.number().int().min(1).max(65535).parse(env.DB_TEST_PORT) } : {}),
    encrypt: bool('DB_TEST_ENCRYPT', true), trustServerCertificate: bool('DB_TEST_TRUST_SERVER_CERTIFICATE', false),
  });
}

/**
 * The model entry the AI_TEST_* variables describe, read by the product's own entry schema (the
 * same validation `ai.models` gets). Faults name the variable, never a value.
 */
export function aiTestEntry(env: NodeJS.ProcessEnv): OpenAiModelEntry {
  const text = (key: string) => env[key]?.trim() || undefined;
  const missing = ['AI_TEST_ENDPOINT', 'AI_TEST_MODEL', 'AI_TEST_API_TYPE', 'AI_TEST_MAX_INPUT_TOKENS', 'AI_TEST_MAX_OUTPUT_TOKENS']
    .filter(key => !text(key));
  if (missing.length) throw new Error(`Set ${missing.join(', ')} for the headless AI run (npm run test:ai:headless).`);
  if (!text('AI_TEST_API_KEY')) throw new Error('Set AI_TEST_API_KEY for the headless AI run (npm run test:ai:headless).');
  const forced = text('AI_TEST_FORCED_TOOL_CHOICE');
  if (forced !== undefined && forced !== 'true' && forced !== 'false') throw new Error('AI_TEST_FORCED_TOOL_CHOICE must be true or false.');
  let requestBody: unknown;
  try {
    requestBody = text('AI_TEST_REQUEST_BODY') === undefined ? undefined : JSON.parse(text('AI_TEST_REQUEST_BODY')!);
  } catch {
    throw new Error('AI_TEST_REQUEST_BODY must be JSON.');
  }
  const { entries, invalid } = parseModelEntries([{
    id: 'headless', name: 'Headless', url: text('AI_TEST_ENDPOINT'), model: text('AI_TEST_MODEL'), apiType: text('AI_TEST_API_TYPE'),
    maxInputTokens: Number(text('AI_TEST_MAX_INPUT_TOKENS')), maxOutputTokens: Number(text('AI_TEST_MAX_OUTPUT_TOKENS')),
    ...(text('AI_TEST_REASONING_EFFORT') ? { reasoningEffort: text('AI_TEST_REASONING_EFFORT') } : {}),
    ...(forced === undefined ? {} : { forcedToolChoice: forced === 'true' }),
    ...(requestBody === undefined ? {} : { requestBody }),
  }]);
  const entry = entries.find((e): e is OpenAiModelEntry => e.apiType !== 'vscode-lm');
  if (!entry) throw new Error(`Invalid model entry: ${invalid.flatMap(entry => entry.issues).join('; ')}. Use --help.`);
  return entry;
}

/** Runs one selected smoke with explicit configuration and independent runtime/export outcomes. */
export async function main(kind: 'ai' | 'db', args: readonly string[]): Promise<number> {
  if (args.includes('--help')) { console.log(HELP); return 0; }
  let options: ReturnType<typeof parseOptions>;
  let entry: OpenAiModelEntry | undefined;
  let db: ReturnType<typeof databaseConfig> | undefined;
  let langfuse: ReturnType<typeof resolveLangfuseConfig>;
  try {
    options = parseOptions(kind, args);
    if (kind === 'db') db = databaseConfig(process.env);
    else {
      entry = aiTestEntry(process.env);
    }
    langfuse = options.langfuse ? resolveLangfuseConfig(process.env) : null;
    if (options.langfuse && !langfuse) throw new Error('Set all LANGFUSE_* connection variables for --langfuse.');
    if (langfuse) {
      const url = new URL(langfuse.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('LANGFUSE_BASE_URL must use HTTP(S) without embedded credentials.');
    }
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? `Invalid configuration fields: ${error.issues.map(issue => issue.path.join('.')).join(', ') || 'runner option'}.`
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
        queryTimeoutSeconds: () => DEFAULT_CONFIG.dmvQueryTimeout,
        promptPassword: async () => undefined,
        acquireSqlToken: async () => { throw new Error('The headless harness has no Microsoft sign-in.'); },
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
      const tracePath = await traceWriter.enable(runDir, { origin: 'headless-harness', verbose: options.verbose });
      const { session, budget } = await createHarnessSession({ dacpacPath: options.dacpac, contextWindow: entry!.maxInputTokens });
      result.model = entry!.model;
      result.apiType = entry!.apiType;
      const turns: Array<{ outcome: string; modelCalls: number; gates: unknown; unansweredCard?: true }> = [];
      let answeredCards = 0;
      for (const [index, step] of [options.prompt, ...options.followups].entries()) {
        const prompt = index === 0 ? step : followupPrompt(step, session);
        const requestId = randomUUID();
        const port = createProviderModelPort(entry!, process.env.AI_TEST_API_KEY!.trim(), {
          requestId, budget, traceVerbose: options.verbose, wireLog: record => { void traceWriter!.write(record); },
        });
        const turn = await runHarnessTurn({ session, model: port, requestId, prompt, runDir: join(runDir, `turn-${index + 1}`), logger, signal: controller.signal, traceWriter, ...(options.gate ? { gate: options.gate, gateOffset: answeredCards } : {}) });
        answeredCards += turn.gates.length;
        turns.push({ outcome: turn.outcome.outcome, modelCalls: turn.outcome.modelCalls, gates: turn.gates, ...(turn.unansweredCard ? { unansweredCard: true as const } : {}) });
        if (turn.outcome.outcome !== 'ok') break;
        if (turn.unansweredCard && options.cards === 'closed') {
          result.stoppedAfterTurn = index + 1;
          result.stopReason = 'unanswered_card';
          break;
        }
      }
      result.turns = turns;
      result.runtime = turns.at(-1)?.outcome ?? 'error';
      await traceWriter.close();
      if (langfuse) {
        const exportController = new AbortController();
        const exportTimeout = setTimeout(() => exportController.abort(), 30_000);
        try {
          const exported = await exportRunToLangfuse(parseTrace(readFileSync(tracePath, 'utf8')), {
            ...langfuse, fetchImpl: (url, init) => fetch(url, { ...init, signal: exportController.signal }),
          });
          result.export = exported.errors.length ? 'error' : 'ok';
          writeFileSync(join(runDir, 'langfuse.json'), JSON.stringify(exported, null, 2) + '\n');
          result.exportedSpans = exported.exported;
          result.traceIds = exported.traceIds;
        } catch { result.export = 'error'; } finally { clearTimeout(exportTimeout); }
      }
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
    setShimLogSink(() => {});
    result.durationMs = Date.now() - started;
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, artifacts: runDir }));
  }
  return result.runtime === 'cancelled' ? 3 : result.runtime !== 'ok' || result.export === 'error' ? 2 : 0;
}
