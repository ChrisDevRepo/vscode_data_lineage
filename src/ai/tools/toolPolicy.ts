/**
 * Canonical tool-by-stage policy shared by provider projection and runtime authorization.
 *
 * @remarks
 * Policy:
 *
 * | Stage                     | Tools                                                                                            |
 * |---------------------------|--------------------------------------------------------------------------------------------------|
 * | `discover`                | get_context, search_objects, get_scope_bundle, search_ddl, get_object_detail, detect_graph_patterns |
 * | `visual_preview`          | present_result (restructures the cached discovery answer)                                  |
 * | `sm_entry`                | search_objects, start_exploration (resolve origin + open the consent gate)                        |
 * | `active` (sm_bb / sm_ct)  | submit_findings, get_neighbor_columns                                                            |
 * | `synthesis`               | present_result                                                                                    |
 * | `completed`               | present_result, get_object_detail, search_ddl, search_objects, start_exploration (supplement-only) |
 *
 * SM keeps `present_result` synthesis-only because the agenda drains across many hops.
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
  /** SM entry: resolve the origin and open the consent gate (search_objects + start_exploration only). */
  | { kind: 'sm_entry' }
  /** Hop loop. `mode` scopes the tool set to SM BB, or SM CT. */
  | { kind: 'active'; mode: ActiveMode }
  /** Post-agenda-drain report authoring. */
  | { kind: 'synthesis' }
  /** Post-synthesis follow-up: refinement plus explicit-node supplements. */
  | { kind: 'completed' };

/** Tools visible when the session is idle or answering ad-hoc questions. */
const DISCOVERY_TOOLS: readonly string[] = [
  'lineage_get_context',
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

/** Tools visible while resolving the SM origin and opening the consent gate. */
const SM_ENTRY_TOOLS: readonly string[] = [
  'lineage_search_objects',
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
 * The follow-up phase handles refinement without a fresh exploration: text edits
 * and prunes re-render via `present_result`; explicit node additions go through
 * `start_exploration` with its `supplement` field (see {@link StartExplorationInputSchema}).
 * Catalog-lookup tools stay available for "what does node X do" questions the user
 * may ask after reading the report.
 */
const COMPLETED_TOOLS: readonly string[] = [
  'lineage_present_result',
  'lineage_get_object_detail',
  'lineage_search_ddl',
  'lineage_search_objects',
  'lineage_start_exploration',
];

/**
 * Exhaustiveness helper — forces the compiler to flag an un-handled `kind`
 * when a new variant is added to {@link LmStage}.
 */
function assertNever(x: never): never {
  throw new Error(`toolPolicy: unhandled LmStage variant: ${JSON.stringify(x)}`);
}

/**
 * Returns the set of LM tool names allowed in the given stage.
 *
 * @param stage - Discriminated stage descriptor.
 */
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
      // SM hop loop. present_result deferred to synthesis — agenda drains across many hops.
      return new Set(['lineage_submit_findings', 'lineage_get_neighbor_columns']);
    }
    default:
      return assertNever(stage);
  }
}

/**
 * Derives the ACTIVE-mode tag from the navigation engine's state flags.
 *
 * @param hasColumnAspect - Whether `engine.columnAspect !== null` (column-trace mode).
 */
export function activeModeOf(hasColumnAspect: boolean): ActiveMode {
  return hasColumnAspect ? 'sm_ct' : 'sm_bb';
}
