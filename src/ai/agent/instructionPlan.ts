/**
 * Pure compilation boundary for one provider-neutral model call.
 *
 * @remarks
 * An instruction plan is a readonly delivery artifact derived from the current runtime frame.
 * It does not own policy: prompt builders own instruction text, `toolPolicy` owns tool visibility,
 * Zod schemas own structured shapes, and session/engine objects own state. The compiler joins those
 * authorities, enforces cross-cutting BB/CT/classification invariants, and gives model ports one
 * observable call contract. The compiler freezes its envelope and copied arrays; authoritative
 * schema and read-only registry references remain shared rather than deep-cloned.
 */
import type {
  CompleteTextInput,
  GenerateStructuredInput,
  ModelPort,
  InstructionContext,
  ModelToolChoice,
} from '../model/modelPort';
import type { ModelMessage } from '../model/modelPort';
import type { z } from 'zod';
import type { ClassificationValue } from '../session/classification';
import type { TurnEventSink } from '../runtime/turnEventSink';
import {
  filterRegistry,
  overrideRegistrySchemas,
  resolveRegistrySchemas,
  type IToolRegistry,
} from '../tools/registry';
import { getAllowedLmToolNames, type LmStage } from '../tools/toolPolicy';
import {
  presentResultSchemaForPhase,
  submitFindingsSchemaForMode,
  type PresentResultRepairField,
} from '../tools/toolSchemas';

/** Model-call phase labels emitted by the production LangGraph runtime. */
export type InstructionPhase =
  | 'detect_entry'
  | 'discover'
  | 'visual_preview'
  | 'sm_entry'
  | 'active'
  | 'compose'
  | 'synthesis'
  | 'completed';

/** Facts shared by every {@link InstructionPlanFacts} member regardless of analysis mode. */
interface InstructionFactsShared {
  /** Gate-locked output classification for active and synthesis calls. */
  readonly classification?: 'business' | 'technical' | 'both';
  /** YAML keys returned by the same stage render that produced the prompt. */
  readonly templateKeys?: readonly string[];
  /** Memory/context blocks measured non-empty by the assembler for this call. */
  readonly memorySections?: readonly string[];
}

/**
 * Mission/runtime facts from which observable plan metadata is derived.
 *
 * @remarks
 * A discriminated union on {@link InstructionFactsShared.classification | analysisMode} so the
 * BB-forbids / CT-requires `targetColumns` invariant is enforced by the compiler, not a runtime
 * throw: BB (and the mode-absent discovery/entry shape) structurally cannot carry `targetColumns`,
 * and CT structurally must.
 */
export type InstructionPlanFacts =
  /** Whole-object (BB) exploration — never carries named target columns. */
  | (InstructionFactsShared & { readonly analysisMode: 'bb'; readonly targetColumns?: never })
  /** Column-trace (CT) exploration — always carries at least one locked target column. */
  | (InstructionFactsShared & { readonly analysisMode: 'ct'; readonly targetColumns: readonly [string, ...string[]] })
  /** Mode-agnostic calls (entry detection, discovery, compose) — no mode, no targets. */
  | (InstructionFactsShared & { readonly analysisMode?: undefined; readonly targetColumns?: never });

/** Provenance shared by both BB and CT members of an exploration-scoped facts value. */
interface ExplorationFactsShared {
  readonly classification?: ClassificationValue;
  readonly templateKeys?: readonly string[];
  readonly memorySections?: readonly string[];
}

/**
 * Builds the mode-correct {@link InstructionPlanFacts} union member for an exploration-scoped call,
 * so no call site restates the `analysisMode === 'ct' ? {…targetColumns} : {…}` branch.
 *
 * @param analysisMode - Approved mode for this call (from the engine or the gate decision).
 * @param targetColumns - Locked CT targets; required non-empty when `analysisMode` is `ct`, ignored for BB.
 * @param shared - Classification / YAML / memory provenance common to both modes.
 * @returns The discriminated facts member the compiler type-checks against the stage.
 */
export function explorationFacts(
  analysisMode: 'bb' | 'ct',
  targetColumns: readonly string[] | undefined,
  shared: ExplorationFactsShared,
): InstructionPlanFacts {
  if (analysisMode === 'ct') {
    // CT locks its targets at engine init; a missing set here is engine-state drift, not model input.
    if (!targetColumns?.length) throw new Error('InstructionPlan: CT requires at least one target column.');
    return { analysisMode: 'ct', targetColumns: targetColumns as readonly [string, ...string[]], ...shared };
  }
  return { analysisMode: 'bb', ...shared };
}

/** Couples a structured schema with the stable identity emitted to traces. */
export interface StructuredContract<T> {
  /** Stable trace/debug identity for the schema. */
  readonly id: string;
  /** Zod boundary shipped to the selected model port. */
  readonly schema: GenerateStructuredInput<T>['schema'];
}

type StructuredPlanDraft<T> = Omit<GenerateStructuredInput<T>, 'phase' | 'instructionContext' | 'schema'> & {
  readonly kind: 'structured';
  readonly phase: InstructionPhase;
  readonly contract: StructuredContract<T>;
  readonly facts?: InstructionPlanFacts;
};

interface ConversePlanInput {
  readonly messages: ModelMessage[];
  readonly system?: string;
  readonly registry: IToolRegistry<string>;
  readonly sink: TurnEventSink;
  readonly signal?: AbortSignal;
  readonly detectGate?: (toolName: string, resultText: string) => unknown | null;
  readonly isPhaseComplete?: () => boolean;
  readonly detectReroute?: (toolName: string, resultText: string) => boolean;
  readonly toolChoice?: ModelToolChoice;
  readonly requiredTerminalTool?: string;
  readonly requiresToolEvidence?: boolean;
  readonly onToolResult?: (toolName: string, input: unknown, isError: boolean, resultText: string) => void;
  readonly proseGate?: 'buffer-until-tool';
  readonly phase: InstructionPhase;
  readonly instructionContext: InstructionContext;
}

/** Compiler-ready instruction plan for a converse-mode turn. */
export type ConversePlanDraft = Omit<ConversePlanInput, 'phase' | 'instructionContext'> & {
  readonly kind: 'converse';
  readonly stage: LmStage;
  readonly registry: IToolRegistry<string>;
  readonly facts?: InstructionPlanFacts;
  /** Phase-derived provider schema replacements; dispatch still uses the canonical registry. */
  readonly toolSchemaOverrides?: ReadonlyMap<string, z.ZodType>;
  /** Live ephemeral session fact read at each provider step; never copied into frame/context state. */
  readonly presentResultRepairFields?: () => readonly PresentResultRepairField[] | null;
};

type TextPlanDraft = Omit<CompleteTextInput, 'phase' | 'instructionContext'> & {
  readonly kind: 'text';
  readonly phase: InstructionPhase;
  readonly facts?: InstructionPlanFacts;
};

/** Inputs accepted by {@link compileInstructionPlan}. */
export type InstructionPlanDraft<T = unknown> = StructuredPlanDraft<T> | ConversePlanDraft | TextPlanDraft;

/** Readonly structured-output model call with a frozen top-level envelope. */
export interface StructuredInstructionPlan<T> {
  /** Selects the model port's forced structured-output operation. */
  readonly kind: 'structured';
  /** Observable derivation metadata attached to lifecycle evidence. */
  readonly context: InstructionContext;
  /** Runtime projection from which this call was derived. */
  readonly frame: RuntimeFrame;
  /** Fully compiled provider-neutral structured-output input. */
  readonly input: GenerateStructuredInput<T>;
}

/** Readonly single-generation tool call with a frozen top-level envelope. */
export interface ConverseInstructionPlan {
  /** Stable observable discriminant for a tool-capable model generation. */
  readonly kind: 'converse';
  /** Observable derivation metadata attached to lifecycle evidence. */
  readonly context: InstructionContext;
  /** Runtime projection from which this call was derived. */
  readonly frame: RuntimeFrame;
  /** Fully compiled input with its phase-filtered provider-neutral JSON-text registry. */
  readonly input: ConversePlanInput;
}

/** Readonly internal text-completion model call with a frozen top-level envelope. */
export interface TextInstructionPlan {
  /** Selects the model port's internal no-tool text operation. */
  readonly kind: 'text';
  /** Observable derivation metadata attached to lifecycle evidence. */
  readonly context: InstructionContext;
  /** Runtime projection from which this call was derived. */
  readonly frame: RuntimeFrame;
  /** Fully compiled provider-neutral text-completion input. */
  readonly input: CompleteTextInput;
}

/** Provider-neutral call contract produced for exactly one model generation. */
export type InstructionPlan<T = unknown> =
  | StructuredInstructionPlan<T>
  | ConverseInstructionPlan
  | TextInstructionPlan;

/** Ephemeral runtime projection used to derive one provider call. */
export interface RuntimeFrame {
  /** Model-call phase selected by LangGraph. */
  readonly phase: InstructionPhase;
  /** Approved mission facts relevant to this call. */
  readonly facts?: InstructionPlanFacts;
  /** Tool-policy stage for a tool-capable call. */
  readonly stage?: LmStage;
  /** Structured schema identity for a structured call. */
  readonly schemaId?: string;
}

function phaseOf(stage: LmStage): InstructionPhase {
  return stage.kind;
}

/**
 * True for the two stages whose `lineage_present_result` schema may be swapped for a
 * live-resolved repair-patch schema (session-authorized held-draft repair).
 *
 * @remarks
 * `completed` amends through its own `is_update` handler path instead of this live-resolver
 * mechanism, so it is never part of this set. Colocated here rather than in `toolPolicy.ts`
 * (which owns per-stage tool exposure generally) because this predicate is specific to the
 * present-result repair-authorization wiring this compiler owns.
 */
function stageSupportsPresentResultRepair(stage: LmStage): boolean {
  return stage.kind === 'synthesis' || stage.kind === 'visual_preview';
}

function freezeStrings(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze([...(values ?? [])]);
}

function freezeFacts(facts: InstructionPlanFacts | undefined): InstructionPlanFacts | undefined {
  if (!facts) return undefined;
  const shared = {
    ...(facts.classification ? { classification: facts.classification } : {}),
    templateKeys: freezeStrings(facts.templateKeys),
    memorySections: freezeStrings(facts.memorySections),
  };
  if (facts.analysisMode === 'ct') {
    return Object.freeze({ ...shared, analysisMode: 'ct', targetColumns: freezeStrings(facts.targetColumns) as readonly [string, ...string[]] });
  }
  if (facts.analysisMode === 'bb') return Object.freeze({ ...shared, analysisMode: 'bb' });
  return Object.freeze(shared);
}

function buildContext(
  kind: InstructionContext['kind'],
  phase: InstructionPhase,
  facts: InstructionPlanFacts | undefined,
  toolNames: readonly string[],
  schemaId?: string,
): InstructionContext {
  const analysisMode = facts?.analysisMode;
  const targets = facts?.analysisMode === 'ct' ? facts.targetColumns : undefined;
  // Runtime-only guards: the BB-forbids / CT-requires targetColumns invariant is now compile-time
  // (discriminated `InstructionPlanFacts`), but classification/mode presence for active & synthesis
  // guards live engine-state drift the type system cannot see.
  if ((phase === 'active' || phase === 'synthesis') && !facts?.classification) {
    throw new Error(`InstructionPlan: ${phase} requires a locked classification.`);
  }
  if ((phase === 'active' || phase === 'synthesis') && !analysisMode) {
    throw new Error(`InstructionPlan: ${phase} requires an approved analysis mode.`);
  }

  const context: InstructionContext = {
    kind,
    ...(analysisMode ? { analysisMode } : {}),
    ...(facts?.classification ? { classification: facts.classification } : {}),
    ...(targets ? { targetColumns: freezeStrings(targets) } : {}),
    templateKeys: freezeStrings(facts?.templateKeys),
    memorySections: freezeStrings(facts?.memorySections),
    toolNames: freezeStrings(toolNames),
    ...(schemaId ? { schemaId } : {}),
  };
  return Object.freeze(context);
}

/** @param draft - Structured-output call ingredients. @returns A readonly structured plan. */
export function compileInstructionPlan<T>(draft: StructuredPlanDraft<T>): StructuredInstructionPlan<T>;
/** @param draft - Tool-generation ingredients. @returns A readonly converse plan. */
export function compileInstructionPlan(draft: ConversePlanDraft): ConverseInstructionPlan;
/** @param draft - Internal text-completion ingredients. @returns A readonly text plan. */
export function compileInstructionPlan(draft: TextPlanDraft): TextInstructionPlan;
/**
 * Implements plan compilation while preserving discriminated result types.
 * @param draft - Trusted call ingredients selected by the active LangGraph node.
 * @returns A readonly provider-neutral instruction plan.
 */
export function compileInstructionPlan<T>(draft: InstructionPlanDraft<T>): InstructionPlan<T> {
  if (draft.kind === 'structured') {
    const { kind: _kind, phase, contract, facts, ...input } = draft;
    const frozenFacts = freezeFacts(facts);
    const frame: RuntimeFrame = Object.freeze({ phase, facts: frozenFacts, schemaId: contract.id });
    const context = buildContext('structured', phase, frozenFacts, [], contract.id);
    return Object.freeze({
      kind: 'structured',
      context,
      frame,
      input: Object.freeze({ ...input, messages: Object.freeze([...input.messages]) as unknown as ModelMessage[], schema: contract.schema, phase, instructionContext: context }),
    });
  }
  if (draft.kind === 'text') {
    const { kind: _kind, phase, facts, ...input } = draft;
    const frozenFacts = freezeFacts(facts);
    const frame: RuntimeFrame = Object.freeze({ phase, facts: frozenFacts });
    const context = buildContext('text', phase, frozenFacts, []);
    return Object.freeze({
      kind: 'text',
      context,
      frame,
      input: Object.freeze({ ...input, messages: Object.freeze([...input.messages]), phase, instructionContext: context }),
    });
  }

  const {
    kind: _kind,
    stage,
    registry: sourceRegistry,
    facts,
    toolSchemaOverrides,
    presentResultRepairFields,
    ...input
  } = draft;
  const phase = phaseOf(stage);
  const frozenFacts = freezeFacts(facts);
  const frame: RuntimeFrame = Object.freeze({ phase, stage, facts: frozenFacts });
  if (stage.kind === 'active') {
    const stageMode = stage.mode === 'sm_ct' ? 'ct' : 'bb';
    if (facts?.analysisMode !== stageMode) {
      throw new Error(`InstructionPlan: active stage mode ${stageMode} does not match the approved analysis mode.`);
    }
  }
  if (presentResultRepairFields && !stageSupportsPresentResultRepair(stage)) {
    throw new Error('InstructionPlan: present_result repair authorization is valid only in synthesis or visual preview.');
  }
  const allowed = getAllowedLmToolNames(stage);
  const filteredRegistry = filterRegistry(sourceRegistry, allowed);
  const schemaOverrides = new Map(toolSchemaOverrides ?? []);
  if (stage.kind === 'active') {
    schemaOverrides.set(
      'lineage_submit_findings',
      submitFindingsSchemaForMode(stage.mode === 'sm_ct' ? 'ct' : 'bb'),
    );
  }
  const liveRepairResolver = stageSupportsPresentResultRepair(stage) && presentResultRepairFields;
  if ((stage.kind === 'completed' || stageSupportsPresentResultRepair(stage)) && !liveRepairResolver) {
    schemaOverrides.set('lineage_present_result', presentResultSchemaForPhase(stage.kind));
  }
  let registry = schemaOverrides.size
    ? overrideRegistrySchemas(filteredRegistry, schemaOverrides)
    : filteredRegistry;
  if (liveRepairResolver) {
    registry = resolveRegistrySchemas(registry, new Map([[
      'lineage_present_result',
      () => presentResultSchemaForPhase(stage.kind, presentResultRepairFields()),
    ]]));
  }
  const toolNames = registry.getTools().map(tool => tool.name);
  if (input.requiredTerminalTool && !registry.has(input.requiredTerminalTool)) {
    throw new Error(`InstructionPlan: required terminal tool ${input.requiredTerminalTool} is not available in ${phase}.`);
  }
  let toolChoice = input.toolChoice;
  if (toolChoice === 'required' && toolNames.length > 1) {
    if (!input.requiredTerminalTool) {
      throw new Error(`InstructionPlan: multi-tool required choice in ${phase} needs a graph-enforced terminal tool.`);
    }
    // Some providers reject generic Required when more than one tool is visible. The graph still
    // enforces the required terminal tool and retries a tool-less generation, so provider Auto
    // preserves the phase contract without narrowing away the phase's lookup tools.
    toolChoice = 'auto';
  }
  const context = buildContext('converse', phase, frozenFacts, toolNames);
  return Object.freeze({
    kind: 'converse',
    context,
    frame,
    input: Object.freeze({ ...input, messages: Object.freeze([...input.messages]) as unknown as ModelMessage[], phase, registry, toolChoice, instructionContext: context }),
  });
}

type InstructionPlanExecutor = Pick<ModelPort, 'generateStructured' | 'completeText'>;

/** @param model - Active provider-neutral model port. @param plan - Structured plan to run. @returns Validated structured output. */
export function executeInstructionPlan<T>(model: InstructionPlanExecutor, plan: StructuredInstructionPlan<T>): Promise<T>;
/** @param model - Active provider-neutral model port. @param plan - Text plan to run. @returns Trimmed provider text. */
export function executeInstructionPlan(model: InstructionPlanExecutor, plan: TextInstructionPlan): Promise<string>;
/**
 * Forwards one compiled structured or text plan to the provider-neutral port.
 * @param model - Active provider-neutral model port.
 * @param plan - Immutable plan selected for this call.
 * @returns The result shape associated with the plan discriminant.
 */
export function executeInstructionPlan<T>(
  model: InstructionPlanExecutor,
  plan: StructuredInstructionPlan<T> | TextInstructionPlan,
): Promise<T | string> {
  switch (plan.kind) {
    case 'structured':
      return model.generateStructured(plan.input);
    case 'text':
      return model.completeText(plan.input);
  }
}
