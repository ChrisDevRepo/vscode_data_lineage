import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
/** Per-call, per-reply and recovery outcomes of the tool dispatcher. */
import { assert, describe, expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { z } from 'zod';
import Ajv from 'ajv';
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
} from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ToolRegistry, type IToolRegistry } from '../../../src/ai/tools/registry';
import { ISSUES, LAST_CORRECTION, at, makeRejection, type IssueCode, type ToolProblem } from '../../../src/ai/support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { buildRouteValidationRejection } from '../../../src/ai/sm/smRouteValidation';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { GetContextInputSchema, PruneCurrentInputSchema, StartExplorationFreshProviderInputSchema, StartExplorationRefineProviderInputSchema, submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { makeGraph, makeIndexedModel, makeNode } from '../helpers/modelFixtures';
import { stubToolServices } from './helpers/toolServices';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { EMPTY_AI_TEMPLATES } from '../../../src/ai/session/types';
import { modelToolCallMessage, type ModelPort, type ToolGenerationInput } from '../../../src/ai/model/modelPort';

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
      const admitted = validateToolCandidate(SearchSchema, input);
      if (!admitted.success) return JSON.stringify(admitted.rejection);
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
type ShownError = ToolProblem['errors'][number];
type Problem = ToolProblem;
const PROBLEM_KEYS = ['attempt', 'code', 'errors', 'notice', 'resend'];
const problemOf = (value: unknown): Problem => (typeof value === 'string' ? JSON.parse(value) : value) as Problem;
const shown = (value: unknown): ShownError[] => problemOf(value).errors;
/** One shown error of an issue code, without values. */
const fault = (code: IssueCode, path = '') => ({ path, code, message: expect.stringContaining(ISSUES[code].correction) });
const hasFallback = (value: unknown): boolean => shown(value).some(error => Object.values(ISSUES).some(issue => 'fallback' in issue && error.message.includes(issue.fallback)));

/** Approved08 D-097/D-098: stable full-field wire updates and strict composed admission through the production graph. */
it.each((['bb', 'ct'] as const).flatMap(mode => (['business', 'technical', 'both'] as const).map(classification => ({ mode, classification }))))(
  'keeps the original request prefix and tools through $mode/$classification corrections, resetting at the next hop', async ({ mode, classification }) => {
  const angles = classification === 'both' ? ['business', 'technical'] : [classification];
  const heldSections = Object.fromEntries(angles.map(angle => [angle, `Held ${angle} detail unique-prefix.`]));
  const columns = [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }];
  const source = makeNode({ id: '[dbo].[Source]', schema: 'dbo', name: 'Source', type: 'view', bodyScript: 'SELECT 1 AS Value;', columns });
  const focus = makeNode({ id: '[dbo].[Report]', schema: 'dbo', name: 'Report', type: 'view', bodyScript: 'SELECT Value FROM dbo.Source;', columns });
  const model = makeIndexedModel([source, focus], [[source.id, focus.id]]);
  const session = new AiSession({ ...EMPTY_AI_TEMPLATES, business_capture: 'Capture the supplied business facts.', technical_capture: 'Capture the supplied SQL.' });
  session.model = model;
  session.graph = makeGraph([source, focus], [[source.id, focus.id]]);
  const requests: Array<{ phase: string | undefined; focus: string | null; messages: string[]; system: string | undefined; tools: string; input: ToolGenerationInput }> = [];
  const sent: Array<{ callId: string; toolName: string; input: Record<string, unknown> }> = [];
  const counters = new Map<string, number>();
  let calls = 0;
  const scripted: ModelPort = {
    id: 'prefix-contract', identity: { id: 'prefix-contract', name: 'Prefix', vendor: 'test', family: 'test', version: '1' },
    budget: createTurnTokenBudget({}), get modelCalls() { return calls; },
    async getNumTokens(text) { return String(text).length; },
    async generateStructured() { throw new Error('Slash routing needs no classifier.'); },
    async completeText() { calls++; return 'Trace the supplied objects.'; },
    async generateToolTurn(input) {
      calls++;
      const engine = session.stateMachine instanceof NavigationEngine ? session.stateMachine : null;
      const current = engine?.currentFocus ?? null;
      requests.push({ phase: input.phase, focus: current, messages: input.messages.map(message => JSON.stringify(message.toJSON())),
        system: input.system, tools: JSON.stringify(input.tools.map(tool => ({ name: tool.name, description: tool.description, schema: toModelJsonSchema(tool.inputSchema) }))), input });
      let toolName: string, payload: Record<string, unknown>;
      if (input.phase === 'sm_entry') {
        toolName = 'lineage_start_exploration';
        payload = { origin: focus.id, analysisMode: mode, classification, ...(mode === 'ct' ? { targetColumns: ['Value'] } : {}),
          depth: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } };
      } else if (input.phase === 'active') {
        assert(engine && current);
        expect(engine.getDetailSlots().some(slot => slot.nodeId === current), 'a rejected draft must not commit before correction').toBe(false);
        const attempt = counters.get(current) ?? 0;
        counters.set(current, attempt + 1);
        toolName = 'lineage_submit_findings';
        if (current === focus.id) payload = attempt === 0
          ? { summary: 'Held summary unique-prefix.', sections: heldSections, badge_label: 42,
            ...(mode === 'ct' ? { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source.id, col: 'Value', transforms: ['pass_through'] }] }] }
              : { questions: [{ nodeId: source.id, question: 'Describe the source.' }] }) }
          : { badge_label: 'Report' };
        else payload = attempt === 0 ? {} : { summary: 'Source summary.', sections: Object.fromEntries(angles.map(angle => [angle, 'Source detail.'])), ...(mode === 'ct' ? { column_flow: [] } : {}) };
      } else {
        toolName = 'lineage_present_result';
        payload = { name: 'Lineage', summary: 'Report reads Source.', sections: [{ label: 'Trace', text: 'Supplied facts.', node_ids: session.resultGraph!.nodeIds }],
          highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [focus.id] }] };
      }
      const call = { callId: `prefix-${calls}`, toolName, input: payload };
      sent.push(call);
      return { status: 'completed', content: [], message: modelToolCallMessage([call]), text: '', toolCalls: [{ valid: true, ...call }], finishReason: 'tool-calls' };
    },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const runtime = new LineageRuntime({ getSession: () => session,
    createRegistry: (lease, port) => buildAiToolRegistry(() => session, logger as never, () => undefined, lease, { model: port }) });
  let proposalId: string | undefined;
  const sink = () => new TurnEventSink(event => { if (event.type === 'gate') proposalId = event.proposalId; });
  expect(await runtime.run({ model: scripted, sink: sink(), request: { id: 'prefix-start', prompt: `/trace ${focus.id}` } })).toMatchObject({ outcome: 'ok' });
  assert(proposalId);
  expect(await runtime.run({ model: scripted, sink: sink(), request: { id: 'prefix-approve', prompt: 'Approve & Proceed', gateDecision: { kind: 'approve', proposalId } } })).toMatchObject({ outcome: 'ok' });
  const target = process.env.DLV_RETRY_PREFIX_OUTPUT;
  if (target) appendFileSync(target, JSON.stringify({ mode, classification, requests: requests.map(({ input: _input, ...request }) => request) }) + '\n');
  const active = requests.filter(request => request.phase === 'active');
  for (const id of [focus.id, source.id]) {
    const [first, correction] = active.filter(request => request.focus === id);
    assert(first && correction);
    expect(correction.system).toBe(first.system);
    expect(correction.tools).toBe(first.tools);
    expect(correction.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(correction.input.messages.slice(first.messages.length).map(message => message.type)).toEqual(['ai', 'tool']);
    expect(correction.messages.join('')).not.toContain('Saved valid content:');
    const feedback = correction.input.messages.at(-1);
    assert(feedback instanceof ToolMessage);
    expect(shown(feedback.content).map(issue => issue.path)).toEqual(id === focus.id ? ['badge_label']
      : expect.arrayContaining(['summary', 'sections', ...(mode === 'ct' ? ['column_flow'] : [])]));
    const submit = first.input.tools.find(tool => tool.name === 'lineage_submit_findings');
    assert(submit);
    const validateWire = new Ajv({ strict: false }).compile(toModelJsonSchema(submit.inputSchema));
    for (const partial of [{ badge_label: 'Report' }, { questions: [] }, { prune_neighbors: [] },
      ...angles.map(angle => ({ sections: { [angle]: 'Corrected section.' } })), ...(mode === 'ct' ? [{ column_flow: [] }] : [])]) {
      expect(validateWire(partial), `D-098: the stable full-field card admits ${JSON.stringify(partial)}`).toBe(true);
    }
    for (const invalid of [{ summary: 42 }, { sections: 42 }, { badge_label: 42 }, { unknown: true },
      ...angles.map(angle => ({ sections: { [angle]: 42 } })), { sections: { unknown: 'Unsupported angle.' } },
      { questions: [{ nodeId: '[dbo].[Unknown]', question: 'Explain the supplied value.' }] },
      ...(mode === 'ct' ? [{ column_flow: 42 }, { column_flow: [{ out_col: 'Unknown', upstream_columns: [] }] }] : [])]) expect(validateWire(invalid)).toBe(false);
    expect(Object.keys(toModelJsonSchema(submit.inputSchema).properties as object)).toEqual(mode === 'ct'
      ? ['focus_node_id', 'column_flow', 'summary', 'badge_label', 'prune_neighbors', 'questions', 'sections']
      : ['focus_node_id', 'summary', 'badge_label', 'prune_neighbors', 'questions', 'sections']);
    expect(JSON.stringify(feedback.content)).not.toContain('Held summary unique-prefix.');
  }
  const [firstHop] = active.filter(request => request.focus === focus.id);
  const [nextHop] = active.filter(request => request.focus === source.id);
  expect(nextHop.messages).not.toEqual(firstHop.messages);
  expect(nextHop.input.messages.some(message => message instanceof ToolMessage)).toBe(false);
  expect(sent.filter(call => call.toolName === 'lineage_submit_findings').map(call => call.input)).toContainEqual({ badge_label: 'Report' });
  expect(session.memory.getResult().detail_slots.find(slot => slot.nodeId === focus.id)).toMatchObject({ summary: 'Held summary unique-prefix.',
    sections: angles.map(angle => ({ angle, text: heldSections[angle] })) });
});

/** Approved08 D-099: the production start controller owns schema and proposal faults in one reply. */
describe('start contract matrix through the native port and production registry', () => {
  const id = '[dbo].[Report]';
  const depth = { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } };
  const proposal = { origin: id, analysisMode: 'bb', classification: 'technical', depth, mission_brief: 'Keep this exact authored mission.' };
  function startWorld() {
    const node = makeNode({ id, schema: 'dbo', name: 'Report', type: 'view', bodyScript: 'SELECT 1 AS Value;',
      columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] });
    const session = new AiSession();
    session.model = makeIndexedModel([node], []);
    session.graph = makeGraph([node], []);
    session.beginTurn(); session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
    let input: unknown;
    const model = nativePort(() => [call(`start-${model.port.modelCalls}`, input, 'lineage_start_exploration')]);
    const registry = buildAiToolRegistry(() => session, { debug() {}, info() {}, warn() {}, error() {} } as never,
      () => undefined, undefined, { model: model.port });
    const plan = (refine: boolean) => compileInstructionPlan({ kind: 'converse', stage: { kind: 'sm_entry' }, registry,
      // These are the exact phase owners selected by the production graph's sm_entry/gate_refine nodes.
      toolSchemaOverrides: new Map([['lineage_start_exploration', refine ? StartExplorationRefineProviderInputSchema : StartExplorationFreshProviderInputSchema]]),
      messages: [new HumanMessage('Review this exploration proposal.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts('bb', [], { classification: 'technical' }), takeControlSignal: () => session.takeControlSignal(),
      requiredTerminalTool: 'lineage_start_exploration', toolChoice: 'required' });
    let current = plan(false), state = initialToolPhaseAttemptState('sm_entry');
    return { session, model, state: () => state, async send(value: unknown) {
      input = value;
      const attempt = await executeToolAttempt(model.port, current, { priorState: state });
      state = recordToolAttempt(state, attempt, registry);
      const [messages, options] = model.sendRequest.mock.calls.at(-1) as unknown as [unknown[], { tools: Array<{ name: string; inputSchema: object }> }];
      const offered = options.tools.find(tool => tool.name === 'lineage_start_exploration');
      assert(offered);
      return { attempt, raw: toolMessage(attempt.messages).artifact as { code?: string; errors?: Array<{ path: string; code: string; values?: string[] }> },
        wire: { schema: offered.inputSchema, messages: structuredClone(messages), tools: structuredClone(options.tools) } };
    }, refine() { session.enterGate(session.turnEpoch); current = plan(true); state = initialToolPhaseAttemptState('sm_entry'); } };
  }

  it.each([false, true])('D-098/D-097: the actual served start card admits the minimal named correction (refine=%s)', async refining => {
    const w = startWorld();
    if (refining) { expect((await w.send(proposal)).attempt.rejections).toEqual([]); w.refine(); }
    const before = structuredClone(w.session.pendingExploration);
    const first = await w.send(refining ? { proposalRevision: 1, mission_brief: proposal.mission_brief,
      depth: { ...depth, upstream: { levels: 2, exactness: 'wrong' } } } : { ...proposal, classification: 'wrong', depth: JSON.stringify(depth) });
    expect(first.raw.errors).toEqual(expect.arrayContaining([expect.objectContaining(refining
      ? { path: 'depth.upstream.exactness', code: 'enum' } : { path: 'classification', code: 'enum' })]));
    expect(w.session.pendingExploration).toEqual(before);
    expect(w.session.stateMachine).toBeNull();
    expect(String(toolMessage(first.attempt.messages).content)).not.toContain(proposal.mission_brief);
    const correction = refining ? { depth: { upstream: { exactness: 'exact' } } } : { classification: 'technical' };
    const validate = new Ajv({ strict: false, allErrors: true }).compile(first.wire.schema);
    expect(validate(correction), `D-098: the exact model-facing card must admit the authored correction: ${JSON.stringify(validate.errors)}`).toBe(true);
    const accepted = await w.send(correction);
    expect(accepted.attempt.rejections).toEqual([]);
    expect(accepted.wire.tools).toEqual(first.wire.tools);
    expect(accepted.wire.messages.slice(0, first.wire.messages.length)).toEqual(first.wire.messages);
    expect(w.session.pendingExploration).toMatchObject({ revision: refining ? 2 : 1,
      init: { origin: id, mission_brief: proposal.mission_brief,
        depthIntent: refining ? { ...depth, upstream: { levels: 2, exactness: 'exact' } } : depth } });
    expect(w.session.stateMachine).toBeNull();
  });

  it.each([{}, { classification: 'wrong' }])('D-098: wire updates never supply missing fresh proposal content (%j)', async payload => {
    const w = startWorld();
    const result = await w.send(payload);
    expect(result.attempt.rejections).toHaveLength(1);
    expect(result.raw.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'origin', code: 'missing' }),
      expect.objectContaining({ path: 'analysisMode', code: 'missing' }),
      expect.objectContaining({ path: 'classification', code: 'classification' in payload ? 'enum' : 'missing' }),
      expect.objectContaining({ path: 'depth', code: 'missing' }),
    ]));
    expect(w.session.pendingExploration).toBeNull();
    expect(w.session.stateMachine).toBeNull();
  });

  it.each([
    { revision: undefined, extra: [] },
    { revision: 1, extra: [{ path: 'proposalRevision', code: 'stale_revision' }] },
    { revision: 'bogus', extra: [{ path: 'proposalRevision', code: 'type' }] },
  ])('does not infer a missing analysis mode on a fresh proposal, whatever its revision ($revision)', async ({ revision, extra }) => {
    const w = startWorld();
    const init = vi.spyOn(NavigationEngine.prototype, 'init');
    try {
      const result = await w.send({ origin: id, classification: 'technical', targetColumns: ['Value'], depth, ...(revision === undefined ? {} : { proposalRevision: revision }) });
      expect(result.raw.errors?.map(({ path, code }) => ({ path, code })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([{ path: 'analysisMode', code: 'missing' }, ...extra]);
      expect(init).not.toHaveBeenCalled();
    } finally { init.mockRestore(); }
    expect(w.session.pendingExploration).toBeNull();
    expect(w.session.stateMachine).toBeNull();
  });

  it('D-099: reports stale revision beside bad depth before accepting just both corrections', async () => {
    const w = startWorld();
    expect((await w.send(proposal)).attempt.rejections).toEqual([]);
    w.refine();
    const before = structuredClone(w.session.pendingExploration);
    const rejected = await w.send({ proposalRevision: 2, classification: 'business',
      depth: { ...depth, upstream: { levels: 1, exactness: 'wrong' } } });
    expect(rejected.raw.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'proposalRevision', code: 'stale_revision' }),
      expect.objectContaining({ path: 'depth.upstream.exactness', code: 'enum' }),
    ]));
    expect(w.session.pendingExploration).toEqual(before);
    expect(w.session.stateMachine).toBeNull();
    const accepted = await w.send({ proposalRevision: 1, depth: { upstream: { exactness: 'exact' } } });
    expect(accepted.attempt.rejections).toEqual([]);
    expect(w.session.pendingExploration).toMatchObject({ revision: 2, classification: 'business',
      init: { origin: id, depthIntent: depth, mission_brief: proposal.mission_brief } });
    expect(w.session.stateMachine).toBeNull();
  });

  it.each((['excludeNodeIds', 'passNodeIds', 'targetColumns'] as const).flatMap(field => [true, false].map(readable => ({ field, readable }))))('Approved08 mixed array items keep independent metadata faults at original indices: $field/readable=$readable', async ({ field, readable }) => {
    const w = startWorld();
    const target = field === 'targetColumns';
    const rejected = await w.send({ ...proposal, ...(target ? { analysisMode: 'ct' } : {}),
      [field]: [42, ...(readable ? [target ? 'MissingColumn' : '[dbo].[Missing]'] : [])] });
    expect(rejected.raw.errors?.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: `${field}.0`, code: 'type' },
      ...(readable ? [{ path: `${field}.1`, code: target ? 'unknown_target_column' : 'not_found' }] : []),
    ]);
    expect(w.session.pendingExploration).toBeNull();
    expect(w.session.stateMachine).toBeNull();
    const correction = { [field]: target ? ['Value'] : [] };
    const validate = new Ajv({ strict: false, allErrors: true }).compile(rejected.wire.schema);
    expect(validate(correction), JSON.stringify(validate.errors)).toBe(true);
    const accepted = await w.send(correction);
    expect(accepted.attempt.rejections).toEqual([]);
    expect(w.session.pendingExploration).toMatchObject({ init: { origin: id, depthIntent: depth, mission_brief: proposal.mission_brief,
      ...(target ? { analysisMode: 'ct', targetColumns: ['Value'] } : { [field]: [] }) } });
  });

  it('Approved08 CT refine inspects target metadata against the held origin beside independent enum faults', async () => {
    const w = startWorld();
    expect((await w.send({ ...proposal, analysisMode: 'ct', targetColumns: ['Value'] })).attempt.rejections).toEqual([]);
    w.refine();
    const before = structuredClone(w.session.pendingExploration);
    const rejected = await w.send({ proposalRevision: 1, classification: 'wrong', targetColumns: ['Missing'] });
    expect(rejected.raw.errors?.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: 'classification', code: 'enum' }, { path: 'targetColumns.0', code: 'unknown_target_column' },
    ]);
    expect(w.session.pendingExploration).toEqual(before);
    const accepted = await w.send({ classification: 'business', targetColumns: ['Value'] });
    expect(accepted.attempt.rejections).toEqual([]);
    expect(w.session.pendingExploration).toMatchObject({ revision: 2, classification: 'business', init: { origin: id, analysisMode: 'ct', targetColumns: ['Value'] } });
  });

  // Independent field rules plus one maximum bundle; temporal outcomes belong to the draft owner.
  const startFaults = [
    { field: 'classification', bad: 'wrong', good: 'technical', errors: [{ path: 'classification', code: 'enum' }] },
    { field: 'origin', bad: '[dbo].[Missing]', good: id, errors: [{ path: 'origin', code: 'not_found' }] },
    { field: 'depth', bad: [], good: depth, errors: [{ path: 'depth', code: 'type' }] },
    { field: 'unknown', bad: true, good: undefined, errors: [{ path: 'unknown', code: 'unknown_key' }] },
    { field: 'excludeNodeIds', bad: ['[dbo].[Missing]'], good: [], errors: [{ path: 'excludeNodeIds.0', code: 'not_found' }] },
  ];
  const startScenarios = [
    ...startFaults.map(fault => ({ name: fault.field, faults: [fault], correctAt: 2 })),
    ...[2, 3, 4, null].map(correctAt => ({ name: 'maximum-independent-bundle', faults: startFaults, correctAt })),
  ];
  it.each(startScenarios)('Approved08 START independent rule: $name / correction=$correctAt', async ({ faults, correctAt }) => {
    const w = startWorld();
    const bad = { ...proposal, ...Object.fromEntries(faults.map(fault => [fault.field, fault.bad])) };
    const correction = Object.fromEntries(faults.filter(fault => fault.good !== undefined).map(fault => [fault.field, fault.good]));
    const expected = faults.flatMap(fault => fault.errors).sort((a, b) => a.path.localeCompare(b.path));
    let first: Awaited<ReturnType<typeof w.send>> | undefined;
    for (let stage = 1; stage < (correctAt ?? 4); stage++) {
      const rejected = await w.send(bad);
      first ??= rejected;
      expect(rejected.raw.errors?.map(({ path, code }) => ({ path, code })).sort((a, b) => a.path.localeCompare(b.path)),
        `feedback ${stage}: every independently decidable fault exactly once`).toEqual([...(stage > 1 ? [{ path: '', code: 'identical_resend' }] : []), ...expected]);
      expect(rejected.raw.errors?.some(error => error.path.startsWith('depth.'))).toBe(false);
      const feedback = problemOf(String(toolMessage(rejected.attempt.messages).content));
      expect(feedback.attempt).toBe(`${stage}/3`);
      expect(feedback.notice !== undefined).toBe(stage === 3);
      expect(hasFallback(feedback)).toBe(false);
      for (const error of rejected.raw.errors ?? []) {
        const visible = shown(feedback).find(item => item.path === error.path);
        expect(visible).toBeDefined();
        if (stage === 1) expect(visible).not.toHaveProperty('allowed');
        else if (error.values) expect([...(visible!.allowed ?? [])].sort()).toEqual([...error.values].sort());
      }
      expect(w.state().stopReason).toBeNull();
      expect(w.session.pendingExploration).toBeNull();
      expect(w.session.stateMachine).toBeNull();
      expect(String(toolMessage(rejected.attempt.messages).content)).not.toContain(proposal.mission_brief);
    }
    assert(first);
    if (correctAt === null) {
      const terminal = await w.send(bad);
      expect(terminal.attempt.rejections).toHaveLength(1);
      expect(w.state()).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS });
      expect(w.session.pendingExploration).toBeNull();
      expect(w.session.stateMachine).toBeNull();
      return;
    }
    const validate = new Ajv({ strict: false, allErrors: true }).compile(first.wire.schema);
    expect(validate(correction), JSON.stringify(validate.errors)).toBe(true);
    const repaired = await w.send(correction);
    expect(repaired.attempt.rejections).toEqual([]);
    expect(w.state().providerCalls).toBe(correctAt);
    expect(repaired.wire.tools).toEqual(first.wire.tools);
    expect(w.session.pendingExploration).toMatchObject({ init: { origin: id, depthIntent: depth, mission_brief: proposal.mission_brief } });
    expect(w.session.stateMachine).toBeNull();
  });

  it('D-099: reports unknown origin with independent classification and depth faults without inventing columns', async () => {
    const w = startWorld();
    const rejected = await w.send({ ...proposal, origin: '[dbo].[Missing]', classification: 'wrong',
      depth: { ...depth, upstream: { levels: 1, exactness: 'wrong' } } });
    expect(rejected.raw.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'origin', code: 'not_found' }),
      expect.objectContaining({ path: 'classification', code: 'enum' }),
      expect.objectContaining({ path: 'depth.upstream.exactness', code: 'enum' }),
    ]));
    expect(rejected.raw.errors?.some(error => error.path.startsWith('targetColumns'))).toBe(false);
    expect(w.session.pendingExploration).toBeNull();
    expect(w.session.stateMachine).toBeNull();
    const accepted = await w.send({ origin: id, classification: 'technical', depth: { upstream: { exactness: 'exact' } } });
    expect(accepted.attempt.rejections).toEqual([]);
    expect(w.session.pendingExploration).toMatchObject({ revision: 1, classification: 'technical',
      init: { origin: id, depthIntent: depth, mission_brief: proposal.mission_brief } });
  });
});

/** Approved08 D-098/D-099/D-102: report corrections use the same production controller in every report phase. */
const reportFields = ['name', 'notes', 'sections', 'highlight_groups', 'unknown'];
const reportContexts = [
  { phase: 'completed' as const, retainable: false }, { phase: 'synthesis' as const, retainable: false },
  { phase: 'completed' as const, retainable: true }, { phase: 'visual_preview' as const, retainable: false },
];
const reportScenarios = [
  ...reportContexts.flatMap(context => [
    ...reportFields.map(field => ({ ...context, name: field, fields: [field], correctAt: 2 })),
    { ...context, name: 'maximum-independent-bundle', fields: reportFields, correctAt: 2 },
  ]),
  ...[3, 4, null].map(correctAt => ({ phase: 'completed' as const, retainable: false,
    name: 'shared-report-draft-temporal', fields: reportFields, correctAt })),
];
it.each(reportScenarios)('report independent rule: $name ($phase, retainable=$retainable, correction=$correctAt)', async ({ phase, retainable, fields, correctAt }) => {
  const origin = '[dbo].[Report]', source = '[dbo].[Source]', outside = '[dbo].[Outside]';
  const nodes = [origin, source, outside].map(id => makeNode({ id, schema: 'dbo', name: id, type: 'table' }));
  const session = new AiSession();
  session.model = makeIndexedModel(nodes, [[source, origin]]); session.graph = makeGraph(nodes, [[source, origin]]);
  const epoch = session.beginTurn();
  session.classification = 'technical';
  const sections = [{ label: 'Flow', node_ids: [origin, source], text: 'Keep this exact authored report body.' }];
  const report = { name: 'Held report', summary: 'Source supplies Report.', title: 'Held title sentinel', sections,
    highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }] };
  session.explorationRunId = 'report-contract';
  session.resultGraph = { nodeIds: [origin, source], edges: [[source, origin, 'read']], source: 'blackboard', originNodeId: origin,
    ...(retainable ? { sections, sectionsRunId: session.explorationRunId } : {}) };
  session.enterCompleted(epoch); session.enterLmStage({ kind: phase }, epoch);
  const preview = phase === 'visual_preview';
  if (preview) {
    session.lastDiscoveryAnswer = 'Source report.\n\nSource supplies Report exactly.';
    session.storeDiscoveryScope({ turnEpoch: epoch, origin, direction: 'upstream', nodeIds: [origin, source], edges: [[source, origin, 'read']] }, epoch);
  }
  const before = structuredClone(session.resultGraph);
  const complete = preview ? { name: report.name, sections: [{ label: 'Flow', node_ids: [origin, source], start: 'B1' }],
    highlight_groups: report.highlight_groups } : { ...report, ...(retainable ? { sections: [{ label: 'Flow' }] } : {}) };
  // Literal oracle: Approved08 field/type/reference contracts, never production validation output.
  const catalog = [
    { field: 'name', bad: 42, good: report.name, errors: [{ path: 'name', code: 'type' }] },
    { field: 'notes', bad: [{ node_id: outside, caption: 'Unresolved outside source.' }], good: [], errors: [{ path: 'notes.0.node_id', code: 'result_out_of_scope' }] },
    { field: 'sections', bad: 42, good: complete.sections, errors: [{ path: 'sections', code: 'type' }] },
    { field: 'highlight_groups', bad: [{ label: 'Origin', color: 'wrong', node_ids: [origin] }], good: report.highlight_groups,
      errors: [{ path: 'highlight_groups.0.color', code: 'enum' }] },
    { field: 'unknown', bad: true, good: undefined, errors: [{ path: 'unknown', code: 'unknown_key' }] },
  ];
  const faults = catalog.filter(fault => fields.includes(fault.field));
  let payload: unknown = { ...complete, ...Object.fromEntries(faults.map(fault => [fault.field, fault.bad])) };
  const model = nativePort(() => [call(`report-${model.port.modelCalls}`, payload, 'lineage_present_result')]);
  const registry = buildAiToolRegistry(() => session, { debug() {}, info() {}, warn() {}, error() {} } as never,
    () => undefined, undefined, { model: model.port });
  const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: phase }, registry,
    messages: [new HumanMessage('Present the recorded report.')], sink: new TurnEventSink(() => {}),
    facts: explorationFacts('bb', [], { classification: 'technical', memorySections: [] }), presentResultRetainableSections: () => session.retainableReportSections() !== null,
    requiredTerminalTool: 'lineage_present_result', toolChoice: 'required' });
  let state = initialToolPhaseAttemptState(phase);
  const first = await executeToolAttempt(model.port, plan, { priorState: state });
  state = recordToolAttempt(state, first, registry);
  const expected = faults.flatMap(fault => fault.errors).sort((a, b) => a.path.localeCompare(b.path));
  const check = (attempt: typeof first, stage: number) => {
    const raw = toolMessage(attempt.messages).artifact as { errors: Array<{ path: string; code: string; values?: string[] }> };
    expect(raw.errors.map(({ path, code }) => ({ path, code })).sort((a, b) => a.path.localeCompare(b.path)),
      `stage${stage}: independently decidable exact faults`).toEqual([...(stage > 1 ? [{ path: '', code: 'identical_resend' }] : []), ...expected]);
    if (fields.includes('sections')) expect(raw.errors.some(error => error.path.startsWith('sections.'))).toBe(false);
    const feedback = problemOf(String(toolMessage(attempt.messages).content));
    expect(feedback.attempt).toBe(`${stage}/3`);
    expect(feedback.notice !== undefined).toBe(stage === 3);
    // Only the report's outside-node reference has a fallback among this declared catalog.
    expect(hasFallback(feedback)).toBe(stage === 3 && fields.includes('notes'));
    for (const error of raw.errors) {
      const visible = shown(feedback).find(item => item.path === error.path);
      expect(visible).toBeDefined();
      if (stage === 1) expect(visible).not.toHaveProperty('allowed');
      else if (error.values) expect([...(visible!.allowed ?? [])].sort()).toEqual([...error.values].sort());
    }
    expect(state.stopReason).toBeNull();
    expect(session.resultGraph).toEqual(before);
    expect(session.presentationArtifact).toBeNull();
    expect(String(toolMessage(attempt.messages).content)).not.toContain(report.title);
    expect(String(toolMessage(attempt.messages).content)).not.toContain(sections[0].text);
  };
  check(first, 1);
  for (let stage = 2; stage < (correctAt ?? 4); stage++) {
    const rejected = await executeToolAttempt(model.port, plan, { priorState: state });
    state = recordToolAttempt(state, rejected, registry);
    check(rejected, stage);
  }
  if (correctAt === null) {
    const terminal = await executeToolAttempt(model.port, plan, { priorState: state });
    const finalState = recordToolAttempt(state, terminal, registry);
    expect(terminal.rejections).toHaveLength(1);
    expect(finalState).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS });
    expect(session.resultGraph).toEqual(before);
    expect(session.presentationArtifact).toBeNull();
    return;
  }
  const [firstMessages, firstOptions] = model.sendRequest.mock.calls.at(-1) as unknown as [unknown[], { tools: Array<{ name: string; inputSchema: object }> }];
  const firstWire = { messages: structuredClone(firstMessages), tools: structuredClone(firstOptions.tools) };
  const offered = firstOptions.tools.find(tool => tool.name === 'lineage_present_result'); assert(offered);
  payload = Object.fromEntries(faults.filter(fault => fault.good !== undefined).map(fault => [fault.field, fault.good]));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(offered.inputSchema);
  expect(validate({ notes: [{ caption: 'Missing required node' }] })).toBe(false);
  expect(validate(payload), `D-098: report wire must admit only corrected fields: ${JSON.stringify(validate.errors)}`).toBe(true);
  const accepted = await executeToolAttempt(model.port, plan, { priorState: state });
  expect(accepted.rejections).toEqual([]);
  expect(recordToolAttempt(state, accepted, registry).providerCalls).toBe(correctAt);
  expect(session.presentationArtifact?.name).toBe(report.name);
  if (preview) {
    expect(session.presentationArtifact?.aiMetadata.description).toContain('Source supplies Report exactly.');
    expect(session.resultGraph?.sections).toEqual([{ label: 'Flow', node_ids: [origin, source], text: expect.stringContaining('Source supplies Report exactly.') }]);
  } else {
    expect(session.resultGraph?.sections).toEqual(sections);
    expect(session.resultGraph?.title).toBe(report.title);
  }
  const [nextMessages, nextOptions] = model.sendRequest.mock.calls.at(-1) as unknown as [unknown[], { tools: unknown[] }];
  expect(nextOptions.tools).toEqual(firstWire.tools);
  expect(nextMessages.slice(0, firstWire.messages.length)).toEqual(firstWire.messages);
});

it.each([
  { phase: 'active', prior: true, human: true, order: ['anchor', 'current', 'call', 'result'] },
  { phase: 'discover', prior: true, human: true, order: ['anchor', 'current', 'call', 'result'] },
  { phase: 'synthesis', prior: true, human: true, order: ['anchor', 'current', 'call', 'result'] },
  { phase: 'active', prior: false, human: true, order: ['anchor', 'current'] },
  { phase: 'active', prior: true, human: false, order: ['anchor', 'current', 'call', 'result'] },
] as const)('appends native paired history after the original request: $phase prior=$prior human=$human', async scenario => {
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
    const prune = vi.fn(() => JSON.stringify(accepted ? { ok: true } : makeRejection({ code: REJECTION_CODES.invalidInput, reason: 'Removal no longer admitted.', errors: at('off_policy') })));
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
    expect(messages[1].artifact).toMatchObject({ code: 'invalid_input', errors: [{ path: '', code: 'one_call' }] });
    const outcomes = lines.filter(line => line.startsWith('[ToolOutcome]'));
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toContain(`callId=prune status=${accepted ? 'accepted' : 'rejected'}`);
    expect(outcomes[1]).toContain('callId=sibling status=not_evaluated');
    expect(outcomes.filter(line => line.includes(' status=rejected'))).toHaveLength(accepted ? 0 : 1);
  });
});

describe('per-reply progress accounting', () => {
  const refused = JSON.stringify(makeRejection({ code: 'invalid_input', errors: at('result_too_large') }));
  const observation = (index: number, extra: Partial<ToolAttemptObservation> = {}): ToolAttemptObservation =>
    ({ callId: `c${index}`, toolName: 'lineage_get_scope_bundle', result: refused, input: { origin: `o${index}` }, ...extra });
  const reply = (observations: ToolAttemptObservation[]) => ({ stop: 'continue' as const, providerCalls: 1, observations, rejections: [], messages: [] });
  const { registry } = registryWith(() => '{}');

  it('a result refused for size stores nothing, so three such replies stop the step as no progress', () => {
    let state = initialToolPhaseAttemptState('discover');
    for (let index = 0; index < MAX_TOOL_PROVIDER_CALLS; index++) {
      expect(state.stopReason).toBeNull();
      state = recordToolAttempt(state, reply([observation(index, { refused: true })]), registry);
    }
    expect(state).toMatchObject({ noProgressCalls: MAX_TOOL_PROVIDER_CALLS, stopReason: 'no_progress' });
  });

  it('a stored body resets the count; a refused body after it does not', () => {
    let state = recordToolAttempt(initialToolPhaseAttemptState('discover'), reply([observation(0, { refused: true })]), registry);
    state = recordToolAttempt(state, reply([observation(1, { result: '{"nodes":[]}' })]), registry);
    expect(state.noProgressCalls).toBe(0);
    state = recordToolAttempt(state, reply([observation(2, { refused: true })]), registry);
    expect(state).toMatchObject({ noProgressCalls: 1, stopReason: null });
  });

  it('an empty reply counts toward the limit', () => {
    const rejected = { callId: '', toolName: 'lineage_answer', code: REJECTION_CODES.invalidInput, reason: 'empty' };
    let state = initialToolPhaseAttemptState('discover');
    for (let index = 0; index < MAX_TOOL_PROVIDER_CALLS; index++) {
      state = recordToolAttempt(state, { stop: 'continue', providerCalls: 1, observations: [], rejections: [rejected], messages: [] }, registry);
    }
    expect(state.stopReason).toBe('no_progress');
  });
});

describe('backend-fault rejection', () => {
  it('a no-project result inside a reply ends the run and executes no later sibling', async () => {
    const { registry, invoke } = registryWith(() => JSON.stringify(makeRejection({ code: REJECTION_CODES.backendFault, errors: at('no_project') })));
    const model = nativePort(() => [call('first', { query: 'Orders' }), call('second', { query: 'Sales' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempt.calls.map(item => item.status)).toEqual(['rejected', 'phase_closed']);
    expect(recordToolAttempt(initialToolPhaseAttemptState('discover'), attempt, registry).stopReason).toBe('backend_fault');
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
      callId: 'unavailable', code: REJECTION_CODES.invalidInput,
    })]);
    expect(invoke).not.toHaveBeenCalled();
    expect(toolMessage(attempt.messages).status).toBe('error');
    expect(() => assertToolPairingWellFormed(attempt.messages)).not.toThrow();
    expect(recordToolAttempt(initialToolPhaseAttemptState('discover'), attempt, registry).stopReason).toBeNull();
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
      { valid: false, callId: 'bad', toolName: 'lineage_search_objects', input: JSON.stringify(input), code: 'type', reason: TOOL_ARGUMENTS_NOT_OBJECT_REASON },
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
    expect(problemOf(String(results[0].content))).toMatchObject({ code: REJECTION_CODES.invalidInput, attempt: '2/3', resend: [] });
    expect(shown(String(results[0].content))).toEqual([{ ...fault('type'), allowed: ['object'] }]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempt.rejections).toEqual([expect.objectContaining({ callId: 'bad', code: REJECTION_CODES.invalidInput })]);
    expect(lines.filter(line => line.startsWith('[ToolOutcome]'))).toEqual([
      expect.stringContaining('callId=bad status=rejected code=invalid_input'),
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
        code: 'type', reason: TOOL_ARGUMENTS_NOT_OBJECT_REASON,
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
    })).rejects.toMatchObject({ code: REJECTION_CODES.invalidInput });
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
    })).rejects.toMatchObject({ code: REJECTION_CODES.invalidInput });
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
    session.classification = 'technical';
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
    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), first, registry);
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
    expect(feedback).toMatchObject({ code: REJECTION_CODES.invalidInput });
    expect([...feedback.resend].sort()).toEqual(['column_flow', 'prune_neighbors', 'questions']);
    for (const absent of ['replies_remaining', 'reason', 'hint', 'detail']) expect(feedback).not.toHaveProperty(absent);
    expect(shown(feedback).map(error => error.path)).toEqual(expect.arrayContaining(['questions.0.nodeId', 'questions.1.nodeId', 'prune_neighbors.0.id']));
    const lastModel = nativePort(() => []);
    const secondState = recordToolAttempt(state, next, registry);
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
    const parsed = validateToolCandidate(schema, input);
    if (parsed.success) throw new Error('Expected schema faults');
    expect(parsed.rejection.errors).toHaveLength(issueCount);
    const rejection = parsed.rejection;
    const { registry, invoke } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    const first = await executeToolAttempt(nativePort(() => [call(id, { query: 'Orders' })]).port, plan,
      { priorState: initialToolPhaseAttemptState('discover') });
    const state = recordToolAttempt(initialToolPhaseAttemptState('discover'), first, registry);
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
    await executeToolAttempt(lastModel.port, plan, { priorState: recordToolAttempt(state, second, registry) });
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
      execute: () => JSON.stringify(makeRejection({ code: REJECTION_CODES.invalidInput,
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
      expect(problemOf(String(toolMessage(attempt.messages).content)).code).toBe(REJECTION_CODES.invalidInput);
      expect(shown(String(toolMessage(attempt.messages).content))).toContainEqual(fault('neighbor_undecided', 'questions'));
      expect(String(toolMessage(attempt.messages).content)).not.toContain('replies_remaining');
      state = recordToolAttempt(state, attempt, registry);
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
      state = recordToolAttempt(state, attempt, registry);
    }
    expect(state).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS });
    expect(state.rejections).toHaveLength(MAX_TOOL_PROVIDER_CALLS);
  });

  it('keeps schema correction choices on a rejected report (D-102)', async () => {
    const schema = z.object({ start: z.enum(['B1', 'B2']) });
    const admitted = validateToolCandidate(schema, { start: 'Missing' });
    if (admitted.success) throw new Error('Expected invalid block');
    const { rejection } = admitted;
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
      priorState: recordToolAttempt(initialToolPhaseAttemptState('synthesis'), first, registry),
    });
    expect(shown(String(toolMessage(second.messages).content))).toContainEqual({ ...fault('enum', 'start'), allowed: ['B1', 'B2'] });
    assertToolPairingWellFormed(second.messages);
  });

  it('keeps every large rejected call paired with its complete repair message (D-097)', async () => {
    const newest = [new AIMessage({ content: '', tool_calls: [{ id: 'large', name: 'lineage_present_result', args: {
      sections: [{ label: 'Sources', text: 'SQL-supported finding. '.repeat(12000) }],
    } }] }), new ToolMessage({ tool_call_id: 'large', name: 'lineage_present_result', status: 'error',
      content: 'sections.0.label is invalid. All report text is held. Correct the named section label and resend sections. Last reply for this step.' })];
    const state = { ...initialToolPhaseAttemptState('synthesis'), messages: [
      new AIMessage({ content: '', tool_calls: [{ id: 'old', name: 'lineage_present_result', args: {} }] }),
      new ToolMessage({ tool_call_id: 'old', content: 'The earlier call was incomplete.' }), ...newest,
    ] };
    const context = renderToolAttemptContext(state);
    expect(context).toEqual(state.messages);
    expect(context.slice(-newest.length)).toEqual(newest);
    assertToolPairingWellFormed(context);
  });

  it('delivers schema-level column choices for each failed field without diagnostic clipping', async () => {
    const columns = Array.from({ length: 400 }, (_, i) => `Column${i}`);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, {
      outCols: columns, outNode: false,
    });
    const input = { focus_node_id: 'focus', summary: 'A valid summary.', sections: { technical: 'A long valid finding. '.repeat(5000) },
      column_flow: [{ out_col: 'Missing', upstream_columns: [] }, { out_col: 'AlsoMissing', upstream_columns: [] }] };
    const parsed = validateToolCandidate(schema, input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected invalid columns');
    const rejection = parsed.rejection;
    const { registry } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const first = await executeToolAttempt(nativePort(() => [call('first', { query: 'Missing' })]).port, plan, { priorState: state });
    const initialFeedback = JSON.parse(String(toolMessage(first.messages).content));
    for (const path of ['column_flow.0.out_col', 'column_flow.1.out_col'])
      expect(shown(initialFeedback)).toContainEqual(fault('unknown_column', path));
    state = recordToolAttempt(state, first, registry);
    const second = await executeToolAttempt(nativePort(() => [call('second', { query: 'MissingInput' })]).port, plan, { priorState: state });
    const content = String(toolMessage(second.messages).content);
    for (const path of ['column_flow.0.out_col', 'column_flow.1.out_col']) {
      const error = shown(content).find(item => item.path === path);
      expect(error).toMatchObject(fault('unknown_column', path));
      expect(error!.allowed).toHaveLength(columns.length);
      expect(new Set(error!.allowed).size).toBe(error!.allowed!.length);
      expect(error!.allowed!.every(value => columns.includes(value))).toBe(true);
      expect(error).not.toHaveProperty('more');
      expect([...error!.allowed!].sort()).toEqual([...columns].sort());
    }
    expect(content).not.toContain(input.sections.technical);
  });

  it.each([3, 400].flatMap(count => ['column', 'neighbor', 'enum'].map(kind => ({ count, kind }))))('delivers faults and guidance first and all $count $kind choices from the second feedback on, without domain inference', async ({ count, kind }) => {
    const columns = Array.from({ length: count }, (_, i) => `VerifiedColumn${i}`);
    const path = kind === 'column' ? 'column_flow.0.upstream_columns.0.col' : kind === 'neighbor' ? 'questions.0.nodeId' : 'query';
    const code: IssueCode = kind === 'enum' ? 'enum' : kind === 'column' ? 'unknown_column' : 'not_neighbor';
    const invalidEnum = validateToolCandidate(z.object({ query: z.enum(columns as [string, ...string[]]) }), { query: 'Missing' });
    if (invalidEnum.success) throw new Error('Expected invalid enum');
    const rejection = kind === 'enum' ? { ...invalidEnum.rejection, code: 'invalid_input' }
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
    state = recordToolAttempt(state, first, registry);
    for (const [index, query] of ['StillMissing', 'StillMissing2'].entries()) {
      const next = await executeToolAttempt(nativePort(() => [call(`retry-${index}`, { query })]).port, plan, { priorState: state });
      const content = String(toolMessage(next.messages).content);
      expect(content).not.toContain('replies_remaining');
      const error = shown(content).find(item => item.path === path);
      expect(error).toMatchObject(fault(code, path));
      expect(error!.allowed).toHaveLength(columns.length);
      expect(new Set(error!.allowed).size).toBe(error!.allowed!.length);
      expect(error!.allowed!.every(value => columns.includes(value))).toBe(true);
      expect(error).not.toHaveProperty('more');
      expect([...error!.allowed!].sort()).toEqual([...columns].sort());
      expect(content).not.toMatch(/Recheck the named column|Rebuild the defective fields|Re-evaluate the proposed action/);
      if (count === 400 && kind !== 'enum') expect(next.rejections[0].detail).toMatchObject({ omitted: true });
      state = recordToolAttempt(state, next, registry);
    }
    const finalModel = nativePort(() => [call('fourth', { query: 'StillMissing3' })]);
    const fourth = await executeToolAttempt(finalModel.port, plan, { priorState: state });
    expect(JSON.stringify(finalModel.sendRequest.mock.calls)).toContain('VerifiedColumn0');
    expect(recordToolAttempt(state, fourth, registry)).toMatchObject({ stopReason: 'no_progress', providerCalls: MAX_TOOL_PROVIDER_CALLS });
    expect(recordToolAttempt(state, fourth, registry).rejections).toHaveLength(MAX_TOOL_PROVIDER_CALLS);
  });

  it('retains column facts first and object-qualified owner choices on the last correction', async () => {
    const columns = ['OrderAmount', 'RegionCode', 'Discount'];
    const rejection = buildRouteValidationRejection([{
      kind: 'bad_contributor_col',
      id: '[ai].[salesstaging]',
      path: 'column_flow.0.upstream_columns.0.col',
      reason: 'Column "OrderAmt" does not exist on contributor "[ai].[salesstaging]".',
      allowed_values: columns,
      when: { node: '[ai].[salesstaging]' },
    }]);
    expect(rejection.code).toBe(REJECTION_CODES.invalidInput);
    const { registry } = registryWith(() => JSON.stringify(rejection));
    const plan = discoveryPlan(registry);
    let state = initialToolPhaseAttemptState('discover');
    const first = await executeToolAttempt(nativePort(() => [call('first', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    const firstFeedback = JSON.parse(String(toolMessage(first.messages).content));
    expect(firstFeedback.code).toBe(REJECTION_CODES.invalidInput);
    expect(shown(firstFeedback)).toEqual([fault('unknown_column', 'column_flow.0.upstream_columns.0.col')]);
    for (const absent of ['replies_remaining', 'detail', 'reason', 'hint']) expect(firstFeedback).not.toHaveProperty(absent);
    expect(toolMessage(first.messages).artifact).toMatchObject({ detail: expect.arrayContaining([expect.objectContaining({
      path: 'column_flow.0.upstream_columns.0.col', allowed_values: columns, when: { node: '[ai].[salesstaging]' },
    })]) });
    state = recordToolAttempt(state, first, registry);
    const second = await executeToolAttempt(nativePort(() => [call('second', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    const content = String(toolMessage(second.messages).content);
    expect(shown(content)).toContainEqual({ ...fault('unknown_column', 'column_flow.0.upstream_columns.0.col'), allowed: [...columns].sort() });
    expect(content).not.toContain('Recheck the named column');
    state = recordToolAttempt(state, second, registry);
    const third = await executeToolAttempt(nativePort(() => [call('third', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    const thirdContent = String(toolMessage(third.messages).content);
    expect(thirdContent).not.toContain('Recheck the named column');
    expect(thirdContent).not.toContain('not a column of');
    expect(third.observations).toEqual([]);
    state = recordToolAttempt(state, third, registry);
    expect(state.stopReason).toBeNull();
    const fourth = await executeToolAttempt(nativePort(() => [call('fourth', { query: 'OrderAmount' })]).port, plan, { priorState: state });
    expect(recordToolAttempt(state, fourth, registry).stopReason).toBe('no_progress');
  });

  it('states a call-level coded fault and correction, never a logs-only reason (D-103)', async () => {
    const { registry } = registryWith(() => JSON.stringify(makeRejection({ code: 'off_policy', reason: 'LOGS_ONLY_REASON', errors: at('off_policy') })));
    const model = nativePort(() => [call('c1', { query: 'Orders' })]);
    const attempt = await executeToolAttempt(model.port, discoveryPlan(registry), { priorState: initialToolPhaseAttemptState('discover') });
    const content = String(toolMessage(attempt.messages).content);
    expect(JSON.parse(content)).toEqual({ code: 'off_policy', attempt: '1/3', resend: [],
      errors: [fault('off_policy')] });
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
    state = recordToolAttempt(state, first, registry);
    const same = await executeToolAttempt(nativePort(() => [call('c2', { query: 'Orders' })]).port, plan, { priorState: state });
    expect(String(toolMessage(same.messages).content)).toContain(ISSUES.identical_resend.label);
    expect(toolMessage(same.messages).artifact).toMatchObject({ code: 'not_found', reason: 'No object matches.' });
    const changed = await executeToolAttempt(nativePort(() => [call('c3', { query: 'Sales' })]).port, plan, { priorState: recordToolAttempt(state, same, registry) });
    expect(String(toolMessage(changed.messages).content)).not.toContain(ISSUES.identical_resend.label);
  });

  it('an unchanged resend of a schema-rejected call is named as such too', async () => {
    const { registry } = registryWith(() => '{}');
    const plan = discoveryPlan(registry);
    const first = await executeToolAttempt(nativePort(() => [call('c1', { query: '' , extra: 1 })]).port, plan, { priorState: initialToolPhaseAttemptState('discover') });
    const state = recordToolAttempt(initialToolPhaseAttemptState('discover'), first, registry);
    const same = await executeToolAttempt(nativePort(() => [call('c2', { extra: 1, query: '' })]).port, plan, { priorState: state });
    expect(String(toolMessage(same.messages).content)).toContain(ISSUES.identical_resend.label);
  });

  it('a read repeated from an earlier reply is a duplicate_read naming the accepted call', async () => {
    const { registry, invoke } = registryWith(() => JSON.stringify({ results: [] }));
    const model = nativePort(() => [call('again', { query: 'Orders' })]);
    const plan = discoveryPlan(registry);
    const first = await executeToolAttempt(model.port, plan);
    const state = recordToolAttempt(initialToolPhaseAttemptState('discover'), first, registry);
    const second = await executeToolAttempt(model.port, plan, { priorState: state });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(toolMessage(second.messages).artifact).toMatchObject({ code: REJECTION_CODES.invalidInput, detail: { acceptedCallId: 'again' } });
    expect(recordToolAttempt(state, second, registry).noProgressCalls).toBe(1);
  });

  it('a read repeated after its result was trimmed from the transcript is answered with the held result', async () => {
    const { registry, invoke } = registryWith(() => JSON.stringify({ results: ['held'] }));
    const model = nativePort(() => [call('again', { query: 'Orders' })]);
    const plan = discoveryPlan(registry);
    const first = await executeToolAttempt(model.port, plan);
    const trimmed = { ...recordToolAttempt(initialToolPhaseAttemptState('discover'), first, registry), messages: [] };
    const second = await executeToolAttempt(model.port, plan, { priorState: trimmed });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(second.rejections).toEqual([]);
    expect(toolMessage(second.messages).status).toBe('success');
    expect(String(toolMessage(second.messages).content)).toContain('held');
  });

  it.each([false, true])('oversized reads retain the refusal with trimmed history=%s (Approved08)', async trimmed => {
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
        expect(result).toMatchObject({ status: 'error', artifact: { code: 'invalid_input', errors: [{ path: '', code: 'result_too_large' }] } });
        expect(String(result.content)).toContain(ISSUES.result_too_large.correction);
      }
      state = { ...recordToolAttempt(state, attempt, registry), ...(trimmed ? { messages: [] } : {}) };
    }
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ noProgressCalls: MAX_TOOL_PROVIDER_CALLS, stopReason: 'no_progress' });
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
  function hop(mode: 'bb' | 'ct' = 'ct', classification: 'business' | 'technical' | 'both' = 'technical', declaredColumns = sourceColumns) {
    const nodes = [root, source, other].map(id => makeNode({ id, schema: 'd', name: id, type: 'view', bodyScript: 'SELECT 1 AS Value, 2 AS Other;',
      columns: (id === source ? declaredColumns : ['Value', 'Other']).map(col) }));
    const pairs: [string, string][] = [[source, root], [other, root]];
    const indexed = makeIndexedModel(nodes, pairs), graph = makeGraph(nodes, pairs);
    const session = new AiSession();
    session.model = indexed;
    session.graph = graph;
    session.classification = classification;
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
    let rawErrors: Array<{ path: string; code: string }> | undefined;
    registry.register({ name: 'lineage_submit_findings', inputSchema: submitFindingsSchemaForMode(mode, classification, true, engine.hopSubmitColumns, false),
      effect: 'hop_commit', execute: async (sent: unknown) => {
        const result = await executeSubmitFindings(sent, services);
        rawErrors = (JSON.parse(result) as { errors?: typeof rawErrors }).errors;
        return result;
      } });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: mode === 'ct' ? 'sm_ct' : 'sm_bb' }, registry,
      messages: [new HumanMessage('Inspect Root.')], sink: new TurnEventSink(() => {}),
      facts: explorationFacts(mode, mode === 'ct' ? ['Value', 'Other'] : [], { classification, memorySections: [] }),
      hopColumns: () => engine.hopSubmitColumns,
      requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required' });
    let state = initialToolPhaseAttemptState(plan.frame.phase);
    const send = async (input: unknown) => {
      const lines: string[] = [];
      const native = nativePort(() => [call(`c${state.providerCalls}`, input, 'lineage_submit_findings')]);
      const attempt = await executeToolAttempt(native.port, plan, { priorState: state, debugLog: line => lines.push(line) });
      state = recordToolAttempt(state, attempt, registry);
      const content = String(toolMessage(attempt.messages).content);
      const problem = attempt.rejections.length ? problemOf(content) : undefined;
      const [, options] = native.sendRequest.mock.calls.at(-1) as unknown as [unknown[], { tools: Array<{ name: string; inputSchema: object }> }];
      const wire = options.tools.find(tool => tool.name === 'lineage_submit_findings')!.inputSchema;
      return { attempt, content, lines, wire, rawErrors, rejection: problem ? { ...problem, errors: shown(problem) } : undefined };
    };
    return { engine, send, state: () => state };
  }


  // Literal contract cases: no served-schema mutations, powersets or field × retry products.
  // Each expected path/code is authored here; the provider schema is only an acceptance boundary.
  const bothSections = { business: 'business: exact authored findings.', technical: 'technical: exact authored findings.' };
  const mappedFlow = [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0', transforms: ['pass_through'], note: 'Declared source.' }] }, terminals[1]];
  const sourceQuestion = { nodeId: source, question: 'Explain this supplied neighbor.' };
  const otherPrune = { id: other, reason: 'No requested contribution.' };
  const literalFaults = [
    { name: 'summary missing', patch: { summary: undefined }, path: 'summary', code: 'missing' },
    { name: 'summary type', patch: { summary: 42 }, path: 'summary', code: 'type' },
    { name: 'badge type', patch: { badge_label: 42 }, path: 'badge_label', code: 'type' },
    { name: 'badge empty', patch: { badge_label: '' }, path: 'badge_label', code: 'size', also: ['invalid'] },
    { name: 'badge bound', patch: { badge_label: 'x'.repeat(51) }, path: 'badge_label', code: 'size' },
    { name: 'badge whitespace', patch: { badge_label: ' ' }, path: 'badge_label', code: 'invalid' },
    { name: 'sections missing', patch: { sections: undefined }, path: 'sections', code: 'missing' },
    { name: 'sections type', patch: { sections: 42 }, path: 'sections', code: 'type' },
    { name: 'business missing', patch: { sections: { technical: bothSections.technical } }, path: 'sections.business', code: 'missing' },
    { name: 'business type', patch: { sections: { ...bothSections, business: 42 } }, path: 'sections.business', code: 'type' },
    { name: 'business blank', patch: { sections: { ...bothSections, business: '' } }, path: 'sections.business', code: 'invalid' },
    { name: 'technical missing', patch: { sections: { business: bothSections.business } }, path: 'sections.technical', code: 'missing' },
    { name: 'technical type', patch: { sections: { ...bothSections, technical: 42 } }, path: 'sections.technical', code: 'type' },
    { name: 'technical blank', patch: { sections: { ...bothSections, technical: '' } }, path: 'sections.technical', code: 'invalid' },
    { name: 'sections strict keys', patch: { sections: { ...bothSections, __unsupported__: true } }, path: 'sections.__unsupported__', code: 'unknown_key' },
    { name: 'flow missing', patch: { column_flow: undefined }, path: 'column_flow', code: 'missing' },
    { name: 'flow type', patch: { column_flow: 42 }, path: 'column_flow', code: 'type' },
    { name: 'flow row type', patch: { column_flow: [42, terminals[1]] }, path: 'column_flow.0', code: 'type' },
    { name: 'output missing', patch: { column_flow: [{ upstream_columns: [] }, terminals[1]] }, path: 'column_flow.0.out_col', code: 'missing' },
    { name: 'output type', patch: { column_flow: [{ out_col: 42, upstream_columns: [] }, terminals[1]] }, path: 'column_flow.0.out_col', code: 'type' },
    { name: 'output metadata', patch: { column_flow: [{ out_col: 'Missing', upstream_columns: [] }, terminals[1]] }, path: 'column_flow.0.out_col', code: 'unknown_column' },
    { name: 'suppliers missing', patch: { column_flow: [{ out_col: 'Value' }, terminals[1]] }, path: 'column_flow.0.upstream_columns', code: 'missing' },
    { name: 'suppliers type', patch: { column_flow: [{ out_col: 'Value', upstream_columns: 42 }, terminals[1]] }, path: 'column_flow.0.upstream_columns', code: 'type' },
    { name: 'supplier type', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [42] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0', code: 'type' },
    { name: 'supplier column metadata', patch: { column_flow: missingColumn }, path: 'column_flow.0.upstream_columns.0.col', code: 'unknown_column' },
    { name: 'supplier node missing', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ col: 'C0' }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.node', code: 'missing' },
    { name: 'supplier node type', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: 42, col: 'C0' }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.node', code: 'type' },
    { name: 'supplier neighbor', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: absent, col: 'C0' }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.node', code: 'not_neighbor' },
    { name: 'supplier column missing', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.col', code: 'missing' },
    { name: 'supplier column type', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 42 }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.col', code: 'type' },
    { name: 'transforms type', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0', transforms: 42 }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.transforms', code: 'type' },
    { name: 'transform item type', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0', transforms: [42] }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.transforms.0', code: 'enum' },
    { name: 'transform enum', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0', transforms: ['bogus'] }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.transforms.0', code: 'enum' },
    { name: 'supplier note type', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0', note: 42 }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.note', code: 'type' },
    { name: 'supplier strict keys', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0', __unsupported__: true }] }, terminals[1]] }, path: 'column_flow.0.upstream_columns.0.__unsupported__', code: 'unknown_key' },
    { name: 'flow strict keys', patch: { column_flow: [{ out_col: 'Value', upstream_columns: [], __unsupported__: true }, terminals[1]] }, path: 'column_flow.0.__unsupported__', code: 'unknown_key' },
    { name: 'questions type', patch: { questions: 42 }, path: 'questions', code: 'type' },
    { name: 'questions bound', patch: { questions: Array.from({ length: 501 }, () => sourceQuestion) }, path: 'questions', code: 'size' },
    { name: 'question row type', patch: { questions: [42] }, path: 'questions.0', code: 'type' },
    { name: 'question node missing', patch: { questions: [{ question: sourceQuestion.question }] }, path: 'questions.0.nodeId', code: 'missing' },
    { name: 'question node type', patch: { questions: [{ ...sourceQuestion, nodeId: 42 }] }, path: 'questions.0.nodeId', code: 'type' },
    { name: 'question neighbor', patch: { questions: [{ ...sourceQuestion, nodeId: absent }] }, path: 'questions.0.nodeId', code: 'not_neighbor' },
    { name: 'question text missing', patch: { questions: [{ nodeId: source }] }, path: 'questions.0.question', code: 'missing' },
    { name: 'question text type', patch: { questions: [{ ...sourceQuestion, question: 42 }] }, path: 'questions.0.question', code: 'type' },
    { name: 'question text blank', patch: { questions: [{ ...sourceQuestion, question: '' }] }, path: 'questions.0.question', code: 'size' },
    { name: 'question strict keys', patch: { questions: [{ ...sourceQuestion, __unsupported__: true }] }, path: 'questions.0.__unsupported__', code: 'unknown_key' },
    { name: 'prunes type', patch: { prune_neighbors: 42 }, path: 'prune_neighbors', code: 'type' },
    { name: 'prunes bound', patch: { prune_neighbors: Array.from({ length: 501 }, () => otherPrune) }, path: 'prune_neighbors', code: 'size' },
    { name: 'prune row type', patch: { prune_neighbors: [42] }, path: 'prune_neighbors.0', code: 'type' },
    { name: 'prune id missing', patch: { prune_neighbors: [{ reason: otherPrune.reason }] }, path: 'prune_neighbors.0.id', code: 'missing' },
    { name: 'prune id type', patch: { prune_neighbors: [{ ...otherPrune, id: 42 }] }, path: 'prune_neighbors.0.id', code: 'type' },
    { name: 'prune neighbor', patch: { prune_neighbors: [{ ...otherPrune, id: absent }] }, path: 'prune_neighbors.0.id', code: 'prune_target' },
    { name: 'prune reason missing', patch: { prune_neighbors: [{ id: other }] }, path: 'prune_neighbors.0.reason', code: 'missing' },
    { name: 'prune reason type', patch: { prune_neighbors: [{ ...otherPrune, reason: 42 }] }, path: 'prune_neighbors.0.reason', code: 'type' },
    { name: 'prune reason empty', patch: { prune_neighbors: [{ ...otherPrune, reason: '' }] }, path: 'prune_neighbors.0.reason', code: 'size', also: ['invalid'] },
    { name: 'prune reason whitespace', patch: { prune_neighbors: [{ ...otherPrune, reason: ' ' }] }, path: 'prune_neighbors.0.reason', code: 'invalid' },
    { name: 'prune strict keys', patch: { prune_neighbors: [{ ...otherPrune, __unsupported__: true }] }, path: 'prune_neighbors.0.__unsupported__', code: 'unknown_key' },
    { name: 'call strict keys', patch: { __unsupported__: true }, path: '__unsupported__', code: 'unknown_key' },
  ];
  const findingScenarios = [
    ...literalFaults.map(row => ({ name: row.name, mode: 'ct' as const, classification: 'both' as const, correctAt: 2, single: row })),
    ...(['bb', 'ct'] as const).flatMap(mode => (['business', 'technical', 'both'] as const).map(classification => ({
      name: 'maximum-independent-bundle', mode, classification, correctAt: 2, single: undefined,
    }))),
    ...(['bb', 'ct'] as const).flatMap(mode => [3, 4, null].map(correctAt => ({
      name: 'shared-finding-draft-temporal', mode, classification: 'both' as const, correctAt, single: undefined,
    }))),
  ];
  it.each(findingScenarios)('native finding rule: $name ($mode/$classification, correction=$correctAt)', async ({ mode, classification, correctAt, single }) => {
    const angles = classification === 'both' ? ['business', 'technical'] : [classification];
    const complete: Record<string, unknown> = { summary: base.summary, badge_label: 'Source role',
      sections: Object.fromEntries(angles.map(angle => [angle, `${angle}: exact authored findings.`])),
      ...(mode === 'ct' ? { column_flow: mappedFlow } : {}), questions: [sourceQuestion], prune_neighbors: [otherPrune] };
    const patch = single?.patch ?? { summary: 42, badge_label: 'x'.repeat(51), sections: 42,
      questions: 42, prune_neighbors: 42, unknown: true, ...(mode === 'ct' ? { column_flow: missingColumn } : {}) };
    const initial = Object.fromEntries(Object.entries({ ...complete, ...patch }).filter(([, value]) => value !== undefined));
    const fields = Object.keys(patch);
    const expected = single ? [single.code, ...(single.also ?? [])].map(code => ({ path: single.path, code })) : [
      { path: 'summary', code: 'type' }, { path: 'badge_label', code: 'size' }, { path: 'sections', code: 'type' },
      { path: 'questions', code: 'type' }, { path: 'prune_neighbors', code: 'type' }, { path: 'unknown', code: 'unknown_key' },
      ...(mode === 'ct' ? [{ path: 'column_flow.0.upstream_columns.0.col', code: 'unknown_column' }] : []),
    ];
    const correction = Object.fromEntries(fields.filter(field => Object.hasOwn(complete, field)).map(field => [field, complete[field]]));
    const { engine, send, state } = hop(mode, classification);
    const before = engine.toJSON();
    let firstWire: unknown;
    for (let stage = 1; stage < (correctAt ?? 4); stage++) {
      const rejected = await send(initial);
      assert(rejected.rejection);
      firstWire ??= rejected.wire;
      expect(rejected.wire).toEqual(firstWire);
      expect(rejected.rawErrors!.filter(error => !['identical_resend', 'not_overwritten'].includes(error.code))
        .map(({ path, code }) => ({ path, code })).sort((a, b) => a.path.localeCompare(b.path)))
        .toEqual([...expected].sort((a, b) => a.path.localeCompare(b.path)));
      if (stage >= 2 && mode === 'ct' && !single) expect(rejected.rejection.errors.find(error => error.path === 'column_flow.0.upstream_columns.0.col')?.allowed).toEqual(sourceColumns);
      expect(rejected.rejection.attempt).toBe(`${stage}/3`);
      expect(rejected.rejection.notice !== undefined).toBe(stage === 3);
      for (const error of rejected.rejection.errors) {
        if (stage === 1) expect(error).not.toHaveProperty('allowed');
        const issue = ISSUES[error.code];
        if ('fallback' in issue) expect(error.message.includes(issue.fallback)).toBe(stage === 3);
      }
      expect(hasFallback(rejected.rejection)).toBe(stage === 3 && mode === 'ct');
      expect(engine.getDetailSlots()).toEqual([]);
      expect(engine.columnAspect?.edges ?? []).toEqual([]);
      expect(engine.toJSON().agenda).toEqual(before.agenda);
      expect(rejected.content).not.toContain(base.summary);
      for (const text of Object.values(complete.sections as Record<string, string>)) expect(rejected.content).not.toContain(text);
      expect(state().stopReason).toBeNull();
      expect(new Ajv({ strict: false }).compile(rejected.wire)(correction)).toBe(true);
    }
    const result = await send(correctAt === null ? initial : correction);
    expect(state().providerCalls).toBe(correctAt ?? 4);
    if (correctAt === null) {
      expect(state()).toMatchObject({ stopReason: 'no_progress', noProgressCalls: 4 });
      expect(engine.getDetailSlots()).toEqual([]);
      expect(engine.columnAspect?.edges ?? []).toEqual([]);
      expect(engine.toJSON().agenda).toEqual(before.agenda);
    } else {
      expect(result.attempt.rejections).toEqual([]);
      expect(result.attempt.stop).toBe('phase_complete');
      expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ summary: complete.summary, badge_label: complete.badge_label,
        sections: angles.map(angle => ({ angle, text: `${angle}: exact authored findings.` })) }));
      expect(engine.toJSON().removedSet).toContain(other);
      if (mode === 'ct') expect(engine.columnAspect?.edges).toEqual([expect.objectContaining({
        from_node: source, from_col: 'C0', to_node: root, to_col: 'Value', transforms: ['pass_through'], note: 'Declared source.',
      })]);
    }
  });

  it.each(['repair', 'continued_wrong'] as const)('keeps the three-correction budget when a retry introduces a new fault: %s', async arm => {
    const { engine, send, state } = hop();
    const initial = { ...base, badge_label: 'x'.repeat(51), column_flow: terminals,
      questions: [source, other].map(nodeId => ({ nodeId, question: 'Explain this supplied neighbor.' })) };
    const steps = [initial, { badge_label: 'Source role', summary: 42 },
      ...(arm === 'repair' ? [{ badge_label: 'Source role' }]
        : [{ sections: { technical: 42 } }, { sections: { technical: 43 } }])];
    const expectedPaths = [['badge_label'], ['summary', 'summary'], ...(arm === 'repair' ? [[]] : [['sections.technical', 'sections'], ['sections.technical', 'sections.technical']])];
    for (const [index, input] of steps.entries()) {
      const result = await send(input);
      expect(result.rejection ? paths(result.rejection).sort() : []).toEqual([...expectedPaths[index]].sort());
      expect(state().providerCalls).toBe(index + 1);
      if (index < steps.length - 1) expect(state().noProgressCalls).toBe(index + 1);
      const target = process.env.DLV_REJECTION_CONTROL_OUTPUT;
      if (target) appendFileSync(target, JSON.stringify({ caseId: `ct-new-faults-${arm}`, arm,
        mode: 'ct', classification: 'technical', phase: 'active', attemptOrdinal: index + 1,
        declaredFaults: ['badge bound', 'new summary type', ...(arm === 'continued_wrong' ? ['new section type'] : [])],
        modelVisibleFeedback: result.content, resendFields: result.rejection?.resend ?? [],
        faults: result.rejection?.errors ?? [], submittedFields: Object.keys(input),
        deliveredFindings: engine.getDetailSlots(),
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
    assert(first.rejection, 'Expected a rejected submission');
    expect(paths(first.rejection).sort()).toEqual(['badge_label', 'summary']);
    expect(first.rejection.resend.sort()).toEqual(['badge_label', 'summary']);
    expect(first.rejection.errors).toEqual(expect.arrayContaining([fault('type', 'summary'), fault('type', 'badge_label')]));
    for (const error of first.rejection.errors) expect(Object.keys(error).sort()).toEqual(['code', 'message', 'path']);
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
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
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
    assert(first.rejection, 'Expected a rejected submission');
    expect(first.attempt.rejections).toHaveLength(1);
    expect(JSON.stringify(first.rejection)).toContain(other);
    expect(first.rejection.resend).toEqual(['questions', 'prune_neighbors', 'column_flow']);
    expect(first.rejection.errors).toContainEqual({ ...fault('neighbor_undecided'), allowed: [other] });
    expect(first.rejection).not.toHaveProperty('way_out');
    expect(first.rejection).not.toHaveProperty('example');
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.getDetailSlots()).toEqual([]);
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ summary: true, sections: ['technical'], resend: [] });
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
      { out_col: 'Other', upstream_columns: [{ node: source, col: 'C1', transforms: ['bogus'] }], out_node: source },
    ] });
    assert(first.rejection, 'Expected a rejected submission');
    expect(first.attempt.rejections).toHaveLength(1);
    const expected = ['column_flow.0.upstream_columns.0.node', 'column_flow.0.upstream_columns.1.col',
      'column_flow.1.out_node', 'column_flow.1.upstream_columns.0.transforms.0'];
    expect(paths(first.rejection).sort()).toEqual(expected);
    expect(first.rejection.resend).toEqual(['column_flow']);
    for (const path of expected) {
      const error = first.rejection.errors.find(error => error.path === path);
      assert(error, `Expected a fault at ${path}`);
      expect(Object.keys(error).sort()).toEqual(['code', 'message', 'path']);
    }
    for (const absentKey of ['replies_remaining', 'example', 'way_out', 'reason', 'hint', 'detail']) expect(first.rejection).not.toHaveProperty(absentKey);
  });

  it('keeps a partial correction: the held draft advances and only the remaining fault is owed', async () => {
    const { engine, send } = hop();
    const first = await send({ ...base, badge_label: 'x'.repeat(51), questions: [{ nodeId: absent, question: 'Explain Absent.' }],
      prune_neighbors: [{ id: absent, reason: 'Outside.' }], column_flow: missingColumn });
    assert(first.rejection, 'Expected a rejected submission');
    expect(paths(first.rejection).sort()).toEqual(['badge_label', 'column_flow.0.upstream_columns.0.col', 'prune_neighbors.0.id', 'questions.0.nodeId']);
    expect([...first.rejection.resend].sort()).toEqual(['badge_label', 'column_flow', 'prune_neighbors', 'questions']);
    const second = await send({ focus_node_id: root, badge_label: 'Source role', questions: [source, other].map(nodeId => ({ nodeId, question: 'Explain this neighboring SQL.' })), prune_neighbors: [], column_flow: missingColumn });
    assert(second.rejection, 'Expected a rejected submission');
    expect(second.attempt.rejections).toHaveLength(1);
    expect(paths(second.rejection)).toEqual(['column_flow.0.upstream_columns.0.col']);
    expect(second.rejection.resend).toEqual(['column_flow']);
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ summary: true, sections: ['technical'], resend: ['column_flow'],
      fields: expect.arrayContaining(['badge_label', 'questions', 'prune_neighbors']) });
    // Feedback 2 carries the complete allowed list; the leave-out instruction waits for feedback 3 (D-105).
    expect(second.rejection.errors[0].allowed).toEqual(sourceColumns);
    for (const rejection of [first.rejection, second.rejection]) expect(hasFallback(rejection)).toBe(false);
    const third = await send({ focus_node_id: root, column_flow: [] });
    expect(third.attempt.stop).toBe('phase_complete');
    expect(third.content).toContain('ended_columns');
    expect(third.content).not.toContain('Missing');
  });

  it('accepts a formerly clipped metadata choice while preserving held findings (Approved08 D-105)', async () => {
    const columns = Array.from({ length: 24 }, (_, index) => `C${index}`);
    const { engine, send } = hop('ct', 'technical', columns);
    const questions = [{ nodeId: other, question: 'Explain the other source.' }];
    await send({ ...base, column_flow: missingColumn, questions });
    const second = await send({ column_flow: missingColumn });
    const allowed = second.rejection!.errors.find(error => error.path === 'column_flow.0.upstream_columns.0.col')!.allowed!;
    expect([...allowed].sort()).toEqual([...columns].sort());
    expect(allowed.indexOf('C9')).toBeGreaterThanOrEqual(15);
    expect(engine.getDetailSlots()).toEqual([]);
    const accepted = await send({ column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C9' }] }, terminals[1]] });
    expect(accepted.attempt.rejections).toEqual([]);
    expect(accepted.attempt.stop).toBe('phase_complete');
    expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ summary: base.summary,
      sections: [{ angle: 'technical', text: base.sections.technical }] }));
    expect(engine.columnAspect!.edges).toContainEqual(expect.objectContaining({ from_node: source, from_col: 'C9', to_node: root, to_col: 'Value' }));
  });

  it('a report column reference gets its historical fallback only at reply 3 with the last-correction notice (D-105)', async () => {
    const { send } = hop();
    const replies = [];
    for (let n = 1; n <= 3; n++) replies.push(await send({ ...base, column_flow: missingColumn }));
    const leaf = 'column_flow.0.upstream_columns.0.col';
    for (const [index, reply] of replies.entries()) {
      const error = reply.rejection!.errors.find(item => item.path === leaf);
      expect(error).toBeDefined();
      expect(error).toMatchObject(fault('unknown_column', leaf));
      expect(hasFallback(reply.rejection!)).toBe(index === 2);
      expect(reply.rejection!.resend).toContain('column_flow');
      expect(reply.rejection!.resend.includes('sections')).toBe(index === 2);
      expect(reply.rejection!.notice).toBe(index === 2 ? LAST_CORRECTION : undefined);
      expect(reply.lines.filter(line => line.startsWith('[ToolOutcome]') && line.includes(' fallback=true'))).toHaveLength(index === 2 ? 1 : 0);
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
    assert(second.rejection, 'Expected a rejected submission');
    expect(second.rejection.resend).toEqual(['prune_neighbors']);
    expect(second.rejection.errors).toEqual([{ ...fault('prune_target', 'prune_neighbors.0.id'), allowed: [source, other].sort() }]);
    expect(hasFallback(second.rejection)).toBe(false);
    const third = await send({ focus_node_id: root, prune_neighbors: [{ id: absent, reason: 'Still outside.' }] });
    assert(third.rejection, 'Expected a rejected submission');
    expect(third.rejection.errors).toEqual([{ ...fault('prune_target', 'prune_neighbors.0.id'), allowed: [source, other].sort() }]);
    expect(hasFallback(third.rejection)).toBe(false);
    const exit = { prune_neighbors: [] };
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldPartsOfCurrentFocus()?.fields.includes('column_flow') ?? false);
    expect(schema.safeParse({ focus_node_id: root, ...exit }).success).toBe(true);
    const fourth = await send({ focus_node_id: root, ...exit });
    expect(fourth.attempt.stop).toBe('phase_complete');
    expect(engine.columnAspect?.edges).toHaveLength(2);
    expect(engine.columnAspect?.edges).toEqual(expect.arrayContaining(flow.map(entry =>
      expect.objectContaining({ from_node: entry.upstream_columns[0].node, from_col: entry.upstream_columns[0].col, to_node: root, to_col: entry.out_col }))));
    expect(engine.getDetailSlots()).toEqual(expect.arrayContaining([expect.objectContaining({ sections: [{ angle: 'technical', text: base.sections.technical }] })]));
  });
  it('withdraws an omitted failing optional field and names it in the acknowledgement', async () => {
    const { engine, send } = hop();
    const first = await send({ ...base, column_flow: terminals, questions: [source, other].map(nodeId => ({ nodeId, question: 'Explain this neighboring SQL.' })), prune_neighbors: [{ id: absent, reason: 'Outside.' }] });
    assert(first.rejection, 'Expected a rejected submission');
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
    assert(second.rejection, 'Expected a rejected submission');
    // The resent list replaces the held one whole, so Other loses its outcome and both faults are reported together.
    expect(paths(second.rejection).sort()).toEqual(['', 'prune_neighbors', 'prune_neighbors.0.id']);
    expect(second.rejection.errors).toContainEqual({ ...fault('neighbor_undecided'), allowed: [other] });
    expect(second.rejection.resend).toEqual(['prune_neighbors', 'column_flow', 'questions']);
    const third = await send({ focus_node_id: root, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'C0' }] }, terminals[1]] });
    expect(third.attempt.stop).toBe('phase_complete');
    expect(engine.toJSON().removedSet).toEqual([other]);
  });
});

describe('tools are told apart by their registry effect, never by name', () => {
  it('a reply carries one presentation commit: the second call is not evaluated and the first rejection stays', async () => {
    const invoke = vi.fn(() => JSON.stringify(makeRejection({ code: REJECTION_CODES.invalidInput, errors: at('missing', ['name']) })));
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_present_result', inputSchema: z.object({ name: z.string() }).strict(), effect: 'presentation_commit', execute: invoke });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'completed' }, registry, messages: [new HumanMessage('Present the report.')],
      sink: new TurnEventSink(() => {}), facts: { memorySections: [] }, requiredTerminalTool: 'lineage_present_result', toolChoice: 'required' });
    const attempt = await executeToolAttempt(nativePort(() => [call('first', {}, 'lineage_present_result'), call('second', {}, 'lineage_present_result')]).port, plan);
    expect(invoke).toHaveBeenCalledOnce();
    expect(attempt.calls.map(item => item.status)).toEqual(['rejected', 'phase_closed']);
    expect((attempt.messages.filter(item => item instanceof ToolMessage) as ToolMessage[])[1].artifact).toMatchObject({ code: REJECTION_CODES.invalidInput });
    expect(attempt.rejections).toHaveLength(1);
  });

  it('a failure thrown inside a presentation commit counts against the turn; one thrown inside a read does not', async () => {
    const session = new AiSession();
    session.beginTurn(); session.enterLmStage({ kind: 'completed' }, session.turnEpoch);
    const registry = buildAiToolRegistry(() => session, { debug() {}, info() {}, warn() {}, error() {} } as never, () => undefined);
    await registry.invoke('lineage_search_objects', { query: 'Orders' });
    expect(session.presentResultFailureCountThisTurn).toBe(0);
    await registry.invoke('lineage_present_result', {});
    expect(session.presentResultFailureCountThisTurn).toBe(1);
  });
});

describe('tool-call notation inside a text argument', () => {
  const notationTool = () => {
    const invoke = vi.fn(() => '{"ok":true}');
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_search_objects', effect: 'read', modelDescription: 'Search objects.', execute: invoke,
      inputSchema: z.object({ query: z.string(), refs: z.array(z.string()).optional(), parts: z.array(z.object({ text: z.string() })).optional() }).strict() });
    return { registry, invoke };
  };
  const send = (registry: IToolRegistry<string>, input: object) => executeToolAttempt(nativePort(() => [call('notation', input)]).port, discoveryPlan(registry));

  it.each([
    { input: { query: 'a</parameter>\n<parameter name="refs">[]' }, paths: ['query'] },
    { input: { query: 'x', refs: ['[a].[b]</parameter>\n</invoke>'] }, paths: ['refs.0'] },
    { input: { query: 'x', parts: [{ text: 'fine' }, { text: '<invoke name="lineage_search_objects">' }] }, paths: ['parts.1.text'] },
    { input: { query: '</invoke>', refs: ['<parameter name="q">'] }, paths: ['query', 'refs.0'] },
  ])('refuses $paths of $input at its text values without dispatching the call', async ({ input, paths }) => {
    const { registry, invoke } = notationTool();
    const attempt = await send(registry, input);
    const message = toolMessage(attempt.messages);
    expect(invoke).not.toHaveBeenCalled();
    expect(message).toMatchObject({ status: 'error', artifact: { code: 'invalid_input', issuePaths: paths } });
    expect(shown(String(message.content))).toEqual(paths.map(path => expect.objectContaining({ path, code: 'tool_call_notation' })));
    expect(recordToolAttempt(initialToolPhaseAttemptState('discover'), attempt, registry)).toMatchObject({ noProgressCalls: 1, rejectedTerminalCalls: 0 });
  });

  it.each([
    'Keeps rows where Amount < Limit and Rate > 0.',
    'Reads the <summary> column, closes </summary> and the parameter name of each call.',
    'Shreds <row><parameter>1</parameter-list></row> with nodes().',
  ])('dispatches ordinary text: %s', async query => {
    const { registry, invoke } = notationTool();
    expect((await send(registry, { query })).rejections).toEqual([]);
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe('required terminal tool of an instruction plan', () => {
  it('refuses to compile a plan whose required terminal tool is not in the offered registry', () => {
    expect(() => compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: 'sm_bb' }, registry: new ToolRegistry<string>(),
      messages: [new HumanMessage('Inspect Root.')], sink: new TurnEventSink(() => {}), facts: explorationFacts('bb', [], { classification: 'technical' }),
      requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required' })).toThrow(/required terminal tool lineage_submit_findings is not available/);
  });
});

describe('a cancelled native generation', () => {
  const planWith = (registry: IToolRegistry<string>, signal: AbortSignal) => compileInstructionPlan({ kind: 'converse', stage: { kind: 'discover' }, registry,
    messages: [new HumanMessage('Which objects read Orders?')], sink: new TurnEventSink(() => {}), facts: { memorySections: [] }, toolChoice: 'auto', signal });

  it('dispatches nothing and never reaches the provider', async () => {
    const { registry, invoke } = registryWith(() => '{}');
    const controller = new AbortController(); controller.abort();
    const model = nativePort(() => [call('cancelled', { query: 'Sales' })]);
    expect((await executeToolAttempt(model.port, planWith(registry, controller.signal))).stop).toBe('cancelled');
    expect(invoke).not.toHaveBeenCalled();
    expect(model.sendRequest).not.toHaveBeenCalled();
  });

  it('returns no partial message group when a batch is cancelled between two tool calls', async () => {
    const { registry, invoke } = registryWith(() => '{}');
    const controller = new AbortController();
    invoke.mockImplementation(() => { controller.abort(); return '{}'; });
    const model = nativePort(() => [call('read-1', { query: 'Sales' }), call('read-2', { query: 'Orders' })]);
    const attempt = await executeToolAttempt(model.port, planWith(registry, controller.signal));
    expect(attempt.stop).toBe('cancelled');
    expect(invoke).toHaveBeenCalledOnce();
    expect(attempt.messages).toEqual([]);
  });
});
