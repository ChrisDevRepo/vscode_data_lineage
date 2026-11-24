import { z } from 'zod';

/**
 * Chat contract: the messages between the extension host and the chat view (the docked pane in
 * the graph webview). The frames join the two main-panel unions in `bridgeContract.ts`.
 */

/** Upper bound, in characters, on one chat prompt or gate refinement text the webview may post. */
const CHAT_TEXT_MAX_CHARS = 50_000;

/** What the host's turn error and the composer notice both say when no `ai.models` entry exists. */
export const NO_MODEL_MESSAGE = 'No model is configured. Run Data Lineage: Add AI Model, or use Add model in the chat.';

/**
 * The commands the composer lists when the user types `/`. `trace` and `search` pin the entry
 * route, `clear` and `new` start a new chat; the host recognizes exactly these
 * (`ai/agent/slashCommands.ts`).
 */
export const CHAT_COMMANDS = [
  { id: 'trace', description: 'Trace the lineage of an object or column' },
  { id: 'search', description: 'Search the objects of the project' },
  { id: 'clear', description: 'Start a new chat' },
  { id: 'new', description: 'Start a new chat' },
] as const;

/** The one definition of a turn event: the runtime's sink emits it and the bridge validates it. */
const TurnEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    phase: z.enum(['thinking', 'scoping', 'tool', 'synthesizing']),
    label: z.string(),
  }),
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({
    type: z.literal('gate'),
    gateId: z.string(),
    gate: z.string(),
    /** The approval card as markdown: depth, scope, schemas, tracing, analysis, objects, skips. */
    summary: z.string(),
    /** The held proposal's full plan as markdown, behind a disclosure; `objects` counts nodes. */
    fullPlan: z.object({ markdown: z.string(), objects: z.number() }).optional(),
    classes: z.array(z.string()).readonly().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string(), recoverable: z.boolean().optional() }),
  z.object({
    type: z.literal('terminal'),
    status: z.enum(['ok', 'error', 'cancelled']),
    error: z.string().optional(),
  }),
]).readonly();

/** One output event of a graph-owned turn. */
export type TurnEvent = z.infer<typeof TurnEventSchema>;

const ChatModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  supportsReasoningEffort: z.array(z.string()).optional(),
  reasoningEffort: z.string().optional(),
});

/** One turn event; `turnId` is `<session id>:<request id>` and rides every turn message. */
const ChatEventMsgSchema = z.object({
  type: z.literal('chat.event'),
  turnId: z.string(),
  event: TurnEventSchema,
  /** Set on a gate event while a finished analysis is shown: approving replaces it. */
  replacesAnalysis: z.boolean().optional(),
});

/** One suggested next prompt: `label` is the button text, `prompt` is what a click sends. */
const ChatFollowupSchema = z.object({ label: z.string(), prompt: z.string() });

/** Composer state: the picker lists, the selection, whether a turn runs, and the follow-ups. */
const ChatStateMsgSchema = z.object({
  type: z.literal('chat.state'),
  models: z.array(ChatModelSchema),
  selectedModelId: z.string(),
  effort: z.string().optional(),
  busy: z.boolean(),
  turnId: z.string().optional(),
  /** Follow-up buttons for the session; empty while a turn runs or a gate is pending. */
  followups: z.array(ChatFollowupSchema),
});

/** Finished exchanges of the session transcript, oldest first; replaces the view's list. */
const ChatHistoryMsgSchema = z.object({
  type: z.literal('chat.history'),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })),
});

/** Host→webview chat frames, joined into `ExtensionToWebviewMsgSchema`. */
export const ChatToWebviewMsgSchemas = [ChatEventMsgSchema, ChatStateMsgSchema, ChatHistoryMsgSchema] as const;

const ChatIdSchema = z.string().min(1).max(256);

/** Webview→host chat frames, joined into `MainPanelToExtensionMsgSchema`; a refine decision
 * carries the change as `text`. */
export const ChatToExtensionMsgSchemas = [
  z.object({ type: z.literal('chat.send'), text: z.string().min(1).max(CHAT_TEXT_MAX_CHARS) }),
  z.object({ type: z.literal('chat.cancel'), turnId: ChatIdSchema }),
  z.object({
    type: z.literal('chat.gate'),
    turnId: ChatIdSchema,
    gateId: ChatIdSchema,
    decision: z.enum(['approve', 'refine', 'cancel']),
    text: z.string().max(CHAT_TEXT_MAX_CHARS).optional(),
  }).refine((msg) => msg.decision !== 'refine' || (msg.text ?? '').trim().length > 0, {
    path: ['text'],
    message: 'A refine decision needs the requested change as text.',
  }),
  z.object({ type: z.literal('chat.newChat') }),
  /** Opens the host's guided model commands: Add AI Model, or the Manage AI Models menu. */
  z.object({ type: z.literal('chat.modelCommand'), command: z.enum(['add', 'manage']) }),
  z.object({ type: z.literal('chat.selectModel'), modelId: ChatIdSchema }),
  z.object({ type: z.literal('chat.selectEffort'), effort: ChatIdSchema }),
  z.object({ type: z.literal('chat.ready') }),
] as const;

/** Chat frames sent from the chat view to the extension host. */
export type ChatToExtensionMsg = z.infer<(typeof ChatToExtensionMsgSchemas)[number]>;

/** Chat frames sent from the extension host to a chat view. */
export type ChatToWebviewMsg = z.infer<(typeof ChatToWebviewMsgSchemas)[number]>;
