/** Optional database smoke releases sessions after import, malformed metadata, query failure and cancellation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SimpleExecuteResult } from '../../../src/types/mssql';
import { main } from '../../harness/cli';
import { openBuiltInSession } from '../../../src/engine/db/builtInProvider';

vi.mock('../../../src/engine/db/builtInProvider', () => ({ openBuiltInSession: vi.fn() }));
vi.mock('../../../src/engine/connectionManager', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/engine/connectionManager')>(),
  loadDmvQueries: async () => ['schema-preview', 'nodes', 'columns', 'dependencies'].map(name => ({ name, sql: `SELECT '${name}'`, phase: name === 'schema-preview' ? 1 : 2 })),
}));

function rows(columns: string[], values: string[][]): SimpleExecuteResult {
  return { rowCount: values.length, columnInfo: columns.map((columnName, columnOrdinal) => ({ columnName, columnOrdinal, dataType: 'nvarchar', dataTypeName: 'nvarchar' })),
    rows: values.map(row => row.map(displayValue => ({ displayValue, isNull: false }))),
  };
}
const fixtures = {
  'schema-preview': rows(['schema_name', 'type_code', 'object_count'], [['dbo', 'U', '1']]),
  nodes: rows(['schema_name', 'object_name', 'type_code', 'body_script'], [['dbo', 'SyntheticTable', 'U', '']]),
  columns: rows(['schema_name', 'table_name', 'ordinal', 'column_name', 'type_name', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed'], [['dbo', 'SyntheticTable', '1', 'Id', 'int', '4', '10', '0', '0', '0', '0']]),
  dependencies: rows(['referencing_schema', 'referencing_name', 'referenced_schema', 'referenced_name'], []),
};
const dispose = vi.fn(async () => {});
const query = vi.fn(async (sql: string) => fixtures[sql.match(/'([^']+)'/)![1] as keyof typeof fixtures]);

beforeEach(() => {
  vi.stubEnv('DB_TEST_SERVER', 'localhost'); vi.stubEnv('DB_TEST_DATABASE', 'SyntheticDb');
  vi.stubEnv('DB_TEST_USER', 'reader'); vi.stubEnv('DB_TEST_PASSWORD', 'synthetic-password');
  vi.stubEnv('DB_TEST_PORT', ''); vi.stubEnv('DB_TEST_ENCRYPT', 'true'); vi.stubEnv('DB_TEST_TRUST_SERVER_CERTIFICATE', 'false');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  dispose.mockClear(); query.mockClear();
  vi.mocked(openBuiltInSession).mockResolvedValue({
    provider: 'builtIn', connectionInfo: { server: 'localhost', database: 'SyntheticDb' },
    executeSimpleQuery: query, getServerInfo: vi.fn(), dispose,
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('imports synthetic metadata through production query execution/model building and disposes', async () => {
  expect(await main('db', [])).toBe(0);
  expect(query).toHaveBeenCalledTimes(4);
  expect(dispose).toHaveBeenCalledOnce();
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({ runtime: 'ok', objects: 1 });
});
it('fails malformed metadata and still disposes', async () => {
  query.mockImplementationOnce(async () => fixtures['schema-preview']);
  query.mockImplementationOnce(async () => rows([], []));
  expect(await main('db', [])).toBe(2);
  expect(dispose).toHaveBeenCalledOnce();
});
it('fails a database query and still disposes', async () => {
  query.mockRejectedValueOnce(new Error('synthetic query failure'));
  expect(await main('db', [])).toBe(2);
  expect(dispose).toHaveBeenCalledOnce();
});
it('cancels a pending query at the whole-run deadline and releases the session', async () => {
  let release!: () => void;
  query.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(fixtures['schema-preview']); }));
  dispose.mockImplementationOnce(async () => { release(); });
  expect(await main('db', ['--timeout-ms', '50'])).toBe(3);
  expect(dispose).toHaveBeenCalled();
});
