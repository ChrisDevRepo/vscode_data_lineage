import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../../src/utils/log';

const notificationMocks = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: notificationMocks.showErrorMessage,
    showWarningMessage: notificationMocks.showWarningMessage,
  },
}));

function makeChannel() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('notifications', () => {
  it('logs detailed error context before showing the concise toast', async () => {
    const { notifyError } = await import('../../../src/utils/notifications');
    const channel = makeChannel();
    const logger = Logger.create(channel as any, 'Bridge');
    const err = new Error('render exploded');

    notifyError(logger, 'Webview error-boundary', 'Data Lineage Error: render failed', err, {
      displayMode: 'schemaExpanded',
      expandedSchemas: ['Production', 'ext'],
    }, notificationMocks.showErrorMessage);

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('[Bridge] FAILED: Webview error-boundary'));
    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('displayMode=schemaExpanded'));
    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('expandedSchemas=Production, ext'));
    expect(notificationMocks.showErrorMessage).toHaveBeenCalledWith('Data Lineage Error: render failed');
  });

  it('logs nested diagnostic context as structured JSON instead of object placeholders', async () => {
    const { notifyError } = await import('../../../src/utils/notifications');
    const channel = makeChannel();
    const logger = Logger.create(channel as any, 'Bridge');

    notifyError(logger, 'Webview error-boundary', 'Data Lineage Error: render failed', undefined, {
      render: { displayMode: 'schemaExpanded', nodeCount: 42 },
    }, notificationMocks.showErrorMessage);

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('render={"displayMode":"schemaExpanded","nodeCount":42}'));
    expect(channel.error).not.toHaveBeenCalledWith(expect.stringContaining('[object Object]'));
  });

  it('logs detailed warning context before showing the concise toast', async () => {
    const { notifyWarning } = await import('../../../src/utils/notifications');
    const channel = makeChannel();
    const logger = Logger.create(channel as any, 'Config');

    notifyWarning(logger, 'Load custom parse rules', 'Using built-in defaults.', {
      path: 'bad.yaml',
      reason: 'missing rules array',
    }, notificationMocks.showWarningMessage);

    expect(channel.warn).toHaveBeenCalledWith(expect.stringContaining('[Config] Load custom parse rules'));
    expect(channel.warn).toHaveBeenCalledWith(expect.stringContaining('path=bad.yaml'));
    expect(channel.warn).toHaveBeenCalledWith(expect.stringContaining('reason=missing rules array'));
    expect(notificationMocks.showWarningMessage).toHaveBeenCalledWith('Using built-in defaults.');
  });

  it('caps the toast text and hands the logger the untruncated message', async () => {
    const { notifyError, notifyInfo, notifyWarning } = await import('../../../src/utils/notifications');
    const channel = makeChannel();
    const logger = Logger.create(channel as any, 'Bridge');
    // Longer than the 400-character toast ceiling, so the cut is observable in the toast and the
    // absence of a cut is observable in the log line beside it.
    const message = 'x'.repeat(1_000);

    const shownError = vi.fn();
    const shownWarning = vi.fn();
    const shownInfo = vi.fn();
    notifyError(logger, 'Long failure', message, undefined, undefined, shownError);
    notifyWarning(logger, 'Long warning', message, undefined, shownWarning);
    notifyInfo(logger, 'Long notice', message, undefined, shownInfo);

    for (const shown of [shownError, shownWarning, shownInfo]) {
      const text = String(shown.mock.calls[0]?.[0]);
      expect(text.startsWith('x'.repeat(400)), 'the toast keeps the leading 400 characters').toBe(true);
      expect(text, 'and no more of them').not.toContain('x'.repeat(401));
      expect(text, 'the cut is marked rather than silent').toContain('\u2026');
    }

    // The untruncated message always reaches the log line that accompanies the toast.
    expect(String(channel.error.mock.calls[0]?.[0])).toContain(message);
    expect(String(channel.warn.mock.calls[0]?.[0])).toContain(message);
    expect(String(channel.info.mock.calls[0]?.[0])).toContain(message);
  });

  it('keeps notification delivery safe and bounded for cyclic and bigint context', async () => {
    const { notifyWarning } = await import('../../../src/utils/notifications');
    const channel = makeChannel();
    const logger = Logger.create(channel as any, 'Config');
    const cyclic: Record<string, unknown> = { count: 7n };
    cyclic.self = cyclic;
    cyclic.detail = 'x'.repeat(2_000);

    notifyWarning(
      logger,
      'Trace writer',
      'Trace diagnostics are degraded.',
      { cyclic },
      notificationMocks.showWarningMessage,
    );

    const logged = String(channel.warn.mock.calls[0]?.[0]);
    expect(logged).toContain('[Circular]');
    expect(logged.length).toBeLessThan(1_500);
    expect(notificationMocks.showWarningMessage).toHaveBeenCalledWith('Trace diagnostics are degraded.');
  });
});
