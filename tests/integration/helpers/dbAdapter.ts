/**
 * dbAdapter.ts — SQL Server connection adapter for integration tests.
 *
 * Uses the `mssql` npm package (TCP/IP, SQL Server auth) to connect directly
 * to SQL Server — bypasses the VS Code MSSQL extension entirely so tests run
 * outside a VS Code window.
 *
 * Prerequisites:
 *   • TCP/IP enabled in SQL Server Configuration Manager (restart service after)
 *   • .env file with DB_SERVER, DB_USER, DB_PASSWORD (loaded by dotenv in test entry)
 *
 * Usage:
 *   const db = await createDbAdapter('AdventureWorks2025');
 *   const { dmvResults, rawDepsAllSchemas } = await db.runAllPhases('Production,Sales');
 *   await db.close();
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import * as sql from 'mssql';
import type { SimpleExecuteResult, IDbColumn, DbCellValue } from '../../../src/types/mssql';
import type { DmvResults } from '../../../src/engine/dmvExtractor';
import { expandSchemaPlaceholder } from '../../../src/utils/sql';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, '..', '..', '..', 'assets');

// ─── DMV Query Loading ──────────────────────────────────────────────────────

interface DmvQuery { name: string; sql: string; phase?: number; }
interface DmvQueriesConfig { queries: DmvQuery[]; }

function loadDmvQueries(): DmvQuery[] {
  const raw = readFileSync(resolve(ASSETS_DIR, 'dmvQueries.yaml'), 'utf-8');
  const cfg = yaml.load(raw) as DmvQueriesConfig;
  return cfg.queries.filter(q => q.name && q.sql);
}

// ─── mssql Transport ──────────────────────────────────────────────────────────

function buildConfig(database: string): sql.config {
  return {
    server:   process.env.DB_SERVER ?? 'localhost',
    port:     parseInt(process.env.DB_PORT ?? '1433', 10),
    database,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
      encrypt:                process.env.DB_ENCRYPT !== 'false',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false',
    },
    connectionTimeout: 15_000,
    requestTimeout:    120_000,
  };
}

async function runQuery(pool: sql.ConnectionPool, sqlText: string): Promise<SimpleExecuteResult> {
  const result = await pool.request().query<Record<string, unknown>>(sqlText);
  const columnInfo: IDbColumn[] = Object.keys(result.recordset.columns).map(name => ({
    columnName: name,
    dataType:     'varchar',
    dataTypeName: 'varchar',
  }));
  const rows: DbCellValue[][] = result.recordset.map(row =>
    columnInfo.map(c => {
      const v = row[c.columnName];
      if (v === null || v === undefined) return { displayValue: '', isNull: true };
      if (typeof v === 'boolean')        return { displayValue: v ? '1' : '0', isNull: false };
      return { displayValue: String(v), isNull: false };
    }),
  );
  return { rowCount: rows.length, columnInfo, rows };
}

// ─── DbAdapter ───────────────────────────────────────────────────────────────

export interface PhaseResults {
  dmvResults: DmvResults;
  /** Unfiltered dependencies across ALL schemas — for coverage assertions */
  rawDepsAllSchemas: SimpleExecuteResult;
  allObjectsResult: SimpleExecuteResult;
}

export class DbAdapter {
  private pool: sql.ConnectionPool;
  private queries: DmvQuery[];

  constructor(pool: sql.ConnectionPool, queries: DmvQuery[]) {
    this.pool    = pool;
    this.queries = queries;
  }

  /** Run a raw SQL query → SimpleExecuteResult */
  async query(sqlText: string): Promise<SimpleExecuteResult> {
    return runQuery(this.pool, sqlText);
  }

  /**
   * Run all DMV phases:
   *   Phase 1 — schema-preview + all-objects (always full, no filter)
   *   Phase 2 — nodes, columns, dependencies (filtered to selected schemas if provided)
   *
   * @param schemas Comma-separated schema names, or empty/undefined for all schemas.
   */
  async runAllPhases(schemas?: string): Promise<PhaseResults> {
    const selected = schemas ? schemas.split(',').map(s => s.trim()).filter(Boolean) : [];
    const queryMap = new Map(this.queries.map(q => [q.name, q]));

    // Phase 1 — always unfiltered
    const [schemaPreviewResult, allObjectsResult] = await Promise.all([
      this.execQuery('schema-preview'),
      this.execQuery('all-objects'),
    ]);

    // Extract all schema names from Phase 1 for unfiltered dependency coverage
    const allSchemas = [...new Set(schemaPreviewResult.rows.map(r => r[0].displayValue))];

    // Phase 2 — expand {{SCHEMAS}} with selected schemas (or all schemas if none selected)
    const filterSchemas = selected.length > 0 ? selected : allSchemas;
    const expand = (name: string) => expandSchemaPlaceholder(queryMap.get(name)!.sql, filterSchemas);
    const expandAll = (name: string) => expandSchemaPlaceholder(queryMap.get(name)!.sql, allSchemas);

    const [nodesResult, columnsResult, depsResult, rawDepsAllSchemas, constraintsResult] = await Promise.all([
      this.query(expand('nodes')),
      this.query(expand('columns')),
      this.query(expand('dependencies')),
      this.query(expandAll('dependencies')), // always all schemas — for coverage assertions
      this.query(expand('constraints')),
    ]);

    return {
      dmvResults: { nodes: nodesResult, columns: columnsResult, dependencies: depsResult, allObjects: allObjectsResult, constraints: constraintsResult },
      rawDepsAllSchemas,
      allObjectsResult,
    };
  }

  private async execQuery(name: string): Promise<SimpleExecuteResult> {
    const q = this.queries.find(q => q.name === name);
    if (!q) throw new Error(`Unknown DMV query: ${name}`);
    return this.query(q.sql);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

/**
 * Create a DbAdapter connected to the given database.
 * Reads connection config from environment variables loaded by dotenv.
 */
export async function createDbAdapter(database: string): Promise<DbAdapter> {
  // Use explicit ConnectionPool (not sql.connect) to avoid global pool reuse
  // when connecting to multiple databases in the same process.
  const pool = new sql.ConnectionPool(buildConfig(database));
  await pool.connect();
  const queries = loadDmvQueries();
  return new DbAdapter(pool, queries);
}
