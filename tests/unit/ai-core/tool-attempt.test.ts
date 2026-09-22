/**
 * Graph-owned tool-attempt loop: dispatch batch, budgets, truncation stops, and retry projection.
 *
 * @remarks
 * Exercises the real `toolAttempt.ts` exports against a scripted model port so the loop's own
 * decisions are observable without a provider. The bounds asserted here (semantic-failure cap,
 * 48KB attempt-context budget, 240-char rejection reason, 1KB hint, 2KB detail/fragment, 4 fragments)
 * are the module's declared constants; where a constant is module-private the literal is restated
 * with the name it mirrors so a source change surfaces as a failing assertion rather than silent drift.
 */
import { describe, expect, it } from 'vitest';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import {
  MAX_TOOL_PROVIDER_CALLS,
  MAX_TOOL_SEMANTIC_FAILURES,
  executeToolAttempt,
  executeToolGenerationAttempt,
  initialToolPhaseAttemptState,
  recordToolAttempt,
  renderToolAttemptContext,
  type ToolAttemptResult,
  type ToolPhaseAttemptState,
} from '../../../src/ai/agent/toolAttempt';
import type { ConverseInstructionPlan } from '../../../src/ai/agent/instructionPlan';
import { assertToolPairingWellFormed } from '../../../src/ai/model/messageWellFormed';
import { modelUserMessage } from '../../../src/ai/model/modelPort';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { createTurnTokenBudget, type TurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import type { IToolRegistry } from '../../../src/ai/tools/registry';
import { presentResultRepairPatchSchemaForFields } from '../../../src/ai/tools/toolSchemas';
import {
  ScriptedModelPort,
  collectingSink,
  invalidCall,
  scriptedRegistry,
  validCall,
  type ScriptedGeneration,
  type ScriptedTool,
} from './helpers/scriptedModelPort';

/** Mirrors the module-private `MAX_ATTEMPT_CONTEXT_BYTES`. */
const MAX_ATTEMPT_CONTEXT_BYTES = 49_152;
/** Mirrors the module-private `MAX_STORED_EVIDENCE_KIND_BYTES` (`MAX_ATTEMPT_CONTEXT_BYTES - 4096`). */
const MAX_STORED_EVIDENCE_KIND_BYTES = MAX_ATTEMPT_CONTEXT_BYTES - 4_096;
/** Mirrors the module-private `MAX_REJECTION_TEXT_CHARS`. */
const MAX_REJECTION_TEXT_CHARS = 240;
/** Mirrors the module-private `MAX_REJECTION_HINT_BYTES`. */
const MAX_REJECTION_HINT_BYTES = 1_024;
/** Mirrors the module-private `MAX_REJECTION_DETAIL_BYTES` and `MAX_CORRECTION_FRAGMENT_BYTES`. */
const MAX_BOUNDED_STRUCTURED_BYTES = 2_048;
/** Mirrors the module-private `MAX_CORRECTION_FRAGMENTS`. */
const MAX_CORRECTION_FRAGMENTS = 4;

type AttemptInput = Parameters<typeof executeToolGenerationAttempt>[1];

/** Builds the minimum graph-compiled attempt input, overridable per case. */
function attemptInput(
  registry: IToolRegistry<string>,
  overrides: Partial<AttemptInput> = {},
): { input: AttemptInput; events: ReturnType<typeof collectingSink>['events'] } {
  const { sink, events } = collectingSink();
  return {
    input: { messages: [], registry, sink, phase: 'active', ...overrides },
    events,
  };
}

/** Runs one scripted generation through the real executor. */
async function runAttempt(
  generations: readonly ScriptedGeneration[],
  tools: readonly ScriptedTool[],
  overrides: Partial<AttemptInput> = {},
): Promise<{
  result: ToolAttemptResult;
  invocations: ReturnType<typeof scriptedRegistry>['invocations'];
  events: ReturnType<typeof collectingSink>['events'];
  port: ScriptedModelPort;
}> {
  const { registry, invocations } = scriptedRegistry(tools);
  const { input, events } = attemptInput(registry, overrides);
  const port = new ScriptedModelPort(generations);
  const result = await executeToolGenerationAttempt(port, input);
  return { result, invocations, events, port };
}

/** Canonical error envelope a state-machine tool returns for a semantic rejection. */
function rejectionEnvelope(fields: {
  reason: string;
  hint?: string;
  detail?: unknown;
}): string {
  return JSON.stringify({
    success: false,
    errors: [fields.reason],
    ...(fields.hint !== undefined ? { hint: fields.hint } : {}),
    ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// (a) mixed valid + invalid batch
// ---------------------------------------------------------------------------

describe('executeToolGenerationAttempt — mixed valid/invalid tool batch', () => {
  it('dispatches valid calls in provider order and rejects invalid ones without dispatch', async () => {
    const { result, invocations, events } = await runAttempt(
      [{
        text: 'Resolving the requested objects.',
        toolCalls: [
          validCall('call-1', 'lineage_search_objects', { query: 'Orders' }),
          invalidCall('call-2', 'lineage_get_details', 'invalid_tool_input', 'node_id: Required', ['node_id']),
          validCall('call-3', 'lineage_get_details', { node_id: '[dbo].[Orders]' }),
        ],
      }],
      [
        { name: 'lineage_search_objects', result: '{"matches":["[dbo].[Orders]"]}', progressLabel: 'Searching…' },
        { name: 'lineage_get_details', result: '{"definition":"CREATE VIEW dbo.Orders"}' },
      ],
    );

    expect(result.stop).toBe('continue');
    expect(result.calls.map((call) => call.status)).toEqual(['executed', 'rejected', 'executed']);
    expect(invocations).toEqual([
      { toolName: 'lineage_search_objects', input: { query: 'Orders' } },
      { toolName: 'lineage_get_details', input: { node_id: '[dbo].[Orders]' } },
    ]);
    expect(result.observations.map((observation) => observation.callId)).toEqual(['call-1', 'call-3']);
    expect(result.semanticFailures).toBe(1);
    // Only the labeled tool emits a status; a registered tool without a progressLabel is silent.
    expect(events.filter((event) => event.type === 'status')).toHaveLength(1);
    expect(events.find((event) => event.type === 'status')).toMatchObject({ label: 'Searching…' });
  });

  it('projects an invalid call as a structured rejection envelope carrying no raw payload', async () => {
    const { result } = await runAttempt(
      [{
        toolCalls: [
          invalidCall('call-9', 'lineage_submit_findings', 'invalid_tool_input', 'column_flow.0.to_col: Required', ['column_flow.0.to_col']),
        ],
      }],
      [{ name: 'lineage_submit_findings', result: '{"ok":true}' }],
    );

    expect(result.rejections).toHaveLength(1);
    const [rejection] = result.rejections;
    expect(rejection).toEqual({
      callId: 'call-9',
      toolName: 'lineage_submit_findings',
      code: 'invalid_tool_input',
      reason: 'column_flow.0.to_col: Required',
      // Schema-invalid calls carry the standing repair directive: the rejected call is replayed
      // without arguments, so the model must be told to edit-and-resend rather than regenerate.
      hint: 'Resend the full tool call with only the offending field(s) corrected; keep every other field unchanged, and resend every element of a corrected list, repeating the unflagged elements exactly as first sent.',
      issuePaths: ['column_flow.0.to_col'],
      // Only a fingerprint of the rejected input survives — enough to bound unproductive resends
      // across attempts, never the payload itself.
      inputHash: expect.any(String),
      // Rejected before any handler ran, so a held present_result draft never carries this payload.
      preDispatch: true,
    });
    // The rejected input is absent by type — no key carries the raw payload, only its hash.
    expect(Object.keys(rejection).sort()).toEqual(['callId', 'code', 'hint', 'inputHash', 'issuePaths', 'preDispatch', 'reason', 'toolName']);
  });

  it('attaches repair guidance to an unknown_tool prevalidation reject, naming the phase\'s valid tools as data', async () => {
    const { result } = await runAttempt(
      [{
        toolCalls: [
          invalidCall('call-1', 'lineage_hallucinated_tool', 'unknown_tool', 'Tool is not available in this phase.'),
        ],
      }],
      [
        { name: 'lineage_search_objects', result: '{"matches":[]}' },
        { name: 'lineage_get_details', result: '{"ok":true}' },
      ],
    );

    expect(result.rejections).toEqual([
      expect.objectContaining({
        code: 'unknown_tool',
        // Verb-led positive instruction; no "do not"/"never" and no offending tool name repeated.
        hint: 'Call one of the tools already offered in this response.',
        // The valid tool-name set is a fact, kept as data rather than a "pick one" menu in the hint.
        detail: { allowedTools: ['lineage_search_objects', 'lineage_get_details'] },
      }),
    ]);
  });

  it('attaches repair guidance to a duplicate_call_id reject', async () => {
    const { result } = await runAttempt(
      [{
        toolCalls: [
          invalidCall('dupe', 'lineage_get_details', REJECTION_CODES.duplicateCallId, 'Duplicate provider call id.'),
          invalidCall('dupe', 'lineage_get_details', REJECTION_CODES.duplicateCallId, 'Duplicate provider call id.'),
        ],
      }],
      [{ name: 'lineage_get_details', result: '{"ok":true}' }],
    );

    expect(result.rejections).toEqual([
      expect.objectContaining({ code: REJECTION_CODES.duplicateCallId, hint: 'Use a new, unique call id for this tool call.' }),
      expect.objectContaining({ code: REJECTION_CODES.duplicateCallId, hint: 'Use a new, unique call id for this tool call.' }),
    ]);
  });

  it('records a dispatcher-rejected result as a rejection while sibling successes still observe', async () => {
    const { result } = await runAttempt(
      [{
        toolCalls: [
          validCall('call-1', 'lineage_submit_findings', { column_flow: [] }),
          validCall('call-2', 'lineage_search_objects', { query: 'Orders' }),
        ],
      }],
      [
        { name: 'lineage_submit_findings', result: rejectionEnvelope({ reason: 'column_flow must not be empty.', hint: 'Add at least one flow entry.' }) },
        { name: 'lineage_search_objects', result: '{"matches":[]}' },
      ],
    );

    expect(result.calls.map((call) => call.status)).toEqual(['rejected', 'executed']);
    expect(result.rejections[0].code).toBe('validation');
    expect(result.rejections[0].reason).toBe('column_flow must not be empty.');
    expect(result.rejections[0].hint).toBe('Add at least one flow entry.');
    expect(result.observations.map((observation) => observation.callId)).toEqual(['call-2']);
    expect(result.semanticFailures).toBe(1);
  });
  it('reuses only accepted equivalent read calls', async () => {
    const accepted = await runAttempt(
      [{ toolCalls: [
        validCall('call-1', 'lineage_search_objects', { query: 'Orders', limit: 10 }),
        validCall('call-2', 'lineage_search_objects', { limit: 10, query: 'Orders' }),
      ] }],
      [{ name: 'lineage_search_objects', result: '{"matches":[]}', effect: 'read' }],
    );
    expect(accepted.invocations).toHaveLength(1);
    expect(accepted.result.calls.map(call => call.status)).toEqual(['executed', 'executed']);
    expect(accepted.result.observations).toHaveLength(1);

    let attempt = 0;
    const rejected = await runAttempt(
      [{ toolCalls: [
        validCall('call-3', 'lineage_search_objects', { query: 'Orders' }),
        validCall('call-4', 'lineage_search_objects', { query: 'Orders' }),
      ] }],
      [{
        name: 'lineage_search_objects',
        effect: 'read',
        result: () => ++attempt === 1
          ? rejectionEnvelope({ reason: 'Retry the lookup.' })
          : '{"matches":[]}',
      }],
    );
    expect(rejected.invocations).toHaveLength(2);
    expect(rejected.result.calls.map(call => call.status)).toEqual(['rejected', 'executed']);
  });

  it('gives two reads the handler cannot tell apart one dedupe key', async () => {
    // The key follows the handler's own normalizers: `[ai].[SpImportOrders]` and
    // `ai.spimportorders` are the same object lookup, and a bracketed query with the same explicit
    // schema is the same search. Keyed on the raw payload each pair dispatched twice.
    const detail = await runAttempt(
      [{ toolCalls: [
        validCall('call-1', 'lineage_get_object_detail', { id: '[ai].[SpImportOrders]' }),
        validCall('call-2', 'lineage_get_object_detail', { id: 'ai.spimportorders' }),
      ] }],
      [{ name: 'lineage_get_object_detail', result: '{"id":"[ai].[spimportorders]"}', effect: 'read' }],
    );
    expect(detail.invocations).toHaveLength(1);
    expect(detail.result.observations).toHaveLength(1);

    const search = await runAttempt(
      [{ toolCalls: [
        validCall('call-3', 'lineage_search_objects', { query: '[ai].[Orders]' }),
        validCall('call-4', 'lineage_search_objects', { query: 'Orders', schemas: ['ai'], mode: 'substring' }),
      ] }],
      [{ name: 'lineage_search_objects', result: '{"matches":[]}', effect: 'read' }],
    );
    expect(search.invocations).toHaveLength(1);
    expect(search.result.observations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (b) semantic-failure streak crossing MAX_TOOL_SEMANTIC_FAILURES
// ---------------------------------------------------------------------------

describe('executeToolGenerationAttempt — semantic-failure budget', () => {
  const streakCases: ReadonlyArray<{
    name: string;
    remaining: number;
    invalidCount: number;
    expectedStatuses: readonly string[];
    expectedCharged: number;
  }> = [
    {
      name: 'under budget: every rejection is charged and none closes the batch',
      remaining: MAX_TOOL_SEMANTIC_FAILURES,
      invalidCount: 2,
      expectedStatuses: ['rejected', 'rejected'],
      expectedCharged: 2,
    },
    {
      name: 'crossing the cap closes remaining siblings as budget_closed',
      remaining: MAX_TOOL_SEMANTIC_FAILURES,
      invalidCount: 5,
      expectedStatuses: ['rejected', 'rejected', 'rejected', 'budget_closed', 'budget_closed'],
      expectedCharged: MAX_TOOL_SEMANTIC_FAILURES,
    },
    {
      name: 'an inherited remaining budget of 1 closes the batch after the first failure',
      remaining: 1,
      invalidCount: 3,
      expectedStatuses: ['rejected', 'budget_closed', 'budget_closed'],
      expectedCharged: 1,
    },
  ];

  for (const testCase of streakCases) {
    it(testCase.name, async () => {
      const toolCalls = Array.from({ length: testCase.invalidCount }, (_unused, index) =>
        invalidCall(`call-${index}`, 'lineage_get_details', 'invalid_tool_input', `node_id: Required (${index})`));
      const { result, invocations } = await runAttempt(
        [{ toolCalls }],
        [{ name: 'lineage_get_details', result: '{"ok":true}' }],
        { semanticFailuresRemaining: testCase.remaining },
      );

      expect(result.calls.map((call) => call.status)).toEqual(testCase.expectedStatuses);
      expect(result.semanticFailures).toBe(testCase.expectedCharged);
      expect(invocations).toHaveLength(0);
      const closed = result.calls.filter((call) => call.status === 'budget_closed');
      for (const call of closed) {
        expect(call.closedByCallId).toBe(`call-${testCase.expectedCharged - 1}`);
        expect(String(call.result)).toContain('attempt_budget_exhausted');
      }
    });
  }

  it('accumulates the streak across attempts and stops on semantic_failures without resetting on success', () => {
    let state = initialToolPhaseAttemptState('active');
    const rejectionAttempt = {
      stop: 'continue' as const,
      providerCalls: 1,
      semanticFailures: 1,
      observations: [],
      rejections: [{ callId: 'c', toolName: 'lineage_get_details', code: 'validation', reason: 'bad' }],
    };
    const successAttempt = {
      stop: 'continue' as const,
      providerCalls: 1,
      semanticFailures: 0,
      observations: [{ callId: 'ok', toolName: 'lineage_search_objects', result: '{"matches":[]}' }],
      rejections: [],
    };

    state = recordToolAttempt(state, rejectionAttempt);
    expect(state.stopReason).toBeNull();
    // A clean read between failures must NOT clear the cumulative semantic count.
    state = recordToolAttempt(state, successAttempt);
    expect(state.semanticFailures).toBe(1);
    expect(state.stopReason).toBeNull();
    state = recordToolAttempt(state, rejectionAttempt);
    expect(state.stopReason).toBeNull();
    state = recordToolAttempt(state, rejectionAttempt);

    expect(state.semanticFailures).toBe(MAX_TOOL_SEMANTIC_FAILURES);
    expect(state.stopReason).toBe('semantic_failures');
  });

  // A correction the stored-rejection budget drops never reaches the model again; the drop is a
  // logged event, not a silent one.
  it('reports the count of stored corrections the budget drops', () => {
    const logged: string[] = [];
    const rejection = (callId: string) => ({
      stop: 'continue' as const,
      providerCalls: 1,
      semanticFailures: 1,
      observations: [],
      rejections: [{ callId, toolName: 'lineage_get_details', code: 'validation', reason: 'bad' }],
    });
    // A window this small leaves the stored-rejection share at zero, so only the essential current
    // correction survives.
    const budget = createTurnTokenBudget({ modelWindowTokens: 1_000 });
    let state = recordToolAttempt(initialToolPhaseAttemptState('active'), rejection('c1'), budget, (message) => { logged.push(message); });
    state = recordToolAttempt(state, rejection('c2'), budget, (message) => { logged.push(message); });

    expect(state.rejections).toHaveLength(1);
    const drops = logged.filter((message) => message.includes('stored corrections dropped by budget'));
    // The first record shrinks the single correction in place — a distinct "collapsed" log fires
    // for that (see the in-place-collapse test below), not this count-delta one; the second record
    // cannot hold both incoming rejections, so one is dropped outright and this log fires for it.
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain('dropped=1');
    expect(drops[0]).toContain('carried=2');
    expect(drops[0]).toContain('phase=active');
  });

  it('never charges a duplicate_call_id transport artifact against the semantic budget', async () => {
    const { result } = await runAttempt(
      [{
        toolCalls: [
          invalidCall('dupe', 'lineage_get_details', REJECTION_CODES.duplicateCallId, 'Duplicate provider call id.'),
          invalidCall('dupe', 'lineage_get_details', REJECTION_CODES.duplicateCallId, 'Duplicate provider call id.'),
        ],
      }],
      [{ name: 'lineage_get_details', result: '{"ok":true}' }],
      { semanticFailuresRemaining: 1 },
    );

    expect(result.calls.map((call) => call.status)).toEqual(['rejected', 'rejected']);
    expect(result.semanticFailures).toBe(0);
  });

  it('charges a synthetic missing_required_tool_call when the batch is empty', async () => {
    const { result } = await runAttempt(
      [{ text: 'I will summarize instead.' }],
      [{ name: 'lineage_present_result', result: '{"ok":true}' }],
      { requiredTerminalTool: 'lineage_present_result' },
    );

    expect(result.stop).toBe('continue');
    expect(result.semanticFailures).toBe(1);
    expect(result.rejections[0]).toMatchObject({
      callId: '',
      toolName: 'lineage_present_result',
      code: 'missing_required_tool_call',
    });
  });

  // The phase asked for `toolChoice: 'required'`. A generation carrying neither a tool call nor a
  // word of prose is the provider ignoring that, not the model answering badly — no correction can
  // spend the repair allowance usefully, so it charges the physical-call budget only.
  it('never charges an empty provider generation against the semantic budget', async () => {
    const { result } = await runAttempt(
      [{ text: '' }],
      [{ name: 'lineage_present_result', result: '{"ok":true}' }],
      { requiredTerminalTool: 'lineage_present_result' },
    );

    expect(result.stop).toBe('continue');
    expect(result.semanticFailures).toBe(0);
    expect(result.rejections[0]).toMatchObject({
      callId: '',
      toolName: 'lineage_present_result',
      code: REJECTION_CODES.emptyGeneration,
    });
  });
});

// ---------------------------------------------------------------------------
// (c) finishReason 'length' -> output_limit stop
// ---------------------------------------------------------------------------

describe('executeToolGenerationAttempt — truncated generation classification', () => {
  const finishCases: ReadonlyArray<{
    finishReason: string;
    expectedStop: ToolAttemptResult['stop'];
    expectedAnomaly: ToolAttemptResult['finishAnomaly'];
    expectDispatch: boolean;
  }> = [
    { finishReason: 'length', expectedStop: 'output_limit', expectedAnomaly: 'length', expectDispatch: false },
    { finishReason: 'content-filter', expectedStop: 'output_limit', expectedAnomaly: 'content-filter', expectDispatch: false },
    { finishReason: 'tool-calls', expectedStop: 'continue', expectedAnomaly: undefined, expectDispatch: true },
    { finishReason: 'stop', expectedStop: 'continue', expectedAnomaly: undefined, expectDispatch: true },
  ];

  for (const testCase of finishCases) {
    it(`maps finishReason '${testCase.finishReason}' to stop '${testCase.expectedStop}'`, async () => {
      const { result, invocations } = await runAttempt(
        [{
          text: 'Partial prose cut mid-sentence',
          finishReason: testCase.finishReason,
          toolCalls: [validCall('call-1', 'lineage_search_objects', { query: 'Orders' })],
        }],
        [{ name: 'lineage_search_objects', result: '{"matches":[]}' }],
      );

      expect(result.stop).toBe(testCase.expectedStop);
      expect(result.finishAnomaly).toBe(testCase.expectedAnomaly);
      expect(invocations.length > 0).toBe(testCase.expectDispatch);
      expect(result.text).toBe('Partial prose cut mid-sentence');
      if (!testCase.expectDispatch) {
        // No tool, observation, or rejection effect may commit from an incomplete generation.
        expect(result.calls).toEqual([]);
        expect(result.observations).toEqual([]);
        expect(result.rejections).toEqual([]);
        expect(result.semanticFailures).toBe(0);
      }
    });
  }

  it('withholds buffered prose on a truncated generation but streams it on a clean stop', async () => {
    const truncated = await runAttempt(
      [{ text: 'Half a thought', finishReason: 'length' }],
      [{ name: 'lineage_search_objects', result: '{}' }],
      { proseGate: 'buffer-until-tool' },
    );
    expect(truncated.events.filter((event) => event.type === 'text')).toHaveLength(0);

    const clean = await runAttempt(
      [{ text: 'A complete thought', finishReason: 'stop' }],
      [{ name: 'lineage_search_objects', result: '{}' }],
      { proseGate: 'buffer-until-tool' },
    );
    expect(clean.result.stop).toBe('final');
    expect(clean.events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', delta: 'A complete thought' },
    ]);
  });

  it('rejects tool-less prose when the phase requires trusted evidence', async () => {
    const attempted = await runAttempt(
      [{ text: '**DB Error**\n\nlineage_get_context() was blocked.', finishReason: 'stop' }],
      [{ name: 'lineage_get_context', result: '{"visible_objects":32}' }],
      { requiresToolEvidence: true, proseGate: 'buffer-until-tool' },
    );

    expect(attempted.result.stop).toBe('continue');
    expect(attempted.result.semanticFailures).toBe(1);
    expect(attempted.result.rejections).toEqual([
      expect.objectContaining({
        code: 'missing_required_evidence',
        // Names the phase's actual tool(s) instead of the undefined "the appropriate lineage tool".
        hint: "Call one of this phase's lineage tools before answering: lineage_get_context.",
      }),
    ]);
    expect(attempted.events.filter((event) => event.type === 'text')).toEqual([]);
  });

  // Evidence-required sibling of the required-terminal-tool case above: an empty generation is a
  // provider artifact in this branch too, so it must charge the physical-call budget only.
  it('never charges an empty generation against the semantic budget in an evidence-required phase', async () => {
    const attempted = await runAttempt(
      [{ text: '' }],
      [{ name: 'lineage_get_context', result: '{"visible_objects":32}' }],
      { requiresToolEvidence: true, proseGate: 'buffer-until-tool' },
    );

    expect(attempted.result.stop).toBe('continue');
    expect(attempted.result.semanticFailures).toBe(0);
    expect(attempted.result.rejections).toEqual([
      expect.objectContaining({ code: REJECTION_CODES.emptyGeneration, toolName: 'lineage_evidence' }),
    ]);
  });

  it('withholds buffered prose when the required terminal tool was not called', async () => {
    const attempted = await runAttempt(
      [{ text: '{"focus_node_id":"[dbo].[Orders]","verdict":"analyze"}', finishReason: 'stop' }],
      [{ name: 'lineage_submit_findings', result: '{"success":true}' }],
      { requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required', proseGate: 'buffer-until-tool' },
    );

    expect(attempted.result.stop).toBe('continue');
    expect(attempted.result.semanticFailures).toBe(1);
    expect(attempted.result.rejections).toEqual([
      expect.objectContaining({ code: 'missing_required_tool_call' }),
    ]);
    expect(attempted.events.filter((event) => event.type === 'text')).toEqual([]);
  });

  it('retries a tool-less length cut in a required-terminal-tool phase as a chargeable missing call', async () => {
    const attempted = await runAttempt(
      [{ text: 'Wait, but the task says re-anchor. '.repeat(50), finishReason: 'length' }],
      [{ name: 'lineage_submit_findings', result: '{"success":true}' }],
      { requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required', proseGate: 'buffer-until-tool' },
    );

    expect(attempted.result.stop).toBe('continue');
    expect(attempted.result.finishAnomaly).toBeUndefined();
    expect(attempted.result.semanticFailures).toBe(1);
    expect(attempted.result.rejections).toEqual([
      expect.objectContaining({
        code: 'missing_required_tool_call',
        reason: 'The output limit was reached before lineage_submit_findings was called.',
      }),
    ]);
    expect(attempted.invocations).toEqual([]);
    expect(attempted.events.filter((event) => event.type === 'text')).toEqual([]);
  });

  it('charges a text-free length cut in a required-terminal-tool phase, never as an empty generation', async () => {
    const attempted = await runAttempt(
      [{ text: '', finishReason: 'length' }],
      [{ name: 'lineage_submit_findings', result: '{"success":true}' }],
      { requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required', proseGate: 'buffer-until-tool' },
    );

    expect(attempted.result.stop).toBe('continue');
    expect(attempted.result.semanticFailures).toBe(1);
    expect(attempted.result.rejections).toEqual([expect.objectContaining({ code: 'missing_required_tool_call' })]);
  });

  it('retries a tool-less length cut in an evidence-required phase as missing evidence', async () => {
    const attempted = await runAttempt(
      [{ text: 'Thinking about the scope…', finishReason: 'length' }],
      [{ name: 'lineage_get_context', result: '{"visible_objects":32}' }],
      { requiresToolEvidence: true, proseGate: 'buffer-until-tool' },
    );

    expect(attempted.result.stop).toBe('continue');
    expect(attempted.result.semanticFailures).toBe(1);
    expect(attempted.result.rejections).toEqual([
      expect.objectContaining({
        code: 'missing_required_evidence',
        reason: 'The output limit was reached before any lineage tool was called.',
      }),
    ]);
  });

  it('keeps a content-filter cut terminal even when the phase requires a tool', async () => {
    const attempted = await runAttempt(
      [{ text: 'Filtered', finishReason: 'content-filter' }],
      [{ name: 'lineage_submit_findings', result: '{"success":true}' }],
      { requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required', proseGate: 'buffer-until-tool' },
    );

    expect(attempted.result.stop).toBe('output_limit');
    expect(attempted.result.finishAnomaly).toBe('content-filter');
    expect(attempted.result.rejections).toEqual([]);
  });

  it('treats a truncation stop as phase-terminal ahead of the cumulative budget counters', () => {
    const state: ToolPhaseAttemptState = {
      phase: 'active',
      providerCalls: 4,
      semanticFailures: MAX_TOOL_SEMANTIC_FAILURES,
      observations: [],
      rejections: [],
      stopReason: 'semantic_failures',
    };
    const next = recordToolAttempt(state, {
      stop: 'output_limit',
      providerCalls: 1,
      semanticFailures: 0,
      observations: [],
      rejections: [],
    });

    expect(next.stopReason).toBe('output_limit');
  });
});

// ---------------------------------------------------------------------------
// (d) 48KB attempt context: held observations render whole, rejection text shrinks
// ---------------------------------------------------------------------------

describe('renderToolAttemptContext — held observations render whole', () => {
  function stateWithObservations(bodies: readonly string[]): ToolPhaseAttemptState {
    return {
      phase: 'active',
      providerCalls: bodies.length,
      semanticFailures: 0,
      observations: bodies.map((result, index) => ({
        callId: `call-${index}`,
        toolName: 'lineage_get_details',
        result,
      })),
      rejections: [],
      stopReason: null,
    };
  }

  it('leaves a within-budget context untouched and free of omission markers', () => {
    const rendered = renderToolAttemptContext(stateWithObservations(['{"definition":"CREATE VIEW dbo.Orders"}']));

    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(MAX_ATTEMPT_CONTEXT_BYTES);
    expect(rendered).toContain('CREATE VIEW dbo.Orders');
    expect(rendered).not.toContain('omitted');
  });

  it('renders every held observation body verbatim — the re-projection is the delivery', () => {
    // Each attempt is a fresh request: a body shrunk here is a body the model never receives. The
    // store already refused anything that does not fit, so rendering has nothing left to shrink.
    const first = `{"definition":"CREATE VIEW dbo.A AS ${'A'.repeat(20_000)}"}`;
    const second = `{"definition":"CREATE VIEW dbo.B AS ${'B'.repeat(20_000)}"}`;
    const rendered = renderToolAttemptContext(stateWithObservations([first, second]));

    expect(rendered).toContain('A'.repeat(20_000));
    expect(rendered).toContain('B'.repeat(20_000));
    expect(rendered).not.toContain('omitted');
    expect(rendered).not.toContain('collapsed');
  });

  it('drops bulk rejection detail while every held observation body survives', () => {
    const state: ToolPhaseAttemptState = {
      ...stateWithObservations(Array.from({ length: 3 }, () => 'X'.repeat(10_000))),
      semanticFailures: 2,
      rejections: [
        {
          callId: 'call-old',
          toolName: 'lineage_submit_findings',
          code: 'validation',
          reason: 'Superseded correction.',
          hint: 'OLD-HINT',
        },
        {
          callId: 'call-new',
          toolName: 'lineage_submit_findings',
          code: 'validation',
          reason: 'Flow entry 3 is malformed.',
          hint: 'NEWEST-HINT: resend column_flow entry 3.',
          detail: { padding: `TERMINAL-BULK-${'p'.repeat(60_000)}` },
          issuePaths: ['column_flow.3'],
        },
      ],
      stopReason: null,
    };
    const rendered = renderToolAttemptContext(state);

    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(MAX_ATTEMPT_CONTEXT_BYTES);
    // Engine correction text is the only shrink axis left: bulk detail goes, the actionable
    // correction stays in full, and the accepted evidence is untouched by either step.
    expect(rendered).not.toContain('TERMINAL-BULK-');
    expect(rendered).toContain('NEWEST-HINT: resend column_flow entry 3.');
    expect(rendered).toContain('column_flow.3');
    expect(rendered).toContain('X'.repeat(10_000));
  });

  it('preserves the newest correction in full while collapsing older rejection envelopes', () => {
    const state: ToolPhaseAttemptState = {
      phase: 'active',
      providerCalls: 6,
      semanticFailures: 2,
      observations: [],
      rejections: Array.from({ length: 20 }, (_unused, index) => ({
        callId: `call-${index}`,
        toolName: 'lineage_submit_findings',
        code: 'validation',
        reason: `Rejection ${index}`,
        hint: `HINT-${index}-${'h'.repeat(200)}`,
        detail: { padding: 'p'.repeat(4_000) },
        issuePaths: [`column_flow.${index}`],
      })),
      stopReason: null,
    };
    const rendered = renderToolAttemptContext(state);

    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(MAX_ATTEMPT_CONTEXT_BYTES);
    expect(rendered).toContain('Older rejection envelopes omitted from retry context');
    // The correction the model must act on next survives verbatim.
    expect(rendered).toContain(`HINT-19-${'h'.repeat(200)}`);
    expect(rendered).toContain('column_flow.19');
  });

  it('drops bulk detail as the final shrink axis while keeping hint and issue paths', () => {
    const state: ToolPhaseAttemptState = {
      phase: 'active',
      providerCalls: 1,
      semanticFailures: 1,
      observations: [],
      rejections: [{
        callId: 'call-0',
        toolName: 'lineage_submit_findings',
        code: 'validation',
        reason: 'Flow entries are malformed.',
        hint: 'Resend column_flow entry 3 with both endpoints.',
        detail: { padding: `BULK-DETAIL-${'p'.repeat(60_000)}` },
        issuePaths: ['column_flow.3'],
      }],
      stopReason: null,
    };
    const rendered = renderToolAttemptContext(state);

    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(MAX_ATTEMPT_CONTEXT_BYTES);
    expect(rendered).not.toContain('BULK-DETAIL-');
    expect(rendered).toContain('Resend column_flow entry 3 with both endpoints.');
    expect(rendered).toContain('column_flow.3');
  });

  it('stores an accepted body whole and keeps its read-dedupe identity', () => {
    // `acceptedCallKey` is what a later attempt reuses instead of re-dispatching an identical read.
    const body = 'B'.repeat(40_000);
    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), {
      stop: 'continue',
      providerCalls: 1,
      semanticFailures: 0,
      observations: [{
        callId: 'call-0',
        toolName: 'lineage_get_object_detail',
        result: body,
        acceptedCallKey: 'accepted-key-0',
      }],
      rejections: [],
    });

    expect(state.observations[0].result).toBe(body);
    expect(state.observations[0].acceptedCallKey).toBe('accepted-key-0');
    expect(Buffer.byteLength(state.observations[0].result)).toBeLessThanOrEqual(MAX_STORED_EVIDENCE_KIND_BYTES);
  });

});

// ---------------------------------------------------------------------------
// (e) rejection replay carries bounded correction fragments only
// ---------------------------------------------------------------------------

describe('executeToolAttempt — bounded rejection replay', () => {
  const RAW_PROSE_MARKER = 'RAW-NARRATIVE-MUST-NOT-REPLAY';

  function conversePlan(registry: IToolRegistry<string>, overrides: Partial<ConverseInstructionPlan['input']> = {}): ConverseInstructionPlan {
    const { sink } = collectingSink();
    const context = {
      kind: 'converse' as const,
      templateKeys: [],
      memorySections: [],
      toolNames: registry.getTools().map((tool) => tool.name),
    };
    return {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: {
        messages: [modelUserMessage('Trace the column flow for OrderTotal.')],
        registry,
        sink,
        phase: 'active',
        instructionContext: context,
        ...overrides,
      },
    };
  }

  /**
   * Runs one rejected submit_findings attempt, then a follow-up attempt that replays it.
   *
   * @param options.budget - Overrides the shipped-default turn budget for both scripted ports and
   *   the intervening `recordToolAttempt`, so a case can force the stored-rejection budget collapse.
   * @param options.debugLog - Diagnostic sink threaded to `recordToolAttempt`, so a case can assert
   *   on the collapse log line.
   */
  async function replayAfterRejection(options: {
    input: unknown;
    envelope: string;
    toolName?: string;
    presentResultRepairDraftHeld?: boolean;
    presentResultRepairDraftContext?: () => { sections?: unknown; notes?: unknown; highlight_groups?: unknown } | null;
    budget?: TurnTokenBudget;
    debugLog?: (message: string) => void;
  }): Promise<{ replayed: readonly BaseMessage[]; state: ToolPhaseAttemptState; first: ToolAttemptResult }> {
    const toolName = options.toolName ?? 'lineage_submit_findings';
    const { registry } = scriptedRegistry([{ name: toolName, result: options.envelope }]);
    const plan = conversePlan(registry);

    const firstPort = new ScriptedModelPort([{
      toolCalls: [validCall('call-1', toolName, options.input)],
    }], [], options.budget);
    const first = await executeToolAttempt(firstPort, plan);
    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), first, options.budget, options.debugLog);

    const secondPort = new ScriptedModelPort([{ text: 'Acknowledged.' }], [], options.budget);
    await executeToolAttempt(secondPort, plan, {
      priorState: state,
      ...(options.presentResultRepairDraftHeld !== undefined
        ? { presentResultRepairDraftHeld: options.presentResultRepairDraftHeld }
        : {}),
      ...(options.presentResultRepairDraftContext
        ? { presentResultRepairDraftContext: options.presentResultRepairDraftContext }
        : {}),
    });

    return { replayed: secondPort.requests[0].messages, state, first };
  }

  // The replay ends with the exchange-closing continuation note, so the pair sits one further back.
  function replayedToolArgs(messages: readonly BaseMessage[]): Record<string, unknown> {
    const toolCallMessage = messages[messages.length - 3] as AIMessage;
    const call = toolCallMessage.tool_calls?.[0];
    expect(call).toBeDefined();
    return (call?.args ?? {}) as Record<string, unknown>;
  }

  function replayedToolResult(messages: readonly BaseMessage[]): Record<string, unknown> {
    return JSON.parse(String(messages[messages.length - 2].content)) as Record<string, unknown>;
  }

  /**
   * Runs one schema-invalid (pre-dispatch) rejection, then the follow-up attempt that replays it —
   * the port-level path, where no held draft exists and the replayed args are the model's only view
   * of what it sent.
   */
  async function replayAfterInvalidCall(options: {
    toolName: string;
    input: unknown;
    reason: string;
    issuePaths: readonly string[];
    hint?: string;
    presentResultRepairDraftContext?: () => { sections?: unknown; notes?: unknown; highlight_groups?: unknown } | null;
  }): Promise<{ replayed: readonly BaseMessage[]; first: ToolAttemptResult }> {
    const { registry } = scriptedRegistry([{ name: options.toolName, result: '{"ok":true}' }]);
    const plan = conversePlan(registry);
    const draftHeld = options.presentResultRepairDraftContext
      ? { presentResultRepairDraftHeld: true, presentResultRepairDraftContext: options.presentResultRepairDraftContext }
      : {};

    const firstPort = new ScriptedModelPort([{
      toolCalls: [invalidCall('call-1', options.toolName, 'invalid_tool_input', options.reason, options.issuePaths, options.input, options.hint)],
    }]);
    const first = await executeToolAttempt(firstPort, plan, draftHeld);
    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), first);

    const secondPort = new ScriptedModelPort([{ text: 'Acknowledged.' }]);
    await executeToolAttempt(secondPort, plan, { priorState: state, ...draftHeld });

    return { replayed: secondPort.requests[0].messages, first };
  }

  it('never ends a retry history on a tool result — the exchange closes with a user-role note', async () => {
    // Provider contract, not style: Gemini 3 signature-validates every function call in the turn
    // opened by the newest user text message, and the VS Code LM API cannot carry a thought
    // signature — so a request ending on the tool result fails the whole turn with an
    // unrecoverable 400. The trailing user note ends that turn before the provider sees it.
    const { replayed } = await replayAfterRejection({
      input: { column_flow: [] },
      envelope: rejectionEnvelope({ reason: 'Required neighbors not accounted for.', hint: 'Add them to route_requests.' }),
    });

    const last = replayed[replayed.length - 1];
    expect(last.getType()).toBe('human');
    expect(String(last.content)).toContain('Continue the current task');
    // The correction itself still rides the paired tool result, and the pair stays well formed.
    expect(replayedToolResult(replayed).code).toBe('validation');
    expect(() => assertToolPairingWellFormed(replayed)).not.toThrow();
  });

  it('replays the whole column_flow list on a flagged entry, never a sparse array with null holes', async () => {
    // column_flow is a submit_findings root: the model rewrites the whole list on a resend, so a
    // replay that showed only the flagged index left the unflagged entries as positional `null`
    // holes — a live capture (m13 T29) then saw the model drop column_flow entirely on its next
    // resend rather than reconstruct the nulled entries. WHOLE_LIST_CORRECTION_ROOTS now covers
    // column_flow (with route_requests, prune_neighbors) exactly as it already covered
    // sections/notes/highlight_groups, so every entry rides the replay, never a hole.
    const { replayed, first } = await replayAfterRejection({
      input: {
        column_flow: [
          { from_col: 'A', to_col: 'B', marker: 'ENTRY-0-RAW' },
          { from_col: 'C', to_col: 'D', marker: 'ENTRY-1-RAW' },
          { from_col: 'E', to_col: 'F', marker: 'ENTRY-2-RAW' },
        ],
        narrative: RAW_PROSE_MARKER,
      },
      envelope: rejectionEnvelope({
        reason: 'column_flow entry 1 has no matching hop node.',
        hint: 'Resend column_flow entry 1 with a hop node from the archive.',
        detail: [{ path: 'column_flow.1', expected: 'known hop node' }],
      }),
    });

    expect(first.rejections[0].issuePaths).toEqual(['column_flow.1']);
    // messages: [original user message, assistant tool-call replay, paired tool result, continuation note]
    expect(replayed).toHaveLength(4);

    const args = replayedToolArgs(replayed);
    expect(Object.keys(args)).toEqual(['column_flow']);
    const flow = args.column_flow as unknown[];
    expect(flow).toHaveLength(3);
    expect(flow.some((entry) => entry === null || entry === undefined)).toBe(false);
    expect(flow[0]).toEqual({ from_col: 'A', to_col: 'B', marker: 'ENTRY-0-RAW' });
    expect(flow[1]).toEqual({ from_col: 'C', to_col: 'D', marker: 'ENTRY-1-RAW' });
    expect(flow[2]).toEqual({ from_col: 'E', to_col: 'F', marker: 'ENTRY-2-RAW' });

    const wire = JSON.stringify(replayed);
    // Every entry rides the replay now, including the ones that were never flagged...
    expect(wire).toContain('ENTRY-0-RAW');
    expect(wire).toContain('ENTRY-1-RAW');
    expect(wire).toContain('ENTRY-2-RAW');
    // ...but the raw prose/narrative field never does — that assertion still holds under the fix.
    expect(wire).not.toContain(RAW_PROSE_MARKER);

    const envelope = replayedToolResult(replayed);
    expect(envelope.code).toBe('validation');
    expect(envelope.hint).toBe('Resend column_flow entry 1 with a hop node from the archive.');
    expect(envelope.issuePaths).toEqual(['column_flow.1']);
  });

  it('replays a trailing unflagged column_flow entry too, not just up through the flagged index', async () => {
    // The other corruption shape on record (m11 T8): a 2-entry column_flow flagged only at index 0
    // replayed with length 1 — the unflagged trailing entry at index 1 was dropped outright, not
    // even shown as null, because the old sparse array's length was `max(flagged index) + 1`.
    const { replayed, first } = await replayAfterRejection({
      input: {
        column_flow: [
          { from_col: 'A', to_col: 'B', marker: 'ENTRY-0-RAW' },
          { from_col: 'C', to_col: 'D', marker: 'ENTRY-1-TRAILING' },
        ],
      },
      envelope: rejectionEnvelope({
        reason: 'column_flow entry 0 has no matching hop node.',
        hint: 'Resend column_flow entry 0 with a hop node from the archive.',
        detail: [{ path: 'column_flow.0', expected: 'known hop node' }],
      }),
    });

    expect(first.rejections[0].issuePaths).toEqual(['column_flow.0']);
    const flow = replayedToolArgs(replayed).column_flow as unknown[];
    expect(flow).toHaveLength(2);
    expect(flow[0]).toEqual({ from_col: 'A', to_col: 'B', marker: 'ENTRY-0-RAW' });
    expect(flow[1]).toEqual({ from_col: 'C', to_col: 'D', marker: 'ENTRY-1-TRAILING' });
  });

  it('replays the whole prune_neighbors list on a flagged entry, never a sparse array with null holes', async () => {
    const { replayed, first } = await replayAfterRejection({
      input: {
        prune_neighbors: ['[dbo].[A]', '[dbo].[B]', '[dbo].[C]'],
      },
      envelope: rejectionEnvelope({
        reason: 'prune_neighbors entry 1 would orphan committed work.',
        hint: 'Remove [dbo].[B] from prune_neighbors.',
        detail: [{ path: 'prune_neighbors.1', expected: 'not orphaning' }],
      }),
    });

    expect(first.rejections[0].issuePaths).toEqual(['prune_neighbors.1']);
    const pruneNeighbors = replayedToolArgs(replayed).prune_neighbors as unknown[];
    expect(pruneNeighbors).toEqual(['[dbo].[A]', '[dbo].[B]', '[dbo].[C]']);
  });

  it('caps the replayed correction envelope at the declared reason, hint, and detail bounds', async () => {
    const longReason = 'R'.repeat(400);
    const longHint = 'H'.repeat(4_000);
    const { replayed, first } = await replayAfterRejection({
      input: { column_flow: [{ from_col: 'A', to_col: 'B' }] },
      envelope: rejectionEnvelope({
        reason: longReason,
        hint: longHint,
        detail: { path: 'column_flow.0', padding: 'P'.repeat(5_000) },
      }),
    });

    const rejection = first.rejections[0];
    expect(rejection.reason).toHaveLength(MAX_REJECTION_TEXT_CHARS + 1);
    expect(rejection.reason.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(String(rejection.hint))).toBeLessThanOrEqual(MAX_REJECTION_HINT_BYTES);
    expect(String(rejection.hint)).toContain('[+4000 bytes total; remainder omitted]');
    // An over-budget structured detail is replaced atomically by a size-only stub, never partially kept.
    expect(rejection.detail).toEqual({ omitted: true, bytes: expect.any(Number) });
    expect((rejection.detail as { bytes: number }).bytes).toBeGreaterThan(MAX_BOUNDED_STRUCTURED_BYTES);

    const envelope = replayedToolResult(replayed);
    expect(String(envelope.reason)).toHaveLength(MAX_REJECTION_TEXT_CHARS + 1);
    expect(JSON.stringify(envelope)).not.toContain('PPPPPPPPPP');
  });

  it('replays every column_flow entry inside the whole-list byte budget, stubbing only what does not fit', async () => {
    // column_flow is a WHOLE_LIST_CORRECTION_ROOT, so entry count is never capped at
    // MAX_CORRECTION_FRAGMENTS — that cap only bounds the single-fragment path, which the
    // `correctionFragments` regex can no longer route column_flow/route_requests/prune_neighbors
    // through now that all three are whole-list roots. Completeness is held by
    // WHOLE_LIST_CORRECTION_BYTES instead: every element gets an equal byte share, and only an
    // element over its share collapses to a stub — the array itself keeps every position, so a
    // large column_flow still shows the model its full index range and entry count, with stubbed
    // content only where an entry did not fit.
    const oversizedEntry = { from_col: 'A', to_col: 'B', marker: `OVERSIZED-${'z'.repeat(3_000)}` };
    const { replayed, first } = await replayAfterRejection({
      input: {
        column_flow: [
          oversizedEntry,
          { from_col: 'C', to_col: 'D', marker: 'KEEP-1' },
          { from_col: 'E', to_col: 'F', marker: 'KEEP-2' },
          { from_col: 'G', to_col: 'H', marker: 'KEEP-3' },
          { from_col: 'I', to_col: 'J', marker: 'KEEP-4' },
          { from_col: 'K', to_col: 'L', marker: 'KEEP-5' },
        ],
      },
      envelope: rejectionEnvelope({
        reason: 'Six column_flow entries are malformed.',
        detail: Array.from({ length: 6 }, (_unused, index) => ({ path: `column_flow.${index}` })),
      }),
    });

    expect(first.rejections[0].issuePaths).toHaveLength(6);
    const args = replayedToolArgs(replayed);
    const flow = args.column_flow as unknown[];
    // Every position survives — six entries in, six entries out, none dropped for a count cap.
    expect(flow).toHaveLength(6);
    expect(flow.some((entry) => entry === null || entry === undefined)).toBe(false);

    // Entry 0 exceeded its equal share of the whole-list byte budget and became an atomic
    // size-only stub — never a hole, never a drop.
    expect(flow[0]).toEqual({ omitted: true, bytes: expect.any(Number) });
    expect((flow[0] as { bytes: number }).bytes).toBeGreaterThan(MAX_BOUNDED_STRUCTURED_BYTES);
    expect(flow[1]).toEqual({ from_col: 'C', to_col: 'D', marker: 'KEEP-1' });
    expect(flow[5]).toEqual({ from_col: 'K', to_col: 'L', marker: 'KEEP-5' });

    const wire = JSON.stringify(replayed);
    expect(wire).not.toContain('OVERSIZED-');
    // The small entries that a count cap used to drop now ride the replay too.
    expect(wire).toContain('KEEP-4');
    expect(wire).toContain('KEEP-5');
  });

  it('replays every present_result section when only one is flagged, so an unflagged section is never rewritten', async () => {
    const { replayed, first } = await replayAfterRejection({
      toolName: 'lineage_present_result',
      input: {
        sections: [
          { label: 'Formula', text: 'SECTION-0-TEXT', node_ids: ['[dbo].[Orders]'] },
          { label: 'Risk', text: 'SECTION-1-TEXT', node_ids: ['[dbo].[Ghost]'] },
        ],
        narrative: RAW_PROSE_MARKER,
      },
      envelope: rejectionEnvelope({
        reason: 'sections entry 1 names an unknown node id.',
        detail: [{ path: 'sections.1.node_ids', expected: 'known node id' }],
      }),
    });

    expect(first.rejections[0].issuePaths).toEqual(['sections.1.node_ids']);
    const args = replayedToolArgs(replayed);
    // A resent list replaces the whole list, so the error-free section rides along verbatim; two
    // entries stay inside MAX_CORRECTION_FRAGMENTS.
    expect(Object.keys(args)).toEqual(['sections']);
    expect(args.sections).toEqual([
      { label: 'Formula', text: 'SECTION-0-TEXT', node_ids: ['[dbo].[Orders]'] },
      { label: 'Risk', text: 'SECTION-1-TEXT', node_ids: ['[dbo].[Ghost]'] },
    ]);
    expect(JSON.stringify(replayed)).not.toContain(RAW_PROSE_MARKER);
  });

  it('replays the whole submit_findings call when the rejection names no path, so a full resend can carry it over', async () => {
    // A route rejection orders "resend submit_findings whole, carrying your sections and summary over
    // unchanged" and names no field path; a replay of `{}` leaves the model rebuilding the call from
    // memory, which reintroduced an already-repaired out_col (a recorded T8 generation).
    const columnFlow = Array.from({ length: 6 }, (_, index) => ({
      out_col: `Col${index}`,
      upstream_columns: [{ node: '[dbo].[Src]', col: `Src${index}`, transforms: ['direct'] }],
    }));
    const input = {
      focus_node_id: '[dbo].[spClean]',
      verdict: 'analyze',
      summary: 'SUMMARY-CARRIED',
      sections: [{ label: 'Formula', text: 'SECTION-CARRIED' }],
      column_flow: columnFlow,
      route_requests: ['[dbo].[Src]'],
      prune_neighbors: ['[dbo].[Required]'],
    };
    const { replayed, first } = await replayAfterRejection({
      input,
      envelope: rejectionEnvelope({
        reason: 'route_validation_failed',
        hint: 'Nothing is held here: resend submit_findings whole, carrying your sections and summary over unchanged alongside both repairs.',
        detail: [{ id: '[dbo].[Required]', reason: 'Pruning `[dbo].[Required]` would orphan committed work.' }],
      }),
    });

    expect(first.rejections[0].issuePaths).toBeUndefined();
    expect(replayedToolArgs(replayed)).toEqual(input);
  });

  it('replays a present_result rejection by name and call id, collapsing the draft-duplicate field instead of blanking the call', async () => {
    const sections = [
      { label: 'Formula', text: 'HELD-SECTION-0', node_ids: ['[dbo].[Orders]'] },
      { label: 'Risk', text: 'HELD-SECTION-1', node_ids: ['[dbo].[Ghost]'] },
    ];
    const { replayed } = await replayAfterRejection({
      toolName: 'lineage_present_result',
      input: { sections, narrative: RAW_PROSE_MARKER },
      envelope: rejectionEnvelope({
        reason: 'sections entry 1 names an unknown node id.',
        detail: [{ path: 'sections.1.node_ids', expected: 'known node id' }],
      }),
      presentResultRepairDraftHeld: true,
      presentResultRepairDraftContext: () => ({ sections, notes: [], highlight_groups: [] }),
    });

    // The draft block is the one carrier of the section text; the replayed call is never blanked to
    // {} (that reads as "your previous call carried nothing") — instead the field the draft already
    // shows in full collapses to a count-only marker, so the call still names what it touched.
    expect(replayedToolArgs(replayed)).toEqual({ sections: { collapsed: true, count: 2 } });
    const wire = JSON.stringify(replayed);
    expect(wire.split('HELD-SECTION-0').length - 1).toBe(1);
    expect(wire.split('HELD-SECTION-1').length - 1).toBe(1);
    expect(wire).not.toContain(RAW_PROSE_MARKER);
  });

  it('replays a prevalidation-rejected repair patch whole while a draft is held — the draft never received it', async () => {
    // The held draft still shows the uncorrected render; the patch that added the missing node was
    // refused by the schema before any handler ran. Replaying it as {} left the model rebuilding the
    // patch from the stale draft and re-sending the gap the validation had named.
    const heldSections = [{ label: 'Feeds', text: 'HELD-SECTION', node_ids: ['[dbo].[Orders]'] }];
    const patch = {
      is_update: true,
      sections: [...heldSections, { label: 'Archive', text: 'PATCH-ADDED-SECTION', node_ids: ['[dbo].[Archive]'] }],
      highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['[dbo].[Archive]'] }],
    };
    const { replayed, first } = await replayAfterInvalidCall({
      toolName: 'lineage_present_result',
      input: patch,
      reason: 'Unrecognized key: "highlight_groups"',
      issuePaths: [''],
      presentResultRepairDraftContext: () => ({ sections: heldSections, notes: [], highlight_groups: [] }),
    });

    expect(first.rejections[0].code).toBe('invalid_tool_input');
    expect(String(replayed[1].content)).toContain('held_draft_repair_state');
    const args = replayedToolArgs(replayed);
    expect(JSON.stringify(args.sections)).toContain('PATCH-ADDED-SECTION');
    expect(args.highlight_groups).toBeDefined();
  });

  it('replays a long present_result list complete, bounded by bytes rather than skipped past four entries', async () => {
    const sections = Array.from({ length: 6 }, (_unused, index) => ({
      label: `Section ${index}`,
      text: index === 0 ? `LONG-${'s'.repeat(9_000)}` : `SHORT-SECTION-${index}`,
    }));
    const { replayed, first } = await replayAfterInvalidCall({
      toolName: 'lineage_present_result',
      input: { sections, narrative: RAW_PROSE_MARKER },
      reason: 'sections.5: Unrecognized key: "notes"',
      issuePaths: ['sections.5.notes'],
    });

    expect(first.rejections[0].issuePaths).toEqual(['sections.5.notes']);
    const args = replayedToolArgs(replayed);
    const replayedSections = args.sections as unknown[];
    expect(replayedSections).toHaveLength(6);
    expect(replayedSections.every((entry) => entry !== undefined)).toBe(true);
    const wire = JSON.stringify(replayed);
    for (let index = 1; index < 6; index += 1) expect(wire).toContain(`SHORT-SECTION-${index}`);
    // The oversized element is truncated to its share of the list budget, never carried whole.
    expect(wire).not.toContain('s'.repeat(9_000));
    expect(Buffer.byteLength(JSON.stringify(replayedSections))).toBeLessThanOrEqual(MAX_CORRECTION_FRAGMENTS * MAX_BOUNDED_STRUCTURED_BYTES + 512);
    expect(wire).not.toContain(RAW_PROSE_MARKER);
  });

  it('replays every section of a schema-invalid present_result call instead of empty arguments', async () => {
    const { replayed, first } = await replayAfterInvalidCall({
      toolName: 'lineage_present_result',
      input: {
        sections: [
          { label: 'Overview', text: 'INVALID-SECTION-0', notes: ['nested-note'] },
          { label: 'Formula', text: 'INVALID-SECTION-1' },
          { label: 'Risk', text: 'INVALID-SECTION-2' },
        ],
        narrative: RAW_PROSE_MARKER,
      },
      reason: 'sections.0: Unrecognized key: "notes"',
      issuePaths: ['sections.0.notes'],
    });

    expect(first.rejections[0].issuePaths).toEqual(['sections.0.notes']);
    const args = replayedToolArgs(replayed);
    expect(Object.keys(args)).toEqual(['sections']);
    expect(args.sections).toEqual([
      { label: 'Overview', text: 'INVALID-SECTION-0', notes: ['nested-note'] },
      { label: 'Formula', text: 'INVALID-SECTION-1' },
      { label: 'Risk', text: 'INVALID-SECTION-2' },
    ]);
    // The standing repair sentence must also bind the unflagged elements of a resent list.
    expect(String(first.rejections[0].hint)).toContain('repeating the unflagged elements exactly as first sent');
    expect(JSON.stringify(replayed)).not.toContain(RAW_PROSE_MARKER);
  });

  it('carries a producer-derived invalid_tool_input hint through to the rejection instead of the standing sentence', async () => {
    // vscodeModelPort.ts now derives an unrecognized-key-specific hint from the ZodError via
    // rejectionFromZodError (toolErrorEnvelope.ts) and stamps it on the GeneratedToolCall; this
    // pins that toolAttempt.ts's rejectionFromInvalid() prefers `call.hint` over the fixed
    // INVALID_TOOL_INPUT_REPAIR_HINT sentence. Before the fix, `rejectionFromInvalid` always
    // applied the fixed sentence regardless of any hint the producer attached, so this assertion
    // would see the standing "keep every other field unchanged" text instead.
    const producerHint = 'Resend the tool call with the unrecognized field "notes" removed entirely'
      + ' — it is not part of this tool\'s input schema at all, so do not resend it under any name'
      + ' or nesting; keep every other field unchanged.';
    const { first } = await replayAfterInvalidCall({
      toolName: 'lineage_present_result',
      input: { sections: [{ label: 'Overview', text: 'x', notes: ['n'] }] },
      reason: 'sections.0: Unrecognized key: "notes"',
      issuePaths: ['sections.0.notes'],
      hint: producerHint,
    });

    expect(first.rejections[0].hint).toBe(producerHint);
    expect(first.rejections[0].hint).not.toContain('keep every other field unchanged, and resend every element of a corrected list');
  });

  it('replays the whole schema-invalid call when the flagged field is not a list, instead of empty arguments', async () => {
    // An out-of-enum `layout_direction` flags a scalar root no list projection covers; the standing
    // hint orders "keep every other field unchanged", so a replay of `{}` sent the model into a full
    // regeneration of an answer it had already authored (recorded on the length cap this fixture
    // used to carry: 146, 123, 124 chars, then terminal). Length caps no longer reject at this
    // boundary — `validatePresentResult` owns them and holds the draft — but every remaining
    // schema-shaped scalar issue still replays the whole call.
    const input = {
      layout_direction: 'SIDEWAYS',
      sections: [{ label: 'Overview', text: 'SECTION-CARRIED' }],
    };
    const { replayed, first } = await replayAfterInvalidCall({
      toolName: 'lineage_present_result',
      input,
      reason: 'layout_direction: Invalid option: expected one of "LR"|"TB"',
      issuePaths: ['layout_direction'],
    });

    expect(first.rejections[0].issuePaths).toEqual(['layout_direction']);
    expect(replayedToolArgs(replayed)).toEqual(input);
  });

  it('replays the whole submit_findings call when a missing required array field flags a bare root, instead of empty arguments', async () => {
    // A dropped required `column_flow` rejects with issuePaths=["column_flow"] — a bare root, no
    // `.N` index — so `correctionFragments()`'s array-entry projection cannot match it and the
    // fallback must be the whole bounded call carrying every other field the model already sent;
    // a `{}` replay leaves the model resending without `column_flow` again.
    const input = {
      focus_node_id: '[ct].[vwSurchargedSales]',
      verdict: 'analyze',
      summary: 'SUMMARY-CARRIED',
      sections: [{ label: 'Formula', text: 'SECTION-CARRIED' }],
      route_requests: ['[ct].[Orders]'],
    };
    const { replayed, first } = await replayAfterInvalidCall({
      toolName: 'lineage_submit_findings',
      input,
      reason: 'column_flow: Invalid input: expected array, received undefined',
      issuePaths: ['column_flow'],
    });

    expect(first.rejections[0].issuePaths).toEqual(['column_flow']);
    expect(replayedToolArgs(replayed)).toEqual(input);
  });

  it('replays a dispatched rejection whose recorded input is an array or a raw string as a bounded raw_input fragment, never {} or []', async () => {
    // rejectionFromResult()'s replayFragments() falls through correctionFragments() (object-only)
    // to wholeCallFragments() for a dispatched call whose own recorded input was never a plain
    // object. Before the fix wholeCallFragments() returned [] for exactly this shape, so
    // boundedCorrectionArgs([]) rendered the replayed call as {} — the third/fourth {} source named
    // in the semantic-breaker log (toolAttempt.ts non-object raw-input projection).
    const arrayInput = ['unexpected', 'array', 'payload'];
    const { replayed: arrayReplayed, first: arrayFirst } = await replayAfterRejection({
      input: arrayInput,
      envelope: rejectionEnvelope({ reason: 'submit_findings expected an object payload, not an array.' }),
    });

    expect(arrayFirst.rejections[0].correctionFragments).toEqual([{ path: 'raw_input', value: arrayInput }]);
    const arrayArgs = replayedToolArgs(arrayReplayed);
    expect(arrayArgs).toEqual({ raw_input: arrayInput });
    expect(JSON.stringify(arrayArgs)).not.toBe('{}');
    expect(JSON.stringify(arrayArgs)).not.toBe('[]');

    const stringInput = '{"column_flow":[]';
    const { replayed: stringReplayed, first: stringFirst } = await replayAfterRejection({
      input: stringInput,
      envelope: rejectionEnvelope({ reason: 'submit_findings expected an object payload, not a raw string.' }),
    });

    expect(stringFirst.rejections[0].correctionFragments).toEqual([{ path: 'raw_input', value: stringInput }]);
    const stringArgs = replayedToolArgs(stringReplayed);
    expect(stringArgs).toEqual({ raw_input: stringInput });
    expect(JSON.stringify(stringArgs)).not.toBe('{}');
    expect(JSON.stringify(stringArgs)).not.toBe('[]');
  });

  it('renders the held present_result repair draft as its own labeled message before the correction', async () => {
    const { replayed } = await replayAfterRejection({
      input: { column_flow: [{ from_col: 'A', to_col: 'B' }] },
      envelope: rejectionEnvelope({ reason: 'Flow entry 0 is incomplete.', detail: [{ path: 'column_flow.0' }] }),
      presentResultRepairDraftContext: () => ({
        sections: [{ label: 'Source', text: 'HELD-DRAFT-SECTION-TEXT' }],
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['[dbo].[Orders]'] }],
      }),
    });

    // [user prompt, held-draft repair state, assistant tool-call replay, paired tool result, continuation note]
    expect(replayed).toHaveLength(5);
    const heldDraft = String(replayed[1].content);
    expect(heldDraft).toContain('held_draft_repair_state');
    expect(heldDraft).toContain('HELD-DRAFT-SECTION-TEXT');
    expect(heldDraft).toContain('This is your own currently held draft for this repair turn');
  });

  it('surfaces the held notes and names all three held fields in the banner', async () => {
    const { replayed } = await replayAfterRejection({
      input: { column_flow: [{ from_col: 'A', to_col: 'B' }] },
      envelope: rejectionEnvelope({ reason: 'Flow entry 0 is incomplete.', detail: [{ path: 'column_flow.0' }] }),
      presentResultRepairDraftContext: () => ({
        sections: [{ label: 'Source', text: 'HELD-DRAFT-SECTION-TEXT' }],
        notes: [{ node_id: '[dbo].[Orders]', text: 'HELD-DRAFT-NOTE-TEXT' }],
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['[dbo].[Orders]'] }],
      }),
    });

    expect(replayed).toHaveLength(5);
    const heldDraft = String(replayed[1].content);
    // The rendered block must expose the held notes verbatim, including the node_id they attach to
    // — otherwise a repair-turn model cannot see the note it is asked to patch.
    expect(heldDraft).toContain('HELD-DRAFT-NOTE-TEXT');
    expect(heldDraft).toContain('[dbo].[Orders]');
    // The banner must name all three held fields, not just the two the model can currently see.
    expect(heldDraft).toContain('sections, notes, and highlight_groups');
  });

  it('omits the held-draft message entirely when no repairable draft is on hold', async () => {
    const { replayed } = await replayAfterRejection({
      input: { column_flow: [{ from_col: 'A', to_col: 'B' }] },
      envelope: rejectionEnvelope({ reason: 'Flow entry 0 is incomplete.', detail: [{ path: 'column_flow.0' }] }),
      presentResultRepairDraftContext: () => null,
    });

    expect(replayed).toHaveLength(4);
    expect(JSON.stringify(replayed)).not.toContain('held_draft_repair_state');
  });

  // m16: the stored-rejection budget collapse (`boundStoredRejections` retaining
  // `essentialCurrentRejection` when even the single newest rejection does not fit) used to drop
  // `correctionFragments` outright, so `boundedCorrectionArgs(undefined)` rendered `{}` here —
  // re-opening the empty-input replay ce6be3e15 closed on the dispatched-rejection path.
  it('replays a rejection collapsed by the stored-rejection budget as non-empty arguments, never {}', async () => {
    // A 1000-token model window floors `storedEvidenceKindBytes` at 0, so even the single newest
    // rejection cannot fit and the in-place collapse branch fires on the very first record.
    const budget = createTurnTokenBudget({ modelWindowTokens: 1_000 });
    const { replayed, state } = await replayAfterRejection({
      input: { column_flow: [{ from_col: 'A', to_col: 'B' }] },
      envelope: rejectionEnvelope({ reason: 'Flow entry 0 is incomplete.', detail: [{ path: 'column_flow.0' }] }),
      budget,
    });

    // Sanity: the collapse actually happened, so this proves the fix and not an untouched path.
    expect(state.rejections[0].correctionFragments).toHaveLength(1);
    expect(state.rejections[0].correctionFragments![0]).toMatchObject({ path: 'raw_input', value: { omitted: true } });

    const args = replayedToolArgs(replayed);
    expect(args).not.toEqual({});
    expect(Object.keys(args).length).toBeGreaterThan(0);
  });

  it('keeps inputHash, preDispatch, and unproductiveStreak on a rejection collapsed by the stored-rejection budget', () => {
    const budget = createTurnTokenBudget({ modelWindowTokens: 1_000 });
    const attempt = {
      stop: 'continue' as const,
      providerCalls: 1,
      semanticFailures: 1,
      observations: [],
      rejections: [{
        callId: 'call-1',
        toolName: 'lineage_present_result',
        code: 'invalid_tool_input',
        reason: 'layout_direction: Invalid option: expected one of "LR"|"TB"',
        correctionFragments: [{ path: 'layout_direction', value: 'SIDEWAYS' }],
        inputHash: 'hash-abc123',
        preDispatch: true as const,
        unproductiveStreak: 3,
      }],
    };

    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), attempt, budget);

    expect(state.rejections).toHaveLength(1);
    const collapsed = state.rejections[0];
    expect(collapsed.inputHash).toBe('hash-abc123');
    expect(collapsed.preDispatch).toBe(true);
    expect(collapsed.unproductiveStreak).toBe(3);
    // The retry-ladder machinery these fields feed (unproductive-resend absorption, the
    // pre-dispatch/dispatched distinction) reads exactly this collapsed object as `priorRejection`
    // on the next attempt, so a dropped field here silently disables it there.
    expect(collapsed.correctionFragments).toBeDefined();
    expect(collapsed.correctionFragments!.length).toBeGreaterThan(0);
  });

  it('logs the in-place collapse of a single stored rejection under budget pressure, not just a count change', () => {
    const logged: string[] = [];
    const budget = createTurnTokenBudget({ modelWindowTokens: 1_000 });
    const attempt = {
      stop: 'continue' as const,
      providerCalls: 1,
      semanticFailures: 1,
      observations: [],
      rejections: [{
        callId: 'call-1',
        toolName: 'lineage_get_details',
        code: 'validation',
        reason: 'bad',
        correctionFragments: [{ path: 'node_id', value: 'X' }],
      }],
    };

    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), attempt, budget, (message) => logged.push(message));

    // Retained count is unchanged (1 in, 1 out), so the existing count-delta log never fires...
    expect(state.rejections).toHaveLength(1);
    expect(logged.some((message) => message.includes('stored corrections dropped by budget'))).toBe(false);
    // ...but the in-place shrink is still an observable event, naming the tool and callId it hit.
    const collapseLogs = logged.filter((message) => message.includes('stored rejection collapsed by budget'));
    expect(collapseLogs).toHaveLength(1);
    expect(collapseLogs[0]).toContain('tool=lineage_get_details');
    expect(collapseLogs[0]).toContain('callId=call-1');
    expect(collapseLogs[0]).toContain('phase=active');
  });
});

// ---------------------------------------------------------------------------
// (f) lineage_present_result repair-budget exemption
// ---------------------------------------------------------------------------

describe('executeToolGenerationAttempt — present_result repair-budget exemption', () => {
  const exemptionCases: ReadonlyArray<{
    name: string;
    toolName: string;
    code: 'invalid_tool_input' | 'unknown_tool';
    draftHeld: boolean;
    expectedCharged: number;
  }> = [
    {
      name: 'exempts a present_result prevalidation reject while a repair draft is held',
      toolName: 'lineage_present_result',
      code: 'invalid_tool_input',
      draftHeld: true,
      expectedCharged: 0,
    },
    {
      name: 'charges an initial present_result prevalidation reject with no held draft',
      toolName: 'lineage_present_result',
      code: 'invalid_tool_input',
      draftHeld: false,
      expectedCharged: 1,
    },
    {
      name: 'charges a non-prevalidation present_result reject even with a held draft',
      toolName: 'lineage_present_result',
      code: 'unknown_tool',
      draftHeld: true,
      expectedCharged: 1,
    },
    {
      name: 'charges another tool\'s prevalidation reject even with a held draft',
      toolName: 'lineage_submit_findings',
      code: 'invalid_tool_input',
      draftHeld: true,
      expectedCharged: 1,
    },
  ];

  for (const testCase of exemptionCases) {
    it(testCase.name, async () => {
      const { result } = await runAttempt(
        [{ toolCalls: [invalidCall('call-1', testCase.toolName, testCase.code, 'sections: Required')] }],
        [
          { name: 'lineage_present_result', result: '{"success":true}' },
          { name: 'lineage_submit_findings', result: '{"ok":true}' },
        ],
        { presentResultRepairDraftHeld: testCase.draftHeld },
      );

      expect(result.calls[0].status).toBe('rejected');
      expect(result.semanticFailures).toBe(testCase.expectedCharged);
    });
  }

  it('keeps the batch open for siblings when the exempt reject would otherwise exhaust the budget', async () => {
    const { result, invocations } = await runAttempt(
      [{
        toolCalls: [
          invalidCall('call-1', 'lineage_present_result', 'invalid_tool_input', 'sections: Required'),
          validCall('call-2', 'lineage_search_objects', { query: 'Orders' }),
        ],
      }],
      [
        { name: 'lineage_present_result', result: '{"success":true}' },
        { name: 'lineage_search_objects', result: '{"matches":[]}' },
      ],
      { semanticFailuresRemaining: 1, presentResultRepairDraftHeld: true },
    );

    expect(result.calls.map((call) => call.status)).toEqual(['rejected', 'executed']);
    expect(result.semanticFailures).toBe(0);
    expect(invocations).toEqual([{ toolName: 'lineage_search_objects', input: { query: 'Orders' } }]);
  });

  it('threads the exemption from executeToolAttempt options through to the budget guard', async () => {
    const { registry } = scriptedRegistry([{ name: 'lineage_present_result', result: '{"success":true}' }]);
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: ['lineage_present_result'] };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'synthesis' },
      input: {
        messages: [modelUserMessage('Render the result.')],
        registry,
        sink,
        phase: 'synthesis',
        instructionContext: context,
      },
    };
    const port = new ScriptedModelPort([{
      toolCalls: [invalidCall('call-1', 'lineage_present_result', 'invalid_tool_input', 'sections: Required')],
    }]);

    const result = await executeToolAttempt(port, plan, { presentResultRepairDraftHeld: true });

    expect(result.semanticFailures).toBe(0);
    expect(result.rejections).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (g) unproductive-resend pre-check: no strike for a resend that changed nothing
// ---------------------------------------------------------------------------

describe('executeToolGenerationAttempt / executeToolAttempt — unproductive-resend pre-check', () => {
  /** Canonical `present_result`-shaped failure envelope, `repairFields` and issue path included. */
  function presentResultRejectionEnvelope(fields: {
    reason: string;
    hint: string;
    repairFields: readonly string[];
    issuePath: string;
  }): string {
    return JSON.stringify({
      success: false,
      errors: [fields.reason],
      hint: fields.hint,
      repairable: true,
      repairFields: fields.repairFields,
      detail: [{ path: fields.issuePath }],
    });
  }

  /** Replays a fixed generation queue through `executeToolAttempt` + `recordToolAttempt`, exactly as the graph replays a rejected submission across attempts. */
  async function runAttemptSequence(
    generations: readonly ScriptedGeneration[],
    tools: readonly ScriptedTool[],
  ): Promise<{ state: ToolPhaseAttemptState; results: readonly ToolAttemptResult[] }> {
    const { registry } = scriptedRegistry(tools);
    const port = new ScriptedModelPort(generations);
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: registry.getTools().map((tool) => tool.name) };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: {
        messages: [modelUserMessage('Present the final result.')],
        registry,
        sink,
        phase: 'active',
        instructionContext: context,
      },
    };
    let state = initialToolPhaseAttemptState('active');
    const results: ToolAttemptResult[] = [];
    for (let index = 0; index < generations.length; index++) {
      const result = await executeToolAttempt(port, plan, { priorState: state });
      results.push(result);
      state = recordToolAttempt(state, result);
    }
    return { state, results };
  }

  it('answers a cross-attempt resend of an accepted read with an uncharged duplicate_read envelope instead of a silent replay', async () => {
    const { registry, invocations } = scriptedRegistry([{ name: 'lineage_get_screen_state', effect: 'read', result: '{"stale":[{"id":"[ai].[vwpricelist]"}]}' }]);
    const port = new ScriptedModelPort([
      { toolCalls: [validCall('call-1', 'lineage_get_screen_state', { filter: 'stale' })] },
      { toolCalls: [validCall('call-2', 'lineage_get_screen_state', { filter: 'stale' })] },
      { text: 'Two objects changed.' },
    ]);
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: ['lineage_get_screen_state'] };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: { messages: [modelUserMessage('Has anything changed?')], registry, sink, phase: 'active', instructionContext: context },
    };
    let state = initialToolPhaseAttemptState('active');
    const results: ToolAttemptResult[] = [];
    for (let index = 0; index < 3; index++) {
      const result = await executeToolAttempt(port, plan, { priorState: state });
      results.push(result);
      state = recordToolAttempt(state, result);
    }

    expect(invocations).toHaveLength(1);
    expect(results[1].calls.map((call) => call.status)).toEqual(['rejected']);
    expect(results[1].rejections[0]?.code).toBe(REJECTION_CODES.duplicateRead);
    expect(results[1].semanticFailures).toBe(0);
    expect(state.semanticFailures).toBe(0);
    expect(state.stopReason).toBeNull();
    const replayed = port.requests[2].messages;
    const resultEnvelope = JSON.parse(String(replayed[replayed.length - 2].content)) as Record<string, unknown>;
    expect(resultEnvelope.code).toBe(REJECTION_CODES.duplicateRead);
    expect(String(resultEnvelope.reason)).toContain('call-1');
    expect(replayed.map((message) => String(message.content)).join(' ')).toContain('[ai].[vwpricelist]');
  });

  it('bounds the duplicate_read exemption: identical resends past the free allowance charge a strike until the phase closes', async () => {
    const { registry, invocations } = scriptedRegistry([{ name: 'lineage_get_screen_state', effect: 'read', result: '{"stale":[{"id":"[ai].[vwpricelist]"}]}' }]);
    const resend = (index: number) => ({ toolCalls: [validCall(`call-${index}`, 'lineage_get_screen_state', { filter: 'stale' })] });
    const port = new ScriptedModelPort(Array.from({ length: 8 }, (_, index) => resend(index + 1)));
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: ['lineage_get_screen_state'] };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: { messages: [modelUserMessage('Has anything changed?')], registry, sink, phase: 'active', instructionContext: context },
    };
    let state = initialToolPhaseAttemptState('active');
    const failuresPerAttempt: number[] = [];
    while (state.stopReason === null && failuresPerAttempt.length < 8) {
      const result = await executeToolAttempt(port, plan, { priorState: state });
      failuresPerAttempt.push(result.semanticFailures);
      state = recordToolAttempt(state, result);
    }

    // One dispatch; every later call is the same read. The first duplicate and the two absorbed
    // resends after it are free; from the third consecutive identical resend each one charges.
    expect(invocations).toHaveLength(1);
    expect(failuresPerAttempt).toEqual([0, 0, 0, 0, 1, 1, 1]);
    expect(state.rejections.every((rejection) => rejection.code === REJECTION_CODES.duplicateRead)).toBe(true);
    expect(state.rejections.at(-1)?.unproductiveStreak).toBe(5);
    expect(state.semanticFailures).toBe(3);
    expect(state.stopReason).toBe('semantic_failures');
  });

  it('logs a [Reject] line for every rejection it raises without a dispatch, so the log and the trace count the same rejections', async () => {
    const { registry } = scriptedRegistry([{ name: 'lineage_get_screen_state', effect: 'read', result: '{"stale":[{"id":"[ai].[vwpricelist]"}]}' }]);
    const port = new ScriptedModelPort([
      { toolCalls: [validCall('call-1', 'lineage_get_screen_state', { filter: 'stale' })] },
      { toolCalls: [validCall('call-2', 'lineage_get_screen_state', { filter: 'stale' })] },
      { text: 'Two objects changed.' },
    ]);
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: ['lineage_get_screen_state'] };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: { messages: [modelUserMessage('Has anything changed?')], registry, sink, phase: 'active', instructionContext: context },
    };
    const logged: string[] = [];
    const traced: string[] = [];
    let state = initialToolPhaseAttemptState('active');
    for (let index = 0; index < 3; index++) {
      state = recordToolAttempt(state, await executeToolAttempt(port, plan, {
        priorState: state,
        debugLog: (message) => { logged.push(message); },
        traceSyntheticRejection: (rejection) => { traced.push(rejection.code); },
      }));
    }

    expect(traced).toEqual([REJECTION_CODES.duplicateRead]);
    const rejectLines = logged.filter((message) => message.startsWith('[Reject]'));
    expect(rejectLines).toHaveLength(traced.length);
    expect(rejectLines[0]).toContain(`code=${REJECTION_CODES.duplicateRead}`);
    expect(rejectLines[0]).toContain('tool=lineage_get_screen_state');
    expect(rejectLines[0]).toContain('callId=call-2');
  });

  it('retires a rejection once the same tool is accepted, so the repaired call is not replayed as a standing correction', async () => {
    const { registry } = scriptedRegistry([{ name: 'lineage_get_screen_state', effect: 'read', result: '{"stale":[{"id":"[ai].[vwpricelist]"}]}' }]);
    const port = new ScriptedModelPort([
      { toolCalls: [invalidCall('call-1', 'lineage_get_screen_state', 'invalid_tool_input', 'filter: Send either ids or filter, never both.', ['filter'])] },
      { toolCalls: [validCall('call-2', 'lineage_get_screen_state', { filter: 'stale' })] },
      { toolCalls: [validCall('call-3', 'lineage_get_screen_state', { filter: 'stale' })] },
      { text: 'Two objects changed.' },
    ]);
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: ['lineage_get_screen_state'] };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: { messages: [modelUserMessage('Has anything changed?')], registry, sink, phase: 'active', instructionContext: context },
    };
    let state = initialToolPhaseAttemptState('active');
    for (let index = 0; index < 4; index++) {
      state = recordToolAttempt(state, await executeToolAttempt(port, plan, { priorState: state }));
    }

    expect(state.rejections.map((rejection) => rejection.code)).toEqual([REJECTION_CODES.duplicateRead]);
    expect(state.observations.map((observation) => observation.callId)).toEqual(['call-2']);
    const rendered = (index: number) => port.requests[index].messages.map((message) => String(message.content)).join(' ');
    expect(rendered(1)).toContain('invalid_tool_input');
    expect(rendered(2)).not.toContain('invalid_tool_input');
    expect(rendered(3)).not.toContain('invalid_tool_input');
    expect(rendered(3)).toContain('[ai].[vwpricelist]');
  });

  it('stores the first body whole, answers the second that does not fit with a result_too_large reply, and still dedupes the repeat of the first', async () => {
    // A body too large for the hop is not truncated and not silently dropped — the reply says so
    // and hands the read to the hop-by-hop path. Held bodies are never touched.
    const bodies: Record<string, string> = {
      spimportorders: JSON.stringify({ id: 'spimportorders', body: 'A'.repeat(28_000) }),
      spcleanorders: JSON.stringify({ id: 'spcleanorders', body: 'B'.repeat(21_000) }),
    };
    const { registry, invocations } = scriptedRegistry([{
      name: 'lineage_get_object_detail',
      effect: 'read',
      result: (input) => bodies[String((input as { id: string }).id)],
    }]);
    const port = new ScriptedModelPort([
      { toolCalls: [validCall('call-1', 'lineage_get_object_detail', { id: 'spimportorders' })] },
      { toolCalls: [validCall('call-2', 'lineage_get_object_detail', { id: 'spcleanorders' })] },
      { toolCalls: [validCall('call-3', 'lineage_get_object_detail', { id: 'spimportorders' })] },
      { text: 'Both procedures write the staging table.' },
    ]);
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: ['lineage_get_object_detail'] };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: { messages: [modelUserMessage('What do these procedures do?')], registry, sink, phase: 'active', instructionContext: context },
    };
    const logged: string[] = [];
    let state = initialToolPhaseAttemptState('active');
    const results: ToolAttemptResult[] = [];
    for (let index = 0; index < 4; index++) {
      const result = await executeToolAttempt(port, plan, {
        priorState: state,
        debugLog: (message) => { logged.push(message); },
      });
      results.push(result);
      state = recordToolAttempt(state, result);
    }

    // The first body is stored whole and is still whole after the second call.
    expect(state.observations[0].result).toBe(bodies.spimportorders);
    // The second does not fit alongside it: the stored observation is the too-big reply, in the
    // tool-error shape, naming the sizes and the hand-off.
    expect(JSON.parse(state.observations[1].result)).toEqual({
      error: 'result_too_large',
      tool: 'lineage_get_object_detail',
      bytes: Buffer.byteLength(bodies.spcleanorders),
      held_bytes: Buffer.byteLength(bodies.spimportorders),
      budget: MAX_STORED_EVIDENCE_KIND_BYTES,
      hint: 'This result is larger than the evidence one hop can hold, so none of it was stored. Stop this tool loop; narrow the request with lineage_get_scope_bundle, or take the consent-gated hop-by-hop path with lineage_start_exploration, which reads one object per hop.',
    });
    const tooBig = logged.filter((message) => message.startsWith('[Observation] result too big'));
    expect(tooBig).toHaveLength(1);
    expect(tooBig[0]).toContain('callId=call-2');
    expect(tooBig[0]).toContain(`bytes=${Buffer.byteLength(bodies.spcleanorders)}`);
    // The repeat of the still-held first read is a duplicate, not a second dispatch.
    expect(invocations.map((invocation) => (invocation.input as { id: string }).id))
      .toEqual(['spimportorders', 'spcleanorders']);
    expect(results[2].rejections[0]?.code).toBe(REJECTION_CODES.duplicateRead);
    expect(state.semanticFailures).toBe(0);
    // The held body reaches the model on the next request; nothing was shrunk to make room.
    expect(port.requests[3].messages.map((message) => String(message.content)).join(' ')).toContain('A'.repeat(1_000));
  });

  it('keeps duplicate_read, hint unchanged, for a repeat whose stored body is still present', async () => {
    const body = JSON.stringify({ id: 'spimportorders', body: 'A'.repeat(1_000) });
    const { registry, invocations } = scriptedRegistry([{ name: 'lineage_get_object_detail', effect: 'read', result: body }]);
    const port = new ScriptedModelPort([
      { toolCalls: [validCall('call-1', 'lineage_get_object_detail', { id: 'spimportorders' })] },
      { toolCalls: [validCall('call-2', 'lineage_get_object_detail', { id: 'spimportorders' })] },
      { text: 'It writes the staging table.' },
    ]);
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: ['lineage_get_object_detail'] };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: { messages: [modelUserMessage('What does this procedure do?')], registry, sink, phase: 'active', instructionContext: context },
    };
    const logged: string[] = [];
    let state = initialToolPhaseAttemptState('active');
    const results: ToolAttemptResult[] = [];
    for (let index = 0; index < 3; index++) {
      const result = await executeToolAttempt(port, plan, {
        priorState: state,
        debugLog: (message) => { logged.push(message); },
      });
      results.push(result);
      state = recordToolAttempt(state, result);
    }

    expect(invocations).toHaveLength(1);
    expect(results[1].rejections[0]?.code).toBe(REJECTION_CODES.duplicateRead);
    // Mirrors the module-private `DUPLICATE_READ_HINT`: with the evicted case now re-served, this
    // sentence is true in every state it reaches the model in.
    expect(results[1].rejections[0]?.hint)
      .toBe('You already ran this call this hop; its result is in your observations. Answer from it, or call a different tool.');
    expect(state.observations[0].result).toBe(body);
  });

  it('restates the held error envelope instead of DUPLICATE_READ_HINT for a repeat whose stored body is a result_too_large reply', async () => {
    // The held body of the repeated read is the too-big stand-in stored for it — an error envelope,
    // so "Answer from it" would be false; the correction restates the held error.
    const bodies: Record<string, string> = {
      spimportorders: JSON.stringify({ id: 'spimportorders', body: 'A'.repeat(40_000) }),
      spcleanorders: JSON.stringify({ id: 'spcleanorders', body: 'B'.repeat(10_000) }),
    };
    const { registry, invocations } = scriptedRegistry([{
      name: 'lineage_get_object_detail',
      effect: 'read',
      result: (input) => bodies[String((input as { id: string }).id)],
    }]);
    const port = new ScriptedModelPort([
      { toolCalls: [validCall('call-1', 'lineage_get_object_detail', { id: 'spimportorders' })] },
      { toolCalls: [validCall('call-2', 'lineage_get_object_detail', { id: 'spcleanorders' })] },
      { toolCalls: [validCall('call-3', 'lineage_get_object_detail', { id: 'spcleanorders' })] },
      { text: 'The second procedure was refused storage for size.' },
    ]);
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: ['lineage_get_object_detail'] };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: { messages: [modelUserMessage('What do these procedures do?')], registry, sink, phase: 'active', instructionContext: context },
    };
    let state = initialToolPhaseAttemptState('active');
    const results: ToolAttemptResult[] = [];
    for (let index = 0; index < 4; index++) {
      const result = await executeToolAttempt(port, plan, { priorState: state });
      results.push(result);
      state = recordToolAttempt(state, result);
    }

    // Two dispatches only; the repeat of the second read is a duplicate, not a third dispatch.
    expect(invocations.map((invocation) => (invocation.input as { id: string }).id))
      .toEqual(['spimportorders', 'spcleanorders']);
    expect(results[2].rejections[0]?.code).toBe(REJECTION_CODES.duplicateRead);
    // The stored body of the repeated read is the error envelope, and the hint restates it —
    // code, then the held hint — instead of DUPLICATE_READ_HINT.
    expect(JSON.parse(state.observations[1].result)).toMatchObject({ error: 'result_too_large' });
    expect(results[2].rejections[0]?.hint).toBe(
      'The held result for callId call-2 is an error envelope (result_too_large): '
      + 'This result is larger than the evidence one hop can hold, so none of it was stored. Stop this tool loop; narrow the request with lineage_get_scope_bundle, or take the consent-gated hop-by-hop path with lineage_start_exploration, which reads one object per hop.',
    );
    expect(results[2].rejections[0]?.hint).not.toContain('Answer from it');
    // Charging and streak semantics are unchanged: the duplicate stays free on its first appearance.
    expect(results[2].semanticFailures).toBe(0);
    expect(state.semanticFailures).toBe(0);
  });

  it('two identical no-op resends spend no strike, and the phase keeps going instead of exhausting the budget', async () => {
    const envelope = presentResultRejectionEnvelope({
      reason: 'highlight_groups node_ids must be explained by sections[].node_ids or notes[]: [dbo].[Orders]',
      hint: 'Fix sections, notes, or highlight_groups.',
      repairFields: ['sections', 'notes'],
      issuePath: 'notes.7',
    });
    const { state, results } = await runAttemptSequence(
      [
        { toolCalls: [validCall('call-1', 'lineage_present_result', { sections: [{ label: 'Source', text: 'Detail.' }], notes: [] })] },
        { toolCalls: [validCall('call-2', 'lineage_present_result', { is_update: true })] },
        { toolCalls: [validCall('call-3', 'lineage_present_result', { is_update: true })] },
      ],
      [{ name: 'lineage_present_result', result: envelope }],
    );

    // Only the first, real submission charges; the two `{"is_update":true}` resends that touch
    // neither `sections` nor `notes` are absorbed by the pre-check.
    expect(results.map((result) => result.semanticFailures)).toEqual([1, 0, 0]);
    expect(state.semanticFailures).toBe(1);
    expect(state.stopReason).toBeNull();
    expect(state.rejections).toHaveLength(3);
  });

  it('a resend byte-identical to the payload just rejected spends no strike', async () => {
    const envelope = presentResultRejectionEnvelope({
      reason: 'Section "Import Orchestrator" node_ids contains unknown IDs',
      hint: 'Fix sections only.',
      repairFields: ['sections'],
      issuePath: 'sections.0',
    });
    const repaired = {
      is_update: true,
      sections: [{ label: 'Import Orchestrator', node_ids: ['[ai].[spimportorders]'], text: 'Detail.' }],
    };
    const { state, results } = await runAttemptSequence(
      [
        { toolCalls: [validCall('call-1', 'lineage_present_result', { sections: [{ label: 'Import Orchestrator', node_ids: ['[ai].[bogus]'], text: 'Detail.' }] })] },
        { toolCalls: [validCall('call-2', 'lineage_present_result', repaired)] },
        { toolCalls: [validCall('call-3', 'lineage_present_result', repaired)] },
      ],
      [{ name: 'lineage_present_result', result: envelope }],
    );

    // Attempt 2 is a genuine (different) repair and charges. Attempt 3 resends attempt 2's exact
    // payload byte-for-byte and must not charge a second time.
    expect(results.map((result) => result.semanticFailures)).toEqual([1, 1, 0]);
    expect(state.semanticFailures).toBe(2);
    expect(state.stopReason).toBeNull();
  });

  it('still charges a genuine repair that touches an authorized field with new content — the pre-check is not a free-retry loop', async () => {
    const envelope = presentResultRejectionEnvelope({
      reason: 'Section "Import Orchestrator" node_ids contains unknown IDs',
      hint: 'Fix sections only.',
      repairFields: ['sections'],
      issuePath: 'sections.0',
    });
    const { state, results } = await runAttemptSequence(
      [
        { toolCalls: [validCall('call-1', 'lineage_present_result', { sections: [{ label: 'Import Orchestrator', node_ids: ['[ai].[bogus]'], text: 'Detail.' }] })] },
        { toolCalls: [validCall('call-2', 'lineage_present_result', { is_update: true, sections: [{ label: 'Import Orchestrator', node_ids: ['[ai].[spimportorders]'], text: 'Corrected detail.' }] })] },
      ],
      [{ name: 'lineage_present_result', result: envelope }],
    );

    expect(results.map((result) => result.semanticFailures)).toEqual([1, 1]);
    expect(state.semanticFailures).toBe(2);
  });

  it('bounds the free absorption: past two consecutive no-op resends every further one charges, closing the phase instead of spinning to the provider-call cap', async () => {
    const envelope = presentResultRejectionEnvelope({
      reason: 'notes[].text must be non-empty.',
      hint: 'Fix notes only.',
      repairFields: ['notes'],
      issuePath: 'notes.0',
    });
    const noOp = { is_update: true };
    const { state, results } = await runAttemptSequence(
      [
        { toolCalls: [validCall('call-1', 'lineage_present_result', { sections: [{ label: 'Source', text: 'Detail.' }], notes: [{ text: '' }] })] },
        { toolCalls: [validCall('call-2', 'lineage_present_result', noOp)] },
        { toolCalls: [validCall('call-3', 'lineage_present_result', noOp)] },
        { toolCalls: [validCall('call-4', 'lineage_present_result', noOp)] },
        { toolCalls: [validCall('call-5', 'lineage_present_result', noOp)] },
      ],
      [{ name: 'lineage_present_result', result: envelope }],
    );

    // Streak grace stays 2 (the no-op-resend test above), then strikes resume: the genuine rejection
    // charges 1, no-ops 1-2 are free, no-ops 3-4 charge — semantic budget closes the phase at 5
    // provider calls instead of running to the 10-call cap.
    expect(results.map((result) => result.semanticFailures)).toEqual([1, 0, 0, 1, 1]);
    expect(state.semanticFailures).toBe(3);
    expect(state.stopReason).toBe('semantic_failures');
  });

  it('exempts a single attempt whose input touches none of a directly supplied prior rejection\'s repairFields', async () => {
    const priorRejection = {
      callId: 'call-1',
      toolName: 'lineage_present_result',
      code: 'validation',
      reason: 'highlight_groups node_ids must be explained by sections[].node_ids or notes[].',
      detail: { repairFields: ['sections', 'notes'] },
      inputHash: 'does-not-match-this-attempt',
    };
    const { result } = await runAttempt(
      [{ toolCalls: [validCall('call-2', 'lineage_present_result', { is_update: true })] }],
      [{ name: 'lineage_present_result', result: rejectionEnvelope({ reason: 'still unresolved' }) }],
      { priorRejection },
    );

    expect(result.semanticFailures).toBe(0);
    // The new rejection retains its own input fingerprint for the attempt after this one.
    expect(result.rejections[0].inputHash).toEqual(expect.any(String));
  });

  it('never exempts a rejection on a different tool than the one the prior rejection named', async () => {
    const priorRejection = {
      callId: 'call-1',
      toolName: 'lineage_submit_findings',
      code: 'validation',
      reason: 'unrelated defect',
      detail: { repairFields: ['sections'] },
      inputHash: 'irrelevant',
    };
    const { result } = await runAttempt(
      [{ toolCalls: [validCall('call-2', 'lineage_present_result', { is_update: true })] }],
      [{ name: 'lineage_present_result', result: rejectionEnvelope({ reason: 'still unresolved' }) }],
      { priorRejection },
    );

    expect(result.semanticFailures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (h) repair-turn prevalidation exemption is bounded — the free channel must not spin
// ---------------------------------------------------------------------------

describe('executeToolAttempt — repair-turn prevalidation exemption is bounded', () => {
  /**
   * Replays a fixed generation queue through `executeToolAttempt` + `recordToolAttempt` with a
   * held `present_result` repair draft — the state the graph holds between a rejected submission
   * and its repair — exactly as the graph replays attempts across one repair turn.
   */
  async function runRepairTurnSequence(
    generations: readonly ScriptedGeneration[],
    tools: readonly ScriptedTool[],
  ): Promise<{ state: ToolPhaseAttemptState; results: readonly ToolAttemptResult[] }> {
    const { registry } = scriptedRegistry(tools);
    const port = new ScriptedModelPort(generations);
    const { sink } = collectingSink();
    const context = { kind: 'converse' as const, templateKeys: [], memorySections: [], toolNames: registry.getTools().map((tool) => tool.name) };
    const plan: ConverseInstructionPlan = {
      kind: 'converse',
      context,
      frame: { phase: 'active' },
      input: {
        messages: [modelUserMessage('Present the final result.')],
        registry,
        sink,
        phase: 'active',
        instructionContext: context,
      },
    };
    let state = initialToolPhaseAttemptState('active');
    const results: ToolAttemptResult[] = [];
    for (let index = 0; index < generations.length; index++) {
      const result = await executeToolAttempt(port, plan, { priorState: state, presentResultRepairDraftHeld: true });
      results.push(result);
      state = recordToolAttempt(state, result);
    }
    return { state, results };
  }

  /** One schema-invalid `present_result` call as SDK prevalidation rejects it, payload attached. */
  function invalidPresentResult(callId: string, input: unknown) {
    return invalidCall(
      callId,
      'lineage_present_result',
      'invalid_tool_input',
      'sections: at least one section is required',
      ['sections'],
      input,
    );
  }

  it('charges identical repair-turn prevalidation resends past the absorbed grace, closing the semantic budget instead of spinning to the provider-call cap', async () => {
    const resend = { sections: [] };
    const { state, results } = await runRepairTurnSequence(
      [1, 2, 3, 4, 5, 6].map((attempt) => ({
        toolCalls: [invalidPresentResult(`call-${attempt}`, resend)],
      })),
      [{ name: 'lineage_present_result', result: '{"success":true}' }],
    );

    // The first reject is the exemption working (genuine mid-correction); the next two identical
    // resends ride the shared absorption grace; every identical resend past it charges like any
    // other invalid call. Without the bound, this exact pattern once looped free until only the
    // provider-call cap stopped it — a phase that never terminates on its own evidence.
    expect(results.map((result) => result.semanticFailures)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(state.semanticFailures).toBe(MAX_TOOL_SEMANTIC_FAILURES);
    expect(state.stopReason).toBe('semantic_failures');
    expect(state.providerCalls).toBe(6);
    expect(state.providerCalls).toBeLessThan(MAX_TOOL_PROVIDER_CALLS);
  });

  it('never charges a genuine prevalidation repair attempt whose input differs from the just-rejected one', async () => {
    const repairs = [
      { sections: [] },
      { sections: [{ label: 'Source', text: 'One section.' }] },
      { notes: [{ text: 'A note.' }] },
      { is_update: true, sections: [{ label: 'Source', text: 'One corrected section.' }] },
    ];
    const { state, results } = await runRepairTurnSequence(
      repairs.map((input, index) => ({ toolCalls: [invalidPresentResult(`call-${index + 1}`, input)] })),
      [{ name: 'lineage_present_result', result: '{"success":true}' }],
    );

    // Each attempt is a different payload — a real repair in progress — so the bound from the
    // previous test must not fire: the streak never grows and nothing charges.
    expect(results.map((result) => result.semanticFailures)).toEqual([0, 0, 0, 0]);
    expect(state.semanticFailures).toBe(0);
    expect(state.stopReason).toBeNull();
  });

  it('keeps the unproductive-resend streak across a dispatched rejection interleaved between identical prevalidation rejects', async () => {
    const resend = { sections: [] };
    const { state, results } = await runRepairTurnSequence(
      [
        { toolCalls: [invalidPresentResult('call-1', resend)] },
        { toolCalls: [invalidPresentResult('call-2', resend)] },
        // A dispatched rejection of the same payload between prevalidation rejects is itself an
        // absorbed resend of the identical streak, not a new correction that resets it.
        { toolCalls: [validCall('call-3', 'lineage_present_result', resend)] },
        { toolCalls: [invalidPresentResult('call-4', resend)] },
        { toolCalls: [invalidPresentResult('call-5', resend)] },
        { toolCalls: [invalidPresentResult('call-6', resend)] },
      ],
      [{ name: 'lineage_present_result', result: rejectionEnvelope({ reason: 'sections: at least one section is required' }) }],
    );

    // If the interleaved dispatched rejection reset the streak, the charge would only land on the
    // last attempt and the phase would stay open. The streak must survive both channels.
    expect(results.map((result) => result.semanticFailures)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(state.semanticFailures).toBe(MAX_TOOL_SEMANTIC_FAILURES);
    expect(state.stopReason).toBe('semantic_failures');
  });
});

// ---------------------------------------------------------------------------
// Non-dispatched rejections are traced (UAT: 12 of 35 rejections left no `tool` record)
// ---------------------------------------------------------------------------

describe('executeToolGenerationAttempt — every non-dispatched rejection is traced', () => {
  it('traces a schema-invalid call and its budget-closed siblings', async () => {
    const traced: Array<{ toolName: string; code: string }> = [];
    const { result } = await runAttempt(
      [{
        toolCalls: [
          invalidCall('call-1', 'lineage_get_details', 'invalid_tool_input', 'node_id: Required', ['node_id']),
          invalidCall('call-2', 'lineage_get_details', 'invalid_tool_input', 'node_id: Required', ['node_id']),
          validCall('call-3', 'lineage_search_objects', { query: 'Orders' }),
        ],
      }],
      [{ name: 'lineage_search_objects', result: '{"matches":[]}' }],
      {
        semanticFailuresRemaining: 1,
        traceSyntheticRejection: (rejection) => traced.push(rejection),
      },
    );

    expect(result.calls.map((call) => call.status)).toEqual(['rejected', 'budget_closed', 'budget_closed']);
    expect(traced).toEqual([
      { toolName: 'lineage_get_details', code: 'invalid_tool_input' },
      { toolName: 'lineage_get_details', code: 'attempt_budget_exhausted' },
      { toolName: 'lineage_search_objects', code: 'attempt_budget_exhausted' },
    ]);
  });

  it('traces a phase-closed sibling after a terminal success', async () => {
    const traced: Array<{ toolName: string; code: string }> = [];
    const { result } = await runAttempt(
      [{
        toolCalls: [
          validCall('call-1', 'lineage_present_result', { is_update: false }),
          validCall('call-2', 'lineage_search_objects', { query: 'Orders' }),
        ],
      }],
      [
        { name: 'lineage_present_result', result: '{"success":true}' },
        { name: 'lineage_search_objects', result: '{"matches":[]}' },
      ],
      {
        requiredTerminalTool: 'lineage_present_result',
        traceSyntheticRejection: (rejection) => traced.push(rejection),
      },
    );

    expect(result.calls.map((call) => call.status)).toEqual(['executed', 'phase_closed']);
    expect(traced).toEqual([{ toolName: 'lineage_search_objects', code: 'phase_closed' }]);
  });

  it('does not trace a dispatched semantic rejection — the registry decorator already records it', async () => {
    const traced: Array<{ toolName: string; code: string }> = [];
    const { result } = await runAttempt(
      [{ toolCalls: [validCall('call-1', 'lineage_submit_findings', { column_flow: [] })] }],
      [{ name: 'lineage_submit_findings', result: rejectionEnvelope({ reason: 'wrong columns' }) }],
      { traceSyntheticRejection: (rejection) => traced.push(rejection) },
    );

    expect(result.calls.map((call) => call.status)).toEqual(['rejected']);
    expect(traced).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (d) an empty present_result repair patch rejects at the Zod boundary, not by re-running the
// held-draft validation with nothing new to say
// ---------------------------------------------------------------------------

describe('presentResultRepairPatchSchemaForFields — empty repair patch prevalidation', () => {
  it('rejects a repair patch that touches no authorized field, naming every authorized field in the issue', () => {
    // Before the fix an empty patch (only is_update, or nothing at all) parsed successfully, merged
    // nothing into the held draft, and re-ran the full held-draft validation — reproducing the
    // identical prior rejection with no signal that the patch itself carried no correction
    // (toolAttempt.ts issue log, m10 2026-09-15). This is the Zod superRefine added at the schema
    // boundary in presentResultRepairPatchSchemaForFields (toolSchemas.ts).
    const schema = presentResultRepairPatchSchemaForFields(['sections', 'summary']);

    const parsed = schema.safeParse({ is_update: true });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.error.issues.map((issue) => issue.path.join('.')).sort();
    expect(paths).toEqual(['sections', 'summary']);
    for (const issue of parsed.error.issues) {
      expect(issue.message).toContain('sections');
      expect(issue.message).toContain('summary');
    }

    // A patch with no fields at all (not even is_update) is the same defect.
    const bareParsed = schema.safeParse({});
    expect(bareParsed.success).toBe(false);
  });

  it('accepts a repair patch that touches at least one authorized field', () => {
    const schema = presentResultRepairPatchSchemaForFields(['sections', 'summary']);
    expect(schema.safeParse({ is_update: true, summary: 'Corrected summary.' }).success).toBe(true);
    expect(schema.safeParse({ sections: [{ label: 'Overview', text: 'Corrected.' }] }).success).toBe(true);
  });
});
