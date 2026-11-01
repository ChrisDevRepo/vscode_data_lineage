import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';

const graph = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('../../../src/ai/agent/graph', () => ({
  buildAgentGraph: () => ({ invoke: graph.invoke }),
  turnRecursionLimit: () => 50,
}));

import { AgentRuntime } from '../../../src/ai/host/agentRuntime';

describe('AgentRuntime LangSmith egress boundary', () => {
  beforeEach(() => {
    graph.invoke.mockReset();
    vi.stubEnv('LANGSMITH_TRACING', 'true');
    vi.stubEnv('LANGSMITH_TRACING_V2', 'true');
    vi.stubEnv('LANGCHAIN_TRACING', 'true');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'true');
    vi.stubEnv('LANGSMITH_API_KEY', 'must-not-be-used');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fails closed before graph or transport when ambient tracing is enabled', async () => {
    // Every timer the run schedules is flushed below, so delayed (batched) egress is observed
    // without a sleep.
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => {
      throw new Error('unexpected fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const httpSpy = vi.spyOn(http, 'request').mockImplementation(() => {
      throw new Error('unexpected HTTP request');
    });
    const httpsSpy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('unexpected HTTPS request');
    });

    const session = {
      currentRoundId: 0,
      phase: { kind: 'idle' },
    };
    const sink = new TurnEventSink(() => undefined);
    const runtime = new AgentRuntime({
      threadId: 'thread-no-egress',
      getSession: () => session as never,
      model: {} as never,
      maxRounds: 10,
      registry: {} as never,
      sink,
      turnEpoch: 1,
    });

    await expect(runtime.run('SECRET-PROMPT-MUST-STAY-LOCAL')).resolves.toBe(
      'error',
    );
    expect(runtime.lastFailureDetail?.message).toContain(
      'External LangChain tracing is not supported by @lineage',
    );
    await vi.runAllTimersAsync();

    expect(graph.invoke).not.toHaveBeenCalled();
    expect(
      fetchSpy,
      'LangSmith fetch must stay disabled',
    ).not.toHaveBeenCalled();
    expect(
      httpSpy,
      'LangSmith HTTP transport must stay disabled',
    ).not.toHaveBeenCalled();
    expect(
      httpsSpy,
      'LangSmith HTTPS transport must stay disabled',
    ).not.toHaveBeenCalled();
  });
});
