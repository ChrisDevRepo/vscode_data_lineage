/**
 * CT column-chain coverage enforced by the `lineage_present_result` handler.
 *
 * @remarks
 * The synthesis self-check tells the model that every kept, unslotted node in the traced column
 * chain must appear in `sections[].node_ids`, `highlight_groups[].node_ids`, or `notes[].node_id`.
 * These tests pin the enforced contract to that stated one: a mid-chain staging table that is both
 * a `from_node` and a `to_node` is required, and any one of the three surfaces satisfies it.
 */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import type { ResultGraph } from '../../../src/ai/session/types';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import type { Logger } from '../../../src/utils/log';

const RAW = '[ai].[vwRawOrders]';
const STAGING = '[ai].[SalesStaging]';
const LOADER = '[ai].[spLoadSalesStaging]';
const CONSUMER = '[ai].[vwConsolidatedSales]';

function node(id: string, name: string, type: string): LineageNode {
  return { id, schema: 'ai', name, fullName: id, type } as unknown as LineageNode;
}

const TEST_MODEL = {
  nodes: [
    node(RAW, 'vwRawOrders', 'view'),
    node(STAGING, 'SalesStaging', 'table'),
    node(LOADER, 'spLoadSalesStaging', 'procedure'),
    node(CONSUMER, 'vwConsolidatedSales', 'view'),
  ],
  edges: [],
} as unknown as DatabaseModel;

const SILENT_LOGGER = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
} as unknown as Logger;

/**
 * Seeds a CT result graph whose column chain routes the traced column through {@link STAGING} —
 * both the `to_node` of hop 1 and the `from_node` of hop 2, so the edge-terminal seed can never
 * reach it. {@link LOADER} and {@link CONSUMER} carry detail slots and are therefore exempt.
 */
function seedCtSession(): AiSession {
  const session = new AiSession();
  const resultGraph: ResultGraph = {
    nodeIds: [RAW, STAGING, LOADER, CONSUMER],
    edges: [],
    source: 'column_trace',
    node_states: [
      { nodeId: RAW, action: 'passthrough', source: 'engine', reason: 'non_bodied_passthrough' },
      { nodeId: STAGING, action: 'passthrough', source: 'engine', reason: 'non_bodied_passthrough' },
      { nodeId: LOADER, action: 'passthrough', source: 'ai', reason: 'submitted_passthrough' },
      { nodeId: CONSUMER, action: 'analyze', source: 'ai', reason: 'submitted_analyze' },
    ] as ResultGraph['node_states'],
    columnAspect: {
      edges: [
        { hop_node: LOADER, hop: 1, from_node: RAW, from_col: 'OrderAmount', to_node: STAGING, to_col: 'OrderAmount' },
        { hop_node: CONSUMER, hop: 2, from_node: STAGING, from_col: 'OrderAmount', to_node: CONSUMER, to_col: 'OrderAmount' },
      ],
      ctPrunedNodeIds: [],
    },
  };
  session.resultGraph = resultGraph;
  session.memory.storeDetail(node(LOADER, 'spLoadSalesStaging', 'procedure'), [], 'Loads staging.');
  session.memory.storeDetail(node(CONSUMER, 'vwConsolidatedSales', 'view'), [], 'Consumes staging.');
  return session;
}

function services(session: AiSession, epoch: number): ToolServices {
  return {
    getSession: () => session,
    getPanel: () => undefined as never,
    logger: SILENT_LOGGER,
    turnEpoch: () => epoch,
    requireModel: () => TEST_MODEL,
    requireGraph: () => { throw new Error('requireGraph is not part of the present_result path'); },
    logAndReturn: (_toolName: string, data: object) => JSON.stringify(data),
    buildActiveFilter: () => { throw new Error('buildActiveFilter is not part of the present_result path'); },
    toolError: (toolName: string, err: unknown) => JSON.stringify({ error: 'internal_error', tool: toolName, message: String(err) }),
  } as unknown as ToolServices;
}

/** Payload covering every chain node except {@link STAGING}; `extra` adds the covering surface. */
function ctInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'OrderAmount Trace',
    summary: 'OrderAmount flows from vwRawOrders into vwConsolidatedSales.',
    sections: [{ label: 'Chain', node_ids: [RAW, LOADER, CONSUMER], text: 'The loader writes the amount forward.' }],
    highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW] }],
    notes: [{ node_id: RAW, text: 'Origin of the traced amount.' }],
    ...extra,
  };
}

async function run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = seedCtSession();
  const epoch = session.beginTurn();
  return JSON.parse(await executePresentResult(input, services(session, epoch))) as Record<string, unknown>;
}

function errorText(result: Record<string, unknown>): string {
  return JSON.stringify(result.errors ?? result.hint ?? result);
}

describe('executePresentResult — CT column-chain coverage', () => {
  it('flags a mid-chain node that is both a from-node and a to-node when no surface covers it', async () => {
    const result = await run(ctInput());

    expect(result.success).toBe(false);
    expect(errorText(result)).toContain(STAGING);
    expect(errorText(result)).toMatch(/CT column-chain node\(s\) missing/);
  });

  it('names all three accepted surfaces in the repair it states', async () => {
    const result = await run(ctInput());

    const text = errorText(result);
    expect(text).toContain('sections[].node_ids');
    expect(text).toContain('highlight_groups[].node_ids');
    expect(text).toContain('notes[].node_id');
  });

  it('accepts the mid-chain node covered through sections[]', async () => {
    const result = await run(ctInput({
      sections: [{ label: 'Chain', node_ids: [RAW, STAGING, LOADER, CONSUMER], text: 'The loader writes the amount forward.' }],
    }));

    expect(result.success).toBe(true);
  });

  // A highlight group clears CT coverage on its own, but the pre-existing unexplained-highlight rule
  // still owns the payload: a highlighted node needs a section link or a note. These two pin that the
  // CT check no longer contributes a violation, and that highlight colour is immaterial to it.
  it('stops flagging the mid-chain node once a source-coloured highlight group carries it', async () => {
    const result = await run(ctInput({
      highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW, STAGING] }],
    }));

    expect(errorText(result)).not.toMatch(/CT column-chain node\(s\) missing/);
    expect(errorText(result)).toMatch(/must be explained by sections\[\]\.node_ids or notes\[\]/);
  });

  it('stops flagging the mid-chain node once a non-source highlight group carries it', async () => {
    const result = await run(ctInput({
      highlight_groups: [
        { label: 'Feeds', color: 'source', node_ids: [RAW] },
        { label: 'Staging', color: 'transform', node_ids: [STAGING] },
      ],
    }));

    expect(errorText(result)).not.toMatch(/CT column-chain node\(s\) missing/);
    expect(errorText(result)).toMatch(/must be explained by sections\[\]\.node_ids or notes\[\]/);
  });

  it('accepts the mid-chain node covered through notes[] alone', async () => {
    const result = await run(ctInput({
      notes: [
        { node_id: RAW, text: 'Origin of the traced amount.' },
        { node_id: STAGING, text: 'Carries the cleaned order amount into the consolidated view unchanged.' },
      ],
    }));

    expect(result.success).toBe(true);
  });

  it('leaves a fully covered presentation untouched', async () => {
    const result = await run(ctInput({
      sections: [{ label: 'Chain', node_ids: [RAW, STAGING, LOADER, CONSUMER], text: 'The loader writes the amount forward.' }],
      highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW, STAGING] }],
      notes: [
        { node_id: RAW, text: 'Origin of the traced amount.' },
        { node_id: STAGING, text: 'Carries the amount forward unchanged.' },
      ],
    }));

    expect(result.success).toBe(true);
    expect(result.view_name).toBe('OrderAmount Trace');
  });

  it('never requires a slotted chain node the presentation leaves unlinked', async () => {
    const result = await run(ctInput({
      sections: [{ label: 'Chain', node_ids: [RAW, STAGING], text: 'The loader writes the amount forward.' }],
    }));

    expect(result.success).toBe(true);
  });
});
