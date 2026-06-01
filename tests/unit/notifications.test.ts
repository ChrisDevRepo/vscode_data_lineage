import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../src/utils/log';

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
    const { notifyError } = await import('../../src/utils/notifications');
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
    const { notifyError } = await import('../../src/utils/notifications');
    const channel = makeChannel();
    const logger = Logger.create(channel as any, 'Bridge');

    notifyError(logger, 'Webview error-boundary', 'Data Lineage Error: render failed', undefined, {
      render: { displayMode: 'schemaExpanded', nodeCount: 42 },
    }, notificationMocks.showErrorMessage);

    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('render={"displayMode":"schemaExpanded","nodeCount":42}'));
    expect(channel.error).not.toHaveBeenCalledWith(expect.stringContaining('[object Object]'));
  });

  it('logs detailed warning context before showing the concise toast', async () => {
    const { notifyWarning } = await import('../../src/utils/notifications');
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
});
