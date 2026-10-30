/**
 * Bridge contract tests:
 * 1. Protocol envelope & version stamping across host/webview/detail.
 * 2. Node fields boundary schema & host transmission.
 * 3. parseStats & spDetails strict validation.
 * 4. Phase-one schema previews (db/dacpac).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { postToDetail, postToWebview } from '../../../src/bridge/host';
import {
  BRIDGE_PROTOCOL_VERSION,
  ExtensionToDetailMsgSchema,
  ExtensionToWebviewMsgSchema,
  type BridgeEnvelope,
  type ExtensionToDetailMsg,
  type ExtensionToWebviewMsg,
  validateBridgeFrame,
} from '../../../src/engine/shared/bridgeContract';
import type { LineageNode, SchemaPreview } from '../../../src/engine/types';
import { Logger } from '../../../src/utils/log';

type BridgeNode = Extract<
  ExtensionToDetailMsg,
  { type: 'detail-update' }
>['node'];

function fakePanel() {
  const sent: unknown[] = [];
  return {
    sent,
    panel: {
      webview: {
        postMessage: (m: unknown) => {
          sent.push(m);
          return Promise.resolve(true);
        },
      },
    },
  };
}

const silentLogger = Logger.create(
  {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
  } as never,
  'Bridge',
);

describe('bridge protocol envelope', () => {
  it('stamps the protocol version on every host→webview frame', async () => {
    const { sent, panel } = fakePanel();
    await postToWebview(
      panel as never,
      { type: 'detail-closed' },
      silentLogger,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'detail-closed',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
  });

  it('stamps the protocol version on every host→detail frame', async () => {
    const { sent, panel } = fakePanel();
    await postToDetail(panel as never, { type: 'detail-clear' }, silentLogger);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'detail-clear',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
  });

  it('round-trips: a stamped frame still parses as its unmodified payload union', async () => {
    const { sent, panel } = fakePanel();
    await postToWebview(
      panel as never,
      { type: 'last-dacpac-gone' },
      silentLogger,
    );
    const frame = sent[0];

    const parsed = ExtensionToWebviewMsgSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ type: 'last-dacpac-gone' });
    expect((frame as BridgeEnvelope).protocolVersion).toBe(
      BRIDGE_PROTOCOL_VERSION,
    );
  });

  it('stamps detail frames without disturbing their payload fields', async () => {
    const { sent, panel } = fakePanel();
    await postToDetail(
      panel as never,
      {
        type: 'table-stats-error',
        objectRef: { schema: 'dbo', objectName: 'Orders' },
        message: 'boom',
      },
      silentLogger,
    );

    const parsed = ExtensionToDetailMsgSchema.safeParse(sent[0]);
    expect(parsed.success && parsed.data).toEqual({
      type: 'table-stats-error',
      objectRef: { schema: 'dbo', objectName: 'Orders' },
      message: 'boom',
    });
  });

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

  it('accepts a focus-object request only with both schema and name', () => {
    const frame = {
      type: 'focus-object',
      schema: 'Sales',
      name: 'Customer',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    };
    expect(
      validateBridgeFrame(ExtensionToWebviewMsgSchema, frame),
    ).toMatchObject({
      ok: true,
      data: { type: 'focus-object', schema: 'Sales', name: 'Customer' },
    });
    expect(
      validateBridgeFrame(ExtensionToWebviewMsgSchema, {
        ...frame,
        name: undefined,
      }),
    ).toMatchObject({ ok: false, reason: 'parse' });
  });

  it('accepts a payload-free reload-source request', () => {
    expect(
      validateBridgeFrame(ExtensionToWebviewMsgSchema, {
        type: 'reload-source',
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
      }),
    ).toMatchObject({ ok: true, data: { type: 'reload-source' } });
  });

  it('routes every webview receive site through validateBridgeFrame — one home for the check', () => {
    const sites = [
      '../../../src/components/App.tsx',
      '../../../src/components/GraphCanvas.tsx',
      '../../../src/detail/DetailApp.tsx',
      '../../../src/hooks/useDacpacLoader.ts',
    ];
    for (const site of sites) {
      const source = readFileSync(new URL(site, import.meta.url), 'utf8');
      expect(source, site).toContain('validateBridgeFrame(');
      expect(source, site).not.toMatch(/MsgSchema\.safeParse\(/u);
    }
  });
});

describe('bridge node fields', () => {
  it('declares every LineageNode field on the boundary schema', () => {
    expectTypeOf<keyof BridgeNode>().toEqualTypeOf<keyof LineageNode>();
  });

  it('keeps external-reference and foreign-key fields through a host send', async () => {
    const { sent, panel } = fakePanel();
    const node: LineageNode = {
      id: '[dbo].[Orders]',
      schema: 'dbo',
      name: 'Orders',
      fullName: '[dbo].[Orders]',
      type: 'table',
      hasDdl: true,
      hasColumns: true,
      columns: [{ name: 'CustomerId', type: 'int', nullable: 'NO', extra: '' }],
      fks: [
        {
          name: 'FK_Orders_Customers',
          columns: ['CustomerId'],
          refSchema: 'dbo',
          refTable: 'Customers',
          refColumns: ['Id'],
          onDelete: 'NO ACTION',
        },
      ],
      externalType: 'db',
      externalUrl: 'https://example.invalid/orders.parquet',
      externalDatabase: 'Sales',
    };

    await postToDetail(
      panel as never,
      { type: 'detail-update', node, config: {} },
      silentLogger,
    );

    expect(sent).toHaveLength(1);
    expect((sent[0] as { node: unknown }).node).toEqual(node);
  });

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

describe('bridge parseStats schema validation', () => {
  it('validates spDetails strictly and correctly', () => {
    const validMessage = {
      type: 'db-model',
      sourceName: 'test',
      config: { showExcludedNodes: false, layoutOrientation: 'TB' },
      model: {
        nodes: [],
        edges: [],
        schemas: [],
        neighborIndex: {},
        catalog: {},
        parseStats: {
          objects: 1,
          lines: 10,
          parsedRefs: 2,
          resolvedEdges: 2,
          droppedRefs: [],
          spDetails: [
            {
              name: 'test_sp',
              inCount: 1,
              outCount: 1,
              inRefs: [],
              outRefs: [],
              unrelated: [],
              excluded: [],
            },
          ],
        },
      },
    };

    const validResult = validateBridgeFrame(ExtensionToWebviewMsgSchema, {
      ...validMessage,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
    expect(validResult.ok).toBe(true);

    const invalidMessage = {
      type: 'db-model',
      sourceName: 'test',
      config: { showExcludedNodes: false, layoutOrientation: 'TB' },
      model: {
        nodes: [],
        edges: [],
        schemas: [],
        neighborIndex: {},
        catalog: {},
        parseStats: {
          objects: 1,
          lines: 10,
          parsedRefs: 2,
          resolvedEdges: 2,
          droppedRefs: [],
          spDetails: [
            {
              name: 'test_sp',
              inCount: 1,
              outCount: 1,
              unrelated: [],
              extraProp: 'should-fail', // strict() should reject this
            },
          ],
        },
      },
    };

    const invalidResult = validateBridgeFrame(ExtensionToWebviewMsgSchema, {
      ...invalidMessage,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
    expect(invalidResult.ok).toBe(false);
  });
});

describe.each(['db-schema-preview', 'dacpac-schema-preview'] as const)(
  '%s metadata boundary',
  (type) => {
    const preview: SchemaPreview = {
      identifierCaseSensitive: true,
      schemas: ['Sales', 'sales'].map((name) => ({
        name,
        nodeCount: 1,
        types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 },
      })),
      totalObjects: 2,
    };
    const message = {
      type,
      preview,
      config: {},
      sourceName: 'Synthetic catalog',
    };

    it('declares every preview field and preserves checked CS schema twins', () => {
      type BoundaryPreview = Extract<
        ExtensionToWebviewMsg,
        { type: typeof type }
      >['preview'];
      expectTypeOf<BoundaryPreview['identifierCaseSensitive']>().toEqualTypeOf<
        SchemaPreview['identifierCaseSensitive']
      >();
      expect(ExtensionToWebviewMsgSchema.parse(message)).toEqual(message);
    });

    it('rejects additional preview metadata for the strict payload', () => {
      const original = {
        ...message,
        preview: { ...preview, sourceMetadata: 'synthetic' },
      };
      expect(ExtensionToWebviewMsgSchema.safeParse(original).success).toBe(
        false,
      );
    });

    it('preserves the absent-policy legacy CI payload', () => {
      const { identifierCaseSensitive: _policy, ...legacy } = preview;
      const original = { ...message, preview: legacy };
      expect(ExtensionToWebviewMsgSchema.parse(original)).toEqual(original);
    });

    it.each(['true', 1, null])(
      'rejects malformed policy %s',
      (identifierCaseSensitive) => {
        expect(
          ExtensionToWebviewMsgSchema.safeParse({
            ...message,
            preview: { ...preview, identifierCaseSensitive },
          }).success,
        ).toBe(false);
      },
    );
  },
);
