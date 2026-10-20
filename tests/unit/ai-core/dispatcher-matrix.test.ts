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
  type ToolPhaseAttemptState,
} from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ToolRegistry, type IToolRegistry } from '../../../src/ai/tools/registry';
import { classifyRejectionCode } from '../../../src/ai/tools/toolProvider';
import { CLARIFICATION_WINDOW_MS, makeRejection, rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { buildRouteValidationRejection } from '../../../src/ai/sm/smRouteValidation';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { PruneCurrentInputSchema, submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { makeGraph, makeIndexedModel, makeNode } from '../helpers/modelFixtures';
import { stubToolServices } from './helpers/toolServices';

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
    const { registry, invoke } = registryWith(() => JSON.stringify(makeRejection({ code: REJECTION_CODES.noProjectLoaded, hint: 'No project is loaded; open the project and ask again.' })));
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
    expect(JSON.parse(String(results[0].content))).toMatchObject({ code: REJECTION_CODES.invalidToolInput, reason: TOOL_ARGUMENTS_NOT_OBJECT_REASON });
    expect(String(results[0].content)).not.toContain('Resend the full tool call');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempt.rejections).toEqual([expect.objectContaining({ callId: 'bad', code: REJECTION_CODES.invalidToolInput })]);
    expect(lines.filter(line => line.startsWith('[ToolOutcome]'))).toEqual([
      expect.stringContaining('callId=bad status=rejected code=invalid_tool_input'),
      expect.stringContaining('callId=good status=accepted'),
    ]);
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
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: protectedId, col: 'Value', transforms: ['filter'] }] }],
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
    const retry = { focus_node_id: root, column_flow: input.column_flow, questions: input.questions, prune_neighbors: input.prune_neighbors };
    const model = nativePort(() => [call('facts-retry', retry, 'lineage_submit_findings')]);
    const next = await executeToolAttempt(model.port, plan, { priorState: state });
    expect(model.sendRequest).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(next.providerCalls).toBe(1);
    assertToolPairingWellFormed(state.messages);
    // Inspect the actual consumed content, never the local artifact.
    const { content, feedback } = consumedRejection(model, 'facts');
    expect(feedback).toMatchObject({ code: REJECTION_CODES.routeValidationFailed });
    expect([...feedback.resend].sort()).toEqual(['prune_neighbors', 'questions']);
    for (const absent of ['replies_remaining', 'reason', 'hint', 'detail']) expect(feedback).not.toHaveProperty(absent);
    expect(feedback.errors.map((error: { path: string }) => error.path)).toEqual(expect.arrayContaining(['questions.0.nodeId', 'questions.1.nodeId', 'prune_neighbors.0.id']));
    const lastModel = nativePort(() => []);
    const secondState = recordToolAttempt(state, next, 'lineage_submit_findings');
    await executeToolAttempt(lastModel.port, plan, { priorState: secondState });
    const last = consumedRejection(lastModel, 'facts-retry').feedback;
    expect(last.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'questions.0.nodeId', issue: expect.stringContaining(`For neighbor \`${protectedId}\`, keep its question and remove its prune_neighbors entry`) }),
      expect.objectContaining({ path: 'questions.1.nodeId', issue: expect.stringContaining(`For neighbor \`${independentId}\`, keep its questions entry or its prune_neighbors entry, not both`) }),
      expect.objectContaining({ path: 'prune_neighbors.0.id', allowed: [independentId] }),
    ]));
    expect(toolMessage(next.messages)).toMatchObject({ status: 'error', tool_call_id: 'facts-retry' });
    expect(toolMessage(first.messages).artifact).toMatchObject({ detail: expect.arrayContaining([
      expect.objectContaining({ kind: 'prune_unsupported', id: protectedId, allowed_values: [independentId] }),
    ]) });
    assertToolPairingWellFormed(secondState.messages);
    expect(content).not.toContain('replies_remaining');
  });

  it.each([
    { id: 'invalid-fields', schema: z.object({ query: z.enum(['Orders', 'Sales']), limit: z.number().int().min(1) }).strict(),
      input: { query: 'Missing', limit: 0 }, issueCount: 2, issuePaths: ['query', 'limit'], reasons: ['query', 'limit'],
      detail: [ { kind: 'invalid_value', path: 'query', allowed_values: ['Orders', 'Sales'] }, { kind: 'too_small', path: 'limit', minimum: 1 } ] },
    { id: 'unknown-keys', schema: z.object({ column_flow: z.array(z.object({ out_col: z.string() }).strict()) }).strict(),
      input: { column_flow: Array.from({ length: 7 }, (_, index) => ({ out_col: `Value${index}`, note: 'RAW_NOTE_SENTINEL' })) }, issueCount: 7,
      issuePaths: Array.from({ length: 7 }, (_, index) => `column_flow.${index}.note`), reasons: [],
      detail: Array.from({ length: 7 }, (_, index) => ({ path: `column_flow[${index}].note`, error: 'field_not_allowed', allowed: ['out_col'] })) },
  ])('delivers every schema correction fact in the next consumed request: $id', async ({ id, schema, input, issueCount, issuePaths, reasons, detail }) => {
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
    expect(feedback).toMatchObject({ code: REJECTION_CODES.invalidInput, reason: rejection.reason });
    expect(feedback.hint).toBe(rejection.hint);
    expect(feedback.detail).toBeUndefined();
    for (const path of issuePaths) expect(`${feedback.reason}\n${JSON.stringify(feedback.issuePaths)}`).toContain(path);
    const lastModel = nativePort(() => []);
    await executeToolAttempt(lastModel.port, plan, { priorState: recordToolAttempt(state, second) });
    const last = consumedRejection(lastModel, `${id}-retry`).feedback;
    expect(last.detail).toHaveLength(detail.length);
    expect(last).not.toHaveProperty('replies_remaining');
    expect(last.detail).toEqual(expect.arrayContaining(detail.map(fact => expect.objectContaining(fact))));
    expect(toolMessage(first.messages).artifact).toMatchObject({ issuePaths, detail: expect.arrayContaining(detail.map(fact => expect.objectContaining(fact))) });
    for (const reason of reasons) expect(feedback.reason).toContain(reason);
    expect(content).not.toContain('RAW_NOTE_SENTINEL');
    expect(feedback).not.toHaveProperty('replies_remaining');
    expect(state).toMatchObject({ providerCalls: 1, noProgressCalls: 1, stopReason: null });
    assertToolPairingWellFormed(state.messages);
  });

  it('preserves owner facts without inventing a domain alternative or a countdown', async () => {
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_submit_findings', inputSchema: z.object({ focus_node_id: z.string() }), effect: 'hop_commit',
      execute: () => JSON.stringify(makeRejection({ code: REJECTION_CODES.routeValidationFailed,
        reason: 'An eligible kept neighbor needs an investigation-purpose question.', issuePaths: ['questions'] })) });
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
      expect(JSON.parse(String(toolMessage(attempt.messages).content))).toMatchObject({ code: REJECTION_CODES.routeValidationFailed, issuePaths: ['questions'] });
      expect(String(toolMessage(attempt.messages).content)).not.toContain('replies_remaining');
      state = recordToolAttempt(state, attempt, 'lineage_submit_findings');
    }
    expect(state).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS, rejectedTerminalCalls: MAX_TOOL_PROVIDER_CALLS });
    expect(state.rejections).toHaveLength(MAX_TOOL_PROVIDER_CALLS);
  });

  it.each([false, true])('serves a delivery alternative before the last reply for a missing call (required=%s)', async required => {
    const { registry } = registryWith(() => '{}');
    const base = discoveryPlan(registry);
    const plan = required ? { ...base, input: { ...base.input, requiredTerminalTool: 'lineage_search_objects' } } : base;
    let state = initialToolPhaseAttemptState('discover');
    for (let index = 0; index < MAX_TOOL_PROVIDER_CALLS; index++) {
      const model = nativePort(() => []);
      const attempt = await executeToolAttempt(model.port, plan, { priorState: state });
      const delivered = JSON.stringify(model.sendRequest.mock.calls);
      expect(delivered.includes('Use the requested delivery channel')).toBe(index === MAX_TOOL_PROVIDER_CALLS - 1);
      state = recordToolAttempt(state, attempt);
    }
    expect(state).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS });
    expect(state.rejections).toHaveLength(MAX_TOOL_PROVIDER_CALLS);
  });

  it('keeps schema correction choices when a rejected report also has held sections', async () => {
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
    const options = { presentResultRepairDraftContext: () => ({ sections: [{ label: 'Sources', start: 'B1' }] }) };
    const first = await executeToolAttempt(model.port, plan, { ...options, priorState: initialToolPhaseAttemptState('synthesis') });
    expect(JSON.parse(String(toolMessage(first.messages).content))).toMatchObject({ code: REJECTION_CODES.invalidInput, reason: expect.stringContaining('start') });
    expect(JSON.parse(String(toolMessage(first.messages).content)).detail).toBeUndefined();
    expect(toolMessage(first.messages).artifact).toMatchObject({ detail: expect.arrayContaining([expect.objectContaining({ held_draft: { sections: [{ label: 'Sources', start: 'B1' }] } })]) });
    const second = await executeToolAttempt(model.port, plan, {
      ...options, priorState: recordToolAttempt(initialToolPhaseAttemptState('synthesis'), first),
    });
    expect(JSON.parse(String(toolMessage(second.messages).content)).detail).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'start', allowed_values: ['B1', 'B2'] })]));
    expect(JSON.parse(String(toolMessage(second.messages).content)).detail).toEqual(expect.arrayContaining([expect.objectContaining({ held_draft: { sections: [{ label: 'Sources', start: 'B1' }] } })]));
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
    expect(initialFeedback.detail).toBeUndefined();
    expect(initialFeedback.hint).toBe(rejection.hint);
    const initialFacts = `${initialFeedback.reason}\n${JSON.stringify(initialFeedback.issuePaths)}`;
    for (const path of ['column_flow.0.out_col', 'column_flow.1.out_col'])
      expect(initialFacts).toContain(path);
    state = recordToolAttempt(state, first);
    const second = await executeToolAttempt(nativePort(() => [call('second', { query: 'MissingInput' })]).port, plan, { priorState: state });
    const content = String(toolMessage(second.messages).content);
    expect(JSON.parse(content).detail).toEqual(expect.arrayContaining([
      ...['column_flow.0.out_col', 'column_flow.1.out_col'].map(path => expect.objectContaining({ path, allowed_values: columns })),
    ]));
    expect(content).not.toContain(input.sections.technical);
  });

  it.each([3, 400].flatMap(count => ['column', 'neighbor', 'enum'].map(kind => ({ count, kind }))))('delivers faults and guidance first and all $count $kind choices on the last correction without domain inference', async ({ count, kind }) => {
    const columns = Array.from({ length: count }, (_, i) => `VerifiedColumn${i}`);
    const hint = 'Send only corrections for these faults.';
    const path = kind === 'column' ? 'column_flow.0.upstream_columns.0.col' : kind === 'neighbor' ? 'questions.0.nodeId' : 'query';
    const invalidEnum = z.object({ query: z.enum(columns as [string, ...string[]]) }).safeParse({ query: 'Missing' });
    if (invalidEnum.success) throw new Error('Expected invalid enum');
    const rejection = kind === 'enum' ? rejectionFromZodError(invalidEnum.error, { code: 'invalid_tool_input', input: { query: 'Missing' }, hint })
      : buildRouteValidationRejection([{ kind: kind === 'column' ? 'bad_contributor_col' : 'question_not_neighbor', id: 'Source', path,
        reason: 'The supplied value is not allowed here.',
        allowed_values: columns, ...(kind === 'column' ? { when: { node: 'Source' } } : {}) }]);
    const { registry } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const lines: string[] = [];
    const first = await executeToolAttempt(nativePort(() => [call('first', { query: 'Missing' })]).port, plan,
      { priorState: state, debugLog: line => lines.push(line) });
    expect(String(toolMessage(first.messages).content)).toContain(path);
    const firstFeedback = JSON.parse(String(toolMessage(first.messages).content));
    expect(firstFeedback).not.toHaveProperty('replies_remaining');
    expect(firstFeedback.detail).toBeUndefined();
    if (kind === 'enum') {
      expect(firstFeedback).toMatchObject({ code: rejection.code, reason: rejection.reason, hint });
    } else {
      expect(firstFeedback.errors).toEqual([expect.objectContaining({ path, issue: expect.stringContaining(rejection.errors![0].issue),
        allowed: count > 8 ? [...columns.slice(0, 8), `+${count - 8} more`] : columns, ...(kind === 'column' ? { when: { node: 'Source' } } : {}) })]);
    }
    expect(toolMessage(first.messages).artifact).toMatchObject({ detail: expect.arrayContaining([expect.objectContaining({ path, allowed_values: columns })]) });
    expect(String(toolMessage(first.messages).content)).not.toMatch(/Recheck the named column|Rebuild the defective fields|Re-evaluate the proposed action/);
    const outcome = lines.filter(line => line.startsWith('[ToolOutcome]'));
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toContain('phase=discover tool=lineage_search_objects callId=first status=rejected');
    expect(outcome[0]).toContain(`issuePaths=${path}`);
    expect(outcome[0]).not.toContain('query=Missing');
    state = recordToolAttempt(state, first);
    const second = await executeToolAttempt(nativePort(() => [call('second', { query: 'StillMissing' })]).port, plan, { priorState: state });
    const content = String(toolMessage(second.messages).content);
    expect(content).not.toContain('replies_remaining');
    if (kind === 'enum') {
      expect(JSON.parse(content)).toMatchObject({ hint: expect.stringContaining(hint) });
      expect(JSON.parse(content).detail).toEqual(expect.arrayContaining([expect.objectContaining({ path, allowed_values: columns })]));
    } else {
      expect(JSON.parse(content).errors).toEqual([expect.objectContaining({ path, allowed: columns, ...(kind === 'column' ? { when: { node: 'Source' } } : {}) })]);
    }
    expect(content).not.toMatch(/Recheck the named column|Rebuild the defective fields|Re-evaluate the proposed action/);
    state = recordToolAttempt(state, second);
    const finalModel = nativePort(() => [call('third', { query: 'StillMissing' })]);
    const third = await executeToolAttempt(finalModel.port, plan, { priorState: state });
    expect(JSON.stringify(finalModel.sendRequest.mock.calls)).toContain('VerifiedColumn0');
    expect(recordToolAttempt(state, third)).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS });
    expect(recordToolAttempt(state, third).rejections).toHaveLength(3);
    if (count === 400) expect(second.rejections[0].detail).toMatchObject({ omitted: true });
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
    expect(firstFeedback).toMatchObject({ code: REJECTION_CODES.columnSelfLoop,
      errors: [{ path: 'column_flow.0.upstream_columns.0', issue: expect.stringContaining('a column cannot be its own upstream source'), allowed: columns, when: { node: '[ai].[salesstaging]' } }] });
    for (const absent of ['replies_remaining', 'detail', 'reason', 'hint']) expect(firstFeedback).not.toHaveProperty(absent);
    expect(toolMessage(first.messages).artifact).toMatchObject({ detail: expect.arrayContaining([expect.objectContaining({
      path: 'column_flow.0.upstream_columns.0', allowed_values: columns, when: { node: '[ai].[salesstaging]' },
    })]) });
    state = recordToolAttempt(state, first);
    const second = await executeToolAttempt(nativePort(() => [call('second', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    const content = String(toolMessage(second.messages).content);
    expect(JSON.parse(content).errors).toEqual([expect.objectContaining({ path: 'column_flow.0.upstream_columns.0', allowed: columns, when: { node: '[ai].[salesstaging]' } })]);
    expect(content).not.toContain('Recheck the named column');
    state = recordToolAttempt(state, second);
    const third = await executeToolAttempt(nativePort(() => [call('third', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    const thirdContent = String(toolMessage(third.messages).content);
    expect(thirdContent).not.toContain('Recheck the named column');
    expect(thirdContent).not.toContain('not a column of');
    expect(third.observations).toEqual([]);
    expect(recordToolAttempt(state, third).stopReason).toBe('no_progress');
  });

  it('never shows a bare machine code when a hint states the fault', async () => {
    const { registry } = registryWith(() => JSON.stringify(makeRejection({ code: 'off_policy', hint: 'Call lineage_get_object_detail for one object.' })));
    const model = nativePort(() => [call('c1', { query: 'Orders' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry), { priorState: initialToolPhaseAttemptState('discover') });
    const content = String(toolMessage(attempt.messages).content);
    expect(JSON.parse(content)).toEqual({ code: 'off_policy', reason: 'Call lineage_get_object_detail for one object.' });
  });

  it('keeps a bare code when no hint exists, so the model is never answered with nothing', async () => {
    const { registry } = registryWith(() => JSON.stringify(makeRejection({ code: 'not_found' })));
    const model = nativePort(() => [call('c1', { query: 'Orders' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    expect(JSON.parse(String(toolMessage(attempt.messages).content))).toEqual({ code: 'not_found', reason: 'not_found' });
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
    const schema = submitFindingsSchemaForMode('bb', 'technical', false);
    const invoke = vi.fn(async (input: unknown) => {
      await beforeReply();
      return executeSubmitFindings(input, services);
    });
    registry.register({ name: 'lineage_submit_findings', inputSchema: schema, effect: 'hop_commit', execute: invoke });
    let completed = false;
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: 'sm_bb' }, registry,
      messages: [new HumanMessage('Explain Report.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts('bb', [], { classification: 'technical', memorySections: [] }),
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
    const args = { ...reply, ...(broad ? { summary: 'An updated but unrequested summary.' } : {}) };
    expect(schema.safeParse(args).success).toBe(true);
    const model = nativePort(() => [call('reply', args, 'lineage_submit_findings')]);
    const result = await executeToolAttempt(model.port, observedPlan, { priorState: attemptState, debugLog: line => log.push(line) });
    expect(invoke).toHaveBeenCalledTimes(broad ? 2 : 1);
    expect(invoke).toHaveBeenLastCalledWith(args);
    expect(result.rejections).toEqual([]);
    expect(toolMessage(result.messages)).toMatchObject({ status: 'success', tool_call_id: 'reply' });
    expect(session.memory.getShortTermMemory()).toEqual([expect.objectContaining({
      summary: broad ? 'An updated but unrequested summary.' : 'Report returns a constant Value.',
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

  /** A CT hop with two neighbors, driven through the real dispatcher so each step reads what the model reads. */
  function hop() {
    const nodes = [root, source, other].map(id => makeNode({ id, schema: 'd', name: id, type: 'view', bodyScript: 'SELECT 1 AS Value, 2 AS Other;',
      columns: (id === source ? sourceColumns : ['Value', 'Other']).map(col) }));
    const pairs: [string, string][] = [[source, root], [other, root]];
    const indexed = makeIndexedModel(nodes, pairs), graph = makeGraph(nodes, pairs);
    const session = new AiSession();
    session.model = indexed;
    session.graph = graph;
    session.setClassification('technical');
    session.beginTurn();
    const engine = new NavigationEngine(indexed, graph, () => {}, { memory: session.memory });
    engine.classification = 'technical';
    expect(engine.init({ origin: root, question: 'Trace Value and Other.', analysisMode: 'ct', targetColumns: ['Value', 'Other'],
      direction: 'upstream', depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    session.stateMachine = engine;
    session.enterExploring(session.turnEpoch);
    const { services } = stubToolServices({ session, model: indexed, graph, turnEpoch: () => session.turnEpoch });
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_submit_findings', inputSchema: submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns, false),
      effect: 'hop_commit', execute: (sent: unknown) => executeSubmitFindings(sent, services) });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: 'sm_ct' }, registry,
      messages: [new HumanMessage('Inspect Root.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts('ct', ['Value', 'Other'], { classification: 'technical', memorySections: [] }),
      requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required' });
    let state = initialToolPhaseAttemptState(plan.frame.phase);
    const send = async (input: unknown) => {
      const attempt = await executeToolAttempt(nativePort(() => [call(`c${state.providerCalls}`, input, 'lineage_submit_findings')]).port, plan, { priorState: state });
      state = recordToolAttempt(state, attempt, 'lineage_submit_findings');
      const content = String(toolMessage(attempt.messages).content);
      return { attempt, content, rejection: attempt.rejections.length ? JSON.parse(content) : undefined };
    };
    return { engine, send };
  }

  it('reports every independently decidable fault in one rejection, with the accepted values', async () => {
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
    expect(at(expected[0])).toMatchObject({ got: absent, allowed: expect.arrayContaining([source, other]) });
    expect(at(expected[1]).allowed, 'a long column list is previewed with its remainder counted').toEqual([...sourceColumns.slice(0, 8), '+2 more']);
    expect(at(expected[2]).allowed).toContain('pass_through');
    expect(at(expected[3]).allowed).toContain('upstream_columns');
    for (const absentKey of ['replies_remaining', 'example', 'way_out', 'reason', 'hint', 'detail']) expect(first.rejection).not.toHaveProperty(absentKey);
  });

  it('keeps a partial correction: the held draft advances and only the remaining fault is owed', async () => {
    const { engine, send } = hop();
    const first = await send({ ...base, badge_label: 'x'.repeat(51), questions: [{ nodeId: absent, question: 'Explain Absent.' }],
      prune_neighbors: [{ id: absent, reason: 'Outside.' }], column_flow: missingColumn });
    expect(paths(first.rejection).sort()).toEqual(['badge_label', 'column_flow.0.upstream_columns.0.col', 'prune_neighbors.0.id', 'questions.0.nodeId']);
    expect([...first.rejection.resend].sort()).toEqual(['badge_label', 'column_flow', 'prune_neighbors', 'questions']);
    const second = await send({ focus_node_id: root, badge_label: 'Source role', questions: [], prune_neighbors: [], column_flow: missingColumn });
    expect(second.attempt.rejections).toHaveLength(1);
    expect(paths(second.rejection)).toEqual(['column_flow.0.upstream_columns.0.col']);
    expect(second.rejection.resend).toEqual(['column_flow']);
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ summary: true, sections: ['technical'], resend: ['column_flow'],
      fields: expect.arrayContaining(['badge_label', 'questions', 'prune_neighbors']) });
    // The last repair opportunity carries the complete lists, one example shape and the way out.
    expect(second.rejection.errors[0].allowed).toEqual(sourceColumns);
    expect(second.rejection.example).toEqual({ column_flow: [expect.objectContaining({ out_col: expect.any(String), upstream_columns: [expect.objectContaining({ node: expect.any(String) })] })] });
    expect(second.rejection.way_out).toBe('If a reference cannot be mapped, remove it and record it in sections or as a question. An empty column_flow ends the arriving columns.');
    expect(first.rejection.way_out).toBeUndefined();
    const third = await send({ focus_node_id: root, column_flow: [] });
    expect(third.attempt.stop).toBe('phase_complete');
    expect(third.content).toContain('ended_columns');
    expect(third.content).not.toContain('Missing');
  });

  it('withdraws an omitted failing optional field and names it in the acknowledgement', async () => {
    const { engine, send } = hop();
    const first = await send({ ...base, column_flow: terminals, prune_neighbors: [{ id: absent, reason: 'Outside.' }] });
    expect(first.rejection.resend).toEqual(['prune_neighbors']);
    const second = await send({ focus_node_id: root });
    expect(second.attempt.stop).toBe('phase_complete');
    expect(second.content).toContain('"withdrawn":["prune_neighbors"]');
    expect(engine.toJSON().removedSet).toEqual([]);
  });

  it('never lets a field resent faulty overwrite its held valid copy', async () => {
    const { engine, send } = hop();
    const held = [{ id: other, reason: 'Supplies no tracked value.' }];
    await send({ ...base, prune_neighbors: held, column_flow: missingColumn });
    // Pruning Source conflicts with the mapping that keeps it; the held prune of Other must survive.
    const second = await send({ focus_node_id: root, prune_neighbors: [{ id: source, reason: 'Outside.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0' }] }, terminals[1]] });
    expect(paths(second.rejection)).toContain('prune_neighbors.0.id');
    expect(second.rejection.resend).toEqual(['prune_neighbors']);
    expect(engine.toJSON().engineInternals.heldFinding?.finding.prune_neighbors).toEqual(held);
    const third = await send({ focus_node_id: root });
    expect(third.attempt.stop).toBe('phase_complete');
    expect(engine.toJSON().removedSet).toEqual([other]);
  });
});
