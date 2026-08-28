/**
 * Classification contract: the one scope field that discards captured analysis must be both
 * stated to the model that picks it and shown to the user who approves it.
 *
 * `filterSectionsForClassification` drops, at commit, every section whose angle the locked
 * classification did not request, and `buildSectionsShape` narrows the per-hop capture to a single
 * angle before that. A wrong value therefore deletes work rather than reshaping it. Two surfaces
 * have to carry the field for that to be correctable: the sm-entry directive, where the model
 * chooses the value, and the approval gate, the last point a human can change it. These tests
 * forbid either surface going silent.
 */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { renderScopeSummaryMd } from '../../../src/ai/prompting/scopeSummaryRenderer';
import { buildSmEntrySystemPrompt } from '../../../src/ai/prompting/hostPrompts';
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

describe('the sm-entry directive carries the selection rule', () => {
  const prompt = buildSmEntrySystemPrompt(
    { dbPlatform: 'SQL Server', filterSchemas: [], totalSchemaCount: 1, visibleNodes: 2, totalNodes: 2 },
    ['Discount'],
  );

  it('names the field', () => {
    expect(prompt).toContain('classification');
  });

  it('states how to choose, not only the enum', () => {
    // The rule lives in the discovery-stage prompt while one validator serves both stages. Naming
    // the field here without its rule is the asymmetry that let a column-trace request classify
    // "technical" and lose every business caveat the hops had already captured.
    expect(prompt).toMatch(/business.*unless.*technical lens/is);
  });

  it('states that a wrong value discards captured analysis', () => {
    expect(prompt).toMatch(/dropped at commit|silently discards/i);
  });
});
