/**
 * Checked identifier metadata preserves case-sensitive twins; legacy and explicit CI stay
 * canonical.
 */
import { describe, expect, it } from 'vitest';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { resolveModelNodeId } from '../../../src/engine/shared/nodeIdResolution';
import type { ExtractedObject } from '../../../src/engine/shared/types';
import JSZip from 'jszip';
import {
  extractDacpac,
  extractSchemaPreview,
  extractDacpacFiltered,
} from '../../../src/engine/dacpacExtractor';
import {
  buildModelFromDmv,
  buildSchemaPreview,
} from '../../../src/engine/dmvExtractor';
import type { SimpleExecuteResult } from '../../../src/types/database';
import { loadParseRules } from '../helpers/testUtils';
const twins: ExtractedObject[] = [
  {
    fullName: '[dbo].[CaseTab]',
    type: 'table',
    columns: [{ name: 'Upper', type: 'int', nullable: 'No', extra: '' }],
  },
  {
    fullName: '[dbo].[casetab]',
    type: 'table',
    columns: [{ name: 'lower', type: 'int', nullable: 'No', extra: '' }],
  },
  { fullName: '[dbo].[Reader]', type: 'view' },
];
describe('checked identifier comparison', () => {
  it('preserves exact CS nodes, catalog, directed dependencies and column ownership', () => {
    const model = buildModel(
      twins,
      [
        { sourceName: '[dbo].[Reader]', targetName: '[dbo].[CaseTab]' },
        { sourceName: '[dbo].[Reader]', targetName: '[dbo].[casetab]' },
      ],
      twins,
      undefined,
      true,
      undefined,
      true,
    );
    expect(model.identifierCaseSensitive).toBe(true);
    expect(model.nodes.map((n) => n.id)).toEqual([
      '[dbo].[CaseTab]',
      '[dbo].[casetab]',
      '[dbo].[Reader]',
    ]);
    expect(Object.keys(model.catalog)).toEqual([
      '[dbo].[CaseTab]',
      '[dbo].[casetab]',
      '[dbo].[Reader]',
    ]);
    expect(model.edges.map((e) => [e.source, e.target])).toEqual([
      ['[dbo].[CaseTab]', '[dbo].[Reader]'],
      ['[dbo].[casetab]', '[dbo].[Reader]'],
    ]);
    expect(model.nodes[0].columns?.map((c) => c.name)).toEqual(['Upper']);
    expect(model.nodes[1].columns?.map((c) => c.name)).toEqual(['lower']);
  });
  it('default and explicit CI merge code casing as the same object', () => {
    for (const flag of [undefined, false]) {
      const model = buildModel(
        twins,
        [],
        twins,
        undefined,
        true,
        undefined,
        flag,
      );
      expect(model.nodes.map((n) => n.id)).toEqual([
        '[dbo].[casetab]',
        '[dbo].[reader]',
      ]);
      expect(normalizeName('[DBO].[CaseTab]')).toBe('[dbo].[casetab]');
    }
  });
  it('CS resolver accepts exact quoted identity and rejects guessed case and malformed input', () => {
    const map = new Map([
      ['[dbo].[CaseTab]', {}],
      ['[dbo].[casetab]', {}],
    ]);
    expect(resolveModelNodeId('dbo.CaseTab', map, true)).toBe(
      '[dbo].[CaseTab]',
    );
    expect(resolveModelNodeId('[dbo].[casetab]', map, true)).toBe(
      '[dbo].[casetab]',
    );
    expect(resolveModelNodeId('[DBO].[CaseTab]', map, true)).toBeNull();
    expect(resolveModelNodeId('', map, true)).toBeNull();
    expect(
      resolveModelNodeId('dbo.CaseTab', new Map([['[dbo].[casetab]', {}]])),
    ).toBe('[dbo].[casetab]');
  });
});

loadParseRules();
function rows(names: string[], values: string[][]): SimpleExecuteResult {
  return {
    columnInfo: names.map((columnName) => ({
      columnName,
      dataType: 'string',
      dataTypeName: 'varchar',
    })),
    rowCount: values.length,
    rows: values.map((row) =>
      row.map((displayValue) => ({
        displayValue,
        isNull: displayValue === '',
      })),
    ),
  };
}
function dmv(
  style?: string,
  collation = 'Latin1_General_100_CS_AS',
  platformInfo?: SimpleExecuteResult,
) {
  return buildModelFromDmv({
    nodes: rows(
      ['schema_name', 'object_name', 'type_code', 'body_script'],
      [
        ['dbo', 'CaseTab', 'U', ''],
        ['dbo', 'casetab', 'U', ''],
      ],
    ),
    columns: rows(
      [
        'schema_name',
        'table_name',
        'ordinal',
        'column_name',
        'type_name',
        'max_length',
        'precision',
        'scale',
        'is_nullable',
        'is_identity',
        'is_computed',
      ],
      [
        ['dbo', 'CaseTab', '1', 'Upper', 'int', '4', '10', '0', '0', '0', '0'],
        ['dbo', 'casetab', '1', 'lower', 'int', '4', '10', '0', '0', '0', '0'],
      ],
    ),
    dependencies: rows(
      [
        'referencing_schema',
        'referencing_name',
        'referenced_schema',
        'referenced_name',
      ],
      [],
    ),
    ...(platformInfo
      ? { platformInfo }
      : style === undefined
        ? {}
        : {
            platformInfo: rows(
              ['identifier_collation', 'identifier_comparison_style'],
              [[collation, style]],
            ),
          }),
  });
}
it('DMV requires checked catalog comparison metadata, preserving CS metadata ownership', () => {
  const cs = dmv('196608');
  expect(cs.identifierCaseSensitive).toBe(true);
  expect(cs.nodes.map((n) => n.id)).toEqual([
    '[dbo].[CaseTab]',
    '[dbo].[casetab]',
  ]);
  expect(cs.nodes.map((n) => n.columns?.map((c) => c.name))).toEqual([
    ['Upper'],
    ['lower'],
  ]);
  for (const model of [
    dmv(),
    dmv('196609'),
    dmv(''),
    dmv('garbled'),
    dmv('0', ''),
  ])
    expect(model.nodes).toHaveLength(1);
});
async function archive(
  rootFlag?: string,
  catalog?: string,
  azure = false,
  containment?: string,
  additionalElements = '',
) {
  const zip = new JSZip();
  zip.file(
    'model.xml',
    `<DataSchemaModel DspName="Microsoft.Data.Tools.Schema.Sql.${azure ? 'SqlAzureV12' : 'Sql170'}DatabaseSchemaProvider" ${rootFlag === undefined ? '' : `CollationCaseSensitive="${rootFlag}"`}><Model><Element Type="SqlDatabaseOptions"><Property Name="Collation" Value="Latin1_General_100_CS_AS"/>${catalog === undefined ? '' : `<Property Name="CatalogCollation" Value="${catalog}"/>`}${containment === undefined ? '' : `<Property Name="Containment" Value="${containment}"/>`}</Element><Element Type="SqlTable" Name="[dbo].[CaseTab]"/><Element Type="SqlTable" Name="[dbo].[casetab]"/>${additionalElements}</Model></DataSchemaModel>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}
it('DACPAC checked model comparator survives full and phase-two extraction; missing/CI metadata does not infer twins', async () => {
  const buffer = await archive('True');
  const model = await extractDacpac(buffer);
  expect(model.identifierCaseSensitive).toBe(true);
  expect(model.nodes.map((n) => n.id)).toEqual([
    '[dbo].[CaseTab]',
    '[dbo].[casetab]',
  ]);
  const preview = await extractSchemaPreview(buffer);
  expect(preview.preview.totalObjects).toBe(2);
  expect(preview.preview.identifierCaseSensitive).toBe(true);
  expect(
    extractDacpacFiltered(
      preview.elements,
      new Set(['dbo']),
      preview.dspName,
      undefined,
      undefined,
      { identifierCaseSensitive: preview.identifierCaseSensitive },
    ).nodes,
  ).toHaveLength(2);
  for (const flag of [undefined, 'False', 'true', 'garbled'])
    expect((await extractDacpac(await archive(flag))).nodes).toHaveLength(1);
});

describe('identifier comparison follows checked catalog metadata', () => {
  it('keeps CI when the effective catalog metadata is absent or contradictory', () => {
    for (const values of [
      [],
      [
        ['Latin1_General_100_CS_AS', '196608'],
        ['Latin1_General_100_CI_AS', '196609'],
      ],
    ]) {
      const platform = rows(
        ['identifier_collation', 'identifier_comparison_style'],
        values,
      );
      expect(dmv(undefined, undefined, platform).nodes).toHaveLength(1);
      expect(
        buildSchemaPreview(
          rows(
            ['schema_name', 'type_code', 'object_count'],
            [
              ['Sales', 'U', '1'],
              ['sales', 'U', '1'],
            ],
          ),
          platform,
        ).schemas,
      ).toHaveLength(1);
    }
  });
});
