/**
 * Dacpac extraction: declared objects, edges, constraints, platform, two-phase schema selection and
 * import errors.
 */

import { readFileSync } from 'fs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  extractDacpac,
  extractSchemaPreview,
  extractDacpacFiltered,
  parseDspPlatform,
} from '../../../src/engine/dacpacExtractor';
import {
  loadParseRules,
  testPath,
  loadAdventureWorksModel,
} from '../helpers/testUtils';

type Model = Awaited<ReturnType<typeof extractDacpac>>;

const AW = 'AdventureWorks2025_AI.dacpac';
const SDK = 'AdventureWorks_sdk-style.dacpac';

const OBJECT_TYPES: Record<string, string> = {
  SqlTable: 'table',
  SqlView: 'view',
  SqlProcedure: 'procedure',
  SqlScalarFunction: 'function',
  SqlInlineTableValuedFunction: 'function',
  SqlMultiStatementTableValuedFunction: 'function',
  SqlExternalTable: 'external',
};

type DeclaredObject = {
  schema: string;
  name: string;
  type: string;
  externalType?: 'et';
};

/**
 * Independent oracle: the top-level objects a fixture's model.xml declares,
 * read with a plain regex over the raw XML (not through the extractor).
 * Keys are the lower-cased two-part ids; values keep the XML spelling,
 * except that an external table is listed without a schema under the UI's
 * External group (NodeInfoBar groups by catalog schema, '' = External).
 */
async function declaredObjects(
  fixture: string,
): Promise<Record<string, DeclaredObject>> {
  const zip = await JSZip.loadAsync(readFileSync(testPath(fixture)));
  const xml = await zip.file('model.xml')!.async('string');
  const out: Record<string, DeclaredObject> = {};
  const re = /<Element Type="(Sql\w+)" Name="\[([^\]]+)\]\.\[([^\]]+)\]"/g;
  for (const [, xmlType, schema, name] of xml.matchAll(re)) {
    const type = OBJECT_TYPES[xmlType];
    if (!type) continue;
    out[`[${schema}].[${name}]`.toLowerCase()] =
      type === 'external'
        ? { schema: '', name, type, externalType: 'et' }
        : { schema, name, type };
  }
  return out;
}

const countBy = (values: string[]) =>
  values.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});

const edgeList = (model: Model) =>
  model.edges.map((e) => `${e.source} -> ${e.target}`).sort();

const bySchemaName = <T extends { name: string }>(list: T[]) =>
  [...list].sort((a, b) => a.name.localeCompare(b.name));

/**
 * Per-schema object counts hand-counted from AdventureWorks2025_AI model.xml
 * (SqlTable / SqlView / SqlProcedure / Sql*Function / SqlExternalTable).
 */
const AW_SCHEMAS = [
  {
    name: 'ai',
    nodeCount: 32,
    types: { table: 19, view: 5, procedure: 8, function: 0, external: 0 },
  },
  {
    name: 'dbo',
    nodeCount: 24,
    types: { table: 3, view: 1, procedure: 8, function: 12, external: 0 },
  },
  {
    name: 'ext',
    nodeCount: 1,
    types: { table: 0, view: 0, procedure: 0, function: 0, external: 1 },
  },
  {
    name: 'HumanResources',
    nodeCount: 15,
    types: { table: 6, view: 6, procedure: 3, function: 0, external: 0 },
  },
  {
    name: 'Person',
    nodeCount: 15,
    types: { table: 13, view: 2, procedure: 0, function: 0, external: 0 },
  },
  {
    name: 'Production',
    nodeCount: 28,
    types: { table: 25, view: 3, procedure: 0, function: 0, external: 0 },
  },
  {
    name: 'Purchasing',
    nodeCount: 7,
    types: { table: 5, view: 2, procedure: 0, function: 0, external: 0 },
  },
  {
    name: 'Sales',
    nodeCount: 26,
    types: { table: 19, view: 7, procedure: 0, function: 0, external: 0 },
  },
];

/** The HumanResources objects declared in AdventureWorks2025_AI model.xml. */
const AW_HR_IDS = [
  '[humanresources].[department]',
  '[humanresources].[employee]',
  '[humanresources].[employeedepartmenthistory]',
  '[humanresources].[employeepayhistory]',
  '[humanresources].[jobcandidate]',
  '[humanresources].[shift]',
  '[humanresources].[uspupdateemployeehireinfo]',
  '[humanresources].[uspupdateemployeelogin]',
  '[humanresources].[uspupdateemployeepersonalinfo]',
  '[humanresources].[vemployee]',
  '[humanresources].[vemployeedepartment]',
  '[humanresources].[vemployeedepartmenthistory]',
  '[humanresources].[vjobcandidate]',
  '[humanresources].[vjobcandidateeducation]',
  '[humanresources].[vjobcandidateemployment]',
];

/** Object ids per type, read from the SDK-style fixture's model.xml. */
const SDK_IDS = {
  function: [
    '[core].[fn_calc_margin]',
    '[core].[fn_calc_tenure]',
    '[core].[fn_calc_variance]',
  ],
  procedure: [
    '[core].[sp_build_budget]',
    '[core].[sp_build_employee]',
    '[core].[sp_build_product]',
    '[core].[sp_build_sales_order]',
    '[legacy].[sp_backup_monthly]',
    '[legacy].[sp_export_to_file]',
    '[mart_sales].[sp_load_dim_customer]',
    '[mart_sales].[sp_load_dim_date]',
    '[mart_sales].[sp_load_dim_product]',
    '[mart_sales].[sp_load_dim_territory]',
    '[mart_sales].[sp_load_fact_sales]',
    '[mart_sales].[sp_load_fact_sales_bak]',
    '[staging].[sp_load_budget]',
    '[staging].[sp_load_customer]',
    '[staging].[sp_load_employee]',
    '[staging].[sp_load_inventory]',
    '[staging].[sp_load_market_data]',
    '[staging].[sp_load_order_detail]',
    '[staging].[sp_load_order_header]',
    '[staging].[sp_load_pay_history]',
    '[staging].[sp_load_product]',
  ],
  view: [
    '[core].[vw_employee_summary]',
    '[core].[vw_sales_summary]',
    '[legacy].[vw_archive_summary]',
    '[legacy].[vw_deprecated_report]',
    '[mart_hr].[vw_dim_employee]',
    '[mart_hr].[vw_fact_headcount]',
    '[mart_hr].[vw_headcount_dashboard]',
    '[mart_sales].[vw_budget_analysis]',
    '[mart_sales].[vw_product_performance]',
    '[mart_sales].[vw_sales_dashboard]',
    '[mart_sales].[vw_territory_summary]',
  ],
};

/** Column count per table: the Columns relationship entries in the SDK-style model.xml. */
const SDK_TABLE_COLUMNS: Record<string, number> = {
  '[core].[int_employee]': 5,
  '[core].[int_product]': 5,
  '[core].[int_sales_order]': 10,
  '[legacy].[bak_dim_customer_2022]': 2,
  '[legacy].[bak_fact_sales_2023]': 4,
  '[legacy].[bak_stg_orders_2022]': 3,
  '[legacy].[tbl_calendar]': 3,
  '[legacy].[tbl_tally]': 1,
  '[legacy].[tmp_export_buffer]': 2,
  '[mart_sales].[dim_customer]': 4,
  '[mart_sales].[dim_date]': 6,
  '[mart_sales].[dim_product]': 5,
  '[mart_sales].[dim_territory]': 4,
  '[mart_sales].[fact_sales]': 8,
  '[src_hr].[tbl_employee]': 4,
  '[src_hr].[tbl_pay_history]': 3,
  '[src_prod].[tbl_inventory]': 3,
  '[src_prod].[tbl_product]': 5,
  '[src_sales].[tbl_customer]': 3,
  '[src_sales].[tbl_order_detail]': 5,
  '[src_sales].[tbl_order_header]': 6,
  '[src_sales].[tbl_territory]': 3,
  '[staging].[stg_budget]': 5,
  '[staging].[stg_customer]': 3,
  '[staging].[stg_customer_bak]': 3,
  '[staging].[stg_employee]': 3,
  '[staging].[stg_exchange_rates]': 3,
  '[staging].[stg_inventory]': 3,
  '[staging].[stg_market_data]': 5,
  '[staging].[stg_order_detail]': 5,
  '[staging].[stg_order_header]': 6,
  '[staging].[stg_order_header_bak]': 4,
  '[staging].[stg_pay_history]': 3,
  '[staging].[stg_product]': 5,
};

/**
 * Every edge of the SDK-style fixture, hand-derived: view inputs are the
 * view's QueryDependencies in model.xml; procedure edges are read from each
 * BodyScript (TRUNCATE/INSERT/UPDATE target = write, FROM/JOIN/APPLY = read;
 * the UPDATE … FROM staging.stg_budget both reads and writes it).
 */
const SDK_EDGES = [
  // views (QueryDependencies)
  '[core].[int_employee] -> [core].[vw_employee_summary]',
  '[core].[int_sales_order] -> [core].[vw_sales_summary]',
  '[legacy].[bak_dim_customer_2022] -> [legacy].[vw_archive_summary]',
  '[legacy].[bak_fact_sales_2023] -> [legacy].[vw_archive_summary]',
  '[legacy].[bak_stg_orders_2022] -> [legacy].[vw_archive_summary]',
  '[core].[int_employee] -> [mart_hr].[vw_dim_employee]',
  '[core].[int_employee] -> [mart_hr].[vw_fact_headcount]',
  '[mart_hr].[vw_dim_employee] -> [mart_hr].[vw_headcount_dashboard]',
  '[mart_hr].[vw_fact_headcount] -> [mart_hr].[vw_headcount_dashboard]',
  '[mart_sales].[dim_territory] -> [mart_sales].[vw_budget_analysis]',
  '[staging].[stg_budget] -> [mart_sales].[vw_budget_analysis]',
  '[core].[int_sales_order] -> [mart_sales].[vw_product_performance]',
  '[mart_sales].[dim_product] -> [mart_sales].[vw_product_performance]',
  '[core].[fn_calc_variance] -> [mart_sales].[vw_sales_dashboard]',
  '[mart_sales].[dim_customer] -> [mart_sales].[vw_sales_dashboard]',
  '[mart_sales].[dim_date] -> [mart_sales].[vw_sales_dashboard]',
  '[mart_sales].[dim_territory] -> [mart_sales].[vw_sales_dashboard]',
  '[mart_sales].[fact_sales] -> [mart_sales].[vw_sales_dashboard]',
  '[mart_sales].[dim_territory] -> [mart_sales].[vw_territory_summary]',
  '[mart_sales].[fact_sales] -> [mart_sales].[vw_territory_summary]',
  // core procedures
  '[core].[fn_calc_variance] -> [core].[sp_build_budget]',
  '[staging].[stg_budget] -> [core].[sp_build_budget]',
  '[core].[sp_build_budget] -> [staging].[stg_budget]',
  '[core].[fn_calc_tenure] -> [core].[sp_build_employee]',
  '[staging].[stg_employee] -> [core].[sp_build_employee]',
  '[staging].[stg_pay_history] -> [core].[sp_build_employee]',
  '[core].[sp_build_employee] -> [core].[int_employee]',
  '[staging].[stg_inventory] -> [core].[sp_build_product]',
  '[staging].[stg_product] -> [core].[sp_build_product]',
  '[core].[sp_build_product] -> [core].[int_product]',
  '[core].[fn_calc_margin] -> [core].[sp_build_sales_order]',
  '[staging].[stg_order_detail] -> [core].[sp_build_sales_order]',
  '[staging].[stg_order_header] -> [core].[sp_build_sales_order]',
  '[staging].[stg_product] -> [core].[sp_build_sales_order]',
  '[core].[sp_build_sales_order] -> [core].[int_sales_order]',
  // legacy
  '[legacy].[sp_export_to_file] -> [legacy].[tmp_export_buffer]',
  // mart_sales procedures
  '[staging].[stg_customer] -> [mart_sales].[sp_load_dim_customer]',
  '[mart_sales].[sp_load_dim_customer] -> [mart_sales].[dim_customer]',
  '[core].[int_sales_order] -> [mart_sales].[sp_load_dim_date]',
  '[mart_sales].[sp_load_dim_date] -> [mart_sales].[dim_date]',
  '[core].[int_product] -> [mart_sales].[sp_load_dim_product]',
  '[mart_sales].[sp_load_dim_product] -> [mart_sales].[dim_product]',
  '[src_sales].[tbl_territory] -> [mart_sales].[sp_load_dim_territory]',
  '[mart_sales].[sp_load_dim_territory] -> [mart_sales].[dim_territory]',
  '[core].[int_sales_order] -> [mart_sales].[sp_load_fact_sales]',
  '[mart_sales].[dim_customer] -> [mart_sales].[sp_load_fact_sales]',
  '[mart_sales].[dim_territory] -> [mart_sales].[sp_load_fact_sales]',
  '[mart_sales].[sp_load_fact_sales] -> [mart_sales].[fact_sales]',
  // staging procedures (TRUNCATE-only placeholders write their target)
  '[staging].[sp_load_budget] -> [staging].[stg_budget]',
  '[staging].[sp_load_customer] -> [staging].[stg_customer]',
  '[src_hr].[tbl_employee] -> [staging].[sp_load_employee]',
  '[staging].[sp_load_employee] -> [staging].[stg_employee]',
  '[staging].[sp_load_inventory] -> [staging].[stg_inventory]',
  '[staging].[sp_load_market_data] -> [staging].[stg_market_data]',
  '[staging].[sp_load_order_detail] -> [staging].[stg_order_detail]',
  '[staging].[sp_load_order_header] -> [staging].[stg_order_header]',
  '[src_hr].[tbl_pay_history] -> [staging].[sp_load_pay_history]',
  '[staging].[sp_load_pay_history] -> [staging].[stg_pay_history]',
  '[staging].[sp_load_product] -> [staging].[stg_product]',
].sort();

describe('DACPAC Extractor', () => {
  loadParseRules();

  describe('AdventureWorks2025_AI dacpac', () => {
    it('renders exactly the objects model.xml declares', async () => {
      const model = await loadAdventureWorksModel();
      const declared = await declaredObjects(AW);
      expect(model.nodes.map((n) => n.id).sort()).toEqual(
        Object.keys(declared).sort(),
      );
    });

    it('classifies objects by their model.xml element type', async () => {
      const model = await loadAdventureWorksModel();
      // 90 SqlTable, 26 SqlView, 19 SqlProcedure, 11 SqlScalarFunction +
      // 1 SqlMultiStatementTableValuedFunction, 1 SqlExternalTable.
      expect(countBy(model.nodes.map((n) => n.type))).toEqual({
        table: 90,
        view: 26,
        procedure: 19,
        function: 12,
        external: 1,
      });
    });

    it('reports per-schema object counts', async () => {
      const model = await loadAdventureWorksModel();
      expect(bySchemaName(model.schemas)).toEqual(AW_SCHEMAS);
    });

    it('catalogs every declared object with its model.xml spelling', async () => {
      const model = await loadAdventureWorksModel();
      expect(model.catalog).toEqual(await declaredObjects(AW));
    });

    it('records the SQL Server 2025 platform and the dacpac source', async () => {
      const model = await loadAdventureWorksModel();
      expect([model.dbPlatform, model.source]).toEqual([
        'SQL Server 2025',
        'dacpac',
      ]);
    });

    it('reports no warnings for a successful extraction', async () => {
      const model = await loadAdventureWorksModel();
      expect(model.warnings).toBeUndefined();
    });

    it('derives the expected edges for named procedures', async () => {
      const model = await loadAdventureWorksModel();
      const edgesFor = (procId: string): string[] =>
        model.edges
          .filter((e) => e.source === procId || e.target === procId)
          .map((e) => `${e.source}|${e.type}|${e.target}`)
          .sort();

      expect(edgesFor('[ai].[spcleanorders]')).toEqual([
        '[ai].[cleanedorders]|body|[ai].[spcleanorders]',
        '[ai].[customermaster]|body|[ai].[spcleanorders]',
        '[ai].[raworderimport]|body|[ai].[spcleanorders]',
        '[ai].[spcleanorders]|body|[ai].[cleanedorders]',
        '[ai].[spcleanorders]|body|[ai].[errorlog]',
        '[ai].[spcleanorders]|exec|[ai].[splogaudit]',
      ]);
      expect(edgesFor('[humanresources].[uspupdateemployeehireinfo]')).toEqual([
        '[humanresources].[uspupdateemployeehireinfo]|body|[humanresources].[employee]',
        '[humanresources].[uspupdateemployeehireinfo]|body|[humanresources].[employeepayhistory]',
        '[humanresources].[uspupdateemployeehireinfo]|exec|[dbo].[usplogerror]',
      ]);
    });

    it('emits no edge whose endpoint is not a node', async () => {
      const model = await loadAdventureWorksModel();
      const ids = new Set(model.nodes.map((n) => n.id));
      expect(
        model.edges.filter((e) => !ids.has(e.source) || !ids.has(e.target)),
      ).toEqual([]);
    });

    it('emits no self-loop edge', async () => {
      const model = await loadAdventureWorksModel();
      expect(model.edges.filter((e) => e.source === e.target)).toEqual([]);
    });

    it('emits each source/target pair once', async () => {
      const model = await loadAdventureWorksModel();
      const keys = edgeList(model);
      expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    });

    it('keeps the Employee foreign key from model.xml', async () => {
      const model = await loadAdventureWorksModel();
      const employee = model.nodes.find(
        (n) => n.id === '[humanresources].[employee]',
      );
      expect(employee?.fks).toEqual([
        {
          name: 'FK_Employee_Person_BusinessEntityID',
          columns: ['BusinessEntityID'],
          refSchema: 'Person',
          refTable: 'Person',
          refColumns: ['BusinessEntityID'],
          onDelete: 'NO ACTION',
        },
      ]);
    });

    it('flags the six CK_Employee_* check constraints on their columns', async () => {
      const model = await loadAdventureWorksModel();
      const employee = model.nodes.find(
        (n) => n.id === '[humanresources].[employee]',
      );
      expect(
        employee?.columns
          ?.filter((c) => c.check)
          .map((c) => [c.name, c.check])
          .sort(),
      ).toEqual([
        ['BirthDate', 'CK_Employee_BirthDate'],
        ['Gender', 'CK_Employee_Gender'],
        ['HireDate', 'CK_Employee_HireDate'],
        ['MaritalStatus', 'CK_Employee_MaritalStatus'],
        ['SickLeaveHours', 'CK_Employee_SickLeaveHours'],
        ['VacationHours', 'CK_Employee_VacationHours'],
      ]);
    });

    it('gives a single-column primary key ordinal 1 and other columns none', async () => {
      const model = await loadAdventureWorksModel();
      const employee = model.nodes.find(
        (n) => n.id === '[humanresources].[employee]',
      );
      expect(
        employee?.columns
          ?.filter((c) => c.pkOrdinal !== undefined)
          .map((c) => [c.name, c.pkOrdinal]),
      ).toEqual([['BusinessEntityID', 1]]);
    });
  });

  describe('SDK-style (Fabric) dacpac', () => {
    const load = () => extractDacpac(readFileSync(testPath(SDK)));

    it('renders the declared tables, views, procedures and functions', async () => {
      const model = await load();
      const ids = (type: string) =>
        model.nodes
          .filter((n) => n.type === type)
          .map((n) => n.id)
          .sort();
      expect({
        table: ids('table'),
        view: ids('view'),
        procedure: ids('procedure'),
        function: ids('function'),
      }).toEqual({ table: Object.keys(SDK_TABLE_COLUMNS).sort(), ...SDK_IDS });
    });

    it('derives the hand-checked edge set from QueryDependencies and procedure bodies', async () => {
      expect(edgeList(await load())).toEqual(SDK_EDGES);
    });

    it('records the Fabric Data Warehouse platform and the dacpac source', async () => {
      const model = await load();
      expect([model.dbPlatform, model.source]).toEqual([
        'Fabric Data Warehouse',
        'dacpac',
      ]);
    });
  });

  describe('two-phase extraction (schema preview, then filtered build)', () => {
    const preview = () => extractSchemaPreview(readFileSync(testPath(AW)));

    it('previews the per-schema counts, the object total and the provider name', async () => {
      const { preview: p, dspName } = await preview();
      expect({
        schemas: bySchemaName(p.schemas),
        totalObjects: p.totalObjects,
        dspName,
      }).toEqual({
        schemas: AW_SCHEMAS,
        totalObjects: 148,
        dspName: 'Microsoft.Data.Tools.Schema.Sql.Sql170DatabaseSchemaProvider',
      });
    });

    it('builds the same nodes and edges as the full extract when every schema is chosen', async () => {
      const { preview: p, elements, dspName } = await preview();
      const all = extractDacpacFiltered(
        elements,
        new Set(p.schemas.map((s) => s.name)),
        dspName,
      );
      const full = await loadAdventureWorksModel();
      expect({
        nodes: all.nodes.map((n) => n.id).sort(),
        edges: edgeList(all),
        dbPlatform: all.dbPlatform,
      }).toEqual({
        nodes: full.nodes.map((n) => n.id).sort(),
        edges: edgeList(full),
        dbPlatform: 'SQL Server 2025',
      });
    });

    it('renders only the chosen schema', async () => {
      const { elements, dspName } = await preview();
      const hr = extractDacpacFiltered(
        elements,
        new Set(['HumanResources']),
        dspName,
      );
      expect(hr.nodes.map((n) => n.id).sort()).toEqual(AW_HR_IDS);
    });

    it('catalogs out-of-filter objects with their model.xml spelling', async () => {
      const { elements } = await preview();
      const model = extractDacpacFiltered(
        elements,
        new Set(['HumanResources']),
      );
      const declared = await declaredObjects(AW);
      const outside = Object.fromEntries(
        Object.entries(declared).filter(([id]) => !AW_HR_IDS.includes(id)),
      );
      const rendered = new Set(model.nodes.map((n) => n.id));
      expect(
        Object.fromEntries(
          Object.entries(model.catalog).filter(([id]) => !rendered.has(id)),
        ),
      ).toEqual(outside);
    });

    it('keeps the out-edges from rendered nodes to out-of-filter objects', async () => {
      const { elements } = await preview();
      const model = extractDacpacFiltered(
        elements,
        new Set(['HumanResources']),
      );
      const rendered = new Set(model.nodes.map((n) => n.id));
      // The three HumanResources update procedures EXECUTE dbo.uspLogError in their CATCH blocks.
      expect(
        Object.entries(model.neighborIndex)
          .filter(([id]) => rendered.has(id))
          .flatMap(([id, nb]) =>
            nb.out.filter((t) => !rendered.has(t)).map((t) => `${id} -> ${t}`),
          )
          .sort(),
      ).toEqual([
        '[humanresources].[uspupdateemployeehireinfo] -> [dbo].[usplogerror]',
        '[humanresources].[uspupdateemployeelogin] -> [dbo].[usplogerror]',
        '[humanresources].[uspupdateemployeepersonalinfo] -> [dbo].[usplogerror]',
      ]);
    });
  });

  describe('import errors', () => {
    it('rejects a non-ZIP file with a readable message and no URL', async () => {
      const result = extractDacpac(
        new TextEncoder().encode('this is not a zip file'),
      );
      await expect(result).rejects.toThrow(
        /^Not a valid \.dacpac file \(invalid ZIP archive\)$/,
      );
    });

    it('rejects a ZIP without model.xml', async () => {
      const zip = new JSZip();
      zip.file('other.xml', '<root/>');
      await expect(
        extractDacpac(await zip.generateAsync({ type: 'arraybuffer' })),
      ).rejects.toThrow(/^model\.xml not found in \.dacpac$/);
    });

    it('warns, without throwing, when model.xml declares no objects', async () => {
      const zip = new JSZip();
      zip.file(
        'model.xml',
        `<?xml version="1.0"?>
    <DataSchemaModel>
      <Model>
        <Element Type="SqlDatabaseOptions" Name="Options"/>
      </Model>
    </DataSchemaModel>`,
      );
      const model = await extractDacpac(
        await zip.generateAsync({ type: 'arraybuffer' }),
      );
      expect({ nodes: model.nodes, warnings: model.warnings }).toEqual({
        nodes: [],
        warnings: [
          'No tables, views, or stored procedures found in this file.',
        ],
      });
    });
  });

  it.each([
    ['', ''],
    [
      'Microsoft.Data.Tools.Schema.Sql.SqlDwUnifiedDatabaseSchemaProvider',
      'Fabric Data Warehouse',
    ],
    [
      'Microsoft.Data.Tools.Schema.Sql.SqlDbFabricDatabaseSchemaProvider',
      'SQL Database in Fabric',
    ],
    [
      'Microsoft.Data.Tools.Schema.Sql.SqlDwDatabaseSchemaProvider',
      'Synapse Dedicated Pool',
    ],
    [
      'Microsoft.Data.Tools.Schema.Sql.SqlManagedInstanceDatabaseSchemaProvider',
      'Azure SQL Managed Instance',
    ],
    [
      'Microsoft.Data.Tools.Schema.Sql.SqlHyperscaleDatabaseSchemaProvider',
      'Azure SQL Hyperscale',
    ],
    [
      'Microsoft.Data.Tools.Schema.Sql.SqlAzureV12DatabaseSchemaProvider',
      'Azure SQL Database',
    ],
    [
      'Microsoft.Data.Tools.Schema.Sql.Sql170DatabaseSchemaProvider',
      'SQL Server 2025',
    ],
    [
      'Microsoft.Data.Tools.Schema.Sql.Sql130DatabaseSchemaProvider',
      'SQL Server 2016',
    ],
    [
      'Microsoft.Data.Tools.Schema.Sql.Sql80DatabaseSchemaProvider',
      'SQL Server 2000',
    ],
    ['SqlAzureV12DatabaseSchemaProvider', 'Azure SQL Database'],
    // Unknown provider: the readable part before DatabaseSchemaProvider.
    ['Vendor.MyTool.Schema.SqlFutureDatabaseSchemaProvider', 'SqlFuture'],
    ['some-unknown-provider', 'some-unknown-provider'],
  ])('maps DSP provider name %j to platform label %j', (dsp, expected) => {
    expect(parseDspPlatform(dsp)).toBe(expected);
  });
});
