import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  statusBar: {
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    text: '',
    name: '',
    tooltip: '',
  },
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  l10n: { t: (value: string) => value },
  window: {
    createStatusBarItem: vi.fn(() => vscodeMocks.statusBar),
    showWarningMessage: vscodeMocks.showWarningMessage,
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, fallback: unknown) => fallback),
    })),
  },
}));

import { LineageParticipant } from '../../../src/ai/participant/lineageParticipant';

function makeOutputChannel() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function makeStream() {
  return {
    markdown: vi.fn(),
    progress: vi.fn(),
    button: vi.fn(),
  };
}

function makeParticipant(run: (...args: never[]) => unknown, sessionState: Record<string, unknown> = {}) {
  const context = { subscriptions: [] as unknown[] };
  const session = {
    id: 'session-network',
    model: {},
    phase: { kind: 'idle' },
    ...sessionState,
  };
  return new LineageParticipant(
    context as never,
    () => session as never,
    makeOutputChannel() as never,
    { run, resumeGate: vi.fn() } as never,
  );
}

const request = {
  prompt: 'inspect the loaded lineage',
  model: {
    id: 'selected-model',
    name: 'Selected Model',
    vendor: 'test',
    family: 'test',
    version: '1',
    maxInputTokens: 16_000,
  },
};

describe('participant provider/network settlement', () => {
  beforeEach(() => {
    vscodeMocks.statusBar.show.mockReset();
    vscodeMocks.statusBar.hide.mockReset();
    vscodeMocks.showWarningMessage.mockReset();
  });

  it('returns one sanitized native error without duplicating terminal markdown', async () => {
    const failure = 'endpoint=https://private.example Bearer secret-token';
    const run = vi.fn(async (input: { sink: { fail(message: string): boolean } }) => {
      input.sink.fail(failure);
      return {
        outcome: 'error' as const,
        modelCalls: 1,
        failure: { message: failure },
      };
    });
    const participant = makeParticipant(run);
    const stream = makeStream();

    const result = await participant.handleChatRequest(
      request as never,
      { history: [{ prompt: 'prior request' }] } as never,
      stream as never,
      makeToken(),
    );

    expect(result).toMatchObject({
      metadata: {
        requestId: expect.any(String),
        status: 'error',
        modelCalls: 1,
      },
      errorDetails: {
        message: 'endpoint=‹redacted› Bearer ‹redacted›',
      },
    });
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it('settles cancellation without native error details', async () => {
    const run = vi.fn(async (input: { sink: { result(status: 'cancelled'): boolean } }) => {
      input.sink.result('cancelled');
      return { outcome: 'cancelled' as const, modelCalls: 1 };
    });
    const participant = makeParticipant(run);

    const result = await participant.handleChatRequest(
      request as never,
      { history: [{ prompt: 'prior request' }] } as never,
      makeStream() as never,
      makeToken(),
    );

    expect(result.metadata).toMatchObject({ status: 'cancelled', modelCalls: 1 });
    expect(result.errorDetails).toBeUndefined();
  });

  it('does not offer Show in Graph after successful auto-render', async () => {
    const run = vi.fn(async (input: { sink: { result(status: 'ok'): boolean } }) => {
      input.sink.result('ok');
      return { outcome: 'ok' as const, modelCalls: 1 };
    });
    const stream = makeStream();
    const participant = makeParticipant(run, {
      presentResultCalledThisTurn: true,
      presentResultAutoDispatched: true,
      resultGraph: { nodeIds: ['[dbo].[Orders]'] },
    });

    await participant.handleChatRequest(
      request as never,
      { history: [{ prompt: 'prior request' }] } as never,
      stream as never,
      makeToken(),
    );

    expect(stream.button).not.toHaveBeenCalledWith(expect.objectContaining({
      command: 'dataLineageViz.aiCreateView',
    }));
  });
});
