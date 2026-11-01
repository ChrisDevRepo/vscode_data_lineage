/** Bridge frame boundary: a frame from the other side is validated before use; a version skew or a malformed payload is rejected. */

import { describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_PROTOCOL_VERSION,
  ExtensionToDetailMsgSchema,
  ExtensionToWebviewMsgSchema,
  validateBridgeFrame,
} from '../../../src/engine/shared/bridgeContract';

const panelHost = vi.hoisted(() => ({
  receive: undefined as undefined | ((frame: unknown) => Promise<void>),
  ready: [] as unknown[],
  errors: [] as string[],
}));
vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ViewColumn: { One: 1 },
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  commands: { executeCommand: () => Promise.resolve() },
  window: {
    showErrorMessage: (message: string) => panelHost.errors.push(message),
    createWebviewPanel: () => ({
      webview: {
        asWebviewUri: (uri: unknown) => uri,
        cspSource: 'vscode-resource:',
        onDidReceiveMessage: (listener: (frame: unknown) => Promise<void>) => {
          panelHost.receive = listener;
        },
      },
      onDidDispose: () => {},
    }),
  },
}));
vi.mock('../../../src/bridge/host', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createBridgeHost: () => ({}),
}));
vi.mock('../../../src/bridge/messageHandlers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createMessageHandlers: () => ({
    handlers: { ready: (msg: unknown) => panelHost.ready.push(msg) },
    cleanup: () => Promise.resolve(),
  }),
}));

describe('bridge protocol envelope', () => {
  it('validateBridgeFrame accepts a stamped frame and names the reason for a rejected one', () => {
    const ok = validateBridgeFrame(ExtensionToWebviewMsgSchema, {
      type: 'detail-closed',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
    expect(ok.ok).toBe(true);
    const skew = validateBridgeFrame(ExtensionToWebviewMsgSchema, {
      type: 'detail-closed',
      protocolVersion: BRIDGE_PROTOCOL_VERSION + 1,
    });
    expect(skew).toMatchObject({
      ok: false,
      reason: 'version',
      msgType: 'detail-closed',
    });
    const unstamped = validateBridgeFrame(ExtensionToWebviewMsgSchema, {
      type: 'detail-closed',
    });
    expect(
      unstamped,
      'the host always stamps, so a missing version is a skew',
    ).toMatchObject({ ok: false, reason: 'version' });
    expect(
      validateBridgeFrame(ExtensionToWebviewMsgSchema, {
        type: 'not-a-message',
      }),
    ).toMatchObject({ ok: false, reason: 'parse' });
  });
});

describe('bridge protocol version at the host receive site', () => {
  it('dispatches an unstamped or matching frame and rejects any other version before its handler', async () => {
    const { openPanel } = await import('../../../src/panelProvider');
    const channel = {
      info() {},
      debug() {},
      warn() {},
      error() {},
      trace() {},
    };
    openPanel(
      { extensionUri: 'ext' } as never,
      'Lineage',
      (() => ({})) as never,
      channel as never,
      (() => ({})) as never,
      () => Promise.resolve(),
      () => Promise.resolve(),
    );
    for (const protocolVersion of [
      undefined,
      BRIDGE_PROTOCOL_VERSION,
      BRIDGE_PROTOCOL_VERSION + 1,
      'v1',
    ]) {
      await panelHost.receive!({ type: 'ready', protocolVersion });
    }
    expect(panelHost.ready).toEqual([{ type: 'ready' }, { type: 'ready' }]);
    expect(panelHost.errors).toHaveLength(2);
  });
});

describe('bridge node fields', () => {
  it('accepts a node without definitionUnreadable and rejects a non-boolean one', () => {
    const node = {
      id: 'a',
      schema: 'dbo',
      name: 'a',
      fullName: '[dbo].[a]',
      type: 'procedure',
    };
    const parse = (n: object) =>
      ExtensionToDetailMsgSchema.safeParse({
        type: 'detail-update',
        node: n,
        config: {},
      }).success;
    expect(parse(node)).toBe(true);
    expect(parse({ ...node, definitionUnreadable: 'yes' })).toBe(false);
  });
});
