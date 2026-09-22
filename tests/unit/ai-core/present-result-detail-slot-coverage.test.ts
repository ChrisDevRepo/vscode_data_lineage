/**
 * Detail-slot section coverage enforced by the `lineage_present_result` handler.
 *
 * @remarks
 * `findUnrenderedDetailSlotIds` (`presentResult.ts`) reports which `detail_slots[]` — the model's
 * own captured technical findings, the richest material the synthesis call received — reached no
 * `sections[].node_ids`. These tests pin that report to a real rejection: only a
 * `sections[].node_ids` link satisfies it, because that is the walkthrough. A `notes[]` caption
 * is a one-line chip and a `highlight_groups[]` color carries no captured findings; accepting
 * either as coverage is what let a CT render park formula-bearing hops on notes and ship a chain
 * table in place of the BB walkthrough. The check runs in both BB and CT mode: it is keyed on
 * "a detail slot was captured", never on the trace mode's name (CLAUDE.md, "Branch on the
 * aspect's presence, never on the mode's name").
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

/** Seeds a plain BB result graph (no `columnAspect`) with one captured detail slot on {@link LOADER}. */
function seedBbSession(): AiSession {
  const session = new AiSession();
  const resultGraph: ResultGraph = {
    nodeIds: [RAW, LOADER, CONSUMER],
    edges: [],
    source: 'graph',
    node_states: [
      { nodeId: RAW, action: 'passthrough', source: 'engine', reason: 'non_bodied_passthrough' },
      { nodeId: LOADER, action: 'analyze', source: 'ai', reason: 'submitted_analyze' },
      { nodeId: CONSUMER, action: 'analyze', source: 'ai', reason: 'submitted_analyze' },
    ] as ResultGraph['node_states'],
  };
  session.resultGraph = resultGraph;
  session.memory.storeDetail(node(LOADER, 'spLoadSalesStaging', 'procedure'), [], 'Loads staging from raw orders.');
  return session;
}

/**
 * Seeds a CT result graph — same shape as the CT column-chain coverage suite — with a captured
 * detail slot on {@link LOADER}, a chain node the CT check itself exempts (`slottedNodeIds`).
 * Proves this check fires independently of, and in addition to, the CT chain check.
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

async function run(session: AiSession, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const epoch = session.beginTurn();
  return JSON.parse(await executePresentResult(input, services(session, epoch))) as Record<string, unknown>;
}

function errorText(result: Record<string, unknown>): string {
  return JSON.stringify(result.errors ?? result.hint ?? result);
}

describe('executePresentResult — detail-slot section coverage', () => {
  it('rejects a BB render whose only detail slot reaches no section and no note', async () => {
    const result = await run(seedBbSession(), {
      name: 'Order Load',
      summary: 'Raw orders load into staging and feed the consolidated view.',
      sections: [{ label: 'Consumer', node_ids: [CONSUMER], text: 'Consolidates staged sales.' }],
      highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW] }],
      notes: [{ node_id: RAW, text: 'Origin of raw orders.' }],
    });

    expect(result.success).toBe(false);
    expect(errorText(result)).toContain(LOADER);
    expect(errorText(result)).toMatch(/Detail slot\(s\) reached no section/);
  });

  it('does not accept a notes[] caption as coverage for a detail slot', async () => {
    const result = await run(seedBbSession(), {
      name: 'Order Load',
      summary: 'Raw orders load into staging and feed the consolidated view.',
      sections: [{ label: 'Consumer', node_ids: [CONSUMER], text: 'Consolidates staged sales.' }],
      highlight_groups: [{ label: 'Feeds', color: 'transform', node_ids: [LOADER] }],
      notes: [{ node_id: LOADER, text: 'Loads staging from raw orders.' }],
    });

    expect(result.success).toBe(false);
    expect(errorText(result)).toContain(LOADER);
    expect(errorText(result)).toMatch(/Detail slot\(s\) reached no section/);
  });

  it('does not accept a highlight_groups[] color alone as coverage for a detail slot', async () => {
    const result = await run(seedBbSession(), {
      name: 'Order Load',
      summary: 'Raw orders load into staging and feed the consolidated view.',
      sections: [{ label: 'Consumer', node_ids: [RAW, CONSUMER], text: 'Consolidates staged sales.' }],
      highlight_groups: [{ label: 'Transforms', color: 'transform', node_ids: [LOADER] }],
    });

    expect(result.success).toBe(false);
    expect(errorText(result)).toMatch(/Detail slot\(s\) reached no section/);
  });

  it('names sections as the authorized repair field for this violation', async () => {
    const result = await run(seedBbSession(), {
      name: 'Order Load',
      summary: 'Raw orders load into staging and feed the consolidated view.',
      sections: [{ label: 'Consumer', node_ids: [CONSUMER], text: 'Consolidates staged sales.' }],
      highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW] }],
      notes: [{ node_id: RAW, text: 'Origin of raw orders.' }],
    });

    expect(result.repairFields).toEqual(['sections']);
    expect(result.hint).toContain('Fix detail-slot coverage only');
    expect(result.hint).toContain('sections[].node_ids');
    expect(result.hint).not.toContain('notes[].node_id');
  });

  it('accepts the slot once its node id is linked in sections[].node_ids', async () => {
    const result = await run(seedBbSession(), {
      name: 'Order Load',
      summary: 'Raw orders load into staging and feed the consolidated view.',
      sections: [{ label: 'Chain', node_ids: [RAW, LOADER, CONSUMER], text: 'Raw orders load into staging and feed the view.' }],
      highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW] }],
    });

    expect(result.success).toBe(true);
  });

  it('fires in CT mode too, independently of the CT column-chain check', async () => {
    // Chain coverage (RAW/STAGING) is fully satisfied and LOADER/CONSUMER are chain-exempt as
    // slotted nodes; only the detail-slot check on LOADER is left to fail — proves this is not
    // reached only via the CT chain branch. A notes[] caption does not satisfy the slot check.
    const result = await run(seedCtSession(), {
      name: 'OrderAmount Trace',
      summary: 'OrderAmount flows from vwRawOrders into vwConsolidatedSales.',
      sections: [{ label: 'Chain', node_ids: [RAW, STAGING, CONSUMER], text: 'The staging table forwards the amount.' }],
      highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW] }],
      notes: [{ node_id: RAW, text: 'Origin of the traced amount.' }],
    });

    expect(result.success).toBe(false);
    expect(errorText(result)).not.toMatch(/CT column-chain node\(s\) missing/);
    expect(errorText(result)).toContain(LOADER);
    expect(errorText(result)).toMatch(/Detail slot\(s\) reached no section/);
  });

  it('does not accept a CT detail slot covered only via notes[].node_id', async () => {
    const result = await run(seedCtSession(), {
      name: 'OrderAmount Trace',
      summary: 'OrderAmount flows from vwRawOrders into vwConsolidatedSales.',
      sections: [{ label: 'Chain', node_ids: [RAW, STAGING, CONSUMER], text: 'The staging table forwards the amount.' }],
      highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW] }],
      notes: [{ node_id: LOADER, text: 'Loads staging.' }],
    });

    expect(result.success).toBe(false);
    expect(errorText(result)).toContain(LOADER);
    expect(errorText(result)).toMatch(/Detail slot\(s\) reached no section/);
  });

  it('leaves a fully covered CT presentation untouched', async () => {
    const result = await run(seedCtSession(), {
      name: 'OrderAmount Trace',
      summary: 'OrderAmount flows from vwRawOrders into vwConsolidatedSales.',
      sections: [
        { label: 'Chain', node_ids: [RAW, STAGING, CONSUMER], text: 'The staging table forwards the amount.' },
        { label: 'Loader', node_ids: [LOADER], text: 'Loads staging from raw orders.' },
      ],
      highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW] }],
    });

    expect(result.success).toBe(true);
  });

  it('does not require coverage of a detail slot whose node the render dropped', async () => {
    // Memory still holds the hop's slot; getResult already removed the node from the result
    // graph. Requiring a section/note link then forbidding that same id is the synthesis trap.
    const DROPPED = '[ai].[splogaudit]';
    const session = seedBbSession();
    session.memory.storeDetail(node(DROPPED, 'spLogAudit', 'procedure'), [], 'Writes one audit row.');

    const result = await run(session, {
      name: 'Order Load',
      summary: 'Raw orders load into staging and feed the consolidated view.',
      sections: [{ label: 'Chain', node_ids: [RAW, LOADER, CONSUMER], text: 'Raw orders load into staging and feed the view.' }],
      highlight_groups: [{ label: 'Feeds', color: 'source', node_ids: [RAW] }],
    });

    expect(result.success).toBe(true);
    expect(errorText(result)).not.toContain(DROPPED);
  });
});
