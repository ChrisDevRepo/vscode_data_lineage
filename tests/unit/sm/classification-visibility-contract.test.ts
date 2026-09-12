/**
 * Classification contract: the one scope field that discards captured analysis must be stated
 * to the model that picks it. Hop-by-hop filtering is `filterSectionsForClassification` at commit
 * and the gated capture keys — not the approval-card markdown, which is user-facing plan copy and
 * is not replayed into later hops.
 *
 * `buildSectionsShape` narrows the per-hop capture to a single angle before commit. A wrong value
 * therefore deletes work rather than reshaping it. Two surfaces have to carry the field for that
 * to be correctable: the sm-entry directive, which names it as a required argument, and the field
 * schema, which owns how the value is chosen. The gate stamps `_Analysis:` from the payload so the
 * reviewed run matches what the tool carried; it does not explain hop-commit filtering.
 */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { renderScopeSummaryMd } from '../../../src/ai/prompting/scopeSummaryRenderer';
import { buildSmEntrySystemPrompt } from '../../../src/ai/prompting/hostPrompts';
import { executeStartExploration } from '../../../src/ai/tools/handlers/startExploration';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { StartExplorationFreshProviderInputSchema } from '../../../src/ai/tools/toolSchemas';
import type { ClassificationValue } from '../../../src/ai/session/classification';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const nodes: LineageNode[] = [
  makeNode({ id: 'origin', schema: 'ai', name: 'vwDiscountCalc', type: 'view' }),
  makeNode({ id: 'src', schema: 'ai', name: 'CustomerMaster', type: 'table' }),
];
const edges: Array<[string, string]> = [['src', 'origin']];
const model: DatabaseModel = makeModel(nodes, edges, ['ai']);
const graph = makeGraph(nodes, edges);

function summaryFor(classification?: ClassificationValue): string {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'trace the Discount column', direction: 'upstream' });
  engine.classification = classification;
  return renderScopeSummaryMd(engine.getScopeSummary());
}

describe('the approval card is plan copy, not hop-commit instruction', () => {
  it('does not put classification-filter copy on the plan the user reviews', () => {
    // Classification is applied hop-by-hop at commit. The card is not that filter and is not
    // replayed into later hops, so it must not carry the drop/keep parenthetical.
    expect(summaryFor('technical')).not.toContain('Reporting on:');
    expect(summaryFor('business')).not.toContain('dropped');
    expect(summaryFor('both')).not.toContain('Reporting on:');
  });
});

describe('the sm-entry directive names the field and the schema owns the rule', () => {
  const prompt = buildSmEntrySystemPrompt(
    { dbPlatform: 'SQL Server', filterSchemas: [], totalSchemaCount: 1, visibleNodes: 2, totalNodes: 2 },
    ['Discount'],
  );
  const projected = toModelJsonSchema(StartExplorationFreshProviderInputSchema) as {
    properties?: Record<string, { description?: string }>;
  };
  const classificationDescription = projected.properties?.classification?.description ?? '';

  it('names the field as a required argument of the call', () => {
    expect(prompt).toContain('`classification` (business, technical, or both)');
  });

  it('leaves the selection rule to the field schema every adapter advertises', () => {
    // A3: one owner. The prompt states call ordering; how to pick the value travels with the
    // argument, so the rule reaches every provider surface rather than the entry stage alone.
    expect(prompt).not.toMatch(/business.*unless.*technical lens/is);
    expect(classificationDescription).toMatch(/business.*unless.*technical lens/is);
  });

  it('does not put hop-commit filter copy on the plan renderer', () => {
    expect(summaryFor('technical')).not.toContain('dropped');
  });
});

describe('classification travels from the tool payload to the approval card', () => {
  /**
   * Drives `start_exploration` the way a model does — one tool payload through the handler — and
   * returns the approval card the gate emits. Nothing here assigns `engine.classification`: the
   * point is that the payload alone puts the value on the card.
   */
  async function gateDetail(classification: ClassificationValue): Promise<string> {
    let returned: Record<string, unknown> = {};
    const session: Record<string, unknown> = {
      id: 'sess-t8',
      stateMachine: null,
      pendingExploration: null,
      phase: { kind: 'idle' },
      currentRoundId: 1,
      startExplorationRoundId: null,
      currentTurnPrompt: 'trace the Discount column',
      pendingUserNotice: new Set<string>(),
      storePendingExploration(proposal: Record<string, unknown>) {
        session.pendingExploration = { ...proposal, revision: 1 };
        return { kind: 'accepted' };
      },
    };
    const services = {
      getSession: () => session,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      maxRounds: 50,
      turnEpoch: () => 1,
      requireModel: () => model,
      requireGraph: () => graph,
      buildActiveFilter: () => ({}),
      logAndReturn: (_tool: string, data: Record<string, unknown>) => {
        returned = data;
        return JSON.stringify(data);
      },
      toolError: (_tool: string, error: unknown) => { throw error; },
    } as unknown as ToolServices;

    await executeStartExploration({
      origin: 'origin',
      analysisMode: 'bb',
      direction: 'upstream',
      question: 'trace the Discount column',
      mission_brief: 'Establish how the Discount column reaches vwDiscountCalc.',
      classification,
    }, services);

    expect(returned.error, JSON.stringify(returned)).toBe('action_required');
    return String(returned.detail ?? '');
  }

  it('stamps _Analysis_ from the classification the payload carried', async () => {
    // The contract above is proved on a hand-set field; this drives the production path, so a
    // handler that stopped forwarding the payload value would fail here and nowhere else.
    expect(await gateDetail('technical')).toContain('_Analysis: technical-driven_');
    expect(await gateDetail('technical')).not.toContain('Reporting on:');
  });

  it('follows the payload rather than a default', async () => {
    expect(await gateDetail('both')).toContain('_Analysis: business + technical driven_');
  });
});
