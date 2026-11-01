/**
 * Canonical CI/CS identities survive discovery, focus-template routing, recall and presentation
 * repair.
 */
import { describe, expect, it } from 'vitest';
import { draftWorld } from '../helpers/presentWorld';
import { renderProblem } from '../../../src/ai/support/toolErrorEnvelope';

describe('present_result id rejection route', () => {
  const call = async (inScope: boolean) => {
    const { ids, report, send } = draftWorld({ inScope });
    return {
      ids,
      rejection: await send({
        ...report,
        sections: [{ ...report.sections[0], node_ids: ids }],
      }),
    };
  };

  it('does not offer add_node_ids for an id outside the approved scope, and states the fault without a leave-out remedy or an echo', async () => {
    const { ids, rejection } = await call(false);
    expect(rejection.errors).toEqual([
      {
        path: 'sections.0.node_ids.2',
        code: 'result_out_of_scope',
        values: ids.slice(0, 2),
      },
    ]);
    for (const stage of [1, 2, 3] as const) {
      const text = renderProblem(
        rejection,
        stage,
        undefined,
        'presentation_commit',
      );
      expect(text).not.toContain('add_node_ids');
      expect(text, 'no echoed id').not.toContain(ids[2]);
      expect(text).not.toMatch(/\b(drop|omit|remove|withdraw)\b/i);
    }
    expect(rejection.resend).toEqual(['sections']);
  });
});
