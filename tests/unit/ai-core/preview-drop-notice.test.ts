/** One failed AI preview post is one user-visible notice: the host drop is a log line there, the participant's toast is the notice. */
import { describe, expect, it, vi } from 'vitest';
import type * as VSCode from 'vscode';

const toasts = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }));
vi.mock('vscode', async original => ({ ...await original<object>(),
  window: { showErrorMessage: toasts.error, showWarningMessage: toasts.warning } }));

import { deliverToPanel } from '../../../src/ai/tools/toolProvider';
import { postToWebview } from '../../../src/bridge/host';
import { Logger } from '../../../src/utils/log';

const logLines: string[] = [];
const channel = { info: () => {}, warn: () => {}, debug: () => {}, trace: () => {}, error: (line: string) => { logLines.push(line); } };
const logger = Logger.create(channel as never, 'Bridge');

const panel = () => ({ reveal: vi.fn(), webview: { postMessage: vi.fn(async () => true) } }) as unknown as VSCode.WebviewPanel & { webview: { postMessage: ReturnType<typeof vi.fn> } };
/** Fails the strict webview schema: `aiMetadata` carries an undeclared key. */
const malformedPreview = { type: 'ai-view-preview', name: 'Report lineage', nodeIds: ['dbo.report'],
  aiMetadata: { createdAt: 'now', modelName: 'm', highlightGroups: [], badges: [], undeclared: true } } as never;

describe('a schema-dropped AI preview post', () => {
  it('is post_failed with no host toast; the drop stays a log line', async () => {
    toasts.error.mockClear(); logLines.length = 0;
    const target = panel();
    expect(await deliverToPanel(target, malformedPreview, logger)).toBe('post_failed');
    expect(target.webview.postMessage).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(logLines.join('\n')).toContain('failed validation');
  });

  it('every other host send keeps its drop toast', async () => {
    toasts.error.mockClear();
    const target = panel();
    expect(await postToWebview(target, malformedPreview, logger)).toBe(false);
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });
});
