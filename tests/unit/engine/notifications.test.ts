/**
 * Pins the notification helpers' log lines: one line at the matching level naming the operation and
 * the notification text, and the call-site context at debug only, redacted before it reaches the
 * output channel; the toast shows only the user message.
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../../src/utils/log';
import { notifyError, notifyInfo, notifyWarning } from '../../../src/utils/notifications';

function channel() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
}

const SECRET_CONTEXT = {
  connectionString: 'Server=sql.example.com;User Id=sa;Password=hunter2;Database=Sales',
  error: new Error('Login failed: {"password":"tok-9876"}'),
  headers: ['Authorization: Basic dXNlcjpodW50ZXIy'],
};

describe('notification context redaction', () => {
  it.each([
    ['notifyWarning', 'warn', (logger: Logger, toast: () => void) => notifyWarning(logger, 'Op', 'Shown', SECRET_CONTEXT, toast)],
    ['notifyInfo', 'info', (logger: Logger, toast: () => void) => notifyInfo(logger, 'Op', 'Shown', SECRET_CONTEXT, toast)],
    ['notifyError', 'error', (logger: Logger, toast: () => void) => notifyError(logger, 'Op', 'Shown', new Error('boom'), SECRET_CONTEXT, toast)],
  ] as const)('%s removes credentials from the logged context', (_name, level, notify) => {
    const ch = channel();
    const toast = vi.fn();
    notify(Logger.create(ch as never, 'DB'), toast);

    const leveled = ch[level].mock.calls.map(([line]) => String(line)).join('\n');
    expect(leveled).toContain('Op');
    expect(leveled).not.toContain('Server=');
    const logged = [...ch[level].mock.calls, ...ch.debug.mock.calls].map(([line]) => String(line)).join('\n');
    const debug = ch.debug.mock.calls.map(([line]) => String(line)).join('\n');
    expect(debug).toContain('notification="Shown"');
    expect(debug).toContain('Server=sql.example.com');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('tok-9876');
    expect(logged).not.toContain('dXNlcjpodW50ZXIy');
    expect(toast).toHaveBeenCalledWith('Shown');
  });

  it('removes a credential that the value length limit would otherwise cut in half', () => {
    const ch = channel();
    const password = `${'p'.repeat(280)}SECRETTAIL${'q'.repeat(100)}`;
    notifyWarning(Logger.create(ch as never, 'DB'), 'Op', 'Shown', { reason: `Server=x;Password=${password};Database=y` }, vi.fn());
    const logged = String(ch.debug.mock.calls[0][0]);
    expect(logged).toContain('Password=[removed]');
    expect(logged).not.toContain('ppppp');
  });

  it.each([
    ['notifyWarning', (logger: Logger, toast: (m: string) => void) => notifyWarning(logger, 'Op', 'Failed: Password=hunter2', undefined, toast)],
    ['notifyInfo', (logger: Logger, toast: (m: string) => void) => notifyInfo(logger, 'Op', 'Failed: Password=hunter2', undefined, toast)],
    ['notifyError', (logger: Logger, toast: (m: string) => void) => notifyError(logger, 'Op', 'Failed: Password=hunter2', undefined, undefined, toast)],
  ] as const)('%s removes credentials from the toast text', (_name, notify) => {
    const toast = vi.fn();
    notify(Logger.create(channel() as never, 'DB'), toast);
    expect(toast).toHaveBeenCalledWith('Failed: Password=[removed]');
  });

  it('leaves ordinary context unchanged', () => {
    const ch = channel();
    notifyWarning(Logger.create(ch as never, 'Config'), 'Load', 'Shown', { setting: 'dmvQueriesFile', count: 3 }, vi.fn());
    expect(ch.warn).toHaveBeenCalledWith('[Config] Load');
    expect(ch.debug).toHaveBeenCalledWith('[Config] Load — notification="Shown" — setting=dmvQueriesFile; count=3');
  });
});

describe('toast text in the output channel', () => {
  const TOAST = 'Failed to load custom rules from "/home/SentinelUser/rules.yaml" — using defaults.';

  it.each([
    ['notifyWarning', 'warn', (logger: Logger, toast: () => void) => notifyWarning(logger, 'Load rules', TOAST, undefined, toast)],
    ['notifyInfo', 'info', (logger: Logger, toast: () => void) => notifyInfo(logger, 'Load rules', TOAST, undefined, toast)],
    ['notifyError', 'error', (logger: Logger, toast: () => void) => notifyError(logger, 'Load rules', TOAST, undefined, undefined, toast)],
    ['notifyError with a caught error', 'error', (logger: Logger, toast: () => void) => notifyError(logger, 'Load rules', TOAST, new Error('EACCES'), undefined, toast)],
  ] as const)('%s keeps a path in the toast off every info, warn and error line', (_name, level, notify) => {
    const ch = channel();
    const toast = vi.fn();
    notify(Logger.create(ch as never, 'Config'), toast);

    const leveled = (['info', 'warn', 'error'] as const).flatMap((l) => ch[l].mock.calls.map(([line]) => String(line)));
    expect(leveled.join('\n')).not.toContain('SentinelUser');
    expect(String(ch[level].mock.calls[0][0])).toContain('Load rules');
    expect(ch.debug.mock.calls.map(([line]) => String(line)).join('\n')).toContain('SentinelUser');
    expect(toast).toHaveBeenCalledWith(TOAST);
  });
});
