import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  executeCommand: vi.fn(),
  showInformationMessage: vi.fn(),
  showInputBox: vi.fn(),
  showWarningMessage: vi.fn(),
  participant: {
    onDidReceiveFeedback: vi.fn(),
    followupProvider: undefined,
    dispose: vi.fn(),
  },
}));

vi.mock('vscode', () => ({
  ChatResultFeedbackKind: { Helpful: 1, Unhelpful: 2 },
  StatusBarAlignment: { Left: 1 },
  chat: {
    createChatParticipant: vi.fn(() => vscodeMocks.participant),
  },
  commands: {
    registerCommand: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      vscodeMocks.handlers.set(name, handler);
      return { dispose: vi.fn() };
    }),
    executeCommand: vscodeMocks.executeCommand,
  },
  l10n: { t: (value: string) => value },
  window: {
    showInformationMessage: vscodeMocks.showInformationMessage,
    showInputBox: vscodeMocks.showInputBox,
    showWarningMessage: vscodeMocks.showWarningMessage,
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
  },
}));

function makeOutputChannel() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeGateStream() {
  return {
    markdown: vi.fn(),
    button: vi.fn(),
  };
}

async function registeredParticipant() {
  const { LineageParticipant } = await import('../../../src/ai/participant/lineageParticipant');
  const runtime = { resumeGate: vi.fn().mockResolvedValue(true) };
  const outputChannel = makeOutputChannel();
  const context = { subscriptions: [] as unknown[] };
  const traced: unknown[] = [];
  const traceWriter = {
    isEnabled: () => true,
    isVerbose: () => false,
    write: vi.fn((record: unknown) => { traced.push(record); return Promise.resolve(); }),
  };
  const participant = new LineageParticipant(
    context as never,
    vi.fn(() => ({ id: 'session-1', model: {}, phase: { kind: 'awaiting_gate' } })) as never,
    outputChannel as never,
    runtime as never,
    traceWriter as never,
  );
  participant.register();

  const emitGate = (
    gateId: string,
    gate = 'confirm_sm_start',
    summary = 'Review this scope.',
    originalPrompt = 'trace Sales',
  ) => {
    const stream = makeGateStream();
    const writeEvent = participant as unknown as {
      writeEvent(
        event: {
          type: 'gate';
          gateId: string;
          gate: string;
          summary: string;
          classes: string[];
        },
        stream: unknown,
        originalPrompt: string,
        requestId: string,
      ): void;
    };
    writeEvent.writeEvent({
      type: 'gate',
      gateId,
      gate,
      summary,
      classes: [],
    }, stream, originalPrompt, `req-${gateId}`);
    return stream;
  };

  const resume = (gateId: string, action: string, classes: string[] = []) =>
    vscodeMocks.handlers.get('dataLineageViz.aiResumeNativeGate')?.(gateId, action, classes);

  /** Drives one native turn far enough to observe the live-card wait message. */
  const chatTurn = async () => {
    const stream = { markdown: vi.fn(), progress: vi.fn(), button: vi.fn() };
    await participant.handleChatRequest(
      { prompt: 'change it', model: { id: 'test', maxInputTokens: 1000 } } as never,
      { history: [{ prompt: 'trace Sales' }] } as never,
      stream as never,
      { isCancellationRequested: false } as never,
    );
    return stream;
  };

  return { runtime, outputChannel, emitGate, resume, chatTurn, traced };
}

describe('native gate commands', () => {
  beforeEach(() => {
    vscodeMocks.handlers.clear();
    vscodeMocks.executeCommand.mockReset();
    vscodeMocks.showInformationMessage.mockReset();
    vscodeMocks.showInputBox.mockReset();
    vscodeMocks.showWarningMessage.mockReset();
    vscodeMocks.participant.onDidReceiveFeedback.mockReset();
    vscodeMocks.participant.dispose.mockReset();
    vscodeMocks.participant.followupProvider = undefined;
  });

  it('projects an exploration proposal through three native participant buttons', async () => {
    const { emitGate } = await registeredParticipant();
    const summary = [
      '### Exploration plan (proposed)',
      '',
      '- **2 hops** · **3 nodes in scope** · depth 2, downstream',
      '- **Tracing:** Blackboard',
      '',
      '- **dbo** — 3 nodes',
      '  - Procedures (1 node): LoadSales',
      '  - Tables (2 nodes): Sales, SalesStage',
      '',
      '_Analysis: Business_',
    ].join('\n');

    const stream = emitGate('gate-1', 'confirm_sm_start', summary);

    expect(stream.markdown).toHaveBeenCalledWith(
      `\n\n---\n**Confirm exploration**\n\n${summary}\n\n`,
    );
    expect(stream.button.mock.calls.map(([button]) => button)).toEqual([
      {
        command: 'dataLineageViz.aiResumeNativeGate',
        title: '$(check) Approve & Proceed',
        arguments: ['gate-1', 'approve', []],
      },
      {
        command: 'dataLineageViz.aiResumeNativeGate',
        title: '$(edit) Change scope',
        arguments: ['gate-1', 'change', []],
      },
      {
        command: 'dataLineageViz.aiResumeNativeGate',
        title: '$(close) Cancel',
        arguments: ['gate-1', 'cancel', []],
      },
    ]);
    expect(vscodeMocks.handlers.has('dataLineageViz.aiChangeOrCancelNativeGate')).toBe(false);
  }, 20_000);

  it('offers no scope change on an expansion gate', async () => {
    const { emitGate } = await registeredParticipant();

    const stream = emitGate('gate-1', 'schema_out_of_filter', 'Expand to [ext]?');

    expect(stream.button.mock.calls.map(([button]) => button.title)).toEqual([
      '$(check) Approve & Proceed',
      '$(close) Cancel',
    ]);
  }, 20_000);

  it('cancels in one click without any popup', async () => {
    const { runtime, emitGate, resume } = await registeredParticipant();
    emitGate('gate-1');

    await resume('gate-1', 'cancel');

    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-1', { kind: 'cancel' });
    expect(vscodeMocks.showInformationMessage).not.toHaveBeenCalled();
    expect(vscodeMocks.showInputBox).not.toHaveBeenCalled();
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  }, 20_000);

  it('cancels the replacement gate produced by a refine round', async () => {
    const { runtime, emitGate, resume } = await registeredParticipant();
    emitGate('gate-1');
    emitGate('gate-2');

    await resume('gate-2', 'cancel');

    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-2', { kind: 'cancel' });
  }, 20_000);

  it('approves with the proposed classes', async () => {
    const { runtime, emitGate, resume } = await registeredParticipant();
    emitGate('gate-1');

    await resume('gate-1', 'approve', ['fact']);

    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-1', { kind: 'approve', classes: ['fact'] });
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  }, 20_000);

  it('holds the proposal and prefills the chat input on a scope change', async () => {
    const { runtime, emitGate, resume } = await registeredParticipant();
    emitGate('gate-1');

    await resume('gate-1', 'change');

    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-1', { kind: 'hold' });
    expect(vscodeMocks.executeCommand).toHaveBeenCalledWith('workbench.action.chat.open', {
      query: '@lineage ',
      isPartialQuery: true,
    });
    expect(vscodeMocks.showInformationMessage).not.toHaveBeenCalled();
    expect(vscodeMocks.showInputBox).not.toHaveBeenCalled();
  }, 20_000);

  it('prefills only after the held turn reaches terminal state', async () => {
    const { runtime, emitGate, resume } = await registeredParticipant();
    emitGate('gate-1');
    let finishTurn!: (resolved: boolean) => void;
    runtime.resumeGate.mockReturnValueOnce(new Promise((res) => { finishTurn = res; }));

    const pending = resume('gate-1', 'change');
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();

    finishTurn(true);
    await pending;
    expect(vscodeMocks.executeCommand).toHaveBeenCalledWith('workbench.action.chat.open', {
      query: '@lineage ',
      isPartialQuery: true,
    });
  }, 20_000);

  it('does not prefill when the held turn no longer has an owning runtime', async () => {
    const { runtime, emitGate, resume } = await registeredParticipant();
    emitGate('gate-1');
    runtime.resumeGate.mockResolvedValueOnce(false);

    await resume('gate-1', 'change');

    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
    // The card's state is restored so its buttons keep working.
    await resume('gate-1', 'approve', []);
    expect(runtime.resumeGate).toHaveBeenLastCalledWith('gate-1', { kind: 'approve', classes: [] });
  }, 20_000);

  it('ignores a superseded button silently and preserves the replacement gate', async () => {
    const { runtime, outputChannel, emitGate, resume } = await registeredParticipant();
    emitGate('gate-old');
    emitGate('gate-new');

    await resume('gate-old', 'approve', []);

    expect(runtime.resumeGate).not.toHaveBeenCalled();
    expect(vscodeMocks.showWarningMessage).not.toHaveBeenCalled();
    expect(outputChannel.debug).toHaveBeenCalledWith(expect.stringContaining('requestedGateId=gate-old'));
    expect(outputChannel.debug).toHaveBeenCalledWith(expect.stringContaining('pendingGateId=gate-new'));

    await resume('gate-new', 'approve', ['fact']);
    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-new', {
      kind: 'approve',
      classes: ['fact'],
    });
  }, 20_000);

  it('rejects a scope change on an expansion gate', async () => {
    const { runtime, emitGate, resume } = await registeredParticipant();
    emitGate('gate-1', 'schema_out_of_filter');

    await resume('gate-1', 'change');

    expect(runtime.resumeGate).not.toHaveBeenCalled();
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  }, 20_000);

  it('traces an accepted gate action against the turn that raised it', async () => {
    const { emitGate, resume, traced } = await registeredParticipant();
    emitGate('gate-1');

    await resume('gate-1', 'approve', ['fact']);

    expect(traced).toContainEqual({
      type: 'gate-resolution',
      requestId: 'req-gate-1',
      gateId: 'gate-1',
      gate: 'confirm_sm_start',
      action: 'approve',
      outcome: 'accepted',
    });
  }, 20_000);

  it('traces a refused gate action with the deciding condition', async () => {
    const { emitGate, resume, traced } = await registeredParticipant();
    emitGate('gate-old');
    emitGate('gate-new');

    await resume('gate-old', 'approve', []);

    // The refusal must name WHY it refused: a record carrying only the ids leaves a dead approval
    // card indistinguishable from a user who never clicked.
    expect(traced).toContainEqual({
      type: 'gate-resolution',
      requestId: 'req-gate-new',
      gateId: 'gate-old',
      gate: 'confirm_sm_start',
      action: 'approve',
      outcome: 'refused',
      refusedBy: 'gate_id_mismatch',
    });
  }, 20_000);

  it('traces a scope change refused on an expansion gate as a kind mismatch', async () => {
    const { emitGate, resume, traced } = await registeredParticipant();
    emitGate('gate-1', 'schema_out_of_filter');

    await resume('gate-1', 'change');

    expect(traced).toContainEqual(expect.objectContaining({
      type: 'gate-resolution',
      outcome: 'refused',
      refusedBy: 'gate_kind_mismatch',
    }));
  }, 20_000);

  it('pairs the raised gate with its resolution through gateId', async () => {
    const { emitGate, resume, traced } = await registeredParticipant();
    emitGate('gate-1');
    await resume('gate-1', 'cancel');

    const resolution = traced.find(
      (r): r is { gateId: string } =>
        typeof r === 'object' && r !== null && (r as { type?: string }).type === 'gate-resolution',
    );
    expect(resolution?.gateId).toBe('gate-1');
  }, 20_000);

  it('points a typed prompt back at the buttons while the card is live', async () => {
    const { runtime, emitGate, chatTurn } = await registeredParticipant();
    emitGate('gate-1');

    const stream = await chatTurn();

    expect(stream.markdown).toHaveBeenCalledWith(
      '_Use **Approve & Proceed**, **Change scope**, or **Cancel** on the proposal above._',
    );
    expect(runtime.resumeGate).not.toHaveBeenCalled();
  }, 20_000);
});
