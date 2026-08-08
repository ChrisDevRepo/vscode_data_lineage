import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  executeCommand: vi.fn(),
  showInformationMessage: vi.fn(),
  showInputBox: vi.fn(),
  showWarningMessage: vi.fn(),
  participant: {
    onDidReceiveFeedback: vi.fn(),
    followupProvider: undefined as unknown,
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
  const participant = new LineageParticipant(
    context as never,
    vi.fn(() => ({ id: 'session-1', model: {}, phase: { kind: 'awaiting_gate' } })) as never,
    outputChannel as never,
    runtime as never,
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
      ): void;
    };
    writeEvent.writeEvent({
      type: 'gate',
      gateId,
      gate,
      summary,
      classes: [],
    }, stream, originalPrompt);
    return stream;
  };

  /** Drives one native turn far enough to observe the pending-gate wait message. */
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

  return { runtime, outputChannel, emitGate, chatTurn };
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

  it('projects approval through exactly two native participant buttons', async () => {
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
        command: 'dataLineageViz.aiChangeOrCancelNativeGate',
        title: '$(edit) Change scope / Cancel',
        arguments: ['gate-1'],
      },
    ]);
    expect(vscodeMocks.handlers.has('dataLineageViz.aiRefineNativeGate')).toBe(false);
  }, 20_000);

  it('keeps the pending gate unchanged when the native choice is dismissed', async () => {
    const { runtime, emitGate } = await registeredParticipant();
    emitGate('gate-1', 'confirm_sm_start', 'Review this scope.');
    const change = vscodeMocks.handlers.get('dataLineageViz.aiChangeOrCancelNativeGate');
    vscodeMocks.showInformationMessage.mockResolvedValueOnce(undefined);

    await change?.('gate-1');

    expect(vscodeMocks.showInformationMessage).toHaveBeenCalledWith(
      'Data Lineage: Change the pending scope or cancel the exploration?',
      'Change scope',
      'Cancel',
    );
    expect(vscodeMocks.showInputBox).not.toHaveBeenCalled();
    expect(runtime.resumeGate).not.toHaveBeenCalled();

    await vscodeMocks.handlers.get('dataLineageViz.aiResumeNativeGate')?.('gate-1', 'approve', []);
    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-1', { kind: 'approve', classes: [] });
  }, 20_000);

  it('cancels the pending gate without opening a new trace or starting analysis', async () => {
    const { runtime, emitGate } = await registeredParticipant();
    emitGate('gate-1');
    vscodeMocks.showInformationMessage.mockResolvedValueOnce('Cancel');

    await vscodeMocks.handlers.get('dataLineageViz.aiChangeOrCancelNativeGate')?.('gate-1');

    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-1', { kind: 'cancel' });
    expect(vscodeMocks.showInputBox).not.toHaveBeenCalled();
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  }, 20_000);

  it.each([undefined, '   '])(
    'keeps the proposal unchanged when the refinement input is %s',
    async (input) => {
      const { runtime, emitGate } = await registeredParticipant();
      emitGate('gate-1');
      vscodeMocks.showInformationMessage.mockResolvedValueOnce('Change scope');
      vscodeMocks.showInputBox.mockResolvedValueOnce(input);

      await vscodeMocks.handlers.get('dataLineageViz.aiChangeOrCancelNativeGate')?.('gate-1');

      expect(runtime.resumeGate).not.toHaveBeenCalled();
      await vscodeMocks.handlers.get('dataLineageViz.aiResumeNativeGate')?.('gate-1', 'approve', []);
      expect(runtime.resumeGate).toHaveBeenCalledWith('gate-1', { kind: 'approve', classes: [] });
    },
    20_000,
  );

  it('submits a nonblank change as a refinement of the same gate', async () => {
    const { runtime, emitGate } = await registeredParticipant();
    emitGate('gate-1');
    vscodeMocks.showInformationMessage.mockResolvedValueOnce('Change scope');
    vscodeMocks.showInputBox.mockResolvedValueOnce('  remove DimCalendar  ');

    await vscodeMocks.handlers.get('dataLineageViz.aiChangeOrCancelNativeGate')?.('gate-1');

    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-1', {
      kind: 'refine',
      refine: { instruction: 'remove DimCalendar' },
    });
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  }, 20_000);

  it('restores the card when a raced gate decision no longer has an owning runtime', async () => {
    const { runtime, emitGate } = await registeredParticipant();
    emitGate('gate-1');
    runtime.resumeGate.mockResolvedValueOnce(false);
    vscodeMocks.showInformationMessage.mockResolvedValueOnce('Change scope');
    vscodeMocks.showInputBox.mockResolvedValueOnce('remove DimCalendar');

    await vscodeMocks.handlers.get('dataLineageViz.aiChangeOrCancelNativeGate')?.('gate-1');
    await vi.waitFor(() => expect(vscodeMocks.showWarningMessage).toHaveBeenCalledWith(
      'Data Lineage: This scope approval action is no longer active. Use the latest approval card.',
    ));

    await vscodeMocks.handlers.get('dataLineageViz.aiResumeNativeGate')?.('gate-1', 'approve', []);
    expect(runtime.resumeGate).toHaveBeenLastCalledWith('gate-1', { kind: 'approve', classes: [] });
  }, 20_000);

  it('rejects a double click while the first native choice is open', async () => {
    const { runtime, emitGate } = await registeredParticipant();
    emitGate('gate-1');
    let finishChoice!: (choice: string | undefined) => void;
    vscodeMocks.showInformationMessage.mockReturnValueOnce(new Promise((resolve) => {
      finishChoice = resolve;
    }));

    const change = vscodeMocks.handlers.get('dataLineageViz.aiChangeOrCancelNativeGate');
    const first = change?.('gate-1');
    await change?.('gate-1');

    expect(vscodeMocks.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.showWarningMessage).toHaveBeenCalledWith(
      'Data Lineage: This scope approval action is no longer active. Use the latest approval card.',
    );
    expect(runtime.resumeGate).not.toHaveBeenCalled();

    finishChoice(undefined);
    await first;
  }, 20_000);

  it('reports a stale replaced button and preserves the replacement gate', async () => {
    const { runtime, outputChannel, emitGate } = await registeredParticipant();
    emitGate('gate-old');
    emitGate('gate-new');
    const resume = vscodeMocks.handlers.get('dataLineageViz.aiResumeNativeGate');

    await resume?.('gate-old', 'approve', []);

    expect(runtime.resumeGate).not.toHaveBeenCalled();
    expect(vscodeMocks.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.showWarningMessage).toHaveBeenCalledWith(
      'Data Lineage: This scope approval action is no longer active. Use the latest approval card.',
    );
    expect(outputChannel.warn).toHaveBeenCalledWith(expect.stringContaining('requestedGateId=gate-old'));
    expect(outputChannel.warn).toHaveBeenCalledWith(expect.stringContaining('pendingGateId=gate-new'));

    await resume?.('gate-new', 'approve', ['fact']);
    expect(runtime.resumeGate).toHaveBeenCalledWith('gate-new', {
      kind: 'approve',
      classes: ['fact'],
    });
  }, 20_000);
});
