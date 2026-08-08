/**
 * Regression tests for `src/ai/observability/aiTraceWriter.ts`.
 *
 * Pins the resilience contract: one failed append rejects only that caller's promise and must
 * never poison the serialized write chain, because the trace file is the opt-in diagnostic
 * channel users enable precisely when something is already going wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({
  open: openMock,
  mkdir: vi.fn(async () => undefined),
}));

import { AiTraceWriter } from '../../../src/ai/observability/aiTraceWriter';

function fakeHandle(
  appendFile = vi.fn(async () => undefined),
  sync = vi.fn(async () => undefined),
) {
  return {
    appendFile,
    sync,
    chmod: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

const record = {
  type: 'phase',
  requestId: 'request-1',
  runFingerprint: 'r1',
  seq: 1,
  phase: 'thinking',
  elapsedMs: 5,
} as const;

describe('AiTraceWriter resilience', () => {
  beforeEach(() => {
    openMock.mockReset();
  });

  it('keeps writing after one failed append', async () => {
    const appendFile = vi.fn()
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
      .mockResolvedValue(undefined);
    openMock.mockResolvedValue(fakeHandle(appendFile));

    const writer = new AiTraceWriter();
    await writer.enable('/ws');
    await expect(writer.write(record), 'the failing append rejects its own caller').rejects.toThrow('ENOSPC');
    await expect(writer.write(record), 'the next append succeeds — chain not poisoned').resolves.toBeUndefined();
    expect(appendFile).toHaveBeenCalledTimes(2);
  });

  it('flushes each appended record before the write is reported complete', async () => {
    const operations: string[] = [];
    const appendFile = vi.fn(async () => {
      operations.push('append');
      return undefined;
    });
    const sync = vi.fn(async () => {
      operations.push('sync');
      return undefined;
    });
    openMock.mockResolvedValue(fakeHandle(appendFile, sync));
    const writer = new AiTraceWriter();
    await writer.enable('/ws');

    await writer.write(record);

    expect(operations).toEqual(['append', 'sync']);
    await writer.close();
  });

  it('fails enablement until the trace file is proven writable, then retries cleanly', async () => {
    openMock
      .mockRejectedValueOnce(new Error('EACCES: permission denied'))
      .mockResolvedValue(fakeHandle());
    const writer = new AiTraceWriter();

    await expect(writer.enable('/ws')).rejects.toThrow('EACCES');
    await expect(writer.enable('/ws')).resolves.toContain('lm-trace');
    expect(openMock).toHaveBeenCalledTimes(2);
    await writer.close();
  });

  it('shares one eager open across concurrent enable commands', async () => {
    openMock.mockResolvedValue(fakeHandle());
    const writer = new AiTraceWriter();

    const [first, second] = await Promise.all([writer.enable('/ws'), writer.enable('/ws')]);
    expect(second).toBe(first);
    expect(openMock).toHaveBeenCalledTimes(1);
    await writer.close();
  });

  it('serializes cyclic and bigint wire payloads without throwing', async () => {
    let written = '';
    const appendFile = vi.fn(async (data?: unknown) => {
      written = String(data);
      return undefined;
    });
    openMock.mockResolvedValue(fakeHandle(appendFile));
    const writer = new AiTraceWriter();
    await writer.enable('/ws');
    const schema: Record<string, unknown> = { count: 7n };
    schema.self = schema;

    await expect(writer.write({
      type: 'wire-request',
      requestId: 'request-1',
      generation: 1,
      messages: [],
      tools: [{ name: 'lineage_test', inputSchema: schema }],
    })).resolves.toBeUndefined();

    expect(() => JSON.parse(written)).not.toThrow();
    expect(written).toContain('[Circular]');
    expect(written).toContain('[BigInt:7]');
    await writer.close();
  });

  it('stays non-verbose unless the caller asks, and never reports verbose while disabled', async () => {
    openMock.mockResolvedValue(fakeHandle());

    const quiet = new AiTraceWriter();
    expect(quiet.isVerbose(), 'a writer that was never enabled captures nothing').toBe(false);
    await quiet.enable('/ws');
    expect(quiet.isVerbose(), 'verbose is opt-in — the default trace records hashes only').toBe(false);
    await quiet.close();
    const verbose = new AiTraceWriter();
    await verbose.enable('/ws', { verbose: true });
    expect(verbose.isVerbose()).toBe(true);
    // A closed writer discards records, so emitters must stop building verbose payloads for it.
    await verbose.close();
    expect(verbose.isVerbose()).toBe(false);
  });

  it('accepts the generation and provider-raw records without a second record union', async () => {
    const lines: string[] = [];
    const appendFile = vi.fn(async (data?: unknown) => {
      lines.push(String(data));
      return undefined;
    });
    openMock.mockResolvedValue(fakeHandle(appendFile));
    const writer = new AiTraceWriter();
    await writer.enable('/ws', { verbose: true });

    await writer.write({
      type: 'generation',
      requestId: 'request-1',
      generation: 2,
      phase: 'hop',
      modelId: 'deepseek/deepseek-chat',
      finishReason: 'tool_calls',
      latencyMs: 1234,
      usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020 },
    });
    await writer.write({
      type: 'provider-raw',
      requestId: 'request-1',
      generation: 2,
      direction: 'response',
      url: 'https://provider.example/v1/chat/completions',
      method: 'POST',
      status: 200,
      body: { choices: [{ finish_reason: 'tool_calls' }] },
    });

    const [generation, raw] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(generation).toMatchObject({ type: 'generation', modelId: 'deepseek/deepseek-chat', latencyMs: 1234 });
    expect(raw).toMatchObject({ type: 'provider-raw', direction: 'response', status: 200 });
    await writer.close();
  });

  it('marks only the first post-enable append failure for warning severity', async () => {
    const appendFile = vi.fn().mockRejectedValue(new Error('ENOSPC'));
    const failures: boolean[] = [];
    openMock.mockResolvedValue(fakeHandle(appendFile));
    const writer = new AiTraceWriter((_error, firstFailure) => failures.push(firstFailure));
    await writer.enable('/ws');

    await writer.write(record).catch(() => {});
    await writer.write(record).catch(() => {});

    expect(failures).toEqual([true, false]);
    await writer.close();
  });
});
