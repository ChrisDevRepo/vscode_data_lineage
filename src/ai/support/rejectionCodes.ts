/**
 * Single owner for rejection codes that appear on more than one surface.
 *
 * @remarks
 * A code belongs here only once a second surface (a hint payload, instruction prose) shows its
 * wire `error` literal to the model — most codes live only where they are emitted. Both surfaces
 * then interpolate this constant, so a rename cannot drift between the guard and the prompt.
 */
export const REJECTION_CODES = {
  /** `submit_findings` carries a CT-only field (`column_flow`) in a BB session. */
  bbFieldUnknown: 'bb_field_unknown',
  /** Tool called outside the current phase's `toolPolicy` allow-list. */
  offPolicy: 'off_policy',
  /** `start_exploration` while the session's exploration is already live (one-shot per turn). */
  alreadyStarted: 'already_started',
  /** Provider/SDK emitted the same tool-call id twice in one generation — a transport artifact, never charged to the model's semantic budget. */
  duplicateCallId: 'duplicate_call_id',
  /** Provider returned neither a tool call nor any text under `toolChoice: 'required'` — a transport artifact, never charged to the model's semantic budget. */
  emptyGeneration: 'empty_generation',
  /** A read call identical (after key canonicalization) to one accepted in an earlier attempt of the same phase; its result is already in the observations. Never charged. */
  duplicateRead: 'duplicate_read',
  /** `lineage_get_screen_state` recall query while no AI run is stored for the applied view. */
  noRunMemory: 'no_run_memory',
  /** A session write arrived after the turn lease moved on, so nothing was stored, rendered or committed. */
  staleTurn: 'stale_turn',
  /** Tool input failed its schema or the engine's argument contract; the hint names the offending field. */
  invalidInput: 'invalid_input',
  /** CT `submit_findings` failed its schema; the hint names the offending field. Same family as `invalidInput`. */
  ctFieldRequired: 'ct_field_required',
  /** A node id, origin or detail lookup resolved to nothing in the loaded model. */
  notFound: 'not_found',
  /** `supplement` was requested without a prior exploration in `complete` status to extend. */
  supplementRequiresCompleteEngine: 'supplement_requires_complete_engine',
  /** `supplement` named no node to extend; the repair is to answer, never to resend an empty list. */
  supplementEmpty: 'supplement_empty',
  /** A regex search/grep pattern failed to compile or exceeded the length/complexity budget. */
  invalidRegex: 'invalid_regex',
  /** A discovery-phase scope-expanding catalog request exceeded the turn's node/token budget. */
  overDiscoveryBudget: 'over_discovery_budget',
  /** An active-phase scope admission exceeded the exploration node/token budget. */
  overActiveScopeBudget: 'over_active_scope_budget',
  /** Consent-gate marker sharing the rejection envelope without being a rejection (`isConsentGateRejection`). */
  actionRequired: 'action_required',
  /** A required field was omitted from the call entirely, distinguished from a present-but-invalid value. */
  missingField: 'missing_field',
  /** `targetColumns` supplied while the effective `start_exploration`/refine mode is BB, which accepts no CT-only field. */
  ctFieldForbiddenInBb: 'ct_field_forbidden_in_bb',
  /** A tool requiring a live exploration session (`stateMachine`) was called with none active. */
  noActiveSession: 'no_active_session',
  /** A `prune_neighbors` entry would orphan a node kept by already-committed work. */
  pruneWouldOrphanNoted: 'prune_would_orphan_noted',
  /** A `prune_neighbors` entry names the immutable exploration origin. */
  pruneOriginForbidden: 'prune_origin_forbidden',
  /** `proposalRevision` no longer matches the pending approval gate under refine. */
  staleProposalRevision: 'stale_proposal_revision',
} as const;
