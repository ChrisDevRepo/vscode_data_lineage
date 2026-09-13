/**
 * Single owner for rejection codes that appear on more than one surface.
 *
 * @remarks
 * Most rejection codes live only where they are emitted; a code belongs here as soon as a second
 * surface shows it to the model (instruction prose, a hint payload, a `.describe()` contract).
 * Both surfaces then interpolate the same constant, so a rename cannot silently drift between the
 * emitting guard and the prompt that teaches the recovery. Provider-pure: no `vscode` / AI-SDK
 * imports.
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
  /** A regex search/grep pattern failed to compile or exceeded the length/complexity budget. */
  invalidRegex: 'invalid_regex',
  /** A discovery-phase scope-expanding catalog request exceeded the turn's node/token budget. */
  overDiscoveryBudget: 'over_discovery_budget',
} as const;
