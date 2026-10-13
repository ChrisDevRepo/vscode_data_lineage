/**
 * Boundaries of the optional headless and database runners.
 *
 * Transport retries, Langfuse upload, and stage-replay mechanics stay with those operator tools.
 * These rows keep the configuration failures and the secret boundary that must not regress.
 */
import { z } from 'zod';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { aiRuns, aiRunStatus, nextAiRunStep, databaseConfig, parseOptions, main, turnChecks } from '../../harness/cli';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import { loadParseRules, rootPath } from '../helpers/testUtils';

const { loadCases } = createRequire(import.meta.url)('../../cases/loadCases.cjs') as {
  loadCases: (runner?: string) => Array<{ id: string; prompt?: string; dacpac?: string; expect?: { terminal?: string; must_contain?: string[] } }>;
};
import { exportRunToLangfuse } from '../../harness/langfuseExport';
import { parseTrace } from '../../harness/traceModel';
import { redactSecret, verboseContent } from '../../harness/exportShared';
import { OpenAiCompatiblePort } from '../../harness/openAiCompatiblePort';
import type { GenerationEntry, ParsedRun } from '../../harness/traceModel';
import { TRACE_MODEL_SCHEMA_VERSION } from '../../harness/traceModel';
import { modelUserMessage } from '../../../src/ai/model/modelPort';

const secret = 'synthetic-secret';

describe('operator runner configuration', () => {
  it.each([
    ['ok', false, 'prompt'],
    ['error', false, 'case'],
    ['cancelled', false, 'stop'],
    ['ok', true, 'stop'],
    ['error', true, 'stop'],
  ] as const)('selects the catalog continuation for outcome %s with aborted=%s', (outcome, aborted, next) => {
    expect(nextAiRunStep(outcome, aborted)).toBe(next);
  });

  it.each([
    [[], 'error'],
    [['ok', 'ok'], 'ok'],
    [['error', 'ok'], 'error'],
    [['ok', 'error', 'ok'], 'error'],
    [['error', 'cancelled'], 'cancelled'],
  ] as const)('preserves failures when aggregating catalog outcomes %j', (outcomes, expected) => {
    expect(aiRunStatus(outcomes.map(outcome => ({ outcome })))).toBe(expected);
  });

  it('accepts a prompt and ordered follow-ups', () => {
    expect(parseOptions('ai', ['--prompt', 'Inspect dependencies', '--followup', 'First', '--followup', 'Second', '--timeout-ms', '1000']))
      .toMatchObject({ prompt: 'Inspect dependencies', followups: ['First', 'Second'], timeoutMs: 1000, langfuse: false, verbose: false });
  });

  it('defaults the AI deadline to 30 minutes and the database deadline to five', () => {
    expect(parseOptions('ai', []).timeoutMs).toBe(1_800_000);
    expect(parseOptions('db', []).timeoutMs).toBe(300_000);
  });

  it('defaults request deadlines to the run deadline and accepts an independent AI request bound', () => {
    expect(parseOptions('ai', []).requestTimeoutMs).toBe(1_800_000);
    expect(parseOptions('ai', ['--timeout-ms', '1000']).requestTimeoutMs).toBe(1000);
    expect(parseOptions('ai', ['--request-timeout-ms', '60000', '--timeout-ms', '1800000']))
      .toMatchObject({ timeoutMs: 1_800_000, requestTimeoutMs: 60_000 });
    expect(() => parseOptions('db', ['--request-timeout-ms', '60000'])).toThrow('Unknown option');
  });

  it('loops catalog headless rows unless a prompt is passed', () => {
    const rows = loadCases('headless');
    expect(rows.length).toBeGreaterThan(0);
    const runs = aiRuns(parseOptions('ai', []));
    expect(runs.map(run => run.id)).toEqual(rows.map(row => row.id));
    expect(runs.map(run => run.prompts[0])).toEqual(rows.map(row => row.prompt));
    expect(runs.map(run => run.expectTerminal)).toEqual(rows.map(row => row.expect?.terminal));
    const manual = aiRuns(parseOptions('ai', ['--prompt', 'Inspect dependencies', '--followup', 'First']));
    expect(manual.map(run => run.prompts)).toEqual([['Inspect dependencies', 'First']]);
    expect(manual[0]?.expectTerminal).toBeUndefined();
    expect(() => aiRuns(parseOptions('ai', ['--followup', 'First']))).toThrow('--followup requires --prompt.');
  });

  it.each(loadCases('headless').map(row => [row.id, row] as const))(
    '%s names only objects and keywords its DACPAC contains',
    async (_id, row) => {
      loadParseRules();
      const model = await extractDacpac(readFileSync(rootPath(row.dacpac!)));
      const text = model.nodes.map(node => [node.id, node.bodyScript ?? '', ...(node.columns ?? []).map(col => col.name)].join(' ')).join('\n').toLowerCase();
      for (const keyword of row.expect?.must_contain ?? []) expect(text, keyword).toContain(keyword.toLowerCase());
      const trace = /\/trace\s+(\[[^\]]+\]\.\[[^\]]+\])\.\[([^\]]+)\]/.exec(row.prompt ?? '');
      if (trace) {
        const node = model.nodes.find(candidate => candidate.id === trace[1].toLowerCase());
        expect(node, trace[1]).toBeDefined();
        expect(`${node!.bodyScript ?? ''} ${(node!.columns ?? []).map(col => col.name).join(' ')}`.toLowerCase()).toContain(trace[2].toLowerCase());
      }
    },
  );

  it('holds only the first answer of a row to its content checks and reports every failure', () => {
    const run = { expectTerminal: 'ok', expectMetrics: { terminal: 'ok', must_contain: ['Price'], preview_chars_min: 5, rejections_max: 0 } };
    const turn = (text: string, outcome = 'ok') => ({ terminalStatus: null, outcome: { outcome }, events: [], text });
    expect(turnChecks(run, turn('Price rules'), true)).toEqual([]);
    expect(turnChecks(run, turn('ok'), false)).toEqual([]);
    expect(turnChecks(run, turn('ok', 'error'), true)).toEqual([
      'terminal error, catalog expects ok',
      'output length 2 below min 5',
      'output missing required keyword "Price"',
    ]);
    expect(turnChecks(run, { ...turn('Price rules'), events: [{ type: 'error', recoverable: true }] }, false))
      .toEqual(['rejections 1 exceeded max 0']);
  });

  it.each([
    { label: 'unused approval', gate: [{ kind: 'approve' }], gates: [], first: true, failures: ['gate round 1 was not exercised'] },
    { label: 'approval', gate: [{ kind: 'approve' }], gates: [{ decision: 'approve' }], first: true, failures: [] },
    { label: 'wrong decision', gate: [{ kind: 'approve' }], gates: [{ decision: 'deny' }], first: true, failures: ['gate round 1 decision deny, expected approve'] },
    { label: 'missing second step', gate: [{ kind: 'refine', instruction: 'one level upstream' }, { kind: 'approve' }], gates: [{ decision: 'refine', instruction: 'one level upstream' }], first: true, failures: ['gate round 2 was not exercised'] },
    { label: 'wrong refinement', gate: [{ kind: 'refine', instruction: 'one level upstream' }], gates: [{ decision: 'refine', instruction: 'all levels' }], first: true, failures: ['gate round 1 refinement differs from catalog'] },
    { label: 'follow-up', gate: [{ kind: 'approve' }], gates: [], first: false, failures: [] },
  ] as const)('checks the catalog gate path for $label', ({ gate, gates, first, failures }) => {
    expect(turnChecks({ expectTerminal: 'ok', gate }, {
      terminalStatus: 'ok', outcome: { outcome: 'ok' }, events: [], text: 'Synthetic answer.', gates,
    }, first)).toEqual(failures);
  });

  it.each([['--timeout-ms', '0'], ['--timeout-ms', 'NaN'], ['--request-timeout-ms', '0'], ['--request-timeout-ms', 'NaN'], ['--request-timeout-ms', '7200001'], ['--request-timeout-ms'], ['--prompt'], ['--runs', '10']])(
    'rejects invalid or campaign options %j',
    (...args) => {
      expect(() => parseOptions('ai', args)).toThrow();
    },
  );

  it('fails a configured hosted provider without credentials instead of choosing another provider', async () => {
    vi.stubEnv('AI_TEST_PROVIDER', 'openai-compatible');
    vi.stubEnv('AI_TEST_MODEL', 'synthetic-model');
    vi.stubEnv('AI_TEST_API_KEY', '');
    vi.stubEnv('AI_TEST_ENDPOINT', 'https://provider.example/v1');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main('ai', ['--prompt', 'test'])).toBe(4);
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('rejects unsupported token-count expectations instead of silently ignoring them', () => {
    const loader = createRequire(import.meta.url)('../../cases/loadCases.cjs');
    const rows = loader.loadCases('headless');
    const read = vi.spyOn(loader, 'loadCases').mockReturnValue([
      { ...rows[0], expect: { ...rows[0].expect, tokens_max: 1 } },
    ]);
    try {
      expect(() => aiRuns(parseOptions('ai', []))).toThrow('expect.tokens_max is unsupported');
    } finally { read.mockRestore(); }
  });

  it.each([['unknown'], ['']])('rejects a run without a hosted provider instead of choosing one (AI_TEST_PROVIDER=%j)', async providerName => {
    vi.stubEnv('AI_TEST_PROVIDER', providerName);
    vi.stubEnv('AI_TEST_MODEL', 'synthetic-model');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main('ai', ['--prompt', 'test'])).toBe(4);
      expect(error.mock.calls[0]?.[0]).toContain('Set AI_TEST_PROVIDER to a hosted provider');
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('names the timeout bound when --timeout-ms is out of range', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main('ai', ['--prompt', 'test', '--timeout-ms', '10800000'])).toBe(4);
      expect(error.mock.calls[0]?.[0]).toContain('--timeout-ms must be at most 7200000');
    } finally { error.mockRestore(); }
  });

  it('rejects AI-only switches on the database runner', () => {
    expect(() => parseOptions('db', ['--langfuse'])).toThrow();
  });

  it('requires database settings and does not put the password on the connection object', () => {
    expect(() => databaseConfig({})).toThrow('DB_TEST_SERVER');
    const env = {
      DB_TEST_SERVER: 'localhost',
      DB_TEST_DATABASE: 'synthetic',
      DB_TEST_USER: 'reader',
      DB_TEST_PASSWORD: 'synthetic-password',
    };
    expect(databaseConfig(env)).toMatchObject({ authenticationType: 'sqlLogin', encrypt: true, trustServerCertificate: false });
    expect(databaseConfig(env)).not.toHaveProperty('password');
    expect(() => databaseConfig({ ...env, DB_TEST_PORT: '65536' })).toThrow();
    expect(() => databaseConfig({ ...env, DB_TEST_ENCRYPT: 'yes' })).toThrow();

    // SQL login names may contain '@'; Entra authentication is explicit.
    const entraAuto = databaseConfig({ ...env, DB_TEST_USER: 'admin@company.com' });
    expect(entraAuto).toMatchObject({ authenticationType: 'sqlLogin', user: 'admin@company.com' });

    // Explicit DB_TEST_AUTH_TYPE
    const explicitEntra = databaseConfig({ ...env, DB_TEST_AUTH_TYPE: 'entraId', DB_TEST_TENANT_ID: 'custom-tenant-guid', DB_TEST_TOKEN: 'access-token' });
    expect(explicitEntra).toMatchObject({ authenticationType: 'entraId', tenantId: 'custom-tenant-guid' });
    // Entra ID uses a supplied access token only; there is no username/password token flow.
    expect(() => databaseConfig({ ...env, DB_TEST_AUTH_TYPE: 'entraId', DB_TEST_TOKEN: '' })).toThrow('Set DB_TEST_TOKEN');

    const explicitSql = databaseConfig({ ...env, DB_TEST_USER: 'admin@company.com', DB_TEST_AUTH_TYPE: 'sqlLogin' });
    expect(explicitSql).toMatchObject({ authenticationType: 'sqlLogin' });
  });
});

describe('operator secret boundary', () => {
  it.each([
    ['replaces the secret wherever it appears', `seen ${secret} here`, secret, 'seen [redacted] here'],
    ['leaves text unchanged when no secret is configured', `seen ${secret} here`, '', `seen ${secret} here`],
  ] as const)('%s', (_name, text, hidden, expected) => {
    expect(redactSecret(text, hidden)).toBe(expected);
  });

  it('omits prompt content when the trace did not capture the system prompt', () => {
    const run = {
      schemaVersion: TRACE_MODEL_SCHEMA_VERSION,
      traceOpen: [],
      turns: [],
      generations: [],
      tools: [],
      gates: [],
      phases: [],
      raw: [],
      malformed: [],
      wire: [{
        type: 'wire-request',
        requestId: 'r',
        generation: 1,
        systemHash: 'hash',
        messages: [],
        tools: [],
        at: '2026-01-01T00:00:00.000Z',
        lineIndex: 0,
      }],
    } as unknown as ParsedRun;
    const generation = { requestId: 'r', generation: 1 } as GenerationEntry;
    expect(verboseContent(run, generation)).toEqual({});
  });

  it.each([
    ['{"value":"synthetic-secret",}', false, 'Invalid JSON syntax: trailing comma at character 28.'],
    ['{"value":"synthetic-secret"', false, 'Invalid JSON syntax: incomplete value at character 27.'],
    ['["synthetic-secret"]', false, null],
    ['{"value":"synthetic-secret"}', true, null],
  ] as const)('keeps tool input identity and logs content-free syntax diagnostics: %s', async (raw, valid, diagnostic) => {
    const diagnostics: string[] = [];
    const port = new OpenAiCompatiblePort(
      { baseUrl: 'https://provider.example/v1', apiKey: 'unrelated-key', model: 'synthetic-model' },
      { debugLog: line => diagnostics.push(line), fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{
          id: 'original-call', type: 'function', function: { name: 'synthetic_tool', arguments: raw },
        }] } }],
      })) },
    );
    const outcome = await port.generateToolTurn({
      messages: [modelUserMessage('synthetic input')],
      tools: [{ name: 'synthetic_tool', description: 'Synthetic boundary', inputSchema: z.object({ value: z.string() }) }],
      toolChoice: 'auto', phase: 'discovery',
    });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('Unexpected transport failure');
    const call = outcome.toolCalls[0]!;
    expect(call.callId).toBe('original-call');
    if (valid) {
      expect(call.valid).toBe(true);
      expect(call.input).toEqual({ value: secret });
    } else {
      expect(call.valid).toBe(false);
      expect(call.input).toBe(raw);
      if (call.valid) throw new Error('Malformed input accepted');
      expect(call.code).toBe('invalid_tool_input');
      expect(call.reason).toBe('Tool arguments were not a JSON object; send the required fields as one JSON object.');
      if (diagnostic) expect(diagnostics.some(line => line.includes(diagnostic))).toBe(true);
      expect(diagnostics.filter(line => line.startsWith('[AI] tool-arguments')).join(' ')).not.toContain(secret);
      expect(call.reason).not.toContain(secret);
      expect(call.reason.length).toBeLessThan(240);
    }
  });

  it('does not return the API key from an HTTP rejection', async () => {
    const port = new OpenAiCompatiblePort(
      { baseUrl: 'https://provider.example/v1', apiKey: secret, model: 'synthetic-model' },
      {
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => secret,
          headers: { get: () => null },
        }),
      },
    );
    const outcome = await port.generateToolTurn({
      messages: [modelUserMessage('synthetic input')],
      tools: [],
      toolChoice: 'auto',
      phase: 'discovery',
    });
    expect(outcome.status).toBe('error');
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
});


describe('explicit attachment export boundary', () => {
  const run = parseTrace([
    { type: 'turn-start', at: '2026-01-01T00:00:00.000Z', requestId: 'synthetic', runFingerprint: 'run' },
    { type: 'turn-terminal', at: '2026-01-01T00:00:00.001Z', requestId: 'synthetic', runFingerprint: 'run', status: 'ok' },
  ].map(row => JSON.stringify(row)).join('\n'));
  it.each([
    { mediaId: 1 }, { mediaId: 'bad|token' }, { mediaId: 'valid', uploadUrl: 'file:///private' },
    { mediaId: 'valid', uploadUrl: 'https://user:password@example.test' },
  ])('rejects malformed upload instructions without transferring content: %j', async payload => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload)));
    const result = await exportRunToLangfuse(run, {
      baseUrl: 'https://export.example', publicKey: 'synthetic', secretKey: 'secret', fetchImpl,
      attachments: { run: [{ name: 'evidence', contentType: 'text/plain', content: 'private evidence' }] },
    });
    expect(result.errors).toContainEqual(expect.stringContaining('invalid media response'));
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });
  it('reports a failed upload confirmation and excludes the attachment reference', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST' && String(_url).endsWith('/media')) return new Response(JSON.stringify({ mediaId: 'media-id', uploadUrl: 'https://upload.example/object' }));
      if (init?.method === 'PATCH') return new Response('{}', { status: 500 });
      return new Response('{}');
    });
    const result = await exportRunToLangfuse(run, {
      baseUrl: 'https://export.example', publicKey: 'synthetic', secretKey: 'secret', fetchImpl,
      attachments: { run: [{ name: 'evidence', contentType: 'text/plain', content: 'private evidence' }] },
    });
    expect(result.errors).toContainEqual(expect.stringContaining('confirmation HTTP 500'));
    expect(String(fetchImpl.mock.calls.at(-1)?.[1]?.body)).not.toContain('langfuseMedia');
  });
});
