/**
 * The two webview→host handlers that hand a webview-supplied string to a VS Code API: the report
 * "Open in editor" path and the draw.io export save dialog.
 *
 * Both are boundaries, so both are pinned here — the contract cap that stops an unbounded report
 * payload reaching `openTextDocument`, the base-name reduction that stops a webview-supplied file
 * name seeding the save dialog at a path it never came from, and the fallback that keeps the report
 * readable when the built-in Markdown preview is not installed.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AI_REPORT_MARKDOWN_MAX_CHARS,
  MainPanelToExtensionMsgSchema,
} from '../../../src/engine/shared/bridgeContract';
import type { BridgeHost } from '../../../src/bridge/host';

const openTextDocument = vi.fn();
const executeCommand = vi.fn();
const showTextDocument = vi.fn();
const showWarningMessage = vi.fn();

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath }) },
    ViewColumn: { Beside: -2 },
    workspace: { openTextDocument: (...args: unknown[]) => openTextDocument(...args) },
    commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) },
    window: {
      showTextDocument: (...args: unknown[]) => showTextDocument(...args),
      showWarningMessage: (...args: unknown[]) => showWarningMessage(...args),
    },
  };
});

const { createMessageHandlers } = await import('../../../src/bridge/messageHandlers');

function fakeHost(overrides: Partial<BridgeHost> = {}): BridgeHost {
  return {
    postMessage: vi.fn().mockResolvedValue(true),
    log: vi.fn(),
    showErrorMessage: vi.fn(),
    executeCommand: vi.fn(),
    openExternal: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    withProgress: vi.fn(),
    getConfiguration: vi.fn(),
    getExtensionUri: vi.fn(),
    getGlobalState: vi.fn(),
    getWorkspaceState: vi.fn(),
    ...overrides,
  } as BridgeHost;
}

function buildHandlers(host: BridgeHost) {
  const { handlers } = createMessageHandlers(
    host,
    { globalState: { get: vi.fn(), update: vi.fn() } } as never,
    () => ({}) as never,
    { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    () => ({ schemaVersion: 1, lastOpenedId: null, projects: [] }) as never,
    vi.fn(),
    vi.fn(),
    false,
    vi.fn(),
  );
  return handlers;
}

describe('ai-open-in-editor payload bound', () => {
  it('accepts a report exactly at the contract ceiling', () => {
    const message = { type: 'ai-open-in-editor', markdown: 'x'.repeat(AI_REPORT_MARKDOWN_MAX_CHARS) };
    expect(MainPanelToExtensionMsgSchema.safeParse(message).success).toBe(true);
  });

  it('rejects one character past it, so an unbounded payload never reaches the editor', () => {
    const message = { type: 'ai-open-in-editor', markdown: 'x'.repeat(AI_REPORT_MARKDOWN_MAX_CHARS + 1) };
    const parsed = MainPanelToExtensionMsgSchema.safeParse(message);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].path).toEqual(['markdown']);
  });
});

describe('ai-open-in-editor handler', () => {
  it('previews the stripped report beside the panel when the preview command is available', async () => {
    openTextDocument.mockReset().mockResolvedValue({ uri: { scheme: 'untitled' } });
    executeCommand.mockReset().mockResolvedValue(undefined);
    showTextDocument.mockReset();
    showWarningMessage.mockReset();

    const handlers = buildHandlers(fakeHost());
    await handlers['ai-open-in-editor']({
      type: 'ai-open-in-editor',
      markdown: 'See [dbo.Orders](#focus-node:dbo.Orders).',
    });

    expect(openTextDocument).toHaveBeenCalledWith({
      content: 'See dbo.Orders.',
      language: 'markdown',
    });
    expect(executeCommand).toHaveBeenCalledWith('markdown.showPreviewToSide', { scheme: 'untitled' });
    expect(showTextDocument, 'the preview is the whole action when it works').not.toHaveBeenCalled();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('shows the document itself and warns — never errors — when the preview command is missing', async () => {
    const doc = { uri: { scheme: 'untitled' } };
    openTextDocument.mockReset().mockResolvedValue(doc);
    executeCommand.mockReset().mockRejectedValue(new Error("command 'markdown.showPreviewToSide' not found"));
    showTextDocument.mockReset().mockResolvedValue(undefined);
    showWarningMessage.mockReset();

    const host = fakeHost();
    const handlers = buildHandlers(host);
    await expect(
      handlers['ai-open-in-editor']({ type: 'ai-open-in-editor', markdown: 'Report body.' }),
    ).resolves.toBeUndefined();

    expect(showTextDocument, 'the document the user asked for is still opened').toHaveBeenCalledWith(
      doc,
      { viewColumn: -2 },
    );
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(String(showWarningMessage.mock.calls[0][0])).toContain('Markdown');
    expect(host.showErrorMessage, 'a missing optional preview is not a failed action').not.toHaveBeenCalled();
  });
});

describe('export-file handler', () => {
  it.each([
    ['../../../etc/passwd', 'passwd'],
    ['sub/dir/orders_lineage.drawio', 'orders_lineage.drawio'],
    ['orders_lineage.drawio', 'orders_lineage.drawio'],
  ])('pre-fills the save dialog with the base name of %s', async (defaultName, expected) => {
    const showSaveDialog = vi.fn().mockResolvedValue(undefined);
    const handlers = buildHandlers(fakeHost({ showSaveDialog }));

    await handlers['export-file']({ type: 'export-file', defaultName, data: '<mxfile/>' });

    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(showSaveDialog.mock.calls[0][0].defaultUri.fsPath).toBe(expected);
  });

  it('writes the export only once the dialog returns a destination the user chose', async () => {
    const chosen = { scheme: 'file', fsPath: '/home/user/picked.drawio' };
    const showSaveDialog = vi.fn().mockResolvedValue(chosen);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const executeHostCommand = vi.fn();
    const handlers = buildHandlers(
      fakeHost({ showSaveDialog, writeFile, executeCommand: executeHostCommand }),
    );

    await handlers['export-file']({
      type: 'export-file',
      defaultName: 'nested/path/orders.drawio',
      data: '<mxfile/>',
    });

    expect(writeFile).toHaveBeenCalledWith(chosen, Buffer.from('<mxfile/>', 'utf-8'));
    expect(executeHostCommand).toHaveBeenCalledWith('revealFileInOS', chosen);
  });
});
