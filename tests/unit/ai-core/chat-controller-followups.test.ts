/**
 * The chat host's follow-up suggestions: which buttons `chat.state` carries for the session as it
 * stands, and what a click on each one runs. A defect here offers a dead button, hides a live one,
 * or sends a sentinel prompt to the model unexpanded.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import { cancelledToolTurnResult, errorToolTurnResult, type ModelPort, type ToolGenerationInput } from '../../../src/ai/model/modelPort';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { NEXT_QUESTIONS_TRIGGER, RUN_TRACE_TRIGGER, SHOW_FULL_DESCRIPTION_TRIGGER, TRACE_REQUEST_MARKER } from '../../../src/ai/prompting/prompts';
import type { LineageRuntimeRunInput } from '../../../src/ai/runtime/lineageRuntime';
import { AiSession } from '../../../src/ai/session/session';
import { ToolRegistry } from '../../../src/ai/tools/registry';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import { ChatController } from '../../../src/bridge/chatHandlers';
import type { ChatToWebviewMsg } from '../../../src/engine/shared/chatContract';
import { Logger } from '../../../src/utils/log';

const NEXT_QUESTIONS = { label: 'Next questions and related objects', prompt: NEXT_QUESTIONS_TRIGGER };
const FULL_DESCRIPTION = { label: 'Show full description', prompt: SHOW_FULL_DESCRIPTION_TRIGGER };
const DEEPER_ANALYSIS = { label: 'Start deeper hop-by-hop analysis', prompt: RUN_TRACE_TRIGGER };
const NO_PREVIEW_DESCRIPTION = '_No AI preview description is currently cached for this session._';

const ENTRY = {
  id: 'm', name: 'M', url: 'https://example.test/v1/', model: 'gpt', apiType: 'chat-completions',
  maxInputTokens: 100_000, maxOutputTokens: 4_000,
};

const artifact = (description: string): PresentationArtifact => ({
  name: 'view', nodeIds: [], aiMetadata: { summary: 'Finding', description },
}) as unknown as PresentationArtifact;

/** A session whose discovery walk reached two objects, so the deeper-analysis offer is open. */
function walkedSession(): AiSession {
  const session = new AiSession();
  session.lastDiscoveryOrigin = 'dbo.Orders';
  session.lastDiscoveryWalkCount = 2;
  session.lastDiscoveryQuestion = 'Where does dbo.Orders come from?';
  session.lastDiscoveryAnswer = 'It comes from dbo.Raw.';
  return session;
}

function setup(session: AiSession, overrides: { runtime?: ConstructorParameters<typeof ChatController>[0]['runtime']; run?: (input: LineageRuntimeRunInput) => Promise<{ outcome: 'ok' | 'cancelled'; modelCalls: number }>; port?: ModelPort } = {}) {
  const frames: ChatToWebviewMsg[] = [];
  const runs: { kind: 'run' | 'suggestions'; prompt: string }[] = [];
  const answer = (kind: 'run' | 'suggestions') => vi.fn(async (input: LineageRuntimeRunInput) => {
    runs.push({ kind, prompt: input.request.prompt });
    input.sink.stream('model answer');
    input.sink.result('ok');
    return { outcome: 'ok' as const, modelCalls: 1 };
  });
  const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
  const controller = new ChatController({
    runtime: overrides.runtime ?? { run: overrides.run ? vi.fn(overrides.run) : answer('run'), runSuggestions: answer('suggestions'), resumeGate: vi.fn(async () => true) },
    getSession: () => session,
    modelSources: () => ({ models: [ENTRY], defaultModel: 'm', secrets: { get: async () => undefined }, lmModel: () => undefined }),
    lmCatalog: () => undefined,
    lastPick: { get: () => undefined, update: async () => {} },
    turnSettings: () => ({ discoveryNodeCap: 100, discoveryTokenBudget: 10_000, maxRounds: 5, maxTraceColumns: 50 }),
    logger: Logger.create(channel as never, 'AI'),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    runModelCommand: vi.fn(),
    createPort: async () => overrides.port ?? ({} as ModelPort),
  });
  controller.attachView({ post: (msg) => { frames.push(msg); } });
  const states = () => frames.filter((frame): frame is Extract<ChatToWebviewMsg, { type: 'chat.state' }> => frame.type === 'chat.state');
  const followups = () => states().at(-1)?.followups;
  const texts = () => frames.flatMap((frame) => (frame.type === 'chat.event' && frame.event.type === 'text' ? [frame.event.delta] : []));
  /** Sends one prompt and resolves once the turn's closing state frame is out. */
  const send = async (text: string) => {
    const before = states().length;
    await controller.receive({ type: 'chat.send', text });
    await vi.waitFor(() => {
      expect(states().length).toBeGreaterThan(before + 1);
      expect(states().at(-1)?.busy).toBe(false);
    });
  };
  return { controller, frames, runs, states, followups, texts, send };
}

describe('chat.state followups', () => {
  it('offers none for a fresh session', async () => {
    const { controller, followups } = setup(new AiSession());
    await controller.receive({ type: 'chat.ready' });
    expect(followups()).toEqual([]);
  });

  it('offers next questions once the analysis is completed', async () => {
    const session = new AiSession();
    session.phase = { kind: 'completed' };
    const { controller, followups } = setup(session);
    await controller.receive({ type: 'chat.ready' });
    expect(followups()).toEqual([NEXT_QUESTIONS]);
  });

  it('offers the full description when a presentation is cached', async () => {
    const session = new AiSession();
    session.presentationArtifact = artifact('Long description');
    const { controller, followups } = setup(session);
    await controller.receive({ type: 'chat.ready' });
    expect(followups()).toEqual([FULL_DESCRIPTION]);
  });

  it('offers the deeper analysis while the walk offer is available', async () => {
    const { controller, followups } = setup(walkedSession());
    await controller.receive({ type: 'chat.ready' });
    expect(followups()).toEqual([DEEPER_ANALYSIS]);
  });

  it('lists next questions, description and deeper analysis in that order, never a graph preview', async () => {
    const session = walkedSession();
    session.phase = { kind: 'completed' };
    session.presentationArtifact = artifact('d');
    // smOfferAvailable() needs the idle phase, so completed + walk shows only the first two.
    const { controller, followups } = setup(session);
    await controller.receive({ type: 'chat.ready' });
    expect(followups()).toEqual([NEXT_QUESTIONS, FULL_DESCRIPTION]);
    session.phase = { kind: 'idle' };
    controller.refresh();
    expect(followups()).toEqual([FULL_DESCRIPTION, DEEPER_ANALYSIS]);
  });

  it('offers none while a gate is pending, even with a cached description', async () => {
    const session = walkedSession();
    session.presentationArtifact = artifact('d');
    session.phase = { kind: 'awaiting_gate', gate: { gate: 'confirm_sm_start', classes: [], nodeIds: [], detail: '' } };
    const { controller, followups } = setup(session);
    await controller.receive({ type: 'chat.ready' });
    expect(followups()).toEqual([]);
  });

  it('is empty while a turn runs and recomputed from the session when it ends', async () => {
    const session = walkedSession();
    const { controller, send, states, followups } = setup(session);
    await controller.receive({ type: 'chat.ready' });
    await send('Where does dbo.Orders come from?');
    expect(states().find((state) => state.busy)?.followups).toEqual([]);
    expect(followups()).toEqual([DEEPER_ANALYSIS]);
  });
});

describe('a followup click', () => {
  it('expands the Run trace sentinel before the graph routes it, so the turn takes the run_trace path', async () => {
    const { controller, runs, send } = setup(walkedSession());
    await controller.receive({ type: 'chat.ready' });
    await send(RUN_TRACE_TRIGGER);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe('run');
    expect(runs[0].prompt.startsWith(TRACE_REQUEST_MARKER)).toBe(true);
    expect(runs[0].prompt).toContain('Where does dbo.Orders come from?');
  });

  it('runs next questions on the read-only suggestion path with the expanded facts', async () => {
    const session = walkedSession();
    session.phase = { kind: 'completed' };
    session.presentationArtifact = artifact('d');
    const { controller, runs, send } = setup(session);
    await controller.receive({ type: 'chat.ready' });
    await send(NEXT_QUESTIONS.prompt);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe('suggestions');
    expect(runs[0].prompt).toContain('Suggest useful follow-up questions');
    expect(runs[0].prompt).toContain('Finding: "Finding"');
  });

  it('answers the full description without a model call, with focus links stripped', async () => {
    const session = new AiSession();
    session.presentationArtifact = artifact('See [dbo.Orders](#focus-node:dbo.Orders) now');
    const { controller, runs, texts, states, send } = setup(session);
    await controller.receive({ type: 'chat.ready' });
    await send(SHOW_FULL_DESCRIPTION_TRIGGER);
    expect(runs).toEqual([]);
    expect(texts().join('')).toBe('See dbo.Orders now');
    expect(states().at(-1)?.busy).toBe(false);
  });

  it('says so when no description is cached, still without a model call', async () => {
    const { controller, runs, texts, send } = setup(new AiSession());
    await controller.receive({ type: 'chat.ready' });
    await send(SHOW_FULL_DESCRIPTION_TRIGGER);
    expect(runs).toEqual([]);
    expect(texts().join('')).toBe(NO_PREVIEW_DESCRIPTION);
  });

  it('sends any other prompt to the graph unchanged', async () => {
    const { controller, runs, send } = setup(walkedSession());
    await controller.receive({ type: 'chat.ready' });
    await send('why is it slow?');
    expect(runs).toEqual([{ kind: 'run', prompt: 'why is it slow?' }]);
  });
});

describe('the Run trace click through the real graph', () => {
  it('reaches the run_trace route: the SM-entry stage, never discovery', async () => {
    const session = walkedSession();
    const generations: ToolGenerationInput[] = [];
    const port = {
      identity: { id: 'm', name: 'M' },
      modelCalls: 0,
      generateToolTurn: async (input: ToolGenerationInput) => { generations.push(input); return cancelledToolTurnResult(); },
    } as unknown as ModelPort;
    const statuses: string[] = [];
    const { controller, send } = setup(session, {
      port,
      run: async ({ model, request, sink }) => {
        sink.addObserver((event) => { if (event.type === 'status') statuses.push(event.label); });
        const outcome = await new AgentRuntime({
          threadId: request.id, getSession: () => session, model, registry: new ToolRegistry<string>(),
          sink, maxRounds: 5, turnEpoch: session.beginTurn(),
        }).run(request.prompt);
        return { outcome: outcome === 'cancelled' ? 'cancelled' : 'ok', modelCalls: 0 };
      },
    });
    await controller.receive({ type: 'chat.ready' });
    await send(RUN_TRACE_TRIGGER);
    expect(statuses).toContain('Starting exploration...');
    expect(statuses).not.toContain('Discovering context...');
    expect(generations[0]?.phase).toBe('sm_entry');
    expect(JSON.stringify(generations[0]?.messages)).toContain('Call `lineage_start_exploration` once this turn');
  });
});

describe('a failing Next-questions click', () => {
  it('shows the provider failure in the chat, as a failed turn does', async () => {
    const session = new AiSession();
    session.phase = { kind: 'completed' };
    const port = {
      identity: { id: 'm', name: 'M' },
      modelCalls: 1,
      generateToolTurn: async () => errorToolTurnResult(new Error('upstream down'), { phase: 'suggestions', name: 'Error', message: 'upstream down' }),
    } as unknown as ModelPort;
    const runtime = new LineageRuntime({ getSession: () => session, createRegistry: () => new ToolRegistry<string>() });
    const { controller, frames, send } = setup(session, { runtime, port });
    await controller.receive({ type: 'chat.ready' });
    await send(NEXT_QUESTIONS.prompt);
    const errors = frames.flatMap((frame) => (frame.type === 'chat.event' && frame.event.type === 'error' ? [frame.event.message] : []));
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toBe('');
    const terminal = frames.flatMap((frame) => (frame.type === 'chat.event' && frame.event.type === 'terminal' ? [frame.event] : []));
    expect(terminal).toEqual([{ type: 'terminal', status: 'error', error: errors[0] }]);
  });
});
