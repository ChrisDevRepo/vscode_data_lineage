/**
 * Classification contract: the one scope field that discards captured analysis must be both
 * stated to the model that picks it and shown to the user who approves it.
 *
 * `filterSectionsForClassification` drops, at commit, every section whose angle the locked
 * classification did not request, and `buildSectionsShape` narrows the per-hop capture to a single
 * angle before that. A wrong value therefore deletes work rather than reshaping it. Three surfaces
 * have to carry the field for that to be correctable: the sm-entry directive, which names it as a
 * required argument; the field schema, which owns how the value is chosen; and the approval gate,
 * the last point a human can change it. These tests forbid any of them going silent, and drive the
 * handler so the value on the card is the value the tool payload carried.
 */
import { describe, expect, it, vi } from 'vitest';
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

// The handler reads `dataLineageViz.ai.maxRounds` for the scope-budget check; the shared stub
// carries no `workspace`, so the configured default is what this test exercises.
vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  workspace: { getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }) },
}));

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

function reportingLine(classification?: ClassificationValue): string {
  return summaryFor(classification).split('\n').find(line => line.includes('Reporting on:')) ?? '';
}

describe('classification is visible where it is chosen and where it is approved', () => {
  it('states the locked classification at the approval gate', () => {
    // Depth, direction and tracing mode are all shown. Before this contract the only field that
    // deletes analysis was the only one the user could not see, so it could not be corrected.
    expect(summaryFor('both')).toContain('- **Reporting on:**');
  });

  it.each([
    { classification: 'technical' as const, dropped: 'business' },
    { classification: 'business' as const, dropped: 'technical' },
  ])('names the angle $classification drops', ({ classification, dropped }) => {
    // A bare enum label reads as a superset to a non-expert. The consequence is what makes the
    // value correctable, so the gate states the loss rather than the label alone.
    const line = reportingLine(classification);
    expect(line).toContain('dropped');
    expect(line).toContain(dropped);
  });

  it('reports "both" as lossless', () => {
    expect(reportingLine('both')).not.toContain('dropped');
  });

  it('renders no line when the AI has not locked a classification', () => {
    // An absent verdict is not a value to render — an invented default would misreport the run.
    expect(summaryFor(undefined)).not.toContain('Reporting on:');
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

  it('states the consequence where the user can still correct it', () => {
    // The consequence belongs to the approval gate, the last point a human changes the value —
    // not to the model that already made the choice.
    expect(reportingLine('technical')).toContain('dropped');
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

  it('renders the "Reporting on" line from the classification the payload carried', async () => {
    // The contract above is proved on a hand-set field; this drives the production path, so a
    // handler that stopped forwarding the payload value would fail here and nowhere else.
    expect(await gateDetail('technical')).toContain('- **Reporting on:** technical mechanics (business findings are dropped)');
  });

  it('follows the payload rather than a default', async () => {
    expect(await gateDetail('both')).toContain('- **Reporting on:** business logic and technical mechanics');
  });
});
