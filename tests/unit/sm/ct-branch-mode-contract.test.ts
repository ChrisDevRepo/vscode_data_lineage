/**
 * Per-hop analysis mode — a CT run's column-less branch is analysed as BB inside the same graph.
 *
 * The governing invariant (docs/ARCHITECTURE.md) is that column state annotates a hop and never
 * gates one: both modes walk the same node set. What column state DOES select is the contract the
 * hop is handed. A branch carrying none of the traced columns has no column to map, so the CT
 * contract asks it for a `column_flow` account it structurally cannot give — the mixed-mode surface
 * that made a model prune a row-shaping node in a real trace.
 *
 * Mode is per hop, therefore per edge: the engine binds the active set at dispatch from the
 * dequeued entry's own carry, so one node reached on a carrying edge and on a row-shaping edge is
 * dispatched under each contract in turn within one run. That case is driven end to end below.
 *
 * Nothing here asserts a verdict. The AI owns what is pruned; these assertions only pin which
 * contract the hop is given.
 */
import { describe, expect, it } from 'vitest';
import Graph from 'graphology';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopFinding } from '../../../src/ai/sm/smTypes';
import type { DatabaseModel, LineageNode, ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { buildActiveHopInstruction, buildActiveInstruction } from '../../../src/ai/agent/stagePrompts';
import { buildPassthroughReAnchor } from '../../../src/ai/prompting/smPrompts';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { compileInstructionPlan, explorationFacts } from '../../../src/ai/agent/instructionPlan';
import { activeModeOf } from '../../../src/ai/tools/toolPolicy';
import { modelUserMessage } from '../../../src/ai/model/modelPort';
import { EMPTY_AI_TEMPLATES, type AiOutputTemplates } from '../../../src/ai/session/types';
import type { AiSession } from '../../../src/ai/session/session';
import type { StagePromptContext } from '../../../src/ai/prompting/hostPrompts';
import { collectingSink, scriptedRegistry } from '../ai-core/helpers/scriptedModelPort';

const V = 'view' as const;

/** The one CT capture template, given distinctive text so its absence is measurable. */
const CT_CAPTURE_MARKER = 'CT-CAPTURE-TEMPLATE-MARKER: account for every active column in column_flow.';

const TEMPLATES: AiOutputTemplates = {
  ...EMPTY_AI_TEMPLATES,
  business_capture: 'Capture the business meaning of this node.',
  column_trace_capture: CT_CAPTURE_MARKER,
};

const CTX: StagePromptContext = {
  dbPlatform: 'SQL Server',
  filterSchemas: ['dbo'],
  totalSchemaCount: 1,
  visibleNodes: 5,
  totalNodes: 5,
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

/** The complete active-phase prompt a hop is dispatched with: stable system prefix + hop message. */
function assembledPrompt(engine: NavigationEngine): string {
  const sess = promptSession(engine);
  const system = buildActiveInstruction(sess, CTX, engine.currentHopAnalysisMode).system;
  const hop = buildActiveHopInstruction(sess, engine, engine.currentFocus!).message;
  return `${system}\n${hop}`;
}

// ─── Fixture: one run reaching `shared` on a row-shaping edge and then on a carrying edge ───
//
//   shared ──> gate ────> report        `gate` restricts rows and declares no traced column
//   shared ──> carrier ─> mid ─> report `carrier` supplies the traced value
//
// Traversal is upstream from `report` on [amount]. `gate` is routed as a row role, so `shared`
// behind it is dispatched column-less (BB). `carrier` later commits a column_flow edge naming
// `shared` as the supplier of `amount`, which reopens it for one CT hop on that edge.

const PER_EDGE_NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  ['report', V, ['amount']],
  ['mid', V, ['amount']],
  ['carrier', V, ['amount']],
  ['gate', V, ['region']],
  ['shared', V, ['amount', 'region']],
];
const PER_EDGE_EDGES: Array<[string, string]> = [
  ['gate', 'report'],
  ['mid', 'report'],
  ['carrier', 'mid'],
  ['shared', 'carrier'],
  ['shared', 'gate'],
];

function buildFixture(
  spec: ReadonlyArray<readonly [string, ObjectType, string[]]>,
  edges: Array<[string, string]>,
): { model: DatabaseModel; graph: Graph } {
  const nodes: LineageNode[] = spec.map(([id, type, columns]) => makeNode({
    id, schema: 'dbo', name: id, type,
    columns: columns.map(name => ({ name, type: 'int', nullable: 'NOT NULL', extra: '' })),
  }));
  return {
    model: makeModel(nodes, edges, ['dbo']),
    graph: makeGraph(nodes.map(n => ({ id: n.id, schema: n.schema, name: n.name, type: n.type })), edges),
  };
}

function startTrace(
  spec: ReadonlyArray<readonly [string, ObjectType, string[]]>,
  edges: Array<[string, string]>,
  origin: string,
  tracedColumn: string,
): NavigationEngine {
  const { model, graph } = buildFixture(spec, edges);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({
    origin,
    question: `trace ${tracedColumn}`,
    direction: 'upstream',
    targetColumns: [tracedColumn],
    depthIntent: { kind: 'explicit', levels: 4 },
  });
  return engine;
}

/** One dispatched hop, captured before its findings are submitted. */
interface Dispatched {
  readonly focusId: string;
  readonly mode: 'bb' | 'ct';
  readonly activeColumns: readonly string[];
  readonly prompt: string;
  readonly question: string;
}

/**
 * Walks the per-edge fixture, recording every dispatched hop and submitting the scripted finding
 * for it. `submitFindings` is driven directly: this file pins the contract a hop is handed, and the
 * model's own tool-boundary parse is asserted separately against the schema the hop dispatched.
 */
function walkPerEdgeRun(): Dispatched[] {
  const engine = startTrace(PER_EDGE_NODES, PER_EDGE_EDGES, 'report', 'amount');
  const findings: Record<string, Omit<HopFinding, 'focus_node_id' | 'sections' | 'summary'>[]> = {
    report: [{
      verdict: 'passthrough',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'mid', col: 'amount' }] }],
      route_requests: [
        { nodeId: 'gate', question: 'what rows does this arm admit?', columns: 'none' },
        { nodeId: 'mid', question: 'where does amount come from?' },
      ],
    }],
    gate: [{
      verdict: 'analyze',
      route_requests: [{ nodeId: 'shared', question: 'what restricts the rows this arm admits?' }],
    }],
    mid: [{
      verdict: 'analyze',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'carrier', col: 'amount' }] }],
      route_requests: [{ nodeId: 'carrier', question: 'where does amount come from?' }],
    }],
    carrier: [{
      verdict: 'analyze',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'shared', col: 'amount' }] }],
      route_requests: [{ nodeId: 'shared', question: 'which rule writes amount?' }],
    }],
    shared: [
      { verdict: 'analyze' },
      { verdict: 'analyze', column_flow: [{ out_col: 'amount', upstream_columns: [] }] },
    ],
  };
  const taken: Record<string, number> = {};
  const dispatched: Dispatched[] = [];

  for (let hop = 0; hop < 12; hop++) {
    const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
    if (ctx.done || !ctx.focus_node) break;
    const focusId = ctx.focus_node.id;
    dispatched.push({
      focusId,
      mode: engine.currentHopAnalysisMode,
      activeColumns: [...(engine.columnAspect?.active_columns ?? [])],
      prompt: assembledPrompt(engine),
      question: engine.getCurrentTasks().map(t => t.question).join(' | '),
    });
    const index = taken[focusId] ?? 0;
    taken[focusId] = index + 1;
    const scripted = findings[focusId]?.[index] ?? findings[focusId]?.[0];
    const outcome = engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: `${focusId} body` }],
      summary: `${focusId} body`,
      ...scripted,
    } as HopFinding) as { error?: string };
    expect(outcome.error, `hop ${hop} on ${focusId} must commit`).toBeUndefined();
  }
  return dispatched;
}

describe('per-hop analysis mode — a column-less branch of a CT run', () => {
  it('dispatches the column-less hop under the BB contract, with no CT block in its prompt', () => {
    const run = walkPerEdgeRun();
    const columnless = run.find(h => h.focusId === 'gate');
    expect(columnless, '`gate` carries none of the traced columns and must still be walked').toBeDefined();
    expect(columnless!.activeColumns, 'this is genuinely the column-less case').toEqual([]);
    expect(columnless!.mode, 'a hop with no column to map is dispatched as BB').toBe('bb');

    const prompt = columnless!.prompt;
    expect(prompt.includes('# Column Trace: active'), 'no CT session anchor').toBe(false);
    expect(prompt.includes(CT_CAPTURE_MARKER), 'no column_trace_capture content').toBe(false);
    expect(prompt.includes('Every verdict carries `column_flow`'), 'no column-flow verdict rider').toBe(false);
    expect(prompt.includes('Ground that in the traced column'), 'no CT grounding suffix').toBe(false);
  });

  it('holds the column-less hop to the BB submit form, so the CT required-field reject cannot fire', () => {
    const run = walkPerEdgeRun();
    const columnless = run.find(h => h.focusId === 'gate')!;
    const schema = submitFindingsSchemaForMode(columnless.mode, 'business');
    const submission = {
      focus_node_id: 'gate',
      sections: [{ angle: 'business', text: 'restricts the admitted rows' }],
      summary: 'restricts the admitted rows',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'shared', question: 'what restricts the rows?' }],
    };
    // `ct_field_required` is the rejection the CT form raises for a missing `column_flow`. The BB
    // form advertises no such field, so a complete submission carries none and nothing can demand it.
    expect(schema.safeParse(submission).success, 'a BB-form submission without column_flow is valid').toBe(true);
    expect(
      schema.safeParse({ ...submission, column_flow: [] }).success,
      'and the CT-only field is not even accepted, so the hop can never be asked for it',
    ).toBe(false);
  });

  it('gives the same node the BB contract on its row-shaping edge and the CT contract on its carrying edge', () => {
    const run = walkPerEdgeRun();
    const sharedHops = run.filter(h => h.focusId === 'shared');
    expect(
      sharedHops.length,
      'the fixture must reach `shared` twice — once behind a row role, once behind a committed column edge',
    ).toBe(2);
    expect(sharedHops.map(h => h.mode), 'mode follows the edge, never the node').toEqual(['bb', 'ct']);
    expect(sharedHops[0].activeColumns).toEqual([]);
    expect(sharedHops[1].activeColumns).toEqual(['amount']);

    expect(sharedHops[0].prompt.includes('# Column Trace: active'), 'the BB edge gets no CT anchor').toBe(false);
    expect(sharedHops[0].prompt.includes(CT_CAPTURE_MARKER), 'the BB edge gets no CT capture').toBe(false);
    expect(sharedHops[1].prompt.includes('# Column Trace: active'), 'the CT edge keeps the CT anchor').toBe(true);
    expect(sharedHops[1].prompt.includes(CT_CAPTURE_MARKER), 'the CT edge keeps the CT capture').toBe(true);
  });

  it('asks a BB-mode hop what the routed node does to the row set, not to the traced value', () => {
    const run = walkPerEdgeRun();
    const columnless = run.find(h => h.focusId === 'gate')!;
    const carrying = run.find(h => h.focusId === 'mid')!;
    expect(columnless.prompt.includes('to produce the traced value'), 'unsatisfiable where no value is traced').toBe(false);
    expect(columnless.prompt.toLowerCase().includes('row set'), 'the BB route question anchors on the rows').toBe(true);
    expect(carrying.prompt.includes('to produce the traced value'), 'a carrying hop keeps the value anchor').toBe(true);
  });

  it('compiles an instruction plan at every hop of the run, including the column-less ones', () => {
    // `compileInstructionPlan` throws when the active stage mode and `facts.analysisMode` disagree.
    // Both are derived from `currentHopAnalysisMode` here exactly as the agent graph derives them,
    // so a per-hop mode cannot desynchronise the pair; this pins that they stay derived together.
    const engine = startTrace(PER_EDGE_NODES, PER_EDGE_EDGES, 'report', 'amount');
    const { registry } = scriptedRegistry([{ name: 'lineage_submit_findings', result: '{}' }]);
    const { sink } = collectingSink();
    const compiled: Array<{ focusId: string; mode: string | undefined }> = [];

    for (let hop = 0; hop < 12; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      const focusId = ctx.focus_node.id;
      const hopMode = engine.currentHopAnalysisMode;
      const plan = compileInstructionPlan({
        kind: 'converse',
        stage: { kind: 'active', mode: activeModeOf(hopMode === 'ct') },
        registry,
        sink,
        messages: [modelUserMessage(`Analyze ${focusId}.`)],
        facts: explorationFacts(
          hopMode,
          hopMode === 'ct' ? engine.currentTargetColumns ?? undefined : undefined,
          { classification: 'business' },
        ),
        toolChoice: 'required',
        requiredTerminalTool: 'lineage_submit_findings',
      });
      compiled.push({ focusId, mode: plan.context.analysisMode });
      engine.submitFindings({
        focus_node_id: focusId,
        sections: [{ angle: 'business' as const, text: 'body' }],
        summary: 'body',
        verdict: 'passthrough',
        ...(hopMode === 'ct' ? { column_flow: [] } : {}),
      } as HopFinding);
    }

    expect(compiled.length, 'the run reaches its column-less hops').toBeGreaterThan(1);
    expect(compiled.some(c => c.mode === 'bb'), 'at least one hop compiles as BB inside the CT run').toBe(true);
    expect(compiled.find(c => c.focusId === 'report')?.mode, 'the origin carries the traced column').toBe('ct');
  });

  it('states the hop mode as data on the hop context the model sees', () => {
    const engine = startTrace(PER_EDGE_NODES, PER_EDGE_EDGES, 'report', 'amount');
    const first = engine.getHopContext();
    expect(first.analysis_mode, 'the origin hop carries the traced column').toBe('ct');
    expect(engine.peekHopContext()?.analysis_mode, 'the re-render states the same mode').toBe('ct');

    engine.submitFindings({
      focus_node_id: 'report',
      sections: [{ angle: 'business' as const, text: 'report body' }],
      summary: 'report body',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'mid', col: 'amount' }] }],
      route_requests: [
        { nodeId: 'gate', question: 'what rows does this arm admit?', columns: 'none' },
        { nodeId: 'mid', question: 'where does amount come from?' },
      ],
    });
    const second = engine.getHopContext();
    expect(second.focus_node?.id, 'the row-role arm dequeues first').toBe('gate');
    expect(second.analysis_mode, 'and states its own mode, not the session mode').toBe('bb');
  });
});

// ─── Passthrough re-anchor: the column clause belongs to the branch, not the session ───
//
//   deep ──> bridge(table, non-bodied) ──> gate ──> report
//
// `gate` is routed as a row role, so the question it forwards through the non-bodied `bridge` to
// `deep` travels on a branch carrying no traced column.

const REANCHOR_NODES: ReadonlyArray<readonly [string, ObjectType, string[]]> = [
  ['report', V, ['amount']],
  ['carrier', V, ['amount']],
  ['gate', V, ['region']],
  ['bridge', 'table' as ObjectType, ['region']],
  ['deep', V, ['region']],
];
const REANCHOR_EDGES: Array<[string, string]> = [
  ['gate', 'report'],
  ['carrier', 'report'],
  ['bridge', 'gate'],
  ['deep', 'bridge'],
];

describe('buildPassthroughReAnchor — gated on the branch, not the session', () => {
  it('adds the column clause only for a branch that carries a traced column', () => {
    expect(buildPassthroughReAnchor('bridge', 'deep', 'ct')).toContain('Ground that in the traced column.');
    expect(buildPassthroughReAnchor('bridge', 'deep', 'bb')).not.toContain('Ground that in the traced column');
    // The shared business-logic nudge is mode-neutral and must survive the gate.
    expect(buildPassthroughReAnchor('bridge', 'deep', 'bb')).toContain('re-anchor this question to deep');
  });

  it('withholds the clause on a column-less branch of a CT run', () => {
    const engine = startTrace(REANCHOR_NODES, REANCHOR_EDGES, 'report', 'amount');
    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'report',
      sections: [{ angle: 'business' as const, text: 'report body' }],
      summary: 'report body',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'carrier', col: 'amount' }] }],
      route_requests: [
        { nodeId: 'gate', question: 'what rows does this arm admit?', columns: 'none' },
        { nodeId: 'carrier', question: 'where does amount come from?' },
      ],
    });

    const gateHop = engine.getHopContext() as { focus_node?: { id: string } };
    expect(gateHop.focus_node?.id).toBe('gate');
    expect(engine.currentHopAnalysisMode, 'the row-role arm is column-less').toBe('bb');
    engine.submitFindings({
      focus_node_id: 'gate',
      sections: [{ angle: 'business' as const, text: 'restricts rows' }],
      summary: 'restricts rows',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'bridge', question: 'what feeds the restriction?' }],
    });

    // `bridge` is non-bodied: the question contracts through it onto `deep`, picking up the
    // re-anchor suffix on the way. The carrying arm is still queued, so drain to the branch under test.
    let question = '';
    for (let hop = 0; hop < 8; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      if (ctx.focus_node.id === 'deep') {
        question = engine.getCurrentTasks().map(t => t.question).join(' | ');
        break;
      }
      engine.submitFindings({
        focus_node_id: ctx.focus_node.id,
        sections: [{ angle: 'business' as const, text: 'body' }],
        summary: 'body',
        verdict: 'passthrough',
        ...(engine.currentHopAnalysisMode === 'ct' ? { column_flow: [] } : {}),
      } as HopFinding);
    }
    expect(question, 'the contraction reaches the bodied node behind the bridge').not.toBe('');
    expect(question, 'the question is re-anchored onto the new focus').toContain('re-anchor this question to deep');
    expect(
      question.includes('Ground that in the traced column'),
      'but this branch carries no traced column to ground an answer in',
    ).toBe(false);
  });
});
