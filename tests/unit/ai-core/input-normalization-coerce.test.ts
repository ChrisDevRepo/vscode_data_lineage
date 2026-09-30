import { describe, expect, it } from 'vitest';
import { coerceStringifiedArguments } from '../../../src/ai/support/inputNormalization';

/**
 * Pins the schema-driven JSON-string decode at the model boundary: a string is decoded only where
 * the declared types accept the decoded kind, and a `null` decode needs a declared `null` type.
 */
const nullableArray = { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] };

describe('coerceStringifiedArguments', () => {
  it('decodes a JSON-string null where the schema declares null', () => {
    const schema = { type: 'object', properties: { entry: { type: 'string' }, targetColumns: nullableArray } };
    const result = coerceStringifiedArguments({ entry: 'discovery', targetColumns: 'null' }, schema);
    expect(result.value).toEqual({ entry: 'discovery', targetColumns: null });
    expect(result.paths).toEqual(['targetColumns']);
  });

  it('decodes a JSON-string array where the schema declares a nullable array', () => {
    const schema = { type: 'object', properties: { targetColumns: nullableArray } };
    const result = coerceStringifiedArguments({ targetColumns: '["A","B"]' }, schema);
    expect(result.value).toEqual({ targetColumns: ['A', 'B'] });
    expect(result.paths).toEqual(['targetColumns']);
  });

  it('keeps the string "null" on a field that declares string', () => {
    const schema = { type: 'object', properties: { name: { anyOf: [{ type: 'string' }, { type: 'null' }] } } };
    const input = { name: 'null' };
    const result = coerceStringifiedArguments(input, schema);
    expect(result.value).toBe(input);
    expect(result.paths).toEqual([]);
  });

  it('keeps the string "null" on a non-nullable array field so schema validation rejects it', () => {
    const schema = { type: 'object', properties: { targetColumns: { type: 'array', items: { type: 'string' } } } };
    const input = { targetColumns: 'null' };
    const result = coerceStringifiedArguments(input, schema);
    expect(result.value).toBe(input);
    expect(result.paths).toEqual([]);
  });
});
