/**
 * The webview→host handlers that hand a webview-supplied string to a VS Code API: the report
 * "Open in editor" path, the draw.io export save dialog and the webview error log.
 *
 * All are boundaries, so all are pinned here — the contract cap that stops an unbounded report
 * payload reaching `openTextDocument`, the base-name reduction that stops a webview-supplied file
 * name seeding the save dialog at a path it never came from, and the fallback that keeps the report
 * readable when the built-in Markdown preview is not installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_REPORT_MARKDOWN_MAX_CHARS,
  MainPanelToExtensionMsgSchema,
} from '../../../src/engine/shared/bridgeContract';
import type { BridgeHost } from '../../../src/bridge/host';

const openTextDocument = vi.fn();
const executeCommand = vi.fn();
const showTextDocument = vi.fn();
const showWarningMessage = vi.fn();
const applyEdit = vi.fn();
const createWebviewPanel = vi.fn();
const closeTab = vi.fn();
/** Tabs the fake workbench reports as open; a test pushes a preview tab to simulate an open preview. */
const openTabs: Array<{ input: unknown; label: string; isActive: boolean }> = [];

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class Range {
    constructor(
      public startLine: number,
      public startCharacter: number,
      public endLine: number,
      public endCharacter: number,
    ) {}
  }
  class WorkspaceEdit {
    readonly replacements: Array<{ uri: unknown; range: unknown; text: string }> = [];
    replace(uri: unknown, range: unknown, text: string): void {
      this.replacements.push({ uri, range, text });
    }
  }
  class TabInputWebview {
    constructor(public viewType: string) {}
  }
  return {
    ...actual,
    Uri: {
      file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath }),
      joinPath: (base: { path: string }, ...parts: string[]) => ({ scheme: 'file', path: [base.path, ...parts].join('/') }),
    },
    ViewColumn: { Beside: -2, One: 1 },
    Range,
    WorkspaceEdit,
    TabInputWebview,
    workspace: {
      openTextDocument: (...args: unknown[]) => openTextDocument(...args),
      applyEdit: (...args: unknown[]) => applyEdit(...args),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
    commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) },
    extensions: { onDidChange: () => ({ dispose() {} }), getExtension: () => undefined },
    window: {
      createWebviewPanel: () => createWebviewPanel(),
      showTextDocument: (...args: unknown[]) => showTextDocument(...args),
      showErrorMessage: () => undefined,
      showWarningMessage: (...args: unknown[]) => showWarningMessage(...args),
      tabGroups: { get all() { return [{ tabs: openTabs }]; }, close: (...args: unknown[]) => closeTab(...args) },
    },
  };
});

const vscodeFake = (await import('vscode')) as unknown as {
  TabInputWebview: new (viewType: string) => unknown;
  WorkspaceEdit: { prototype: { replacements: Array<{ uri: unknown; text: string }> } };
};

const { createMessageHandlers } = await import('../../../src/bridge/messageHandlers');
const { openPanel } = await import('../../../src/panelProvider');

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
    ...overrides,
  } as BridgeHost;
}

function buildHandlers(host: BridgeHost, outputChannel: unknown = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) {
  const { handlers } = createMessageHandlers(
    host,
    { globalState: { get: vi.fn(), update: vi.fn() } } as never,
    () => ({}) as never,
    outputChannel as never,
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
    openTextDocument.mockReset().mockResolvedValue({ uri: { scheme: 'untitled', path: 'Untitled-1' } });
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
    expect(executeCommand).toHaveBeenCalledWith('markdown.showPreviewToSide', { scheme: 'untitled', path: 'Untitled-1' });
    expect(showTextDocument, 'the preview is the whole action when it works').not.toHaveBeenCalled();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('shows the document itself and warns — never errors — when the preview command is missing', async () => {
    const doc = { uri: { scheme: 'untitled', path: 'Untitled-1' } };
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

/** An untitled-like document whose text follows applied edits, as the real model does. */
function fakeDocument(name: string) {
  const doc = {
    uri: { scheme: 'untitled', path: name },
    isClosed: false,
    text: '',
    get lineCount() { return doc.text.split('\n').length; },
    getText: () => doc.text,
    validateRange: (range: unknown) => range,
  };
  return doc;
}

function previewTabFor(name: string, isActive = true) {
  return { input: new vscodeFake.TabInputWebview('mainThreadWebview-markdown.preview'), label: `Preview ${name}`, isActive };
}

describe('ai-open-in-editor handler: one report document and preview', () => {
  function arrange() {
    let created = 0;
    const docs: ReturnType<typeof fakeDocument>[] = [];
    openTextDocument.mockReset().mockImplementation(async (opts: { content: string }) => {
      const doc = fakeDocument(`Untitled-${++created}`);
      doc.text = opts.content;
      docs.push(doc);
      return doc;
    });
    applyEdit.mockReset().mockImplementation(async (edit: { replacements: Array<{ uri: unknown; text: string }> }) => {
      for (const r of edit.replacements) docs.find((d) => d.uri === r.uri)!.text = r.text;
      return true;
    });
    executeCommand.mockReset().mockResolvedValue(undefined);
    showTextDocument.mockReset().mockResolvedValue(undefined);
    showWarningMessage.mockReset();
    openTabs.length = 0;
    closeTab.mockReset().mockResolvedValue(true);
    const handlers = buildHandlers(fakeHost());
    const click = (markdown: string) => handlers['ai-open-in-editor']({ type: 'ai-open-in-editor', markdown });
    return { docs, click };
  }

  it('keeps one document and one preview uri across three clicks with changing content', async () => {
    const { docs, click } = arrange();
    await click('# A');
    await click('# A');
    await click('# B');

    expect(docs, 'repeated clicks never accumulate documents').toHaveLength(1);
    expect(docs[0].text, 'the report shows the latest content').toBe('# B');
    expect(executeCommand.mock.calls.map((c) => c[0])).toEqual(Array(3).fill('markdown.showPreviewToSide'));
    for (const call of executeCommand.mock.calls) expect(call[1]).toBe(docs[0].uri);
  });

  it('keeps one document when a second click arrives before the first document exists', async () => {
    const { docs, click } = arrange();
    await Promise.all([click('# A'), click('# B')]);

    expect(docs).toHaveLength(1);
    expect(docs[0].text).toBe('# B');
  });

  it('updates an already open preview through the document instead of opening a second one', async () => {
    const { docs, click } = arrange();
    await click('# A');
    openTabs.push(previewTabFor('Untitled-1'));
    await click('# B');
    await click('# C');

    expect(executeCommand, 'the open preview follows the document; no new preview is requested').toHaveBeenCalledTimes(1);
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toBe('# C');
  });

  it('closes a hidden report preview once, then asks for the preview, so the command ends with one preview', async () => {
    const { docs, click } = arrange();
    await click('# A');
    const hidden = previewTabFor('Untitled-1', false);
    openTabs.push(hidden);
    closeTab.mockClear();
    executeCommand.mockClear();
    await click('# B');

    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith(hidden);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith('markdown.showPreviewToSide', docs[0].uri);
    expect(closeTab.mock.invocationCallOrder[0]).toBeLessThan(executeCommand.mock.invocationCallOrder[0]);
  });

  it('closes nothing and asks for nothing when the report preview is visible', async () => {
    const { click } = arrange();
    await click('# A');
    openTabs.push(previewTabFor('Untitled-1'));
    closeTab.mockClear();
    executeCommand.mockClear();
    await click('# B');

    expect(closeTab).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('closes nothing and asks once when no report preview exists', async () => {
    const { click } = arrange();
    await click('# A');

    expect(closeTab).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['returns false', () => closeTab.mockResolvedValue(false)],
    ['rejects', () => closeTab.mockRejectedValue(new Error('close refused'))],
  ])('still asks for the preview, without throwing, when closing the hidden tab %s', async (_name, setup) => {
    const { docs, click } = arrange();
    await click('# A');
    openTabs.push(previewTabFor('Untitled-1', false));
    setup();
    executeCommand.mockClear();

    await expect(click('# B')).resolves.toBeUndefined();
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith('markdown.showPreviewToSide', docs[0].uri);
  });

  it('does not take a preview of a document whose name merely ends with the report name for the report preview', async () => {
    const { click } = arrange();
    await click('# A');
    const other = previewTabFor('notes-Untitled-1', false);
    openTabs.push(other, previewTabFor('xUntitled-1'));
    closeTab.mockClear();
    executeCommand.mockClear();
    await click('# B');

    expect(closeTab, 'another document\'s preview is never closed').not.toHaveBeenCalled();
    expect(executeCommand, 'no report preview is open, so one is requested').toHaveBeenCalledTimes(1);
  });

  it('recognizes the locked preview label form of the report', async () => {
    const { click } = arrange();
    await click('# A');
    openTabs.push({ input: new vscodeFake.TabInputWebview('mainThreadWebview-markdown.preview'), label: '[Preview] Untitled-1', isActive: true });
    executeCommand.mockClear();
    await click('# B');

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('closes a hidden report preview even when another report preview is visible, and asks for nothing', async () => {
    const { click } = arrange();
    await click('# A');
    const hidden = previewTabFor('Untitled-1', false);
    openTabs.push(previewTabFor('Untitled-1'), hidden);
    closeTab.mockClear();
    executeCommand.mockClear();
    await click('# B');

    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith(hidden);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('opens the preview again on the same document after the user closed it', async () => {
    const { docs, click } = arrange();
    await click('# A');
    openTabs.push(previewTabFor('Untitled-1'));
    await click('# B');
    openTabs.length = 0;
    await click('# C');

    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(executeCommand.mock.calls[1][1]).toBe(docs[0].uri);
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toBe('# C');
  });

  it('opens a new report document when the previous one was closed or cannot be edited', async () => {
    const { docs, click } = arrange();
    await click('# A');
    docs[0].isClosed = true;
    await click('# B');
    expect(docs).toHaveLength(2);
    expect(executeCommand.mock.calls[1][1]).toBe(docs[1].uri);

    applyEdit.mockResolvedValueOnce(false);
    await click('# C');
    expect(docs, 'a rejected edit falls back to a fresh document, never to a stale report').toHaveLength(3);
    expect(docs[2].text).toBe('# C');
  });

  it('still shows the document and warns on a later click when the preview command is missing', async () => {
    const { docs, click } = arrange();
    await click('# A');
    executeCommand.mockReset().mockRejectedValue(new Error("command 'markdown.showPreviewToSide' not found"));
    await expect(click('# B')).resolves.toBeUndefined();

    expect(docs).toHaveLength(1);
    expect(showTextDocument).toHaveBeenCalledWith(docs[0], { viewColumn: -2 });
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });
});

/** A webview panel double that records its message listener and fires dispose listeners on `dispose()`. */
function fakeWebviewPanel() {
  const disposeListeners: Array<() => void> = [];
  let messageListener: ((msg: unknown) => Promise<void>) | undefined;
  const panel = {
    webview: {
      html: '',
      cspSource: 'csp',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: (listener: (msg: unknown) => Promise<void>) => { messageListener = listener; return { dispose() {} }; },
    },
    onDidDispose: (listener: () => void) => { disposeListeners.push(listener); return { dispose() {} }; },
    reveal: vi.fn(),
    dispose: () => { for (const l of disposeListeners) l(); },
  };
  return { panel, send: (msg: unknown) => messageListener!(msg) };
}

describe('ai-open-in-editor across a closed and reopened panel', () => {
  /** Panels and documents of the running test; the retained report document is module state, so a test closes its predecessors. */
  const livePanels: Array<{ dispose: () => void }> = [];
  const leftoverDocs: Array<{ isClosed: boolean }> = [];
  beforeEach(() => {
    for (const doc of leftoverDocs.splice(0)) doc.isClosed = true;
  });
  afterEach(() => {
    for (const panel of livePanels.splice(0)) panel.dispose();
  });

  function openFreshPanel() {
    const fake = fakeWebviewPanel();
    livePanels.push(fake.panel);
    createWebviewPanel.mockReset().mockReturnValue(fake.panel);
    const session = {
      phase: { kind: 'idle' },
      resetExploration: vi.fn(),
      columnStore: { clear: vi.fn() },
      clearDiscoveryTranscript: vi.fn(),
      clearExternalViews: vi.fn(),
      model: null,
      graph: null,
    };
    openPanel(
      { extensionUri: { scheme: 'file', path: '/ext' }, globalState: { get: vi.fn(), update: vi.fn() } } as never,
      'Data Lineage',
      () => session as never,
      { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      () => ({ schemaVersion: 1, lastOpenedId: null, projects: [] }),
      vi.fn(),
      vi.fn(),
    );
    return fake;
  }

  function arrangeDocuments() {
    let created = 0;
    const docs: ReturnType<typeof fakeDocument>[] = [];
    openTextDocument.mockReset().mockImplementation(async (opts: { content: string }) => {
      const doc = fakeDocument(`Untitled-${++created}`);
      doc.text = opts.content;
      docs.push(doc);
      leftoverDocs.push(doc);
      return doc;
    });
    applyEdit.mockReset().mockImplementation(async (edit: { replacements: Array<{ uri: unknown; text: string }> }) => {
      for (const r of edit.replacements) docs.find((d) => d.uri === r.uri)!.text = r.text;
      return true;
    });
    executeCommand.mockReset().mockResolvedValue(undefined);
    showTextDocument.mockReset().mockResolvedValue(undefined);
    openTabs.length = 0;
    closeTab.mockReset().mockResolvedValue(true);
    return docs;
  }

  it('reuses the still-open report document after the panel is closed and reopened', async () => {
    const docs = arrangeDocuments();
    const first = openFreshPanel();
    await first.send({ type: 'ai-open-in-editor', markdown: '# A' });
    first.panel.dispose();

    const second = openFreshPanel();
    await second.send({ type: 'ai-open-in-editor', markdown: '# B' });

    expect(docs, 'one report document per extension session').toHaveLength(1);
    expect(docs[0].text).toBe('# B');
    second.panel.dispose();
  });

  it('opens a fresh report document after the panel reopened when the user closed the previous one', async () => {
    const docs = arrangeDocuments();
    const first = openFreshPanel();
    await first.send({ type: 'ai-open-in-editor', markdown: '# A' });
    first.panel.dispose();
    docs[0].isClosed = true;

    const second = openFreshPanel();
    await second.send({ type: 'ai-open-in-editor', markdown: '# B' });

    expect(docs).toHaveLength(2);
    expect(docs[1].text).toBe('# B');
    second.panel.dispose();
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

describe('webview error handler: logging goes through the redacting host.log', () => {
  const secretStack = 'Error: boom Password=hunter2\n    at render (webview.js:1:1)';

  it('writes the error to host.log at error level and never to the output channel directly', () => {
    const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const host = fakeHost();
    const handlers = buildHandlers(host, channel);

    handlers['error']({ type: 'error', error: 'render failed Password=hunter2', stack: secretStack, source: 'error-boundary', context: { note: 'x' } });

    expect(channel.error, 'a direct channel write bypasses redaction').not.toHaveBeenCalled();
    expect(channel.warn).not.toHaveBeenCalled();
    expect(host.log).toHaveBeenCalledTimes(1);
    const [level, category, text, err] = (host.log as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(level).toBe('error');
    expect(category).toBe('Bridge');
    expect(text).toContain('Webview error-boundary');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('render failed Password=hunter2');
    expect((err as Error).stack).toBe(secretStack);
  });

  it('still shows the error toast', () => {
    const host = fakeHost();
    buildHandlers(host)['error']({ type: 'error', error: 'x', source: 'window-error' });
    expect(host.showErrorMessage).toHaveBeenCalledTimes(1);
    expect((host.showErrorMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('Output channel');
  });
});
