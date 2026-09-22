/**
 * Two node-id coverage checks the `lineage_present_result` handler runs on the same fixtures:
 *
 * - CT column-chain coverage: every kept, unslotted node in the traced column chain must appear in
 *   `sections[].node_ids`, `highlight_groups[].node_ids`, or `notes[].node_id`.
 * - Detail-slot section coverage (`findUnrenderedDetailSlotIds`): a captured `detail_slots[]` —
 *   the model's own technical findings — reaches no `sections[].node_ids`. Only a
 *   `sections[].node_ids` link satisfies it; a `notes[]` caption or a `highlight_groups[]` color
 *   does not, because accepting either is what let a CT render park formula-bearing hops on notes
 *   and ship a chain table in place of the BB walkthrough. Runs in both BB and CT mode, keyed on
 *   "a detail slot was captured", never on the trace mode's name.
 *
 * The two checks compose (neither subsumes the other) and share one fixture set.
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
 * Seeds a CT result graph whose column chain routes the traced column through {@link STAGING} —
 * both the `to_node` of hop 1 and the `from_node` of hop 2, so the edge-terminal seed can never
 * reach it. {@link LOADER} and {@link CONSUMER} carry detail slots and are therefore chain-exempt.
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

/** Payload covering every CT chain node except {@link STAGING}; `extra` adds the covering surface. */
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

function errorText(result: Record<string, unknown>): string {
  return JSON.stringify(result.errors ?? result.hint ?? result);
}

describe('executePresentResult — CT column-chain coverage', () => {
  it('flags a mid-chain node that is both a from-node and a to-node when no surface covers it', async () => {
    const result = await run(seedCtSession(), ctInput());

    expect(result.success).toBe(false);
    expect(errorText(result)).toContain(STAGING);
    expect(errorText(result)).toMatch(/CT column-chain node\(s\) missing/);
  });

  it('names all three accepted surfaces in the repair it states', async () => {
    const result = await run(seedCtSession(), ctInput());

    const text = errorText(result);
    expect(text).toContain('sections[].node_ids');
    expect(text).toContain('highlight_groups[].node_ids');
    expect(text).toContain('notes[].node_id');
  });

  it('accepts the mid-chain node covered through sections[]', async () => {
    const result = await run(seedCtSession(), ctInput({
      sections: [{ label: 'Chain', node_ids: [RAW, STAGING, LOADER, CONSUMER], text: 'The loader writes the amount forward.' }],
    }));

    expect(result.success).toBe(true);
  });

  // A highlight group clears CT coverage on its own, but the pre-existing unexplained-highlight rule
  // still owns the payload: a highlighted node needs a section link or a note. These pin that the
  // CT check no longer contributes a violation, and that highlight colour is immaterial to it.
  it.each([
    ['a source-coloured highlight group', [{ label: 'Feeds', color: 'source', node_ids: [RAW, STAGING] }]],
    ['a non-source highlight group', [
      { label: 'Feeds', color: 'source', node_ids: [RAW] },
      { label: 'Staging', color: 'transform', node_ids: [STAGING] },
    ]],
  ])('stops flagging the mid-chain node once %s carries it', async (_title, highlight_groups) => {
    const result = await run(seedCtSession(), ctInput({ highlight_groups }));

    expect(errorText(result)).not.toMatch(/CT column-chain node\(s\) missing/);
    expect(errorText(result)).toMatch(/must be explained by sections\[\]\.node_ids or notes\[\]/);
  });

  it('accepts the mid-chain node covered through notes[] alone', async () => {
    const result = await run(seedCtSession(), ctInput({
      notes: [
        { node_id: RAW, text: 'Origin of the traced amount.' },
        { node_id: STAGING, text: 'Carries the cleaned order amount into the consolidated view unchanged.' },
      ],
    }));

    expect(result.success).toBe(true);
  });

  it('leaves a fully covered presentation untouched', async () => {
    const result = await run(seedCtSession(), ctInput({
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

  it('never requires a slotted chain node in the CT chain check itself — the detail-slot check owns that', async () => {
    // LOADER and CONSUMER are slotted, so this CT-chain check exempts them — but the separate
    // detail-slot coverage check below still requires their captured findings reach a section;
    // the two checks compose, neither is redundant.
    const result = await run(seedCtSession(), ctInput({
      sections: [{ label: 'Chain', node_ids: [RAW, STAGING], text: 'The loader writes the amount forward.' }],
    }));

    expect(result.success).toBe(false);
    expect(errorText(result)).not.toMatch(/CT column-chain node\(s\) missing/);
    expect(errorText(result)).toMatch(/Detail slot\(s\) reached no section/);
  });
});

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
