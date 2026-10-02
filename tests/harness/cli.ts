/** Optional service runners; no question registry, scoring, campaign scheduling, or default service calls. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { exportRunToLangfuse, resolveLangfuseConfig } from './langfuseExport';
import { OpenAiCompatiblePort, type FetchLike } from './openAiCompatiblePort';
import { runHarnessTurn } from './runTurn';
import { createHarnessSession, repoPath } from './sessionFactory';
import { parseTrace } from './traceModel';
import { setShimLogSink, Uri } from './vscodeHostShim';

const DEFAULT_PROMPT = 'Summarize the loaded database and its main dependencies.';
const HELP = `Optional testing toolset (no scoring):
  npm run test:ai:headless -- [--dacpac FILE] [--prompt TEXT] [--followup TEXT ...]
                            [--timeout-ms N] [--langfuse] [--trace-verbose]
  npm run test:db:smoke -- [--timeout-ms N]
AI uses AI_TEST_* provider profiles. DB uses DB_TEST_SERVER, DB_TEST_DATABASE,
DB_TEST_USER, DB_TEST_PASSWORD, optional DB_TEST_PORT, DB_TEST_ENCRYPT and
DB_TEST_TRUST_SERVER_CERTIFICATE. Langfuse uses LANGFUSE_BASE_URL,
LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY. All services require explicit setup.
Artifacts are written only under ignored test-results/headless. AI gates are
simulated approvals; this runner does not test interactive VS Code consent.`;

/** Parses bounded runner options; rejects unknown flags before any service call. */
export function parseOptions(kind: string, args: readonly string[]) {
  let dacpac = repoPath('assets', 'demo.dacpac');
  let prompt = DEFAULT_PROMPT;
  let timeoutMs = 300_000;
  let langfuse = false;
  let verbose = false;
  const followups: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (kind === 'ai' && ['--langfuse', '--trace-verbose'].includes(flag)) {
      if (flag === '--langfuse') langfuse = true;
      else verbose = true;
      continue;
    }
    if (!(flag === '--timeout-ms' || kind === 'ai' && ['--dacpac', '--prompt', '--followup'].includes(flag))) {
      throw new Error(`Unknown option ${flag}. Use --help.`);
    }
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (flag === '--timeout-ms') timeoutMs = z.coerce.number().int().min(1).max(7_200_000).parse(value);
    if (flag === '--dacpac') dacpac = resolve(value);
    if (flag === '--prompt') prompt = value;
    if (flag === '--followup') followups.push(value);
  }
  return { dacpac, prompt, followups, timeoutMs, langfuse, verbose };
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

/** Runs one selected smoke with explicit configuration and independent runtime/export outcomes. */
export async function main(kind: 'ai' | 'db', args: readonly string[]): Promise<number> {
  if (args.includes('--help')) { console.log(HELP); return 0; }
  let options: ReturnType<typeof parseOptions>;
  let provider: { provider: string; model: string } | undefined;
  let db: ReturnType<typeof databaseConfig> | undefined;
  let langfuse: ReturnType<typeof resolveLangfuseConfig>;
  try {
    options = parseOptions(kind, args);
    if (kind === 'db') db = databaseConfig(process.env);
    else {
      provider = {
        provider: z.enum(['azure', 'fireworks', 'openrouter', 'openai-compatible']).parse(process.env.AI_TEST_PROVIDER),
        model: z.string().trim().min(1).parse(process.env.AI_TEST_MODEL),
      };
      z.string().trim().min(1).parse(process.env.AI_TEST_API_KEY);
      const endpoint = new URL(process.env.AI_TEST_ENDPOINT!);
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw new Error('AI_TEST_ENDPOINT must use HTTP(S) without embedded credentials.');
      }
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
      const { session, budget } = await createHarnessSession({ dacpacPath: options.dacpac, contextWindow: Infinity });
      const { providerEndpoint } = require(repoPath('tests', 'fixtures', 'lm-provider-extension', 'live-provider-adapter.js')) as {
        providerEndpoint: (endpoint: string, provider: string, model: string) => string;
      };
      const endpoint = providerEndpoint(process.env.AI_TEST_ENDPOINT!, provider!.provider, provider!.model);
      const fetchImpl: FetchLike = (_url, init) => fetch(endpoint, {
        ...init, body: process.env.AI_TEST_REASONING_EFFORT
          ? JSON.stringify({ ...JSON.parse(init.body), reasoning_effort: process.env.AI_TEST_REASONING_EFFORT }) : init.body,
        headers: provider!.provider === 'azure'
          ? { 'content-type': 'application/json', 'api-key': process.env.AI_TEST_API_KEY! }
          : init.headers,
      });
      const port = new OpenAiCompatiblePort({
        baseUrl: process.env.AI_TEST_ENDPOINT!, apiKey: process.env.AI_TEST_API_KEY!,
        model: provider!.model, laneId: provider!.provider, requestTimeoutMs: options.timeoutMs,
      }, { budget, fetchImpl, traceVerbose: options.verbose, wireLog: record => { void traceWriter!.write(record); } });
      result.provider = provider!.provider;
      result.model = provider!.model;
      const turns: Array<{ outcome: string; modelCalls: number }> = [];
      for (const [index, prompt] of [options.prompt, ...options.followups].entries()) {
        const turn = await runHarnessTurn({ session, model: port, prompt, runDir: join(runDir, `turn-${index + 1}`), logger, signal: controller.signal, traceWriter });
        turns.push({ outcome: turn.outcome.outcome, modelCalls: turn.outcome.modelCalls });
        if (turn.outcome.outcome !== 'ok') break;
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
