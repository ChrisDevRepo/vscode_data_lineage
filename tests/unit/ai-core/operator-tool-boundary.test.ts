/** Boundaries of the optional headless and database runners. */
import { z } from 'zod';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  caseInventory,
  readBaselineMap,
  aiRuns,
  aiRunStatus,
  assessCapture,
  nextAiRunStep,
  databaseConfig,
  databaseImportEvidence,
  parseOptions,
  main,
  turnChecks,
} from '../../harness/cli';
import { loadHarnessParseRules } from '../../harness/sessionFactory';
import { loadRules } from '../../../src/engine/sqlBodyParser';
import { buildModelFromDmv } from '../../../src/engine/dmvExtractor';
import type { SimpleExecuteResult } from '../../../src/types/database';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import { loadParseRules, rootPath } from '../helpers/testUtils';

const { loadCases } = createRequire(import.meta.url)(
  '../../cases/loadCases.cjs',
) as {
  loadCases: (runner?: string) => Array<{
    id: string;
    prompt?: string;
    dacpac?: string;
    expect?: {
      terminal?: string;
      must_contain?: string[];
      missing_columns?: string[];
    };
  }>;
};
import {
  baselineSession,
  exportRunToLangfuse,
} from '../../harness/langfuseExport';
import { exportNativeEvidence } from '../../harness/nativeEvidence';
import { redactSecret, verboseContent } from '../../harness/exportShared';
import { OpenAiCompatiblePort } from '../../harness/openAiCompatiblePort';
import { parseTrace } from '../../harness/traceModel';
import type { GenerationEntry, ParsedRun } from '../../harness/traceModel';
import { TRACE_MODEL_SCHEMA_VERSION } from '../../harness/traceModel';
import { modelUserMessage } from '../../../src/ai/model/modelPort';

const secret = 'synthetic-secret';

describe('headless tool-call correlation', () => {
  it.each(
    [
      {
        name: 'text',
        message: { content: 'Partial answer' },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Partial answer' }],
          },
        ],
        received: true,
      },
      {
        name: 'tool',
        message: {
          tool_calls: [
            {
              id: 'call',
              type: 'function',
              function: { name: 'inspect', arguments: '{}' },
            },
          ],
        },
        output: [
          {
            type: 'function_call',
            call_id: 'call',
            name: 'inspect',
            arguments: '{}',
          },
        ],
        received: true,
      },
      { name: 'empty', message: {}, output: [], received: false },
    ].flatMap((row) =>
      (['chat_completions', 'responses'] as const).map((wire) => ({
        ...row,
        wire,
      })),
    ),
  )(
    'retains $name reply receipt for $wire when a completed HTTP body also carries an interruption',
    async ({ message, output, received, wire }) => {
      const error = { code: 'ECONNRESET', message: 'upstream socket hang up' };
      const fetchImpl = vi.fn(async () =>
        Response.json(
          wire === 'responses'
            ? { output, error }
            : { choices: [{ finish_reason: 'error', message, error }] },
        ),
      );
      const port = new OpenAiCompatiblePort(
        {
          baseUrl: 'https://provider.example/v1',
          apiKey: secret,
          model: 'synthetic',
          wire,
        },
        { fetchImpl },
      );
      const result = await port.generateToolTurn({
        messages: [modelUserMessage('Inspect.')],
        tools: [],
        phase: 'discover',
      });
      expect(result.status).toBe('error');
      if (result.status !== 'error')
        throw new Error('Expected provider failure.');
      expect(result.providerError.cause).toMatchObject({ code: 'ECONNRESET' });
      expect(result.providerError.replyReceived).toBe(
        received ? true : undefined,
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
  it.each(['{"query":"Sales"}', 'null'])(
    'refuses repeated IDs with arguments %s as a transport error',
    async (raw) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: ['{"query":"Orders"}', raw].map((args) => ({
                      id: 'same-id',
                      type: 'function',
                      function: {
                        name: 'lineage_search_objects',
                        arguments: args,
                      },
                    })),
                  },
                },
              ],
            }),
          ),
      );
      const port = new OpenAiCompatiblePort(
        {
          baseUrl: 'https://provider.example/v1',
          apiKey: secret,
          model: 'synthetic-model',
        },
        { fetchImpl },
      );
      const result = await port.generateToolTurn({
        messages: [modelUserMessage('Inspect orders.')],
        tools: [
          {
            name: 'lineage_search_objects',
            description: 'Search.',
            inputSchema: z.object({ query: z.string() }),
          },
        ],
        phase: 'discover',
      });
      expect(result.status).toBe('error');
      expect(result.toolCalls).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
});

describe('operator runner configuration', () => {
  it.each([
    ['ok', false, 'prompt'],
    ['error', false, 'case'],
    ['cancelled', false, 'stop'],
    ['ok', true, 'stop'],
    ['error', true, 'stop'],
  ] as const)(
    'selects the catalog continuation for outcome %s with aborted=%s',
    (outcome, aborted, next) => {
      expect(nextAiRunStep(outcome, aborted)).toBe(next);
    },
  );

  it.each([
    [[], 'error'],
    [['ok', 'ok'], 'ok'],
    [['error', 'ok'], 'error'],
    [['ok', 'error', 'ok'], 'error'],
    [['error', 'cancelled'], 'cancelled'],
  ] as const)(
    'preserves failures when aggregating catalog outcomes %j',
    (outcomes, expected) => {
      expect(aiRunStatus(outcomes.map((outcome) => ({ outcome })))).toBe(
        expected,
      );
    },
  );

  it('accepts a prompt and ordered follow-ups', () => {
    expect(
      parseOptions('ai', [
        '--prompt',
        'Inspect dependencies',
        '--followup',
        'First',
        '--followup',
        'Second',
        '--timeout-ms',
        '1000',
      ]),
    ).toMatchObject({
      prompt: 'Inspect dependencies',
      followups: ['First', 'Second'],
      timeoutMs: 1000,
      langfuse: true,
      verbose: true,
      attach: false,
      baseline: false,
    });
  });

  it('defaults the AI deadline to two hours and the database deadline to five', () => {
    expect(parseOptions('ai', []).timeoutMs).toBe(7_200_000);
    expect(parseOptions('ai', [])).toMatchObject({
      langfuse: true,
      verbose: true,
      attach: false,
      baseline: false,
    });
    expect(
      parseOptions('ai', ['--langfuse', '--trace-verbose', '--attach']),
    ).toMatchObject({ langfuse: true, verbose: true, attach: true });
    expect(parseOptions('db', [])).toMatchObject({
      langfuse: false,
      verbose: false,
      attach: false,
      timeoutMs: 300_000,
    });
  });

  it('baseline mode needs a branch, attaches files and owns its session; attach alone is not a baseline', () => {
    expect(
      parseOptions('ai', ['--baseline', '--branch', 'testing01']),
    ).toMatchObject({ baseline: true, attach: true, branch: 'testing01' });
    expect(() => parseOptions('ai', ['--baseline'])).toThrow(
      '--baseline requires --branch',
    );
    expect(() => parseOptions('ai', ['--branch', 'main'])).toThrow(
      '--branch is only for --baseline',
    );
    expect(() =>
      parseOptions('ai', ['--baseline', '--branch', 'main', '--session', 'x']),
    ).toThrow('do not pass --session');
    expect(() =>
      parseOptions('ai', ['--baseline', '--branch', 'feat/x']),
    ).toThrow('plain branch name');
    expect(baselineSession('main', '3ad819b4aa11bb22\n')).toBe(
      'baseline-main-3ad819b4',
    );
  });

  it('defaults request deadlines to the run deadline and accepts an independent AI request bound', () => {
    expect(parseOptions('ai', []).requestTimeoutMs).toBe(7_200_000);
    expect(parseOptions('ai', ['--timeout-ms', '1000']).requestTimeoutMs).toBe(
      1000,
    );
    expect(
      parseOptions('ai', [
        '--request-timeout-ms',
        '60000',
        '--timeout-ms',
        '1800000',
      ]),
    ).toMatchObject({ timeoutMs: 1_800_000, requestTimeoutMs: 60_000 });
    expect(() => parseOptions('db', ['--request-timeout-ms', '60000'])).toThrow(
      'Unknown option',
    );
  });

  it('accepts slower local-model budgets and gives explicit flags precedence over the environment', () => {
    vi.stubEnv('AI_TEST_TIMEOUT_MS', '28800000');
    vi.stubEnv('AI_TEST_REQUEST_TIMEOUT_MS', '10800000');
    try {
      expect(parseOptions('ai', [])).toMatchObject({
        timeoutMs: 28_800_000,
        requestTimeoutMs: 10_800_000,
      });
      expect(
        parseOptions('ai', [
          '--timeout-ms',
          '14400000',
          '--request-timeout-ms',
          '7200000',
        ]),
      ).toMatchObject({ timeoutMs: 14_400_000, requestTimeoutMs: 7_200_000 });
      expect(parseOptions('db', []).timeoutMs).toBe(300_000);
      vi.stubEnv('AI_TEST_TIMEOUT_MS', 'invalid');
      vi.stubEnv('AI_TEST_REQUEST_TIMEOUT_MS', 'invalid');
      expect(() => parseOptions('ai', [])).toThrow();
      expect(
        parseOptions('ai', [
          '--timeout-ms',
          '14400000',
          '--request-timeout-ms',
          '7200000',
        ]),
      ).toMatchObject({ timeoutMs: 14_400_000, requestTimeoutMs: 7_200_000 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('loops catalog headless rows unless a prompt is passed', () => {
    const rows = loadCases('headless');
    expect(rows.length).toBeGreaterThan(0);
    const runs = aiRuns(parseOptions('ai', []));
    expect(parseOptions('ai', []).baseline).toBe(false);
    expect(parseOptions('ai', ['--attach'])).toMatchObject({
      attach: true,
      baseline: false,
    });
    expect(runs.map((run) => run.id)).toEqual(rows.map((row) => row.id));
    expect(aiRuns(parseOptions('ai', ['--all'])).map((run) => run.id)).toEqual(
      rows.map((row) => row.id),
    );
    expect(
      aiRuns(parseOptions('ai', ['--case', rows[0].id])).map((run) => run.id),
    ).toEqual([rows[0].id]);
    expect(() =>
      aiRuns(parseOptions('ai', ['--case', 'unknown-case'])),
    ).toThrow('Unknown headless case');
    expect(() => parseOptions('ai', ['--all', '--case', rows[0].id])).toThrow(
      'without mixing selectors',
    );
    expect(() =>
      parseOptions('ai', ['--case', rows[0].id, '--prompt', 'Question']),
    ).toThrow('without mixing selectors');
    expect(runs.map((run) => run.prompts[0])).toEqual(
      rows.map((row) => row.prompt),
    );
    expect(runs.map((run) => run.expectTerminal)).toEqual(
      rows.map((row) => row.expect?.terminal),
    );
    const manual = aiRuns(
      parseOptions('ai', [
        '--prompt',
        'Inspect dependencies',
        '--followup',
        'First',
      ]),
    );
    expect(manual.map((run) => run.prompts)).toEqual([
      ['Inspect dependencies', 'First'],
    ]);
    expect(manual[0]?.expectTerminal).toBeUndefined();
    expect(() => aiRuns(parseOptions('ai', ['--followup', 'First']))).toThrow(
      '--followup requires --prompt.',
    );
  });

  it('assembles baseline pairs and inventory for the optional --all launcher', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlv-launcher-contract-'));
    try {
      const id = loadCases('headless')[0].id;
      const mapping = {
        cases: {
          [id]: {
            main: { runDir: join(dir, 'main'), turns: [1] },
            previous: { runDir: join(dir, 'previous') },
          },
        },
      };
      const path = join(dir, 'baselines.json');
      writeFileSync(path, JSON.stringify(mapping));
      const options = parseOptions('ai', ['--all', '--baselines', path]);
      const loaded = readBaselineMap(options.baselines!);
      expect(loaded).toEqual(mapping);
      expect(aiRuns(options).find((run) => run.id === id)).toBeDefined();
      const inventory = caseInventory();
      expect(
        inventory.additionalCases.every((row) => row.execution === 'not_run'),
      ).toBe(true);
      expect(
        inventory.unavailableCases.every(
          (row) => row.execution === 'not_runnable',
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(loadCases('headless').map((row) => [row.id, row] as const))(
    '%s names only objects and keywords its DACPAC contains',
    async (_id, row) => {
      loadParseRules();
      const model = await extractDacpac(readFileSync(rootPath(row.dacpac!)));
      const text = model.nodes
        .map((node) =>
          [
            node.id,
            node.bodyScript ?? '',
            ...(node.columns ?? []).map((col) => col.name),
          ].join(' '),
        )
        .join('\n')
        .toLowerCase();
      for (const keyword of row.expect?.must_contain ?? [])
        expect(text, keyword).toContain(keyword.toLowerCase());
      const trace = /\/trace\s+(\[[^\]]+\]\.\[[^\]]+\])\.\[([^\]]+)\]/.exec(
        row.prompt ?? '',
      );
      if (trace) {
        const node = model.nodes.find(
          (candidate) => candidate.id === trace[1].toLowerCase(),
        );
        expect(node, trace[1]).toBeDefined();
        const columns =
          `${node!.bodyScript ?? ''} ${(node!.columns ?? []).map((col) => col.name).join(' ')}`.toLowerCase();
        if (
          row.expect?.missing_columns?.some(
            (column) => column.toLowerCase() === trace[2].toLowerCase(),
          )
        ) {
          expect(columns).not.toContain(trace[2].toLowerCase());
        } else expect(columns).toContain(trace[2].toLowerCase());
      }
    },
  );

  it('holds only the first answer of a row to its content checks and reports every failure', () => {
    const run = {
      expectTerminal: 'ok',
      expectMetrics: {
        terminal: 'ok',
        must_contain: ['Price'],
        preview_chars_min: 5,
        rejections_max: 0,
      },
    };
    const turn = (text: string, outcome = 'ok') => ({
      terminalStatus: null,
      outcome: { outcome },
      events: [],
      text,
    });
    expect(turnChecks(run, turn('Price rules'), true)).toEqual([]);
    expect(turnChecks(run, turn('ok'), false)).toEqual([]);
    expect(turnChecks(run, turn('ok', 'error'), true)).toEqual([
      'terminal error, catalog expects ok',
      'output length 2 below min 5',
      'output missing required keyword "Price"',
    ]);
    expect(
      turnChecks(
        run,
        {
          ...turn('Price rules'),
          events: [{ type: 'error', recoverable: true }],
        },
        false,
      ),
    ).toEqual(['rejections 1 exceeded max 0']);
  });

  it.each([
    {
      label: 'unused approval',
      gate: [{ kind: 'approve' }],
      gates: [],
      first: true,
      failures: ['gate round 1 was not exercised'],
    },
    {
      label: 'approval',
      gate: [{ kind: 'approve' }],
      gates: [{ decision: 'approve' }],
      first: true,
      failures: [],
    },
    {
      label: 'wrong decision',
      gate: [{ kind: 'approve' }],
      gates: [{ decision: 'deny' }],
      first: true,
      failures: ['gate round 1 decision deny, expected approve'],
    },
    {
      label: 'missing second step',
      gate: [
        { kind: 'refine', instruction: 'one level upstream' },
        { kind: 'approve' },
      ],
      gates: [{ decision: 'refine', instruction: 'one level upstream' }],
      first: true,
      failures: ['gate round 2 was not exercised'],
    },
    {
      label: 'wrong refinement',
      gate: [{ kind: 'refine', instruction: 'one level upstream' }],
      gates: [{ decision: 'refine', instruction: 'all levels' }],
      first: true,
      failures: ['gate round 1 refinement differs from catalog'],
    },
    {
      label: 'conditional Change then approve',
      gate: [
        {
          kind: 'approve',
          expect: 'classification~business',
          onMismatch: { instruction: 'Use business.' },
        },
      ],
      gates: [
        {
          policyIndex: 0,
          decision: 'refine',
          instruction: 'Use business.',
          refine: { instruction: 'Use business.' },
          expectation: { expr: 'classification~business', ok: false },
        },
        {
          policyIndex: 0,
          decision: 'approve',
          expectation: { expr: 'classification~business', ok: true },
        },
      ],
      first: true,
      failures: [],
    },
    {
      label: 'follow-up',
      gate: [{ kind: 'approve' }],
      gates: [],
      first: false,
      failures: [],
    },
  ] as const)(
    'checks the catalog gate path for $label',
    ({ gate, gates, first, failures }) => {
      expect(
        turnChecks(
          { expectTerminal: 'ok', gate },
          {
            terminalStatus: 'ok',
            outcome: { outcome: 'ok' },
            events: [],
            text: 'Synthetic answer.',
            gates,
          },
          first,
        ),
      ).toEqual(failures);
    },
  );

  it.each([
    ['--timeout-ms', '0'],
    ['--timeout-ms', 'NaN'],
    ['--request-timeout-ms', '0'],
    ['--request-timeout-ms', 'NaN'],
    ['--request-timeout-ms', '2147423648'],
    ['--request-timeout-ms'],
    ['--prompt'],
    ['--runs', '10'],
  ])('rejects invalid or campaign options %j', (...args) => {
    expect(() => parseOptions('ai', args)).toThrow();
  });

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
    const read = vi
      .spyOn(loader, 'loadCases')
      .mockReturnValue([
        { ...rows[0], expect: { ...rows[0].expect, tokens_max: 1 } },
      ]);
    try {
      expect(() => aiRuns(parseOptions('ai', []))).toThrow(
        'expect.tokens_max is unsupported',
      );
    } finally {
      read.mockRestore();
    }
  });

  it.each([['unknown'], ['']])(
    'rejects a run without a hosted provider instead of choosing one (AI_TEST_PROVIDER=%j)',
    async (providerName) => {
      vi.stubEnv('AI_TEST_PROVIDER', providerName);
      vi.stubEnv('AI_TEST_MODEL', 'synthetic-model');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await main('ai', ['--prompt', 'test'])).toBe(4);
        expect(error.mock.calls[0]?.[0]).toContain(
          'Set AI_TEST_PROVIDER to a hosted provider',
        );
      } finally {
        error.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it('names the timeout bound when --timeout-ms is out of range', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await main('ai', ['--prompt', 'test', '--timeout-ms', '2147423648']),
      ).toBe(4);
      expect(error.mock.calls[0]?.[0]).toContain(
        'test timeout must be at most 2147423647',
      );
    } finally {
      error.mockRestore();
    }
  });

  it('rejects AI-only switches on the database runner', () => {
    expect(() => parseOptions('db', ['--langfuse'])).toThrow();
  });

  it('stops an AI run before the model when Langfuse settings are missing', async () => {
    vi.stubEnv('AI_TEST_PROVIDER', 'openai-compatible');
    vi.stubEnv('AI_TEST_MODEL', 'synthetic-model');
    vi.stubEnv('AI_TEST_API_KEY', 'synthetic-key');
    vi.stubEnv('AI_TEST_ENDPOINT', 'https://provider.example/v1');
    vi.stubEnv('LANGFUSE_BASE_URL', '');
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '');
    vi.stubEnv('LANGFUSE_SECRET_KEY', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main('ai', ['--prompt', 'test'])).toBe(4);
      expect(error.mock.calls[0]?.[0]).toContain(
        'Set all LANGFUSE_* connection variables before an AI run.',
      );
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('requires the verbose trace, debug log, Langfuse export, and a state dump on every turn', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'dlv-capture-'));
    try {
      writeFileSync(
        join(runDir, 'host.log'),
        '2026-10-17 info [headless] ready\n',
      );
      writeFileSync(
        join(runDir, 'trace.ndjson'),
        '{"type":"trace-open","origin":"headless-harness","verbose":true}\n',
      );
      const discovery = join(runDir, 'turn-1');
      const explored = join(runDir, 'turn-2');
      mkdirSync(discovery);
      mkdirSync(explored);
      writeFileSync(
        join(discovery, 'hop-log.json'),
        '[{"tool":"lineage_search_objects"}]\n',
      );
      writeFileSync(
        join(discovery, 'sm-state.json'),
        '{"explorationOpened":false}\n',
      );
      writeFileSync(join(explored, 'present-result.json'), '{}\n');
      writeFileSync(join(explored, 'sm-state.json'), '{"visited":[]}\n');
      expect(
        assessCapture(runDir, join(runDir, 'trace.ndjson'), 'ok', 2).gaps,
      ).toEqual([]);
      rmSync(join(explored, 'present-result.json'));
      writeFileSync(
        join(explored, 'sm-state.json'),
        '{"status":"awaiting_findings","visited":["[ai].[synthetic]"]}\n',
      );
      expect(
        assessCapture(runDir, join(runDir, 'trace.ndjson'), 'ok', 2)
          .explorations,
      ).toEqual([
        { turn: 1, opened: false },
        { turn: 2, opened: true },
      ]);
      writeFileSync(join(explored, 'present-result.json'), '{}\n');
      writeFileSync(
        join(runDir, 'trace.ndjson'),
        '{"type":"trace-open","verbose":false}\n',
      );
      rmSync(join(discovery, 'sm-state.json'));
      rmSync(join(explored, 'sm-state.json'));
      writeFileSync(join(runDir, 'host.log'), '');
      expect(
        assessCapture(runDir, join(runDir, 'trace.ndjson'), 'disabled', 2).gaps,
      ).toEqual([
        'Opening trace record is not verbose.',
        'Debug log is missing.',
        'Trace export is disabled.',
        'Turn 1 has no sm-state.json.',
        'Turn 2 has no sm-state.json.',
      ]);
      expect(
        assessCapture(runDir, join(runDir, 'trace.ndjson'), 'ok', 2)
          .explorations,
      ).toEqual([
        { turn: 1, opened: false },
        { turn: 2, opened: true },
      ]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('records production SQL parsing from a cold parser and rejects a disconnected import projection', async () => {
    loadRules({ rules: [] });
    await loadHarnessParseRules();
    const raw = (fields: string[], rows: string[][]): SimpleExecuteResult => ({
      rowCount: rows.length,
      columnInfo: fields.map((columnName) => ({ columnName })),
      rows: rows.map((row) =>
        row.map((displayValue) => ({ displayValue, isNull: false })),
      ),
    });
    const model = buildModelFromDmv({
      nodes: raw(
        ['schema_name', 'object_name', 'type_code', 'body_script'],
        [
          ['dbo', 'Input', 'U', ''],
          [
            'dbo',
            'ReadInput',
            'V',
            'CREATE VIEW [dbo].[ReadInput] AS SELECT Value FROM [dbo].[Input]',
          ],
        ],
      ),
      columns: raw([], []),
      dependencies: raw([], []),
    });
    expect(databaseImportEvidence(model)).toMatchObject({
      source: 'database',
      scriptedObjects: 1,
      readableDefinitions: 1,
      sqlBodyParsing: 'exercised',
      graphEndpoints: 'verified',
    });
    expect(databaseImportEvidence(model).parsedReferences).toBeGreaterThan(0);
    expect(model.edges).toContainEqual(
      expect.objectContaining({
        source: '[dbo].[input]',
        target: '[dbo].[readinput]',
      }),
    );
    expect(
      databaseImportEvidence({
        ...model,
        nodes: model.nodes.filter((node) => node.type === 'table'),
        edges: [],
      }).sqlBodyParsing,
    ).toBe('not_exercised');
    expect(() =>
      databaseImportEvidence({
        ...model,
        edges: [{ source: 'absent', target: model.nodes[0].id, type: 'body' }],
      }),
    ).toThrow('unresolved edge endpoints');
  });

  it('requires database settings and does not put the password on the connection object', () => {
    expect(() => databaseConfig({})).toThrow('DB_TEST_SERVER');
    const env = {
      DB_TEST_SERVER: 'localhost',
      DB_TEST_DATABASE: 'synthetic',
      DB_TEST_USER: 'reader',
      DB_TEST_PASSWORD: 'synthetic-password',
    };
    expect(databaseConfig(env)).toMatchObject({
      authenticationType: 'sqlLogin',
      encrypt: true,
      trustServerCertificate: false,
    });
    expect(databaseConfig(env)).not.toHaveProperty('password');
    expect(() => databaseConfig({ ...env, DB_TEST_PORT: '65536' })).toThrow();
    expect(() => databaseConfig({ ...env, DB_TEST_ENCRYPT: 'yes' })).toThrow();

    // SQL login names may contain '@'; Entra authentication is explicit.
    const entraAuto = databaseConfig({
      ...env,
      DB_TEST_USER: 'admin@company.com',
    });
    expect(entraAuto).toMatchObject({
      authenticationType: 'sqlLogin',
      user: 'admin@company.com',
    });

    // Explicit DB_TEST_AUTH_TYPE
    const explicitEntra = databaseConfig({
      ...env,
      DB_TEST_AUTH_TYPE: 'entraId',
      DB_TEST_TENANT_ID: 'custom-tenant-guid',
      DB_TEST_TOKEN: 'access-token',
    });
    expect(explicitEntra).toMatchObject({
      authenticationType: 'entraId',
      tenantId: 'custom-tenant-guid',
    });
    // The launcher supplies any noninteractive token before this configuration boundary.
    expect(() =>
      databaseConfig({
        ...env,
        DB_TEST_AUTH_TYPE: 'entraId',
        DB_TEST_TOKEN: '',
      }),
    ).toThrow('Set DB_TEST_TOKEN');

    const explicitSql = databaseConfig({
      ...env,
      DB_TEST_USER: 'admin@company.com',
      DB_TEST_AUTH_TYPE: 'sqlLogin',
    });
    expect(explicitSql).toMatchObject({ authenticationType: 'sqlLogin' });
  });
});

describe('operator secret boundary', () => {
  it.each([
    [
      'replaces the secret wherever it appears',
      `seen ${secret} here`,
      secret,
      'seen [redacted] here',
    ],
    [
      'leaves text unchanged when no secret is configured',
      `seen ${secret} here`,
      '',
      `seen ${secret} here`,
    ],
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
      wire: [
        {
          type: 'wire-request',
          requestId: 'r',
          generation: 1,
          systemHash: 'hash',
          messages: [],
          tools: [],
          at: '2026-01-01T00:00:00.000Z',
          lineIndex: 0,
        },
      ],
    } as unknown as ParsedRun;
    const generation = { requestId: 'r', generation: 1 } as GenerationEntry;
    expect(verboseContent(run, generation)).toEqual({});
  });

  it.each([
    [
      '{"value":"synthetic-secret",}',
      false,
      'Invalid JSON syntax: trailing comma at character 28.',
    ],
    [
      '{"value":"synthetic-secret"',
      false,
      'Invalid JSON syntax: incomplete value at character 27.',
    ],
    ['["synthetic-secret"]', false, null],
    ['{"value":"synthetic-secret"}', true, null],
  ] as const)(
    'keeps tool input identity and logs content-free syntax diagnostics: %s',
    async (raw, valid, diagnostic) => {
      const diagnostics: string[] = [];
      const port = new OpenAiCompatiblePort(
        {
          baseUrl: 'https://provider.example/v1',
          apiKey: 'unrelated-key',
          model: 'synthetic-model',
        },
        {
          debugLog: (line) => diagnostics.push(line),
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      tool_calls: [
                        {
                          id: 'original-call',
                          type: 'function',
                          function: { name: 'synthetic_tool', arguments: raw },
                        },
                      ],
                    },
                  },
                ],
              }),
            ),
        },
      );
      const outcome = await port.generateToolTurn({
        messages: [modelUserMessage('synthetic input')],
        tools: [
          {
            name: 'synthetic_tool',
            description: 'Synthetic boundary',
            inputSchema: z.object({ value: z.string() }),
          },
        ],
        toolChoice: 'auto',
        phase: 'discovery',
      });
      expect(outcome.status).toBe('completed');
      if (outcome.status !== 'completed')
        throw new Error('Unexpected transport failure');
      const call = outcome.toolCalls[0]!;
      expect(call.callId).toBe('original-call');
      if (valid) {
        expect(call.valid).toBe(true);
        expect(call.input).toEqual({ value: secret });
      } else {
        expect(call.valid).toBe(false);
        expect(call.input).toBe(raw);
        if (call.valid) throw new Error('Malformed input accepted');
        expect(call.code).toBe('type');
        expect(call.reason).toBe(
          'Tool arguments were not a JSON object; send the required fields as one JSON object.',
        );
        if (diagnostic)
          expect(diagnostics.some((line) => line.includes(diagnostic))).toBe(
            true,
          );
        expect(
          diagnostics
            .filter((line) => line.startsWith('[AI] tool-arguments'))
            .join(' '),
        ).not.toContain(secret);
        expect(call.reason).not.toContain(secret);
        expect(call.reason.length).toBeLessThan(240);
      }
    },
  );

  it('D-103: normalizes a lossless spelling once with the served schema, like the product port', async () => {
    const diagnostics: string[] = [];
    const port = new OpenAiCompatiblePort(
      {
        baseUrl: 'https://provider.example/v1',
        apiKey: 'unrelated-key',
        model: 'synthetic-model',
      },
      {
        debugLog: (line) => diagnostics.push(line),
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'encoded',
                        type: 'function',
                        function: {
                          name: 'synthetic_tool',
                          arguments: JSON.stringify({
                            values: '["a","b"]',
                            n: '2',
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          ),
      },
    );
    const outcome = await port.generateToolTurn({
      messages: [modelUserMessage('synthetic input')],
      toolChoice: 'auto',
      phase: 'discovery',
      tools: [
        {
          name: 'synthetic_tool',
          description: 'Synthetic boundary',
          inputSchema: z.object({ values: z.array(z.string()), n: z.number() }),
        },
      ],
    });
    if (outcome.status !== 'completed')
      throw new Error('Unexpected transport failure');
    expect(outcome.toolCalls).toEqual([
      {
        valid: true,
        callId: 'encoded',
        toolName: 'synthetic_tool',
        input: { values: ['a', 'b'], n: 2 },
      },
    ]);
    expect(
      diagnostics.filter((line) => line.startsWith('[Normalize]')),
    ).toEqual([
      '[Normalize] tool=synthetic_tool path=values beforeBytes=9',
      '[Normalize] tool=synthetic_tool path=n beforeBytes=1',
    ]);
  });

  it('does not return the API key from an HTTP rejection', async () => {
    const port = new OpenAiCompatiblePort(
      {
        baseUrl: 'https://provider.example/v1',
        apiKey: secret,
        model: 'synthetic-model',
      },
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
  it('native export redacts every configured harness secret, including the provider endpoint host', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dlv-native-redact-'));
    // The media stub hands out an upload URL, so the attachment bytes are really sent (PUT) and checked below.
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) =>
      init?.method === 'POST' && String(url).endsWith('/media')
        ? Response.json({
            mediaId: 'media-id',
            uploadUrl: 'https://upload.example/object',
          })
        : Response.json({}),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const host = 'private-endpoint.example';
    try {
      const trace = [
        {
          type: 'trace-open',
          at: '2026-01-01T00:00:00.000Z',
          origin: 'native',
          verbose: true,
        },
        {
          type: 'turn-start',
          at: '2026-01-01T00:00:00.000Z',
          requestId: 'synthetic',
          runFingerprint: 'run',
          note: `https://${host}/openai/responses db-credential`,
        },
        {
          type: 'turn-terminal',
          at: '2026-01-01T00:00:00.001Z',
          requestId: 'synthetic',
          runFingerprint: 'run',
          status: 'ok',
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n');
      const state = join(directory, 'sm-state.json');
      writeFileSync(state, `{"endpoint":"https://${host}/openai"}\n`);
      writeFileSync(
        join(directory, 'host.log'),
        `request-start https://${host}/openai/responses db-credential\n`,
      );
      // Baseline mode freezes and uploads attachments.
      // Free-plan pacing waits between uploads; fake timers run them at once.
      vi.useFakeTimers();
      const exported = exportNativeEvidence({
        trace,
        directory,
        sessionId: 'synthetic-session',
        promptId: 'synthetic',
        statePaths: new Map([['synthetic', state]]),
        env: {
          AI_TEST_BASELINE: '1',
          AI_TEST_BRANCH: 'testing01',
          AI_TEST_ENDPOINT: `https://${host}/openai/responses`,
          DB_TEST_PASSWORD: 'db-credential',
          LANGFUSE_BASE_URL: 'https://export.example',
          LANGFUSE_PUBLIC_KEY: 'public',
          LANGFUSE_SECRET_KEY: 'credential',
        },
      });
      await vi.runAllTimersAsync();
      await exported;
      const sent = fetchImpl.mock.calls
        .map(([, init]) =>
          typeof init?.body === 'string'
            ? init.body
            : Buffer.from((init?.body ?? '') as Uint8Array).toString('utf8'),
        )
        .join('\n');
      const files = ['evidence-snapshot.json', 'langfuse-otlp.json']
        .map((file) => readFileSync(join(directory, file), 'utf8'))
        .join('\n');
      expect(
        fetchImpl.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(true);
      expect(sent).toContain('[redacted]');
      expect(files).toContain('[redacted]');
      for (const text of [sent, files]) {
        expect(text).not.toContain(host);
        expect(text).not.toContain('db-credential');
      }
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const run = parseTrace(
    [
      {
        type: 'turn-start',
        at: '2026-01-01T00:00:00.000Z',
        requestId: 'synthetic',
        runFingerprint: 'run',
      },
      {
        type: 'turn-terminal',
        at: '2026-01-01T00:00:00.001Z',
        requestId: 'synthetic',
        runFingerprint: 'run',
        status: 'ok',
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  it('reports a failed upload confirmation and excludes the attachment reference', async () => {
    let retainedPayload: string | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST' && String(_url).endsWith('/media')) {
        if (JSON.parse(String(init.body)).contentLength === 0)
          return new Response('{}', { status: 400 });
        return new Response(
          JSON.stringify({
            mediaId: 'media-id',
            uploadUrl: 'https://upload.example/object',
          }),
        );
      }
      if (init?.method === 'PATCH') return new Response('{}', { status: 500 });
      return new Response('{}');
    });
    const result = await exportRunToLangfuse(run, {
      baseUrl: 'https://export.example',
      publicKey: 'synthetic',
      secretKey: 'secret',
      fetchImpl,
      onPayload: (body) => {
        retainedPayload = body;
      },
      runMetadata: { isBaseline: true, tags: ['baseline'] },
      attachments: {
        run: [
          {
            name: 'evidence',
            contentType: 'text/plain',
            content: 'private evidence',
          },
          { name: 'answer', contentType: 'text/plain', content: '' },
        ],
      },
    });
    expect(result.errors).toContainEqual(
      expect.stringContaining('confirmation HTTP 500'),
    );
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/media')),
    ).toHaveLength(1);
    const exportedAttributes = JSON.parse(retainedPayload!).resourceSpans[0]
      .scopeSpans[0].spans[0].attributes;
    expect(
      JSON.parse(
        exportedAttributes.find(
          (attribute: { key: string }) =>
            attribute.key === 'langfuse.trace.metadata.attachments',
        ).value.stringValue,
      ).answer,
    ).toEqual({
      empty: true,
      contentLength: 0,
      sha256Hash: '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
      contentType: 'text/plain',
    });
    expect(String(fetchImpl.mock.calls.at(-1)?.[1]?.body)).not.toContain(
      'langfuseMedia',
    );
    expect(retainedPayload).toBe(fetchImpl.mock.calls.at(-1)?.[1]?.body);
    expect(
      JSON.parse(retainedPayload!).resourceSpans[0].scopeSpans[0].spans[0],
    ).toMatchObject({
      traceId: result.traceIds[0],
      spanId: expect.any(String),
    });
    expect(retainedPayload).not.toContain('authorization');
    expect(retainedPayload).not.toContain('secret');
    expect(
      JSON.parse(retainedPayload!).resourceSpans[0].scopeSpans[0].spans[0]
        .attributes,
    ).toContainEqual({
      key: 'langfuse.trace.metadata.isBaseline',
      value: { boolValue: true },
    });
    expect(
      JSON.parse(retainedPayload!).resourceSpans[0].scopeSpans[0].spans[0]
        .attributes,
    ).toContainEqual({
      key: 'langfuse.observation.metadata.isBaseline',
      value: { boolValue: true },
    });
  });
});
