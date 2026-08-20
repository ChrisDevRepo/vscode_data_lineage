/**
 * Golden byte-comparison harness for every exported prompt-builder variant.
 *
 * @remarks
 * Renders each (round, variant) pair with the deterministic fixtures in `./fixtures.ts` and
 * byte-compares the result against `./golden/<round>.<variant>.txt`. This is the harness's whole
 * job: catch a prompt-text regression the rest of the AI-core suite doesn't pin (see the WS-F
 * coverage-map finding this package implements — most of `stagePrompts.ts`, `templateRenderer.ts`,
 * and 12 of 13 YAML keys previously had zero content assertions anywhere in `tests/`).
 *
 * Regenerate every golden after a deliberate prompt change:
 *   UPDATE_GOLDEN=1 npm run test:prompts
 * then review the `git diff` on `golden/*.txt` as the reviewable prompt-change artifact.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  buildEntryDetectorSystemPrompt,
  buildSmEntrySystemPrompt,
  buildGateRefineSystemPrompt,
  buildGateRefinePrompt,
  buildHostStageSystemPrompt,
  buildActiveContinuationAnchor,
  buildVisualPreviewSystemPrompt,
} from '../../../src/ai/prompting/hostPrompts';
import {
  buildGeneralSystemPrompt,
  buildPhasePrompt,
  buildPresentationDetailContract,
  buildDiscoverySummaryComposePrompt,
  buildOriginalQuestionBlock,
  buildMissionBriefBlock,
  buildCurrentTaskBlock,
  buildMemoryBlock,
  buildColumnAspectPrompt,
  expandRunTracePrompt,
  RUN_TRACE_TRIGGER,
} from '../../../src/ai/prompting/prompts';
import {
  buildSmProtocol,
  buildBbSynthesisBlock,
  buildCtSynthesisBlock,
  buildPassthroughFlowFacts,
  buildSmCompletionEnvelope,
  buildPassthroughReAnchor,
} from '../../../src/ai/prompting/smPrompts';
import { resolveStagePrompt } from '../../../src/ai/prompting/templateRenderer';
import {
  buildWorkerHopMessage,
  buildDiscoveryInstruction,
  buildActiveInstruction,
  buildActiveHopInstruction,
  buildSynthesisInstruction,
} from '../../../src/ai/agent/stagePrompts';

import {
  ctx,
  QUESTION,
  ANSWER,
  ORIGIN,
  MISSION_BRIEF,
  CONTRACT_SUMMARY,
  TARGET_COLUMNS,
  SCOPE_SUMMARY_MD,
  REFINE_BB,
  REFINE_CT,
  PHASES,
  CLASSIFICATIONS,
  CT_EDGES,
  templates,
  HOP_CONTEXT_BODIED,
  HOP_CONTEXT_NON_BODIED,
  asHopContext,
  makeSession,
  makeEngine,
  smResultFixtures,
} from './fixtures';

const GOLDEN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'golden');
fs.mkdirSync(GOLDEN_DIR, { recursive: true });

interface Case {
  round: string;
  variant: string;
  render: () => string[];
}

const CASES: Case[] = [];

/** Registers one (round, variant) case. `render()` returns the non-empty text blocks to join. */
function add(round: string, variant: string, render: () => string[]): void {
  CASES.push({ round, variant, render });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 1 — hostPrompts.ts
// ══════════════════════════════════════════════════════════════════════════════════════════════

add('entry_detector_system', 'default', () => [buildEntryDetectorSystemPrompt(ctx)]);

add('sm_entry_system', 'bb', () => [buildSmEntrySystemPrompt(ctx)]);
add('sm_entry_system', 'ct', () => [buildSmEntrySystemPrompt(ctx, TARGET_COLUMNS)]);

add('gate_refine_system', 'default', () => [buildGateRefineSystemPrompt(ctx)]);

add('gate_refine_prompt', 'bb', () => [buildGateRefinePrompt(SCOPE_SUMMARY_MD, REFINE_BB, 2)]);
add('gate_refine_prompt', 'ct', () => [buildGateRefinePrompt(SCOPE_SUMMARY_MD, REFINE_CT, 3)]);

for (const phase of PHASES) {
  add('host_stage_system', phase, () => [buildHostStageSystemPrompt(phase, ctx)]);
}

add('visual_preview_system', 'default', () => [buildVisualPreviewSystemPrompt(ctx)]);

add('active_continuation_anchor', 'default', () => [buildActiveContinuationAnchor()]);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 2 — prompts.ts (standalone blocks not already covered above)
// ══════════════════════════════════════════════════════════════════════════════════════════════

for (const phase of PHASES) {
  add('general_system_prompt', phase, () => [buildGeneralSystemPrompt(phase, ctx)]);
  add('phase_prompt', phase, () => [buildPhasePrompt(phase)]);
}

add('presentation_detail_contract', 'with_evidence', () => [
  buildPresentationDetailContract('The detailed walkthrough belongs in `sections[].text`.'),
]);
add('presentation_detail_contract', 'no_evidence', () => [buildPresentationDetailContract()]);

add('run_trace_trigger_prompt', 'default', () => [
  expandRunTracePrompt(RUN_TRACE_TRIGGER, {
    lastDiscoveryOrigin: ORIGIN,
    lastDiscoveryQuestion: QUESTION,
    lastDiscoveryAnswer: ANSWER,
  }),
]);

add('discovery_summary_compose_prompt', 'default', () => [
  buildDiscoverySummaryComposePrompt(QUESTION, ANSWER, CONTRACT_SUMMARY),
]);

add('original_question_block', 'default', () => [buildOriginalQuestionBlock(QUESTION)]);
add('original_question_block', 'empty', () => [buildOriginalQuestionBlock(null)]);

add('mission_brief_block', 'with_brief', () => [buildMissionBriefBlock(MISSION_BRIEF, QUESTION)]);
add('mission_brief_block', 'fallback_to_question', () => [buildMissionBriefBlock('', QUESTION)]);

add('current_task_block', 'root_only', () => [
  buildCurrentTaskBlock([{ kind: 'root', question: QUESTION }]),
]);
// buildCurrentTaskBlock only branches on `kind === 'root'` and renders `.question`, so any non-root
// kind produces byte-identical output; 'analytical' is a real InvestigationTask kind that preserves
// the golden text while satisfying the real Pick<InvestigationTask,'kind'|'question'> param type.
add('current_task_block', 'sub_question', () => [
  buildCurrentTaskBlock([{ kind: 'analytical', question: 'What business rule sets NetAmountA when PriceA is null?' }]),
]);
add('current_task_block', 'with_ct_and_lineage_questions', () => [
  buildCurrentTaskBlock(
    [{ kind: 'root', question: QUESTION }],
    TARGET_COLUMNS,
    ['dbo.OrderDetailA.QtyA -> dbo.spLoadFactSales.NetAmountA still needs a terminal source'],
  ),
]);

add('memory_block', 'empty', () => [buildMemoryBlock([])]);
add('memory_block', 'with_stm_and_rejections', () => [
  buildMemoryBlock(
    [{ nodeId: 'dbo.OrderDetailA', summary: 'Passthrough source; QtyA feeds NetAmountA.' }],
    [{ nodeId: 'dbo.DimProduct', reason: 'route target already visited', atHop: 1 }],
  ),
]);

add('column_aspect_prompt', 'default', () => [buildColumnAspectPrompt(TARGET_COLUMNS)]);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 3 — smPrompts.ts
// ══════════════════════════════════════════════════════════════════════════════════════════════

for (const classification of CLASSIFICATIONS) {
  add('sm_protocol', `bb_${classification}`, () => [buildSmProtocol({ classification })]);
}
add('sm_protocol', 'ct_business', () => [
  buildSmProtocol({ targetColumns: TARGET_COLUMNS, classification: 'business' }),
]);

add('bb_synthesis_block', 'default', () => [
  buildBbSynthesisBlock(ORIGIN, [
    ['dbo.OrderDetailA', 'dbo.spLoadFactSales', 'reads'],
    ['dbo.DimProduct', 'dbo.spLoadFactSales', 'reads'],
    ['dbo.spLoadFactSales', 'dbo.FactSales', 'writes'],
  ]),
]);

add('ct_synthesis_block', 'with_edges', () => [
  buildCtSynthesisBlock(ORIGIN, CT_EDGES, [], [
    ['dbo.OrderDetailA', 'dbo.spLoadFactSales', 'reads'],
    ['dbo.DimProduct', 'dbo.spLoadFactSales', 'reads'],
    ['dbo.spLoadFactSales', 'dbo.FactSales', 'writes'],
  ]),
]);
add('ct_synthesis_block', 'zero_trace', () => [buildCtSynthesisBlock(ORIGIN, [], [], [])]);

add('passthrough_flow_facts', 'default', () => [
  buildPassthroughFlowFacts(smResultFixtures.passthroughFlowFacts),
]);

// buildSynthesisReminder is NOT exported from smPrompts.ts — isolate its exact real output via
// buildSmCompletionEnvelope with a fixture SmResult shaped so no flow/passthrough block appends
// (edges: [], and the sole fullNodes entry is already slotted) — the envelope's
// synthesis_reminder field is then byte-identical to buildSynthesisReminder(question) alone.
add('synthesis_reminder', 'isolated_via_envelope', () => [
  buildSmCompletionEnvelope(smResultFixtures.synthesisReminder, QUESTION, []).synthesis_reminder,
]);

add('sm_completion_envelope', 'small_fixture', () => [
  JSON.stringify(
    buildSmCompletionEnvelope(smResultFixtures.smCompletionEnvelope, QUESTION, smResultFixtures.smCompletionEnvelopeDeferred),
    null,
    2,
  ),
]);

add('passthrough_re_anchor', 'bb', () => [
  buildPassthroughReAnchor('dbo.OrderDetailA', 'dbo.spLoadFactSales', 'bb'),
]);
add('passthrough_re_anchor', 'ct', () => [
  buildPassthroughReAnchor('dbo.OrderDetailA', 'dbo.spLoadFactSales', 'ct'),
]);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 4 — templateRenderer.ts: resolveStagePrompt across reachable gate combinations
// ══════════════════════════════════════════════════════════════════════════════════════════════

// discover: classification/ctMode do not gate any discover-stage key — one representative call.
add('resolve_stage_prompt', 'discover', () => [
  resolveStagePrompt(templates, 'discover', undefined, undefined, false, { scope: 'stable' }).prompt,
]);

// active / stable scope — column_trace_capture is the only key reachable at stable scope.
for (const classification of CLASSIFICATIONS) {
  for (const ctMode of [false, true]) {
    const variant = `active_stable_${classification}_ct${ctMode ? '1' : '0'}`;
    add('resolve_stage_prompt', variant, () => [
      resolveStagePrompt(templates, 'active', classification, 3, ctMode, { scope: 'stable' }).prompt,
    ]);
  }
}

// active / per_focus bodied — business_capture / technical_capture per classification.
for (const classification of CLASSIFICATIONS) {
  add('resolve_stage_prompt', `active_per_focus_bodied_${classification}`, () => [
    resolveStagePrompt(templates, 'active', classification, 3, false, { scope: 'per_focus', focusKind: 'bodied' }).prompt,
  ]);
}

// active / per_focus non_bodied — structural_summary only, classification-invariant by construction.
for (const classification of CLASSIFICATIONS) {
  add('resolve_stage_prompt', `active_per_focus_non_bodied_${classification}`, () => [
    resolveStagePrompt(templates, 'active', classification, 3, false, { scope: 'per_focus', focusKind: 'non_bodied' }).prompt,
  ]);
}

// synthesis / stable — classification x slotCount(3,8) crossing the closing-suppression boundary (5).
for (const classification of CLASSIFICATIONS) {
  for (const slotCount of [3, 8]) {
    add('resolve_stage_prompt', `synthesis_${classification}_slots${slotCount}`, () => [
      resolveStagePrompt(templates, 'synthesis', classification, slotCount, false, { scope: 'stable' }).prompt,
    ]);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 5 — agent/stagePrompts.ts (the richer session/engine-shaped builders)
// ══════════════════════════════════════════════════════════════════════════════════════════════

add('discovery_instruction', 'default', () => {
  const sess = makeSession({ classification: undefined });
  return [buildDiscoveryInstruction(sess, ctx).system];
});

for (const classification of CLASSIFICATIONS) {
  add('active_instruction', `bb_${classification}`, () => {
    const sess = makeSession({ classification });
    const engine = makeEngine({ columnAspect: null });
    sess.stateMachine = engine;
    return [buildActiveInstruction(sess, ctx, false).system];
  });
}
add('active_instruction', 'ct_business', () => {
  const sess = makeSession({ classification: 'business' });
  const engine = makeEngine({ columnAspect: { target_columns: TARGET_COLUMNS, active_columns: TARGET_COLUMNS, edges: [] } });
  sess.stateMachine = engine;
  return [buildActiveInstruction(sess, ctx, true).system];
});

// active hop instruction — bodied/non_bodied x rejections/required-neighbors x CT
add('active_hop_instruction', 'bodied_bb_business', () => {
  const sess = makeSession({ classification: 'business' });
  const engine = makeEngine({
    currentFocus: 'dbo.spLoadFactSales', columnAspect: null,
    requiredNeighborIds: ['dbo.DimProduct'],
    hopContext: HOP_CONTEXT_BODIED,
  });
  return [buildActiveHopInstruction(sess, engine, 'dbo.spLoadFactSales').message];
});
add('active_hop_instruction', 'bodied_bb_both_with_rejections', () => {
  const sess = makeSession({
    classification: 'both',
    recentRejections: [{ nodeId: 'dbo.DimCurrency', reason: 'not a direct neighbor of the current focus', atHop: 1 }],
  });
  const engine = makeEngine({
    currentFocus: 'dbo.spLoadFactSales', columnAspect: null,
    requiredNeighborIds: [],
    hopContext: HOP_CONTEXT_BODIED,
  });
  return [buildActiveHopInstruction(sess, engine, 'dbo.spLoadFactSales').message];
});
add('active_hop_instruction', 'non_bodied_bb_technical', () => {
  const sess = makeSession({ classification: 'technical' });
  const engine = makeEngine({
    currentFocus: 'dbo.FactSales', columnAspect: null,
    requiredNeighborIds: [],
    hopContext: HOP_CONTEXT_NON_BODIED,
  });
  return [buildActiveHopInstruction(sess, engine, 'dbo.FactSales').message];
});
add('active_hop_instruction', 'bodied_ct_with_lineage_questions', () => {
  const sess = makeSession({ classification: 'business' });
  const engine = makeEngine({
    currentFocus: 'dbo.spLoadFactSales',
    columnAspect: { target_columns: TARGET_COLUMNS, active_columns: TARGET_COLUMNS, edges: [] },
    pendingLineageQuestions: ['dbo.OrderDetailA.QtyA -> dbo.spLoadFactSales.NetAmountA still needs a terminal source'],
    hopContext: HOP_CONTEXT_BODIED,
  });
  return [buildActiveHopInstruction(sess, engine, 'dbo.spLoadFactSales').message];
});

for (const classification of CLASSIFICATIONS) {
  for (const slotCount of [3, 8]) {
    add('synthesis_instruction', `${classification}_slots${slotCount}`, () => {
      const sess = makeSession({ classification, slotCount });
      const engine = makeEngine({ discoverySummary: 'The user asked how FactSales is loaded; NetAmountA = QtyA x PriceA.' });
      sess.stateMachine = engine;
      return [buildSynthesisInstruction(sess, ctx).system];
    });
  }
}

add('worker_hop_message', 'with_hop', () => [
  buildWorkerHopMessage(asHopContext(HOP_CONTEXT_BODIED), 'dbo.spLoadFactSales'),
]);
add('worker_hop_message', 'null_hop', () => [
  buildWorkerHopMessage(null, 'dbo.FactSales'),
]);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Golden byte comparison
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('prompt golden renders', () => {
  for (const c of CASES) {
    it(`${c.round}.${c.variant}`, () => {
      const blocks = c.render();
      const fullText = blocks.filter((t) => t.length > 0).join('\n\n');
      const goldenPath = path.join(GOLDEN_DIR, `${c.round}.${c.variant}.txt`);

      if (process.env.UPDATE_GOLDEN === '1') {
        fs.writeFileSync(goldenPath, fullText, 'utf8');
        return;
      }

      expect(
        fs.existsSync(goldenPath),
        `missing golden ${c.round}.${c.variant}.txt — run "UPDATE_GOLDEN=1 npm run test:prompts" to generate it`,
      ).toBe(true);
      const expected = fs.readFileSync(goldenPath, 'utf8');
      expect(
        fullText,
        `golden mismatch for ${c.round}.${c.variant} — run "UPDATE_GOLDEN=1 npm run test:prompts" to regenerate if this change is intended`,
      ).toBe(expected);
    });
  }

  it('covers every registered case exactly once', () => {
    const keys = CASES.map((c) => `${c.round}.${c.variant}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The per-case assertions above only run case -> file. A prompt round that is deleted or renamed
  // leaves its golden behind with nothing reading it, and a stale file that no assertion touches
  // reads on disk exactly like a maintained one. Skipped under UPDATE_GOLDEN, where the regenerated
  // set is the thing being established rather than checked.
  it.skipIf(process.env.UPDATE_GOLDEN === '1')('leaves no golden file without a registered case', () => {
    const onDisk = fs.readdirSync(GOLDEN_DIR)
      .filter((name) => name.endsWith('.txt'))
      .map((name) => name.slice(0, -'.txt'.length))
      .sort();
    const registered = CASES.map((c) => `${c.round}.${c.variant}`).sort();
    const orphans = onDisk.filter((name) => !registered.includes(name));
    expect(
      orphans,
      `golden files with no registered case — delete them: ${orphans.join(', ')}`,
    ).toEqual([]);
  });
});
