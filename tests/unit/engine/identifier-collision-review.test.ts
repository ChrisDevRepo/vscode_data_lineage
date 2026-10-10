/** Escaped identifiers and colliding external URLs retain separate object identities. */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { resolveModelNodeId } from '../../../src/engine/shared/nodeIdResolution';
import { getObjectDetail } from '../../../src/ai/tools/tools';
import { loadParseRules } from '../helpers/testUtils';
import { stripBrackets } from '../../../src/utils/sql';

beforeAll(loadParseRules);
const escaped = '[dbo].[a]]b]', plain = '[dbo].[ab]', reader = '[dbo].[reader]';
const table = (fullName: string) => ({ fullName, type: 'table' as const });
const procedure = (fullName: string, bodyScript: string) => ({ fullName, type: 'procedure' as const, bodyScript });

it.each([['"a]]b"', 'a]]b'], ['[a""b]', 'a""b']])('unescapes only the delimiter used by %s', (raw, decoded) => {
  expect(stripBrackets(raw)).toBe(decoded);
});

describe.each([false, true])('escaped identifier ownership (CS=%s)', cs => {
  it.each(['[dbo].[a]]b]', '"dbo"."a]b"'])('quotes %s without losing its literal bracket', raw => {
    expect(normalizeName(raw, cs)).toBe(escaped);
    expect(normalizeName(normalizeName(raw, cs), cs)).toBe(escaped);
  });
  it('keeps ordinary identifiers and the case policy unchanged', () => {
    expect(normalizeName('DBO.Ab', cs)).toBe(cs ? '[DBO].[Ab]' : plain);
    expect(normalizeName('[dbo].[a.b]', cs)).toBe('[dbo].[a.b]');
  });
  it.each(['SELECT * FROM [dbo].[a]]b];', 'SELECT * FROM "dbo"."a]b";'])('returns the exact read identity for %s', sql => {
    expect(parseSqlBody(sql, undefined, cs).sources).toEqual([escaped]);
  });
  it('connects a qualified mutation to its own catalog twin', () => {
    const model = buildModel([table(escaped), table(plain), procedure(reader, `UPDATE ${escaped} SET ID=1; SELECT * FROM ${plain};`)],
      [{ sourceName: reader, targetName: escaped }, { sourceName: reader, targetName: plain }], undefined, undefined, true, undefined, cs);
    expect(model.nodes.map(node => node.id)).toEqual([escaped, plain, reader]);
    expect(model.catalog[escaped]?.name).toBe('a]b');
    expect(model.edges).toEqual(expect.arrayContaining([
      { source: reader, target: escaped, type: 'body' }, { source: plain, target: reader, type: 'body' },
    ]));
    expect(model.edges).toHaveLength(2);
  });
  it('resolves current tool requests to the correct bracketed and unescaped objects', () => {
    const model = buildModel([table(escaped), table(plain)], [], undefined, undefined, true, undefined, cs);
    expect(getObjectDetail(model, '"dbo"."a]b"')).toMatchObject({ id: escaped, name: 'a]b' });
    expect(getObjectDetail(model, plain)).toMatchObject({ id: plain, name: 'ab' });
  });
  it('does not treat a valid current canonical ID as a legacy alias', () => {
    const doubleBracket = '[dbo].[a]]]]b]';
    const nodeMap = new Map([[escaped, {}], [doubleBracket, {}]]);
    expect(resolveModelNodeId(escaped, nodeMap, cs)).toBe(escaped);
    expect(resolveModelNodeId('"dbo"."a]]b"', nodeMap, cs)).toBe(doubleBracket);
  });
});

const firstUrl = 'https://example.test/Aa.csv';
const secondUrl = 'https://example.test/BB.csv';
// These real URLs have the same polynomial-31 signed 32-bit hash, -1802015294.
const oldId = '[__ext__].[6b68923e]';
const fileProc = (name: string, url: string) => procedure(name, `SELECT * FROM OPENROWSET(BULK '${url}', FORMAT='CSV') AS src;`);
const fileModel = (reverse = false) => buildModel((reverse
  ? [fileProc('[dbo].[second]', secondUrl), fileProc('[dbo].[first]', firstUrl)]
  : [fileProc('[dbo].[first]', firstUrl), fileProc('[dbo].[second]', secondUrl)]), []);

describe('external URL hash collisions', () => {
  it.each([false, true])('creates both exact URLs and their own consumers (reverse=%s)', reverse => {
    const model = fileModel(reverse);
    const files = model.nodes.filter(node => node.externalType === 'file');
    expect(new Set(files.map(node => node.externalUrl))).toEqual(new Set([firstUrl, secondUrl]));
    expect(new Set(files.map(node => node.id)).size).toBe(2);
    for (const [url, consumer] of [[firstUrl, '[dbo].[first]'], [secondUrl, '[dbo].[second]']]) {
      const id = files.find(node => node.externalUrl === url)!.id;
      expect(id).toMatch(/^\[__ext__\]\.\[[0-9a-f]{64}\]$/);
      expect(model.edges.filter(edge => edge.source === id)).toEqual([{ source: id, target: consumer, type: 'body' }]);
      expect(getObjectDetail(model, id)).toMatchObject({ id, external_url: url });
    }
    expect(files.map(node => node.id)).not.toContain(oldId);
  });
  it('allocates the same IDs independent of source order and repeated references', () => {
    const pairs = (reverse: boolean) => fileModel(reverse).nodes.filter(node => node.externalType === 'file').map(node => [node.externalUrl, node.id]).sort();
    expect(pairs(false)).toEqual(pairs(true));
    expect(pairs(false)).toHaveLength(2);
    const repeat = buildModel([fileProc(reader, firstUrl), fileProc('[dbo].[again]', firstUrl), fileProc('[dbo].[second]', secondUrl)], []);
    expect(repeat.nodes.filter(node => node.externalType === 'file').map(node => [node.externalUrl, node.id]).sort()).toEqual(pairs(false));
  });
  it('keeps a real catalog node occupying the short ID separate from the URL', () => {
    const model = buildModel([table(oldId), fileProc(reader, firstUrl)], []);
    const file = model.nodes.find(node => node.externalType === 'file');
    expect(file).toMatchObject({ externalUrl: firstUrl });
    expect(file?.id).not.toBe(oldId);
    expect(model.nodes.find(node => node.id === oldId)?.type).toBe('table');
    expect(model.edges).toEqual([{ source: file!.id, target: reader, type: 'body' }]);
  });
});
