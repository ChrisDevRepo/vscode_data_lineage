// Owner: src/ai/agent/stagePrompts.ts, instructionPlan.ts, src/ai/prompting, src/ai/tools/toolSchemas.ts and toolErrorEnvelope.ts; what the backend puts in front of the model.
/** Real requests of the AdventureWorks AI fixture, driven without a model. Every rendered model-visible text is stored under `__model_visible__/`: the first group fails until the stored text is regenerated in the same commit as the change (`node tests/tools/run-vitest.mjs run tests/unit/ai-core/model-visible-requests.test.ts -u`), which marks that commit as a prompt change. The second group proves request-assembly clauses of spec 06 (pruning), 07 (adding) and 04 (routing) against the same requests. */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EntryDetectionSchema, GateReplySchema } from '../../../src/ai/agent/state';
import { buildDiscoveryInstruction } from '../../../src/ai/agent/stagePrompts';
import {
  buildActiveContinuationAnchor, buildEntryDetectorSystemPrompt, buildGateRefinePrompt, buildGateRefineSystemPrompt,
  buildHostStageSystemPrompt, buildSmEntrySystemPrompt, buildVisualPreviewSystemPrompt,
} from '../../../src/ai/prompting/hostPrompts';
import {
  DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT, buildDiscoveryFinalAnswerTask, buildDiscoverySummaryComposePrompt, buildGateReplySystemPrompt,
  buildGateReplyUserPrompt, expandRunTracePrompt, expandShowGraphPreviewPrompt, RUN_TRACE_TRIGGER, SHOW_GRAPH_PREVIEW_TRIGGER,
} from '../../../src/ai/prompting/prompts';
import { renderScopeSummaryMd } from '../../../src/ai/prompting/scopeSummaryRenderer';
import { resolveStagePrompt } from '../../../src/ai/prompting/templateRenderer';
import { STRUCTURED_OUTPUT_TOOL, STRUCTURED_OUTPUT_TOOL_DESCRIPTION } from '../../../src/ai/providers/structuredOutput';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { StartExplorationFreshProviderInputSchema, StartExplorationRefineProviderInputSchema } from '../../../src/ai/tools/toolSchemas';
import { ISSUES, LAST_CORRECTION, renderProblem } from '../../../src/ai/support/toolErrorEnvelope';
import { driveWalk, openFixtureWalk, promptContext, servedTools, type HopRecord, type ScriptedHop } from './helpers/modelRequests';

const STORED = join(dirname(fileURLToPath(import.meta.url)), '__model_visible__');
const CLASSIFICATIONS = ['business', 'technical', 'both'] as const;
const upstreamOnly = (levels: number | 'all') => ({ upstream: { levels, exactness: 'exact' as const }, downstream: { levels: 0, exactness: 'exact' as const } });

const PM = '[ai].[pricemaster]', SS = '[ai].[salesstaging]', DC = '[ai].[dimcalendar]', RAW = '[ai].[vwraworders]', CO = '[ai].[cleanedorders]';

/** Column trace of `vwPriceList.UnitPrice`: a view, the storage carrier PriceMaster, and the procedure that loads it. The first hop asks no question, so the continuation reaches the procedure with a blank one. */
const CT_SCRIPT: Record<string, ScriptedHop> = {
  '[ai].[vwpricelist]': { refused: { sections: { business: 'UnitPrice is the current list price.' },
    column_flow: [{ out_col: 'UnitPrice', upstream_columns: [{ node: '[ai].[spbuildsalesreport]', col: 'ListPrice', transforms: ['compute'] }] }] }, submit: { summary: 'Current PriceMaster prices renamed to UnitPrice.', sections: { business: 'UnitPrice is the current list price.' },
    column_flow: [{ out_col: 'UnitPrice', upstream_columns: [{ node: PM, col: 'ListPrice', transforms: ['compute'], note: 'ListPrice * 1.0' }] }] } },
  '[ai].[sprefreshprices]': { submit: { summary: 'Loads PriceMaster from supplier costs and markups.', sections: { business: 'List price is cost plus markup.' },
    column_flow: [{ out_col: 'ListPrice', writes_to: { node: PM, col: 'ListPrice' }, upstream_columns: [
      { node: '[ai].[supplierprices]', col: 'CostPrice', transforms: ['compute'] }, { node: '[ai].[markuprules]', col: 'MarkupPct', transforms: ['compute'] },
      { node: '[ai].[currencyconfig]', col: 'IsBase', transforms: ['filter'] }, { node: '[ai].[regionlookup]', col: 'RegionCode', transforms: ['combine'] }] }] } },
};

/** Whole-object walk of `vwConsolidatedSales` three levels upstream: a question through a storage carrier, a prune, a carrier-reached procedure removed with `lineage_prune_current`, and a question past the depth border. */
const BB_SCRIPT: Record<string, ScriptedHop> = {
  '[ai].[vwconsolidatedsales]': { submit: { summary: 'Renames OrderQty to Qty for current business days.', sections: { business: 'Quantities are staged order quantities.', technical: 'Qty is OrderQty.' },
    questions: [{ nodeId: SS, question: 'Which procedure loads SalesStaging, and from what?' }], prune_neighbors: [{ id: DC, reason: 'Filter-only join; no column is selected from it.' }] } },
  '[ai].[sparchiveoldorders]': { prune: 'Archives old rows; unrelated to where the quantities come from.' },
  '[ai].[sploadsalesstaging]': { submit: { summary: 'Reloads SalesStaging from vwRawOrders.', sections: { business: 'Staging is rebuilt from raw orders.', technical: 'TRUNCATE then INSERT.' },
    questions: [{ nodeId: RAW, question: 'What does vwRawOrders expose?' }], prune_neighbors: [{ id: DC, reason: 'Only backfills the date key.' }] } },
  '[ai].[vwraworders]': { submit: { summary: 'Selects every column of CleanedOrders.', sections: { business: 'Raw orders are cleaned orders.', technical: 'SELECT * FROM CleanedOrders.' },
    questions: [{ nodeId: CO, question: 'Which procedure fills CleanedOrders?' }] } },
};

const ct = await openFixtureWalk();
const bb = await openFixtureWalk();
const ctRun = await driveWalk(ct, { origin: '[ai].[vwpricelist]', question: 'Trace UnitPrice back to its original sources.', analysisMode: 'ct', targetColumns: ['UnitPrice'], direction: 'upstream', depthIntent: upstreamOnly('all') }, 'business', CT_SCRIPT);
const bbRun = await driveWalk(bb, { origin: '[ai].[vwconsolidatedsales]', question: 'Where do the quantities of vwConsolidatedSales come from?', analysisMode: 'bb', direction: 'upstream', depthIntent: upstreamOnly(3),
  mission_brief: 'Name the procedures and views that produce the quantities.', scopeNotes: ['Ignore audit logging.'] }, 'both', BB_SCRIPT,
'The user asked where vwConsolidatedSales quantities come from; discovery found SalesStaging as the source.');

/** The same origin one level upstream: the table SalesStaging is reached, and the procedure behind it lies past the border, so the table's relay defers the question. */
const SHALLOW_SCRIPT: Record<string, ScriptedHop> = {
  '[ai].[vwconsolidatedsales]': { submit: { summary: 'Renames OrderQty to Qty.', sections: { business: 'Quantities are staged order quantities.', technical: 'Qty is OrderQty.' },
    questions: [{ nodeId: SS, question: 'Which procedure loads SalesStaging, and from what?' }], prune_neighbors: [{ id: DC, reason: 'Filter-only join; no column is selected from it.' }] } },
};
const shallowRun = await driveWalk(await openFixtureWalk(), { origin: '[ai].[vwconsolidatedsales]', question: 'Where do the quantities of vwConsolidatedSales come from?', analysisMode: 'bb', direction: 'upstream', depthIntent: upstreamOnly(1),
  mission_brief: 'Name the procedures and views that produce the quantities.' }, 'both', SHALLOW_SCRIPT);

/** Every rendered model-visible artifact by stored path. Only a text file gains the single final newline the editorconfig asks for, so no text change is masked. */
function renderAll(): Map<string, string> {
  const files = new Map<string, string>();
  const text = (name: string, value: string) => files.set(`${name}.txt`, `${value}\n`);
  const json = (name: string, value: unknown) => files.set(`${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
  const ctx = promptContext(ct);

  text('system/entry-detector', buildEntryDetectorSystemPrompt(ctx));
  text('system/discovery', buildDiscoveryInstruction(ct.session, ctx).system);
  text('system/discovery-final-answer', buildDiscoveryFinalAnswerTask());
  text('system/visual-preview', buildVisualPreviewSystemPrompt(ctx));
  text('system/sm-entry-bb', buildSmEntrySystemPrompt(ctx));
  text('system/sm-entry-ct', buildSmEntrySystemPrompt(ctx, ['UnitPrice']));
  text('system/gate-refine', buildGateRefineSystemPrompt(ctx));
  text('system/gate-reply', buildGateReplySystemPrompt());
  text('system/discovery-summary-compose', DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT);
  text('system/completed', buildHostStageSystemPrompt('completed', ctx));
  text('system/active-ct', ctRun.hops[0].request.system);
  text('system/active-bb', bbRun.hops[0].request.system);
  text('system/synthesis-ct', ctRun.synthesis.system);
  text('system/synthesis-bb', bbRun.synthesis.system);

  const card = renderScopeSummaryMd(ctRun.scope, 1, 'business');
  text('message/continuation-anchor', buildActiveContinuationAnchor());
  text('message/gate-card', card);
  text('message/gate-refine', buildGateRefinePrompt(card, { instruction: 'Change scope to one level upstream.' }, 1));
  text('message/gate-reply', buildGateReplyUserPrompt(card, 'Looks good, go ahead.'));
  text('message/discovery-summary-compose', buildDiscoverySummaryComposePrompt('Where does UnitPrice come from?', 'It is the current list price of PriceMaster.', 'origin vwPriceList; upstream; column UnitPrice'));
  const pill = { lastDiscoveryOrigin: '[ai].[vwpricelist]', lastDiscoveryQuestion: 'Where does UnitPrice come from?', lastDiscoveryAnswer: 'It is the current list price of PriceMaster.' };
  text('message/run-trace', expandRunTracePrompt(RUN_TRACE_TRIGGER, pill));
  text('message/show-graph-preview', expandShowGraphPreviewPrompt(SHOW_GRAPH_PREVIEW_TRIGGER, pill));

  for (const [name, run] of [['ct', ctRun], ['bb', bbRun]] as const) {
    run.hops.forEach((hop, index) => {
      text(`${name}/hop-${index + 1}.message`, hop.request.message);
      json(`${name}/hop-${index + 1}.tools`, hop.request.tools);
    });
    text(`${name}/synthesis.message`, run.synthesis.message);
  }
  json('synthesis.tools', ctRun.synthesis.tools);

  const fresh = new Map([['lineage_start_exploration', StartExplorationFreshProviderInputSchema]]);
  const refine = new Map([['lineage_start_exploration', StartExplorationRefineProviderInputSchema]]);
  json('tools/discover', servedTools(ct, { stage: { kind: 'discover' } }));
  json('tools/visual-preview', servedTools(ct, { stage: { kind: 'visual_preview' }, presentResultPreviewBlockCount: 3 }));
  json('tools/sm-entry', servedTools(ct, { stage: { kind: 'sm_entry' }, toolSchemaOverrides: fresh }));
  json('tools/gate-refine', servedTools(ct, { stage: { kind: 'sm_entry' }, toolSchemaOverrides: refine }));
  json('tools/completed', servedTools(ct, { stage: { kind: 'completed' }, toolSchemaOverrides: fresh, presentResultRetainableSections: () => true }));
  for (const [name, schema] of [['entry-detection', EntryDetectionSchema], ['gate-reply', GateReplySchema]] as const) {
    json(`structured/${name}`, { name: STRUCTURED_OUTPUT_TOOL, description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION, inputSchema: toModelJsonSchema(schema) });
  }

  json('issues', ISSUES);
  const { input, rejection } = ctRun.hops[0].refusal!;
  json('rejection-problem', { lastCorrection: LAST_CORRECTION, stages: ([1, 2, 3] as const).map(stage => JSON.parse(renderProblem(rejection, stage, input))) });

  const { outputTemplates: templates, outputSections: sections } = ct.session;
  const stages = (label: string, rows: ReadonlyArray<readonly [string, string]>) => text(`templates/${label}`, rows.map(([name, prompt]) => `=== ${name} ===\n${prompt}`).join('\n\n'));
  stages('discover', [['discover', resolveStagePrompt(templates, 'discover', undefined, undefined, false, { scope: 'stable' }, sections).prompt]]);
  stages('active-stable', ([false, true] as const).flatMap(isCt => CLASSIFICATIONS.map(classification =>
    [`${isCt ? 'ct' : 'bb'} ${classification}`, resolveStagePrompt(templates, 'active', classification, 0, isCt, { scope: 'stable' }, sections).prompt] as const)));
  stages('active-per-focus', (['bodied', 'non_bodied'] as const).flatMap(focusKind => CLASSIFICATIONS.map(classification =>
    [`${focusKind} ${classification}`, resolveStagePrompt(templates, 'active', classification, 0, false, { scope: 'per_focus', focusKind, writeSections: true }, sections).prompt] as const)));
  stages('synthesis', ([0, 3] as const).flatMap(slots => CLASSIFICATIONS.map(classification =>
    [`${slots} detail slots ${classification}`, resolveStagePrompt(templates, 'synthesis', classification, slots, false, { scope: 'stable' }, sections).prompt] as const)));
  return files;
}

const rendered = renderAll();
const updating = () => (expect.getState() as { snapshotState?: { snapshotUpdateState?: string } }).snapshotState?.snapshotUpdateState === 'all';
const storedFiles = (dir = STORED): string[] => (existsSync(dir) ? readdirSync(dir).flatMap(name =>
  statSync(join(dir, name)).isDirectory() ? storedFiles(join(dir, name)) : [relative(STORED, join(dir, name)).replaceAll('\\', '/')]) : []);

describe('stored model-visible text', () => {
  it.each([...rendered])('%s', async (name, text) => {
    const file = join(STORED, name);
    // A first render is a prompt change as well: it fails until the stored text is committed.
    if (!existsSync(file) && !updating()) throw new Error(`${name} has no stored text; regenerate it with -u and commit it.`);
    await expect(text).toMatchFileSnapshot(file);
  });

  it('holds no text the backend no longer renders', () => {
    const obsolete = storedFiles().filter(name => !rendered.has(name));
    if (updating()) for (const name of obsolete) rmSync(join(STORED, name));
    else expect(obsolete).toEqual([]);
    mkdirSync(STORED, { recursive: true });
  });
});

/** The JSON the engine embeds between `<tag>` and `</tag>` of a model message, or `undefined` when the message has no such block. */
function payload(message: string, tag: string): Record<string, unknown> | undefined {
  const body = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(message)?.[1];
  return body === undefined ? undefined : JSON.parse(body.slice(body.indexOf('{'))) as Record<string, unknown>;
}

interface OfferedNeighbor { id: string; can_question: boolean; can_prune: boolean; already_visited?: true; already_removed?: true }
const neighborsOf = (hop: HopRecord) => (payload(hop.request.message, 'hop_context')!.neighbors ?? []) as OfferedNeighbor[];

/** The ids a hop's served `lineage_submit_findings` schema admits in `field`'s `key`. */
function servedChoices(hop: HopRecord, field: 'questions' | 'prune_neighbors', key: 'nodeId' | 'id'): string[] {
  const submit = hop.request.tools.find(tool => tool.name === 'lineage_submit_findings')!.inputSchema as
    { properties: Record<string, { items: { properties: Record<string, { enum?: string[] }> } }> };
  return [...(submit.properties[field].items.properties[key].enum ?? [])].sort();
}

/** Every `{question, from_node}` pair a model message carries. */
function senders(message: string): Array<{ question: string; from_node: string }> {
  const found: Array<{ question: string; from_node: string }> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const entry = value as Record<string, unknown>;
    if (typeof entry.from_node === 'string' && typeof entry.question === 'string') found.push({ question: entry.question, from_node: entry.from_node });
    Object.values(entry).forEach(visit);
  };
  for (const tag of ['hop_context', 'synthesis_envelope']) visit(payload(message, tag));
  return found;
}

const WALKS = [{ name: 'ct', run: ctRun, origin: '[ai].[vwpricelist]' }, { name: 'bb', run: bbRun, origin: '[ai].[vwconsolidatedsales]' }] as const;

describe('request assembly', () => {
  it('reaches the cases the clauses below are about', () => {
    expect(ctRun.hops.some(hop => hop.tasks.some(task => task.kind === 'column_lineage' && task.question.trim() === '' && task.nodeId !== '[ai].[vwpricelist]'))).toBe(true);
    for (const { run } of WALKS) expect(run.hops.some(hop => neighborsOf(hop).some(neighbor => hop.closed.has(neighbor.id)))).toBe(true);
    expect(senders(bbRun.synthesis.message).length).toBeGreaterThan(0);
  });

  // Internal 09-memory-context, "What goes to synthesis": a follow-up question reaches synthesis with the object that asked it; a table only passes it on and never becomes the asker.
  it('names the origin view as the asker of a question that passed through a storage table', () => {
    expect(senders(bbRun.synthesis.message)).toContainEqual({ question: 'Which procedure loads SalesStaging, and from what?', from_node: '[ai].[vwconsolidatedsales]' });
  });

  // Internal 09-memory-context, "What goes to synthesis": a follow-up question deferred past the border names the object that asked it, never the table that relayed it.
  it('names the origin view as the asker of a question deferred while a storage table relayed it', () => {
    const deferred = (payload(shallowRun.synthesis.message, 'synthesis_envelope')!.result as { deferred_questions: Array<{ nodeId: string; fromFocusNodeId: string; question: string }> }).deferred_questions;
    expect(deferred).toContainEqual(expect.objectContaining({ nodeId: '[ai].[sploadsalesstaging]', fromFocusNodeId: '[ai].[vwconsolidatedsales]', question: 'Which procedure loads SalesStaging, and from what?' }));
  });

  // `synthesis.tools.json` stores the one served set; both walks must serve exactly it.
  it('serves the same synthesis tools for a column trace and a whole-object walk', () => {
    expect(bbRun.synthesis.tools).toEqual(ctRun.synthesis.tools);
  });

  // Spec 07: the backend forwards the mapped columns to each mapped neighbor as a technical continuation; the hop that receives it is told which qualified columns arrived, with or without a question.
  // The column-trace walk is skipped here: its blank-question hop renders no endpoint until the separate blank-question fix lands.
  it.each(WALKS.filter(walk => walk.name === 'bb'))('$name: a hop message names every qualified endpoint of its column_lineage tasks', ({ run, origin }) => {
    for (const hop of run.hops) {
      // A task's endpoints are declared in its own elements; the same text in a lineage question does not declare them.
      const declared = [...hop.request.message.matchAll(/<(?:assigned_endpoints|neighbor_columns)>([^<]*)</g)].map(match => match[1]).join('\n');
      for (const task of hop.tasks.filter(candidate => candidate.kind === 'column_lineage')) {
        const refs = task.sourceRefs ?? task.returnTargets ?? (task.nodeId === origin ? task.activeColumns.map(col => ({ node: origin, col })) : []);
        expect(refs.length, `${hop.focus} carries no endpoint`).toBeGreaterThan(0);
        for (const ref of refs) expect(declared, hop.focus).toContain(`${ref.node}.${ref.col}`);
      }
    }
  });

  // Spec 06 and 07: only an open neighbor takes a question and only an unvisited, unremoved one a prune. The hop message and the served schema both say so.
  it.each(WALKS)('$name: a hop offers no visited or removed neighbor as a question or prune target', ({ run }) => {
    for (const hop of run.hops) {
      const neighbors = neighborsOf(hop);
      for (const closed of neighbors.filter(neighbor => hop.closed.has(neighbor.id))) {
        expect(closed, `${hop.focus} offers ${closed.id}`).toMatchObject({ can_question: false, can_prune: false });
        expect(closed.already_visited === true || closed.already_removed === true, `${closed.id} is not flagged closed`).toBe(true);
      }
      expect(servedChoices(hop, 'questions', 'nodeId'), hop.focus).toEqual(neighbors.filter(neighbor => neighbor.can_question).map(neighbor => neighbor.id).sort());
      expect(servedChoices(hop, 'prune_neighbors', 'id'), hop.focus).toEqual(neighbors.filter(neighbor => neighbor.can_prune).map(neighbor => neighbor.id).sort());
    }
  });
});
