/**
 * A real object is never rejected as "unknown" (P1-16).
 *
 * The id check already runs over the whole loaded model before this validator sees it, so an id the
 * result graph cannot link is either a hallucination — "not in the loaded model" — or a real node in
 * a state the engine already records. The two need different repairs, and the model only ever sees
 * the first reason line (the rejection replay caps it and drops `detail`), so both the per-id state
 * and the accepted set must ride in the message itself.
 *
 * Measured shape (T8S @ 37875e19): `[ai].[vwraworders]` (border-cut) and `[ai].[spbuildsalesreport]`
 * (analysed, then dropped by the render bound) drew the same "unknown IDs" text as an invented id,
 * were resubmitted three times, and ended the run on the semantic-failure breaker.
 */
import { describe, expect, it } from 'vitest';
import {
  PRESENT_NODE_ID_STATE_TEXT,
  orderAndAssemble,
  validatePresentResult,
  type PresentNodeIdState,
} from '../../../src/ai/tools/presentResult';

const KEPT = '[ai].[vwdiscountcalc]';
/** Analysed at hop 2, then dropped from the render as an undispositioned write sink. */
const DROPPED = '[ai].[spbuildsalesreport]';
/** Never in any model — the hallucination class. */
const INVENTED = '[ai].[vwtotallymadeup]';

const STATES: Readonly<Record<string, PresentNodeIdState>> = {
  [DROPPED]: 'render_dropped',
  [INVENTED]: 'not_in_model',
};

/** One synthesis call linking a render-dropped node and an invented one from the same section. */
function rejectOneCall(stage: 'synthesis' | 'completed' = 'synthesis') {
  const sections = [{ label: 'Consumers', node_ids: [KEPT, DROPPED, INVENTED], text: 'One.' }];
  const assembled = orderAndAssemble(sections);
  const result = validatePresentResult(
    { name: 'ok', summary: 'ok', sections, highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [KEPT] }] },
    [KEPT],
    assembled.badges,
    assembled.description,
    false,
    [],
    stage,
    id => STATES[id] ?? 'not_in_model',
  );
  expect(result.success, 'the call is rejected').toBe(false);
  return result as Extract<typeof result, { success: false }>;
}

describe('present_result node ids — the reject names the state the engine records', () => {
  it('a dropped analysed node and an invented id get two differently worded entries', () => {
    const result = rejectOneCall();
    const reason = result.errors[0];

    expect(reason.includes(DROPPED) && reason.includes(INVENTED),
      'both offending ids reach the model in the one field the replay keeps').toBe(true);
    expect(reason.includes(PRESENT_NODE_ID_STATE_TEXT.render_dropped),
      'the real node is named by the disposition the render recorded').toBe(true);
    expect(reason.includes(PRESENT_NODE_ID_STATE_TEXT.not_in_model),
      'only the unresolvable id is called out as absent from the model').toBe(true);
    expect(PRESENT_NODE_ID_STATE_TEXT.render_dropped === PRESENT_NODE_ID_STATE_TEXT.not_in_model,
      'the two states are worded differently').toBe(false);
    expect(reason.includes(KEPT), 'the accepted result-graph ids are stated, not withheld').toBe(true);
    expect(reason.includes('unknown'),
      'a real object is never rejected as unknown').toBe(false);
  });

  it('an all-invented call keeps the unknown-ID wording', () => {
    const sections = [{ label: 'Consumers', node_ids: [KEPT, INVENTED], text: 'One.' }];
    const assembled = orderAndAssemble(sections);
    const result = validatePresentResult(
      { name: 'ok', summary: 'ok', sections, highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [KEPT] }] },
      [KEPT], assembled.badges, assembled.description, false, [], 'synthesis',
      () => 'not_in_model',
    );
    expect(!result.success && result.errors[0].includes('unknown IDs'),
      'a hallucination is still called what it is').toBe(true);
  });

  it('the way back is the one the tool accepts at this stage', () => {
    expect(rejectOneCall('synthesis').errors[0].includes('add_node_ids'),
      'the graph is locked during synthesis — no add route to offer').toBe(false);
    expect(rejectOneCall('completed').errors[0].includes('add_node_ids'),
      'completed phase is the only stage that accepts add_node_ids').toBe(true);
  });

  it('detail carries every offending id with its state and the full accepted set', () => {
    const detail = rejectOneCall().detail ?? [];
    const entry = detail.find(item => item.unlinkable_node_ids !== undefined)!;

    expect(entry.path, 'the offender is still pinned to its section').toBe('sections.0');
    expect(entry.unlinkable_node_ids?.map(item => item.node_id), 'both offenders are listed in full')
      .toEqual([DROPPED, INVENTED]);
    expect(entry.unlinkable_node_ids?.map(item => item.state), 'each with its own recorded state')
      .toEqual([PRESENT_NODE_ID_STATE_TEXT.render_dropped, PRESENT_NODE_ID_STATE_TEXT.not_in_model]);
    expect(entry.accepted_node_ids, 'the uncapped accepted set').toEqual([KEPT]);
  });

  it('offenders in different fields are all named in the first reason line', () => {
    const sections = [{ label: 'Consumers', node_ids: [KEPT], text: 'One.' }];
    const assembled = orderAndAssemble(sections);
    const result = validatePresentResult(
      {
        name: 'ok', summary: 'ok', sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [KEPT, DROPPED] }],
        notes: [{ node_id: INVENTED, text: 'Bad note.' }],
      },
      [KEPT], assembled.badges, assembled.description, false, [], 'synthesis',
      id => STATES[id] ?? 'not_in_model',
    );
    const reason = (result as Extract<typeof result, { success: false }>).errors[0];
    expect(reason.includes(DROPPED) && reason.includes(INVENTED),
      'a rejection at one path still names the offenders at the others').toBe(true);
  });
});
