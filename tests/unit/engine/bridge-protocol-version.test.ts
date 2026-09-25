/**
 * Bridge protocol-envelope contract.
 *
 * Proves the two halves of the version tripwire independently: the host's single send choke point
 * stamps every outgoing frame, and a receive site rejects a frame whose version disagrees. The
 * receive-site checks are three lines of inline logic at four call sites, so they are exercised here
 * through the same predicate shape rather than by booting React — what must not regress is the
 * decision (stamped-and-equal passes, anything else is rejected), not the JSX around it.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { postToDetail, postToWebview } from '../../../src/bridge/host';
import {
  BRIDGE_PROTOCOL_VERSION,
  ExtensionToDetailMsgSchema,
  ExtensionToWebviewMsgSchema,
  type BridgeEnvelope,
  validateBridgeFrame,
} from '../../../src/engine/shared/bridgeContract';
import { Logger } from '../../../src/utils/log';

/** Minimal panel double capturing whatever reaches `webview.postMessage`. */
function fakePanel() {
  const sent: unknown[] = [];
  return {
    sent,
    panel: { webview: { postMessage: (m: unknown) => { sent.push(m); return Promise.resolve(true); } } },
  };
}

const silentLogger = Logger.create(
  { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} } as never,
  'Bridge',
);

describe('bridge protocol envelope', () => {
  it('stamps the protocol version on every host→webview frame', async () => {
    const { sent, panel } = fakePanel();

    await postToWebview(panel as never, { type: 'detail-closed' }, silentLogger);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: 'detail-closed', protocolVersion: BRIDGE_PROTOCOL_VERSION });
  });

  it('stamps the protocol version on every host→detail frame', async () => {
    const { sent, panel } = fakePanel();

    await postToDetail(panel as never, { type: 'detail-clear' }, silentLogger);

    expect(sent[0]).toEqual({ type: 'detail-clear', protocolVersion: BRIDGE_PROTOCOL_VERSION });
  });

  it('round-trips: a stamped frame still parses as its unmodified payload union', async () => {
    const { sent, panel } = fakePanel();
    await postToWebview(panel as never, { type: 'last-dacpac-gone' }, silentLogger);
    const frame = sent[0];

    const parsed = ExtensionToWebviewMsgSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ type: 'last-dacpac-gone' });
    expect((frame as BridgeEnvelope).protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
  });

  it('stamps detail frames without disturbing their payload fields', async () => {
    const { sent, panel } = fakePanel();
    await postToDetail(panel as never, { type: 'table-stats-error', message: 'boom' }, silentLogger);

    const parsed = ExtensionToDetailMsgSchema.safeParse(sent[0]);
    expect(parsed.success && parsed.data).toEqual({ type: 'table-stats-error', message: 'boom' });
  });

  /** The webview-side rule: host always stamps, so absent or different is a rejection. */
  const webviewAccepts = (frame: unknown) =>
    (frame as BridgeEnvelope | undefined)?.protocolVersion === BRIDGE_PROTOCOL_VERSION;

  /** The host-side rule: webview→host frames are unstamped, so only a wrong version is a skew. */
  const hostAccepts = (frame: unknown) => {
    const v = (frame as BridgeEnvelope | undefined)?.protocolVersion;
    return v === undefined || v === BRIDGE_PROTOCOL_VERSION;
  };

  it('rejects a mismatched version at a webview receive site', async () => {
    const { sent, panel } = fakePanel();
    await postToWebview(panel as never, { type: 'detail-closed' }, silentLogger);

    expect(webviewAccepts(sent[0])).toBe(true);
    expect(webviewAccepts({ type: 'detail-closed', protocolVersion: BRIDGE_PROTOCOL_VERSION + 1 })).toBe(false);
    expect(webviewAccepts({ type: 'detail-closed' })).toBe(false);
  });

  it('rejects only a mismatched version at a host receive site', () => {
    expect(hostAccepts({ type: 'ready' })).toBe(true);
    expect(hostAccepts({ type: 'ready', protocolVersion: BRIDGE_PROTOCOL_VERSION })).toBe(true);
    expect(hostAccepts({ type: 'ready', protocolVersion: BRIDGE_PROTOCOL_VERSION + 1 })).toBe(false);
    expect(hostAccepts({ type: 'ready', protocolVersion: 'v1' })).toBe(false);
  });

  it('keeps the protocol version a positive integer so comparisons stay exact', () => {
    expect(Number.isInteger(BRIDGE_PROTOCOL_VERSION)).toBe(true);
    expect(BRIDGE_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('validateBridgeFrame accepts a stamped frame and names the reason for a rejected one', () => {
    const ok = validateBridgeFrame(ExtensionToWebviewMsgSchema, { type: 'detail-closed', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    expect(ok.ok).toBe(true);
    const skew = validateBridgeFrame(ExtensionToWebviewMsgSchema, { type: 'detail-closed', protocolVersion: BRIDGE_PROTOCOL_VERSION + 1 });
    expect(skew).toMatchObject({ ok: false, reason: 'version', msgType: 'detail-closed' });
    expect(validateBridgeFrame(ExtensionToWebviewMsgSchema, { type: 'not-a-message' })).toMatchObject({ ok: false, reason: 'parse' });
  });

  it('accepts a focus-object request only with both schema and name', () => {
    const frame = { type: 'focus-object', schema: 'Sales', name: 'Customer', protocolVersion: BRIDGE_PROTOCOL_VERSION };
    expect(validateBridgeFrame(ExtensionToWebviewMsgSchema, frame)).toMatchObject({ ok: true, data: { type: 'focus-object', schema: 'Sales', name: 'Customer' } });
    expect(validateBridgeFrame(ExtensionToWebviewMsgSchema, { ...frame, name: undefined })).toMatchObject({ ok: false, reason: 'parse' });
  });

  it('accepts a payload-free reload-source request', () => {
    expect(validateBridgeFrame(ExtensionToWebviewMsgSchema, { type: 'reload-source', protocolVersion: BRIDGE_PROTOCOL_VERSION })).toMatchObject({ ok: true, data: { type: 'reload-source' } });
  });

  it('routes every webview receive site through validateBridgeFrame — one home for the check', () => {
    const sites = ['../../../src/components/App.tsx', '../../../src/components/GraphCanvas.tsx', '../../../src/detail/DetailApp.tsx', '../../../src/hooks/useDacpacLoader.ts'];
    for (const site of sites) {
      const source = readFileSync(new URL(site, import.meta.url), 'utf8');
      expect(source, site).toContain('validateBridgeFrame(');
      expect(source, site).not.toMatch(/MsgSchema\.safeParse\(/u);
    }
  });
});
