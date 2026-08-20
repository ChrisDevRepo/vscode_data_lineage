import { describe, expect, it } from 'vitest';
import { sensitiveTraceReason } from '../../../src/ai/providers/traceSecurity';
import {
  systemPromptHash,
  type GenerationRecord,
  type ProviderRawRecord,
} from '../../../src/ai/observability/wireLog';

/**
 * Redaction shapes are asserted through the public refusal API rather than the patterns themselves,
 * because the contract that matters is "this value never reaches a trace or a retry payload".
 */
const REDACTED_VALUES: ReadonlyArray<readonly [string, string]> = [
  // Pre-existing shapes — held as regressions now that the pattern list is extensible.
  ['bearer token', 'Authorization: Bearer sk1F9mQpZ2xLbTnR4vHc0eWaYdJgKuS7'],
  ['sk- prefixed provider key', 'the key is sk-abcdef0123456789ABCDEF'],
  ['query-string api key', 'GET https://contoso.example/v1/models?api_key=9f2b7c1de4a6'],

  // Connection strings.
  ['ADO.NET connection string password', 'Server=tcp:edw.database.windows.net,1433;Database=Sales;User ID=svc_etl;Password=Hunter2Hunter2;Encrypt=true'],
  ['ODBC lowercase pwd', 'DRIVER={ODBC Driver 18 for SQL Server};SERVER=edw;UID=svc;pwd=S3cretPassphrase;'],
  ['spaced assignment', 'Password = R3allyL0ngSecretValue'],

  // Bearer-style credentials.
  ['JSON Web Token', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
  ['JWT inside a larger payload', '{"headers":"redacted","raw":"eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJhcGk6Ly9sYW5jZSJ9.QUJDREVGR0hJSktMTU5PUFFSUw"}'],

  // Vendor-prefixed tokens.
  ['AWS access key id', 'AWS_ACCESS_KEY_ID is AKIAIOSFODNN7EXAMPLE for the staging loader'],
  ['AWS temporary access key id', 'ASIAY34FZKBOKMUTVV7A'],
  ['GitHub personal access token', 'remote url uses ghp_16C7e42F292c6912E7710c838347Ae178B4a'],
  ['GitHub OAuth token', 'gho_16C7e42F292c6912E7710c838347Ae178B4a'],
  ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0aBcDeFgHiJkL_MnOpQrStUvWxYz0123456789AbCdEf'],
  ['Slack bot token', 'xoxb-2417-2521-pOxJxKzXhLmNqRsTuVwYzAbC'],
  ['Slack user token', 'xoxp-9876543210-1234567890-abcdefghijklmnop'],

  // Encoded key material with no vendor prefix.
  ['long mixed-class base64 blob', 'cert=MIIBqjCCARMCFDq3Kp7XvR9zLmN4oPqW2sTb0YcHMA0GCSqGSIb3DQEBCwUAMBQx7Kd9'],
];

const RETAINED_VALUES: ReadonlyArray<readonly [string, string]> = [
  ['plain object identifier', '[dbo].[FactInternetSales]'],
  ['three-part name', 'AdventureWorksDW.dbo.DimCustomer'],
  ['column reference', 'FactResellerSales.SalesOrderNumber'],
  ['ordinary SELECT', 'SELECT c.CustomerKey, c.LastName FROM dbo.DimCustomer AS c WHERE c.GeographyKey = 12'],
  ['view definition', 'CREATE VIEW dbo.vSalesByRegion AS SELECT r.EnglishCountryRegionName, SUM(f.SalesAmount) AS SalesAmount FROM dbo.FactInternetSales AS f JOIN dbo.DimGeography AS r ON r.GeographyKey = f.CustomerKey GROUP BY r.EnglishCountryRegionName'],
  ['password-named column with no assignment', 'ALTER TABLE dbo.DimEmployee ADD PasswordHash VARBINARY(128) NULL'],
  ['prose mentioning a password column', 'The DimEmployee table stores a password hash but no plaintext password.'],
  ['long single-case hex digest', 'checksum 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0'],
  ['long POSIX path', '/home/DataEngineer42/projects/LineageWarehouse/Reports/Monthly/RegionSummary/Output2024'],
  ['long lowercase identifier run', 'factinternetsalesreasonbridgetablewithaverylongdescriptivename'],
  ['short base64-looking token', 'YWJjZGVmZ2g='],
];

describe('trace security redaction', () => {
  it.each(REDACTED_VALUES)('refuses %s', (_label, value) => {
    expect(sensitiveTraceReason(value)).toBe('secret_value');
  });

  it.each(RETAINED_VALUES)('retains %s', (_label, value) => {
    expect(sensitiveTraceReason(value)).toBeUndefined();
  });

  it('finds a secret nested in objects and arrays', () => {
    expect(sensitiveTraceReason({
      tool: 'lineage_get_object_detail',
      results: [{ id: '[dbo].[DimDate]' }, { note: 'connect with pwd=Sup3rSecretValue;' }],
    })).toBe('secret_value');
  });

  it('reports a forbidden key before inspecting its value', () => {
    expect(sensitiveTraceReason({ apiKey: 'harmless' })).toBe('forbidden_key');
    expect(sensitiveTraceReason({ requestHeaders: {} })).toBe('forbidden_key');
  });

  it('leaves an ordinary lineage payload untouched', () => {
    expect(sensitiveTraceReason({
      tool: 'lineage_get_object_detail',
      objects: [
        { id: '[dbo].[FactInternetSales]', type: 'TABLE', columns: ['SalesOrderNumber', 'OrderDateKey'] },
        { id: '[dbo].[vSalesByRegion]', type: 'VIEW', definition: 'SELECT * FROM dbo.FactInternetSales' },
      ],
    })).toBeUndefined();
  });

  /**
   * The trace records added for the headless live-provider lane, held against the same guard.
   *
   * @remarks
   * These records exist to be read after a bad run — pasted into an issue, diffed across lanes — so
   * the question is not whether the emitter happens to omit credentials today but whether the record
   * SHAPE has anywhere to put one. The guard is the oracle for that: a header-bearing field is
   * refused by key before its value is ever inspected.
   */
  describe('generation and provider-raw record surface', () => {
    const generation: GenerationRecord = {
      type: 'generation',
      requestId: 'request-1',
      generation: 3,
      phase: 'hop',
      modelId: 'deepseek/deepseek-chat',
      finishReason: 'tool_calls',
      latencyMs: 4210,
      usage: { inputTokens: 12_000, outputTokens: 480, totalTokens: 12_480 },
    };
    const providerRaw: ProviderRawRecord = {
      type: 'provider-raw',
      requestId: 'request-1',
      generation: 3,
      direction: 'request',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      status: 200,
      body: { model: 'deepseek/deepseek-chat', messages: [{ role: 'system', content: 'Trace lineage.' }] },
    };

    it('retains a complete generation record, clear-text model id included', () => {
      // The model id is a public product identifier and the whole point of the record: a hashed one
      // cannot answer "which model misbehaved".
      expect(sensitiveTraceReason(generation)).toBeUndefined();
    });

    it('retains a provider-raw body record — bodies are captured, headers are not', () => {
      expect(sensitiveTraceReason(providerRaw)).toBeUndefined();
    });

    it('refuses the same record the moment a header-bearing field is introduced', () => {
      // Not a hypothetical: adding request headers is the single most likely "helpful" extension of
      // this record, and it is the one that would put the Authorization value into every trace.
      expect(sensitiveTraceReason({ ...providerRaw, headers: {} })).toBe('forbidden_key');
      expect(sensitiveTraceReason({ ...providerRaw, requestHeaders: {} })).toBe('forbidden_key');
      expect(sensitiveTraceReason({ ...providerRaw, authorization: 'Bearer redacted-shape' }))
        .toBe('forbidden_key');
      expect(sensitiveTraceReason({
        ...providerRaw,
        body: { authorization: 'Bearer sk1F9mQpZ2xLbTnR4vHc0eWaYdJgKuS7' },
      })).toBe('forbidden_key');
    });

    it('keeps the non-verbose system hash inert', () => {
      // 64 lowercase hex characters: single-case, so it never reaches the base64 heuristic, and it is
      // what a default (non-verbose) trace records instead of the prompt text.
      const hash = systemPromptHash('You are the lineage analyst. Trace [ai].[FactSalesReport].');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(sensitiveTraceReason(hash)).toBeUndefined();
      expect(sensitiveTraceReason({ type: 'wire-request', systemHash: hash })).toBeUndefined();
    });
  });

  it('scans a repeated shape without pathological backtracking', () => {
    // A long non-matching run adjacent to the bounded patterns: the guard must stay linear.
    const hostile = `${'Aa0b'.repeat(4_000)}!`;
    const started = Date.now();
    expect(sensitiveTraceReason(hostile)).toBe('secret_value');
    expect(Date.now() - started).toBeLessThan(1_000);

    const hostileMiss = `${'password'.repeat(4_000)} `;
    const startedMiss = Date.now();
    expect(sensitiveTraceReason(hostileMiss)).toBeUndefined();
    expect(Date.now() - startedMiss).toBeLessThan(1_000);
  });
});
