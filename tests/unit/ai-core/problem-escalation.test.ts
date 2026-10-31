/** One flat `{code, attempt, errors, resend}` problem per rejection, escalated over three corrections, then the hop terminates. */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import {
  compileInstructionPlan,
  explorationFacts,
} from '../../../src/ai/agent/instructionPlan';
import {
  executeToolAttempt,
  initialToolPhaseAttemptState,
  recordToolAttempt,
  type ToolPhaseAttemptState,
} from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ToolRegistry } from '../../../src/ai/tools/registry';
import {
  ISSUES,
  type ToolProblem,
} from '../../../src/ai/support/toolErrorEnvelope';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { SubmitFindingsModelSchema } from '../../../src/ai/tools/toolSchemas';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import {
  makeGraph,
  makeIndexedModel,
  makeNode,
} from '../helpers/modelFixtures';

const TOOL = 'lineage_submit_findings';

function nativePort(parts: () => vscode.LanguageModelToolCallPart[]) {
  const sendRequest = vi.fn(async () => ({
    stream: {
      async *[Symbol.asyncIterator]() {
        yield* parts();
      },
    },
  }));
  return new VscodeModelPort(
    {
      id: 'synthetic',
      name: 'synthetic',
      vendor: 'test',
      family: 'test',
      version: '1',
      maxInputTokens: 128000,
      countTokens: async () => 1,
      sendRequest,
    } as never,
    { budget: createTurnTokenBudget({}) },
  );
}

/** The real submit_findings handler, registry and instruction plan bound to the engine's current hop. */
function hopOf(session: AiSession, epoch: number, engine: NavigationEngine) {
  const model = session.model!;
  const services = {
    getSession: () => session,
    turnEpoch: () => epoch,
    requireModel: () => model,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    logAndReturn: (_name: string, data: object) => JSON.stringify(data),
    toolError: (_name: string, error: unknown) => {
      throw error;
    },
  } as unknown as ToolServices;
  const registry = new ToolRegistry<string>();
  registry.register({
    name: TOOL,
    inputSchema: SubmitFindingsModelSchema,
    effect: 'hop_commit',
    modelDescription: 'Submit findings.',
    execute: (input: unknown) => executeSubmitFindings(input, services),
  });
  const plan = compileInstructionPlan({
    kind: 'converse',
    stage: { kind: 'active', mode: 'sm_bb' },
    registry,
    messages: [new HumanMessage('Inspect the current object.')],
    sink: new TurnEventSink(() => {}),
    facts: explorationFacts('bb', [], {
      classification: 'technical',
      memorySections: [],
    }),
    findingSchema: () => engine.findingSchema(),
    requiredTerminalTool: TOOL,
    toolChoice: 'required',
  });
  return { engine, plan, registry, session };
}

/** A BB exploration of `nodes` from `origin`, started and at its first hop. */
function bbSession(
  nodes: ReturnType<typeof makeNode>[],
  pairs: Array<[string, string]>,
  origin: string,
  levels: number | 'all',
) {
  const model = makeIndexedModel(nodes, pairs);
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.model = model;
  session.classification = 'technical';
  const engine = new NavigationEngine(
    model,
    makeGraph(nodes, pairs),
    () => {},
    { memory: session.memory },
  );
  session.stateMachine = engine;
  expect(
    engine.init({
      origin,
      question: 'Explain the origin.',
      direction: 'upstream',
      analysisMode: 'bb',
      depthIntent: {
        upstream: { levels, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    }),
  ).toHaveProperty('ok', true);
  engine.classification = 'technical';
  engine.getHopContext();
  return { session, epoch, engine };
}

/** A real BB hop at a view reading one table, driven through the real submit_findings handler and the dispatcher. */
function bbHop() {
  const source = makeNode({
    id: '[dbo].[Source]',
    schema: 'dbo',
    name: 'Source',
    type: 'table',
  });
  const focus = makeNode({
    id: '[dbo].[Report]',
    schema: 'dbo',
    name: 'Report',
    type: 'view',
    bodyScript: 'SELECT Value FROM dbo.Source;',
  });
  const { session, epoch, engine } = bbSession(
    [source, focus],
    [[source.id, focus.id]],
    focus.id,
    1,
  );
  return { focus, source, ...hopOf(session, epoch, engine) };
}

/** Faults: `summary` required and missing; `badge_label` optional and too short; `questions.0.nodeId` not a served neighbor. */
const faulty = (focus: string) => ({
  focus_node_id: focus,
  sections: { technical: 'Report selects Value from Source unchanged.' },
  badge_label: '',
  questions: [
    { nodeId: '[dbo].[Nope]', question: 'What does Nope establish for Value?' },
  ],
});

type ShownError = ToolProblem['errors'][number];
type Problem = ToolProblem;
const PROBLEM_KEYS = ['attempt', 'code', 'errors', 'resend'];
const shown = (problem: Problem): ShownError[] => problem.errors;

async function reply(
  hop: Pick<ReturnType<typeof hopOf>, 'plan' | 'registry'>,
  state: ToolPhaseAttemptState,
  input: unknown,
  id: string,
) {
  const attempt = await executeToolAttempt(
    nativePort(() => [
      new vscode.LanguageModelToolCallPart(id, TOOL, input as object),
    ]),
    hop.plan,
    { priorState: state },
  );
  const message = attempt.messages.find(
    (item) => item instanceof ToolMessage,
  ) as ToolMessage;
  return {
    attempt,
    content: String(message.content),
    next: recordToolAttempt(state, attempt, hop.registry),
  };
}

describe('Feedback stages through the dispatcher and the real submit_findings handler', () => {
  it.each([
    { stage: 1, allowed: false },
    { stage: 2, allowed: true },
    { stage: 3, allowed: true },
  ])(
    'feedback $stage: every fault by path and code; allowed=$allowed',
    async ({ stage, allowed }) => {
      const hop = bbHop();
      let state = initialToolPhaseAttemptState(hop.plan.frame.phase);
      let problem: Problem | undefined;
      for (let n = 1; n <= stage; n++) {
        const sent = await reply(
          hop,
          state,
          faulty(hop.focus.id),
          `reply-${n}`,
        );
        problem = JSON.parse(sent.content) as Problem;
        expect(sent.next.stopReason).toBeNull();
        expect(sent.content).not.toContain('[dbo].[Nope]');
        state = sent.next;
      }
      // One problem shape for every tool.
      expect(
        Object.keys(problem!).every((key) => PROBLEM_KEYS.includes(key)),
      ).toBe(true);
      expect(problem!.attempt).toBe(`${stage}/3`);
      for (const error of shown(problem!)) {
        expect(
          Object.keys(error).every((key) =>
            ['path', 'code', 'message', 'allowed'].includes(key),
          ),
        ).toBe(true);
      }
      const at = (path: string) =>
        shown(problem!).find((error) => error.path === path)!;
      // Every fault in every feedback, each at its path with its code; a repeated call is also named a resend.
      expect(shown(problem!).map(({ path, code }) => ({ path, code }))).toEqual(
        [
          ...(stage > 1 ? [{ path: '', code: 'identical_resend' }] : []),
          { path: 'badge_label', code: 'invalid' },
          { path: 'badge_label', code: 'size' },
          { path: 'questions.0.nodeId', code: 'not_neighbor' },
          { path: 'summary', code: 'missing' },
        ],
      );
      expect(at('summary')).toMatchObject({
        code: 'missing',
        message: expect.stringContaining(ISSUES.missing.correction),
      });
      expect(problem!.resend).toEqual(
        expect.arrayContaining(['summary', 'badge_label', 'questions']),
      );
      // Allowed values from metadata from feedback 2 on.
      if (allowed)
        expect(at('questions.0.nodeId').allowed).toEqual([hop.source.id]);
      else
        for (const error of shown(problem!))
          expect(error).not.toHaveProperty('allowed');
      // A fallback belongs only to an issue whose fact no structured field holds; text, a missing field and a neighbor decision get none at any stage.
      for (const error of problem!.errors)
        for (const issue of Object.values(ISSUES))
          if ('fallback' in issue)
            expect(error.message).not.toContain(issue.fallback);
    },
  );

  it('terminates the hop as a logged error when correction 3 still fails (four replies)', async () => {
    const hop = bbHop();
    let state = initialToolPhaseAttemptState(hop.plan.frame.phase);
    for (let n = 1; n <= 4; n++) {
      state = (await reply(hop, state, faulty(hop.focus.id), `reply-${n}`))
        .next;
      expect(state.stopReason).toBe(n < 4 ? null : 'no_progress');
    }
    expect(state).toMatchObject({ providerCalls: 4, rejectedTerminalCalls: 4 });
  });
});
