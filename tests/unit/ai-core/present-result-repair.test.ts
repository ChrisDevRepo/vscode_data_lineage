/** Report draft contracts through the actual handler; no repair-only schema or merge protocol. */
import { describe, expect, it } from 'vitest';
import { draftWorld } from '../helpers/presentWorld';
import { renderProblem } from '../../../src/ai/support/toolErrorEnvelope';

describe('Full-schema report draft boundary', () => {
  it('logs an identical saved-field resend as a no-op while still requiring its missing content', async () => {
    const { session, report, logs, send } = draftWorld();
    const { summary: _summary, ...incomplete } = report;
    expect(await send(incomplete)).toHaveProperty('code', 'invalid_input');
    const repeated = await send({ name: report.name });
    expect(repeated.errors).toContainEqual(
      expect.objectContaining({ path: 'summary', code: 'missing' }),
    );
    expect(logs).toContainEqual(
      expect.stringContaining(
        '[Hold] identical resend no-op tool=lineage_present_result',
      ),
    );
    expect(session.presentationArtifact).toBeNull();
    expect(await send({ summary: report.summary })).toHaveProperty(
      'success',
      true,
    );
  });

  it('replaces supplied lists whole rather than merging entries by identity', async () => {
    const { session, ids, report, send } = draftWorld();
    await send({
      ...report,
      summary: 42,
      notes: ids
        .slice(0, 2)
        .map((node_id) => ({ node_id, caption: 'Held caption.' })),
    });
    expect(
      await send({
        summary: report.summary,
        notes: [{ node_id: ids[1], caption: 'Only supplied caption.' }],
      }),
    ).toHaveProperty('success', true);
    expect(session.presentationArtifact?.aiMetadata.notes).toEqual([
      { nodeId: ids[1], text: 'Only supplied caption.' },
    ]);
  });

  it('keeps a held value on a faulty overwrite, reports it without echo, and accepts the next correction', async () => {
    const { session, report, send } = draftWorld();
    await send({ ...report, summary: 42 });
    const rejected = await send({
      summary: report.summary,
      title: ['new invalid title sentinel'],
    });
    expect(rejected.errors).toContainEqual(
      expect.objectContaining({ path: 'title', code: 'not_overwritten' }),
    );
    const shown = renderProblem(rejected, 1, undefined, 'presentation_commit');
    expect(shown).not.toContain(report.title);
    expect(shown).not.toContain('new invalid title sentinel');
    expect(await send({ summary: report.summary })).toHaveProperty(
      'success',
      true,
    );
    expect(session.presentationArtifact?.aiMetadata.description).toContain(
      report.title,
    );
  });
});
