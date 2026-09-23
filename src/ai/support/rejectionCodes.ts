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
  /** A `prune_neighbors` entry, or an `end_branch` focus, carries a tracked column an accepted `column_flow` already named (`smRouteValidation.ts`, `smBase.ts`). */
  pruneCarriesTrackedColumn: 'prune_carries_tracked_column',
  /** A `prune_neighbors` entry, or an `end_branch` verdict, names the immutable exploration origin. */
  pruneOriginForbidden: 'prune_origin_forbidden',
  /** `proposalRevision` no longer matches the pending approval gate under refine. */
  staleProposalRevision: 'stale_proposal_revision',
  /** Prune/column/question structural fault whose kind carries no specific code, or ≥2 distinct kinds in one submission (`ROUTE_REJECTION_CODE` fallback, `smRouteValidation.ts`). */
  routeValidationFailed: 'route_validation_failed',
  /** `column_flow[].out_col` names a column this focus node does not carry (`bad_out_col` kind, `smRouteValidation.ts`). */
  outColNotOnNode: 'out_col_not_on_node',
  /** `column_flow[].out_col` names a real node column outside the CT active-column set being traced (`untracked_out_col` kind, `smRouteValidation.ts`). */
  outColNotTracked: 'out_col_not_tracked',
  /** `upstream_columns[].col` names a column the contributor node does not itself read (`bad_contributor_col` kind, `smRouteValidation.ts`). */
  contributorColNotOnSource: 'contributor_col_not_on_source',
  /** A bodyless focus's `column_flow` names a neighbour other than its own carrier side (`non_writer_continuation` kind, `smRouteValidation.ts`). */
  continuationNotWriter: 'continuation_not_writer',
  /** An `upstream_columns` entry names the same node.col as this submission's own `writes_to` target (`self_loop_column` kind, `smRouteValidation.ts`). */
  columnSelfLoop: 'column_self_loop',
  /** `writes_to` names a downstream reader rather than the node this hop actually writes (`bad_writes_to_target` kind, `smRouteValidation.ts`). */
  writesToNamesReader: 'writes_to_names_reader',
  /** An `upstream_columns` entry names a node already pruned earlier this run (`smRouteValidation.ts`, `columnTracer.ts`). */
  prunedContributor: 'pruned_contributor',
  /** A CT active tracked column is left unaccounted by the submitted `column_flow` (`smCompleteness.ts`, `smBase.ts` log line). */
  columnChainIncomplete: 'column_chain_incomplete',
  /** A `submit_findings` field (e.g. `badge_label`, a `column_flow` note) exceeds its length bound (`smBase.ts`). */
  fieldLengthExceeded: 'field_length_exceeded',
  /** The provider emitted the synthetic structured-output/terminal tool call with empty required arguments (`structuredOutput.ts`, `vscodeModelPort.ts`, `graph.ts`). */
  emptyStructuredOutput: 'empty_structured_output',
  /** The provider generated text or nothing instead of the phase's required terminal tool call (`toolAttempt.ts`). */
  missingRequiredToolCall: 'missing_required_tool_call',
  /** `submit_findings` carries a classification that no longer matches the locked exploration classification (`submitFindings.ts`). */
  classificationLockViolation: 'classification_lock_violation',
  /** A registered tool handler threw; the generic fallback envelope both LM lanes feed back to the model (`toolErrorEnvelope.ts`, `lineageRuntime.ts` instrumentation label). */
  toolExecutionError: 'tool_execution_error',
  /** `readToolError`'s synthesized code for the `{success:false,errors:[]}` shape when no `error` field is present (`toolErrorEnvelope.ts`). */
  validation: 'validation',
  /** `submit_findings` reached an engine not in `awaiting_findings`; the rule mapper passes it through for every status but `complete` (`smBase.ts`, `submitFindingsRules.ts`). */
  invalidStatus: 'invalid_status',
  /** `submit_findings` reached an engine whose exploration is already `complete`; the mapped wire form of {@link REJECTION_CODES.invalidStatus} (`submitFindingsRules.ts`). */
  explorationComplete: 'exploration_complete',
  /** Engine-internal: `submit_findings.focus_node_id` resolves to no loaded node; mapped to {@link REJECTION_CODES.invalidInput} on the wire (`smBase.ts`, `submitFindingsRules.ts`). */
  invalidFocusNode: 'invalid_focus_node',
  /** Engine-internal: `submit_findings.focus_node_id` is a real node other than the current focus; mapped to {@link REJECTION_CODES.focusNodeIdMismatch} (`smBase.ts`, `submitFindingsRules.ts`). */
  focusMismatch: 'focus_mismatch',
  /** `submit_findings.focus_node_id` is not the current hop focus; the wire form of {@link REJECTION_CODES.focusMismatch} (`submitFindingsRules.ts`). */
  focusNodeIdMismatch: 'focus_node_id_mismatch',
  /** A provider tool call failed its tool's input schema before dispatch (`vscodeModelPort.ts`, `toolAttempt.ts`, `toolErrorEnvelope.ts`). */
  invalidToolInput: 'invalid_tool_input',
  /** A provider tool call named a tool the phase does not expose (`vscodeModelPort.ts`, `toolAttempt.ts`). */
  unknownTool: 'unknown_tool',
  /** The synthetic structured-output call was missing, duplicated or schema-invalid (`structuredOutput.ts`, `vscodeModelPort.ts`). */
  invalidStructuredOutput: 'invalid_structured_output',
} as const;
