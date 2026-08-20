/**
 * A `LogOutputChannel`-shaped logger that persists the extension host's DEBUG trail to a file.
 *
 * @remarks
 * Closes a real diagnostic gap rather than merely satisfying a type. The `[AI][Hop]`, `[CT]` and
 * `[Reject]` lines that explain WHY a turn took the shape it did are written through
 * `src/utils/log.ts` to a VS Code Output channel — an in-process buffer that dies with the window
 * and appears nowhere in the NDJSON trace. Under the harness the same lines land in
 * `<runDir>/host.log`, so a failed run is diagnosable afterwards from files alone.
 *
 * Writes are synchronous on purpose: the log's value is its ORDER relative to the crash or hang
 * being investigated, and a queued async write is exactly what is lost when the process exits hard.
 * Volume is a few thousand lines per run, so the cost is irrelevant.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The subset of `vscode.LogOutputChannel` the production logger actually calls. */
export interface HeadlessLogChannel {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  replace(value: string): void;
  clear(): void;
  show(): void;
  hide(): void;
  dispose(): void;
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string | Error, ...args: unknown[]): void;
}

function formatArgument(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A logger that throws while reporting a failure destroys the evidence it exists to keep.
    return '[unserializable]';
  }
}

/**
 * Creates a channel that appends every level to `logFilePath`.
 *
 * @param name - Channel name, recorded on each line so several channels can share one file.
 * @param logFilePath - Absolute path of the run's `host.log`; parent directories are created.
 * @returns A channel assignable to `vscode.LogOutputChannel` after one cast at the call site.
 */
export function createHeadlessLogger(name: string, logFilePath: string): HeadlessLogChannel {
  mkdirSync(dirname(logFilePath), { recursive: true });
  const write = (level: string, message: unknown, args: readonly unknown[]): void => {
    const parts = [formatArgument(message), ...args.map(formatArgument)].filter(Boolean);
    appendFileSync(
      logFilePath,
      `${new Date().toISOString()} ${level.padEnd(5)} [${name}] ${parts.join(' ')}\n`,
      'utf8',
    );
  };
  return {
    name,
    // `append` is line-oriented here: the production logger only ever appends whole lines, and
    // reconstructing partial writes would reorder them against the timestamps that make the file useful.
    append: (value) => write('info', value, []),
    appendLine: (value) => write('info', value, []),
    replace: (value) => write('info', value, []),
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
    trace: (message, ...args) => write('trace', message, args),
    debug: (message, ...args) => write('debug', message, args),
    info: (message, ...args) => write('info', message, args),
    warn: (message, ...args) => write('warn', message, args),
    error: (message, ...args) => write('error', message, args),
  };
}
