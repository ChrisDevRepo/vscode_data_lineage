/** Per-call, per-reply and recovery outcomes of the tool dispatcher. */
import { describe, expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { z } from 'zod';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { TOOL_ARGUMENTS_NOT_OBJECT_REASON } from '../../../src/ai/model/modelPort';
import { assertToolPairingWellFormed } from '../../../src/ai/model/messageWellFormed';
import { compileInstructionPlan, explorationFacts } from '../../../src/ai/agent/instructionPlan';
import {
  executeToolAttempt,
  initialToolPhaseAttemptState,
  MAX_TOOL_PROVIDER_CALLS,
  recordToolAttempt,
  renderToolAttemptContext,
  type ToolAttemptObservation,
  type ToolPhaseAttemptState,
} from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ToolRegistry, type IToolRegistry } from '../../../src/ai/tools/registry';
import { classifyRejectionCode } from '../../../src/ai/tools/toolProvider';
import { CLARIFICATION_WINDOW_MS, ISSUE_CATEGORIES, ISSUES, LAST_CORRECTION, at, makeRejection, rejectionFromZodError, type IssueCode } from '../../../src/ai/support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { buildRouteValidationRejection } from '../../../src/ai/sm/smRouteValidation';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { GetContextInputSchema, PruneCurrentInputSchema, submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { makeGraph, makeIndexedModel, makeNode } from '../helpers/modelFixtures';
import { stubToolServices, schemaFaults, withSchemaFaults, type SchemaFault } from './helpers/toolServices';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

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

/** The rendered problem the model reads (D-103) and its errors across categories. */
interface ShownError { path: string; fault: string; correction: string; allowed?: string[]; missing?: string[]; more?: number }
interface Problem { code: string; attempt: string; notice?: string; guidance: Array<{ category: string; instruction: string; errors: ShownError[]; more?: number; fallback?: string }>; resend: string[]; resend_rule?: string }
const PROBLEM_KEYS = ['attempt', 'code', 'guidance', 'notice', 'resend', 'resend_rule'];
const problemOf = (value: unknown): Problem => (typeof value === 'string' ? JSON.parse(value) : value) as Problem;
const shown = (value: unknown): ShownError[] => problemOf(value).guidance.flatMap(group => group.errors);
/** One shown error of an issue code, without values. */
const fault = (code: IssueCode, path = '') => ({ path, fault: ISSUES[code].label, correction: ISSUES[code].correction });

it.each([
  { phase: 'active', prior: true, human: true, order: ['anchor', 'call', 'result', 'current'] },
  { phase: 'discover', prior: true, human: true, order: ['anchor', 'current', 'call', 'result'] },
  { phase: 'synthesis', prior: true, human: true, order: ['anchor', 'current', 'call', 'result'] },
  { phase: 'active', prior: false, human: true, order: ['anchor', 'current'] },
  { phase: 'active', prior: true, human: false, order: ['anchor', 'current', 'call', 'result'] },
] as const)('places only a rebuilt active user job after paired history: $phase prior=$prior human=$human', async scenario => {
  const { registry } = registryWith(() => '{}');
  const currentText = 'CURRENT JOB: held correction. SQL: SELECT Value FROM dbo.Source; TASK: trace Value.';
  const base = [new HumanMessage('ANCHOR'), scenario.human ? new HumanMessage(currentText) : new AIMessage(currentText)];
  const plan = compileInstructionPlan({ kind: 'converse',
    stage: scenario.phase === 'active' ? { kind: 'active', mode: 'sm_bb' } : { kind: scenario.phase },
    registry, messages: base, sink: new TurnEventSink(() => {}),
    facts: explorationFacts('bb', [], { classification: 'technical', memorySections: [] }), toolChoice: 'auto' });
  const attempted = new AIMessage({ content: '', tool_calls: [{ id: 'original-call', name: 'lineage_search_objects', args: { query: 'Missing' } }] });
  const returned = new ToolMessage({ content: 'Original fault stays intact.', tool_call_id: 'original-call', name: 'lineage_search_objects', status: 'error' });
  const state = { ...initialToolPhaseAttemptState(scenario.phase), providerCalls: scenario.prior ? 1 : 0,
    messages: scenario.prior ? [attempted, returned] : [] };
  const model = nativePort(() => []);
  await executeToolAttempt(model.port, plan, { priorState: state });
  const request = (model.sendRequest.mock.calls[0] as unknown as [vscode.LanguageModelChatMessage[]])[0];
  const order = request.flatMap(message => message.content.flatMap(part =>
    part instanceof vscode.LanguageModelToolCallPart ? ['call']
      : part instanceof vscode.LanguageModelToolResultPart ? ['result']
      : part instanceof vscode.LanguageModelTextPart ? [part.value === 'ANCHOR' ? 'anchor' : part.value === currentText ? 'current' : 'unexpected'] : []));
  expect(order).toEqual(scenario.order);
  expect(request.flatMap(message => message.content).filter(part => part instanceof vscode.LanguageModelTextPart && part.value === currentText)).toHaveLength(1);
  expect(plan.input.messages).toEqual(base);
  expect(state.messages).toEqual(scenario.prior ? [attempted, returned] : []);
  assertToolPairingWellFormed(state.messages);
});

function consumedRejection(model: ReturnType<typeof nativePort>, callId: string) {
  const request = model.sendRequest.mock.calls[0] as unknown as [vscode.LanguageModelChatMessage[]];
  const delivered = request[0].flatMap(message => message.content).find(part => part instanceof vscode.LanguageModelToolResultPart && part.callId === callId);
  if (!(delivered instanceof vscode.LanguageModelToolResultPart)) throw new Error('Expected a consumed tool result');
  expect(delivered.callId).toBe(callId);
  const content = delivered.content.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('\n');
  return { content, feedback: JSON.parse(content) };
}


describe('optional table-arrival prune command delivery', () => {
  it.each([
    { mode: 'bb', accepted: true }, { mode: 'ct', accepted: true },
    { mode: 'bb', accepted: false }, { mode: 'ct', accepted: false },
  ] as const)('serves conditional self-prune and evaluates one commit in $mode (accepted=$accepted)', async ({ mode, accepted }) => {
    const registry = new ToolRegistry<string>();
    const prune = vi.fn(() => JSON.stringify(accepted ? { ok: true } : makeRejection({ code: REJECTION_CODES.offPolicy, reason: 'Removal no longer admitted.', errors: at('off_policy') })));
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
    const lines: string[] = [];
    const result = await executeToolAttempt(model.port, available, { debugLog: line => lines.push(line) });
    expect(result.stop).toBe(accepted ? 'phase_complete' : 'continue');
    expect(result.observations).toEqual([]);
    expect(prune).toHaveBeenCalledExactlyOnceWith(input);
    const messages = result.messages.filter(item => item instanceof ToolMessage) as ToolMessage[];
    expect(messages[0].status).toBe(accepted ? 'success' : 'error');
    expect(messages[1].artifact).toMatchObject({ code: accepted ? 'phase_closed' : 'extra_call_not_evaluated' });
    const outcomes = lines.filter(line => line.startsWith('[ToolOutcome]'));
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toContain(`callId=prune status=${accepted ? 'accepted' : 'rejected'}`);
    expect(outcomes[1]).toContain('callId=sibling status=not_evaluated');
    expect(outcomes.filter(line => line.includes(' status=rejected'))).toHaveLength(accepted ? 0 : 1);
  });
});

describe('per-reply progress accounting', () => {
  const refused = JSON.stringify(makeRejection({ code: 'result_too_large', errors: at('result_too_large') }));
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
    [REJECTION_CODES.invalidInput, 'answer_format'],
    [REJECTION_CODES.missingField, 'answer_format'],
    [REJECTION_CODES.routeValidationFailed, 'source_selection'],
    [REJECTION_CODES.noProjectLoaded, 'backend_fault'],
    [REJECTION_CODES.internalError, 'backend_fault'],
    [REJECTION_CODES.toolExecutionError, 'backend_fault'],
    [REJECTION_CODES.staleTurn, 'backend_fault'],
    [REJECTION_CODES.explorationComplete, 'correction'],
    [REJECTION_CODES.staleProposalRevision, 'correction'],
    ['a_code_no_one_mapped', 'correction'],
  ])('%s is %s', (code, group) => {
    expect(classifyRejectionCode(code)).toBe(group);
  });

  it('a no-project result inside a reply ends the run and executes no later sibling', async () => {
    const { registry, invoke } = registryWith(() => JSON.stringify(makeRejection({ code: REJECTION_CODES.noProjectLoaded, errors: at('no_project') })));
    const model = nativePort(() => [call('first', { query: 'Orders' }), call('second', { query: 'Sales' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempt.calls.map(item => item.status)).toEqual(['rejected', 'phase_closed']);
    expect(recordToolAttempt(initialToolPhaseAttemptState('discover'), attempt).stopReason).toBe('backend_fault');
  });
});

describe('a tool call whose arguments are not a JSON object', () => {
  it.each([{ query: 'Sales' }, null])('refuses ambiguous call IDs before dispatch, including malformed arguments: %j', async input => {
    const { registry, invoke } = registryWith(() => JSON.stringify({ results: [] }));
    const model = nativePort(() => [call('same-id', { query: 'Orders' }), call('same-id', input)]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    expect(attempt.stop).toBe('error');
    expect(invoke).not.toHaveBeenCalled();
    expect(attempt.calls).toEqual([]);
    expect(attempt.messages).toEqual([]);
    expect(model.sendRequest).toHaveBeenCalledOnce();
  });

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
    const lines: string[] = [];
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry), { debugLog: line => lines.push(line) });
    assertToolPairingWellFormed(attempt.messages);
    const results = attempt.messages.filter(item => item instanceof ToolMessage) as ToolMessage[];
    expect(results.map(item => item.status)).toEqual(['error', 'success']);
    // D-103: the call-level fault is the root error; its message comes from the port's reason.
    // Without step state the rejection renders at feedback 2, so the accepted JSON type is stated.
    expect(problemOf(String(results[0].content))).toMatchObject({ code: REJECTION_CODES.invalidToolInput, attempt: '2/3', resend: [] });
    expect(shown(String(results[0].content))).toEqual([{ ...fault('type'), allowed: ['object'] }]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempt.rejections).toEqual([expect.objectContaining({ callId: 'bad', code: REJECTION_CODES.invalidToolInput })]);
    expect(lines.filter(line => line.startsWith('[ToolOutcome]'))).toEqual([
      expect.stringContaining('callId=bad status=rejected code=invalid_tool_input'),
      expect.stringContaining('callId=good status=accepted'),
    ]);
  });

  it('empty arguments reach the schema and name every missing field', async () => {
    const { registry, invoke } = registryWith(() => '{}');
    const model = nativePort(() => [call('empty', {})]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    const content = String(toolMessage(attempt.messages).content);
    expect(invoke).not.toHaveBeenCalled();
    expect(shown(content)).toEqual([fault('missing', 'query')]);
  });

  it('rejects a missing tool input instead of accepting the empty object an empty schema allows', async () => {
    const model = nativePort(() => [call('missing', undefined, 'lineage_get_context'), call('sent', {}, 'lineage_get_context')]);
    const result = await model.port.generateToolTurn({
      messages: [new HumanMessage('q')],
      tools: [{ name: 'lineage_get_context', description: 'Read the context.', inputSchema: GetContextInputSchema }],
      phase: 'test',
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        valid: false, callId: 'missing', toolName: 'lineage_get_context',
        code: REJECTION_CODES.invalidToolInput, reason: TOOL_ARGUMENTS_NOT_OBJECT_REASON,
      }),
      { valid: true, callId: 'sent', toolName: 'lineage_get_context', input: {} },
    ]);
  });

  it('rejects structured output when the generation also calls another tool', async () => {
    const schema = z.object({ action: z.literal('approve') }).strict();
    const model = nativePort(() => [
      call('s', { action: 'approve' }, 'structured_output'),
      call('q', { query: 'Orders' }, 'lineage_search_objects'),
    ]);
    await expect(model.port.generateStructured({
      messages: [new HumanMessage('q')],
      schema,
      phase: 'test',
    })).rejects.toMatchObject({ code: REJECTION_CODES.invalidStructuredOutput });
  });

  it('rejects structured output when another call has non-object arguments', async () => {
    const schema = z.object({ action: z.literal('approve') }).strict();
    const model = nativePort(() => [
      call('s', { action: 'approve' }, 'structured_output'),
      call('q', 'Orders', 'lineage_search_objects'),
    ]);
    await expect(model.port.generateStructured({
      messages: [new HumanMessage('q')],
      schema,
      phase: 'test',
    })).rejects.toMatchObject({ code: REJECTION_CODES.invalidStructuredOutput });
  });
});

describe('model-facing rejection text', () => {
  it('delivers every protected-A and independent-B repair fact in the next consumed tool result', async () => {
    const root = '[d].[Root]', protectedId = '[d].[Protected]', independentId = '[d].[Independent]';
    const nodes = [root, protectedId, independentId].map(id => makeNode({ id, schema: 'd', name: id,
      type: 'view', bodyScript: 'SELECT 1 AS Value;', columns: [{ name: 'Value', type: 'int', nullable: 'NOT NULL', extra: '' }] }));
    const pairs: [string, string][] = [[protectedId, root], [independentId, root]];
    const indexed = makeIndexedModel(nodes, pairs), graph = makeGraph(nodes, pairs);
    const session = new AiSession();
    session.model = indexed;
    session.graph = graph;
    session.setClassification('technical');
    session.beginTurn();
    const engine = new NavigationEngine(indexed, graph, () => {}, { memory: session.memory });
    engine.classification = 'technical';
    expect(engine.init({ origin: root, question: 'Explain Value.', analysisMode: 'ct', targetColumns: ['Value'],
      direction: 'upstream', depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    session.stateMachine = engine;
    session.enterExploring(session.turnEpoch);
    const { services } = stubToolServices({ session, model: indexed, graph, turnEpoch: () => session.turnEpoch });
    const input = { focus_node_id: root, summary: 'Root reads Value.', sections: { technical: 'Value is supplied by Protected.' },
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: protectedId, col: 'Value', transforms: ['compute', 'filter'] }] }],
      questions: [protectedId, independentId].map(nodeId => ({ nodeId, question: 'Explain the contribution.' })),
      prune_neighbors: [protectedId, independentId].map(id => ({ id, reason: 'Outside the investigation.' })) };
    const invoke = vi.fn((sent: unknown) => executeSubmitFindings(sent, services));
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_submit_findings', inputSchema: submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns, false),
      effect: 'hop_commit', execute: invoke });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: 'sm_ct' }, registry,
      messages: [new HumanMessage('Inspect Root.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts('ct', ['Value'], { classification: 'technical', memorySections: [] }),
      requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required' });
    const first = await executeToolAttempt(nativePort(() => [call('facts', input, 'lineage_submit_findings')]).port, plan,
      { priorState: initialToolPhaseAttemptState('active') });
    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), first, 'lineage_submit_findings');
    expect(first.rejections).toHaveLength(1);
    expect(state).toMatchObject({ providerCalls: 1, rejectedTerminalCalls: 1, stopReason: null });
    expect(engine.heldFindingFocus).toBe(root);
    const retry = { focus_node_id: root, questions: input.questions, prune_neighbors: input.prune_neighbors };
    const model = nativePort(() => [call('facts-retry', retry, 'lineage_submit_findings')]);
    const next = await executeToolAttempt(model.port, plan, { priorState: state });
    expect(model.sendRequest).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(next.providerCalls).toBe(1);
    assertToolPairingWellFormed(state.messages);
    // Inspect the actual consumed content, never the local artifact.
    const { content, feedback } = consumedRejection(model, 'facts');
    expect(feedback).toMatchObject({ code: REJECTION_CODES.routeValidationFailed });
    expect([...feedback.resend].sort()).toEqual(['column_flow', 'prune_neighbors', 'questions']);
    for (const absent of ['replies_remaining', 'reason', 'hint', 'detail']) expect(feedback).not.toHaveProperty(absent);
    expect(shown(feedback).map(error => error.path)).toEqual(expect.arrayContaining(['questions.0.nodeId', 'questions.1.nodeId', 'prune_neighbors.0.id']));
    const lastModel = nativePort(() => []);
    const secondState = recordToolAttempt(state, next, 'lineage_submit_findings');
    await executeToolAttempt(lastModel.port, plan, { priorState: secondState });
    const last = consumedRejection(lastModel, 'facts-retry').feedback;
    // Replacement is schema-eligible; keeping the conflicting effective mapping still rejects every action fault.
    expect(shown(last).map(error => [error.path, [...(error.allowed ?? [])].sort()])).toEqual([
      ['prune_neighbors.0.id', [independentId]],
      ['questions.0.nodeId', [independentId, protectedId].sort()],
      ['questions.1.nodeId', [independentId, protectedId].sort()],
    ]);
    expect(toolMessage(next.messages)).toMatchObject({ status: 'error', tool_call_id: 'facts-retry' });
    expect(toolMessage(first.messages).artifact).toMatchObject({ detail: expect.arrayContaining([
      expect.objectContaining({ kind: 'prune_unsupported', id: protectedId, allowed_values: [independentId] }),
    ]) });
    assertToolPairingWellFormed(secondState.messages);
    expect(content).not.toContain('replies_remaining');
  });

  it.each([
    { id: 'invalid-fields', schema: z.object({ query: z.enum(['Orders', 'Sales']), limit: z.number().int().min(1) }).strict(),
      input: { query: 'Missing', limit: 0 }, issueCount: 2, issuePaths: ['query', 'limit'],
      errors: [{ path: 'query', code: 'enum' as IssueCode, allowed: ['Orders', 'Sales'] }, { path: 'limit', code: 'size' as IssueCode }] },
    { id: 'unknown-keys', schema: z.object({ column_flow: z.array(z.object({ out_col: z.string() }).strict()) }).strict(),
      input: { column_flow: Array.from({ length: 7 }, (_, index) => ({ out_col: `Value${index}`, note: 'RAW_NOTE_SENTINEL' })) }, issueCount: 7,
      issuePaths: Array.from({ length: 7 }, (_, index) => `column_flow.${index}.note`),
      errors: Array.from({ length: 7 }, (_, index) => ({ path: `column_flow.${index}.note`, code: 'unknown_key' as IssueCode, allowed: ['out_col'] })) },
  ])('delivers every schema correction fact in the next consumed request: $id', async ({ id, schema, input, issueCount, issuePaths, errors }) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error('Expected schema faults');
    expect(parsed.error.issues).toHaveLength(issueCount);
    const rejection = rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema });
    const { registry, invoke } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    const first = await executeToolAttempt(nativePort(() => [call(id, { query: 'Orders' })]).port, plan,
      { priorState: initialToolPhaseAttemptState('discover') });
    const state = recordToolAttempt(initialToolPhaseAttemptState('discover'), first);
    const model = nativePort(() => [call(`${id}-retry`, { query: 'Sales' })]);
    const second = await executeToolAttempt(model.port, plan, { priorState: state });
    expect(model.sendRequest).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledTimes(2);
    const { content, feedback } = consumedRejection(model, id);
    // Feedback 1: every fault by path and code, no allowed values yet (D-105).
    expect(Object.keys(feedback).every(key => PROBLEM_KEYS.includes(key))).toBe(true);
    expect(feedback.code).toBe(REJECTION_CODES.invalidInput);
    const byPath = <T extends { path: string }>(rows: T[]) => [...rows].sort((a, b) => a.path.localeCompare(b.path));
    expect(shown(feedback)).toEqual(byPath(errors.map(({ path, code }) => fault(code, path))));
    const lastModel = nativePort(() => []);
    await executeToolAttempt(lastModel.port, plan, { priorState: recordToolAttempt(state, second) });
    const last = consumedRejection(lastModel, `${id}-retry`).feedback;
    // Feedback 2: the same faults, now with the schema's allowed values.
    const sortedValues = (rows: ShownError[]) => rows.map(row => (row.allowed ? { ...row, allowed: [...row.allowed].sort() } : row));
    expect(sortedValues(shown(last))).toEqual(byPath(errors.map(({ path, code, ...values }) => ({ ...fault(code, path), ...values }))));
    expect(last).not.toHaveProperty('replies_remaining');
    expect(toolMessage(first.messages).artifact).toMatchObject({ issuePaths });
    expect(content).not.toContain('RAW_NOTE_SENTINEL');
    expect(feedback).not.toHaveProperty('replies_remaining');
    expect(state).toMatchObject({ providerCalls: 1, noProgressCalls: 1, stopReason: null });
    assertToolPairingWellFormed(state.messages);
  });

  it('preserves owner facts without inventing a domain alternative or a countdown', async () => {
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_submit_findings', inputSchema: z.object({ focus_node_id: z.string() }), effect: 'hop_commit',
      execute: () => JSON.stringify(makeRejection({ code: REJECTION_CODES.routeValidationFailed,
        reason: 'An eligible kept neighbor needs an investigation-purpose question.', errors: at('neighbor_undecided', ['questions']) })) });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: 'sm_ct' }, registry,
      messages: [new HumanMessage('Inspect the current object.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts('ct', ['Value'], { classification: 'technical', memorySections: [] }),
      requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required' });
    let state = initialToolPhaseAttemptState(plan.frame.phase);
    const alternative = 'Retain known facts and a truthful unresolved-issue callout in sections.';
    for (let index = 0; index < MAX_TOOL_PROVIDER_CALLS; index++) {
      const model = nativePort(() => [call(`finding-${index}`, { focus_node_id: 'focus' }, 'lineage_submit_findings')]);
      const attempt = await executeToolAttempt(model.port, plan, { priorState: state });
      expect(JSON.stringify(model.sendRequest.mock.calls)).not.toContain(alternative);
      expect(problemOf(String(toolMessage(attempt.messages).content)).code).toBe(REJECTION_CODES.routeValidationFailed);
      expect(shown(String(toolMessage(attempt.messages).content))).toContainEqual(fault('neighbor_undecided', 'questions'));
      expect(String(toolMessage(attempt.messages).content)).not.toContain('replies_remaining');
      state = recordToolAttempt(state, attempt, 'lineage_submit_findings');
    }
    expect(state).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS, rejectedTerminalCalls: MAX_TOOL_PROVIDER_CALLS });
    expect(state.rejections).toHaveLength(MAX_TOOL_PROVIDER_CALLS);
  });

  it.each([false, true])('states a missing call by its fault on every reply and the last-correction notice only before the last reply (required=%s)', async required => {
    const { registry } = registryWith(() => '{}');
    const base = discoveryPlan(registry);
    const plan = required ? { ...base, input: { ...base.input, requiredTerminalTool: 'lineage_search_objects' } } : base;
    let state = initialToolPhaseAttemptState('discover');
    for (let index = 0; index < MAX_TOOL_PROVIDER_CALLS; index++) {
      const model = nativePort(() => []);
      const attempt = await executeToolAttempt(model.port, plan, { priorState: state });
      const delivered = JSON.stringify(model.sendRequest.mock.calls);
      expect(delivered.includes(LAST_CORRECTION)).toBe(index === MAX_TOOL_PROVIDER_CALLS - 1);
      // No issue code of a missing call carries a fallback, so none is ever delivered.
      for (const issue of Object.values(ISSUES)) if ('fallback' in issue) expect(delivered).not.toContain(issue.fallback);
      state = recordToolAttempt(state, attempt);
    }
    expect(state).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS });
    expect(state.rejections).toHaveLength(MAX_TOOL_PROVIDER_CALLS);
  });

  it('keeps schema correction choices on a rejected report (D-102)', async () => {
    const schema = z.object({ start: z.enum(['B1', 'B2']) });
    const parsed = schema.safeParse({ start: 'Missing' });
    if (parsed.success) throw new Error('Expected invalid block');
    const rejection = rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, schema });
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_present_result', inputSchema: schema, effect: 'presentation_commit',
      execute: () => JSON.stringify(rejection) });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'synthesis' }, registry,
      messages: [new HumanMessage('Present the findings.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts('bb', [], { classification: 'technical', memorySections: [] }) });
    const model = nativePort(() => [call('report', { start: 'Missing' }, 'lineage_present_result')]);
    const first = await executeToolAttempt(model.port, plan, { priorState: initialToolPhaseAttemptState('synthesis') });
    expect(problemOf(String(toolMessage(first.messages).content))).toMatchObject({ code: REJECTION_CODES.invalidInput, resend: [] });
    expect(shown(String(toolMessage(first.messages).content))).toEqual([fault('enum', 'start')]);
    const second = await executeToolAttempt(model.port, plan, {
      priorState: recordToolAttempt(initialToolPhaseAttemptState('synthesis'), first),
    });
    expect(shown(String(toolMessage(second.messages).content))).toContainEqual({ ...fault('enum', 'start'), allowed: ['B1', 'B2'] });
    assertToolPairingWellFormed(second.messages);
  });

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

  it('delivers schema-level column choices for each failed field without diagnostic clipping', async () => {
    const columns = Array.from({ length: 400 }, (_, i) => `Column${i}`);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, {
      outCols: columns, writesTo: false,
    });
    const input = { focus_node_id: 'focus', summary: 'A valid summary.', sections: { technical: 'A long valid finding. '.repeat(5000) },
      column_flow: [{ out_col: 'Missing', upstream_columns: [] }, { out_col: 'AlsoMissing', upstream_columns: [] }] };
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected invalid columns');
    const rejection = rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidInput, input, schema });
    const { registry } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const first = await executeToolAttempt(nativePort(() => [call('first', { query: 'Missing' })]).port, plan, { priorState: state });
    const initialFeedback = JSON.parse(String(toolMessage(first.messages).content));
    for (const path of ['column_flow.0.out_col', 'column_flow.1.out_col'])
      expect(shown(initialFeedback)).toContainEqual(fault('unknown_column', path));
    state = recordToolAttempt(state, first);
    const second = await executeToolAttempt(nativePort(() => [call('second', { query: 'MissingInput' })]).port, plan, { priorState: state });
    const content = String(toolMessage(second.messages).content);
    for (const path of ['column_flow.0.out_col', 'column_flow.1.out_col']) {
      const error = shown(content).find(item => item.path === path);
      expect(error).toMatchObject(fault('unknown_column', path));
      expect([...error!.allowed!, ...Array(error!.more ?? 0)]).toHaveLength(columns.length);
    }
    expect(content).not.toContain(input.sections.technical);
  });

  it.each([3, 400].flatMap(count => ['column', 'neighbor', 'enum'].map(kind => ({ count, kind }))))('delivers faults and guidance first and all $count $kind choices from the second feedback on, without domain inference', async ({ count, kind }) => {
    const columns = Array.from({ length: count }, (_, i) => `VerifiedColumn${i}`);
    const path = kind === 'column' ? 'column_flow.0.upstream_columns.0.col' : kind === 'neighbor' ? 'questions.0.nodeId' : 'query';
    const code: IssueCode = kind === 'enum' ? 'enum' : kind === 'column' ? 'unknown_column' : 'not_neighbor';
    const invalidEnum = z.object({ query: z.enum(columns as [string, ...string[]]) }).safeParse({ query: 'Missing' });
    if (invalidEnum.success) throw new Error('Expected invalid enum');
    const rejection = kind === 'enum' ? rejectionFromZodError(invalidEnum.error, { code: 'invalid_tool_input', input: { query: 'Missing' } })
      : buildRouteValidationRejection([{ kind: kind === 'column' ? 'bad_contributor_col' : 'question_not_neighbor', id: 'Source', path,
        reason: 'The supplied value is not allowed here.',
        allowed_values: columns, ...(kind === 'column' ? { when: { node: 'Source' } } : {}) }]);
    const { registry } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const lines: string[] = [];
    const first = await executeToolAttempt(nativePort(() => [call('first', { query: 'Missing' })]).port, plan,
      { priorState: state, debugLog: line => lines.push(line) });
    const firstFeedback = JSON.parse(String(toolMessage(first.messages).content));
    expect(firstFeedback).not.toHaveProperty('replies_remaining');
    expect(shown(firstFeedback)).toContainEqual(fault(code, path));
    expect(String(toolMessage(first.messages).content)).not.toContain('VerifiedColumn0');
    expect(toolMessage(first.messages).artifact).toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ path })]) });
    expect(String(toolMessage(first.messages).content)).not.toMatch(/Recheck the named column|Rebuild the defective fields|Re-evaluate the proposed action/);
    const outcome = lines.filter(line => line.startsWith('[ToolOutcome]'));
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toContain('phase=discover tool=lineage_search_objects callId=first status=rejected');
    expect(outcome[0]).toContain(`issuePaths=${path}`);
    expect(outcome[0]).not.toContain('query=Missing');
    state = recordToolAttempt(state, first);
    for (const [index, query] of ['StillMissing', 'StillMissing2'].entries()) {
      const next = await executeToolAttempt(nativePort(() => [call(`retry-${index}`, { query })]).port, plan, { priorState: state });
      const content = String(toolMessage(next.messages).content);
      expect(content).not.toContain('replies_remaining');
      const error = shown(content).find(item => item.path === path);
      expect(error).toMatchObject(fault(code, path));
      expect([...error!.allowed!, ...Array(error!.more ?? 0)]).toHaveLength(columns.length);
      expect(content).not.toMatch(/Recheck the named column|Rebuild the defective fields|Re-evaluate the proposed action/);
      if (count === 400 && kind !== 'enum') expect(next.rejections[0].detail).toMatchObject({ omitted: true });
      state = recordToolAttempt(state, next);
    }
    const finalModel = nativePort(() => [call('fourth', { query: 'StillMissing3' })]);
    const fourth = await executeToolAttempt(finalModel.port, plan, { priorState: state });
    expect(JSON.stringify(finalModel.sendRequest.mock.calls)).toContain('VerifiedColumn0');
    expect(recordToolAttempt(state, fourth)).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS });
    expect(recordToolAttempt(state, fourth).rejections).toHaveLength(MAX_TOOL_PROVIDER_CALLS);
  });

  it('retains self-loop facts first and object-qualified owner choices on the last correction', async () => {
    const columns = ['OrderAmount', 'RegionCode', 'Discount'];
    const rejection = buildRouteValidationRejection([{
      kind: 'self_loop_column',
      id: '[ai].[salesstaging]',
      path: 'column_flow.0.upstream_columns.0',
      reason: 'upstream_columns entry "[ai].[salesstaging].OrderAmount" is identical to its own writes_to target "[ai].[salesstaging].OrderAmount" - a column cannot be its own upstream source.',
      allowed_values: columns,
      when: { node: '[ai].[salesstaging]' },
    }]);
    expect(rejection.code).toBe(REJECTION_CODES.columnSelfLoop);
    const { registry } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const first = await executeToolAttempt(nativePort(() => [call('first', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    const firstFeedback = JSON.parse(String(toolMessage(first.messages).content));
    expect(firstFeedback.code).toBe(REJECTION_CODES.columnSelfLoop);
    expect(shown(firstFeedback)).toEqual([fault('self_loop', 'column_flow.0.upstream_columns.0')]);
    for (const absent of ['replies_remaining', 'detail', 'reason', 'hint']) expect(firstFeedback).not.toHaveProperty(absent);
    expect(toolMessage(first.messages).artifact).toMatchObject({ detail: expect.arrayContaining([expect.objectContaining({
      path: 'column_flow.0.upstream_columns.0', allowed_values: columns, when: { node: '[ai].[salesstaging]' },
    })]) });
    state = recordToolAttempt(state, first);
    const second = await executeToolAttempt(nativePort(() => [call('second', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    const content = String(toolMessage(second.messages).content);
    expect(shown(content)).toContainEqual({ ...fault('self_loop', 'column_flow.0.upstream_columns.0'), allowed: [...columns].sort() });
    expect(content).not.toContain('Recheck the named column');
    state = recordToolAttempt(state, second);
    const third = await executeToolAttempt(nativePort(() => [call('third', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    const thirdContent = String(toolMessage(third.messages).content);
    expect(thirdContent).not.toContain('Recheck the named column');
    expect(thirdContent).not.toContain('not a column of');
    expect(third.observations).toEqual([]);
    state = recordToolAttempt(state, third);
    expect(state.stopReason).toBeNull();
    const fourth = await executeToolAttempt(nativePort(() => [call('fourth', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    expect(recordToolAttempt(state, fourth).stopReason).toBe('no_progress');
  });

  it('states a call-level fault by its category instruction, fault label and correction, never by a logs-only reason', async () => {
    const { registry } = registryWith(() => JSON.stringify(makeRejection({ code: 'off_policy', reason: 'LOGS_ONLY_REASON', errors: at('off_policy') })));
    const model = nativePort(() => [call('c1', { query: 'Orders' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry), { priorState: initialToolPhaseAttemptState('discover') });
    const content = String(toolMessage(attempt.messages).content);
    expect(JSON.parse(content)).toEqual({ code: 'off_policy', attempt: '1/3', resend: [],
      guidance: [{ category: 'stage', instruction: ISSUE_CATEGORIES.stage.short, errors: [fault('off_policy')] }] });
  });

  it('refuses a rejection without a fault at its producer, so the model is never answered with nothing', () => {
    expect(() => makeRejection({ code: 'unlisted_fault', errors: [] })).toThrow('at least one error');
  });

  it('states a reference fault of the call by its issue-code label and correction', async () => {
    const { registry } = registryWith(() => JSON.stringify(makeRejection({ code: 'not_found', errors: at('not_found') })));
    const model = nativePort(() => [call('c1', { query: 'Orders' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    expect(shown(String(toolMessage(attempt.messages).content))).toEqual([fault('not_found')]);
  });

  it('an unchanged resend of a rejected call is named as such; a changed call is not', async () => {
    const { registry } = registryWith(() => JSON.stringify(makeRejection({ code: 'not_found', reason: 'No object matches.', errors: at('not_found') })));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const first = await executeToolAttempt(nativePort(() => [call('c1', { query: 'Orders' })]).port, plan, { priorState: state });
    expect(String(toolMessage(first.messages).content)).not.toContain(ISSUES.identical_resend.label);
    state = recordToolAttempt(state, first);
    const same = await executeToolAttempt(nativePort(() => [call('c2', { query: 'Orders' })]).port, plan, { priorState: state });
    expect(String(toolMessage(same.messages).content)).toContain(ISSUES.identical_resend.label);
    expect(toolMessage(same.messages).artifact).toMatchObject({ code: 'not_found', reason: 'No object matches.' });
    const changed = await executeToolAttempt(nativePort(() => [call('c3', { query: 'Sales' })]).port, plan, { priorState: recordToolAttempt(state, same) });
    expect(String(toolMessage(changed.messages).content)).not.toContain(ISSUES.identical_resend.label);
  });

  it('an unchanged resend of a schema-rejected call is named as such too', async () => {
    const { registry } = registryWith(() => '{}');
    const plan = discoveryPlan(registry);
    const first = await executeToolAttempt(nativePort(() => [call('c1', { query: '' , extra: 1 })]).port, plan, { priorState: initialToolPhaseAttemptState('discover') });
    const state = recordToolAttempt(initialToolPhaseAttemptState('discover'), first);
    const same = await executeToolAttempt(nativePort(() => [call('c2', { extra: 1, query: '' })]).port, plan, { priorState: state });
    expect(String(toolMessage(same.messages).content)).toContain(ISSUES.identical_resend.label);
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
        expect(String(result.content)).toContain(ISSUES.result_too_large.correction);
      }
      state = { ...recordToolAttempt(state, attempt), messages: [] };
    }
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ noProgressCalls: MAX_TOOL_PROVIDER_CALLS, stopReason: 'no_progress' });
  });
});


describe('missing-content exchange progress', () => {
  const held = (beforeReply: () => void | Promise<void> = () => {}) => {
    const node = makeNode({ id: '[dbo].[Report]', schema: 'dbo', name: 'Report', type: 'view', bodyScript: 'SELECT 1 AS Value;' });
    const model = makeIndexedModel([node], []);
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.model = model;
    session.classification = 'technical';
    const engine = new NavigationEngine(model, makeGraph([node], []), () => {}, { memory: session.memory });
    session.stateMachine = engine;
    expect(engine.init({ origin: node.id, question: 'Explain Report.', direction: 'upstream', analysisMode: 'bb', depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.classification = 'technical';
    engine.getHopContext();
    const services = { getSession: () => session, turnEpoch: () => epoch, requireModel: () => model,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      logAndReturn: (_name: string, data: object) => JSON.stringify(data),
      toolError: (_name: string, error: unknown) => { throw error; },
    } as unknown as ToolServices;
    const initialInput = { focus_node_id: node.id, summary: 'Report returns a constant Value.' };
    const rejected = executeSubmitFindings(initialInput, services);
    const feedback = JSON.parse(rejected);
    expect(feedback.missingParts).toEqual(['sections']);
    expect(engine.heldFindingFocus).toBe(node.id);
    const registry = new ToolRegistry<string>();
    const schema = submitFindingsSchemaForMode('bb', 'technical', false, undefined, false);
    const invoke = vi.fn(async (input: unknown) => {
      await beforeReply();
      return executeSubmitFindings(input, services);
    });
    registry.register({ name: 'lineage_submit_findings', inputSchema: schema, effect: 'hop_commit', execute: invoke });
    let completed = false;
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: 'sm_bb' }, registry,
      messages: [new HumanMessage('Explain Report.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts('bb', [], { classification: 'technical', memorySections: [] }),
      freshSubmission: () => engine.heldFindingFocus === null && session.memory.getArchivedAngles(node.id).size === 0,
      hopColumns: () => engine.hopSubmitColumns, heldColumnFlow: () => engine.heldColumnFlow,
      requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required',
      onToolResult: (_name, _input, isError) => { if (!isError) completed = true; }, isPhaseComplete: () => completed,
    });
    const state = { ...initialToolPhaseAttemptState('active'), providerCalls: 1, noProgressCalls: 1,
      rejections: [{ callId: 'missing', toolName: 'lineage_submit_findings', ...feedback }],
      messages: [new AIMessage({ content: '', tool_calls: [{ id: 'missing', name: 'lineage_submit_findings', args: initialInput }] }),
        new ToolMessage({ content: rejected, tool_call_id: 'missing', name: 'lineage_submit_findings', status: 'error', artifact: feedback })],
    };
    return { state, plan, invoke, engine, session, schema, reply: { focus_node_id: node.id, sections: { technical: 'Value is the SQL literal 1.' } } };
  };

  it.each([false, true])('keeps a narrow completion hidden and preserves the draft through a malformed broad repair (broad=%s)', async broad => {
    const events: unknown[] = [];
    const { plan, state, invoke, reply, engine, session, schema } = held();
    const before = engine.toJSON();
    let attemptState: ToolPhaseAttemptState = state;
    const observedPlan = { ...plan, input: { ...plan.input, sink: new TurnEventSink(event => events.push(event)) } };
    const log: string[] = [];
    if (broad) {
      const malformedArgs = { focus_node_id: reply.focus_node_id, sections: '{"technical":"unterminated' };
      expect(schema.safeParse(malformedArgs).success).toBe(false);
      const malformed = await executeToolAttempt(nativePort(() => [call('malformed-section', malformedArgs, 'lineage_submit_findings')]).port,
        observedPlan, { priorState: attemptState, debugLog: line => log.push(line) });
      expect(malformed.rejections).toEqual([expect.objectContaining({ code: REJECTION_CODES.invalidInput, issuePaths: ['sections'] })]);
      expect(toolMessage(malformed.messages)).toMatchObject({ status: 'error', tool_call_id: 'malformed-section' });
      expect(engine.toJSON()).toMatchObject({ visited: before.visited, agenda: before.agenda,
        engineInternals: { heldFinding: { finding: { summary: 'Report returns a constant Value.' } } } });
      expect(session.memory.getShortTermMemory()).toEqual([]);
      attemptState = recordToolAttempt(state, malformed, 'lineage_submit_findings');
      expect(attemptState).toMatchObject({ providerCalls: 2, stopReason: null });
      assertToolPairingWellFormed(attemptState.messages);
    }
    const args = reply;
    expect(schema.safeParse(args).success).toBe(true);
    const model = nativePort(() => [call('reply', args, 'lineage_submit_findings')]);
    const result = await executeToolAttempt(model.port, observedPlan, { priorState: attemptState, debugLog: line => log.push(line) });
    expect(invoke).toHaveBeenCalledTimes(broad ? 2 : 1);
    expect(invoke).toHaveBeenLastCalledWith(args);
    expect(result.rejections).toEqual([]);
    expect(toolMessage(result.messages)).toMatchObject({ status: 'success', tool_call_id: 'reply' });
    expect(session.memory.getShortTermMemory()).toEqual([expect.objectContaining({
      summary: 'Report returns a constant Value.',
    })]);
    expect(events.some(event => (event as { type: string }).type === 'status')).toBe(broad);
    expect(log).toEqual(expect.arrayContaining([expect.stringContaining(`classification=${broad ? 'retry' : 'clarification'}`)]));
    expect(state.noProgressCalls).toBe(1);
  });

  it('does not hide an exchange with an intervening read as a narrow first clarification', async () => {
    const events: unknown[] = [];
    const { plan, state, reply } = held();
    state.messages.push(new AIMessage({ content: '', tool_calls: [{ id: 'intervening', name: 'lineage_search_objects', args: { query: 'Other' } }] }),
      new ToolMessage({ content: '{}', tool_call_id: 'intervening', name: 'lineage_search_objects' }));
    const model = nativePort(() => [call('reply', reply, 'lineage_submit_findings')]);
    await executeToolAttempt(model.port, { ...plan, input: { ...plan.input, sink: new TurnEventSink(event => events.push(event)) } }, { priorState: state });
    expect(events.some(event => (event as { type: string }).type === 'status')).toBe(true);
  });

  it.each(['slow', 'backend_slow', 'cancelled', 'error'] as const)('cleans the pending timer when a completion is %s', async outcome => {
    vi.useFakeTimers();
    try {
      const events: unknown[] = [];
      const controller = new AbortController();
      let release!: () => void;
      const paused = new Promise<void>(resolve => { release = resolve; });
      const { plan, state, reply } = held(async () => {
        if (outcome === 'backend_slow') await paused;
      });
      const model = nativePort(() => []);
      model.sendRequest.mockImplementation(async () => ({ stream: { async *[Symbol.asyncIterator]() {
        if (outcome !== 'backend_slow') await paused;
        if (outcome === 'error') throw new Error('Synthetic provider failure.');
        yield call('reply', reply, 'lineage_submit_findings');
      } } }));
      const running = executeToolAttempt(model.port, { ...plan, input: { ...plan.input, signal: controller.signal,
        sink: new TurnEventSink(event => events.push(event)) } }, { priorState: state });
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === 'cancelled') controller.abort();
      if (outcome === 'slow' || outcome === 'backend_slow') await vi.advanceTimersByTimeAsync(CLARIFICATION_WINDOW_MS + 1);
      release();
      await running;
      expect(events.some(event => (event as { type: string }).type === 'status')).toBe(outcome === 'slow' || outcome === 'backend_slow');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('submit_findings rejection form', () => {
  const root = '[d].[Root]', source = '[d].[Source]', other = '[d].[Other]', absent = '[d].[Absent]';
  const col = (name: string) => ({ name, type: 'int', nullable: 'NOT NULL', extra: '' });
  const sourceColumns = Array.from({ length: 10 }, (_, index) => `C${index}`);
  const base = { focus_node_id: root, summary: 'Root reads constants.', sections: { technical: 'Both outputs are constants.' } };
  const terminals = [{ out_col: 'Value', upstream_columns: [] }, { out_col: 'Other', upstream_columns: [] }];
  const missingColumn = [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'Missing' }] }, terminals[1]];
  const paths = (rejection: { errors: Array<{ path: string }> }) => rejection.errors.map(error => error.path);

  /** A BB/CT hop with two neighbors, driven through the real dispatcher so each step reads what the model reads. */
  function hop(mode: 'bb' | 'ct' = 'ct', classification: 'business' | 'technical' | 'both' = 'technical') {
    const nodes = [root, source, other].map(id => makeNode({ id, schema: 'd', name: id, type: 'view', bodyScript: 'SELECT 1 AS Value, 2 AS Other;',
      columns: (id === source ? sourceColumns : ['Value', 'Other']).map(col) }));
    const pairs: [string, string][] = [[source, root], [other, root]];
    const indexed = makeIndexedModel(nodes, pairs), graph = makeGraph(nodes, pairs);
    const session = new AiSession();
    session.model = indexed;
    session.graph = graph;
    session.setClassification(classification);
    session.beginTurn();
    const engine = new NavigationEngine(indexed, graph, () => {}, { memory: session.memory });
    engine.classification = classification;
    expect(engine.init({ origin: root, question: 'Trace Value and Other.', analysisMode: mode, ...(mode === 'ct' ? { targetColumns: ['Value', 'Other'] } : {}),
      direction: 'upstream', depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    session.stateMachine = engine;
    session.enterExploring(session.turnEpoch);
    const { services } = stubToolServices({ session, model: indexed, graph, turnEpoch: () => session.turnEpoch });
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_submit_findings', inputSchema: submitFindingsSchemaForMode(mode, classification, true, engine.hopSubmitColumns, false),
      effect: 'hop_commit', execute: (sent: unknown) => executeSubmitFindings(sent, services) });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: mode === 'ct' ? 'sm_ct' : 'sm_bb' }, registry,
      messages: [new HumanMessage('Inspect Root.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts(mode, mode === 'ct' ? ['Value', 'Other'] : [], { classification, memorySections: [] }),
      freshSubmission: () => engine.heldFindingFocus === null && session.memory.getArchivedAngles(root).size === 0,
      hopColumns: () => engine.hopSubmitColumns, heldColumnFlow: () => engine.heldColumnFlow,
      requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required' });
    let state = initialToolPhaseAttemptState(plan.frame.phase);
    const send = async (input: unknown) => {
      const lines: string[] = [];
      const attempt = await executeToolAttempt(nativePort(() => [call(`c${state.providerCalls}`, input, 'lineage_submit_findings')]).port, plan, { priorState: state, debugLog: line => lines.push(line) });
      state = recordToolAttempt(state, attempt, 'lineage_submit_findings');
      const content = String(toolMessage(attempt.messages).content);
      const problem = attempt.rejections.length ? problemOf(content) : undefined;
      return { attempt, content, lines, rejection: problem ? { ...problem, errors: shown(problem) } : undefined };
    };
    return { engine, send, state: () => state };
  }


  it.each((['bb', 'ct'] as const).flatMap(mode => (['business', 'technical', 'both'] as const).map(classification => ({ mode, classification }))))(
    'generates $mode/$classification native repairs from served metadata', async ({ mode, classification }) => {
      const angles = classification === 'both' ? ['business', 'technical'] : [classification];
      const complete = { summary: base.summary, badge_label: 'Source role',
        sections: Object.fromEntries(angles.map(angle => [angle, `${angle}: exact authored findings.`])),
        ...(mode === 'ct' ? { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0', transforms: ['pass_through'], note: 'Declared source.' }] }, terminals[1]] } : {}),
        questions: [{ nodeId: source, question: 'Explain this supplied neighbor.' }],
        prune_neighbors: [{ id: other, reason: 'No requested contribution.' }] };
      const fixture = hop(mode, classification);
      const schema = submitFindingsSchemaForMode(mode, classification, true, fixture.engine.hopSubmitColumns);
      const wire = toModelJsonSchema(schema);
      const columns = new Map([[root, ['Value', 'Other']], [source, sourceColumns], [other, ['Value', 'Other']]]);
      const faults = schemaFaults(wire, complete, [], columns);
      // Body/header binding has separate owner tests; only provided fixture fields are mutated.
      const unique = (rows: readonly SchemaFault[]) => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()];
      const rank = ['required', 'type', 'minLength', 'pattern', 'maxLength', 'enum', 'unknown', 'metadata-column'];
      const selected = [...new Map([...faults].sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind))
        .map(row => [row.path.join('.'), row])).values()].filter(row => !faults.some(other => other.path.length > row.path.length
          && row.path.every((part, index) => other.path[index] === part)));
      const bundledSeed = structuredClone(complete) as Record<string, unknown>;
      const bundled = selected.map(row => {
        // Keep known-column truth readable beside an independently invalid supplier identity.
        if (row.kind === 'enum' && row.path.at(-1) === 'node' && selected.some(other => other.kind === 'metadata-column'
          && other.path.slice(0, -1).join('.') === row.path.slice(0, -1).join('.'))) {
          const flow = bundledSeed.column_flow as unknown[];
          const index = flow.length;
          flow.push(structuredClone(flow[0]));
          return { ...row, path: [row.path[0]!, index, ...row.path.slice(2)] };
        }
        return row;
      });
      const groups = [...new Set(bundled.map(row => String(row.path[0])))].map(field => bundled.filter(row => row.path[0] === field));
      const scenarios = [
        ...unique(faults).map((fault, index) => ({ id: `single-${index}`, seed: complete, faults: [fault], escalate: false })),
        ...Array.from({ length: (1 << groups.length) - 1 }, (_, index) => ({ id: `fields-${index + 1}`, seed: groups.some((group, bit) => ((index + 1) & (1 << bit)) && group[0]!.path[0] === 'column_flow') ? bundledSeed : complete,
          faults: groups.filter((_group, bit) => (index + 1) & (1 << bit)).flat(), escalate: index + 1 === (1 << groups.length) - 1 })),
      ];
      for (const scenario of scenarios) {
        const initial = withSchemaFaults(scenario.seed, scenario.faults);
        const fields = [...new Set(scenario.faults.map(fault => String(fault.path[0])))];
        const bodies = initial.sections as Record<string, unknown> | null;
        const missingAngles = angles.filter(angle => !bodies || typeof bodies[angle] !== 'string' || !(bodies[angle] as string).trim());
        const emptyBodies = fields.includes('sections') && (!bodies || !angles.some(angle => Object.hasOwn(bodies, angle)));
        const expected = [...new Set([...scenario.faults.filter(fault => !(emptyBodies && fault.path[0] === 'sections')).map(fault => fault.path.join('.')),
          ...(emptyBodies || (missingAngles.length === angles.length && angles.some(angle => bodies && Object.hasOwn(bodies, angle) && typeof bodies[angle] !== 'string')) ? ['sections'] : [])])];
        const correction = Object.fromEntries(fields.filter(field => Object.hasOwn(complete, field) && (field !== 'sections' || missingAngles.length))
          .map(field => [field, field === 'sections' ? Object.fromEntries(missingAngles.map(angle => [angle, complete.sections[angle]]))
            : complete[field as keyof typeof complete]]));
        for (const arm of scenario.escalate ? ['first_resend_success', 'legal_final_exit', 'continued_wrong'] : ['first_resend_success']) {
          const { engine, send, state } = hop(mode, classification);
          const sendCaptured = async (payload: unknown, ordinal: number) => {
            const result = await send(payload);
            const target = process.env.DLV_REJECTION_MATRIX_OUTPUT;
            if (target) appendFileSync(target, JSON.stringify({ caseId: `${mode}-${classification}-${scenario.id}`, mode, classification, phase: 'active', arm,
              generatedFaults: scenario.faults, metadataSource: 'toModelJsonSchema(actual served schema) + declared fixture columns',
              attemptOrdinal: ordinal, submittedPayload: payload, expectedResendFields: Object.keys(correction), modelVisibleFeedback: result.content,
              resendFields: result.rejection?.resend ?? [], faults: result.rejection?.errors ?? [],
              heldSentinels: engine.toJSON().engineInternals.heldFinding?.finding ?? null,
              outcome: state().stopReason ?? result.attempt.stop, providerCalls: state().providerCalls }) + '\n');
            return result;
          };
          const first = await sendCaptured(initial, 1);
          expect([...new Set(paths(first.rejection))].sort(), scenario.id).toEqual(expected.sort());
          for (const error of first.rejection.errors) expect(error).not.toHaveProperty('allowed');
          expect(first.rejection).not.toHaveProperty('example');
          expect(engine.getDetailSlots()).toEqual([]);
          const projected = toModelJsonSchema(submitFindingsSchemaForMode(mode, classification, false,
            engine.hopSubmitColumns, engine.heldColumnFlow)) as any;
          for (const field of Object.keys(complete))
            expect(projected.properties[field], `${scenario.id}: D-098 keeps held ${field} in the full schema`).toBeDefined();
          if (arm !== 'first_resend_success') {
            const second = await sendCaptured(initial, 2);
            expect(second.attempt.rejections).toHaveLength(1);
            // D-099: feedback 2 names the same faults (the root '' error is the identical-resend note).
            expect([...new Set(paths(second.rejection).filter(Boolean))].sort(), scenario.id).toEqual(expected.sort());
          }
          if (arm === 'continued_wrong') await sendCaptured(initial, 3);
          const final = await sendCaptured(arm === 'continued_wrong' ? initial : correction, arm === 'first_resend_success' ? 2 : arm === 'legal_final_exit' ? 3 : 4);
          if (arm === 'continued_wrong') {
            expect(state()).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS, noProgressCalls: MAX_TOOL_PROVIDER_CALLS });
            expect(engine.getDetailSlots()).toEqual([]);
          } else {
            expect(final.attempt.rejections).toEqual([]);
            expect(final.attempt.stop).toBe('phase_complete');
            expect(state().providerCalls).toBe(arm === 'first_resend_success' ? 2 : 3);
            expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ summary: complete.summary,
              sections: expect.arrayContaining(angles.map(angle => ({ angle, text: complete.sections[angle] }))) }));
            expect(engine.getDetailSlots()[0]!.sections).toHaveLength(angles.length);
            expect(engine.getDetailSlots()[0]!.badge_label).toBe(complete.badge_label);
            if (mode === 'ct') {
              const edges = engine.columnAspect!.edges.map(edge => [edge.from_node, edge.from_col, edge.to_node, edge.to_col]);
              expect(edges).toHaveLength(1);
              expect(engine.columnAspect!.edges[0]).toMatchObject({ transforms: ['pass_through'], note: 'Declared source.' });
              expect([...new Set(edges.map(edge => JSON.stringify(edge)))]).toEqual([JSON.stringify([source, 'C0', root, 'Value'])]);
            }
          }
        }
      }
    },
  );

  it.each(['repair', 'continued_wrong'] as const)('keeps the three-correction budget when a retry introduces a new fault: %s', async arm => {
    const { engine, send, state } = hop();
    const initial = { ...base, badge_label: 'x'.repeat(51), column_flow: terminals,
      questions: [source, other].map(nodeId => ({ nodeId, question: 'Explain this supplied neighbor.' })) };
    const steps = [initial, { badge_label: 'Source role', summary: 42 },
      ...(arm === 'repair' ? [{ badge_label: 'Source role' }]
        : [{ sections: { technical: 42 } }, { sections: { technical: 43 } }])];
    const expectedPaths = [['badge_label'], ['summary'], ...(arm === 'repair' ? [[]] : [['sections.technical'], ['sections.technical']])];
    for (const [index, input] of steps.entries()) {
      const result = await send(input);
      expect(result.rejection ? paths(result.rejection) : []).toEqual(expectedPaths[index]);
      expect(state().providerCalls).toBe(index + 1);
      if (index < steps.length - 1) expect(state().noProgressCalls).toBe(index + 1);
      const target = process.env.DLV_REJECTION_CONTROL_OUTPUT;
      if (target) appendFileSync(target, JSON.stringify({ caseId: `ct-new-faults-${arm}`, arm,
        mode: 'ct', classification: 'technical', phase: 'active', attemptOrdinal: index + 1,
        declaredFaults: ['badge bound', 'new summary type', ...(arm === 'continued_wrong' ? ['new section type'] : [])],
        modelVisibleFeedback: result.content, resendFields: result.rejection?.resend ?? [],
        faults: result.rejection?.errors ?? [], submittedFields: Object.keys(input),
        heldSentinels: engine.toJSON().engineInternals.heldFinding?.finding ?? null,
        outcome: state().stopReason ?? result.attempt.stop, providerCalls: state().providerCalls,
      }) + '\n');
    }
    if (arm === 'repair') expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({
      summary: base.summary, sections: [{ angle: 'technical', text: base.sections.technical }],
    }));
    else {
      expect(state()).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS, noProgressCalls: MAX_TOOL_PROVIDER_CALLS });
      expect(engine.getDetailSlots()).toEqual([]);
    }
  });

  it('accepts a lossless structured-text representation without spending a rejection', async () => {
    const { engine, send, state } = hop();
    const flow = [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0' }] }, terminals[1]];
    const input = { ...base, column_flow: JSON.stringify(flow),
      questions: [source, other].map(nodeId => ({ nodeId, question: 'Explain this supplied neighbor.' })) };
    const before = structuredClone(input);
    const result = await send(input);
    expect(result.attempt.rejections).toEqual([]);
    expect(result.attempt.stop).toBe('phase_complete');
    expect(state()).toMatchObject({ providerCalls: 1, rejections: [] });
    expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ summary: base.summary,
      sections: [{ angle: 'technical', text: base.sections.technical }] }));
    expect(input).toEqual(before);
    const target = process.env.DLV_REJECTION_CONTROL_OUTPUT;
    if (target) appendFileSync(target, JSON.stringify({ caseId: 'ct-normalized-no-rejection', mode: 'ct',
      classification: 'technical', phase: 'active', attemptOrdinal: 1, normalizedRepresentation: true,
      modelVisibleFeedback: result.content, faults: [], resendFields: [], submittedFields: Object.keys(input),
      outcome: result.attempt.stop, providerCalls: state().providerCalls, rejections: 0,
    }) + '\n');
  });


  it('holds a normalized real form field while one resend corrects all other mistyped fields', async () => {
    const { engine, send, state } = hop();
    const flow = [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0' }] }, terminals[1]];
    const input = { ...base, summary: null, badge_label: 42, column_flow: JSON.stringify(flow),
      questions: [source, other].map(nodeId => ({ nodeId, question: 'Explain this supplied neighbor.' })) };
    const before = structuredClone(input);
    const first = await send(input);
    expect(paths(first.rejection).sort()).toEqual(['badge_label', 'summary']);
    expect(first.rejection.resend.sort()).toEqual(['badge_label', 'summary']);
    expect(first.rejection.errors).toEqual(expect.arrayContaining([fault('type', 'summary'), fault('type', 'badge_label')]));
    for (const error of first.rejection.errors) expect(Object.keys(error).sort()).toEqual(['correction', 'fault', 'path']);
    const held = engine.toJSON().engineInternals.heldFinding?.finding;
    expect(held?.column_flow).toEqual(flow);
    expect(held?.sections).toEqual([{ angle: 'technical', text: base.sections.technical }]);
    expect(engine.getDetailSlots()).toEqual([]);
    const correction = { summary: 'Corrected authored summary.', badge_label: 'Source role' };
    const second = await send(correction);
    expect(second.attempt.rejections).toEqual([]);
    expect(second.attempt.stop).toBe('phase_complete');
    expect(state().providerCalls).toBe(2);
    expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: source, from_col: 'C0', to_node: root, to_col: 'Value' }));
    expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ summary: correction.summary,
      sections: [{ angle: 'technical', text: base.sections.technical }] }));
    expect(input).toEqual(before);
  });

  it.each(['keep-mapping', 'replace-mapping'] as const)('accepts the first atomic conflict repair by %s', async correction => {
    const { engine, send } = hop();
    const flow = [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0' }] }, terminals[1]];
    const prune = [{ id: source, reason: 'Outside the asked value path.' }];
    const first = await send({ ...base, column_flow: flow, questions: [{ nodeId: other, question: 'Explain Other.' }], prune_neighbors: prune });
    expect(first.attempt.rejections).toHaveLength(1);
    expect(engine.columnAspect?.edges).toEqual([]);
    expect(engine.getDetailSlots()).toEqual([]);
    const correctionInput = correction === 'keep-mapping' ? { prune_neighbors: [] } : { column_flow: terminals, prune_neighbors: prune };
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(schema.safeParse(correctionInput).success, 'the served repair schema must admit the complete joint replacement').toBe(true);
    const accepted = await send(correctionInput);
    expect(accepted.attempt.rejections).toEqual([]);
    expect(accepted.attempt.stop).toBe('phase_complete');
    expect(engine.toJSON().removedSet.includes(source)).toBe(correction === 'replace-mapping');
    expect(engine.columnAspect?.edges.some(edge => edge.from_node === source)).toBe(correction === 'keep-mapping');
    expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ summary: base.summary, sections: [{ angle: 'technical', text: base.sections.technical }] }));
  });

  it.each(['map', 'prune', 'question'] as const)('repairs a missing neighbor outcome by %s through the served handler with held findings', async outcome => {
    const { engine, send } = hop();
    const before = engine.toJSON();
    const flow = [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0' }] }, terminals[1]];
    const first = await send({ ...base, column_flow: flow });
    expect(first.attempt.rejections).toHaveLength(1);
    expect(JSON.stringify(first.rejection)).toContain(other);
    expect(first.rejection.resend).toEqual(['questions', 'prune_neighbors', 'column_flow']);
    expect(first.rejection.errors).toContainEqual({ ...fault('neighbor_undecided'), missing: [other] });
    expect(first.rejection).not.toHaveProperty('way_out');
    expect(first.rejection).not.toHaveProperty('example');
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.getDetailSlots()).toEqual([]);
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ summary: true, sections: ['technical'], resend: ['questions', 'prune_neighbors', 'column_flow'] });
    const patch = outcome === 'map' ? { column_flow: [...flow, { out_col: 'Other', upstream_columns: [{ node: other, col: 'Value' }] }] }
      : outcome === 'prune' ? { prune_neighbors: [{ id: other, reason: 'No value contribution.' }] }
      : { questions: [{ nodeId: other, question: 'Explain the neighboring SQL.' }] };
    const second = await send({ focus_node_id: root, ...patch });
    expect(second.attempt.rejections).toEqual([]);
    expect(second.attempt.stop).toBe('phase_complete');
    expect(engine.columnAspect?.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from_node: source, to_node: root })]));
    expect(engine.getDetailSlots()).toEqual(expect.arrayContaining([expect.objectContaining({ summary: base.summary })]));
    expect(engine.toJSON().removedSet.includes(other)).toBe(outcome === 'prune');
  });

  it('reports every independently decidable fault first, reserving accepted values for the second rejection', async () => {
    const { send } = hop();
    const first = await send({ ...base, column_flow: [
      { out_col: 'Value', upstream_columns: [{ node: absent, col: 'C0' }, { node: source, col: 'Missing' }] },
      { out_col: 'Other', upstream_columns: [{ node: source, col: 'C1', transforms: ['bogus'] }], writes_to: { node: source, col: 'C0' } },
    ] });
    expect(first.attempt.rejections).toHaveLength(1);
    const expected = ['column_flow.0.upstream_columns.0.node', 'column_flow.0.upstream_columns.1.col',
      'column_flow.1.upstream_columns.0.transforms.0', 'column_flow.1.writes_to'];
    expect(paths(first.rejection).sort()).toEqual(expected);
    expect(first.rejection.resend).toEqual(['column_flow']);
    const at = (path: string) => first.rejection.errors.find((error: { path: string }) => error.path === path);
    for (const path of expected) expect(Object.keys(at(path)).sort()).toEqual(['correction', 'fault', 'path']);
    for (const absentKey of ['replies_remaining', 'example', 'way_out', 'reason', 'hint', 'detail']) expect(first.rejection).not.toHaveProperty(absentKey);
  });

  it('keeps a partial correction: the held draft advances and only the remaining fault is owed', async () => {
    const { engine, send } = hop();
    const first = await send({ ...base, badge_label: 'x'.repeat(51), questions: [{ nodeId: absent, question: 'Explain Absent.' }],
      prune_neighbors: [{ id: absent, reason: 'Outside.' }], column_flow: missingColumn });
    expect(paths(first.rejection).sort()).toEqual(['badge_label', 'column_flow.0.upstream_columns.0.col', 'prune_neighbors.0.id', 'questions.0.nodeId']);
    expect([...first.rejection.resend].sort()).toEqual(['badge_label', 'column_flow', 'prune_neighbors', 'questions']);
    const second = await send({ focus_node_id: root, badge_label: 'Source role', questions: [source, other].map(nodeId => ({ nodeId, question: 'Explain this neighboring SQL.' })), prune_neighbors: [], column_flow: missingColumn });
    expect(second.attempt.rejections).toHaveLength(1);
    expect(paths(second.rejection)).toEqual(['column_flow.0.upstream_columns.0.col']);
    expect(second.rejection.resend).toEqual(['column_flow']);
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ summary: true, sections: ['technical'], resend: ['column_flow'],
      fields: expect.arrayContaining(['badge_label', 'questions', 'prune_neighbors']) });
    // Feedback 2 carries the complete allowed list; the leave-out instruction waits for feedback 3 (D-105).
    expect(second.rejection.errors[0].allowed).toEqual(sourceColumns);
    for (const rejection of [first.rejection, second.rejection]) for (const group of rejection.guidance) expect(group).not.toHaveProperty('fallback');
    const third = await send({ focus_node_id: root, column_flow: [] });
    expect(third.attempt.stop).toBe('phase_complete');
    expect(third.content).toContain('ended_columns');
    expect(third.content).not.toContain('Missing');
  });

  it('a fault a valid value can correct carries no fallback at any reply, and reply 3 carries the last-correction notice (D-105)', async () => {
    const { send } = hop();
    const replies = [];
    for (let n = 1; n <= 3; n++) replies.push(await send({ ...base, column_flow: missingColumn }));
    const leaf = 'column_flow.0.upstream_columns.0.col';
    for (const [index, reply] of replies.entries()) {
      const error = reply.rejection!.errors.find(item => item.path === leaf);
      expect(error).toBeDefined();
      expect(error).toMatchObject(fault('unknown_column', leaf));
      expect(reply.rejection!.guidance.some(group => group.fallback !== undefined)).toBe(false);
      expect(reply.rejection!.notice).toBe(index === 2 ? LAST_CORRECTION : undefined);
      expect(reply.lines.filter(line => line.startsWith('[ToolOutcome]') && line.includes(' fallback=true'))).toHaveLength(0);
    }
  });

  it('feedback 3 on a prune decision has no fallback, and a schema-valid empty correction is accepted while all mapped facts are held', async () => {
    const { engine, send } = hop();
    const flow = [
      { out_col: 'Value', upstream_columns: [{ node: source, col: 'C0' }] },
      { out_col: 'Other', upstream_columns: [{ node: other, col: 'Value' }] },
    ];
    const invalidPrune = [{ id: absent, reason: 'Outside.' }];
    await send({ ...base, column_flow: flow, prune_neighbors: invalidPrune });
    const second = await send({ focus_node_id: root, prune_neighbors: invalidPrune });
    expect(second.rejection.resend).toEqual(['prune_neighbors']);
    expect(second.rejection.errors).toEqual([{ ...fault('not_neighbor', 'prune_neighbors.0.id'), allowed: [source, other].sort() }]);
    expect(second.rejection.guidance.some(group => group.fallback !== undefined)).toBe(false);
    const third = await send({ focus_node_id: root, prune_neighbors: [{ id: absent, reason: 'Still outside.' }] });
    expect(third.rejection.errors).toEqual([{ ...fault('not_neighbor', 'prune_neighbors.0.id'), allowed: [source, other].sort() }]);
    expect(third.rejection.guidance.some(group => group.fallback !== undefined)).toBe(false);
    const exit = { prune_neighbors: [] };
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldColumnFlow);
    expect(schema.safeParse({ focus_node_id: root, ...exit }).success).toBe(true);
    const held = structuredClone(engine.toJSON().engineInternals.heldFinding?.finding);
    const fourth = await send({ focus_node_id: root, ...exit });
    expect(fourth.attempt.stop).toBe('phase_complete');
    expect(engine.columnAspect?.edges).toHaveLength(2);
    expect(engine.columnAspect?.edges).toEqual(expect.arrayContaining(flow.map(entry =>
      expect.objectContaining({ from_node: entry.upstream_columns[0].node, from_col: entry.upstream_columns[0].col, to_node: root, to_col: entry.out_col }))));
    expect(engine.getDetailSlots()).toEqual(expect.arrayContaining([expect.objectContaining({ sections: held?.sections })]));
  });
  it('withdraws an omitted failing optional field and names it in the acknowledgement', async () => {
    const { engine, send } = hop();
    const first = await send({ ...base, column_flow: terminals, questions: [source, other].map(nodeId => ({ nodeId, question: 'Explain this neighboring SQL.' })), prune_neighbors: [{ id: absent, reason: 'Outside.' }] });
    expect(first.rejection.resend).toEqual(['prune_neighbors']);
    const second = await send({ focus_node_id: root });
    expect(second.attempt.stop).toBe('phase_complete');
    expect(second.content).toContain('"withdrawn":["prune_neighbors"]');
    expect(engine.toJSON().removedSet).toEqual([]);
  });

  it('validates a changed resent effect whole and keeps its held valid copy when it fails (D-098)', async () => {
    const { engine, send } = hop();
    const held = [{ id: other, reason: 'Supplies no tracked value.' }];
    await send({ ...base, prune_neighbors: held, column_flow: missingColumn });
    // Pruning Source conflicts with the mapping that keeps it; the held prune of Other must survive.
    const second = await send({ focus_node_id: root, prune_neighbors: [{ id: source, reason: 'Outside.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0' }] }, terminals[1]] });
    // The resent list replaces the held one whole, so Other loses its outcome and both faults are reported together.
    expect(paths(second.rejection).sort()).toEqual(['', 'prune_neighbors.0.id']);
    expect(second.rejection.errors).toContainEqual({ ...fault('neighbor_undecided'), missing: [other] });
    expect(second.rejection.resend).toEqual(['prune_neighbors', 'column_flow', 'questions']);
    expect(engine.toJSON().engineInternals.heldFinding?.finding.prune_neighbors).toEqual(held);
    const third = await send({ focus_node_id: root, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0' }] }, terminals[1]] });
    expect(third.attempt.stop).toBe('phase_complete');
    expect(engine.toJSON().removedSet).toEqual([other]);
  });
});
