import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { ModelMessage } from '../model/modelPort';
import { z } from 'zod';
import { AiGateRefineSchema, type AiGateRefine } from '../../engine/shared/bridgeContract';
import { ColumnIdentifierSchema } from '../tools/toolSchemas';
import type { TurnOutcome } from '../core/agentCore';
import type { StagePromptContext } from '../prompting/hostPrompts';
import type { PendingGate } from '../session/sessionPhase';
import type { SmState } from '../sm/smTypes';
import type { ToolPhaseAttemptState } from './toolAttempt';

/**
 * Explicit entry route chosen before phase execution starts.
 *
 * @remarks
 * AI-owned semantic verdict. Execution triggers such as `/trace` and the explicit preview action
 * are represented separately so identical visual wording cannot blur the requested execution mode.
 */
export type AgentEntryRoute = 'column_trace' | 'visual_render' | 'discovery';

/** Mechanical source that can select SM without reinterpreting natural-language intent. */
export type AgentExecutionTrigger = 'free_text' | 'slash_trace' | 'run_trace' | 'preview_button' | 'discovery_budget';

/**
 * Structured output for the narrow entry-detector model call.
 *
 * @remarks
 * `visual_render` identifies explicit visual intent but is not itself an execution trigger: it
 * enters discovery like `discovery` does, and only the host-owned preview action (or another
 * explicit trigger) grants a different route.
 */
export const EntryDetectionSchema = z.object({
  entry: z.enum(['column_trace', 'visual_render', 'discovery'])
    .describe('Discrete entry route selected from the user request.'),
  targetColumns: z.array(ColumnIdentifierSchema).nullish()
    .describe('Explicit user-named columns for column_trace; null for discovery or visual_render.'),
}).strict().superRefine((value, ctx) => {
  if (value.entry === 'column_trace' && (!value.targetColumns || value.targetColumns.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: 'column_trace requires at least one explicitly named column.' });
  }
  if (value.entry !== 'column_trace' && value.targetColumns != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: `${value.entry === 'discovery' ? 'Discovery' : 'Visual render'} does not take \`targetColumns\`. Call detect_entry again with \`targetColumns\` omitted.` });
  }
});
/**
 * User's response to a LangGraph consent interrupt.
 *
 * @remarks
 * `hold` ends the turn with the reviewed proposal intact so the chat input becomes
 * available for a free-text scope change; the next user prompt supplies the
 * instruction a same-turn `refine` would have carried.
 */
export type GateDecision =
  | { kind: 'approve'; classes: string[] }
  | { kind: 'refine'; refine: AiGateRefine }
  | { kind: 'hold' }
  | { kind: 'cancel' };

/** Runtime validation for values supplied through `Command({ resume })`. */
export const GateDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve'), classes: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal('refine'), refine: AiGateRefineSchema }).strict(),
  z.object({ kind: z.literal('hold') }).strict(),
  z.object({ kind: z.literal('cancel') }).strict(),
]);

/**
 * Structured reading of one typed chat reply while an approval gate is pending.
 *
 * @remarks
 * The model — never a keyword match — decides what the user's free text asks the pending
 * proposal to do; the verbatim text then rides the decision as the refinement instruction.
 */
export const GateReplySchema = z.object({
  action: z.enum(['approve', 'change', 'cancel', 'other'])
    .describe('What the typed reply asks of the pending exploration proposal.'),
}).strict();

/** Lifecycle marker for the production LangGraph runtime. */
type AgentGraphPhase =
  | 'init'
  | 'detect_entry'
  | 'discover'
  | 'visual_preview'
  | 'sm_entry'
  | 'gate'
  | 'gate_refine'
  | 'gate_approve'
  | 'gate_cancel'
  | 'active_coordinator'
  | 'active_worker'
  | 'synthesis'
  | 'follow_up'
  | 'done';

/** Stable machine-readable graph failures that callers may diagnose without parsing prose. */
export type AgentErrorCode =
  | 'invalid_engine_checkpoint'
  | 'incompatible_tool_call_format';

const lastValue = <T>(_current: T, next: T): T => next;

/**
 * Production host-agent graph state.
 *
 * @remarks
 * Runtime handles (model port, registry, event sink, session) live in graph-node closures, not in
 * checkpointed channels. The checkpoint carries only the serializable turn projection needed
 * for interrupt/resume, state inspection, and restart recovery.
 */
export const AgentState = Annotation.Root({
  prompt: Annotation<string>({ reducer: lastValue, default: () => '' }),
  ctx: Annotation<StagePromptContext | null>({ reducer: lastValue, default: () => null }),
  messages: Annotation<ModelMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  entry: Annotation<AgentEntryRoute | null>({ reducer: lastValue, default: () => null }),
  executionTrigger: Annotation<AgentExecutionTrigger>({ reducer: lastValue, default: () => 'free_text' }),
  targetColumns: Annotation<string[] | null>({ reducer: lastValue, default: () => null }),
  gate: Annotation<PendingGate | null>({ reducer: lastValue, default: () => null }),
  gateDecision: Annotation<GateDecision | null>({ reducer: lastValue, default: () => null }),
  engineSnapshot: Annotation<SmState | null>({ reducer: lastValue, default: () => null }),
  activeHopCount: Annotation<number>({ reducer: lastValue, default: () => 0 }),
  /** Cumulative prune count at the previous hop start, used to show per-hop prune deltas. */
  lastPruned: Annotation<number>({ reducer: lastValue, default: () => 0 }),
  phase: Annotation<AgentGraphPhase>({ reducer: lastValue, default: () => 'init' }),
  outcome: Annotation<TurnOutcome | null>({ reducer: lastValue, default: () => null }),
  errorCode: Annotation<AgentErrorCode | null>({ reducer: lastValue, default: () => null }),
  error: Annotation<string | null>({ reducer: lastValue, default: () => null }),
  activeStop: Annotation<string | null>({ reducer: lastValue, default: () => null }),
  /** Compact phase-local observations and cumulative budgets for graph-owned model attempts. */
  toolAttempt: Annotation<ToolPhaseAttemptState | null>({ reducer: lastValue, default: () => null }),
});

/** Readonly state projection for the agent graph. */
export type AgentStateType = typeof AgentState.State;
/** Writable state update for the agent graph. */
export type AgentStateUpdate = typeof AgentState.Update;
