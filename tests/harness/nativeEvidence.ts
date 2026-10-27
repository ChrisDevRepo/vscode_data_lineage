/** Evidence shared by the opt-in VS Code provider and native chat checks. */
import * as assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { BASELINE_BRANCH, baselineSession, exportBudgetMs, exportRunToLangfuse, freezeRunEvidence, readFrozenRunEvidence, resolveLangfuseConfig } from './langfuseExport';
import { redactSecret } from './exportShared';
import { parseTrace } from './traceModel';

/** Copies the current extension output log from an isolated VS Code profile when available. */
export function copyNativeHostLog(profile: string | undefined, destination: string): boolean {
  if (!profile || !existsSync(join(profile, 'logs'))) return false;
  const matches: Array<{ path: string; mtime: number }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.includes('Data Lineage Viz')) matches.push({ path, mtime: statSync(path).mtimeMs });
    }
  };
  walk(join(profile, 'logs'));
  const newest = matches.sort((left, right) => right.mtime - left.mtime)[0];
  if (!newest) return false;
  mkdirSync(destination, { recursive: true });
  copyFileSync(newest.path, join(destination, existsSync(join(destination, 'evidence-snapshot.json')) ? 'runner-diagnostics.log' : 'host.log'));
  return true;
}

/** Exports saved native evidence, preserving partial receipts and rejecting incomplete captures. */
export async function exportNativeEvidence(input: {
  readonly trace: string;
  readonly directory: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly statePaths: ReadonlyMap<string, string>;
  readonly captureErrors?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = input.env ?? process.env;
  assert.ok(env.AI_TEST_BASELINE === undefined || env.AI_TEST_BASELINE === '0' || env.AI_TEST_BASELINE === '1',
    'AI_TEST_BASELINE must be 0 or 1.');
  const baseline = env.AI_TEST_BASELINE === '1';
  const branch = env.AI_TEST_BRANCH;
  assert.ok(!baseline || (branch !== undefined && BASELINE_BRANCH.test(branch)),
    'AI_TEST_BASELINE=1 requires AI_TEST_BRANCH (a plain branch name such as main or testing01).');
  assert.ok(baseline || branch === undefined, 'AI_TEST_BRANCH is only for AI_TEST_BASELINE=1.');
  let sessionId = input.sessionId;
  if (baseline) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(head.status, 0, 'A native baseline needs a readable git commit.');
    sessionId = baselineSession(branch!, head.stdout);
  }
  const config = resolveLangfuseConfig(env);
  assert.ok(config, 'Set all LANGFUSE_* connection variables before native AI model use.');
  const saved = existsSync(join(input.directory, 'evidence-snapshot.json')) ? readFrozenRunEvidence(input.directory) : undefined;
  const parsed = parseTrace(input.trace);
  const starts = parsed.turns.filter(turn => turn.type === 'turn-start');
  const errors = [...(input.captureErrors ?? [])];
  if (!parsed.traceOpen.some(row => row.verbose === true)) errors.push('Native AI verification requires verbose NDJSON.');
  for (const [index, turn] of starts.entries()) {
    if (saved ? !saved.attachments.turns?.[index]?.some(file => file.name === 'state-dump') : !input.statePaths.has(turn.requestId)) {
      errors.push(`Missing state capture for native request ${turn.requestId}.`);
    }
    if (!parsed.turns.some(row => row.type === 'turn-terminal' && row.requestId === turn.requestId)) {
      errors.push(`Missing terminal record for native request ${turn.requestId}.`);
    }
  }
  const hostPath = join(input.directory, 'host.log');
  if (saved ? !saved.attachments.run?.some(file => file.name === 'debug-log' && file.content.length > 0)
    : !existsSync(hostPath) || statSync(hostPath).size === 0) errors.push('Native AI verification requires host.log.');
  const attachments = saved?.attachments ?? {
    run: [
      { name: 'event-trace', contentType: 'text/plain' as const, content: input.trace },
      ...(existsSync(hostPath) ? [{ name: 'debug-log', contentType: 'text/plain' as const, content: readFileSync(hostPath, 'utf8') }] : []),
      ...[
        ['identity', 'metrics-manifest.json', 'application/json'],
        ['answer', 'answer.txt', 'text/plain'],
        ['result', 'report.md', 'text/markdown'],
        ['final-snapshot', 'final-snapshot.json', 'application/json'],
      ].flatMap(([name, file, contentType]) => {
        const path = join(input.directory, file);
        return existsSync(path) ? [{ name, contentType: contentType as 'application/json' | 'text/plain' | 'text/markdown',
          content: readFileSync(path, 'utf8') }] : [];
      }),
    ],
    turns: starts.map(turn => {
      const path = input.statePaths.get(turn.requestId);
      return path ? [{ name: 'state-dump', contentType: 'application/json' as const, content: readFileSync(path, 'utf8') }] : [];
    }),
    redact: env.AI_TEST_API_KEY ? [env.AI_TEST_API_KEY] : [],
  };
  const frozen = saved ?? freezeRunEvidence(input.directory, attachments, baseline, [config.secretKey]);
  assert.equal(frozen.isBaseline, baseline, 'A frozen capture cannot change baseline mode.');
  const frozenTrace = frozen.attachments.run!.find(file => file.name === 'event-trace')!.content;
  assert.equal(frozenTrace, [config.secretKey, ...(env.AI_TEST_API_KEY ? [env.AI_TEST_API_KEY] : [])]
    .reduce((text, secret) => redactSecret(text, secret), input.trace), 'Native trace differs from frozen evidence.');
  const frozenAttachments = baseline ? frozen.attachments : undefined;
  const controller = new AbortController();
  const count = (frozenAttachments?.run?.length ?? 0) * starts.length
    + (frozenAttachments?.turns ?? []).reduce((total, files) => total + files.length, 0);
  const timeout = setTimeout(() => controller.abort(), exportBudgetMs(count));
  let exported: Awaited<ReturnType<typeof exportRunToLangfuse>>;
  try {
    exported = await exportRunToLangfuse(parseTrace(frozenTrace), { ...config, attachments: frozenAttachments,
      onPayload: body => writeFileSync(join(input.directory, 'langfuse-otlp.json'), body + '\n'),
      runMetadata: { lane: 'native', promptId: input.promptId, sessionId,
        isBaseline: baseline,
        tags: [baseline ? `baseline:${branch}` : 'verification'] },
      fetchImpl: (url, init) => fetch(url, { ...init, signal: controller.signal }),
    });
  } catch {
    writeFileSync(join(input.directory, 'langfuse.json'), JSON.stringify({ status: 'error', errors: [
      ...errors, 'Native Langfuse export failed; reexport the saved capture.',
    ] }, null, 2) + '\n');
    throw new Error('Native Langfuse export failed; reexport the saved capture without rerunning the model.');
  } finally { clearTimeout(timeout); }
  errors.push(...exported.errors);
  if (!starts.length || exported.exported === 0 || new Set(exported.traceIds).size !== new Set(starts.map(turn => turn.requestId)).size) {
    errors.push('Langfuse export did not cover every observed native turn.');
  }
  writeFileSync(join(input.directory, 'langfuse.json'), JSON.stringify({ ...exported, errors,
    baseline, status: errors.length ? 'error' : 'ok' }, null, 2) + '\n');
  assert.equal(errors.length, 0, 'native evidence or Langfuse export incomplete; inspect saved capture without rerunning the model');
}
