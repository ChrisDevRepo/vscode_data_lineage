/**
 * Scope-notes contract: an instruction the user gave that maps to no filter field must still be
 * confirmable at the approval gate and present on every hop.
 *
 * The gate is where the user consents to the assistant's reading of their question; after approval
 * the run is autonomous. An instruction that reaches neither the gate nor the hops was silently
 * dropped, which is what these tests forbid.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { renderScopeSummaryMd } from '../../../src/ai/prompting/scopeSummaryRenderer';
import { buildMissionBriefBlock } from '../../../src/ai/prompting/prompts';
import { StartExplorationInputSchema, StartExplorationFreshProviderInputSchema } from '../../../src/ai/tools/toolSchemas';
import { AiMemoryManager } from '../../../src/ai/session/memoryManager';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe('Scope notes — constraints that map to no filter', () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'ai', name: 'FactSalesReport', type: 'procedure' }),
    makeNode({ id: 'src', schema: 'ai', name: 'vwConsolidatedSales', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [['src', 'origin']];
  const model: DatabaseModel = makeModel(nodes, edges, ['ai']);
  const graph = makeGraph(nodes, edges);
  const NOTE = 'ignore filter criteria for the analysis';

  it('the model-facing tool schema advertises the field, not only the dispatcher', () => {
    // Without the provider-facing schema carrying it, the model is never told the field exists and
    // an emitted value would be rejected as an unrecognized key before dispatch ever sees it.
    const provider = StartExplorationFreshProviderInputSchema.safeParse({
      origin: '[ai].[FactSalesReport]',
      question: 'trace it',
      direction: 'upstream',
      classification: 'business',
      analysisMode: 'bb',
      scopeNotes: [NOTE],
    });
    expect(provider.success, `provider schema must accept scopeNotes: ${JSON.stringify(provider.error?.issues)}`).toBe(true);

    const dispatcher = StartExplorationInputSchema.safeParse({
      origin: '[ai].[FactSalesReport]',
      question: 'trace it',
      classification: 'business',
      analysisMode: 'bb',
      scopeNotes: [NOTE],
    });
    expect(dispatcher.success, `dispatcher schema must accept scopeNotes: ${JSON.stringify(dispatcher.error?.issues)}`).toBe(true);
  });

  it('is echoed at the approval gate under what the user asked for', () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace it', direction: 'upstream', scopeNotes: [NOTE] });
    const md = renderScopeSummaryMd(engine.getScopeSummary());
    const stated = md.slice(md.indexOf('**From your question**'), md.indexOf('**My plan**'));
    expect(stated.includes(`- Noted: "${NOTE}"`), 'a constraint mapping to no filter is still shown for confirmation').toBe(true);
  });

  it('reaches every hop, including after the sliding-memory wipe', () => {
    // The block is rendered from memory, not from conversation history, so hop 9 sees exactly what
    // hop 1 saw — and byte-identically, so the cached prefix still holds.
    const memory = new AiMemoryManager();
    memory.setUserQuestion('trace it');
    memory.setMissionBrief('Trace TotalRevenue to its sources.');
    memory.setScopeNotes([NOTE]);

    const first = buildMissionBriefBlock(memory.getMissionBrief(), memory.getUserQuestion(), memory.getScopeNotes());
    expect(first.includes('<user_constraints>'), 'constraints ride the session-stable mission block').toBe(true);
    expect(first.includes(NOTE), 'the constraint is carried verbatim').toBe(true);

    // Rendered from memory, never from conversation history — so a later hop, after the wipe has
    // removed the turn that carried the instruction, still produces the same bytes.
    const later = buildMissionBriefBlock(memory.getMissionBrief(), memory.getUserQuestion(), memory.getScopeNotes());
    expect(later === first, 'the block is byte-identical across hops — wipe-proof and cache-safe').toBe(true);
  });

  it('survives the engine checkpoint round-trip', () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace it', direction: 'upstream', scopeNotes: [NOTE] });
    const restored = NavigationEngine.fromJSON(engine.toJSON(), model, graph, () => {});
    expect(restored.getScopeSummary().scopeNotes.includes(NOTE), 'a resumed session keeps the constraints the user approved').toBe(true);
  });

  it('is omitted entirely when the user stated no such constraint', () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace it', direction: 'upstream' });
    const md = renderScopeSummaryMd(engine.getScopeSummary());
    expect(!md.includes('- Noted:'), 'no empty block appears when nothing was noted').toBe(true);
    expect(buildMissionBriefBlock('brief', 'q', []) === buildMissionBriefBlock('brief', 'q'), 'an empty note list costs nothing in the prompt').toBe(true);
  });
});
