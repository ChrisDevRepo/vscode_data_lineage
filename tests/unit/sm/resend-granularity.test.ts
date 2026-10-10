/**
 * Resend granularity, field by field: a payload rejected on one field is repaired by resending the
 * envelope and that field alone, and the engine receives every other value exactly as first sent.
 * One case per field of the two tools that hold a draft, checking retained content and accepted repairs.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { holdRejectedPresentResult, mergePresentResultRepairPatch, type PresentResultInput, type PresentResultRepairAuthorization } from '../../../src/ai/tools/presentResult';
import { PresentResultModelSchema, presentResultRepairPatchSchemaForFields } from '../../../src/ai/tools/toolSchemas';
import { RepairDraftStore } from '../../../src/ai/support/repairDraftStore';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { stubToolServices } from './helpers/toolServices';

const origin = '[g].[origin]', left = '[g].[left]', right = '[g].[right]';
const col = { name: 'Value', type: 'int', nullable: 'NULL' as const, extra: '' };

function world(mode: 'bb' | 'ct') {
  const nodes = [
    makeNode({ id: origin, schema: 'g', name: origin, type: 'view', columns: [col], bodyScript: `SELECT l.Value FROM ${left} l JOIN ${right} r ON l.Value = r.Value;` }),
    makeNode({ id: left, schema: 'g', name: left, type: 'table', columns: [col] }),
    makeNode({ id: right, schema: 'g', name: right, type: 'table', columns: [col] }),
  ];
  const pairs: Array<[string, string]> = [[left, origin], [right, origin]];
  const model = makeModel(nodes, pairs, ['g']);
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model; session.graph = graph; session.setClassification('technical'); session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {}); engine.classification = 'technical';
  expect(engine.init({ origin, question: 'Trace Value.', analysisMode: mode, ...(mode === 'ct' ? { targetColumns: ['Value'] } : {}), direction: 'upstream',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  engine.getHopContext(); session.stateMachine = engine; session.memory.setUserQuestion('Trace Value.'); session.enterExploring(session.turnEpoch);
  const bind = () => stubToolServices({ session, model, graph }).services;
  return { engine, bind };
}

const prose = 'The view joins left and right on Value and hands Value on unchanged. '.repeat(12);
const full = (mode: 'bb' | 'ct') => ({
  focus_node_id: origin,
  verdict: 'analyze' as const,
  summary: 'Joins left and right on Value.',
  sections: { technical: prose },
  badge_label: 'Join',
  prune_neighbors: [{ id: left, reason: 'Left only supplies the join key.' }],
  questions: [{ nodeId: right, question: 'Establish where Value originates in right.' }],
  ...(mode === 'ct' ? { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: right, col: 'Value', note: 'Passed through the join.' }] }] } : {}),
});

/** How each field is broken on the first call, and the corrected value the resend carries. */
const faults: Array<[field: string, broken: unknown, corrected: unknown, modes: Array<'bb' | 'ct'>]> = [
  ['summary', '', 'Joins left and right on Value.', ['bb', 'ct']],
  ['sections', {}, { technical: prose }, ['bb', 'ct']],
  ['badge_label', '   ', 'Join', ['bb', 'ct']],
  ['prune_neighbors', 'left', [{ id: left, reason: 'Left only supplies the join key.' }], ['bb', 'ct']],
  ['questions', 'right', [{ nodeId: right, question: 'Establish where Value originates in right.' }], ['bb', 'ct']],
  ['column_flow', [{ out_col: 'Nope', upstream_columns: [] }], [{ out_col: 'Value', upstream_columns: [{ node: right, col: 'Value', note: 'Passed through the join.' }] }], ['ct']],
];

describe('submit_findings: a rejection on one field is repaired by that field alone', () => {
  for (const [field, broken, corrected, modes] of faults) {
    for (const mode of modes) {
      it(`${mode}: ${field}`, () => {
        const w = world(mode);
        const payload = full(mode);
        const rejected = JSON.parse(executeSubmitFindings({ ...payload, [field]: broken }, w.bind()));
        expect(rejected.code).toBe('invalid_input');
        expect(rejected.issuePaths?.[0]?.startsWith(field)).toBe(true);
        for (const other of Object.keys(payload).filter(key => !['focus_node_id', 'verdict', field].includes(key))) {
          // Within the Held sentence; a held list label names bracketed ids such as `([d].[left])`, whose dots do not end it.
          expect(rejected.hint, `${other} is held`).toMatch(new RegExp(`Held:(?:[^.[]|\\[[^\\]]*\\](?:\\.\\[[^\\]]*\\])*)*\\b${other}\\b`));
        }
        const merged = vi.spyOn(w.engine, 'applyHeldContent');
        const resend = { focus_node_id: origin, verdict: 'analyze' as const, [field]: corrected };
        expect(JSON.parse(executeSubmitFindings(resend, w.bind()))).toHaveProperty('ok', true);
        const received = merged.mock.results[0]!.value as Record<string, unknown>;
        expect(received).toMatchObject({
          summary: payload.summary, badge_label: payload.badge_label, prune_neighbors: payload.prune_neighbors, questions: payload.questions,
          sections: [{ angle: 'technical', text: prose }],
          ...(mode === 'ct' ? { column_flow: (payload as { column_flow: unknown }).column_flow } : {}),
        });
      });
    }
  }

  it('a call rejected only for an unknown key is repaired by the envelope alone', () => {
    const w = world('ct');
    const payload = full('ct');
    expect(JSON.parse(executeSubmitFindings({ ...payload, caption: 'Not a field.' }, w.bind()))).toMatchObject({ code: 'invalid_input', issuePaths: ['caption'] });
    const merged = vi.spyOn(w.engine, 'applyHeldContent');
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: origin, verdict: 'analyze' }, w.bind()))).toHaveProperty('ok', true);
    expect(merged.mock.results[0]!.value).toMatchObject({ summary: payload.summary, badge_label: 'Join', column_flow: payload.column_flow, prune_neighbors: payload.prune_neighbors, questions: payload.questions });
  });
});

const report = {
  name: 'Orders lineage', summary: 'How Orders is produced.', title: 'Orders', intro: 'Intro. '.repeat(50), closing: 'Closing. '.repeat(50), layout_direction: 'LR',
  highlight_groups: [{ label: 'Sources', color: 'source', node_ids: ['dbo.a'] }, { label: 'Targets', color: 'target', node_ids: ['dbo.b'] }],
  sections: [{ label: 'Sources', node_ids: ['dbo.a'], text: 'Body. '.repeat(100) }, { label: 'Targets', node_ids: ['dbo.b'], text: 'Body. '.repeat(100) }],
  notes: [{ node_id: 'dbo.a', caption: 'A caption.' }],
};

/** How each report field is broken, the patch that repairs it, and the field list the hold authorizes. */
const reportFaults: Array<[label: string, broken: Partial<Record<string, unknown>>, patch: Record<string, unknown>, authorized: string[]]> = [
  ['name', { name: 'x'.repeat(200) }, { name: 'Orders lineage' }, ['name']],
  ['summary', { summary: '' }, { summary: 'How Orders is produced.' }, ['summary']],
  ['title', { title: 't'.repeat(300) }, { title: 'Orders' }, ['title']],
  ['intro', { intro: 7 }, { intro: report.intro }, ['intro']],
  ['closing', { closing: 7 }, { closing: report.closing }, ['closing']],
  ['layout_direction', { layout_direction: 'XX' }, { layout_direction: 'LR' }, ['layout_direction']],
  ['one section text leaf', { sections: [{ ...report.sections[0], text: '' }, report.sections[1]] }, { sections: [{ index: 0, text: report.sections[0].text }] }, ['sections']],
  ['one highlight label leaf', { highlight_groups: [{ ...report.highlight_groups[0], label: 'y'.repeat(70) }, report.highlight_groups[1]] }, { highlight_groups: [{ index: 0, label: 'Sources' }] }, ['highlight_groups']],
  ['one note caption', { notes: [{ node_id: 'dbo.a' }] }, { notes: report.notes }, ['notes']],
];

describe('present_result: a rejection on one field is repaired by that field alone', () => {
  for (const [label, broken, patch, authorized] of reportFaults) {
    it(label, () => {
      const input = { ...report, ...broken };
      const parsed = PresentResultModelSchema.safeParse(input);
      expect(parsed.success).toBe(false);
      const rejection = rejectionFromZodError(parsed.error!, { code: 'invalid_input', input, schema: PresentResultModelSchema });
      const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
      const sentence = holdRejectedPresentResult(store, input, rejection.issuePaths ?? [], 'synthesis');
      expect(sentence).toContain(`only these corrected fields: ${authorized.join(', ')}`);
      const authorization = store.getAuthorization()!;
      expect(authorization.fields).toEqual(authorized);
      const schema = presentResultRepairPatchSchemaForFields(authorization.fields, 'synthesis', 0, authorization.highlightLabelIndexes, authorization.sectionTextLeaves);
      expect(schema.safeParse(patch).success, JSON.stringify(schema.safeParse(patch))).toBe(true);
      // The patch is the corrected field alone: every other report field stays held.
      expect(Object.keys(patch)).toEqual(authorized);
      const merged = mergePresentResultRepairPatch(store.get()!, patch as never, authorization);
      expect(merged).toEqual(report);
    });
  }
});
