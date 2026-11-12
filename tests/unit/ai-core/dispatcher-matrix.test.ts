import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
/** Per-call, per-reply and recovery outcomes of the tool dispatcher. */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { z } from 'zod';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { assertToolPairingWellFormed } from '../../../src/ai/model/messageWellFormed';
import { compileInstructionPlan } from '../../../src/ai/agent/instructionPlan';
import {
  executeToolAttempt,
  initialToolPhaseAttemptState,
  recordToolAttempt,
} from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import {
  ToolRegistry,
  type IToolRegistry,
} from '../../../src/ai/tools/registry';
import {
  ISSUES,
  at,
  makeRejection,
  type IssueCode,
  type ToolProblem,
} from '../../../src/ai/support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';

const SearchSchema = z.object({ query: z.string().min(1) }).strict();

function nativePort(
  parts: () => Array<
    vscode.LanguageModelToolCallPart | vscode.LanguageModelTextPart
  >,
  budget = createTurnTokenBudget({}),
) {
  const sendRequest = vi.fn(async () => ({
    stream: {
      async *[Symbol.asyncIterator]() {
        yield* parts();
      },
    },
  }));
  const port = new VscodeModelPort(
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
    { budget },
  );
  return { port, sendRequest };
}

/** A discovery-stage registry: one read tool whose result the case scripts. */
function registryWith(result: (input: unknown) => string): {
  registry: IToolRegistry<string>;
  invoke: ReturnType<typeof vi.fn>;
} {
  const registry = new ToolRegistry<string>();
  const invoke = vi.fn(result);
  registry.register({
    name: 'lineage_search_objects',
    inputSchema: SearchSchema,
    effect: 'read',
    modelDescription: 'Search objects.',
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
    kind: 'converse',
    stage: { kind: 'discover' },
    registry,
    messages: [new HumanMessage('Which objects read Orders?')],
    sink: new TurnEventSink(() => {}),
    facts: { memorySections: [] },
    toolChoice: 'auto',
  });
}
const call = (id: string, input: unknown, tool = 'lineage_search_objects') =>
  new vscode.LanguageModelToolCallPart(id, tool, input as object);

/** The rendered problem the model reads and its errors across categories. */
type ShownError = ToolProblem['errors'][number];
type Problem = ToolProblem;
const problemOf = (value: unknown): Problem =>
  (typeof value === 'string' ? JSON.parse(value) : value) as Problem;
const shown = (value: unknown): ShownError[] => problemOf(value).errors;
/** One shown error of an issue code, without values. */
const fault = (code: IssueCode, path = '') => ({
  path,
  code,
  message: expect.stringContaining(ISSUES[code].correction),
});

describe('backend-fault rejection', () => {
  it('a no-project result inside a reply ends the run and executes no later sibling', async () => {
    const { registry, invoke } = registryWith(() =>
      JSON.stringify(
        makeRejection({
          code: REJECTION_CODES.backendFault,
          errors: at('no_project'),
        }),
      ),
    );
    const model = nativePort(() => [
      call('first', { query: 'Orders' }),
      call('second', { query: 'Sales' }),
    ]);
    const attempt = await executeToolAttempt(
      model.port,
      discoveryPlan(registry),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempt.calls.map((item) => item.status)).toEqual([
      'rejected',
      'phase_closed',
    ]);
    expect(
      recordToolAttempt(initialToolPhaseAttemptState('discover'), attempt)
        .stopReason,
    ).toBe('backend_fault');
  });
});

describe('a tool call whose arguments are not a JSON object', () => {
  it('is answered by its own tool result stating the fault and the next action, and the valid sibling still runs', async () => {
    const { registry, invoke } = registryWith(() =>
      JSON.stringify({ results: [] }),
    );
    const model = nativePort(() => [
      call('bad', 'Orders'),
      call('good', { query: 'Orders' }),
    ]);
    const lines: string[] = [];
    const attempt = await executeToolAttempt(
      model.port,
      discoveryPlan(registry),
      { debugLog: (line) => lines.push(line) },
    );
    assertToolPairingWellFormed(attempt.messages);
    const results = attempt.messages.filter(
      (item) => item instanceof ToolMessage,
    ) as ToolMessage[];
    expect(results.map((item) => item.status)).toEqual(['error', 'success']);
    // The call-level fault is the root error; its message comes from the port's reason.
    // Without step state the rejection renders at feedback 2, so the accepted JSON type is stated;
    // arguments that are not an object hold nothing, so every required field of the card is resent.
    expect(problemOf(String(results[0].content))).toMatchObject({
      code: REJECTION_CODES.invalidInput,
      attempt: '2/3',
      resend: ['query'],
    });
    expect(shown(String(results[0].content))).toEqual([
      { ...fault('type'), type: ['object'] },
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempt.rejections).toEqual([
      expect.objectContaining({
        callId: 'bad',
        code: REJECTION_CODES.invalidInput,
      }),
    ]);
    expect(lines.filter((line) => line.startsWith('[ToolOutcome]'))).toEqual([
      expect.stringContaining('callId=bad status=rejected code=invalid_input'),
      expect.stringContaining('callId=good status=accepted'),
    ]);
  });
});

describe('a cancelled native generation', () => {
  const planWith = (registry: IToolRegistry<string>, signal: AbortSignal) =>
    compileInstructionPlan({
      kind: 'converse',
      stage: { kind: 'discover' },
      registry,
      messages: [new HumanMessage('Which objects read Orders?')],
      sink: new TurnEventSink(() => {}),
      facts: { memorySections: [] },
      toolChoice: 'auto',
      signal,
    });

  it('returns no partial message group when a batch is cancelled between two tool calls', async () => {
    const { registry, invoke } = registryWith(() => '{}');
    const controller = new AbortController();
    invoke.mockImplementation(() => {
      controller.abort();
      return '{}';
    });
    const model = nativePort(() => [
      call('read-1', { query: 'Sales' }),
      call('read-2', { query: 'Orders' }),
    ]);
    const attempt = await executeToolAttempt(
      model.port,
      planWith(registry, controller.signal),
    );
    expect(attempt.stop).toBe('cancelled');
    expect(invoke).toHaveBeenCalledOnce();
    expect(attempt.messages).toEqual([]);
  });
});
