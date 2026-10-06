/**
 * Bridge node-field contract.
 *
 * Zod strips undeclared keys, and the host posts the parsed copy, so a `LineageNode` field the
 * boundary schema does not declare is silently dropped from every node that crosses the bridge.
 * The type check fails `typecheck:tests` when `LineageNode` gains a field the schema lacks; the
 * runtime check proves a fully populated node survives the host's send path unchanged.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { postToDetail } from '../../../src/bridge/host';
import { ExtensionToDetailMsgSchema, type ExtensionToDetailMsg } from '../../../src/engine/shared/bridgeContract';
import type { LineageNode } from '../../../src/engine/types';
import { Logger } from '../../../src/utils/log';

type BridgeNode = Extract<ExtensionToDetailMsg, { type: 'detail-update' }>['node'];

const silentLogger = Logger.create(
  { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} } as never,
  'Bridge',
);

describe('bridge node fields', () => {
  it('declares every LineageNode field on the boundary schema', () => {
    expectTypeOf<keyof BridgeNode>().toEqualTypeOf<keyof LineageNode>();
  });

  it('keeps external-reference and foreign-key fields through a host send', async () => {
    const sent: unknown[] = [];
    const panel = { webview: { postMessage: (m: unknown) => { sent.push(m); return Promise.resolve(true); } } };
    const node: LineageNode = {
      id: '[dbo].[Orders]',
      schema: 'dbo',
      name: 'Orders',
      fullName: '[dbo].[Orders]',
      type: 'table',
      hasDdl: true,
      hasColumns: true,
      columns: [{ name: 'CustomerId', type: 'int', nullable: 'NO', extra: '' }],
      fks: [{ name: 'FK_Orders_Customers', columns: ['CustomerId'], refSchema: 'dbo', refTable: 'Customers', refColumns: ['Id'], onDelete: 'NO ACTION' }],
      externalType: 'db',
      externalUrl: 'https://example.invalid/orders.parquet',
      externalDatabase: 'Sales',
    };

    await postToDetail(panel as never, { type: 'detail-update', node, config: {} }, silentLogger);

    expect(sent).toHaveLength(1);
    expect((sent[0] as { node: unknown }).node).toEqual(node);
  });
  it('accepts a node without definitionUnreadable and rejects a non-boolean one', () => {
    const node = { id: 'a', schema: 'dbo', name: 'a', fullName: '[dbo].[a]', type: 'procedure' };
    const parse = (n: object) => ExtensionToDetailMsgSchema.safeParse({ type: 'detail-update', node: n, config: {} }).success;
    expect(parse(node)).toBe(true);
    expect(parse({ ...node, definitionUnreadable: 'yes' })).toBe(false);
  });
});
