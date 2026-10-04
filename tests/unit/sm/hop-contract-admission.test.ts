/** The active hop owns tool exposure, strict submission admission and operational prompt riders. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { compileInstructionPlan, explorationFacts } from '../../../src/ai/agent/instructionPlan';
import { executeToolAttempt, initialToolPhaseAttemptState, recordToolAttempt, MAX_TOOL_PROVIDER_CALLS } from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { ToolRegistry } from '../../../src/ai/tools/registry';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildActiveHopInstruction, buildActiveInstruction } from '../../../src/ai/agent/stagePrompts';
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';
import { getAllowedLmToolNames } from '../../../src/ai/tools/toolPolicy';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { parseAiOutputTemplatesYaml, REQUIRED_AI_TEMPLATE_KEYS } from '../../../src/configCore';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { stubToolServices } from './helpers/toolServices';

const parsedTemplates = parseAiOutputTemplatesYaml(readFileSync(new URL('../../../assets/aiOutputTemplates.yaml', import.meta.url), 'utf8'));
const templates = Object.fromEntries(REQUIRED_AI_TEMPLATE_KEYS.map(key => {
  const instruction = parsedTemplates[key]?.instruction;
  if (!instruction) throw new Error(`Missing shipped template instruction: ${key}`);
  return [key, instruction.trim()];
}));
const context = { dbPlatform: 'SQL Server', filterSchemas: [], totalSchemaCount: 1, visibleNodes: 2, totalNodes: 2 };
const origin = '[hop].[origin]', branch = '[hop].[branch]';
const userQuestion = 'Trace Value and explain how the branch affects rows.';
function world(mode: 'bb' | 'ct' = 'bb') {
  const nodes = [origin, branch].map(id => makeNode({ id, schema: 'hop', name: id, type: 'view', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }], bodyScript: id === origin ? `SELECT Value FROM ${branch};` : 'SELECT 1 AS Value;' }));
  const pairs: Array<[string, string]> = [[branch, origin]];
  const model = makeModel(nodes, pairs, ['hop']); const graph = makeGraph(nodes, pairs);
  const session = new AiSession(templates as never); session.model = model; session.graph = graph; session.setClassification('technical'); session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {}); engine.classification = 'technical';
  expect(engine.init({ origin, question: userQuestion, analysisMode: mode, ...(mode === 'ct' ? { targetColumns: ['Value'] } : {}), direction: 'upstream', depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  engine.getHopContext(); session.stateMachine = engine; session.memory.setUserQuestion(userQuestion); session.enterExploring(session.turnEpoch);
  const bind = () => stubToolServices({ session, model, graph }).services;
  const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Parameters<typeof buildAiToolRegistry>[1];
  const registry = buildAiToolRegistry(() => session, logger, () => undefined);
  return { engine, session, model, graph, bind, registry };
}
const finding = (focus = origin) => ({ focus_node_id: focus, verdict: 'analyze' as const, summary: 'Observed SQL.', sections: { technical: 'Observed SQL.' } });

describe('current-hop submission contract', () => {
  it.each([false, true])('states the required findings envelope and accepts a route repair with resent prose=%s', resendProse => {
    const w = world('ct');
    const column_flow = [{ out_col: 'Value', upstream_columns: [{ node: branch, col: 'Value' }] }];
    const rejected = JSON.parse(executeSubmitFindings({ ...finding(),
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: branch, col: 'Missing' }] }],
      questions: [{ nodeId: branch, question: 'Establish Value.' }] }, w.bind()));
    expect(rejected).toMatchObject({ code: 'contributor_col_not_on_source', issuePaths: ['column_flow.0.upstream_columns.0.col'] });
    expect(rejected.hint).toContain('always focus_node_id, verdict and every other required field');
    expect(rejected.hint).toContain('Omit summary');
    const missingEnvelope = JSON.parse(executeSubmitFindings({ questions: [{ nodeId: branch, question: 'Establish Value.' }] }, w.bind()));
    expect(missingEnvelope).toMatchObject({ code: 'invalid_input' });
    expect(missingEnvelope.issuePaths).toEqual(expect.arrayContaining(['focus_node_id', 'verdict', 'column_flow']));
    expect(JSON.parse(executeSubmitFindings({ focus_node_id: origin, verdict: 'analyze', column_flow,
      questions: [{ nodeId: branch, question: 'Establish Value.' }],
      ...(resendProse ? { summary: 'Observed SQL.', sections: { technical: 'Corrected SQL detail.' } } : {}) }, w.bind()))).toHaveProperty('ok', true);
    expect(w.engine.getDetailSlots()).toContainEqual(expect.objectContaining({ nodeId: origin, summary: 'Observed SQL.', sections: [{ angle: 'technical', text: resendProse ? 'Corrected SQL detail.' : 'Observed SQL.' }] }));
  });

  it('refuses caller context on a non-function at the advertised boundary before engine mutation', () => {
    const w = world('ct'); const submit = vi.spyOn(w.engine, 'submitFindings'); const before = w.engine.toJSON();
    const input = { ...finding(), column_flow: [{ out_col: 'Value', upstream_columns: [{ node: branch, col: 'Value' }] }],
      questions: [{ nodeId: branch, question: 'Establish Value.', caller_context: { node: origin, col: 'Value' } }] };
    expect(JSON.parse(executeSubmitFindings(input, w.bind()))).toMatchObject({ code: 'invalid_input', issuePaths: ['questions.0.caller_context'] });
    expect(submit).not.toHaveBeenCalled();
    expect(w.engine.toJSON()).toEqual(before);
  });

  it('uses one held-draft repair directive after a schema rejection and keeps the accepted patch', () => {
    const w = world('ct');
    const input = { ...finding(), column_flow: [{ out_col: 'Wrong', upstream_columns: [] }] };
    const rejected = JSON.parse(executeSubmitFindings(input, w.bind()));
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: ['column_flow.0.out_col'] });
    expect(rejected.hint).toContain('Held:');
    expect(rejected.hint).toContain('resend only the entries you add or change');
    expect(rejected.hint).not.toContain('repeating the unflagged elements exactly as first sent');
    const repaired = { focus_node_id: origin, verdict: 'analyze', column_flow: [{ out_col: 'Value', upstream_columns: [] }] };
    expect(JSON.parse(executeSubmitFindings(repaired, w.bind()))).toHaveProperty('ok', true);
    expect(w.engine.getDetailSlots()).toContainEqual(expect.objectContaining({ nodeId: origin, summary: 'Observed SQL.', sections: [{ angle: 'technical', text: 'Observed SQL.' }] }));
  });

  it('serves and authorizes only BB tools on BB work', async () => {
    const w = world(); const before = w.engine.toJSON();
    expect([...getAllowedLmToolNames({ kind: 'active', mode: 'sm_bb' })]).toEqual(['lineage_submit_findings']);
    expect(JSON.parse(await w.registry.invoke('lineage_get_neighbor_columns', { ids: [branch] }))).toMatchObject({ code: 'off_policy' });
    expect(w.engine.toJSON()).toEqual(before);
    expect(getAllowedLmToolNames({ kind: 'active', mode: 'sm_ct' }).has('lineage_get_neighbor_columns')).toBe(true);
  });

  it('extends BB questions with caller binding only on CT', () => {
    const input = { ...finding(), questions: [{ nodeId: branch, question: 'Investigate the row effect.', caller_context: { node: origin, col: 'Value' } }] };
    expect(submitFindingsSchemaForMode('bb', 'technical', true).safeParse(input).success).toBe(false);
    expect(submitFindingsSchemaForMode('ct', 'technical', true).safeParse({ ...input, column_flow: [] }).success).toBe(true);
  });

  it.each([
    { column_flow: [] },
    { unknown: 'must not disappear' },
    { verdict: 'invalid' },
    { sections: { technical: 42 } },
    { questions: [{ nodeId: branch, question: 'Check.', caller_context: { node: origin, col: 'Value' } }] },
  ])('rejects raw malformed BB input before engine admission: %j', async patch => {
    const w = world(); const submit = vi.spyOn(w.engine, 'submitFindings'); const before = w.engine.toJSON();
    const input = { ...finding(), ...patch }; const raw = structuredClone(input);
    expect(JSON.parse(await w.registry.invoke('lineage_submit_findings', input))).toMatchObject({ code: 'invalid_input' });
    expect(submit).not.toHaveBeenCalled(); expect(input).toEqual(raw);
    expect(w.engine.columnAspect).toEqual(before.columnAspect); expect(w.engine.currentFocus).toBe(origin);
    expect(w.engine.getCurrentTasks().every(task => task.status === 'active')).toBe(true);
  });

  it.each([
    { unexpected: true },
    { writes_to: { node: branch, col: 'Value', unexpected: true } },
    { upstream_columns: [{ node: branch, col: 'Value', unexpected: true }] },
  ])('refuses unknown nested column fields rather than stripping them: %j', patch => {
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, { outCols: ['Value'], writesTo: true });
    const input = { ...finding(), column_flow: [{ out_col: 'Value', writes_to: null, upstream_columns: [], ...patch }] };
    expect(schema.safeParse(input).success).toBe(false);
  });

  it.each([undefined, []])('suppresses CT-only continuations at the exported BB renderer boundary: %j', columns => {
    const tasks = [{ kind: 'root' as const, question: userQuestion }];
    const bb = buildCurrentTaskBlock(tasks, columns, ['Trace stale Value.']);
    expect(bb).toContain(userQuestion); expect(bb).not.toContain('<lineage_questions>'); expect(bb).not.toContain('<column_trace>');
    const ct = buildCurrentTaskBlock(tasks, ['Value'], ['Trace Value.']);
    expect(ct).toContain('<lineage_questions>'); expect(ct).toContain('<column_trace>'); expect(ct).toContain('Trace Value.');
  });

  it('projects restored BB instructions without stale lineage riders while preserving the original question', () => {
    const w = world('ct');
    expect(JSON.parse(executeSubmitFindings({ ...finding(), column_flow: [] }, w.bind()))).toHaveProperty('ok', true);
    expect(w.engine.peekHopContext()).toMatchObject({ analysis_mode: 'bb', focus_node: { id: branch } });
    const snapshot = w.engine.toJSON(); snapshot.lineageQuestionsLastHop = ['Trace stale Value at this branch'];
    const restored = NavigationEngine.fromJSON(snapshot, w.model, w.graph, () => {}, {}); w.session.stateMachine = restored;
    const system = buildActiveInstruction(w.session, context, restored.currentHopAnalysisMode);
    const message = buildActiveHopInstruction(w.session, restored, branch);
    expect(system.system).toContain(userQuestion);
    expect(message.message).not.toContain('<lineage_questions>'); expect(message.message).not.toContain('<column_trace>');
    expect(system.system).not.toContain('column_flow');
  });
});


function nativePort(parts: () => Array<vscode.LanguageModelToolCallPart | vscode.LanguageModelTextPart>) {
  const sendRequest = vi.fn(async () => ({ stream: { async *[Symbol.asyncIterator]() { yield* parts(); } } }));
  const port = new VscodeModelPort({ id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1', maxInputTokens: 128000, countTokens: async () => 1, sendRequest } as never);
  return { port, sendRequest };
}
function activePlan(w: ReturnType<typeof world>, registry = w.registry, signal?: AbortSignal) {
  const mode = w.engine.currentHopAnalysisMode;
  return compileInstructionPlan({ kind: 'converse', stage: { kind: 'active', mode: mode === 'ct' ? 'sm_ct' : 'sm_bb' },
    registry, messages: [new HumanMessage(userQuestion)], sink: new TurnEventSink(() => {}), signal,
    facts: explorationFacts(mode, ['Value'], { classification: 'technical' }),
    freshSubmission: () => w.engine.heldFindingFocus === null && w.session.memory.getArchivedAngles(w.engine.currentFocus!).size === 0,
    hopColumns: () => w.engine.hopSubmitColumns, requiredTerminalTool: 'lineage_submit_findings', toolChoice: 'required',
    isPhaseComplete: () => w.engine.currentFocus !== origin,
  });
}

describe('native receiving-boundary execution and finite retries', () => {
  it('discloses verified object columns only on the final budgeted identity rejection', async () => {
    const w = world('ct');
    const input = { ...finding(), column_flow: [{ out_col: 'Value', upstream_columns: [{ node: branch, col: 'Missing' }] }] };
    const model = nativePort(() => [new vscode.LanguageModelToolCallPart('identity', 'lineage_submit_findings', input)]);
    const plan = activePlan(w);
    let state = initialToolPhaseAttemptState('active');
    const contents: string[] = [];
    for (let index = 0; index < MAX_TOOL_PROVIDER_CALLS; index++) {
      const attempt = await executeToolAttempt(model.port, plan, { priorState: state });
      const message = attempt.messages.find(item => item instanceof ToolMessage) as ToolMessage;
      contents.push(String(message.content));
      expect(message.artifact).toMatchObject({ detail: [{ actual_columns: ['Value'] }] });
      state = recordToolAttempt(state, attempt);
    }
    expect(contents[0]).toBe(contents[1]);
    expect(contents[0]).not.toContain('Actual columns');
    expect(contents[2]).toContain('Actual columns of [hop].[branch]: Value.');
    expect(contents[2]).not.toContain('follow-up');
    expect(JSON.stringify(model.sendRequest.mock.calls[1])).not.toContain('actual_columns');
    expect(state.stopReason).toBe('no_progress');
    expect(model.sendRequest).toHaveBeenCalledTimes(MAX_TOOL_PROVIDER_CALLS);
    expect(w.engine.currentFocus).toBe(origin);
  });



  it('discloses verified names on the final overall budget even when mixed faults use a generic code', async () => {
    const w = world('ct');
    const input = { ...finding(), column_flow: [{ out_col: 'Value', upstream_columns: [{ node: branch, col: 'Missing' }] }] };
    const invoke = vi.spyOn(w.registry, 'invoke').mockResolvedValue(JSON.stringify({
      code: 'route_validation_failed', reason: 'An absent contributor column and a separate route fault.',
      detail: [{ id: branch, actual_columns: ['Value'] }, { id: origin, available_routes: [branch] }],
    }));
    const model = nativePort(() => [new vscode.LanguageModelToolCallPart('mixed', 'lineage_submit_findings', input)]);
    const state = { ...initialToolPhaseAttemptState('active'), noProgressCalls: MAX_TOOL_PROVIDER_CALLS - 1 };
    const attempt = await executeToolAttempt(model.port, activePlan(w), { priorState: state });
    const message = attempt.messages.find(item => item instanceof ToolMessage) as ToolMessage;
    expect(String(message.content)).toContain('Actual columns of [hop].[branch]: Value.');
    expect(recordToolAttempt(state, attempt).stopReason).toBe('no_progress');
    expect(model.sendRequest).toHaveBeenCalledTimes(1);
    invoke.mockRestore();
  });

  it('withholds unverified available sets even on the final rejection', async () => {
    const w = world('ct');
    const input = { ...finding(), column_flow: [{ out_col: 'Value', upstream_columns: [{ node: branch, col: 'Missing' }] }] };
    const invoke = vi.spyOn(w.registry, 'invoke').mockResolvedValue(JSON.stringify({
      code: 'contributor_col_not_on_source', reason: 'Exact identity cannot be verified.',
      hint: 'Recheck SQL identity.', detail: [{ id: branch, available_columns: ['TrackedSubset', 'ProcedureInput'] }],
    }));
    const model = nativePort(() => [new vscode.LanguageModelToolCallPart('unverified', 'lineage_submit_findings', input)]);
    const state = { ...initialToolPhaseAttemptState('active'), noProgressCalls: MAX_TOOL_PROVIDER_CALLS - 1 };
    const attempt = await executeToolAttempt(model.port, activePlan(w), { priorState: state });
    const message = attempt.messages.find(item => item instanceof ToolMessage) as ToolMessage;
    expect(String(message.content)).not.toContain('TrackedSubset');
    expect(String(message.content)).not.toContain('ProcedureInput');
    expect(String(message.content)).not.toContain('Actual columns');
    invoke.mockRestore();
  });

  it('parses raw BB input once at dispatch, pairs a rejection, then accepts the correction once', async () => {
    const w = world(); const before = w.engine.toJSON(); const submit = vi.spyOn(w.engine, 'submitFindings');
    const schema = submitFindingsSchemaForMode('bb', 'technical', true, w.engine.hopSubmitColumns);
    const parse = vi.spyOn(schema, 'safeParse');
    let input: object = { ...finding(), column_flow: [] }; let call = 'invalid-bb';
    const model = nativePort(() => [new vscode.LanguageModelToolCallPart(call, 'lineage_submit_findings', input)]);
    const plan = activePlan(w);
    const rejected = await executeToolAttempt(model.port, plan);
    expect(parse).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled();
    expect(w.engine.toJSON()).toEqual(before);
    const error = rejected.messages.find(message => message instanceof ToolMessage) as ToolMessage;
    expect(error).toMatchObject({ tool_call_id: 'invalid-bb', status: 'error', artifact: { code: 'invalid_input' } });
    input = finding(); call = 'corrected-bb';
    const accepted = await executeToolAttempt(model.port, plan, { priorState: recordToolAttempt(initialToolPhaseAttemptState('active'), rejected) });
    expect(parse).toHaveBeenCalledTimes(2); expect(submit).toHaveBeenCalledTimes(1);
    expect(accepted.stop).toBe('phase_complete');
    expect(accepted.messages.find(message => message instanceof ToolMessage)).toMatchObject({ tool_call_id: 'corrected-bb', status: 'success' });
    expect(model.sendRequest).toHaveBeenCalledTimes(2);
    parse.mockRestore();
  });

  it.each(['text-only', 'empty'] as const)('stops %s replies at the existing limit while tasks remain undispositioned', async kind => {
    const w = world(); const before = w.engine.toJSON(); const submit = vi.spyOn(w.engine, 'submitFindings');
    const model = nativePort(() => kind === 'text-only' ? [new vscode.LanguageModelTextPart('I am done.')] : []);
    let state = initialToolPhaseAttemptState('active');
    for (let i = 0; i < MAX_TOOL_PROVIDER_CALLS; i++) {
      const attempt = await executeToolAttempt(model.port, activePlan(w), { priorState: state });
      expect(attempt.stop).toBe('continue'); expect(attempt.observations).toEqual([]);
      state = recordToolAttempt(state, attempt);
    }
    expect(MAX_TOOL_PROVIDER_CALLS).toBe(3); expect(state.stopReason).toBe('no_progress');
    expect(model.sendRequest).toHaveBeenCalledTimes(3); expect(submit).not.toHaveBeenCalled();
    expect(w.engine.toJSON()).toEqual(before); expect(w.engine.getCurrentTasks().every(task => task.status === 'active')).toBe(true);
  });

  it('refuses a required submit tool absent from the offered registry before provider generation', () => {
    const w = world(); expect(() => activePlan(w, new ToolRegistry<string>())).toThrow();
    expect(w.engine.currentFocus).toBe(origin);
  });

  it('requires explicit CT flow and never accepts a missing field as terminal empty flow', async () => {
    const w = world('ct'); const before = w.engine.columnAspect; const submit = vi.spyOn(w.engine, 'submitFindings');
    const model = nativePort(() => [new vscode.LanguageModelToolCallPart('missing-flow', 'lineage_submit_findings', finding())]);
    const attempt = await executeToolAttempt(model.port, activePlan(w));
    expect(attempt.rejections).toContainEqual(expect.objectContaining({ code: 'invalid_input', issuePaths: expect.arrayContaining(['column_flow']) }));
    expect(submit).not.toHaveBeenCalled(); expect(w.engine.columnAspect).toEqual(before);
    expect(w.engine.currentFocus).toBe(origin); expect(w.engine.getCurrentTasks().every(task => task.status === 'active')).toBe(true);
    const hint = attempt.rejections[0]!.hint ?? '';
    expect(hint).not.toMatch(/omit[^.]*column_flow/);
  });

  it('does not count equivalent repeated CT reads as progress', async () => {
    const w = world('ct'); w.model.neighborIndex = { [origin]: { in: [branch], out: [] }, [branch]: { in: [], out: [origin] } };
    const before = w.engine.toJSON(); const invoke = vi.spyOn(w.registry, 'invoke'); let sequence = 0;
    const model = nativePort(() => [new vscode.LanguageModelToolCallPart(`read-${++sequence}`, 'lineage_get_neighbor_columns', { ids: [branch] })]);
    let state = initialToolPhaseAttemptState('active');
    for (let i = 0; i <= MAX_TOOL_PROVIDER_CALLS; i++) {
      const attempt = await executeToolAttempt(model.port, activePlan(w), { priorState: state });
      if (i === 0) expect(attempt.observations).toHaveLength(1);
      else { expect(attempt.observations).toEqual([]); expect(attempt.rejections).toContainEqual(expect.objectContaining({ code: 'duplicate_read' })); }
      state = recordToolAttempt(state, attempt);
    }
    expect(state.stopReason).toBe('no_progress'); expect(state.observations).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1); expect(w.engine.toJSON()).toEqual(before);
  });

  it('admits malformed presentation only at the handler and pairs a held repair with its own call', async () => {
    const w = world(); w.session.resultGraph = { nodeIds: [origin, branch], edges: [[branch, origin, 'read']], source: 'blackboard', originNodeId: origin };
    w.session.enterCompleted(w.session.turnEpoch); const before = structuredClone(w.session.resultGraph);
    let input: object = { name: 'Report', summary: 42, sections: [{ label: 'Sources', node_ids: [origin, branch], text: 'Branch supplies the report.' }], highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }] };
    let call = 'invalid-presentation';
    const model = nativePort(() => [new vscode.LanguageModelToolCallPart(call, 'lineage_present_result', input)]);
    const plan = compileInstructionPlan({ kind: 'converse', stage: { kind: 'completed' }, registry: w.registry,
      messages: [new HumanMessage('Show the result')], sink: new TurnEventSink(() => {}),
      presentResultRepairFields: () => w.session.presentResultRepairFields,
      presentResultRepairHighlightLabelIndexes: () => w.session.presentResultRepairHighlightLabelIndexes,
      presentResultRepairSectionTextLeaves: () => w.session.presentResultRepairSectionTextLeaves,
      presentResultRetainableSections: () => w.session.retainableReportSections() !== null,
      requiredTerminalTool: 'lineage_present_result', toolChoice: 'required', isPhaseComplete: () => w.session.presentationArtifact !== null,
    });
    const rejected = await executeToolAttempt(model.port, plan);
    expect(rejected.messages.find(message => message instanceof ToolMessage)).toMatchObject({ tool_call_id: call, status: 'error', artifact: { code: 'invalid_input' } });
    expect(w.session.resultGraph).toEqual(before); expect(w.session.presentationArtifact).toBeNull();
    expect(w.session.presentResultRepairDraft.get()?.name).toBe('Report');
    input = { summary: 'Branch supplies the report.' }; call = 'corrected-presentation';
    const accepted = await executeToolAttempt(model.port, plan, { priorState: recordToolAttempt(initialToolPhaseAttemptState('completed'), rejected) });
    expect(accepted.stop).toBe('phase_complete');
    expect(accepted.messages.find(message => message instanceof ToolMessage)).toMatchObject({ tool_call_id: call, status: 'success' });
    expect(w.session.presentationArtifact?.name).toBe('Report');
  });

  it('does not dispatch or mutate a cancelled native generation', async () => {
    const w = world(); const before = w.engine.toJSON(); const controller = new AbortController(); controller.abort();
    const model = nativePort(() => [new vscode.LanguageModelToolCallPart('cancelled', 'lineage_submit_findings', finding())]);
    expect((await executeToolAttempt(model.port, activePlan(w, w.registry, controller.signal))).stop).toBe('cancelled');
    expect(w.engine.toJSON()).toEqual(before); expect(model.sendRequest).not.toHaveBeenCalled();
  });
});
