/**
 * The connect of the built-in provider. Azure SQL answers the first login to a paused serverless
 * database with transient error 40613 and takes "generally about one minute to auto-resume"
 * (https://learn.microsoft.com/azure/azure-sql/database/serverless-tier-auto-pause-resume), so the
 * driver keeps retrying for that long, at the 5 s minimum interval or more
 * (https://learn.microsoft.com/azure/azure-sql/database/troubleshoot-common-connectivity-issues).
 * The driver documents no abort for a pending connect; `close()` is the only primitive (in tedious
 * it ends the retry wait and attempts), so Cancel calls it and ignores the late result.
 */

import { describe, expect, it, vi } from 'vitest';

const driver: {
  options?: Record<string, unknown>;
  finish?: (err?: Error) => void;
  closed: number;
} = { closed: 0 };

vi.mock('tedious', () => ({
  Connection: class {
    constructor(config: { options: Record<string, unknown> }) { driver.options = config.options; driver.closed = 0; }
    connect(callback: (err?: Error) => void) { driver.finish = callback; }
    on() { return this; }
    close() { driver.closed += 1; }
  },
}));
vi.mock('../../../src/engine/db/entraSignIn', () => ({ acquireSqlToken: async () => 'token' }));

import { openBuiltInSession } from '../../../src/engine/db/builtInProvider';

const MICROSOFT_RESUME_WINDOW_MS = 60_000;
const logger = { info() {}, debug() {}, warn() {}, error() {} };
const env = { secrets: {}, outputChannel: logger, loadQueries: async () => [] } as never;
const entra = { id: 'c1', server: 'x.database.windows.net', authenticationType: 'entraId', database: 'db' } as never;

/** Lets the open reach the pending driver connect. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function cancellable() {
  let cancel: () => void = () => {};
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => { cancel = () => { token.isCancellationRequested = true; listener(); }; return { dispose() {} }; },
  };
  return { token: token as never, cancel: () => cancel() };
}

describe('openBuiltInSession connect', () => {
  it('retries transient Azure errors for at least the serverless resume time', async () => {
    const open = openBuiltInSession(entra, env);
    await settle();
    driver.finish?.();
    await open;
    const interval = driver.options?.connectionRetryInterval as number;
    const retries = driver.options?.maxRetriesOnTransientErrors as number;
    expect(interval).toBeGreaterThanOrEqual(5000);
    expect(interval * retries).toBeGreaterThanOrEqual(MICROSOFT_RESUME_WINDOW_MS);
  });

  it('says what the wait is for: waking an Azure database, or connecting to the server', async () => {
    const labels: string[] = [];
    const azure = openBuiltInSession(entra, env, { onConnecting: (l) => labels.push(l) });
    await settle();
    driver.finish?.();
    await azure;
    const local = openBuiltInSession(
      { id: 'c2', server: 'tcp:build01', authenticationType: 'sqlLogin', user: 'sa' } as never,
      { ...(env as object), secrets: { get: async () => 'pw' } } as never,
      { onConnecting: (l) => labels.push(l), password: 'pw' },
    );
    await settle();
    driver.finish?.();
    await local;
    expect(labels[0]).toContain('Waking up the database');
    expect(labels[0]).toContain('about a minute');
    expect(labels[1]).toBe('Connecting to build01…');
  });

  it('cancel during an attempt in flight closes the connection and opens no session', async () => {
    const { token, cancel } = cancellable();
    const open = openBuiltInSession(entra, env, { token });
    await settle();
    cancel();
    await expect(open).resolves.toBeUndefined();
    expect(driver.closed).toBe(1);
  });

  it('ignores the late result of the cancelled attempt: no error, no session', async () => {
    const { token, cancel } = cancellable();
    const open = openBuiltInSession(entra, env, { token });
    await settle();
    cancel();
    const lateFailure = Object.assign(new Error('Connection closed before the connection was established.'), { code: 'ECLOSE' });
    driver.finish?.(lateFailure);
    await expect(open).resolves.toBeUndefined();
    expect(driver.closed).toBe(1);
  });
});
