/** Fail-closed VS Code host substitute for explicitly invoked headless checks. */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

/** Thrown when production code reaches a `vscode` member the headless harness does not implement. */
export class HarnessShimError extends Error {
  public constructor(member: string) {
    super(
      `vscode.${member} is not implemented by the headless harness shim (tests/harness/vscodeHostShim.ts). `
      + 'A real extension host supplies it; either add a faithful implementation or keep this path out '
      + 'of the harness lane — never let it resolve to undefined.',
    );
    this.name = 'HarnessShimError';
  }
}

/** One notification production code raised during the run. */
export interface RecordedNotification {
  readonly severity: 'error' | 'warning' | 'information';
  readonly message: string;
}

/** Every notification raised during the run, in order — a run-summary input, not a UI surface. */
export const recordedNotifications: RecordedNotification[] = [];

let logSink: (line: string) => void = () => {};
let injectedSettings: ReadonlyMap<string, string> = new Map();

/**
 * Injects setting values for {@link getConfiguration} to answer with instead of the caller's default.
 *
 * @remarks
 * Opt-in per key: a key absent from `settings` still falls through to the caller's default verbatim,
 * so an A/B run that injects nothing behaves byte-identically to today's shim.
 * @param settings - Values keyed by the full dotted `section.key`, e.g.
 * `dataLineageViz.ai.outputTemplateFile`.
 */
export function setShimSettings(settings: ReadonlyMap<string, string>): void {
  injectedSettings = new Map(settings);
}

/**
 * Routes shim-observed activity (notifications, ad-hoc output channels) into the run's `host.log`.
 *
 * @remarks
 * Set by the harness once the run directory exists. Until then the sink is a no-op rather than
 * `console`, so importing the shim never writes anywhere on its own.
 */
export function setShimLogSink(sink: (line: string) => void): void {
  logSink = sink;
}

/** Configuration section that answers with the caller's declared default and never invents a value. */
export function getConfiguration(section?: string): Record<string, unknown> {
  const qualify = (key: string): string => (section ? `${section}.${key}` : key);
  return {
    get: (key: string, defaultValue?: unknown): unknown => {
      const qualified = qualify(key);
      return injectedSettings.has(qualified) ? injectedSettings.get(qualified) : defaultValue;
    },
    has: (): boolean => false,
    inspect: (): undefined => undefined,
    update: (key: string): never => {
      throw new HarnessShimError(`workspace.getConfiguration().update('${qualify(key)}')`);
    },
  };
}

/** Minimal `Uri`: path joining and `fsPath`, with no scheme handling beyond `file`. */
class HarnessUri {
  private constructor(
    public readonly scheme: string,
    public readonly fsPath: string,
  ) {}

  public static file(path: string): HarnessUri {
    return new HarnessUri('file', path);
  }

  public static joinPath(base: HarnessUri, ...segments: string[]): HarnessUri {
    // Platform `join`, not the POSIX one: the harness targets Windows and macOS dev boxes and
    // `fsPath` has to stay directly usable with `node:fs`.
    return new HarnessUri(base.scheme, join(base.fsPath, ...segments));
  }

  public toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

function record(severity: RecordedNotification['severity']) {
  return (message: string): Promise<undefined> => {
    recordedNotifications.push({ severity, message });
    logSink(`[shim] ${severity}: ${message}`);
    return Promise.resolve(undefined);
  };
}

/** Ad-hoc channel for production code that creates its own; every level lands in the run log. */
function createOutputChannel(name: string): Record<string, unknown> {
  const write = (level: string) => (message: string): void => { logSink(`[${name}] ${level} ${message}`); };
  return {
    name,
    logLevel: 1,
    onDidChangeLogLevel: () => ({ dispose: () => {} }),
    append: write('append'),
    appendLine: write('append'),
    replace: write('replace'),
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

/** File URIs supplied by the headless runner to production asset loaders. */
export const Uri = HarnessUri;

const implemented: Record<string, unknown> = {
  // `__importStar` returns the module untouched when this is set, which is what keeps the proxy —
  // and therefore the loud-failure guarantee — intact through TypeScript's interop helper.
  __esModule: true,
  HarnessShimError,
  recordedNotifications,
  setShimLogSink,
  setShimSettings,
  Uri: HarnessUri,
  workspace: {
    getConfiguration,
    workspaceFolders: undefined,
    fs: { readFile: (uri: HarnessUri) => readFile(uri.fsPath) },
  },
  window: {
    showErrorMessage: record('error'),
    showWarningMessage: record('warning'),
    showInformationMessage: record('information'),
    createOutputChannel,
  },
};

/**
 * The module object the `vscode` alias resolves to.
 *
 * @remarks
 * Assigned over `module.exports` rather than declared with `export =` so this file can keep its own
 * named exports for harness callers while still handing `require('vscode')` a proxy. Plain named
 * exports alone would answer `undefined` for every unimplemented member, which is exactly the silent
 * gap Phase 0 exists to eliminate.
 */
module.exports = new Proxy(implemented, {
  get: (target, property): unknown => {
    if (typeof property === 'string' && !(property in target)) throw new HarnessShimError(property);
    return target[property as string];
  },
});
