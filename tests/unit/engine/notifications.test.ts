/**
 * Pins the notification helpers' log line: one line at the matching level whose context is redacted
 * before it reaches the output channel; the toast shows only the user message.
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

    const logged = ch[level].mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('notification="Shown"');
    expect(logged).toContain('Server=sql.example.com');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('tok-9876');
    expect(logged).not.toContain('dXNlcjpodW50ZXIy');
    expect(toast).toHaveBeenCalledWith('Shown');
  });

  it('removes a credential that the value length limit would otherwise cut in half', () => {
    const ch = channel();
    const password = `${'p'.repeat(280)}SECRETTAIL${'q'.repeat(100)}`;
    notifyWarning(Logger.create(ch as never, 'DB'), 'Op', 'Shown', { reason: `Server=x;Password=${password};Database=y` }, vi.fn());
    const logged = String(ch.warn.mock.calls[0][0]);
    expect(logged).toContain('Password=[removed]');
    expect(logged).not.toContain('ppppp');
  });

  it('leaves ordinary context unchanged', () => {
    const ch = channel();
    notifyWarning(Logger.create(ch as never, 'Config'), 'Load', 'Shown', { setting: 'dmvQueriesFile', count: 3 }, vi.fn());
    expect(ch.warn).toHaveBeenCalledWith('[Config] Load — notification="Shown" — setting=dmvQueriesFile; count=3');
  });
});
