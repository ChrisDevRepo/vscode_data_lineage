/** Deterministic production tool-error-envelope contract: the one rejection record, the Zod issue mapping and the one renderer (D-103, D-105). Tests assert paths, issue codes, backend values and the stage; every rendered sentence is a table string (see rejection-render.test.ts). */
import { ISSUES, readToolError, readToolErrorText, isConsentGateRejection, makeRejection, rejectionFromZodError, renderProblem, type FeedbackStage, type ToolRejection } from '../../../src/ai/support/toolErrorEnvelope';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph, makeIndexedModel, makeModel, makeNode } from '../helpers/modelFixtures';
import { validatePresentResult } from '../../../src/ai/tools/presentResult';
import { presentResultSchemaForPhase } from '../../../src/ai/tools/toolSchemas';
import { AiSession } from '../../../src/ai/session/session';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import { buildModel } from '../../../src/engine/modelBuilder';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';

interface Shown { path: string; fault: string; correction: string; allowed?: string[]; missing?: string[]; more?: number }
interface Problem { code: string; attempt: string; notice?: string; guidance: Array<{ category: string; instruction: string; errors: Shown[]; more?: number; fallback?: string }>; resend: string[]; resend_rule?: string }
const render = (rejection: ToolRejection, stage: FeedbackStage, input?: unknown): Problem => JSON.parse(renderProblem(rejection, stage, input));
const zodRejection = (schema: z.ZodType, input: unknown) => {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error('Expected schema faults');
  return rejectionFromZodError(parsed.error, { code: 'invalid_input', input, schema });
};
const shown = (problem: Problem): Shown[] => problem.guidance.flatMap(group => group.errors);
const at = (problem: Problem, path: string) => shown(problem).find(error => error.path === path);
const faults = (rejection: ToolRejection) => rejection.errors.map(error => [error.path, error.code]);

describe("tool-error-envelope", () => {
  it('retains resend fields and resend rules through JSON and the renderer', () => {
    const rejection = makeRejection({ code: 'invalid_regex', errors: [{ path: 'query', code: 'invalid_regex' }], resend: ['sections'], resendRules: ['sections'] });
    expect(readToolError(JSON.parse(JSON.stringify(rejection)))).toEqual(rejection);
    expect(render(rejection, 1)).toMatchObject({ resend: ['sections'], resend_rule: expect.any(String) });
  });

  it('keeps the fault at its path from feedback 1, its allowed values from feedback 2, and the record unchanged', () => {
    const rejection = makeRejection({ code: 'contributor_col_not_on_source', reason: 'Column does not exist on the contributor.',
      errors: [{ path: 'column_flow.0.upstream_columns.1.col', code: 'unknown_column', values: ['Rate', 'Amount'] }] });
    const original = structuredClone(rejection);
    expect(at(render(rejection, 1), 'column_flow.0.upstream_columns.1.col')).toEqual({ path: 'column_flow.0.upstream_columns.1.col', fault: ISSUES.unknown_column.label, correction: ISSUES.unknown_column.correction });
    expect(at(render(rejection, 2), 'column_flow.0.upstream_columns.1.col')?.allowed).toEqual(['Amount', 'Rate']);
    expect(rejection).toEqual(original);
  });

  it('ranks allowed values by distance to the sent value, alphabetical on ties, and caps them at 15', () => {
    const values = Array.from({ length: 20 }, (_, index) => `Col${String(index).padStart(2, '0')}`);
    const rejection = makeRejection({ code: 'invalid_input', errors: [{ path: 'column_flow.0.out_col', code: 'unknown_column', values }] });
    const error = at(render(rejection, 2, { column_flow: [{ out_col: 'Col17x' }] }), 'column_flow.0.out_col')!;
    expect(error.allowed?.[0]).toBe('Col17');
    expect(error.allowed).toHaveLength(15);
    expect(error.more).toBe(5);
    expect(JSON.stringify(error)).not.toContain('Col17x');
  });


  it('derives errors from Zod issues with schema values, never the submitted value (D-102)', () => {
    const schema = z.object({ mode: z.enum(['a', 'b']), items: z.array(z.object({ name: z.string() }).strict()), count: z.number() }).strict();
    const input = { mode: 'zzz-sent', items: [{ name: 'ok', extra: 1 }], count: 'x'.repeat(200) };
    const rejection = zodRejection(schema, input);
    expect(rejection.errors).toEqual(expect.arrayContaining([
      { path: 'mode', code: 'enum', values: ['a', 'b'] },
      { path: 'items.0.extra', code: 'unknown_key', values: ['name'] },
      expect.objectContaining({ path: 'count', code: 'type' }),
    ]));
    for (const stage of [1, 2, 3] as const) expect(renderProblem(rejection, stage, input)).not.toMatch(/zzz-sent|xxxxx/);
  });

  it.each([z.number(), z.number().int()])('reports a numeric type fault without choosing or echoing a value: %s', owner => {
    for (const value of [null, 'three']) {
      const rejection = zodRejection(z.object({ value: owner }), { value });
      expect(rejection.issuePaths).toEqual(['value']);
      expect(faults(rejection)).toEqual([['value', 'type']]);
    }
  });

  it('reads a JSON string sent for an object as json_text', () => {
    expect(faults(zodRejection(z.object({ sections: z.object({ a: z.string() }) }), { sections: '{"a":"x"}' }))).toEqual([['sections', 'json_text']]);
  });

  it.each([false, true])('names an unknown key and its declared fields (nested=%s)', nested => {
    const schema = z.object({ entry: z.object({ value: z.string() }).strict() }).strict();
    const input = nested ? { entry: { value: 'Keep this text.', extra: 'x' } } : { entry: { value: 'Keep this text.' }, extra: 'x' };
    const rejection = zodRejection(schema, input);
    const path = nested ? 'entry.extra' : 'extra';
    expect(rejection.errors).toEqual([{ path, code: 'unknown_key', values: [nested ? 'value' : 'entry'] }]);
    expect(at(render(rejection, 1), path)?.allowed).toBeUndefined();
    expect(at(render(rejection, 2), path)?.allowed).toEqual([nested ? 'value' : 'entry']);
  });

  it('states a native never fault without values', () => {
    const rejection = zodRejection(z.object({ items: z.array(z.object({ id: z.never() }).strict()) }).strict(), { items: [{ id: 'invalid' }] });
    expect(faults(rejection)).toEqual([['items.0.id', 'never']]);
  });

  it('maps a custom refinement through params.issue and params.allowed_values', () => {
    const schema = z.object({ col: z.string().refine(value => value === 'A', { params: { issue: 'unknown_column', allowed_values: ['A'] } }),
      other: z.string().refine(() => false, { params: { allowed_values: ['B'] } }), free: z.string().refine(() => false) });
    expect(zodRejection(schema, { col: 'x', other: 'y', free: 'z' }).errors).toEqual([
      { path: 'col', code: 'unknown_column', values: ['A'] }, { path: 'other', code: 'enum', values: ['B'] }, { path: 'free', code: 'invalid' }]);
  });

  describe('D-105 fallback: per issue code, only with the third rejection, never early', () => {
    const fallbackOf = (problem: Problem) => problem.guidance.find(group => group.fallback !== undefined)?.fallback;
    it.each([['supplier_out_of_scope', 'column_flow.0.upstream_columns.0.node'], ['result_out_of_scope', 'sections.0.node_ids.3'], ['unknown_column', 'column_flow.0.upstream_columns.0.col']] as const)('%s at %s', (code, path) => {
      for (const values of [[], ['x']]) {
        const rejection = makeRejection({ code: 'invalid_input', errors: [{ path, code, values }] });
        for (const stage of [1, 2] as const) expect(fallbackOf(render(rejection, stage))).toBeUndefined();
        const third = render(rejection, 3);
        expect(fallbackOf(third)).toBe((ISSUES[code] as { fallback?: string }).fallback);
        expect(third.resend).toContain('sections');
      }
    });
    it.each([['out_of_scope', 'column_flow.0.writes_to.node'], ['bad_write_target', 'column_flow.0.writes_to.node'], ['unknown_target_column', 'targetColumns.0'],
      ['not_in_result', 'sections.0.node_ids.0'], ['missing', 'summary']] as const)('%s at %s: no fallback at any feedback', (code, path) => {
      for (const stage of [1, 2, 3] as const) expect(fallbackOf(render(makeRejection({ code: 'invalid_input', errors: [{ path, code, values: [] }] }), stage))).toBeUndefined();
    });
  });

  it('states the expected focus as an allowed value, never the sent id', () => {
    const origin = '[dbo].[A]', sent = '[dbo].[Sent]';
    const node = makeNode({ id: origin, schema: 'dbo', name: 'A', type: 'view' });
    const engine = new NavigationEngine(makeModel([node], [], ['dbo']), makeGraph([node], []), () => {}, {});
    engine.init({ origin, question: 'Q', direction: 'upstream', analysisMode: 'bb',
      depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } });
    engine.getHopContext();
    const rejection = engine.pruneCurrent(sent, 'Off path.') as ToolRejection;
    expect(rejection.errors).toEqual([{ path: 'focus_node_id', code: 'not_current_object', values: [origin] }]);
    for (const stage of [1, 2, 3] as const) expect(renderProblem(rejection, stage, { focus_node_id: sent })).not.toContain(sent);
  });

  it('present_result unknown node ids: each at its element path with the result ids, no echo (D-102)', () => {
    for (const stage of ['completed', 'synthesis', 'visual_preview'] as const) {
      const sentId = '[dbo].[x]', sentLabel = 'LabelSentinel';
      const input = { name: 'Reports', summary: 'Reports lineage.', highlight_groups: [{ label: 'Out', color: 'target' as const, node_ids: [sentId] }],
        sections: [{ label: sentLabel, node_ids: ['[dbo].[a]', sentId], text: 'Report output.' }] };
      const result = validatePresentResult(input, ['[dbo].[a]'], undefined, undefined, [], stage, () => 'out_of_scope');
      if (result.success) throw new Error('Expected a node-id rejection');
      expect(result.rejection.errors).toEqual(expect.arrayContaining([
        { path: 'sections.0.node_ids.1', code: 'result_out_of_scope', values: ['[dbo].[a]'] },
        { path: 'highlight_groups.0.node_ids.0', code: 'result_out_of_scope', values: ['[dbo].[a]'] }]));
      for (const feedback of [1, 2, 3] as const) expect(renderProblem(result.rejection, feedback, input)).not.toMatch(/\[dbo\]\.\[x\]|LabelSentinel/);
    }
  });

  it('a node id given two captions is one duplicate fault at the later caption', () => {
    const admitted = validateToolCandidate(presentResultSchemaForPhase('completed'), { name: 'Reports', summary: 'Reports lineage.', highlight_groups: [{ label: 'Out', color: 'target', node_ids: ['[dbo].[b]'] }],
      sections: [{ label: 'Report', node_ids: ['[dbo].[b]'], text: 'Report output.' }],
      notes: [{ node_id: '[dbo].[S]', caption: 'First.' }, { node_id: '[dbo].[b]', caption: 'Other.' }, { node_id: '[dbo].[S]', caption: 'Second.' }] });
    if (admitted.success) throw new Error('Conflicting note captions admitted');
    const rejection = admitted.rejection;
    expect(rejection.errors.map(error => error.path)).toEqual(['notes.2.caption']);
    expect(renderProblem(rejection, 3)).not.toContain('[dbo].[S]');
  });

  it('renders only the problem shape: reason and detail never reach the model', () => {
    const rejection = makeRejection({ code: 'invalid_input', reason: 'REASON_SENTINEL', errors: [{ path: 'sections.0.label', code: 'missing' }],
      detail: [{ input: 'RAW_INPUT_SENTINEL', held_draft: { sections: [{ text: 'HELD_BODY_SENTINEL' }] } }] });
    for (const stage of [1, 2, 3] as const) {
      const content = renderProblem(rejection, stage);
      expect(Object.keys(JSON.parse(content)).sort()).toEqual(['attempt', 'code', 'guidance', 'resend', ...(stage === 3 ? ['notice'] : [])].sort());
      expect(content).not.toMatch(/SENTINEL/);
    }
  });

  it('readToolError: the rejection round-trips; reason falls back to the code', () => {
    const made = makeRejection({ code: 'focus_node_id_mismatch', errors: [{ path: 'focus_node_id', code: 'not_current_object', values: ['a'] }], detail: { expected: 'a' } });
    expect(readToolError(JSON.parse(JSON.stringify(made)))).toEqual(made);
    expect(made.reason).toBe('focus_node_id_mismatch');
  });

  it('readToolError: unknown keys, issue codes outside the table, an empty error list and retired shapes are not rejections', () => {
    expect(readToolError({ code: 'x', reason: 'y', errors: [{ path: '', code: 'missing' }], extra: 1 })).toBeNull();
    expect(readToolError({ code: 'x', reason: 'y', errors: [{ path: '', code: 'no_such_code' }] })).toBeNull();
    expect(readToolError({ code: 'x', reason: 'y', errors: [] })).toBeNull();
    expect(readToolError({ code: 'x', reason: 'y', errors: [{ path: '', code: 'missing', message: 'prose' }] })).toBeNull();
    expect(readToolError({ error: 'focus_mismatch', hint: 'h' })).toBeNull();
    expect(readToolError({ ok: false, reason: 'over_discovery_budget' })).toBeNull();
    for (const value of [{ ok: true, nodes: [] }, {}, null, 'a string']) expect(readToolError(value)).toBeNull();
  });

  it('makeRejection: requires an error, moves a path outside the grammar to the call, adds unstated missing parts', () => {
    expect(() => makeRejection({ code: 'x', errors: [] })).toThrow();
    const made = makeRejection({ code: 'validation', errors: [{ path: 'not a path!', code: 'invalid' }, { path: 'sections.0.text', code: 'missing' }], missingParts: ['sections.0.text', 'summary'] });
    expect(faults(made)).toEqual([['', 'invalid'], ['sections.0.text', 'missing'], ['summary', 'missing']]);
    expect(made.issuePaths).toEqual(['sections.0.text', 'summary']);
  });

  it('the consent gate is separable from a real rejection', () => {
    expect(isConsentGateRejection(makeRejection({ code: 'action_required', errors: [{ path: '', code: 'awaiting_approval' }] }).code)).toBe(true);
    expect(isConsentGateRejection(makeRejection({ code: 'validation', errors: [{ path: '', code: 'invalid' }] }).code)).toBe(false);
  });

  describe('rejectionFromZodError: invalid_union', () => {
    it('a field missing in every variant is one missing fault, not one per branch', () => {
      const levelsSchema = z.union([z.number().int().min(0), z.literal('all')]);
      const sideSchema = z.object({ levels: levelsSchema, exactness: z.enum(['exact', 'approximate']) }).strict();
      const depth = z.object({ upstream: sideSchema, downstream: sideSchema }).strict();
      const provider = z.union([
        z.object({ analysisMode: z.literal('bb'), depth }).strict(),
        z.object({ analysisMode: z.literal('ct'), depth, targetColumns: z.array(z.string()) }).strict(),
      ]);
      const rejection = zodRejection(provider, { analysisMode: 'bb', depth: { upstream: { exactness: 'exact' }, downstream: { levels: 2, exactness: 'exact' } } });
      expect(rejection.errors.filter(error => error.path === 'depth.upstream.levels')).toEqual([{ path: 'depth.upstream.levels', code: 'missing' }]);
    });

    it('an empty call names every field the variants require once', () => {
      const bbVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('bb') }).strict();
      const ctVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('ct'), targetColumns: z.array(z.string()) }).strict();
      const rejection = zodRejection(z.union([bbVariant, ctVariant]), {});
      expect(rejection.errors.map(error => error.path)).toEqual(expect.arrayContaining(['origin', 'classification', 'analysisMode']));
      for (const path of ['origin', 'classification']) expect(rejection.errors.filter(error => error.path === path)).toHaveLength(1);
    });
  });

  describe('rejectionFromZodError: a present value outside its enum', () => {
    const flowSchema = z.object({ verdict: z.enum(['pass', 'fail']), flow: z.array(z.object({ out: z.literal('Qty'), src: z.string() }).strict()).optional() }).strict();

    it('names each offending entry with the schema values', () => {
      const rejection = zodRejection(flowSchema, { verdict: 'pass', flow: [{ out: 'Qty', src: 'x' }, { out: 'Other', src: 'y' }, { out: 'More', src: 'z' }] });
      expect(rejection.errors).toEqual([{ path: 'flow.1.out', code: 'enum', values: ['Qty'] }, { path: 'flow.2.out', code: 'enum', values: ['Qty'] }]);
    });

    it('the first and the repeated rejection of the same call render identically', () => {
      const payload = { verdict: 'pass', flow: [{ out: 'Other', src: 'y' }] };
      for (const stage of [1, 2, 3] as const)
        expect(renderProblem(zodRejection(flowSchema, payload), stage)).toBe(renderProblem(zodRejection(flowSchema, structuredClone(payload)), stage));
    });

    it('an absent enum field is missing, not an invalid value', () => {
      expect(faults(zodRejection(flowSchema, {}))).toEqual([['verdict', 'missing']]);
    });
  });

  describe('rejectionFromZodError: size bounds', () => {
    const schema = z.object({ notes: z.array(z.string()).max(8).optional(), title: z.string().max(8).optional(), name: z.string().trim().min(1).optional(), revision: z.number().int().positive().optional() });
    it('a string sent for a bounded array is a type fault, an independent text limit a size fault', () => {
      expect(faults(zodRejection(schema, { notes: 'Ignore logging-related objects', title: 'nine char' }))).toEqual([['notes', 'type'], ['title', 'size']]);
    });
    it('array, blank-string and exclusive numeric bounds are size faults', () => {
      expect(faults(zodRejection(schema, { notes: Array.from({ length: 9 }, () => 'n'), name: '   ', revision: 0 }))).toEqual([['notes', 'size'], ['name', 'size'], ['revision', 'size']]);
    });
  });

  it('a key misplaced on a column_flow entry names the concrete path with the declared fields', () => {
    const ref = z.object({ node: z.string(), col: z.string(), note: z.string().optional() }).strict();
    const entry = z.object({ out_col: z.string(), writes_to: z.object({ node: z.string(), col: z.string() }).strict().nullish(), upstream_columns: z.array(ref) }).strict();
    const ok = { out_col: 'a', writes_to: null, upstream_columns: [] };
    const rejection = zodRejection(z.object({ column_flow: z.array(entry) }).strict(), { column_flow: [ok, ok, ok, ok, { ...ok, note: 'misplaced' }] });
    expect(rejection.errors).toEqual([{ path: 'column_flow.4.note', code: 'unknown_key', values: ['out_col', 'writes_to', 'upstream_columns'] }]);
  });
});

/** A present_result call with one unknown section id and detail slots that reached no section, rejected by the real handler. */
describe('renderProblem over a real present_result rejection: an unknown section id and unplaced detail slots', () => {
  const ids = ['[ai].[a]', '[ai].[b]', '[ai].[c]', '[ai].[d]'];
  async function rejectR3(verifyRepair = false): Promise<ToolRejection> {
    const model = buildModel(ids.map(id => ({ fullName: id, type: 'view' as const, bodyScript: 'SELECT 1 AS Qty', columns: [{ name: 'Qty', type: 'int', nullable: 'NULL', extra: '' }] })),
      [], undefined, undefined, true, undefined, false);
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.resultGraph = { nodeIds: ids, edges: ids.slice(1).map((id, i) => [id, ids[i]!, 'read'] as [string, string, string]), source: 'column_trace', originNodeId: ids[0]! };
    for (const id of ids.slice(1)) {
      const node = (model as unknown as { nodes: Array<{ id: string }> }).nodes.find(n => n.id === id);
      session.memory.storeDetail(node as never, [{ angle: 'technical', text: 'Captured finding.' }], 'Summary.');
    }
    session.enterCompleted(epoch);
    const services = { getSession: () => session, turnEpoch: () => epoch, requireModel: () => model, logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      budget: DEFAULT_TURN_TOKEN_BUDGET, deliverPreview: vi.fn().mockResolvedValue('delivered'), logAndReturn: (_n: string, data: object) => JSON.stringify(data),
      toolError: (_n: string, error: unknown) => { throw error; } } as never;
    const rejected = readToolErrorText(await executePresentResult({ name: 'Lineage', summary: 'How it flows.', layout_direction: 'LR',
      highlight_groups: [{ label: 'All', color: 'source', node_ids: [ids[0]] }],
      sections: [{ label: 'Origin', node_ids: [ids[0]], text: 'The origin.' }, { label: 'Cleaning', node_ids: ['[placeholder]'], text: 'Cleans rows.' }] }, services));
    if (!rejected) throw new Error('Expected a present_result rejection');
    if (verifyRepair) {
      const sections = [
        { label: 'Origin', node_ids: [ids[0]], text: 'The origin.' },
        { label: 'Captured findings', node_ids: ids.slice(1), text: 'Captured finding.' },
      ];
      const repaired = JSON.parse(await executePresentResult({ sections }, services));
      expect(repaired).toHaveProperty('success', true);
      expect(session.resultGraph?.sections).toEqual(sections);
      expect(session.resultGraph?.nodeIds).toEqual(ids);
    }
    return rejected;
  }
  const problem = async (stage: FeedbackStage) => render(await rejectR3(), stage);

  it('states each fault at its element path with its code and never echoes the sent id or label', async () => {
    const rejection = await rejectR3();
    expect(faults(rejection).sort()).toEqual([['sections.*.node_ids', 'slot_unplaced'], ['sections.1.node_ids.0', 'not_found']]);
    for (const stage of [1, 2, 3] as const) expect(renderProblem(rejection, stage)).not.toMatch(/\[placeholder\]|Cleaning/);
  });

  it('lists the unplaced slots as missing from feedback 1 and the result ids as allowed from feedback 2', async () => {
    expect(at(await problem(1), 'sections.*.node_ids')?.missing).toEqual(ids.slice(1));
    expect(at(await problem(2), 'sections.1.node_ids.0')?.allowed).toEqual(ids);
  });

  it('accepts a complete sections replacement correcting every listed fault (Approved08 D-099)', async () => {
    const shown = render(await rejectR3(true), 1);
    expect(shown.resend).toEqual(['sections']);
    expect(shown).not.toHaveProperty('resend_rule');
  });
});

/** A CT procedure hop whose supplier lies beyond the approved depth, rejected by the real registry. */
describe('renderProblem over a real submit_findings rejection: a supplier beyond the approved depth', () => {
  const id = (name: string) => `[ai].[${name}]`;
  const cols = (...names: string[]) => names.map(name => ({ name, type: 'int', nullable: 'NULL', extra: '' }));
  async function world() {
    const nodes = [
      makeNode({ id: id('report'), schema: 'ai', name: 'report', type: 'view', columns: cols('Discount'), bodyScript: 'SELECT Amount AS Discount FROM [ai].[staging]' }),
      makeNode({ id: id('staging'), schema: 'ai', name: 'staging', type: 'table', columns: cols('Amount', 'Region') }),
      makeNode({ id: id('loader'), schema: 'ai', name: 'loader', type: 'procedure', columns: [],
        bodyScript: 'CREATE PROCEDURE [ai].[loader] AS BEGIN INSERT INTO [ai].[staging] (Amount, Region) SELECT v.Amount, v.Region FROM [ai].[raw] v; END' }),
      makeNode({ id: id('raw'), schema: 'ai', name: 'raw', type: 'view', columns: cols('Amount', 'Region'), bodyScript: 'SELECT 1 AS Amount, 2 AS Region' }),
    ];
    const pairs: Array<[string, string]> = [[id('staging'), id('report')], [id('loader'), id('staging')], [id('raw'), id('loader')]];
    const model = makeIndexedModel(nodes, pairs);
    const graph = makeGraph(nodes, pairs);
    const session = new AiSession();
    session.model = model; session.graph = graph; session.setClassification('technical'); session.beginTurn();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.classification = 'technical';
    expect(engine.init({ origin: id('report'), question: 'Trace.', analysisMode: 'ct', targetColumns: ['Discount'], direction: 'upstream',
      depthIntent: { upstream: { levels: 2, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } } as never)).toMatchObject({ ok: true });
    engine.getHopContext();
    session.stateMachine = engine;
    session.enterExploring(session.turnEpoch);
    const noop = () => {};
    const registry = buildAiToolRegistry(() => session, { info: noop, debug: noop, warn: noop, error: noop } as never, () => undefined);
    const first = JSON.parse(String(await registry.invoke('lineage_submit_findings', { focus_node_id: id('report'), summary: 'Discount derives from staging.',
      sections: { technical: 'Reads staging.Amount.' }, column_flow: [{ out_col: 'Discount', upstream_columns: [{ node: id('staging'), col: 'Amount' }] }] })));
    expect(first).toMatchObject({ ok: true, next_focus: id('loader') });
    return registry;
  }
  const flow = (col: string) => ({ out_col: col, upstream_columns: [{ node: id('raw'), col }], writes_to: { node: id('staging'), col } });

  it('keeps same-table supplier choices and accepts a different-column correction (Approved08)', async () => {
    const registry = await world();
    const rejection = readToolErrorText(String(await registry.invoke('lineage_submit_findings', { focus_node_id: id('loader'), summary: 'Loads staging from raw.',
      sections: { technical: 'Copies raw into staging.' }, column_flow: [flow('Amount'), { ...flow('Region'), writes_to: { node: id('staging'), col: 'Amount' } }] })));
    if (!rejection) throw new Error('Expected a rejection');
    expect(rejection.errors.filter(error => error.path === 'column_flow.0.upstream_columns.0.node')).toEqual([
      { path: 'column_flow.0.upstream_columns.0.node', code: 'supplier_out_of_scope', values: [id('staging')] }]);
    // Object choices stay metadata-complete; the existing tracer checks identical column endpoints.
    expect(at(render(rejection, 1), 'column_flow.0.upstream_columns.0.node')).not.toHaveProperty('allowed');
    expect(at(render(rejection, 2), 'column_flow.0.upstream_columns.0.node')?.allowed).toEqual([id('staging')]);
    expect(render(rejection, 2).guidance.find(group => group.category === 'reference')?.fallback).toBeUndefined();
    expect(render(rejection, 3).guidance.find(group => group.category === 'reference')?.fallback).toBe(ISSUES.supplier_out_of_scope.fallback);
    // Region and Amount are distinct endpoints on the same table; metadata, not SQL inference, decides eligibility.
    expect(at(render(rejection, 2), 'column_flow.1.upstream_columns.0.node')?.allowed).toEqual([id('staging')]);
    const repaired = JSON.parse(String(await registry.invoke('lineage_submit_findings', { focus_node_id: id('loader'),
      column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: id('staging'), col: 'Region' }], writes_to: { node: id('staging'), col: 'Amount' } }] })));
    expect(repaired).toHaveProperty('ok', true);
  });
});
