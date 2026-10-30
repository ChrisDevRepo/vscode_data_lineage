/** Canonical tool-by-stage policy shared by provider projection and runtime authorization. */

/** Mode variant of the ACTIVE phase. */
type ActiveMode = 'sm_bb' | 'sm_ct';

/** Discriminated stage descriptor passed to {@link getAllowedLmToolNames}. `active` requires `mode` at compile time — callers cannot forget it. */
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
  /** Post-synthesis follow-up: presentation edits or a fresh approval proposal. */
  | { kind: 'completed' }
  /** Read-only registration for a caller without a chat turn. */
  | { kind: 'external' };

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
const VISUAL_PREVIEW_TOOLS: readonly string[] = ['lineage_present_result'];

/** Tools visible while resolving the SM origin and opening the consent gate; the screen card resolves an origin the user referred to as "this trace". `get_object_detail` is included so the CT missing-columns rejection's hint ("read them with `lineage_get_object_detail`") names a tool callable at this stage, enabling resolution of "all columns" for a CT start instead of abandoning the trace. */
const SM_ENTRY_TOOLS: readonly string[] = [
  'lineage_get_screen_state',
  'lineage_search_objects',
  'lineage_get_object_detail',
  'lineage_start_exploration',
];

/** Tools visible when authoring the final report. */
const SYNTHESIS_TOOLS: readonly string[] = ['lineage_present_result'];

/** Tools visible in the post-synthesis follow-up phase. */
const COMPLETED_TOOLS: readonly string[] = [
  ...DISCOVERY_TOOLS,
  'lineage_present_result',
  'lineage_start_exploration',
];

/** Read-only tools registered with other VS Code agents. */
const EXTERNAL_TOOLS: readonly string[] = [
  'lineage_get_context',
  'lineage_search_objects',
  'lineage_get_object_detail',
  'lineage_detect_graph_patterns',
  'lineage_search_ddl',
  'lineage_get_neighbor_columns',
  'lineage_get_screen_state',
];

/** Names of every tool a caller without a chat turn can reach; drives `vscode.lm` and the manifest. */
export const EXTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set(EXTERNAL_TOOLS);

/** Exhaustiveness helper — forces the compiler to flag an un-handled `kind` when a new variant is added to {@link LmStage}. */
function assertNever(x: never): never {
  throw new Error(
    `toolPolicy: unhandled LmStage variant: ${JSON.stringify(x)}`,
  );
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
      return EXTERNAL_TOOL_NAMES;
    case 'active': {
      return new Set(
        stage.mode === 'sm_ct'
          ? [
              'lineage_submit_findings',
              'lineage_prune_current',
              'lineage_get_neighbor_columns',
            ]
          : ['lineage_submit_findings', 'lineage_prune_current'],
      );
    }
    default:
      return assertNever(stage);
  }
}

/** Derives the ACTIVE-mode tag from the current hop's analysis mode. */
export function activeModeOf(hasColumnAspect: boolean): ActiveMode {
  return hasColumnAspect ? 'sm_ct' : 'sm_bb';
}
