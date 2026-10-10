import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { createSavedReferenceResolver } from '../../../src/engine/shared/nodeIdResolution';
import { allocateExternalFileIds } from '../../../src/engine/externalFileIdentity';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(loadParseRules);
const first = 'https://example.test/Aa.csv', second = 'https://example.test/BB.csv';
const short = '[__ext__].[6b68923e]';
const procedure = (url: string, i: number) => ({ fullName: `[dbo].[reader${i}]`, type: 'procedure' as const,
  bodyScript: `SELECT * FROM OPENROWSET(BULK '${url}', FORMAT='CSV') AS src;` });
const model = (...urls: string[]) => buildModel(urls.map(procedure), []);
const file = (urls: string[], url = first) => model(...urls).nodes.find(node => node.externalUrl === url)!;
const oldLong = (url: string) => `${short.slice(0, -1)}_url_${Array.from({ length: url.length }, (_, i) => url.charCodeAt(i).toString(16).padStart(4, '0')).join('')}]`;

describe('stable external-file references', () => {
  it('keeps a current saved identity when another colliding URL is loaded or removed', () => {
    const saved = file([first]).id;
    const expanded = model(second, first);
    expect(expanded.nodes.find(node => node.externalUrl === first)?.id).toBe(saved);
    expect(createSavedReferenceResolver(expanded, 2).nodeId(saved)).toBe(saved);
    expect(createSavedReferenceResolver(model(first), 2).nodeId(saved)).toBe(saved);
  });
  it.each([undefined, 2] as const)('rejects ambiguous old short references (encoding=%s)', version => {
    expect(createSavedReferenceResolver(model(first, second), version).nodeId(short)).toBeNull();
  });
  it.each([undefined, 2] as const)('restores old injective URL references even after a collision disappears (encoding=%s)', version => {
    const resolver = createSavedReferenceResolver(model(first), version);
    expect(resolver.nodeId(oldLong(first))).toBe(file([first]).id);
    expect(resolver.nodeId(oldLong(first).replace(/]$/, '__]'))).toBe(file([first]).id);
    expect(resolver.nodeId(oldLong(second))).toBeNull();
  });
  it.each([false, true])('never redirects old references to a catalog owner (CS=%s)', cs => {
    const current = buildModel([{ fullName: short, type: 'table' }, procedure(first, 0)], [], undefined, undefined, true, undefined, cs);
    expect(createSavedReferenceResolver(current, 2).nodeId(short)).toBeNull();
  });
  it('refuses a generated ID already owned by a real catalog object', () => {
    const reserved = file([first]).id;
    expect(() => buildModel([{ fullName: reserved, type: 'table' }, procedure(first, 0)], [])).toThrow('External-file identity conflicts');
  });
  it.each([oldLong(first), oldLong(first).replace(/]$/, '_]')])('refuses ambiguous saved URL spelling %s', reserved => {
    const current = buildModel([{ fullName: reserved, type: 'table' }, procedure(first, 0)], []);
    expect(createSavedReferenceResolver(current, 2).nodeId(reserved)).toBeNull();
  });
  it('preserves exact URL case and unmatched UTF-16 code units', () => {
    const urls = [first, first.toLowerCase(), 'https://example.test/\ud800', 'https://example.test/\ud801'];
    const allocated = allocateExternalFileIds([...urls, first], new Set());
    expect(allocated.size).toBe(urls.length);
    expect(new Set(allocated.values()).size).toBe(urls.length);
    for (const id of allocated.values()) expect(id).toMatch(/^\[__ext__\]\.\[[0-9a-f]{64}\]$/);
  });
  it('restores a suffixed old file ID when the unsuffixed spelling belongs to a catalog object', () => {
    const current = buildModel([{ fullName: oldLong(first), type: 'table' }, procedure(first, 0)], []);
    const resolver = createSavedReferenceResolver(current, 2);
    expect(resolver.nodeId(oldLong(first))).toBeNull();
    expect(resolver.nodeId(oldLong(first).replace(/]$/, '_]'))).toBe(current.nodes.find(node => node.externalType === 'file')!.id);
  });
});
