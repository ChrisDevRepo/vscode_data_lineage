import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { ModelMessage } from '../model/modelPort';
import { z } from 'zod';
import type { AiGateRefine } from '../../engine/shared/bridgeContract';
import { ColumnIdentifierSchema } from '../tools/toolSchemas';
import { at, type ToolError } from '../support/toolErrorEnvelope';
import type { TurnOutcome } from '../core/agentCore';
import type { StagePromptContext } from '../prompting/hostPrompts';
import type { ToolPhaseAttemptState } from './toolAttempt';

/** Explicit entry route chosen before phase execution starts. */
export type AgentEntryRoute = 'column_trace' | 'visual_render' | 'discovery';

/** Mechanical source that can select SM without reinterpreting natural-language intent. */
export type AgentExecutionTrigger =
  | 'free_text'
  | 'slash_trace'
  | 'run_trace'
  | 'preview_button'
  | 'discovery_budget';

/** Structured output for the narrow entry-detector model call. */
export const EntryDetectionSchema = z
  .object({
    entry: z
      .enum(['column_trace', 'visual_render', 'discovery'])
      .describe('Discrete entry route selected from the user request.'),
    targetColumns: z
      .array(ColumnIdentifierSchema)
      .nullable()
      .describe(
        'Explicit user-named columns for column_trace; null for discovery or visual_render.',
      ),
  })
  .strict();

/** Domain rule after schema admission: a column trace names at least one column; another route names none. */
export function entryRouteFaults(
  value: z.infer<typeof EntryDetectionSchema>,
): ToolError[] {
  return (
    value.entry === 'column_trace'
      ? !value.targetColumns?.length
      : value.targetColumns !== null
  )
    ? at('invalid', ['targetColumns'])
    : [];
}

/** The user's resolution of the card with `proposalId`: a click or a classified typed reply. */
export type GateDecision =
  | { kind: 'approve'; proposalId: string }
  | { kind: 'cancel'; proposalId: string }
  | { kind: 'refine'; proposalId: string; refine: AiGateRefine };

/** Structured reading of one typed chat reply while an approval gate is pending. */
export const GateReplySchema = z
  .object({
    action: z
      .enum(['approve', 'change', 'cancel', 'other'])
      .describe(
        'What the typed reply asks of the pending exploration proposal.',
      ),
  })
  .strict();

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
export type AgentErrorCode = 'incompatible_tool_call_format';

const lastValue = <T>(_current: T, next: T): T => next;

/** Production host-agent graph state. */
export const AgentState = Annotation.Root({
  prompt: Annotation<string>({ reducer: lastValue, default: () => '' }),
  ctx: Annotation<StagePromptContext | null>({
    reducer: lastValue,
    default: () => null,
  }),
  messages: Annotation<ModelMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  entry: Annotation<AgentEntryRoute | null>({
    reducer: lastValue,
    default: () => null,
  }),
  executionTrigger: Annotation<AgentExecutionTrigger>({
    reducer: lastValue,
    default: () => 'free_text',
  }),
  targetColumns: Annotation<string[] | null>({
    reducer: lastValue,
    default: () => null,
  }),
  gateDecision: Annotation<GateDecision | null>({
    reducer: lastValue,
    default: () => null,
  }),
  activeHopCount: Annotation<number>({ reducer: lastValue, default: () => 0 }),
  /** Cumulative prune count at the previous hop start, used to show per-hop prune deltas. */
  lastPruned: Annotation<number>({ reducer: lastValue, default: () => 0 }),
  phase: Annotation<AgentGraphPhase>({
    reducer: lastValue,
    default: () => 'init',
  }),
  outcome: Annotation<TurnOutcome | null>({
    reducer: lastValue,
    default: () => null,
  }),
  errorCode: Annotation<AgentErrorCode | null>({
    reducer: lastValue,
    default: () => null,
  }),
  error: Annotation<string | null>({ reducer: lastValue, default: () => null }),
  activeStop: Annotation<string | null>({
    reducer: lastValue,
    default: () => null,
  }),
  /** Compact phase-local observations and cumulative budgets for graph-owned model attempts. */
  toolAttempt: Annotation<ToolPhaseAttemptState | null>({
    reducer: lastValue,
    default: () => null,
  }),
});

/** Readonly state projection for the agent graph. */
export type AgentStateType = typeof AgentState.State;
/** Writable state update for the agent graph. */
export type AgentStateUpdate = typeof AgentState.Update;
