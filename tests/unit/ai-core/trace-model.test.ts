/**
 * Regression tests for `tests/harness/traceModel.ts`.
 *
 * @remarks
 * The parser is the foundation the CLI's run summary and the Langfuse exporter both build on, so
 * the properties pinned here are the ones a consumer can least afford to have silently drift: the
 * round trip is byte-identical, an unrecognized record type never disappears, one malformed line
 * never takes the rest of the file down with it, and the turn-join accessor pairs the right
 * `turn-start` with the right `turn-terminal` rather than the first one it sees.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRACE_MODEL_SCHEMA_VERSION,
  joinTurns,
  parseTrace,
  serializeRun,
  type ParsedRun,
} from '../../harness/traceModel';

const FIXTURE_PATH = join(__dirname, '../../fixtures/trace/sample-trace.ndjson');
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');

describe('parseTrace / serializeRun round trip', () => {
  it('reproduces the fixture byte-for-byte', () => {
    const run = parseTrace(FIXTURE_TEXT);
    expect(serializeRun(run)).toBe(FIXTURE_TEXT);
  });

  it('round-trips an empty file to an empty run and back to an empty string', () => {
    const run = parseTrace('');
    expect(run).toMatchObject({
      schemaVersion: TRACE_MODEL_SCHEMA_VERSION,
      turns: [], generations: [], tools: [], gates: [], phases: [], wire: [], raw: [], malformed: [],
    });
    expect(serializeRun(run)).toBe('');
  });

  it('tolerates a file with no trailing newline the same way', () => {
    const withoutTrailingNewline = FIXTURE_TEXT.replace(/\n$/, '');
    const run = parseTrace(withoutTrailingNewline);
    // The writer always terminates the last line with '\n'; serializeRun restores that convention
    // even when the input under test happened not to have one.
    expect(serializeRun(run)).toBe(FIXTURE_TEXT);
  });

  it('preserves every record field exactly, not just its type', () => {
    const run = parseTrace(FIXTURE_TEXT);
    const firstGeneration = run.generations[0];
    expect(firstGeneration).toMatchObject({
      type: 'generation',
      requestId: 'req-a',
      generation: 1,
      phase: 'detect_entry',
      modelId: 'deepseek/deepseek-chat',
      finishReason: 'tool_calls',
      latencyMs: 541,
      usage: { inputTokens: 420, outputTokens: 36, totalTokens: 456 },
    });
    expect(typeof firstGeneration.lineIndex).toBe('number');
    expect(typeof firstGeneration.at).toBe('string');
  });
});

describe('unknown and malformed lines', () => {
  it('keeps an unrecognized type verbatim in raw[] rather than dropping it', () => {
    const run = parseTrace(FIXTURE_TEXT);
    expect(run.raw).toHaveLength(1);
    expect(run.raw[0]).toMatchObject({
      type: 'budget-snapshot',
      requestId: 'req-c',
      tokensRemaining: 48_000,
    });
  });

  it('isolates the malformed line without losing any well-formed neighbor', () => {
    const run = parseTrace(FIXTURE_TEXT);
    expect(run.malformed).toHaveLength(1);
    expect(run.malformed[0]).toMatchObject({ errorName: 'SyntaxError' });
    expect(run.malformed[0].text).toContain('"requestId":"req-c"');
    // The malformed line is the last physical line of the fixture; every record before it must
    // still have parsed — a single bad line must not abort the rest of the file.
    expect(run.turns.length + run.generations.length + run.tools.length
      + run.gates.length + run.phases.length + run.wire.length + run.raw.length)
      .toBe(27);
  });

  it('routes syntactically valid JSON that is not a trace record to malformed, not raw', () => {
    const run = parseTrace('[1,2,3]\n"a bare string"\n42\n');
    expect(run.malformed).toHaveLength(3);
    expect(run.malformed.map((entry) => entry.errorName)).toEqual([
      'NotATraceRecord', 'NotATraceRecord', 'NotATraceRecord',
    ]);
    expect(run.raw).toHaveLength(0);
  });
});

describe('typed accessor bucket counts', () => {
  const run: ParsedRun = parseTrace(FIXTURE_TEXT);

  it.each([
    ['turns', 5], // 3 turn-start + 2 turn-terminal
    ['generations', 2],
    ['tools', 3],
    ['gates', 2],
    ['phases', 6],
    ['wire', 8], // 3 wire-request + 2 wire-response + 1 wire-error + 2 provider-raw
    ['raw', 1],
    ['malformed', 1],
  ] as const)('%s has %i entries', (bucket, count) => {
    expect(run[bucket]).toHaveLength(count);
  });

  it('every wire entry is a request, response, error, or provider-raw record — never a generation', () => {
    const wireTypes = new Set(run.wire.map((entry) => entry.type));
    expect(wireTypes).toEqual(new Set(['wire-request', 'wire-response', 'wire-error', 'provider-raw']));
  });

  it('assigns each line a distinct, source-ordered lineIndex', () => {
    const indices = [
      ...run.turns, ...run.generations, ...run.tools, ...run.gates, ...run.phases, ...run.wire, ...run.raw,
    ].map((entry) => entry.lineIndex);
    expect(new Set(indices).size).toBe(indices.length);
    expect(Math.max(...indices, ...run.malformed.map((entry) => entry.line))).toBe(27);
  });
});

describe('joinTurns', () => {
  const run = parseTrace(FIXTURE_TEXT);
  const joined = joinTurns(run);

  it('pairs a completed turn (req-a) with both halves present', () => {
    const turnA = joined.find((entry) => entry.requestId === 'req-a');
    expect(turnA).toBeDefined();
    expect(turnA?.runFingerprint).toBe('run-a');
    expect(turnA?.start).toMatchObject({ type: 'turn-start', requestId: 'req-a' });
    expect(turnA?.terminal).toMatchObject({ type: 'turn-terminal', requestId: 'req-a', status: 'ok', modelCalls: 2 });
  });

  it('pairs an errored turn (req-b) and keeps its terminal reason and error code', () => {
    const turnB = joined.find((entry) => entry.requestId === 'req-b');
    expect(turnB?.terminal).toMatchObject({
      status: 'error', reason: 'provider_calls', errorCode: 'E_PROVIDER', modelCalls: 1,
    });
  });

  it('leaves an orphan start (req-c, cut off before a terminal record) with terminal undefined', () => {
    const turnC = joined.find((entry) => entry.requestId === 'req-c');
    expect(turnC?.start).toBeDefined();
    expect(turnC?.terminal).toBeUndefined();
  });

  it('joins exactly the three requestIds the fixture defines, each once', () => {
    expect(joined.map((entry) => entry.requestId).sort()).toEqual(['req-a', 'req-b', 'req-c']);
  });
});
