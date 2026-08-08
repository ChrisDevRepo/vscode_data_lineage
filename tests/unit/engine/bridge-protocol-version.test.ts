/**
 * Bridge protocol-envelope contract.
 *
 * Proves the two halves of the version tripwire independently: the host's single send choke point
 * stamps every outgoing frame, and a receive site rejects a frame whose version disagrees. The
 * receive-site checks are three lines of inline logic at four call sites, so they are exercised here
 * through the same predicate shape rather than by booting React — what must not regress is the
 * decision (stamped-and-equal passes, anything else is rejected), not the JSX around it.
 */
import { describe, expect, it } from 'vitest';

import { postToDetail, postToWebview } from '../../../src/bridge/host';
import {
  BRIDGE_PROTOCOL_VERSION,
  ExtensionToDetailMsgSchema,
  ExtensionToWebviewMsgSchema,
  type BridgeEnvelope,
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
    await postToWebview(panel as never, { type: 'auto-visualize-start' }, silentLogger);
    const frame = sent[0];

    // The stamp lives on the envelope, so the payload unions are untouched: Zod strips the extra
    // key and yields exactly the message the sender passed.
    const parsed = ExtensionToWebviewMsgSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ type: 'auto-visualize-start' });
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
    // An unstamped frame means the host bundle predates the envelope — also a rejection.
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
});
