/** Phase-one previews preserve checked identifier policy and reject malformed metadata at IPC. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ExtensionToWebviewMsgSchema, type ExtensionToWebviewMsg } from '../../../src/engine/shared/bridgeContract';
import type { SchemaPreview } from '../../../src/engine/types';

describe.each(['db-schema-preview', 'dacpac-schema-preview'] as const)('%s metadata boundary', (type) => {
  const preview: SchemaPreview = {
    identifierCaseSensitive: true,
    schemas: ['Sales', 'sales'].map(name => ({ name, nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } })),
    totalObjects: 2,
  };
  const message = { type, preview, config: {}, sourceName: 'Synthetic catalog' };

  it('declares every preview field and preserves checked CS schema twins', () => {
    type BoundaryPreview = Extract<ExtensionToWebviewMsg, { type: typeof type }>['preview'];
    expectTypeOf<BoundaryPreview['identifierCaseSensitive']>().toEqualTypeOf<SchemaPreview['identifierCaseSensitive']>();
    expect(ExtensionToWebviewMsgSchema.parse(message)).toEqual(message);
  });

  it('retains additional preview metadata from the existing flexible payload', () => {
    const original = { ...message, preview: { ...preview, sourceMetadata: 'synthetic' } };
    expect(ExtensionToWebviewMsgSchema.parse(original)).toEqual(original);
  });

  it('preserves the absent-policy legacy CI payload', () => {
    const { identifierCaseSensitive: _policy, ...legacy } = preview;
    const original = { ...message, preview: legacy };
    expect(ExtensionToWebviewMsgSchema.parse(original)).toEqual(original);
  });

  it.each(['true', 1, null])('rejects malformed policy %s', (identifierCaseSensitive) => {
    expect(ExtensionToWebviewMsgSchema.safeParse({ ...message, preview: { ...preview, identifierCaseSensitive } }).success).toBe(false);
  });
});
