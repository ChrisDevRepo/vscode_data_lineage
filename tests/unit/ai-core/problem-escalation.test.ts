/** Spec 08 / D-105 / D-099 / D-103: one `{code, errors, resend}` problem per rejection, escalated over three corrections, then the hop terminates. */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { z } from 'zod';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { compileInstructionPlan, explorationFacts } from '../../../src/ai/agent/instructionPlan';
import {
  executeToolAttempt,
  initialToolPhaseAttemptState,
  recordToolAttempt,
  type ToolPhaseAttemptState,
} from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ToolRegistry } from '../../../src/ai/tools/registry';
import { PROBLEM_MESSAGES, makeRejection, rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
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
    facts: explorationFacts('bb', [], { classification: 'technical', memorySections: [] }),
    freshSubmission: () => engine.heldFindingFocus === null, hopColumns: () => engine.hopSubmitColumns,
    requiredTerminalTool: TOOL, toolChoice: 'required' });
  return { focus, source, engine, plan };
}

/** Faults: `summary` required and missing; `badge_label` optional and too short; `questions.0.nodeId` not a served neighbor. */
const faulty = (focus: string) => ({ focus_node_id: focus, sections: { technical: 'Report selects Value from Source unchanged.' },
  badge_label: '', questions: [{ nodeId: '[dbo].[Nope]', question: 'What does Nope establish for Value?' }] });

interface Problem { code: string; errors: Array<{ path: string; code: string; message: string; allowed?: string[] }>; resend: string[] }

async function reply(hop: ReturnType<typeof bbHop>, state: ToolPhaseAttemptState, input: unknown, id: string) {
  const attempt = await executeToolAttempt(nativePort(() => [new vscode.LanguageModelToolCallPart(id, TOOL, input as object)]), hop.plan, { priorState: state });
  const message = attempt.messages.find(item => item instanceof ToolMessage) as ToolMessage;
  return { attempt, content: String(message.content), next: recordToolAttempt(state, attempt, TOOL) };
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
    expect(Object.keys(problem!).sort()).toEqual(['code', 'errors', 'resend']);
    for (const error of problem!.errors) {
      expect(Object.keys(error).every(key => ['path', 'code', 'message', 'allowed'].includes(key))).toBe(true);
      expect(error.code).toEqual(expect.any(String));
    }
    const at = (path: string) => problem!.errors.find(error => error.path === path)!;
    // D-099: every fault in every feedback, each with its path.
    for (const path of ['summary', 'badge_label', 'questions.0.nodeId']) expect(at(path)).toBeDefined();
    expect(at('summary').code).toBe('missing');
    expect(problem!.resend).toEqual(expect.arrayContaining(['summary', 'badge_label', 'questions']));
    // D-077/D-105: allowed values from metadata from feedback 2 on.
    if (allowed) expect(at('questions.0.nodeId').allowed).toEqual([hop.source.id]);
    else for (const error of problem!.errors) expect(error).not.toHaveProperty('allowed');
    // D-105: the fallback is only for reference leaves; text, a missing field and a neighbor decision get none at any stage.
    for (const path of ['summary', 'badge_label', 'questions.0.nodeId']) expect(at(path).message).not.toContain(PROBLEM_MESSAGES.fallback);
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
        return JSON.stringify(makeRejection({ code: 'out_of_scope_or_not_neighbor', reason: 'Not a neighbor of the current object.', issuePaths: ['query'] }));
      } });
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'discover' }, registry,
      messages: [new HumanMessage('Find Orders.')], sink: new TurnEventSink(() => {}), facts: { memorySections: [] }, toolChoice: 'auto' });
    let state = initialToolPhaseAttemptState('discover');
    for (const stage of [1, 2]) {
      const attempt = await executeToolAttempt(nativePort(() => [new vscode.LanguageModelToolCallPart(`c${stage}`, 'lineage_search_objects', input)]), plan, { priorState: state });
      const problem = JSON.parse(String((attempt.messages.find(item => item instanceof ToolMessage) as ToolMessage).content)) as Problem;
      expect(Object.keys(problem).sort()).toEqual(['code', 'errors', 'resend']);
      expect(problem.errors.map(error => error.path)).toEqual(expect.arrayContaining(paths));
      for (const [path, values] of Object.entries(allowedAt)) {
        expect(problem.errors.find(error => error.path === path)?.allowed).toEqual(stage === 1 ? undefined : values);
      }
      state = recordToolAttempt(state, attempt);
    }
  });
});
