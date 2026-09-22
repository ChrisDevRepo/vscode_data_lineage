/**
 * GATE (plan Package 0.1) — the wrong prune of a column-less node, pinned on the surface that
 * decides it.
 *
 * Ownership first, because it decides what this file may assert. The AI decides WHAT is pruned; the
 * engine only decides whether removing it is structurally valid (the immutable origin, orphaning
 * committed work, route/prune conflicts). Whether a node "really contributes nothing" is a reading
 * of its body, and only the AI has read it. So there is no engine rule to assert here, and this
 * file must not grow one.
 *
 * Column state cannot stand in for that reading either. A focus carrying none of the traced columns
 * is EITHER a row-shaper that must be kept (an inner join applying filters — it decides which rows
 * the answer contains, which is exactly the contribution a column trace cannot see) OR a genuine
 * dead end that must stay prunable (a log writer). Both are column-less. Any engine rule keyed on
 * column-less-ness therefore breaks one case to fix the other: refusing the prune leaves CT strictly
 * larger than BB for the same question, which is the same parity defect from the other side. The
 * log-writer half is pinned in `ct-retention-differential.test.ts` by the self-prune assertion
 * inside the shared `drivePassthroughWalk` helper, which both C11 and C12 drive — an engine rule
 * keyed on column state fails both. It must keep passing.
 *
 * The defect was the instruction: the hop told a column-less focus both that it "is kept in the
 * answer" AND — via the shared prune trigger — that a node contributing no column to the traced
 * column path is removable. The model resolved the contradiction the way the trace shows it did, by
 * pruning `vwDiscountCalc`.
 *
 * These gates read the prompt a column-less hop is ACTUALLY dispatched with, not a builder called
 * directly: such a hop now takes the BB contract, so a gate aimed at the CT task block would pass
 * against text no model ever sees. `ct-branch-mode-contract.test.ts` pins WHICH contract it gets;
 * this file pins two claims about what that contract may and may not say.
 *
 * Deliberately NOT asserted here: that the prune trigger's column clause cannot be read by a
 * column-less focus as its own case. That is the defect the trace actually shows, but it is a claim
 * about how one paragraph reads next to another, and every string form of it is either vacuous or a
 * wording-lock — two attempts passed against the unfixed prompt, once on a synonym and once on an
 * incidental "focus" three clauses away. Prompt wording is validated by e2e replay, not by grepping
 * the prompt, and no replay has been run, so that claim is evidenced nowhere in this suite.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { buildActiveHopInstruction, buildActiveInstruction } from '../../../src/ai/agent/stagePrompts';
import { EMPTY_AI_TEMPLATES, type AiOutputTemplates } from '../../../src/ai/session/types';
import type { AiSession } from '../../../src/ai/session/session';
import type { StagePromptContext } from '../../../src/ai/prompting/hostPrompts';
import { describe, expect, it } from 'vitest';

const TEMPLATES: AiOutputTemplates = {
  ...EMPTY_AI_TEMPLATES,
  business_capture: 'Capture the business meaning of this node.',
  column_trace_capture: 'Account for every active column in column_flow.',
};

const CTX: StagePromptContext = {
  dbPlatform: 'SQL Server',
  filterSchemas: ['dbo'],
  totalSchemaCount: 1,
  visibleNodes: 4,
  totalNodes: 4,
};

/** Session stub carrying only what the active-phase prompt builders read. */
function promptSession(engine: NavigationEngine): AiSession {
  return {
    outputTemplates: TEMPLATES,
    classification: 'business',
    requireLockedClassification: () => 'business',
    stateMachine: engine,
    memory: {
      slotCount: 0,
      getShortTermMemory: () => [],
      getRecentRejections: () => [],
      getMissionBrief: () => '',
      getUserQuestion: () => 'trace amount',
      getScopeNotes: () => [],
    },
  } as unknown as AiSession;
}

describe('CT — the instruction given to a column-less focus', () => {
  // `report` is traced on [amount]. `carrier` continues that column. `side` is inner-joined into
  // `report` but declares no `amount` at all — it only restricts rows — and `behind` sits above it.
  // The plan's A -> B -> (C, D) shape, with `side` as D and `behind` as F.
  const nodes: LineageNode[] = [
    makeNode({
      id: 'report', schema: 'dbo', name: 'report', type: 'view',
      columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
    }),
    makeNode({
      id: 'carrier', schema: 'dbo', name: 'carrier', type: 'view',
      columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
    }),
    makeNode({
      id: 'side', schema: 'dbo', name: 'side', type: 'view',
      columns: [{ name: 'region', type: 'varchar', nullable: 'NOT NULL', extra: '' }],
    }),
    makeNode({
      id: 'behind', schema: 'dbo', name: 'behind', type: 'view',
      columns: [{ name: 'region', type: 'varchar', nullable: 'NOT NULL', extra: '' }],
    }),
  ];
  // [source, consumer] — upstream from `report` reaches `carrier` and `side`; `behind` feeds `side`.
  const edges: Array<[string, string]> = [['carrier', 'report'], ['side', 'report'], ['behind', 'side']];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);

  /**
   * Walks the CT exploration from `report` until `side` is dispatched, returning the complete
   * prompt that hop is dispatched with and the active column set the engine bound to it.
   */
  function reachColumnlessHop(): { prompt: string; activeColumns: string[]; mode: string; dispatched: boolean } {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({
      origin: 'report',
      question: 'trace amount',
      direction: 'upstream',
      targetColumns: ['amount'],
      depthIntent: { kind: 'explicit', levels: 3 },
    });
    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'report',
      sections: [{ angle: 'business' as const, text: 'report body' }],
      summary: 'report body',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'carrier', col: 'amount' }] }],
      route_requests: [
        { nodeId: 'carrier', question: 'where does amount come from' },
        { nodeId: 'side', question: 'what does this restrict', columns: 'none' },
      ],
    });

    for (let hop = 0; hop < 8; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      const activeColumns = engine.columnAspect?.active_columns ?? [];
      if (id === 'side') {
        const sess = promptSession(engine);
        const system = buildActiveInstruction(sess, CTX, engine.currentHopAnalysisMode).system;
        const hop = buildActiveHopInstruction(sess, engine, engine.currentFocus!).message;
        return {
          prompt: `${system}\n${hop}`,
          activeColumns: [...activeColumns],
          mode: engine.currentHopAnalysisMode,
          dispatched: true,
        };
      }
      engine.submitFindings({
        focus_node_id: id,
        sections: [{ angle: 'business' as const, text: 'ok' }],
        summary: 'ok',
        verdict: 'passthrough',
        column_flow: [],
      });
    }
    return { prompt: '', activeColumns: [], mode: '', dispatched: false };
  }

  it('(gate-0) the column-less branch is dispatched as a hop at all — BB/CT parity on the node set', () => {
    const { dispatched, activeColumns, mode } = reachColumnlessHop();
    expect(
      dispatched,
      '`side` carries none of the traced columns but is inner-joined into the origin; CT must walk the same node set as BB',
    ).toBe(true);
    expect(activeColumns, 'this is genuinely the column-less case, not a mis-built fixture').toEqual([]);
    expect(mode, 'and it is dispatched under the BB contract, which is the surface the gates below read').toBe('bb');
  });

  it('(gate-1) the hop declares no disposition — the verdict is the AI\'s call', () => {
    // The engine may not promise an outcome it will not enforce: it accepts a prune here, because
    // the AI owns the verdict. Announcing one and then not standing behind it is what contradicted
    // the prune trigger the same prompt carries.
    const { prompt } = reachColumnlessHop();
    const lower = prompt.toLowerCase();
    for (const claim of ['kept in the answer', 'node is kept', 'will be kept']) {
      expect(
        lower.includes(claim),
        `the hop must not declare a verdict the engine does not enforce (found "${claim}")`,
      ).toBe(false);
    }
    // All three stay reachable: a row-shaper is kept and a log writer is pruned under the same
    // instruction, and only the body tells them apart.
    for (const verdict of ['analyze', 'passthrough', 'prune']) {
      expect(prompt, `${verdict} stays available to this hop`).toContain(verdict);
    }
  });

  it('(gate-2) the hop asks what the node does to the ROW SET', () => {
    const { prompt } = reachColumnlessHop();
    // The distinctive clause, not the three bare words: `join`/`filter`/`predicate` occur widely
    // enough in an assembled prompt that matching them alone passes without the row-set ask ever
    // being present. This phrase exists only in the BB route question.
    expect(
      prompt,
      'a column-less node earns its place by what it does to the rows; the hop must ask for exactly that',
    ).toContain('decide which rows survive it');
    const lower = prompt.toLowerCase();
    expect(
      ['joins', 'filters', 'predicates'].every(term => lower.includes(term)),
      'and names the constructs that do it',
    ).toBe(true);
  });

});
