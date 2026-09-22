/**
 * A render that amends a committed report keeps the sections it does not resend.
 *
 * @remarks
 * Re-authoring the whole report on a scope change costs a full resend and moves every badge the
 * user already read. A section sent with no text keeps its committed body instead. The relaxation
 * is stamped, not inferred: `storeSmResult` carries sections forward and an approved exploration
 * does not clear the result graph, so these tests pin both the retention and the two cases that
 * must still demand a complete section — a first synthesis, and a report left by a previous run.
 */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import type { IHopStateMachine } from '../../../src/ai/sm/smBase';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { presentResultSchemaForPhase } from '../../../src/ai/tools/toolSchemas';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import type { DatabaseModel } from '../../../src/engine/types';
import type { Logger } from '../../../src/utils/log';

const ORIGIN = '[dbo].[Orders]';
const AUDIT = '[dbo].[Audit]';
const RUN_ID = 'session-1:e1';
/** The committed body the follow-up must keep without resending it. */
const COMMITTED_TEXT = 'Orders is loaded nightly from the staging extract and is the sole source table.';

const TEST_MODEL = {
  nodes: [
    { id: ORIGIN, name: 'Orders', schema: 'dbo', type: 'table' },
    { id: AUDIT, name: 'Audit', schema: 'dbo', type: 'table' },
  ],
  edges: [{ source: ORIGIN, target: AUDIT, type: 'write' }],
} as unknown as DatabaseModel;

const SILENT_LOGGER = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
} as unknown as Logger;

/** A session holding a committed one-section report, stamped with `sectionsRunId`. */
function sessionWithCommittedReport(sectionsRunId: string | undefined): { session: AiSession; epoch: number } {
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.explorationRunId = RUN_ID;
  session.resultGraph = {
    nodeIds: [ORIGIN],
    edges: [],
    source: 'blackboard',
    originNodeId: ORIGIN,
    sections: [{ label: 'Source', node_ids: [ORIGIN], text: COMMITTED_TEXT }],
    ...(sectionsRunId ? { sectionsRunId } : {}),
  };
  session.stateMachine = {
    status: 'complete',
    columnAspect: null,
    toJSON: () => ({ scopeNodeIds: [ORIGIN, AUDIT], removedSet: [], renderDroppedNodeIds: [] }),
  } as unknown as IHopStateMachine;
  session.enterCompleted(epoch);
  return { session, epoch };
}

function services(session: AiSession, epoch: number): ToolServices {
  return {
    getSession: () => session,
    deliverPreview: () => Promise.resolve(true),
    logger: SILENT_LOGGER,
    budget: DEFAULT_TURN_TOKEN_BUDGET,
    maxRounds: 50,
    turnEpoch: () => epoch,
    requireModel: () => TEST_MODEL,
    requireGraph: () => { throw new Error('requireGraph is not part of the present_result path'); },
    logAndReturn: (_toolName: string, data: object) => JSON.stringify(data),
    buildActiveFilter: () => { throw new Error('buildActiveFilter is not part of the present_result path'); },
    toolError: (toolName: string, err: unknown) => JSON.stringify({ error: 'internal_error', tool: toolName, message: String(err) }),
  } as unknown as ToolServices;
}

/** The follow-up a scope change produces: one label resent bare, one new section authored in full. */
function amendmentPayload(): Record<string, unknown> {
  return {
    name: 'Orders Lineage',
    summary: 'How Orders is populated and audited.',
    sections: [
      { label: 'Source', node_ids: [ORIGIN] },
      { label: 'Audit trail', node_ids: [AUDIT], text: 'Every write to Orders is mirrored into Audit.' },
    ],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [ORIGIN, AUDIT] }],
    notes: [
      { node_id: ORIGIN, text: 'The order header table.' },
      { node_id: AUDIT, text: 'The audit mirror.' },
    ],
    add_node_ids: [AUDIT],
    is_update: true,
  };
}

describe('executePresentResult — a committed report is amended, not re-authored', () => {
  it('keeps the committed text and badge for a section resent without text', async () => {
    const { session, epoch } = sessionWithCommittedReport(RUN_ID);

    const result = JSON.parse(
      await executePresentResult(amendmentPayload(), services(session, epoch)),
    ) as { success: boolean; errors?: string[] };

    expect(result.success).toBe(true);
    expect(session.resultGraph?.sections).toEqual([
      { label: 'Source', node_ids: [ORIGIN], text: COMMITTED_TEXT },
      { label: 'Audit trail', node_ids: [AUDIT], text: 'Every write to Orders is mirrored into Audit.' },
    ]);
    expect(session.presentationArtifact?.aiMetadata.badges).toEqual([
      { nodeId: ORIGIN, text: '1 Source' },
      { nodeId: AUDIT, text: '2 Audit trail' },
    ]);
    expect(session.resultGraph?.sectionsRunId).toBe(RUN_ID);
  });

  it('keeps the whole committed report when sections are omitted entirely', async () => {
    const { session, epoch } = sessionWithCommittedReport(RUN_ID);
    const { sections: _dropped, ...withoutSections } = amendmentPayload() as { sections: unknown };

    const result = JSON.parse(
      await executePresentResult(withoutSections, services(session, epoch)),
    ) as { success: boolean };

    expect(result.success).toBe(true);
    expect(session.resultGraph?.sections).toEqual([
      { label: 'Source', node_ids: [ORIGIN], text: COMMITTED_TEXT },
    ]);
  });

  it('refuses a bare section when the committed report belongs to a superseded run', async () => {
    const { session, epoch } = sessionWithCommittedReport('session-1:e0');

    const result = JSON.parse(
      await executePresentResult(amendmentPayload(), services(session, epoch)),
    ) as { success: boolean; errors?: string[] };

    expect(result.success).toBe(false);
    expect(result.errors?.join(' ')).toContain('sections');
    expect(session.resultGraph?.sections?.[0]?.text).toBe(COMMITTED_TEXT);
  });

  it('refuses a bare section on a first synthesis, which has no committed report', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.explorationRunId = RUN_ID;
    session.resultGraph = { nodeIds: [ORIGIN], edges: [], source: 'blackboard', originNodeId: ORIGIN };
    session.enterExploring(epoch);

    const result = JSON.parse(await executePresentResult({
      name: 'Orders Lineage',
      summary: 'How Orders is populated.',
      sections: [{ label: 'Source', node_ids: [ORIGIN] }],
      highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [ORIGIN] }],
      notes: [{ node_id: ORIGIN, text: 'The order header table.' }],
    }, services(session, epoch))) as { success: boolean; errors?: string[] };

    expect(result.success).toBe(false);
    expect(result.errors?.join(' ')).toContain('sections');
    expect(session.presentationArtifact).toBeFalsy();
  });
});

/** The offered schema is what makes the model able to omit; it has to survive the projection. */
describe('present_result — the retaining projection is offered to the model', () => {
  for (const stage of ['completed', 'synthesis'] as const) {
    it(`drops the sections and text requirements on ${stage}`, () => {
      type Projection = { properties: { sections: { items: { required?: string[] } } } };
      const strict = presentResultSchemaForPhase(stage);
      const retaining = presentResultSchemaForPhase(stage, null, true);
      const bare = {
        name: 'Orders Lineage',
        summary: 'How Orders is populated.',
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [ORIGIN] }],
      };

      // The advertised contract: `text` leaves the required list, and the JSON Schema still projects.
      expect((toModelJsonSchema(strict) as unknown as Projection).properties.sections.items.required).toContain('text');
      expect((toModelJsonSchema(retaining) as unknown as Projection).properties.sections.items.required ?? []).not.toContain('text');

      // The parsed contract, which is what actually gates the call.
      expect(strict.safeParse({ ...bare, sections: [{ label: 'Source' }] }).success).toBe(false);
      expect(retaining.safeParse({ ...bare, sections: [{ label: 'Source' }] }).success).toBe(true);
      expect(strict.safeParse(bare).success).toBe(false);
      expect(retaining.safeParse(bare).success).toBe(true);
    });
  }
});
