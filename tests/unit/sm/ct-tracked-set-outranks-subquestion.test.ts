/**
 * The CT hop states which column set is authoritative, instead of letting a stale sub-question ask
 * for columns the trace does not follow.
 *
 * A `route_requests[].question` is authored by the model on the hop that opens a route and
 * re-delivered verbatim as that node's `<current_task>` one or more hops later. Between the two,
 * the active column set can narrow — a column the earlier hop thought was in play may have been
 * accounted for, or never have been tracked at all. An observed run shows exactly that: a hop-3
 * sub-question asking about `Qty`, `StagingID` and `RegionCode` delivered alongside
 * `Active columns: [Qty]`. The model answered the question it was given and named untracked
 * columns in `column_flow`, which the engine then rejected.
 *
 * The engine must not repair this by editing the question. Rewriting model-authored prose means the
 * backend reading and judging content, which it does not do. It states its own fact instead: the
 * `<column_trace>` list is the whole tracked set for the hop and outranks the sub-question, a
 * column the question names but the list omits does not belong in `column_flow`, and what the node
 * does with it belongs in `sections[].text` — so the observation is not lost, only routed to the
 * field that accepts it.
 */
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';
import { describe, expect, it } from 'vitest';

/** The observed shape: a model-authored question naming more columns than the hop still tracks. */
const STALE_SUB_QUESTION =
  'How does vwConsolidatedSales derive Qty (renamed from OrderQty?) and StagingID/RegionCode from its sources?';

describe('buildCurrentTaskBlock — the tracked column set outranks the delivered sub-question', () => {
  it('states the precedence, the column_flow consequence and where the untracked observation goes', () => {
    const block = buildCurrentTaskBlock(
      [{ kind: 'analytical', question: STALE_SUB_QUESTION }],
      ['Qty'],
    );

    expect(block, 'the tracked set is still printed').toContain('Active columns: [Qty]');
    expect(block, 'the block says the list is the whole tracked set, not a highlight of it').toContain('whole tracked set for this hop');
    expect(block, 'and says which of the two sources wins when they disagree').toContain('outranks the sub-question');
    expect(block, 'the consequence is stated as a field rule, not as a judgement about the question').toContain('`column_flow` may not name it');
    expect(block, 'the observation is redirected rather than discarded').toContain('sections[].text');
  });

  it('leaves the model-authored question byte-for-byte intact', () => {
    const block = buildCurrentTaskBlock(
      [{ kind: 'analytical', question: STALE_SUB_QUESTION }],
      ['Qty'],
    );

    expect(
      block,
      'the engine states its own fact and never edits the question — filtering model prose would be the backend judging content',
    ).toContain(STALE_SUB_QUESTION);
    for (const untracked of ['StagingID', 'RegionCode']) {
      expect(block, `${untracked} survives in the question text; only its standing is corrected`).toContain(untracked);
    }
  });

  it('renders no tracked-set block at all on a hop that tracks no column', () => {
    const block = buildCurrentTaskBlock([{ kind: 'analytical', question: STALE_SUB_QUESTION }], []);

    expect(
      block.includes('<column_trace>'),
      'a hop tracking no column is dispatched under the BB contract, which has no column channel to describe',
    ).toBe(false);
    expect(
      block.includes('outranks the sub-question'),
      'there is no tracked set to outrank anything, so the line would be a contradiction here',
    ).toBe(false);
    expect(block, 'the task itself still reaches the hop').toContain(STALE_SUB_QUESTION);
  });
});
