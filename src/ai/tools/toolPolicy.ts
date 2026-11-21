/**
 * Canonical tool-by-stage policy shared by provider projection and runtime authorization (tool
 * names without the `lineage_` prefix):
 * - `discover`: get_context, get_screen_state, search_objects, get_scope_bundle, search_ddl,
 *   get_object_detail, detect_graph_patterns.
 * - `visual_preview`: present_result (restructures the cached discovery answer).
 * - `sm_entry`: get_screen_state, search_objects, get_object_detail (resolves all columns for a CT
 *   start), start_exploration (resolves the origin and opens the consent gate).
 * - `active` (sm_bb): submit_findings. `active` (sm_ct): submit_findings, get_neighbor_columns.
 * - `synthesis`: present_result.
 * - `completed`: present_result, start_exploration (a supplement on the completed engine, or a
 *   fresh proposal), and every discovery read tool.
 *
 * SM keeps `present_result` synthesis-only because the agenda drains across many hops.
 */

/** Mode variant of the ACTIVE phase. */
export type ActiveMode = 'sm_bb' | 'sm_ct';

/** Stage descriptor for {@link getAllowedLmToolNames}; `active` requires `mode` at compile time. */
export type LmStage =
  /** Idle / ad-hoc question answering. No state machine active. */
  | { kind: 'discover' }
  /** Bounded discovery rendering through the shared presentation commit path. */
  | { kind: 'visual_preview' }
  /**
   * SM entry: resolve the origin and open the consent gate (`get_screen_state`, `search_objects`,
   * `get_object_detail`, `start_exploration`).
   */
  | { kind: 'sm_entry' }
  /** Hop loop. `mode` scopes the tool set to SM BB, or SM CT. */
  | { kind: 'active'; mode: ActiveMode }
  /** Post-agenda-drain report authoring. */
  | { kind: 'synthesis' }
  /** Post-synthesis follow-up: refinement, explicit-node supplements, or a fresh proposal. */
  | { kind: 'completed' };

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
 * resolves an origin the user called "this trace". `get_object_detail` is included so the CT
 * missing-columns rejection's hint ("read them with `lineage_get_object_detail`") names a tool
 * callable at this stage, letting the model resolve "all columns" for a CT start instead of
 * abandoning the trace.
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
 * Tools visible in the post-synthesis follow-up phase, which refines the report: text edits and
 * prunes re-render via `present_result`; explicit node additions go through `start_exploration`'s
 * `supplement` field (see {@link StartExplorationInputSchema}); a different origin or scope is a
 * fresh `start_exploration` proposal opening a new approval card. Every discovery read tool stays
 * available, so a question beyond the report is answered by walking the loaded graph instead of
 * starting over.
 */
const COMPLETED_TOOLS: readonly string[] = [
  ...DISCOVERY_TOOLS,
  'lineage_present_result',
  'lineage_start_exploration',
];

/** Exhaustiveness helper: the compiler flags an unhandled `kind` added to {@link LmStage}. */
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
    case 'active': {
      return new Set(stage.mode === 'sm_ct'
        ? ['lineage_submit_findings', 'lineage_get_neighbor_columns']
        : ['lineage_submit_findings']);
    }
    default:
      return assertNever(stage);
  }
}

/** Derives the ACTIVE-mode tag from whether the current hop runs in column-trace mode. */
export function activeModeOf(hasColumnAspect: boolean): ActiveMode {
  return hasColumnAspect ? 'sm_ct' : 'sm_bb';
}
