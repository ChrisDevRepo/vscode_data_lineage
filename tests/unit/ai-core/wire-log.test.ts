import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as vscode from 'vscode';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { AiTraceWriter } from '../../../src/ai/observability/aiTraceWriter';
import {
  safeTraceStringify,
  systemPromptHash,
  type WireRecord,
} from '../../../src/ai/observability/wireLog';

describe('model wire log', () => {
  it('makes an acknowledged record readable before the writer closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lineage-trace-'));
    const writer = new AiTraceWriter();
    const file = await writer.enable(root);

    await writer.write({
      type: 'turn-start',
      requestId: 'request-visible',
      runFingerprint: 'run',
      sessionFingerprint: 'session',
      modelFingerprint: 'model',
    });

    expect(await readFile(file, 'utf8')).toContain('"requestId":"request-visible"');
    await writer.close();
  });

  it('writes lifecycle and wire records to one session trace after the command enables it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lineage-trace-'));
    const writer = new AiTraceWriter();
    const file = await writer.enable(root);
    expect(await writer.enable(root)).toBe(file);
    await writer.write({
      type: 'turn-start',
      requestId: 'request-1',
      runFingerprint: 'run',
      sessionFingerprint: 'session',
      modelFingerprint: 'model',
    });

    const result = await runTurn((record) => {
      void writer.write(record);
    });
    await writer.close();

    expect(result.toolCalls).toEqual([
      expect.objectContaining({ valid: true, callId: 'call-2', input: { id: 'orders' } }),
    ]);

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4);
    const [lifecycle, request, response, generation] =
      lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lifecycle).toMatchObject({ type: 'turn-start', runFingerprint: 'run' });
    expect(request).toMatchObject({
      type: 'wire-request',
      requestId: 'request-1',
      generation: 1,
      phase: 'synthesis',
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    });
    expect(typeof request.at).toBe('string');
    // Default (non-verbose) capture: the system instruction is identified, never reproduced.
    expect(request.systemHash).toMatch(/^[0-9a-f]{64}$/);
    expect(request.systemHash).toBe(systemPromptHash('stable prefix'));
    expect(request).not.toHaveProperty('system');
    // The role integer is preserved verbatim: the API has no System role, so the system prompt
    // arrives as User (1) exactly like the question next to it.
    expect(request.messages).toEqual([
      { role: 1, parts: [{ type: 'text', value: 'stable prefix' }] },
      { role: 1, parts: [{ type: 'text', value: 'trace dbo.Orders' }] },
      {
        role: 2,
        parts: [{
          type: 'tool-call', callId: 'call-1', name: 'lineage_present_result', input: { id: 'prior' },
        }],
      },
      {
        role: 1,
        parts: [{
          type: 'tool-result',
          callId: 'call-1',
          content: [{ type: 'text', value: '{"results":[]}' }],
        }],
      },
    ]);
    // The tool input schema is the field no other capture surface exposes.
    expect(request.tools).toEqual([{
      name: 'lineage_present_result',
      inputSchema: expect.objectContaining({
        type: 'object',
        properties: { id: { type: 'string' } },
      }),
    }]);

    expect(response).toMatchObject({
      type: 'wire-response',
      requestId: 'request-1',
      generation: 1,
      phase: 'synthesis',
      text: 'thinking about it',
      toolCalls: [{ callId: 'call-2', name: 'lineage_present_result', input: { id: 'orders' } }],
    });

    // The measurement row. `modelId` is CLEAR TEXT on purpose — `turn-start` carries only a
    // `modelFingerprint`, which cannot answer "which model produced this" across lanes or runs.
    expect(generation).toMatchObject({
      type: 'generation',
      requestId: 'request-1',
      generation: 1,
      phase: 'synthesis',
      modelId: 'publisher.exact',
      finishReason: 'tool-calls',
    });
    expect(typeof generation.latencyMs).toBe('number');
    expect(generation.latencyMs as number).toBeGreaterThanOrEqual(0);
    // Structurally unavailable on this lane: `vscode.lm` reports no token counts, and a zeroed
    // usage block would be indistinguishable from a provider that genuinely billed nothing.
    expect(generation).not.toHaveProperty('usage');
  });

  it('captures the verbatim system instruction only while the trace runs verbose', async () => {
    const verbose: WireRecord[] = [];
    await runTurn((record) => { verbose.push(record); }, { traceVerbose: true });
    const quiet: WireRecord[] = [];
    await runTurn((record) => { quiet.push(record); });

    const verboseRequest = verbose.find((record) => record.type === 'wire-request');
    const quietRequest = quiet.find((record) => record.type === 'wire-request');
    expect(verboseRequest).toMatchObject({
      system: 'stable prefix',
      systemHash: systemPromptHash('stable prefix'),
    });
    // Same hash either way: the identifier is what makes the two runs comparable at all.
    expect(quietRequest).toMatchObject({ systemHash: systemPromptHash('stable prefix') });
    expect(quietRequest).not.toHaveProperty('system');
  });

  it('emits one generation record per completed call and none for a failed one', async () => {
    const records: WireRecord[] = [];
    const model = {
      id: 'publisher.counted',
      name: 'Counted',
      vendor: 'test',
      family: 'scripted',
      version: '1',
      sendRequest: vi.fn()
        .mockResolvedValueOnce({ stream: asyncIterable([new vscode.LanguageModelTextPart('answer')]) })
        .mockRejectedValueOnce(new Error('provider unavailable')),
    };
    const port = new VscodeModelPort(model as never, {
      requestId: 'request-counted',
      wireLog: (record) => records.push(record),
    });

    // `completeText` goes through the same private collection path, so its generation is recorded
    // too — a turn's model-call accounting must not depend on which port method the graph used.
    expect(await port.completeText({ messages: [new HumanMessage('summarize')], phase: 'synthesis' }))
      .toBe('answer');
    const failed = await port.generateToolTurn({
      messages: [new HumanMessage('again')],
      tools: [],
      phase: 'synthesis',
    });
    expect(failed.status).toBe('error');

    expect(records.map((record) => record.type))
      .toEqual(['wire-request', 'wire-response', 'generation', 'wire-request', 'wire-error']);
    expect(records[2]).toMatchObject({
      type: 'generation',
      generation: 1,
      modelId: 'publisher.counted',
      // No tool call in the response, so the generation stopped rather than dispatched.
      finishReason: 'stop',
    });
  });

  // The capture carries schema, table and column names and SQL, so containment is the part of the
  // guarantee every platform can verify: the session trace lands inside the caller's `lm-trace`
  // directory and nowhere else. The 0o600 mode is checked in addition where it exists — Windows
  // has no POSIX mode bits (Node reports 0o666 for any writable file and `chmod` only toggles the
  // read-only attribute), so asserting them there would encode the gap as intent.
  it('creates the session trace inside the caller log directory, owner-readable only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lineage-trace-'));
    const writer = new AiTraceWriter();
    const file = await writer.enable(root);
    await writer.close();

    const traceDirectory = join(root, 'lm-trace');
    expect(isAbsolute(file)).toBe(true);
    expect(dirname(resolve(file))).toBe(resolve(traceDirectory));
    expect(relative(resolve(root), resolve(file)).startsWith('..')).toBe(false);
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('creates no file and changes no result before the session command enables it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lineage-trace-'));
    const traceDirectory = join(root, 'lm-trace');
    const writer = new AiTraceWriter();

    const result = await runTurn((record) => {
      void writer.write(record);
    });
    await writer.close();

    await expect(access(traceDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result).toMatchObject({ status: 'completed', text: 'thinking about it' });
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ valid: true, callId: 'call-2', input: { id: 'orders' } }),
    ]);
  });

  it('pairs a failed provider request with a sanitized wire error', async () => {
    const records: WireRecord[] = [];
    const providerError = Object.assign(
      new Error('POST https://router.example/v1 failed with Bearer sk-secretvalue12345678'),
      { code: 'ECONNRESET' },
    );
    const model = {
      id: 'publisher.failing',
      name: 'Failing',
      vendor: 'test',
      family: 'scripted',
      version: '1',
      sendRequest: vi.fn().mockRejectedValue(providerError),
    };
    const result = await new VscodeModelPort(model as never, {
      requestId: 'request-error',
      wireLog: (record) => records.push(record),
    }).generateToolTurn({
      messages: [new HumanMessage('trace orders')],
      tools: [],
      phase: 'discover',
    });

    expect(result.status).toBe('error');
    expect(records.map((record) => record.type)).toEqual(['wire-request', 'wire-error']);
    expect(records[1]).toMatchObject({
      type: 'wire-error',
      requestId: 'request-error',
      generation: 1,
      phase: 'discover',
      diagnostic: {
        phase: 'discover',
        code: 'provider_error',
        cause: { code: 'ECONNRESET' },
      },
    });
    const serialized = JSON.stringify(records[1]);
    expect(serialized).not.toContain('router.example');
    expect(serialized).not.toContain('sk-secretvalue12345678');
    expect(serialized).toContain('redacted');
  });

  it('does not classify cancellation as a provider wire error', async () => {
    const records: WireRecord[] = [];
    const cancelled = Object.assign(new Error('cancelled'), { name: 'Canceled' });
    const model = {
      id: 'publisher.cancelled',
      name: 'Cancelled',
      vendor: 'test',
      family: 'scripted',
      version: '1',
      sendRequest: vi.fn().mockRejectedValue(cancelled),
    };
    const result = await new VscodeModelPort(model as never, {
      requestId: 'request-cancelled',
      wireLog: (record) => records.push(record),
    }).generateToolTurn({
      messages: [new HumanMessage('trace orders')],
      tools: [],
      phase: 'discover',
    });

    expect(result.status).toBe('cancelled');
    expect(records.map((record) => record.type)).toEqual(['wire-request']);
  });
});

// `safeTraceStringify` serializes every record the writer emits and every unknown result part, so a
// defect here silently corrupts the diagnostic surface itself rather than failing loudly.
describe('safeTraceStringify', () => {
  it('keeps the real content of a shared reference that is not a cycle', () => {
    // Two siblings pointing at one object — common in LangChain message and tool-schema graphs — is
    // sharing, not recursion. A "seen everything" set reports the second one as `[Circular]` and
    // destroys real trace content.
    const shared = { table: 'dbo.Orders', columns: ['id', 'total'] };

    const parsed = JSON.parse(safeTraceStringify({ first: shared, second: shared, all: [shared] }));

    expect(parsed).toEqual({ first: shared, second: shared, all: [shared] });
  });

  it('marks a true cycle and still records the content around it', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    node.children = [{ name: 'child', parent: node }];

    const parsed = JSON.parse(safeTraceStringify(node));

    expect(parsed).toEqual({
      name: 'root',
      self: '[Circular]',
      children: [{ name: 'child', parent: '[Circular]' }],
    });
  });

  it('represents functions and symbols instead of dropping them', () => {
    // `JSON.stringify` omits both without a trace; the reader would see a payload that never existed.
    const parsed = JSON.parse(safeTraceStringify({
      handler: function namedHandler() { return 1; },
      arrow: () => 1,
      marker: Symbol('trace-marker'),
      ok: 1,
    })) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual(['handler', 'arrow', 'marker', 'ok']);
    expect(parsed.handler).toContain('namedHandler');
    expect(parsed.arrow).toContain('=>');
    expect(parsed.marker).toBe('Symbol(trace-marker)');
    expect(parsed.ok).toBe(1);
  });

  it('degrades only the property whose getter throws', () => {
    const record = {
      before: 'kept',
      get boom(): string { throw new TypeError('unreadable'); },
      after: 'kept too',
      nested: {
        get alsoBoom(): number { throw new RangeError('unreadable'); },
        sibling: 7,
      },
    };

    const parsed = JSON.parse(safeTraceStringify(record));

    expect(parsed).toEqual({
      before: 'kept',
      boom: '[Unserializable:TypeError]',
      after: 'kept too',
      nested: { alsoBoom: '[Unserializable:RangeError]', sibling: 7 },
    });
  });

  it('renders bigint values with an explicit marker', () => {
    expect(JSON.parse(safeTraceStringify({ rows: 9007199254740993n }))).toEqual({
      rows: '[BigInt:9007199254740993]',
    });
    expect(safeTraceStringify(1n)).toBe('"[BigInt:1]"');
  });

  it('returns valid JSON for hostile objects instead of throwing', () => {
    const throwingKeys = new Proxy({}, {
      ownKeys() { throw new Error('ownKeys refused'); },
      getOwnPropertyDescriptor() { throw new Error('descriptor refused'); },
      get() { throw new Error('get refused'); },
    });
    const throwingReads = new Proxy({ a: 1, b: 2 }, {
      get() { throw new EvalError('get refused'); },
    });
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.schema = 'dbo';
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 2_000; depth += 1) nested = { child: nested };

    const parsed = JSON.parse(safeTraceStringify({
      throwingKeys,
      throwingReads,
      nullPrototype,
      nested,
      plain: 'kept',
    })) as Record<string, unknown>;

    expect(parsed.throwingKeys).toBe('[Unserializable:Error]');
    expect(parsed.throwingReads).toEqual({
      a: '[Unserializable:EvalError]',
      b: '[Unserializable:EvalError]',
    });
    expect(parsed.nullPrototype).toEqual({ schema: 'dbo' });
    expect(parsed.plain).toBe('kept');
  });

  it('stays total for pathological nesting and for values JSON has no shape for', () => {
    // Either the walker or `JSON.stringify` may run out of stack here; both paths are contained, so
    // the caller still receives parseable JSON.
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 50_000; depth += 1) nested = { child: nested };

    let output = '';
    expect(() => { output = safeTraceStringify(nested); }).not.toThrow();
    expect(() => JSON.parse(output)).not.toThrow();
    expect(safeTraceStringify(undefined)).toBe('null');
    expect(safeTraceStringify(() => 1)).toContain('=>');
  });
});

function runTurn(
  wireLog: ((record: WireRecord) => void) | undefined,
  options: { readonly traceVerbose?: boolean } = {},
) {
  const model = {
    id: 'publisher.exact',
    name: 'Exact',
    vendor: 'test',
    family: 'scripted',
    version: '1',
    sendRequest: vi.fn().mockResolvedValue({
      stream: asyncIterable([
        new vscode.LanguageModelTextPart('thinking '),
        new vscode.LanguageModelTextPart('about it'),
        new vscode.LanguageModelToolCallPart('call-2', 'lineage_present_result', { id: 'orders' }),
      ]),
    }),
  };
  return new VscodeModelPort(model as never, {
    requestId: 'request-1',
    wireLog,
    ...options,
  }).generateToolTurn({
    system: 'stable prefix',
    messages: [
      new HumanMessage('trace dbo.Orders'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-1', name: 'lineage_present_result', args: { id: 'prior' } }],
      }),
      new ToolMessage({ tool_call_id: 'call-1', content: '{"results":[]}' }),
    ],
    tools: [{
      name: 'lineage_present_result',
      description: 'present',
      inputSchema: z.object({ id: z.string() }).strict(),
    }],
    phase: 'synthesis',
  });
}

function asyncIterable<T>(values: readonly T[]): AsyncIterable<T> {
  return { async *[Symbol.asyncIterator]() { yield* values; } };
}
