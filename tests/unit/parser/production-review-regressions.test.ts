/** Regression cases for parser and DACPAC boundary defects found in the production review. */
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractDacpac,
  extractSchemaPreview,
} from '../../../src/engine/dacpacExtractor';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import {
  extractExternalRefs,
  loadRules,
  parseSqlBody,
} from '../../../src/engine/sqlBodyParser';
import { loadParseRules } from '../helpers/testUtils';

beforeEach(() => {
  loadParseRules();
});
afterEach(() => {
  loadParseRules();
});

it('consumes external_ref rules only as external references', () => {
  expect(
    loadRules({
      rules: [
        {
          name: 'external_custom',
          priority: 50,
          category: 'external_ref',
          kind: 'file',
          pattern: '\\bFROM\\s+(dbo\\.\\w+)',
          flags: 'g',
        },
      ],
    }).loaded,
  ).toBe(1);
  const sql = 'SELECT * FROM dbo.FileSource;';
  expect(extractExternalRefs(sql)).toEqual([
    { url: 'dbo.FileSource', kind: 'file' },
  ]);
  expect(parseSqlBody(sql)).toEqual({
    sources: [],
    targets: [],
    execCalls: [],
    crossDbSources: [],
    crossDbTargets: [],
    mutations: [],
    unsupported: [],
  });
});

it.each([false, true])(
  'keeps unreadable procedure dependencies unresolved while retaining its callers (CS=%s)',
  (cs) => {
    const objects = [
      { fullName: 'dbo.Hidden', type: 'procedure' as const },
      {
        fullName: 'dbo.Caller',
        type: 'procedure' as const,
        bodyScript: 'EXEC dbo.Hidden;',
      },
    ];
    const model = buildModel(
      objects,
      [
        { sourceName: 'dbo.Hidden', targetName: 'Remote.dbo.Source' },
        { sourceName: 'dbo.Caller', targetName: 'dbo.Hidden' },
      ],
      objects,
      undefined,
      true,
      undefined,
      cs,
    );
    const hidden = normalizeName('dbo.Hidden', cs);
    expect(
      model.nodes.find((node) => node.id === hidden)?.definitionUnreadable,
    ).toBe(true);
    expect(model.nodes.some((node) => node.externalType === 'db')).toBe(false);
    expect(model.edges).toEqual([
      { source: normalizeName('dbo.Caller', cs), target: hidden, type: 'exec' },
    ]);
  },
);

describe('malformed model.xml cannot load a partial model', () => {
  it.each([
    '<DataSchemaModel><Model><Element Type="SqlTable" Name="[dbo].[Partial]">',
    '<DataSchemaModel><Model><Element Type="SqlTable" Name="[dbo].[Partial]"/></Wrong></DataSchemaModel>',
  ])('rejects invalid XML in full extraction and preview: %s', async (xml) => {
    const zip = new JSZip();
    zip.file('model.xml', xml);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(extractDacpac(bytes)).rejects.toThrow(
      'Failed to parse model.xml',
    );
    await expect(extractSchemaPreview(bytes)).rejects.toThrow(
      'Failed to parse model.xml',
    );
  });
});
