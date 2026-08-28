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
import { ModelPortError } from '../../../src/ai/model/modelPort';

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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fails closed before graph or transport when ambient tracing is enabled', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('unexpected fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const httpSpy = vi.spyOn(http, 'request').mockImplementation((() => {
      throw new Error('unexpected HTTP request');
    }));
    const httpsSpy = vi.spyOn(https, 'request').mockImplementation((() => {
      throw new Error('unexpected HTTPS request');
    }));

    const session = {
      currentRoundId: 0,
      phase: { kind: 'idle' },
    };
    const sink = new TurnEventSink(() => undefined);
    const runtime = new AgentRuntime({
      threadId: 'thread-no-egress',
      getSession: () => session as never,
      model: {} as never,
      registry: {} as never,
      sink,
      turnEpoch: 1,
    });

    await expect(runtime.run('SECRET-PROMPT-MUST-STAY-LOCAL')).resolves.toBe('error');
    expect(runtime.lastFailureDetail?.message).toContain(
      'External LangChain tracing is not supported by @lineage',
    );
    // Give any accidentally queued transport enough time to attempt egress.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(graph.invoke).not.toHaveBeenCalled();
    expect(fetchSpy, 'LangSmith fetch must stay disabled').not.toHaveBeenCalled();
    expect(httpSpy, 'LangSmith HTTP transport must stay disabled').not.toHaveBeenCalled();
    expect(httpsSpy, 'LangSmith HTTPS transport must stay disabled').not.toHaveBeenCalled();
  });
});

describe('AgentRuntime cancellation truth', () => {
  beforeEach(() => {
    graph.invoke.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makeRuntime(signal: AbortSignal) {
    const session = { currentRoundId: 0, phase: { kind: 'idle' } };
    return new AgentRuntime({
      threadId: 'thread-cancel',
      getSession: () => session as never,
      model: {} as never,
      registry: {} as never,
      sink: new TurnEventSink(() => undefined),
      turnEpoch: 1,
      signal,
    });
  }

  it('closes as cancelled when the abort fired mid-invoke, even if the graph returned ok', async () => {
    const controller = new AbortController();
    graph.invoke.mockImplementation(async () => {
      // The user presses Stop while a node is executing; the graph still completes its state.
      controller.abort();
      return { outcome: 'ok' };
    });
    await expect(makeRuntime(controller.signal).run('q'), "Stop wins over the graph's carried outcome").resolves.toBe('cancelled');
  });

  it('classifies a thrown cancellation as cancelled, never as a turn error', async () => {
    const controller = new AbortController();
    graph.invoke.mockImplementation(async () => {
      controller.abort();
      throw new Error('Aborted mid-flight');
    });
    const runtime = makeRuntime(controller.signal);
    await expect(runtime.run('q')).resolves.toBe('cancelled');
    expect(runtime.lastFailureDetail, 'a clean cancel records no failure detail').toBeUndefined();
  });

  it('classifies a port cancellation as cancelled even when the runtime signal never fired', async () => {
    graph.invoke.mockImplementation(async () => {
      throw new ModelPortError('cancelled', 'Language model request was cancelled.');
    });
    const runtime = makeRuntime(new AbortController().signal);
    await expect(runtime.run('q')).resolves.toBe('cancelled');
    expect(runtime.lastFailureDetail, 'a clean cancel records no failure detail').toBeUndefined();
  });

  it('classifies an AbortError-named throw as cancelled even when the runtime signal never fired', async () => {
    graph.invoke.mockImplementation(async () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const runtime = makeRuntime(new AbortController().signal);
    await expect(runtime.run('q')).resolves.toBe('cancelled');
    expect(runtime.lastFailureDetail, 'a clean cancel records no failure detail').toBeUndefined();
  });
});
