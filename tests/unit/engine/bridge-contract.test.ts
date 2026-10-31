/** Bridge frame boundary: a frame from the other side is validated before use; a version skew or a malformed payload is rejected. */
import { describe, expect, it } from 'vitest';

import {
  BRIDGE_PROTOCOL_VERSION,
  ExtensionToDetailMsgSchema,
  ExtensionToWebviewMsgSchema,
  validateBridgeFrame,
} from '../../../src/engine/shared/bridgeContract';

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
