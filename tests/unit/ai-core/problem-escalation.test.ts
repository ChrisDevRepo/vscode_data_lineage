/** Spec 08 / D-105 / D-099 / D-103: one flat `{code, attempt, errors, resend}` problem per rejection, escalated over three corrections, then the hop terminates. */
import { assert, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { z } from 'zod';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { compileInstructionPlan, explorationFacts } from '../../../src/ai/agent/instructionPlan';
import {
  executeToolAttempt,
  initialToolPhaseAttemptState,
  MAX_TOOL_PROVIDER_CALLS,
  recordToolAttempt,
  type ToolPhaseAttemptState,
} from '../../../src/ai/agent/toolAttempt';
import { modelToolCallMessage, type ModelPort } from '../../../src/ai/model/modelPort';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ToolRegistry } from '../../../src/ai/tools/registry';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { EMPTY_AI_TEMPLATES } from '../../../src/ai/session/types';
import { ISSUES, at as errorsAt, makeRejection, rejectionFromZodError, type ToolProblem } from '../../../src/ai/support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { SubmitFindingsModelSchema } from '../../../src/ai/tools/toolSchemas';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { makeGraph, makeIndexedModel, makeNode } from '../helpers/modelFixtures';

const TOOL = 'lineage_submit_findings';

function nativePort(parts: () => vscode.LanguageModelToolCallPart[]) {
  const sendRequest = vi.fn(async () => ({ stream: { async *[Symbol.asyncIterator]() { yield* parts(); } } }));
  return new VscodeModelPort(
    { id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1', maxInputTokens: 128000, countTokens: async () => 1, sendRequest } as never,
    { budget: createTurnTokenBudget({}) },
  );
}

/** A real BB hop at a view reading one table, driven through the real submit_findings handler and the dispatcher. */
function bbHop() {
  const source = makeNode({ id: '[dbo].[Source]', schema: 'dbo', name: 'Source', type: 'table' });
  const focus = makeNode({ id: '[dbo].[Report]', schema: 'dbo', name: 'Report', type: 'view', bodyScript: 'SELECT Value FROM dbo.Source;' });
  const model = makeIndexedModel([source, focus], [[source.id, focus.id]]);
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.model = model;
  session.classification = 'technical';
  const engine = new NavigationEngine(model, makeGraph([source, focus], [[source.id, focus.id]]), () => {}, { memory: session.memory });
  session.stateMachine = engine;
  expect(engine.init({ origin: focus.id, question: 'Explain Report.', direction: 'upstream', analysisMode: 'bb',
    depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
  engine.classification = 'technical';
  engine.getHopContext();
  const services = { getSession: () => session, turnEpoch: () => epoch, requireModel: () => model,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    logAndReturn: (_name: string, data: object) => JSON.stringify(data),
    toolError: (_name: string, error: unknown) => { throw error; },
  } as unknown as ToolServices;
  const registry = new ToolRegistry<string>();
  registry.register({ name: TOOL, inputSchema: SubmitFindingsModelSchema, effect: 'hop_commit', modelDescription: 'Submit findings.',
    execute: (input: unknown) => executeSubmitFindings(input, services) });
  const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: 'sm_bb' }, registry,
    messages: [new HumanMessage('Inspect the current object.')], sink: new TurnEventSink(() => {}),
    facts: explorationFacts('bb', [], { classification: 'technical', memorySections: [] }), hopColumns: () => engine.hopSubmitColumns,
    requiredTerminalTool: TOOL, toolChoice: 'required' });
  return { focus, source, engine, plan, registry };
}

/** Faults: `summary` required and missing; `badge_label` optional and too short; `questions.0.nodeId` not a served neighbor. */
const faulty = (focus: string) => ({ focus_node_id: focus, sections: { technical: 'Report selects Value from Source unchanged.' },
  badge_label: '', questions: [{ nodeId: '[dbo].[Nope]', question: 'What does Nope establish for Value?' }] });

type ShownError = ToolProblem['errors'][number];
type Problem = ToolProblem;
const PROBLEM_KEYS = ['attempt', 'code', 'errors', 'notice', 'resend'];
const shown = (problem: Problem): ShownError[] => problem.errors;

async function reply(hop: ReturnType<typeof bbHop>, state: ToolPhaseAttemptState, input: unknown, id: string) {
  const attempt = await executeToolAttempt(nativePort(() => [new vscode.LanguageModelToolCallPart(id, TOOL, input as object)]), hop.plan, { priorState: state });
  const message = attempt.messages.find(item => item instanceof ToolMessage) as ToolMessage;
  return { attempt, content: String(message.content), next: recordToolAttempt(state, attempt, hop.registry) };
}

describe('D-105 feedback stages through the dispatcher and the real submit_findings handler', () => {
  it.each([
    { stage: 1, allowed: false },
    { stage: 2, allowed: true },
    { stage: 3, allowed: true },
  ])('feedback $stage: every fault by path and code; allowed=$allowed', async ({ stage, allowed }) => {
    const hop = bbHop();
    let state = initialToolPhaseAttemptState(hop.plan.frame.phase);
    let problem: Problem | undefined;
    for (let n = 1; n <= stage; n++) {
      const sent = await reply(hop, state, faulty(hop.focus.id), `reply-${n}`);
      problem = JSON.parse(sent.content) as Problem;
      expect(sent.next.stopReason).toBeNull();
      expect(sent.content).not.toContain('[dbo].[Nope]');
      state = sent.next;
    }
    // D-103: one problem shape for every tool.
    expect(Object.keys(problem!).every(key => PROBLEM_KEYS.includes(key))).toBe(true);
    expect(problem!.attempt).toBe(`${stage}/3`);
    for (const error of shown(problem!)) {
      expect(Object.keys(error).every(key => ['path', 'code', 'message', 'allowed'].includes(key))).toBe(true);
    }
    const at = (path: string) => shown(problem!).find(error => error.path === path)!;
    // D-099: every fault in every feedback, each with its path.
    for (const path of ['summary', 'badge_label', 'questions.0.nodeId']) expect(at(path)).toBeDefined();
    expect(at('summary')).toMatchObject({ code: 'missing', message: expect.stringContaining(ISSUES.missing.correction) });
    expect(problem!.resend).toEqual(expect.arrayContaining(['summary', 'badge_label', 'questions']));
    // D-077/D-105: allowed values from metadata from feedback 2 on.
    if (allowed) expect(at('questions.0.nodeId').allowed).toEqual([hop.source.id]);
    else for (const error of shown(problem!)) expect(error).not.toHaveProperty('allowed');
    // D-105: a fallback belongs only to an issue whose fact no structured field holds; text, a missing field and a neighbor decision get none at any stage.
    for (const error of problem!.errors) for (const issue of Object.values(ISSUES)) if ('fallback' in issue) expect(error.message).not.toContain(issue.fallback);
  });

  it('accepts correction 3 that corrects summary and questions and sends no badge_label (schema-valid; the feedback never recommends it)', async () => {
    const hop = bbHop();
    let state = initialToolPhaseAttemptState(hop.plan.frame.phase);
    for (let n = 1; n <= 3; n++) state = (await reply(hop, state, faulty(hop.focus.id), `reply-${n}`)).next;
    expect(state.stopReason).toBeNull();
    const fixed = await reply(hop, state, { focus_node_id: hop.focus.id, summary: 'Report passes Source.Value through.',
      questions: [{ nodeId: hop.source.id, question: 'What does Source establish for Value?' }] }, 'reply-4');
    expect(fixed.attempt.rejections).toEqual([]);
    expect(fixed.next).toMatchObject({ stopReason: null, providerCalls: 4 });
    expect(hop.engine.heldFindingFocus).toBeNull();
  });

  it('terminates the hop as a logged error when correction 3 still fails (four replies, D-029)', async () => {
    const hop = bbHop();
    let state = initialToolPhaseAttemptState(hop.plan.frame.phase);
    for (let n = 1; n <= 4; n++) {
      state = (await reply(hop, state, faulty(hop.focus.id), `reply-${n}`)).next;
      expect(state.stopReason).toBe(n < 4 ? null : 'no_progress');
    }
    expect(state).toMatchObject({ providerCalls: 4, rejectedTerminalCalls: 4 });
  });
});

describe('D-103: every rejecting path renders the one problem shape', () => {
  const Schema = z.object({ query: z.string().min(1), types: z.array(z.enum(['table', 'view'])).optional() }).strict();
  it.each([
    { name: 'schema issue of a read tool', input: { query: '', types: ['proc'], extra: 1 },
      paths: ['query', 'types.0', 'extra'], allowedAt: { 'types.0': ['table', 'view'] } },
    { name: 'domain rejection without schema issues', input: { query: 'x' },
      paths: ['query'], allowedAt: {} },
  ])('$name', async ({ input, paths, allowedAt }) => {
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_search_objects', inputSchema: Schema, effect: 'read', modelDescription: 'Search.',
      execute: (value: unknown) => {
        const parsed = Schema.safeParse(value);
        if (!parsed.success) return JSON.stringify(rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidToolInput, input: value, schema: Schema }));
        return JSON.stringify(makeRejection({ code: 'out_of_scope_or_not_neighbor', errors: errorsAt('not_neighbor', ['query']) }));
      } });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'discover' }, registry,
      messages: [new HumanMessage('Find Orders.')], sink: new TurnEventSink(() => {}), facts: { memorySections: [] }, toolChoice: 'auto' });
    let state = initialToolPhaseAttemptState('discover');
    for (const stage of [1, 2]) {
      const attempt = await executeToolAttempt(nativePort(() => [new vscode.LanguageModelToolCallPart(`c${stage}`, 'lineage_search_objects', input)]), plan, { priorState: state });
      const problem = JSON.parse(String((attempt.messages.find(item => item instanceof ToolMessage) as ToolMessage).content)) as Problem;
      expect(Object.keys(problem).every(key => PROBLEM_KEYS.includes(key))).toBe(true);
      expect(shown(problem).map(error => error.path)).toEqual(expect.arrayContaining(paths));
      for (const [path, values] of Object.entries(allowedAt)) {
        expect(shown(problem).find(error => error.path === path)?.allowed).toEqual(stage === 1 ? undefined : values);
      }
      state = recordToolAttempt(state, attempt, registry);
    }
  });
});

/** Spec 08 "Same steps for every tool" / D-105: a rejected commit call escalates 1, 2, 3 and ends the step on the fourth reply in every phase, even when each reply also stores an accepted read. */
describe('D-105 escalation of a rejected start_exploration in sm_entry and gate_refine, through the production graph', () => {
  const origin = '[dbo].[Report]';
  const depth = { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } };
  const reads = ['Report', 'Source', 'Value', 'dbo'];

  /** Replies to the step under test with a faulty start plus one fresh accepted read until it ends; returns the stage each start rejection rendered, the breaker's phase and reason, and the reply count. */
  async function run(refine: boolean) {
    const node = makeNode({ id: origin, schema: 'dbo', name: 'Report', type: 'view', bodyScript: 'SELECT 1 AS Value;', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] });
    const session = new AiSession({ ...EMPTY_AI_TEMPLATES, technical_capture: 'Capture the supplied SQL.' });
    session.model = makeIndexedModel([node], []);
    session.graph = makeGraph([node], []);
    let calls = 0, replies = 0, faulty = !refine;
    const stages: string[] = [];
    const scripted: ModelPort = {
      id: 'escalation', identity: { id: 'escalation', name: 'Escalation', vendor: 'test', family: 'test', version: '1' },
      budget: createTurnTokenBudget({}), get modelCalls() { return calls; },
      async getNumTokens(text) { return String(text).length; },
      async generateStructured() { throw new Error('Slash routing needs no classifier.'); },
      async completeText() { calls++; return 'Trace the supplied objects.'; },
      async generateToolTurn(input) {
        calls++;
        if (faulty) replies++;
        const feedback = input.messages.filter(message => message instanceof ToolMessage && message.tool_call_id.startsWith('start-'));
        if (feedback.length) stages.push((JSON.parse(String(feedback.at(-1)!.content)) as Problem).attempt);
        const batch = faulty
          ? [{ callId: `start-${calls}`, toolName: 'lineage_start_exploration', input: refine
              ? { proposalRevision: 1, depth: { upstream: { levels: 2, exactness: 'wrong' } } }
              : { origin, analysisMode: 'bb', classification: 'wrong', depth } },
            { callId: `read-${calls}`, toolName: 'lineage_search_objects', input: { query: reads[replies % reads.length] } }]
          : [{ callId: `start-${calls}`, toolName: 'lineage_start_exploration', input: { origin, analysisMode: 'bb', classification: 'technical', depth } }];
        return { status: 'completed', content: [], message: modelToolCallMessage(batch), text: '', toolCalls: batch.map(item => ({ valid: true, ...item })), finishReason: 'tool-calls' };
      },
    };
    const breaker: string[] = [];
    const logger = { debug: (line: string) => { const hit = /\[Breaker\] phase=(\w+) reason=(\w+)/.exec(line); if (hit) breaker.push(`${hit[1]} ${hit[2]}`); }, info() {}, warn() {}, error() {} };
    const runtime = new LineageRuntime({ getSession: () => session, logger: logger as never,
      createRegistry: (lease, port) => buildAiToolRegistry(() => session, logger as never, () => undefined, lease, { model: port }) });
    let proposalId: string | undefined;
    const sink = () => new TurnEventSink(event => { if (event.type === 'gate') proposalId = event.proposalId; });
    if (refine) {
      expect(await runtime.run({ model: scripted, sink: sink(), request: { id: 'open', prompt: `/trace ${origin}` } })).toMatchObject({ outcome: 'ok' });
      assert(proposalId);
      faulty = true;
    }
    await runtime.run({ model: scripted, sink: sink(), request: refine
      ? { id: 'refine', prompt: 'Change the scope.', gateDecision: { kind: 'refine', proposalId: proposalId!, refine: { instruction: 'Change the scope.' } } }
      : { id: 'open', prompt: `/trace ${origin}` } });
    return { stages, breaker, replies };
  }

  it.each([{ phase: 'sm_entry', refine: false }, { phase: 'gate_refine', refine: true }])(
    '$phase: three rejected start replies interleaved with accepted reads give feedback 1, 2, 3 and the fourth ends the step as no_progress', async ({ refine }) => {
    expect(await run(refine)).toEqual({ stages: ['1/3', '2/3', '3/3'], breaker: ['sm_entry no_progress'], replies: MAX_TOOL_PROVIDER_CALLS });
  });
});

describe('D-105: the registry effect of a rejected call decides whether the reply counts as a rejected commit', () => {
  const Schema = z.object({ query: z.string() }).strict();
  const fails = () => JSON.stringify(makeRejection({ code: REJECTION_CODES.invalidInput, errors: errorsAt('missing', ['query']) }));
  function world(stage: 'sm_entry' | 'completed' | 'discover', commit: { name: string; effect: 'session_start' | 'presentation_commit' | 'scope_store' }) {
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_search_objects', inputSchema: Schema, effect: 'read', modelDescription: 'Search.', execute: () => '{"results":[]}' });
    registry.register({ name: commit.name, inputSchema: Schema, effect: commit.effect, modelDescription: 'Commit.', execute: fails });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: stage }, registry,
      messages: [new HumanMessage('Continue.')], sink: new TurnEventSink(() => {}), facts: { memorySections: [] } });
    return { registry, plan };
  }
  /** Four replies, each with one rejected call of the tool and one fresh accepted read. */
  async function replies(stage: 'sm_entry' | 'completed' | 'discover', commit: { name: string; effect: 'session_start' | 'presentation_commit' | 'scope_store' }) {
    const { registry, plan } = world(stage, commit);
    let state = initialToolPhaseAttemptState(plan.frame.phase);
    const seen: Array<{ stage: string; stop: ToolPhaseAttemptState['stopReason'] }> = [];
    for (let n = 1; n <= MAX_TOOL_PROVIDER_CALLS; n++) {
      const attempt = await executeToolAttempt(nativePort(() => [
        new vscode.LanguageModelToolCallPart(`commit-${n}`, commit.name, {}),
        new vscode.LanguageModelToolCallPart(`read-${n}`, 'lineage_search_objects', { query: `q${n}` })]), plan, { priorState: state });
      const feedback = attempt.messages.find(item => item instanceof ToolMessage && item.tool_call_id === `commit-${n}`) as ToolMessage;
      state = recordToolAttempt(state, attempt, registry);
      seen.push({ stage: (JSON.parse(String(feedback.content)) as Problem).attempt, stop: state.stopReason });
    }
    return seen;
  }

  it.each([
    { stage: 'sm_entry' as const, commit: { name: 'lineage_start_exploration', effect: 'session_start' as const } },
    { stage: 'completed' as const, commit: { name: 'lineage_present_result', effect: 'presentation_commit' as const } },
  ])('a rejected $commit.effect call is counted through interleaved reads: feedback 1, 2, 3, then no_progress on the fourth reply', async ({ stage, commit }) => {
    expect(await replies(stage, commit)).toEqual([
      { stage: '1/3', stop: null }, { stage: '2/3', stop: null }, { stage: '3/3', stop: null }, { stage: '3/3', stop: 'no_progress' },
    ]);
  });

  it('a rejected scope_store call is a read: accepted reads keep resetting its count', async () => {
    expect(await replies('discover', { name: 'lineage_get_scope_bundle', effect: 'scope_store' })).toEqual(
      Array.from({ length: MAX_TOOL_PROVIDER_CALLS }, () => ({ stage: '1/3', stop: null })));
  });
});

describe('D-105: a sibling closed by its reply renders that reply\'s stage, like every other rejection', () => {
  const Schema = z.object({ query: z.string().min(1) }).strict();
  it.each([0, 1, 2])('after %i rejected replies the closed sibling is feedback n+1 of 3', async rejected => {
    const registry = new ToolRegistry<string>();
    registry.register({ name: 'lineage_search_objects', inputSchema: Schema, effect: 'read', modelDescription: 'Search.',
      execute: (value: unknown) => {
        const parsed = Schema.safeParse(value);
        return parsed.success ? '{"results":[]}' : JSON.stringify(rejectionFromZodError(parsed.error, { code: REJECTION_CODES.invalidToolInput, input: value, schema: Schema }));
      } });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'discover' }, registry, requiredTerminalTool: 'lineage_search_objects',
      messages: [new HumanMessage('Find Orders.')], sink: new TurnEventSink(() => {}), facts: { memorySections: [] }, toolChoice: 'required' });
    const call = (id: string, query: string) => new vscode.LanguageModelToolCallPart(id, 'lineage_search_objects', { query });
    let state = initialToolPhaseAttemptState('discover');
    for (let n = 0; n < rejected; n++) state = recordToolAttempt(state, await executeToolAttempt(nativePort(() => [call(`bad-${n}`, '')]), plan, { priorState: state }), registry);
    const closing = await executeToolAttempt(nativePort(() => [call('terminal', 'Orders'), call('sibling', 'Sales')]), plan, { priorState: state });
    const sibling = closing.messages.find(item => item instanceof ToolMessage && item.tool_call_id === 'sibling') as ToolMessage;
    expect(closing.calls.map(item => item.status)).toEqual(['executed', 'phase_closed']);
    expect(JSON.parse(String(sibling.content))).toMatchObject({ code: REJECTION_CODES.phaseClosed, attempt: `${rejected + 1}/3` });
  });
});
