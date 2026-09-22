/**
 * The repair allowance is only ever spent on repairs the model could actually make.
 *
 * `MAX_TOOL_SEMANTIC_FAILURES` is three strikes per phase. It exists to bound a model that keeps
 * submitting a payload the engine keeps refusing — the correction is in the model's hands, so each
 * attempt is worth a strike. `NON_CHARGEABLE_REJECTION_CODES` (`src/ai/agent/toolAttempt.ts`) is
 * the list of rejections that fails that test, and it already held the transport artifacts and the
 * two scope-budget codes.
 *
 * The session/state codes belong on it for the same reason and were charging anyway. Each one
 * reports that the host's own session, turn lease or focus has moved: the engine is in the wrong
 * status, the focus is not the one dispatched, the run memory or the turn epoch is gone. No
 * correction the model could write changes any of them, so a strike spent there is a strike taken
 * away from a real semantic repair later in the same phase — and three of them close a phase that
 * had no semantic failure in it at all.
 *
 * The second half of the file is the audit trail. `charged=` on the `[Reject]` debug lines makes
 * the chargeability decision readable in a trace instead of inferable by re-deriving the set from
 * source, which is what made this class of bug invisible for as long as it was.
 */
import { describe, expect, it } from 'vitest';
import {
  executeToolGenerationAttempt,
  type ToolAttemptResult,
} from '../../../src/ai/agent/toolAttempt';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import {
  ScriptedModelPort,
  collectingSink,
  scriptedRegistry,
  validCall,
  type ScriptedGeneration,
} from './helpers/scriptedModelPort';

type AttemptInput = Parameters<typeof executeToolGenerationAttempt>[1];

/** Runs one scripted generation through the real executor, capturing its debug lines. */
async function runAttempt(
  generations: readonly ScriptedGeneration[],
  toolResult: string,
  overrides: Partial<AttemptInput> = {},
): Promise<{ result: ToolAttemptResult; logged: string[] }> {
  const { registry } = scriptedRegistry([{ name: 'lineage_submit_findings', result: toolResult }]);
  const { sink } = collectingSink();
  const logged: string[] = [];
  const input: AttemptInput = {
    messages: [],
    registry,
    sink,
    phase: 'active',
    debugLog: (message: string) => { logged.push(message); },
    ...overrides,
  };
  const result = await executeToolGenerationAttempt(new ScriptedModelPort(generations), input);
  return { result, logged };
}

/** One dispatched `submit_findings` whose result is the given host-state error envelope. */
function hostStateRejection(code: string): Promise<{ result: ToolAttemptResult; logged: string[] }> {
  return runAttempt(
    [{ toolCalls: [validCall('call-1', 'lineage_submit_findings', { focus_node_id: 'n1' })] }],
    JSON.stringify({ error: code, message: `the host reports ${code}` }),
  );
}

/**
 * Every code the host raises about its own session, turn lease or focus state.
 *
 * @remarks
 * `invalid_status`, `invalid_focus_node` and `focus_mismatch` are matched as literals because
 * `submit_findings` is their only surface, which is what keeps them out of `rejectionCodes.ts`
 * (a code earns a constant there once a second surface shows it to the model).
 */
const HOST_STATE_CODES: ReadonlyArray<string> = [
  REJECTION_CODES.noActiveSession,
  REJECTION_CODES.noRunMemory,
  REJECTION_CODES.staleTurn,
  REJECTION_CODES.staleProposalRevision,
  REJECTION_CODES.alreadyStarted,
  REJECTION_CODES.supplementRequiresCompleteEngine,
  'invalid_status',
  'invalid_focus_node',
  'focus_mismatch',
];

describe('the semantic-failure budget is not spent on host state the model cannot repair', () => {
  for (const code of HOST_STATE_CODES) {
    it(`does not charge a ${code} rejection`, async () => {
      const { result } = await hostStateRejection(code);

      expect(result.rejections[0]?.code, 'the rejection is still raised and still reaches the model').toBe(code);
      expect(
        result.semanticFailures,
        `${code} reports host state, not a repairable payload — charging it takes a strike from a real repair`,
      ).toBe(0);
    });
  }

  it('still charges a rejection the model can actually repair', async () => {
    const { result } = await hostStateRejection('route_validation_failed');

    expect(
      result.semanticFailures,
      'the exemption is narrow: a payload fault the model can correct keeps costing a strike',
    ).toBe(1);
  });
});

describe('the [Reject] debug lines state whether the rejection was charged', () => {
  it('marks a synthesized non-chargeable rejection charged=false', async () => {
    const { result, logged } = await runAttempt(
      [{ text: '' }],
      '{"ok":true}',
      { requiredTerminalTool: 'lineage_submit_findings' },
    );

    expect(result.rejections[0]?.code, 'an empty generation is a provider artifact, not an answer').toBe(REJECTION_CODES.emptyGeneration);
    const line = logged.find((message) => message.startsWith('[Reject] source=graph_attempt'));
    expect(line, 'the synthesized rejection writes its own [Reject] line').toBeDefined();
    expect(line ?? '', 'and states the chargeability decision rather than leaving a reader to re-derive the set').toContain('charged=false');
  });

  it('marks a synthesized chargeable rejection charged=true', async () => {
    const { result, logged } = await runAttempt(
      [{ text: 'Here is what I would call, in prose.' }],
      '{"ok":true}',
      { requiredTerminalTool: 'lineage_submit_findings' },
    );

    expect(result.rejections[0]?.code, 'prose in place of the required call is the model\'s own mistake').toBe('missing_required_tool_call');
    const line = logged.find((message) => message.startsWith('[Reject] source=graph_attempt'));
    expect(line ?? '', 'so the same line reports the opposite decision, and the two are told apart in a trace').toContain('charged=true');
  });
});
