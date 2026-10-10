/** Credentials must be removed before log preview limits or notification display. */
import { describe, expect, it, vi } from 'vitest';
import { Logger, safeStringifyForLog } from '../../../src/utils/log';
import { notifyError, notifyInfo, notifyWarning } from '../../../src/utils/notifications';

const SYNTHETIC_SECRET = 'REVIEW_SYNTHETIC_CREDENTIAL';

function channel() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** The preview ceiling falls inside the last JSON value, before its closing quote. */
function contextAtPreviewLimit() {
  return { pad1: 'x'.repeat(120), pad2: 'x'.repeat(120), password: SYNTHETIC_SECRET };
}

describe('log and notification redaction boundaries', () => {
  it.each(['info', 'debug', 'warn'] as const)('redacts direct %s messages', (level) => {
    const ch = channel();
    Logger.create(ch as never, 'DB')[level](`Password=${SYNTHETIC_SECRET}`);

    expect(ch[level].mock.calls.flat().join(' ')).not.toContain(SYNTHETIC_SECRET);
    expect(ch[level]).toHaveBeenCalledWith('[DB] Password=[removed]');
  });

  it('redacts the error label, message and stack', () => {
    const ch = channel();
    const error = new Error(`Password=${SYNTHETIC_SECRET}`);
    error.stack = `Error: token=${SYNTHETIC_SECRET}\n at synthetic`;
    Logger.create(ch as never, 'DB').error(`secret=${SYNTHETIC_SECRET}`, error);

    expect(ch.error.mock.calls.flat().join(' ')).not.toContain(SYNTHETIC_SECRET);
    expect(ch.error.mock.calls).toEqual([
      ['[DB] FAILED: secret=[removed] — Password=[removed]'],
      ['[DB] Stack: Error: token=[removed] at synthetic'],
    ]);
  });

  it('redacts serialized objects before the complete preview limit', () => {
    const rendered = safeStringifyForLog(contextAtPreviewLimit());

    expect(rendered).not.toContain(SYNTHETIC_SECRET.slice(0, 8));
    expect(rendered).toContain('"password":"[removed]"');
  });

  it.each([
    ['info', notifyInfo],
    ['warn', notifyWarning],
  ] as const)('redacts the %s notification in both the log and toast', (level, notify) => {
    const ch = channel();
    const toast = vi.fn();
    notify(Logger.create(ch as never, 'DB'), 'Review', `Password=${SYNTHETIC_SECRET}`, undefined, toast);

    expect(ch[level].mock.calls.flat().join(' ')).not.toContain(SYNTHETIC_SECRET);
    expect(toast).toHaveBeenCalledWith('Password=[removed]');
  });

  it('redacts the error notification in both the log and toast', () => {
    const ch = channel();
    const toast = vi.fn();
    notifyError(
      Logger.create(ch as never, 'DB'),
      'Review',
      `Password=${SYNTHETIC_SECRET}`,
      new Error(`Password=${SYNTHETIC_SECRET}`),
      undefined,
      toast,
    );

    expect(ch.error.mock.calls.flat().join(' ')).not.toContain(SYNTHETIC_SECRET);
    expect(toast).toHaveBeenCalledWith('Password=[removed]');
  });

  it('redacts structured notification context before preview limits', () => {
    const ch = channel();
    notifyWarning(
      Logger.create(ch as never, 'DB'),
      'Review',
      'Shown',
      { detail: contextAtPreviewLimit() },
      vi.fn(),
    );

    expect(ch.warn.mock.calls.flat().join(' ')).not.toContain(SYNTHETIC_SECRET.slice(0, 8));
    expect(ch.warn.mock.calls.flat().join(' ')).toContain('"password":"[removed]"');
  });
});
