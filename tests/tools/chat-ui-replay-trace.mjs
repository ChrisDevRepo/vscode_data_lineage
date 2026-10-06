// Selects the recorded live analysis the chat-UI `badge` lane replays for its setup.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Origin of the public AdventureWorks question the live lane records. */
const REPLAY_ORIGIN = '[ai].[spimportorders]';

/** What the badge lane needs before it can run; the start of every setup error. */
export const BADGE_REPLAY_SETUP =
  'Badge acceptance needs a recorded successful public AdventureWorks AI synthesis.';

/**
 * Whether one NDJSON trace records the successful public analysis the badge lane replays: an
 * approved `[ai].[spImportOrders]` exploration with both classifications whose synthesis presented
 * a result.
 *
 * @param path - Trace file to read.
 * @returns `false` for a non-matching or unreadable (for example truncated) trace.
 */
function isSuccessfulPublicAnalysis(path) {
  let responses;
  try {
    responses = readFileSync(path, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((row) => row.type === 'wire-response');
  } catch {
    return false;
  }
  const start = responses.flatMap((row) => row.toolCalls ?? [])
    .find((call) => call.name === 'lineage_start_exploration');
  return start?.input?.origin?.toLowerCase() === REPLAY_ORIGIN && start.input.classification === 'both'
    && responses.some((row) => row.phase === 'synthesis'
      && row.toolCalls?.some((call) => call.name === 'lineage_present_result'));
}

/**
 * Finds the newest recorded trace the badge lane can replay.
 *
 * @param rootDir - Repository root, which is also the live lane's workspace; traces are read from
 * `<rootDir>/tmp/lm-trace` regardless of the process working directory.
 * @returns Absolute path of the newest qualifying `.ndjson` trace.
 * @throws Error starting with {@link BADGE_REPLAY_SETUP} when the directory is absent or holds no
 * qualifying trace; any other file-system failure is rethrown unchanged.
 */
export function findBadgeReplayTrace(rootDir) {
  const traceDir = join(rootDir, 'tmp', 'lm-trace');
  const setupError = () => new Error(
    `${BADGE_REPLAY_SETUP} Expected a successful live-lane trace under ${traceDir}; record one with `
    + '`npx vscode-test --config .vscode-test.chat-ui.mjs --label live`.',
  );
  let names;
  try {
    names = readdirSync(traceDir);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw setupError();
    throw error;
  }
  const trace = names.filter((name) => name.endsWith('.ndjson'))
    .map((name) => join(traceDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .find(isSuccessfulPublicAnalysis);
  if (!trace) throw setupError();
  return trace;
}
