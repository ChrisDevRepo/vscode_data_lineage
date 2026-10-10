/**
 * Canonical tool-by-stage policy shared by provider projection and runtime authorization.
 *
 * @remarks
 * Policy:
 *
 * | Stage                     | Tools                                                                                            |
 * |---------------------------|--------------------------------------------------------------------------------------------------|
 * | `discover`                | get_context, get_screen_state, search_objects, get_scope_bundle, search_ddl, get_object_detail, detect_graph_patterns |
 * | `visual_preview`          | present_result (restructures the cached discovery answer)                                  |
 * | `sm_entry`                | get_screen_state, search_objects, get_object_detail (resolve all columns for a CT start), start_exploration (resolve origin + open the consent gate) |
 * | `active` (sm_bb)          | submit_findings                                                                                 |
 * | `active` (sm_ct)          | submit_findings, get_neighbor_columns                                                            |
 * | `synthesis`               | present_result                                                                                    |
 * | `completed`               | present_result, start_exploration (a supplement on the completed engine, or a fresh proposal), and every discovery read tool |
 * | `external`                | every discovery read tool and present_result; the read tools only while a chat turn runs                |
 *
 * SM keeps `present_result` synthesis-only because the agenda drains across many hops.
 *
 * `external` is the stage of every caller without a chat turn (the `vscode.lm` registration and the
 * MCP server). Hop-by-hop tools are never in it: they advance an approved exploration the chat owns.
 */

/** Mode variant of the ACTIVE phase. */
export type ActiveMode = 'sm_bb' | 'sm_ct';

/**
 * Discriminated stage descriptor passed to {@link getAllowedLmToolNames}.
 * `active` requires `mode` at compile time — callers cannot forget it.
 */
export type LmStage =
  /** Idle / ad-hoc question answering. No state machine active. */
  | { kind: 'discover' }
  /** Bounded discovery rendering through the shared presentation commit path. */
  | { kind: 'visual_preview' }
  /** SM entry: resolve the origin and open the consent gate (`get_screen_state`, `search_objects`, `get_object_detail`, `start_exploration`). */
  | { kind: 'sm_entry' }
  /** Hop loop. `mode` scopes the tool set to SM BB, or SM CT. */
  | { kind: 'active'; mode: ActiveMode }
  /** Post-agenda-drain report authoring. */
  | { kind: 'synthesis' }
  /** Post-synthesis follow-up: refinement, explicit-node supplements, or a fresh proposal. */
  | { kind: 'completed' }
  /** A caller without a chat turn; `chatTurnActive` withholds the tools that change what the panel shows. */
  | { kind: 'external'; chatTurnActive: boolean };

/** The stages a chat turn runs in; the chat runtime never enters {@link LmStage} `external`. */
export type ChatLmStage = Exclude<LmStage, { kind: 'external' }>;

/** Tools visible when the session is idle or answering ad-hoc questions. */
const DISCOVERY_TOOLS: readonly string[] = [
  'lineage_get_context',
  'lineage_get_screen_state',
  'lineage_search_objects',
  'lineage_get_scope_bundle',
  'lineage_search_ddl',
  'lineage_get_object_detail',
  'lineage_detect_graph_patterns',
];

/** Tools visible while resolving and rendering one bounded discovery scope. */
const VISUAL_PREVIEW_TOOLS: readonly string[] = [
  'lineage_present_result',
];

/**
 * Tools visible while resolving the SM origin and opening the consent gate; the screen card
 * resolves an origin the user referred to as "this trace". `get_object_detail` is included so the
 * CT missing-columns rejection's hint ("read them with `lineage_get_object_detail`") names a tool
 * the model can actually call at this stage, letting it resolve "all columns" for a CT start
 * instead of abandoning the trace.
 */
const SM_ENTRY_TOOLS: readonly string[] = [
  'lineage_get_screen_state',
  'lineage_search_objects',
  'lineage_get_object_detail',
  'lineage_start_exploration',
];

/** Tools visible when authoring the final report. */
const SYNTHESIS_TOOLS: readonly string[] = [
  'lineage_present_result',
];

/**
 * Tools visible in the post-synthesis follow-up phase.
 *
 * @remarks
 * The follow-up phase refines the report: text edits and prunes re-render via `present_result`;
 * explicit node additions go through `start_exploration` with its `supplement` field (see
 * {@link StartExplorationInputSchema}), and a different origin or scope is a fresh
 * `start_exploration` proposal that opens a new approval card. Every discovery read tool stays
 * available, so a question beyond the report — another object, a wider neighbourhood — is answered
 * by walking the loaded graph instead of starting over.
 */
const COMPLETED_TOOLS: readonly string[] = [
  ...DISCOVERY_TOOLS,
  'lineage_present_result',
  'lineage_start_exploration',
];

/**
 * Tools available to callers without a chat turn: discovery reads plus rendering.
 *
 * @remarks
 * `lineage_get_scope_bundle` and `lineage_present_result` write the session's external view slot,
 * never the chat's discovery scope or report (see `AiSession.externalView`).
 */
const EXTERNAL_TOOLS: readonly string[] = [
  ...DISCOVERY_TOOLS,
  'lineage_present_result',
];

/** Names of every tool a caller without a chat turn can reach; drives `vscode.lm`, MCP and the manifest. */
export const EXTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set(EXTERNAL_TOOLS);

/**
 * Exhaustiveness helper — forces the compiler to flag an un-handled `kind`
 * when a new variant is added to {@link LmStage}.
 */
function assertNever(x: never): never {
  throw new Error(`toolPolicy: unhandled LmStage variant: ${JSON.stringify(x)}`);
}

/** Returns the set of LM tool names allowed in the given stage. */
export function getAllowedLmToolNames(stage: LmStage): ReadonlySet<string> {
  switch (stage.kind) {
    case 'discover':
      return new Set(DISCOVERY_TOOLS);
    case 'visual_preview':
      return new Set(VISUAL_PREVIEW_TOOLS);
    case 'sm_entry':
      return new Set(SM_ENTRY_TOOLS);
    case 'synthesis':
      return new Set(SYNTHESIS_TOOLS);
    case 'completed':
      return new Set(COMPLETED_TOOLS);
    case 'external':
      return new Set(stage.chatTurnActive ? DISCOVERY_TOOLS : EXTERNAL_TOOLS);
    case 'active': {
      return new Set(stage.mode === 'sm_ct'
        ? ['lineage_submit_findings', 'lineage_get_neighbor_columns']
        : ['lineage_submit_findings']);
    }
    default:
      return assertNever(stage);
  }
}

/**
 * Derives the ACTIVE-mode tag from the current hop's analysis mode.
 *
 * @param hasColumnAspect - Whether the current hop runs in column-trace mode.
 */
export function activeModeOf(hasColumnAspect: boolean): ActiveMode {
  return hasColumnAspect ? 'sm_ct' : 'sm_bb';
}
