/**
 * `add_node_ids` reveals; it does not extend.
 *
 * @remarks
 * A completed-phase presentation update resolves its ids against the whole loaded model, so
 * without a bound it could render a node the exploration never analysed — a canvas the archive
 * cannot describe and the state machine never recorded. Bringing a new node into the lineage is a
 * scope change, owned by `lineage_start_exploration`'s supplement. These tests pin the boundary
 * from both sides: a node inside the analysed scope renders, one outside is refused and told where
 * to go.
 */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import type { IHopStateMachine } from '../../../src/ai/sm/smBase';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import type { DatabaseModel } from '../../../src/engine/types';
import type { Logger } from '../../../src/utils/log';

const ORIGIN = '[dbo].[Orders]';
/** Analysed by the exploration — a presentation update may reveal it. */
const IN_SCOPE = '[dbo].[Audit]';
/** A real, connected object the exploration never covered. */
const OUT_OF_SCOPE = '[dbo].[Outside]';

const TEST_MODEL = {
  nodes: [
    { id: ORIGIN, name: 'Orders', schema: 'dbo', type: 'table' },
    { id: IN_SCOPE, name: 'Audit', schema: 'dbo', type: 'table' },
    { id: OUT_OF_SCOPE, name: 'Outside', schema: 'dbo', type: 'table' },
  ],
  edges: [
    { source: ORIGIN, target: IN_SCOPE, type: 'write' },
    { source: ORIGIN, target: OUT_OF_SCOPE, type: 'write' },
  ],
} as unknown as DatabaseModel;

const SILENT_LOGGER = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
} as unknown as Logger;

/** A completed session whose engine reports `[ORIGIN, IN_SCOPE]` as the analysed scope. */
function completedSession(): { session: AiSession; epoch: number } {
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.resultGraph = { nodeIds: [ORIGIN], edges: [], source: 'blackboard', originNodeId: ORIGIN };
  session.stateMachine = {
    status: 'complete',
    columnAspect: null,
    toJSON: () => ({ scopeNodeIds: [ORIGIN, IN_SCOPE], removedSet: [], renderDroppedNodeIds: [] }),
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

function payload(addIds: string[]): Record<string, unknown> {
  const linked = [ORIGIN, ...addIds];
  return {
    name: 'Orders Lineage',
    summary: 'How Orders is populated.',
    sections: [{ label: 'Source', node_ids: linked, text: 'Orders is the sole source table.' }],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [ORIGIN] }],
    notes: linked.map(id => ({ node_id: id, text: 'One sentence about this node.' })),
    add_node_ids: addIds,
    is_update: true,
  };
}

describe('executePresentResult — add_node_ids is bounded by the analysed scope', () => {
  it('refuses a node outside the analysed scope and names the supplement route', async () => {
    const { session, epoch } = completedSession();

    const result = JSON.parse(
      await executePresentResult(payload([OUT_OF_SCOPE]), services(session, epoch)),
    ) as { success: boolean; errors?: string[] };

    expect(result.success).toBe(false);
    expect(result.errors?.join(' ')).toContain(OUT_OF_SCOPE);
    expect(result.errors?.join(' ')).toContain('supplement');
    // The supplement is the repair only for an add the user asked for; a "what next" question is
    // answered in chat and the user picks — the refusal must not prescribe an unrequested analysis.
    expect(result.errors?.join(' ')).toContain('If the user asked to add these objects');
    expect(result.errors?.join(' ')).toContain('ask which to add');
    expect(session.resultGraph?.nodeIds).toEqual([ORIGIN]);
  });

  it('reveals a node the exploration already analysed', async () => {
    const { session, epoch } = completedSession();

    const result = JSON.parse(
      await executePresentResult(payload([IN_SCOPE]), services(session, epoch)),
    ) as { success: boolean; node_count?: number };

    expect(result.success).toBe(true);
    expect(session.resultGraph?.nodeIds).toEqual([ORIGIN, IN_SCOPE]);
  });
});
