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
import { modelUserMessage } from '../../../src/ai/model/modelPort';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import type { IToolRegistry } from '../../../src/ai/tools/registry';
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
      hint: 'Resend the full tool call with only the offending field(s) corrected; keep every other field unchanged.',
      issuePaths: ['column_flow.0.to_col'],
    });
    // The rejected input is absent by type — the envelope has no payload-bearing key at all.
    expect(Object.keys(rejection).sort()).toEqual(['callId', 'code', 'hint', 'issuePaths', 'reason', 'toolName']);
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
// (d) 48KB shrink ladder with explicit, non-silent omission accounting
// ---------------------------------------------------------------------------

describe('renderToolAttemptContext — 48KB attempt-context shrink ladder', () => {
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

  it('truncates then collapses oversized observations with exact byte accounting', () => {
    const body = 'D'.repeat(40_000);
    const rendered = renderToolAttemptContext(stateWithObservations([body, body]));

    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(MAX_ATTEMPT_CONTEXT_BYTES);

    // Ladder step 1: equal-share truncation at floor(49152 / 2) = 24576 bytes per observation,
    // so the reported drop is exactly 40000 - 24576. Nothing is dropped silently.
    const fairShare = Math.floor(MAX_ATTEMPT_CONTEXT_BYTES / 2);
    const dropped = body.length - fairShare;
    expect(rendered).toContain(`+${dropped} bytes omitted from retry context`);
    expect(rendered).toContain('the full result was delivered when this call first ran');

    // Ladder step 2: the oldest observation collapses to an identity+size stub whose byte count is
    // the ORIGINAL body size, so the model still learns exactly how much evidence exists.
    expect(rendered).toContain('\\"omitted\\":true,\\"bytes\\":40000');
  });

  it('reduces every oversized body under a wide batch, each reduction explicitly accounted', () => {
    const rendered = renderToolAttemptContext(stateWithObservations(Array.from({ length: 12 }, () => 'X'.repeat(30_000))));

    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(MAX_ATTEMPT_CONTEXT_BYTES);
    // Equal-share truncation at floor(49152 / 12) = 4096 bytes, then oldest-first collapse until
    // the rendered payload fits. Both reductions state their exact byte cost.
    const fairShare = Math.floor(MAX_ATTEMPT_CONTEXT_BYTES / 12);
    expect(rendered).toContain(`+${30_000 - fairShare} bytes omitted from retry context`);
    expect(rendered).toContain('\\"omitted\\":true,\\"bytes\\":30000');
    // No body survives at anything approaching its original size.
    expect(rendered).not.toContain('X'.repeat(fairShare + 1));
  });

  it('falls back to a single counted observation summary when rejections alone exceed the budget', () => {
    const state: ToolPhaseAttemptState = {
      ...stateWithObservations(Array.from({ length: 12 }, () => 'X'.repeat(30_000))),
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
    // Terminal observation step: one count+bytes summary standing in for all 12 observations.
    expect(rendered).toContain('"collapsed":true,"count":12,"bytes":360000');
    expect(rendered).not.toContain('XXXXXXXXXX');
    // Terminal rejection step: bulk detail dropped, the actionable correction retained in full.
    expect(rendered).not.toContain('TERMINAL-BULK-');
    expect(rendered).toContain('NEWEST-HINT: resend column_flow entry 3.');
    expect(rendered).toContain('column_flow.3');
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

  it('bounds a stored observation to the checkpoint share with a total-size marker', () => {
    const body = 'B'.repeat(60_000);
    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), {
      stop: 'continue',
      providerCalls: 1,
      semanticFailures: 0,
      observations: [{ callId: 'call-0', toolName: 'lineage_get_details', result: body }],
      rejections: [],
    });

    const [stored] = state.observations;
    expect(Buffer.byteLength(stored.result)).toBeLessThanOrEqual(MAX_STORED_EVIDENCE_KIND_BYTES);
    expect(stored.result).toContain('[+60000 bytes total; remainder omitted]');
  });

  it('keeps the read-dedupe identity on a truncated observation', () => {
    // `acceptedCallKey` is what a later attempt reuses instead of re-dispatching an identical read.
    // Dropping it while truncating disables the dedupe on exactly the over-budget hops that caused
    // the truncation, so the next attempt pays for the same read again.
    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), {
      stop: 'continue',
      providerCalls: 1,
      semanticFailures: 0,
      observations: [{
        callId: 'call-0',
        toolName: 'lineage_get_object_detail',
        result: 'B'.repeat(60_000),
        acceptedCallKey: 'accepted-key-0',
      }],
      rejections: [],
    });

    expect(state.observations[0].acceptedCallKey).toBe('accepted-key-0');
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

  /** Runs one rejected submit_findings attempt, then a follow-up attempt that replays it. */
  async function replayAfterRejection(options: {
    input: unknown;
    envelope: string;
    presentResultRepairDraftHeld?: boolean;
    presentResultRepairDraftContext?: () => { sections?: unknown; highlight_groups?: unknown } | null;
  }): Promise<{ replayed: readonly BaseMessage[]; state: ToolPhaseAttemptState; first: ToolAttemptResult }> {
    const { registry } = scriptedRegistry([{ name: 'lineage_submit_findings', result: options.envelope }]);
    const plan = conversePlan(registry);

    const firstPort = new ScriptedModelPort([{
      toolCalls: [validCall('call-1', 'lineage_submit_findings', options.input)],
    }]);
    const first = await executeToolAttempt(firstPort, plan);
    const state = recordToolAttempt(initialToolPhaseAttemptState('active'), first);

    const secondPort = new ScriptedModelPort([{ text: 'Acknowledged.' }]);
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

  function replayedToolArgs(messages: readonly BaseMessage[]): Record<string, unknown> {
    const toolCallMessage = messages[messages.length - 2] as AIMessage;
    const call = toolCallMessage.tool_calls?.[0];
    expect(call).toBeDefined();
    return (call?.args ?? {}) as Record<string, unknown>;
  }

  function replayedToolResult(messages: readonly BaseMessage[]): Record<string, unknown> {
    return JSON.parse(String(messages[messages.length - 1].content)) as Record<string, unknown>;
  }

  it('replays only the flagged correction fragment, never the original payload', async () => {
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
    // messages: [original user message, assistant tool-call replay, paired tool result]
    expect(replayed).toHaveLength(3);

    const args = replayedToolArgs(replayed);
    expect(Object.keys(args)).toEqual(['column_flow']);
    const flow = args.column_flow as unknown[];
    expect(flow).toHaveLength(2);
    expect(flow[0]).toBeUndefined();
    expect(flow[1]).toEqual({ from_col: 'C', to_col: 'D', marker: 'ENTRY-1-RAW' });

    const wire = JSON.stringify(replayed);
    expect(wire).toContain('ENTRY-1-RAW');
    expect(wire).not.toContain('ENTRY-0-RAW');
    expect(wire).not.toContain('ENTRY-2-RAW');
    expect(wire).not.toContain(RAW_PROSE_MARKER);

    const envelope = replayedToolResult(replayed);
    expect(envelope.code).toBe('validation');
    expect(envelope.hint).toBe('Resend column_flow entry 1 with a hop node from the archive.');
    expect(envelope.issuePaths).toEqual(['column_flow.1']);
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

  it('retains at most four correction fragments and stubs any fragment over its byte bound', async () => {
    const oversizedEntry = { from_col: 'A', to_col: 'B', marker: `OVERSIZED-${'z'.repeat(3_000)}` };
    const { replayed, first } = await replayAfterRejection({
      input: {
        column_flow: [
          oversizedEntry,
          { from_col: 'C', to_col: 'D', marker: 'KEEP-1' },
          { from_col: 'E', to_col: 'F', marker: 'KEEP-2' },
          { from_col: 'G', to_col: 'H', marker: 'KEEP-3' },
          { from_col: 'I', to_col: 'J', marker: 'DROP-4' },
          { from_col: 'K', to_col: 'L', marker: 'DROP-5' },
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
    const present = flow.filter((entry) => entry !== undefined);
    expect(present).toHaveLength(MAX_CORRECTION_FRAGMENTS);

    // Fragment 0 exceeded the 2KB per-fragment bound and became an atomic size-only stub.
    expect(flow[0]).toEqual({ omitted: true, bytes: expect.any(Number) });
    expect((flow[0] as { bytes: number }).bytes).toBeGreaterThan(MAX_BOUNDED_STRUCTURED_BYTES);
    expect(flow[1]).toEqual({ from_col: 'C', to_col: 'D', marker: 'KEEP-1' });

    const wire = JSON.stringify(replayed);
    expect(wire).not.toContain('OVERSIZED-');
    expect(wire).not.toContain('DROP-4');
    expect(wire).not.toContain('DROP-5');
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

    // [user prompt, held-draft repair state, assistant tool-call replay, paired tool result]
    expect(replayed).toHaveLength(4);
    const heldDraft = String(replayed[1].content);
    expect(heldDraft).toContain('held_draft_repair_state');
    expect(heldDraft).toContain('HELD-DRAFT-SECTION-TEXT');
    expect(heldDraft).toContain('This is your own currently held draft for this repair turn');
  });

  it('omits the held-draft message entirely when no repairable draft is on hold', async () => {
    const { replayed } = await replayAfterRejection({
      input: { column_flow: [{ from_col: 'A', to_col: 'B' }] },
      envelope: rejectionEnvelope({ reason: 'Flow entry 0 is incomplete.', detail: [{ path: 'column_flow.0' }] }),
      presentResultRepairDraftContext: () => null,
    });

    expect(replayed).toHaveLength(3);
    expect(JSON.stringify(replayed)).not.toContain('held_draft_repair_state');
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

  it('replays turn 23: two identical no-op resends spend no strike, and the phase keeps going instead of exhausting the budget', async () => {
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
    // neither `sections` nor `notes` (turn 23's exact 19-byte payload) are absorbed by the pre-check.
    expect(results.map((result) => result.semanticFailures)).toEqual([1, 0, 0]);
    expect(state.semanticFailures).toBe(1);
    expect(state.stopReason).toBeNull();
    expect(state.rejections).toHaveLength(3);
  });

  it('replays turn 9: a resend byte-identical to the payload just rejected spends no strike', async () => {
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
    // payload byte-for-byte — the recorded turn-9 defect — and must not charge a second time.
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

    // The recorded 2026-08-19 deepseek turn resent one rejected payload 8 times until the user
    // cancelled. Streak grace stays 2 (the turn-23 pin above), then strikes resume: the genuine
    // rejection charges 1, no-ops 1-2 are free, no-ops 3-4 charge — semantic budget closes the
    // phase at 5 provider calls instead of running to the 10-call cap.
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
