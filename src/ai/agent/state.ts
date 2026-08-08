import { Annotation } from '@langchain/langgraph';
import {
  modelSystemMessage,
  type ModelMessage,
} from '../model/modelPort';
import { z } from 'zod';
import { AiGateRefineSchema, type AiGateRefine } from '../../engine/shared/bridgeContract';
import { coercedStringArray } from '../support/inputNormalization';
import { ColumnIdentifierSchema } from '../tools/toolSchemas';
import type { TurnOutcome } from '../core/agentCore';
import type { StagePromptContext } from '../prompting/hostPrompts';
import type { PendingGate } from '../session/sessionPhase';
import type { SmState } from '../sm/smTypes';
import type { ToolPhaseAttemptState } from './toolAttempt';

/**
 * Sentinel first element of a `messages` update that makes the reducer replace prior history.
 *
 * @remarks
 * Identity-compared, frozen, and stripped by the reducer so it never reaches the model.
 */
export const RESET_HISTORY: ModelMessage = Object.freeze(
  modelSystemMessage('__RESET_HISTORY__'),
);

/**
 * Reduces LangGraph `messages` updates by appending deltas unless {@link RESET_HISTORY} is present.
 *
 * @remarks
 * The replace path prevents active-hop prompt history from accumulating across sliding-memory wipes.
 *
 * @param left - Current channel value.
 * @param right - Channel update emitted by the current graph node.
 * @returns The appended or replacement message history for the next graph state.
 */
function messagesReducer(left: ModelMessage[], right: ModelMessage[]): ModelMessage[] {
  const reset = right.indexOf(RESET_HISTORY);
  return reset >= 0 ? right.slice(reset + 1) : left.concat(right);
}

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
 * `visual_render` identifies explicit visual intent. Free text enters approval-gated BB exploration;
 * only the host-owned preview action grants the lightweight bounded-preview route.
 */
export const EntryDetectionSchema = z.object({
  entry: z.enum(['column_trace', 'visual_render', 'discovery'])
    .describe('Discrete entry route selected from the user request.'),
  // Omitted, explicit null, and empty [] all mean "no target columns" — [] is a common model habit
  // on non-trace routes and must not hard-reject the whole detection (encoding-only normalization).
  targetColumns: z.preprocess(
    value => (Array.isArray(value) && value.length === 0 ? null : value),
    coercedStringArray(ColumnIdentifierSchema).nullable().default(null),
  )
    .describe('Explicit user-named columns for column_trace; null for discovery or visual_render.'),
}).strict().superRefine((value, ctx) => {
  if (value.entry === 'column_trace' && (!value.targetColumns || value.targetColumns.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: 'column_trace requires at least one explicitly named column.' });
  }
  if (value.entry !== 'column_trace' && value.targetColumns !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetColumns'], message: `${value.entry} forbids targetColumns.` });
  }
});
/** User's response to a LangGraph consent interrupt. */
export type GateDecision =
  | { kind: 'approve'; classes: string[] }
  | { kind: 'refine'; refine: AiGateRefine }
  | { kind: 'cancel' };

/** Runtime validation for values supplied through `Command({ resume })`. */
export const GateDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve'), classes: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal('refine'), refine: AiGateRefineSchema }).strict(),
  z.object({ kind: z.literal('cancel') }).strict(),
]);

/** Lifecycle marker for the production LangGraph runtime. */
type AgentGraphPhase =
  | 'init'
  | 'detect_entry'
  | 'discover'
  | 'visual_preview'
  | 'sm_entry'
  | 'gate'
  | 'gate_refine'
  | 'active_coordinator'
  | 'active_worker'
  | 'synthesis'
  | 'follow_up'
  | 'done';

/** Stable machine-readable graph failures that callers may diagnose without parsing prose. */
export type AgentErrorCode =
  | 'invalid_engine_checkpoint'
  | 'model_output_truncated'
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
  messages: Annotation<ModelMessage[]>({ reducer: messagesReducer, default: () => [] }),
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
