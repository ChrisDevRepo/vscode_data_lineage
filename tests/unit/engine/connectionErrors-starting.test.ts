/**
 * The text of a connect that failed because the server may still be starting (Azure SQL answers
 * the first login to a paused serverless database with 40613 and resumes in about a minute). The
 * user sees one plain sentence; the raw driver error goes to the output log. A failed login keeps
 * its specific text.
 */

import { describe, expect, it, vi } from 'vitest';
import { describeConnectionError, reportConnectionError } from '../../../src/engine/db/connectionErrors';
import type { ConnectionErrorTarget } from '../../../src/engine/db/dbSession';

const target: ConnectionErrorTarget = {
  provider: 'builtIn', name: 'Prod SQL', server: 'x.database.windows.net', database: 'SalesDb',
  authenticationType: 'entraId', connectionId: 'c1',
};
const driverError = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
const RAW = 'Database SalesDb on server x is not currently available. Please retry the connection later.';
const STARTING = "Couldn't connect to SalesDb. It might still be starting.";

describe('connect failure while the server may still be starting', () => {
  it.each([
    ['40613', driverError(RAW, { number: 40613 })],
    ['10928', driverError('Resource ID : 1. The request limit for the database is 30.', { number: 10928 })],
    ['ETIMEOUT', driverError('Failed to connect to x.database.windows.net:1433 in 30000ms', { code: 'ETIMEOUT' })],
    ['ESOCKET', driverError('Failed to connect to x.database.windows.net:1433 - socket hang up', { code: 'ESOCKET' })],
  ])('%s shows the plain sentence, offers Retry, and keeps the driver text out of the UI', (_name, err) => {
    const { message, actions } = describeConnectionError(err, target, { retry: () => undefined });
    expect(message).toBe(STARTING);
    expect(actions.map((a) => a.label)).toContain('Retry');
  });

  it('logs the failure at error level by number and code only, and the driver text at debug', () => {
    const logger = { error: vi.fn(), debug: vi.fn() };
    const { message } = reportConnectionError(driverError(RAW, { number: 40613 }), target, logger, {}, () => Promise.resolve(undefined));
    expect(message).not.toContain('not currently available');
    expect(logger.error).toHaveBeenCalledWith('Database connection failed', 'code=- number=40613');
    expect(logger.error.mock.calls.map(String).join('\n')).not.toContain('not currently available');
    expect(logger.debug.mock.calls.map(String).join('\n')).toContain('not currently available');
  });

  it('logs a failed action at error level', async () => {
    const logger = { error: vi.fn(), debug: vi.fn() };
    const { answered } = reportConnectionError(
      driverError(RAW, { number: 40613 }), target, logger,
      { retry: () => { throw new Error('boom'); } }, () => Promise.resolve('Retry'),
    );
    await answered;
    expect(logger.error).toHaveBeenCalledWith('Connection action failed', 'retry');
  });

  it('keeps the specific text of a failed login', () => {
    const { message } = describeConnectionError(driverError("Login failed for user 'a@b.c'.", { number: 18456 }), target);
    expect(message).toContain('Login failed for user');
  });

  it('keeps the driver text of a network error that is not a start-up wait', () => {
    const { message } = describeConnectionError(driverError('getaddrinfo ENOTFOUND nope.example', { code: 'ENOTFOUND' }), target);
    expect(message).toContain('ENOTFOUND');
  });
});
