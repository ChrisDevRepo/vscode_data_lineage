/**
 * The dispatcher's per-call and per-reply outcomes, one case per condition of the messaging matrix
 * (tool-call and tool-reply handling). Rows the hop-admission suite
 * already proves (notation, backend fault inside a reply, the reply limit of one hop) are not
 * repeated here.
 */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { z } from 'zod';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { TOOL_ARGUMENTS_NOT_OBJECT_REASON } from '../../../src/ai/model/modelPort';
import { assertToolPairingWellFormed } from '../../../src/ai/model/messageWellFormed';
import { compileInstructionPlan } from '../../../src/ai/agent/instructionPlan';
import {
  executeToolAttempt,
  IDENTICAL_RESEND_HINT,
  initialToolPhaseAttemptState,
  MAX_TOOL_PROVIDER_CALLS,
  recordToolAttempt,
  type ToolAttemptObservation,
} from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ToolRegistry, type IToolRegistry } from '../../../src/ai/tools/registry';
import { classifyRejectionCode } from '../../../src/ai/tools/toolProvider';
import { makeRejection, rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';

const SearchSchema = z.object({ query: z.string().min(1) }).strict();

function nativePort(parts: () => Array<vscode.LanguageModelToolCallPart | vscode.LanguageModelTextPart>, budget = createTurnTokenBudget({})) {
  const sendRequest = vi.fn(async () => ({ stream: { async *[Symbol.asyncIterator]() { yield* parts(); } } }));
  const port = new VscodeModelPort(
    { id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1', maxInputTokens: 128000, countTokens: async () => 1, sendRequest } as never,
    { budget },
  );
  return { port, sendRequest };
}

/** A discovery-stage registry: one read tool whose result the case scripts. */
function registryWith(result: (input: unknown) => string): { registry: IToolRegistry<string>; invoke: ReturnType<typeof vi.fn> } {
  const registry = new ToolRegistry<string>();
  const invoke = vi.fn(result);
  registry.register({
    name: 'lineage_search_objects', inputSchema: SearchSchema, effect: 'read', modelDescription: 'Search objects.',
    execute: (input: unknown) => {
      const parsed = SearchSchema.safeParse(input);
      if (!parsed.success) return JSON.stringify(rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema: SearchSchema }));
      return invoke(input) as string;
    },
  });
  return { registry, invoke };
}

function discoveryPlan(registry: IToolRegistry<string>) {
  return compileInstructionPlan({
    kind: 'converse', stage: { kind: 'discover' }, registry,
    messages: [new HumanMessage('Which objects read Orders?')], sink: new TurnEventSink(() => {}),
    facts: { memorySections: [] }, toolChoice: 'auto',
  });
}

const toolMessage = (messages: readonly unknown[]): ToolMessage => messages.find(item => item instanceof ToolMessage) as ToolMessage;
const call = (id: string, input: unknown, tool = 'lineage_search_objects') => new vscode.LanguageModelToolCallPart(id, tool, input as object);

describe('per-reply progress accounting', () => {
  const refused = JSON.stringify(makeRejection({ code: 'result_too_large', hint: 'Narrow the request.' }));
  const observation = (index: number, extra: Partial<ToolAttemptObservation> = {}): ToolAttemptObservation =>
    ({ callId: `c${index}`, toolName: 'lineage_get_scope_bundle', result: refused, input: { origin: `o${index}` }, ...extra });
  const reply = (observations: ToolAttemptObservation[]) => ({ stop: 'continue' as const, providerCalls: 1, observations, rejections: [], messages: [] });

  it('a result refused for size stores nothing, so three such replies stop the step as no progress', () => {
    let state = initialToolPhaseAttemptState('discover');
    for (let index = 0; index < MAX_TOOL_PROVIDER_CALLS; index++) {
      expect(state.stopReason).toBeNull();
      state = recordToolAttempt(state, reply([observation(index, { refused: true })]));
    }
    expect(state).toMatchObject({ noProgressCalls: MAX_TOOL_PROVIDER_CALLS, stopReason: 'no_progress' });
  });

  it('a stored body resets the count; a refused body after it does not', () => {
    let state = recordToolAttempt(initialToolPhaseAttemptState('discover'), reply([observation(0, { refused: true })]));
    state = recordToolAttempt(state, reply([observation(1, { result: '{"nodes":[]}' })]));
    expect(state.noProgressCalls).toBe(0);
    state = recordToolAttempt(state, reply([observation(2, { refused: true })]));
    expect(state).toMatchObject({ noProgressCalls: 1, stopReason: null });
  });

  it('a duplicate-id-only or empty reply counts toward the limit even though its code is outside the chat groups', () => {
    const rejected = { callId: '', toolName: 'lineage_answer', code: REJECTION_CODES.emptyGeneration, reason: 'empty' };
    let state = initialToolPhaseAttemptState('discover');
    for (let index = 0; index < MAX_TOOL_PROVIDER_CALLS; index++) {
      state = recordToolAttempt(state, { stop: 'continue', providerCalls: 1, observations: [], rejections: [rejected], messages: [] });
    }
    expect(state.stopReason).toBe('no_progress');
    expect(classifyRejectionCode(REJECTION_CODES.emptyGeneration)).toBe('correction');
  });
});

describe('rejection classification', () => {
  it.each([
    [REJECTION_CODES.noProjectLoaded, 'backend_fault'],
    [REJECTION_CODES.internalError, 'backend_fault'],
    [REJECTION_CODES.toolExecutionError, 'backend_fault'],
    [REJECTION_CODES.staleTurn, 'backend_fault'],
    [REJECTION_CODES.explorationComplete, 'correction'],
    [REJECTION_CODES.staleProposalRevision, 'correction'],
    [REJECTION_CODES.duplicateCallId, 'correction'],
    ['a_code_no_one_mapped', 'correction'],
  ])('%s is %s', (code, group) => {
    expect(classifyRejectionCode(code)).toBe(group);
  });

  it('a no-project result inside a reply ends the run and executes no later sibling', async () => {
    const { registry, invoke } = registryWith(() => JSON.stringify(makeRejection({ code: REJECTION_CODES.noProjectLoaded, hint: 'No project is loaded; open the project and ask again.' })));
    const model = nativePort(() => [call('first', { query: 'Orders' }), call('second', { query: 'Sales' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempt.calls.map(item => item.status)).toEqual(['rejected', 'phase_closed']);
    expect(recordToolAttempt(initialToolPhaseAttemptState('discover'), attempt).stopReason).toBe('backend_fault');
  });
});

describe('a tool call whose arguments are not a JSON object', () => {
  it.each([
    ['null', null],
    ['a string', 'Orders'],
    ['an array', ['Orders']],
  ])('arrives as %s and is charged to that call, not the generation', async (_label, input) => {
    const model = nativePort(() => [call('bad', input), call('good', { query: 'Orders' })]);
    const result = await model.port.generateToolTurn({ messages: [new HumanMessage('q')], tools: [{ name: 'lineage_search_objects', description: 'Search.', inputSchema: SearchSchema }], phase: 'test' });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.toolCalls).toEqual([
      { valid: false, callId: 'bad', toolName: 'lineage_search_objects', input: JSON.stringify(input), code: REJECTION_CODES.invalidToolInput, reason: TOOL_ARGUMENTS_NOT_OBJECT_REASON },
      { valid: true, callId: 'good', toolName: 'lineage_search_objects', input: { query: 'Orders' } },
    ]);
    // The replayed assistant turn carries an object for every call id, so the tool results pair.
    expect((result.message as AIMessage).tool_calls?.map(item => [item.id, item.args])).toEqual([['bad', {}], ['good', { query: 'Orders' }]]);
  });

  it('is answered by its own tool result stating the fault and the next action, and the valid sibling still runs', async () => {
    const { registry, invoke } = registryWith(() => JSON.stringify({ results: [] }));
    const model = nativePort(() => [call('bad', 'Orders'), call('good', { query: 'Orders' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    assertToolPairingWellFormed(attempt.messages);
    const results = attempt.messages.filter(item => item instanceof ToolMessage) as ToolMessage[];
    expect(results.map(item => item.status)).toEqual(['error', 'success']);
    expect(String(results[0].content)).toBe(TOOL_ARGUMENTS_NOT_OBJECT_REASON);
    expect(String(results[0].content)).not.toContain('Resend the full tool call');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempt.rejections).toEqual([expect.objectContaining({ callId: 'bad', code: REJECTION_CODES.invalidToolInput })]);
  });

  it('a call without an id is the one generation-level failure left', async () => {
    const model = nativePort(() => [call('', { query: 'Orders' })]);
    const result = await model.port.generateToolTurn({ messages: [new HumanMessage('q')], tools: [{ name: 'lineage_search_objects', description: 'Search.', inputSchema: SearchSchema }], phase: 'test' });
    expect(result.status).toBe('error');
  });

  it('empty arguments reach the schema and are diagnosed as a lost call, with the fields to send', async () => {
    const { registry, invoke } = registryWith(() => '{}');
    const model = nativePort(() => [call('empty', {})]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    const content = String(toolMessage(attempt.messages).content);
    expect(invoke).not.toHaveBeenCalled();
    expect(content).toContain('The call arrived with no arguments at all');
    expect(content).toContain('"query"');
  });
});

describe('model-facing rejection text', () => {
  it('never shows a bare machine code when a hint states the fault', async () => {
    const { registry } = registryWith(() => JSON.stringify(makeRejection({ code: 'off_policy', hint: 'Call lineage_get_object_detail for one object.' })));
    const model = nativePort(() => [call('c1', { query: 'Orders' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry), { priorState: initialToolPhaseAttemptState('discover') });
    const content = String(toolMessage(attempt.messages).content);
    expect(content.split('\n')[0]).toBe('Call lineage_get_object_detail for one object.');
    expect(content).not.toMatch(/^off_policy/m);
    expect(content).toMatch(/replies left for this step\.$/);
  });

  it('keeps a bare code when no hint exists, so the model is never answered with nothing', async () => {
    const { registry } = registryWith(() => JSON.stringify(makeRejection({ code: 'not_found' })));
    const model = nativePort(() => [call('c1', { query: 'Orders' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    expect(String(toolMessage(attempt.messages).content)).toBe('not_found');
  });

  it('an unchanged resend of a rejected call is named as such; a changed call is not', async () => {
    const { registry } = registryWith(() => JSON.stringify(makeRejection({ code: 'not_found', reason: 'No object matches.', hint: 'Use an id from lineage_search_objects.' })));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const first = await executeToolAttempt(nativePort(() => [call('c1', { query: 'Orders' })]).port, plan, { priorState: state });
    expect(String(toolMessage(first.messages).content)).not.toContain(IDENTICAL_RESEND_HINT);
    state = recordToolAttempt(state, first);
    const same = await executeToolAttempt(nativePort(() => [call('c2', { query: 'Orders' })]).port, plan, { priorState: state });
    expect(String(toolMessage(same.messages).content)).toContain(IDENTICAL_RESEND_HINT);
    expect(toolMessage(same.messages).artifact).toMatchObject({ code: 'not_found', reason: 'No object matches.' });
    const changed = await executeToolAttempt(nativePort(() => [call('c3', { query: 'Sales' })]).port, plan, { priorState: recordToolAttempt(state, same) });
    expect(String(toolMessage(changed.messages).content)).not.toContain(IDENTICAL_RESEND_HINT);
  });

  it('an unchanged resend of a schema-rejected call is named as such too', async () => {
    const { registry } = registryWith(() => '{}');
    const plan = discoveryPlan(registry);
    const first = await executeToolAttempt(nativePort(() => [call('c1', { query: '' , extra: 1 })]).port, plan, { priorState: initialToolPhaseAttemptState('discover') });
    const state = recordToolAttempt(initialToolPhaseAttemptState('discover'), first);
    const same = await executeToolAttempt(nativePort(() => [call('c2', { extra: 1, query: '' })]).port, plan, { priorState: state });
    expect(String(toolMessage(same.messages).content)).toContain(IDENTICAL_RESEND_HINT);
  });

  it('a read repeated from an earlier reply is a duplicate_read naming the accepted call', async () => {
    const { registry, invoke } = registryWith(() => JSON.stringify({ results: [] }));
    const model = nativePort(() => [call('again', { query: 'Orders' })]);
    const plan = discoveryPlan(registry);
    const first = await executeToolAttempt(model.port, plan);
    const state = recordToolAttempt(initialToolPhaseAttemptState('discover'), first);
    const second = await executeToolAttempt(model.port, plan, { priorState: state });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(toolMessage(second.messages).artifact).toMatchObject({ code: REJECTION_CODES.duplicateRead, detail: { acceptedCallId: 'again' } });
    expect(recordToolAttempt(state, second).noProgressCalls).toBe(1);
  });

  it('a read repeated after its result was trimmed from the transcript is answered with the held result', async () => {
    const { registry, invoke } = registryWith(() => JSON.stringify({ results: ['held'] }));
    const model = nativePort(() => [call('again', { query: 'Orders' })]);
    const plan = discoveryPlan(registry);
    const first = await executeToolAttempt(model.port, plan);
    const trimmed = { ...recordToolAttempt(initialToolPhaseAttemptState('discover'), first), messages: [] };
    const second = await executeToolAttempt(model.port, plan, { priorState: trimmed });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(second.rejections).toEqual([]);
    expect(toolMessage(second.messages).status).toBe('success');
    expect(String(toolMessage(second.messages).content)).toContain('held');
  });
});
