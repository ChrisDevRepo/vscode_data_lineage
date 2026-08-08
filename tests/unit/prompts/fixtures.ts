/**
 * Deterministic fixtures for the prompt golden-test harness (`prompt-golden.test.ts`).
 *
 * @remarks
 * Ported from the ai-instruction-review probe (`scratchpad/probe/entry.ts`) that rendered every
 * exported prompt-builder variant against the real `assets/aiOutputTemplates.yaml` and captured
 * byte-exact output per variant. Values here are the SAME literals the probe used, so the goldens
 * generated from this module (`UPDATE_GOLDEN=1`) reproduce the probe's `scratchpad/assembled/*.txt`
 * byte-for-byte wherever the underlying prompt text has not changed.
 *
 * Typing policy: fixtures are shaped against the real production interfaces via `satisfies` (not
 * `as any`), so a renamed/removed field the builders actually consume fails `typecheck:tests`
 * instead of silently rendering an empty or wrong block. `AiSession`, `AiMemoryManager`, and
 * `NavigationEngine` are concrete classes with private/protected fields, so a plain object literal
 * can never be nominally assignable to them — each `make*()` factory below builds its object
 * against a `Pick<RealClass, '...'>` of exactly the members the prompt builders call (the
 * `satisfies` check that gives the drift protection), then performs the one unavoidable boundary
 * cast the class's private fields force. A few nested fixtures (the hop-context blobs, and the
 * `sm_completion_envelope` result/deferred fixtures) are consumed as opaque JSON payloads whose
 * exact literal shape IS the golden content; forcing full interface compliance there would change
 * rendered bytes, so those stay loosely typed with a documented cast — see their own comments.
 */
import { readFileSync } from 'fs';
import { rootPath } from '../helpers/testUtils';
import { parseAiOutputTemplatesYaml, REQUIRED_AI_TEMPLATE_KEYS } from '../../../src/configCore';
import { EMPTY_AI_TEMPLATES, type AiOutputTemplates } from '../../../src/ai/session/types';
import type { StagePromptContext } from '../../../src/ai/prompting/hostPrompts';
import type { PromptPhase } from '../../../src/ai/prompting/prompts';
import type { AiGateRefine } from '../../../src/engine/shared/bridgeContract';
import type { DatabaseModel } from '../../../src/engine/types';
import { AiSession } from '../../../src/ai/session/session';
import { AiMemoryManager } from '../../../src/ai/session/memoryManager';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type {
  ColumnAspect,
  ColumnEdge,
  DeferredQuestion,
  HopContext,
  InvestigationTask,
  SmResult,
} from '../../../src/ai/sm/smTypes';
import type { ClassificationValue } from '../../../src/ai/session/classification';

// ── Shared grounding / scalar fixtures ──────────────────────────────────────────────────────────

export const ctx = {
  dbPlatform: 'Azure SQL Database',
  filterSchemas: ['dbo'],
  totalSchemaCount: 3,
  visibleNodes: 42,
  totalNodes: 120,
} satisfies StagePromptContext;

export const QUESTION = 'How is FactSales loaded?';
export const ANSWER = 'FactSales is loaded by spLoadFactSales, which aggregates OrderDetailA and joins ' +
  'DimProduct before inserting into dbo.FactSales. NetAmountA is computed as QtyA times PriceA.';
export const ORIGIN = 'dbo.FactSales';
export const MISSION_BRIEF = 'Trace how dbo.FactSales is loaded and what business rules govern NetAmountA during the load.';
export const CONTRACT_SUMMARY = 'Origin dbo.FactSales; direction upstream; depth 3; classification business.';
export const TARGET_COLUMNS = ['NetAmountA'];

export const SCOPE_SUMMARY_MD = [
  '- dbo (3 hops, 5 scope)',
  '  - table: dbo.FactSales, dbo.OrderDetailA, dbo.DimProduct',
  '  - procedure: dbo.spLoadFactSales, dbo.spCalcNetAmountA',
].join('\n');

export const REFINE_BB = {
  excludeTypes: ['function'],
  excludeSchemas: [],
  excludeNodeIds: ['dbo.TableX'],
  passNodeIds: [],
  analysisMode: 'bb',
  instruction: 'Exclude staging tables from the scope.',
} satisfies AiGateRefine;

export const REFINE_CT = {
  excludeTypes: [],
  excludeSchemas: ['staging'],
  excludeNodeIds: [],
  passNodeIds: ['dbo.TableA'],
  analysisMode: 'ct',
  targetColumns: ['NetAmountA'],
  instruction: 'Focus tracing on NetAmountA only.',
} satisfies AiGateRefine;

export const PHASES = ['discover', 'visual_preview', 'active', 'synthesis', 'completed'] as const satisfies readonly PromptPhase[];
export const CLASSIFICATIONS = ['business', 'technical', 'both'] as const satisfies readonly ClassificationValue[];

export const CT_EDGES = [
  { hop_node: 'dbo.spLoadFactSales', hop: 2, from_node: 'dbo.OrderDetailA', from_col: 'QtyA', to_node: 'dbo.FactSales', to_col: 'NetAmountA' },
  { hop_node: 'dbo.spLoadFactSales', hop: 2, from_node: 'dbo.DimProduct', from_col: 'PriceA', to_node: 'dbo.FactSales', to_col: 'NetAmountA' },
] satisfies ColumnEdge[];

// ── Real YAML output templates, loaded exactly as extensionRuntime.ts loads the shipped default ──
// (direct parse of assets/aiOutputTemplates.yaml — never the workspace-merged loader — so the
// golden pins the built-in template content regardless of any local/CI overlay config.)
const yamlText = readFileSync(rootPath('assets', 'aiOutputTemplates.yaml'), 'utf8');
const parsedYaml = parseAiOutputTemplatesYaml(yamlText);
export const templates: AiOutputTemplates = { ...EMPTY_AI_TEMPLATES };
for (const key of REQUIRED_AI_TEMPLATE_KEYS) {
  const entry = parsedYaml[key];
  templates[key] = (entry?.instruction && typeof entry.instruction === 'string') ? entry.instruction.trim() : '';
}

// ── DatabaseModel fixture ────────────────────────────────────────────────────────────────────────
// Only consumed via `sess.model?.nodes.find(...)` (id/type lookup) inside `focusIsNonBodied` —
// never rendered — so this is fully `DatabaseModel`-compliant at no cost to golden byte parity.
export const MODEL = {
  nodes: [
    { id: 'dbo.spLoadFactSales', schema: 'dbo', name: 'spLoadFactSales', fullName: '[dbo].[spLoadFactSales]', type: 'procedure' },
    { id: 'dbo.spCalcNetAmountA', schema: 'dbo', name: 'spCalcNetAmountA', fullName: '[dbo].[spCalcNetAmountA]', type: 'procedure' },
    { id: 'dbo.FactSales', schema: 'dbo', name: 'FactSales', fullName: '[dbo].[FactSales]', type: 'table' },
    { id: 'dbo.OrderDetailA', schema: 'dbo', name: 'OrderDetailA', fullName: '[dbo].[OrderDetailA]', type: 'table' },
    { id: 'dbo.DimProduct', schema: 'dbo', name: 'DimProduct', fullName: '[dbo].[DimProduct]', type: 'table' },
  ],
  edges: [],
  schemas: [],
  catalog: {},
  neighborIndex: {},
} satisfies DatabaseModel;

// ── Hop-context fixtures ─────────────────────────────────────────────────────────────────────────
/**
 * Deliberately NOT `satisfies HopContext`.
 *
 * @remarks
 * `buildWorkerHopMessage` / `NavigationEngine.peekHopContext` consume this object opaquely — a
 * whole-object `JSON.stringify`, never destructured field-by-field — and its exact literal shape
 * (including the harmless extra `focus_node_id` key and the intentionally thin `neighbors[]`
 * entries) is what the golden `.txt` files pin byte-for-byte. Making this fully `HopNeighbor`-
 * compliant would add/remove JSON keys and change rendered golden content, which is out of scope
 * here. Cast to `HopContext` only at the call boundaries that need it (`makeEngine`,
 * `buildWorkerHopMessage` call sites in the test file).
 */
export const HOP_CONTEXT_BODIED = {
  focus_node_id: 'dbo.spLoadFactSales',
  focus_node: {
    id: 'dbo.spLoadFactSales', s: 'dbo', n: 'spLoadFactSales', t: 'procedure',
    bb_ddl: "CREATE PROCEDURE dbo.spLoadFactSales AS BEGIN INSERT INTO dbo.FactSales (NetAmountA, ProductId) " +
      "SELECT od.QtyA * p.PriceA, od.ProductId FROM dbo.OrderDetailA od JOIN dbo.DimProduct p ON od.ProductId = p.ProductId; END",
  },
  neighbors: [
    { id: 'dbo.OrderDetailA', direction: 'in' },
    { id: 'dbo.DimProduct', direction: 'in' },
    { id: 'dbo.FactSales', direction: 'out' },
  ],
  hop: 2,
  agenda_remaining: 3,
  sm_status: 'awaiting_findings',
};
export const HOP_CONTEXT_NON_BODIED = {
  focus_node_id: 'dbo.FactSales',
  focus_node: {
    id: 'dbo.FactSales', s: 'dbo', n: 'FactSales', t: 'table',
    cols: [{ name: 'NetAmountA', type: 'decimal(18,2)' }, { name: 'ProductId', type: 'int' }],
    in: [{ id: 'dbo.spLoadFactSales' }], out: [],
  },
  neighbors: [{ id: 'dbo.spLoadFactSales', direction: 'in' }],
  hop: 1,
};

/** Casts an opaque hop-context fixture to `HopContext` at a call boundary — see the fixtures above. */
export function asHopContext(fixture: typeof HOP_CONTEXT_BODIED | typeof HOP_CONTEXT_NON_BODIED): HopContext {
  return fixture as unknown as HopContext;
}

// ── AiMemoryManager fixture ─────────────────────────────────────────────────────────────────────
type MemoryFixtureShape = Pick<
  AiMemoryManager,
  'slotCount' | 'getMissionBrief' | 'getUserQuestion' | 'getRecentRejections' | 'getShortTermMemory'
>;

export interface MemoryFixtureOptions {
  slotCount?: number;
  missionBrief?: string;
  userQuestion?: string;
  recentRejections?: Array<{ nodeId: string; reason: string; atHop: number }>;
  shortTermMemory?: Array<{ nodeId: string; summary: string }>;
}

/**
 * Builds a duck-typed `AiMemoryManager` stand-in.
 *
 * @remarks
 * `AiMemoryManager` is a concrete class with private fields, so a plain object literal can never
 * be a nominal `AiMemoryManager` — the `satisfies MemoryFixtureShape` check is what gives this
 * fixture real drift protection: renaming or removing any of the five members the prompt builders
 * actually call fails `typecheck:tests` at the `Pick<...>` reference, not silently. The final cast
 * is the unavoidable nominal-class boundary, not an escape from that check.
 */
export function makeMemory(opts: MemoryFixtureOptions = {}): AiMemoryManager {
  const shape = {
    slotCount: opts.slotCount ?? 3,
    getMissionBrief: () => opts.missionBrief ?? MISSION_BRIEF,
    getUserQuestion: () => opts.userQuestion ?? QUESTION,
    getRecentRejections: () => opts.recentRejections ?? [],
    getShortTermMemory: () => opts.shortTermMemory ?? [
      { nodeId: 'dbo.OrderDetailA', summary: 'Passthrough source table; QtyA feeds NetAmountA calc.' },
      { nodeId: 'dbo.DimProduct', summary: 'Lookup table; PriceA feeds NetAmountA calc.' },
    ],
  } satisfies MemoryFixtureShape;
  return shape as unknown as AiMemoryManager;
}

// ── AiSession fixture ───────────────────────────────────────────────────────────────────────────
type SessionFixtureShape = Pick<
  AiSession,
  'outputTemplates' | 'classification' | 'memory' | 'model' | 'requireLockedClassification' | 'stateMachine'
>;

export interface SessionFixtureOptions extends MemoryFixtureOptions {
  classification?: ClassificationValue;
  memory?: AiMemoryManager;
  model?: DatabaseModel;
}

/** Builds a duck-typed `AiSession` stand-in — see the module remarks for the typing policy. */
export function makeSession(opts: SessionFixtureOptions = {}): AiSession {
  const resolvedClassification: ClassificationValue = opts.classification ?? 'business';
  const shape = {
    outputTemplates: templates,
    classification: resolvedClassification,
    memory: opts.memory ?? makeMemory(opts),
    model: opts.model ?? MODEL,
    stateMachine: null,
    requireLockedClassification: (): ClassificationValue => resolvedClassification,
  } satisfies SessionFixtureShape;
  return shape as unknown as AiSession;
}

// ── NavigationEngine fixture ────────────────────────────────────────────────────────────────────
const ROOT_TASK = {
  id: 'task_root',
  source: 'mission',
  question: QUESTION,
  status: 'active',
  createdHop: 0,
  kind: 'root',
} satisfies InvestigationTask;

type EngineFixtureShape = Pick<
  NavigationEngine,
  | 'currentFocus'
  | 'columnAspect'
  | 'getCurrentTasks'
  | 'pendingLineageQuestions'
  | 'requiredNeighborIds'
  | 'peekHopContext'
  | 'getDiscoverySummary'
>;

export interface EngineFixtureOptions {
  currentFocus?: string | null;
  columnAspect?: ColumnAspect | null;
  currentTasks?: InvestigationTask[];
  pendingLineageQuestions?: string[];
  requiredNeighborIds?: string[];
  hopContext?: typeof HOP_CONTEXT_BODIED | typeof HOP_CONTEXT_NON_BODIED;
  discoverySummary?: string | null;
}

/** Builds a duck-typed `NavigationEngine` stand-in — see the module remarks for the typing policy. */
export function makeEngine(opts: EngineFixtureOptions = {}): NavigationEngine {
  const shape = {
    currentFocus: opts.currentFocus ?? 'dbo.spLoadFactSales',
    columnAspect: opts.columnAspect ?? null,
    getCurrentTasks: (): ReadonlyArray<InvestigationTask> => opts.currentTasks ?? [ROOT_TASK],
    pendingLineageQuestions: opts.pendingLineageQuestions ?? [],
    requiredNeighborIds: (_focusId: string): string[] => opts.requiredNeighborIds ?? [],
    peekHopContext: (): HopContext | null => asHopContext(opts.hopContext ?? HOP_CONTEXT_BODIED),
    getDiscoverySummary: (): string | null => opts.discoverySummary ?? null,
  } satisfies EngineFixtureShape;
  return shape as unknown as NavigationEngine;
}

// ── SmResult fixtures (smPrompts.ts round) ──────────────────────────────────────────────────────

/**
 * Fully `SmResult`-compliant: `buildPassthroughFlowFacts` reads only `id`/`t` off `fullNodes` and
 * `nodeId`/`action` off `node_states` to construct fresh text, so the added `s`/`n`/`source`/
 * `reason` fields (real, required members of `ResultNode`/`SmNodeState`) are never rendered.
 */
const PASSTHROUGH_FLOW_FACTS_RESULT = {
  status: 'complete',
  originNodeId: ORIGIN,
  fullNodes: [
    { id: 'dbo.OrderDetailA', s: 'dbo', n: 'OrderDetailA', t: 'table' },
    { id: 'dbo.DimProduct', s: 'dbo', n: 'DimProduct', t: 'table' },
    { id: 'dbo.FactSales', s: 'dbo', n: 'FactSales', t: 'table' },
  ],
  edges: [
    ['dbo.OrderDetailA', 'dbo.spLoadFactSales', 'reads'],
    ['dbo.spLoadFactSales', 'dbo.FactSales', 'writes'],
  ],
  detail_slots: [],
  node_states: [{ nodeId: 'dbo.dimproduct', action: 'passthrough', source: 'engine', reason: 'submitted_passthrough' }],
  columnAspect: null,
} satisfies SmResult;

/**
 * Fully `SmResult`-compliant for the same reason as {@link PASSTHROUGH_FLOW_FACTS_RESULT}: the
 * lone `fullNodes` entry is already slotted, so `buildPassthroughFlowFacts` (invoked internally by
 * `buildSmCompletionEnvelope`) short-circuits to `''` regardless of the added fields, and the
 * `synthesis_reminder` golden text carries no raw JSON of these objects.
 */
const SYNTHESIS_REMINDER_RESULT = {
  status: 'complete',
  originNodeId: ORIGIN,
  fullNodes: [{ id: ORIGIN, s: 'dbo', n: 'FactSales', t: 'table' }],
  edges: [],
  suggested_sections: [],
  node_states: [{ nodeId: ORIGIN.toLowerCase(), action: 'analyze', source: 'ai', reason: 'submitted_analyze' }],
  detail_slots: [{
    nodeId: ORIGIN, schema: 'dbo', name: 'FactSales', type: 'table',
    sections: [{ angle: 'business', text: 'Fact table receiving NetAmountA.' }],
    summary: 'Terminal fact table for the revenue load.',
  }],
  columnAspect: null,
  ctPrunedNodeIds: [],
} satisfies SmResult;

/**
 * Kept loose (no `satisfies SmResult`) and cast at the call boundary.
 *
 * @remarks
 * `buildSmCompletionEnvelope` embeds `node_states` and `deferred_questions` VERBATIM into the
 * JSON-stringified envelope that IS this variant's golden text (`fullNodes` is not embedded, only
 * its length). Real `SmNodeState`/`DeferredQuestion` require a few more fields than this literal
 * carries; adding them would change the rendered JSON, so this fixture's exact shape is preserved
 * byte-for-byte rather than "corrected" to full interface compliance.
 */
const SM_COMPLETION_ENVELOPE_RESULT = {
  status: 'complete',
  originNodeId: ORIGIN,
  fullNodes: [
    { id: 'dbo.spLoadFactSales', t: 'procedure' },
    { id: 'dbo.OrderDetailA', t: 'table' },
    { id: 'dbo.DimProduct', t: 'table' },
    { id: ORIGIN, t: 'table' },
  ],
  edges: [
    ['dbo.OrderDetailA', 'dbo.spLoadFactSales', 'reads'],
    ['dbo.DimProduct', 'dbo.spLoadFactSales', 'reads'],
    ['dbo.spLoadFactSales', ORIGIN, 'writes'],
  ],
  suggested_sections: [{ label: 'Revenue Calc', node_ids: ['dbo.spLoadFactSales'] }],
  node_states: [
    { nodeId: 'dbo.sploadfactsales', action: 'analyze' },
    { nodeId: 'dbo.orderdetaila', action: 'passthrough' },
    { nodeId: 'dbo.dimproduct', action: 'passthrough' },
    { nodeId: 'dbo.factsales', action: 'analyze' },
  ],
  detail_slots: [
    {
      nodeId: 'dbo.spLoadFactSales', schema: 'dbo', name: 'spLoadFactSales', type: 'procedure',
      sections: [{ angle: 'business', text: 'Computes NetAmountA = QtyA * PriceA at INSERT into FactSales.' }],
      summary: 'Loads FactSales from OrderDetailA and DimProduct.',
    },
    {
      nodeId: ORIGIN, schema: 'dbo', name: 'FactSales', type: 'table',
      sections: [{ angle: 'business', text: 'Terminal fact table for the revenue load.' }],
      summary: 'Terminal fact table.',
    },
  ],
  columnAspect: null,
  ctPrunedNodeIds: [],
} as unknown as SmResult;

/** Same treatment as {@link SM_COMPLETION_ENVELOPE_RESULT} — embedded verbatim in the golden JSON. */
const SM_COMPLETION_ENVELOPE_DEFERRED = [
  { nodeId: 'dbo.DimCurrency', question: 'Does currency conversion affect NetAmountA?' },
] as unknown as DeferredQuestion[];

export const smResultFixtures = {
  passthroughFlowFacts: PASSTHROUGH_FLOW_FACTS_RESULT,
  synthesisReminder: SYNTHESIS_REMINDER_RESULT,
  smCompletionEnvelope: SM_COMPLETION_ENVELOPE_RESULT,
  smCompletionEnvelopeDeferred: SM_COMPLETION_ENVELOPE_DEFERRED,
};
