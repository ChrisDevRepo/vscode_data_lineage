/** Per-call, per-reply and recovery outcomes of the tool dispatcher. */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { z } from 'zod';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { TOOL_ARGUMENTS_NOT_OBJECT_REASON } from '../../../src/ai/model/modelPort';
import { assertToolPairingWellFormed } from '../../../src/ai/model/messageWellFormed';
import { compileInstructionPlan, explorationFacts } from '../../../src/ai/agent/instructionPlan';
import {
  executeToolAttempt,
  IDENTICAL_RESEND_HINT,
  initialToolPhaseAttemptState,
  MAX_TOOL_PROVIDER_CALLS,
  recordToolAttempt,
  renderToolAttemptContext,
  type ToolAttemptObservation,
} from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ToolRegistry, type IToolRegistry } from '../../../src/ai/tools/registry';
import { classifyRejectionCode } from '../../../src/ai/tools/toolProvider';
import { makeRejection, rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { buildRouteValidationRejection } from '../../../src/ai/sm/smRouteValidation';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { PruneCurrentInputSchema, submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';

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

describe('optional table-arrival prune command delivery', () => {
  it.each([
    { mode: 'bb', accepted: true }, { mode: 'ct', accepted: true },
    { mode: 'bb', accepted: false }, { mode: 'ct', accepted: false },
  ] as const)('serves conditional self-prune and evaluates one commit in $mode (accepted=$accepted)', async ({ mode, accepted }) => {
    const registry = new ToolRegistry<string>();
    const prune = vi.fn(() => JSON.stringify(accepted ? { ok: true } : makeRejection({ code: REJECTION_CODES.offPolicy, reason: 'Removal no longer admitted.' })));
    registry.register({ name: 'lineage_submit_findings', inputSchema: z.object({}), effect: 'hop_commit', execute: () => '{}' });
    registry.register({ name: 'lineage_prune_current', inputSchema: PruneCurrentInputSchema, effect: 'hop_commit', execute: prune });
    const draft = {
      kind: 'converse' as const, stage: { kind: 'active' as const, mode: mode === 'ct' ? 'sm_ct' as const : 'sm_bb' as const },
      registry, messages: [new HumanMessage('Inspect the current object.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts(mode, ['Value'], { classification: 'technical', memorySections: [] }), requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required' as const,
      onToolResult: (name: string, _input: unknown, isError: boolean) => { if (name === 'lineage_prune_current' && !isError) completed = true; },
      isPhaseComplete: () => completed,
    };
    let completed = false;
    for (const canPruneCurrent of [undefined, () => false]) {
      const unavailable = compileInstructionPlan({ ...draft, canPruneCurrent });
      expect(unavailable.context.toolNames).not.toContain('lineage_prune_current');
      expect(unavailable.input.registry.has('lineage_prune_current')).toBe(false);
      expect(() => unavailable.input.registry.invoke('lineage_prune_current', {})).toThrow('no tool registered');
    }
    const available = compileInstructionPlan({ ...draft, canPruneCurrent: () => true });
    expect(available.context.toolNames).toContain('lineage_prune_current');
    expect(available.input.registry.get('lineage_prune_current')?.inputSchema).toBe(PruneCurrentInputSchema);
    const input = { focus_node_id: 'dbo.Reader', reason: 'None of the inherited work applies to this SQL.' };
    const model = nativePort(() => [call('prune', input, 'lineage_prune_current'), call('sibling', {}, 'lineage_submit_findings')]);
    const result = await executeToolAttempt(model.port, available);
    expect(result.stop).toBe(accepted ? 'phase_complete' : 'continue');
    expect(result.observations).toEqual([]);
    expect(prune).toHaveBeenCalledExactlyOnceWith(input);
    const messages = result.messages.filter(item => item instanceof ToolMessage) as ToolMessage[];
    expect(messages[0].status).toBe(accepted ? 'success' : 'error');
    expect(messages[1].artifact).toMatchObject({ code: accepted ? 'phase_closed' : 'extra_call_not_evaluated' });
  });
});

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

  it('an empty reply counts toward the limit even though its code is outside the chat groups', () => {
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
    ['incomplete_task', 'missing_details'],
    [REJECTION_CODES.invalidInput, 'answer_format'],
    [REJECTION_CODES.missingField, 'answer_format'],
    [REJECTION_CODES.routeValidationFailed, 'source_selection'],
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
  it.each([{ input: null }, { input: 'Orders' }, { input: [] }])('keeps an unavailable malformed call replayable for correction: $input', async ({ input }) => {
    const { registry, invoke } = registryWith(() => JSON.stringify({ results: [] }));
    const model = nativePort(() => [call('unavailable', input, 'unavailable_tool')]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    expect(attempt.rejections).toEqual([expect.objectContaining({
      callId: 'unavailable', code: REJECTION_CODES.unknownTool,
    })]);
    expect(invoke).not.toHaveBeenCalled();
    expect(toolMessage(attempt.messages).status).toBe('error');
    expect(() => assertToolPairingWellFormed(attempt.messages)).not.toThrow();
    expect(recordToolAttempt(initialToolPhaseAttemptState('discover'), attempt).stopReason).toBeNull();
  });

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
  it('keeps the latest large rejected call paired with its complete repair message over the retry-context budget', async () => {
    const newest = [new AIMessage({ content: '', tool_calls: [{ id: 'large', name: 'lineage_present_result', args: {
      sections: [{ label: 'Sources', text: 'SQL-supported finding. '.repeat(12000) }],
    } }] }), new ToolMessage({ tool_call_id: 'large', name: 'lineage_present_result', status: 'error',
      content: 'sections.0.label is invalid. All report text is held. Resend only sections: [{index: 0, label: "Source"}]. Last reply for this step.' })];
    const state = { ...initialToolPhaseAttemptState('synthesis'), messages: [
      new AIMessage({ content: '', tool_calls: [{ id: 'old', name: 'lineage_present_result', args: {} }] }),
      new ToolMessage({ tool_call_id: 'old', content: 'The earlier call was incomplete.' }), ...newest,
    ] };
    const logs: string[] = [];
    const context = await renderToolAttemptContext(state, { budget: createTurnTokenBudget({ modelWindowTokens: 1024 }),
      getNumTokens: async text => Math.ceil(text.length / 4) }, line => logs.push(line));
    expect(context).toEqual(newest);
    assertToolPairingWellFormed(context);
    expect(logs).toEqual([expect.stringContaining('tool-attempt-context-oversize-newest-kept')]);
  });

  it('escalates schema-level column failures with choices for each failed field', async () => {
    const columns = Array.from({ length: 400 }, (_, i) => `Column${i}`);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, {
      outCols: columns, writesTo: false, incomingRefs: [{ node: 'source', col: 'IncomingA' }, { node: 'other', col: 'IncomingB' }],
    });
    const input = { focus_node_id: 'focus', summary: 'A valid summary.', sections: { technical: 'A long valid finding. '.repeat(5000) },
      column_flow: [{ out_col: 'Missing', upstream_columns: [] }, { out_col: 'AlsoMissing', upstream_columns: [] }],
      terminated_inputs: [{ node: 'source', col: 'MissingInput' }] };
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected invalid columns');
    const rejection = rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema });
    const { registry } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const first = await executeToolAttempt(nativePort(() => [call('first', { query: 'Missing' })]).port, plan, { priorState: state });
    expect(String(toolMessage(first.messages).content)).not.toContain('Allowed values for');
    state = recordToolAttempt(state, first);
    const second = await executeToolAttempt(nativePort(() => [call('second', { query: 'MissingInput' })]).port, plan, { priorState: state });
    const content = String(toolMessage(second.messages).content);
    expect(content).toContain(`Allowed values for column_flow.0.out_col, column_flow.1.out_col: ${columns.map(value => JSON.stringify(value)).join(', ')}.`);
    expect(content.match(/"Column399"/g)).toHaveLength(1);
    expect(content).toContain('Allowed values for terminated_inputs.0.col when node="source": "IncomingA"');
    expect(content).toContain('Allowed values for terminated_inputs.0.col when node="other": "IncomingB"');
    expect(content).not.toContain(input.sections.technical);
  });

  it.each([3, 400].flatMap(count => ['column', 'neighbor', 'enum'].map(kind => ({ count, kind }))))('escalates $kind choices on the second rejection with all $count values', async ({ count, kind }) => {
    const columns = Array.from({ length: count }, (_, i) => `VerifiedColumn${i}`);
    const hint = 'Held: sections.technical, summary. Resend: column_flow. Resend focus_node_id with only the parts to correct.';
    const path = kind === 'column' ? 'column_flow.0.upstream_columns.0.col' : kind === 'neighbor' ? 'questions.0.nodeId' : 'query';
    const invalidEnum = z.object({ query: z.enum(columns as [string, ...string[]]) }).safeParse({ query: 'Missing' });
    if (invalidEnum.success) throw new Error('Expected invalid enum');
    const rejection = kind === 'enum' ? rejectionFromZodError(invalidEnum.error, { code: 'invalid_tool_input', input: { query: 'Missing' }, hint })
      : buildRouteValidationRejection([{ kind: kind === 'column' ? 'bad_contributor_col' : 'question_not_neighbor', id: 'Source', path,
        reason: 'The supplied value is not allowed here.',
        allowed_values: columns, ...(kind === 'column' ? { when: { node: 'Source' } } : {}) }], hint);
    const { registry } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const first = await executeToolAttempt(nativePort(() => [call('first', { query: 'Missing' })]).port, plan, { priorState: state });
    expect(String(toolMessage(first.messages).content)).toContain(path);
    expect(String(toolMessage(first.messages).content)).not.toContain(columns[0]);
    expect(String(toolMessage(first.messages).content)).toContain(hint);
    state = recordToolAttempt(state, first);
    const second = await executeToolAttempt(nativePort(() => [call('second', { query: 'StillMissing' })]).port, plan, { priorState: state });
    const content = String(toolMessage(second.messages).content);
    expect(content).toContain(`Allowed values for ${path}${kind === 'column' ? ' when node="Source"' : ''}: ${columns.map(value => JSON.stringify(value)).join(', ')}.`);
    expect(content).toContain(hint);
    expect(content).toContain(`Fields to correct in this reply: ${path.split('.')[0]}.`);
    expect(content).toContain('Last reply for this step.');
    state = recordToolAttempt(state, second);
    const third = await executeToolAttempt(nativePort(() => [call('third', { query: 'StillMissing' })]).port, plan, { priorState: state });
    expect(recordToolAttempt(state, third).stopReason).toBe('no_progress');
    if (count === 400) expect(second.rejections[0].detail).toMatchObject({ omitted: true });
  });

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

  it('oversized reads retain errors for cached siblings and trimmed replays and exhaust the no-progress budget', async () => {
    const { registry, invoke } = registryWith(() => JSON.stringify({ results: 'x'.repeat(4_000_000) }));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    for (let index = 0; index < MAX_TOOL_PROVIDER_CALLS; index++) {
      const model = nativePort(() => [call(`read-${index}`, { query: 'Orders' }),
        ...(index === 0 ? [call('sibling', { query: 'Orders' })] : [])]);
      const attempt = await executeToolAttempt(model.port, plan, { priorState: state });
      const results = attempt.messages.filter(message => message instanceof ToolMessage) as ToolMessage[];
      expect(results).toHaveLength(index === 0 ? 2 : 1);
      for (const result of results) {
        expect(result).toMatchObject({ status: 'error', artifact: { code: 'result_too_large' } });
        expect(String(result.content)).toContain('Narrow the request');
      }
      state = { ...recordToolAttempt(state, attempt), messages: [] };
    }
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ noProgressCalls: MAX_TOOL_PROVIDER_CALLS, stopReason: 'no_progress' });
  });
});
