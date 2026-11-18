/**
 * Single owner for rejection codes that appear on more than one surface. A code belongs here once a
 * second surface (a hint payload, instruction prose) shows its wire `error` literal to the model;
 * both surfaces then interpolate this constant, so a rename cannot drift between guard and prompt.
 * Most codes live only where they are emitted.
 */
export const REJECTION_CODES = {
  /** Tool called outside the current phase's `toolPolicy` allow-list. */
  offPolicy: 'off_policy',
  /** `start_exploration` while the session's exploration is already live (one-shot per turn). */
  alreadyStarted: 'already_started',
  /**
   * Provider/SDK emitted one tool-call id twice in a generation: a transport artifact, not charged
   * to the model.
   */
  duplicateCallId: 'duplicate_call_id',
  /**
   * Provider returned neither a tool call nor any text under `toolChoice: 'required'` — a transport
   * artifact, never charged to the model's semantic budget.
   */
  emptyGeneration: 'empty_generation',
  /**
   * A read call identical (after key canonicalization) to one accepted in an earlier attempt of the
   * same phase; its result is already in the observations. Never charged.
   */
  duplicateRead: 'duplicate_read',
  /** `lineage_get_screen_state` recall query while no AI run is stored for the applied view. */
  noRunMemory: 'no_run_memory',
  /** A session write arrived after the turn lease moved on, so nothing was stored or rendered. */
  staleTurn: 'stale_turn',
  /** Tool input failed its schema or the engine's argument contract; the hint names the field. */
  invalidInput: 'invalid_input',
  /** A node id, origin or detail lookup resolved to nothing in the loaded model. */
  notFound: 'not_found',
  /** `supplement` was requested without a prior exploration in `complete` status to extend. */
  supplementRequiresCompleteEngine: 'supplement_requires_complete_engine',
  /**
   * `supplement` named no node to extend; the repair is to answer, never to resend an empty list.
   */
  supplementEmpty: 'supplement_empty',
  /**
   * Every id named in a `supplement` request was refused: unresolved (no such object) or stopped by
   * the border (excluded, out-of-allowlist, or not connected to the trace). Distinct from
   * {@link supplementEmpty}, whose id list was empty. The repair is a corrective tool call (a new
   * `lineage_start_exploration` proposal for a border refusal), never a resend of this supplement.
   */
  supplementAllRefused: 'supplement_all_refused',
  /** A regex search/grep pattern failed to compile or exceeded the length/complexity budget. */
  invalidRegex: 'invalid_regex',
  /** A discovery-phase scope-expanding catalog request exceeded the turn's node/token budget. */
  overDiscoveryBudget: 'over_discovery_budget',
  /**
   * A proposal, scope change or supplement over `ai.maxRounds` or `ai.maxTraceColumns`; no approval
   * card opens.
   */
  overActiveScopeBudget: 'over_active_scope_budget',
  /** Consent-gate marker in the rejection envelope, not a rejection (`isConsentGateRejection`). */
  actionRequired: 'action_required',
  /** A required field was omitted entirely, as opposed to present but invalid. */
  missingField: 'missing_field',
  /**
   * `targetColumns` supplied while the effective `start_exploration`/refine mode is BB, which
   * accepts no CT-only field.
   */
  ctFieldForbiddenInBb: 'ct_field_forbidden_in_bb',
  /** A tool requiring a live exploration session (`stateMachine`) was called with none active. */
  noActiveSession: 'no_active_session',
  /** A tool ran with no model/graph loaded: the panel closed mid-turn, or no project was opened. */
  noProjectLoaded: 'no_project_loaded',
  /** `proposalRevision` no longer matches the pending approval gate under refine. */
  staleProposalRevision: 'stale_proposal_revision',
  /**
   * Prune/column/question structural fault whose kind carries no specific code, or ≥2 distinct
   * kinds in one submission (`ROUTE_REJECTION_CODE` fallback, `smRouteValidation.ts`).
   */
  routeValidationFailed: 'route_validation_failed',
  /**
   * `column_flow[].out_col` names a column this focus node does not carry (`bad_out_col` kind,
   * `smRouteValidation.ts`).
   */
  outColNotOnNode: 'out_col_not_on_node',
  /**
   * `column_flow[].out_col` names a real node column outside the CT active-column set being traced
   * (`untracked_out_col` kind, `smRouteValidation.ts`).
   */
  outColNotTracked: 'out_col_not_tracked',
  /**
   * `upstream_columns[].col` names a column the contributor node does not itself read
   * (`bad_contributor_col` kind, `smRouteValidation.ts`).
   */
  contributorColNotOnSource: 'contributor_col_not_on_source',
  /**
   * A bodyless focus's `column_flow` names a neighbour other than its carrier side
   * (`non_writer_continuation`).
   */
  continuationNotWriter: 'continuation_not_writer',
  /**
   * An `upstream_columns` entry names the same node.col as this submission's own `writes_to` target
   * (`self_loop_column` kind, `smRouteValidation.ts`).
   */
  columnSelfLoop: 'column_self_loop',
  /**
   * `writes_to` names a downstream reader rather than the node this hop actually writes
   * (`bad_writes_to_target` kind, `smRouteValidation.ts`).
   */
  writesToNamesReader: 'writes_to_names_reader',
  /** An `upstream_columns` entry names a node already pruned earlier this run. */
  prunedContributor: 'pruned_contributor',
  /** A `column_flow` node outside the approved scope (spec 07:9). */
  columnOutOfScope: 'column_out_of_scope',
  /** A `submit_findings` field (`badge_label`, `column_flow` note) over its length bound. */
  fieldLengthExceeded: 'field_length_exceeded',
  /**
   * The provider emitted the synthetic structured-output/terminal tool call with empty required
   * arguments (`structuredOutput.ts`, `vscodeModelPort.ts`, `graph.ts`).
   */
  emptyStructuredOutput: 'empty_structured_output',
  /** The provider generated text or nothing instead of the phase's required terminal tool call. */
  missingRequiredToolCall: 'missing_required_tool_call',
  /** A registered tool handler threw during dispatch; a backend fault that ends the run. */
  toolExecutionError: 'tool_execution_error',
  /** A tool handler caught an unexpected exception; a backend fault that ends the run. */
  internalError: 'internal_error',
  /** The engine threw applying findings and entered its error status; a backend fault, run ends. */
  engineCrash: 'engine_crash',
  /**
   * A `lineage_present_result` call failed an engine-state or content rule its served schema cannot
   * express (`presentResult.ts`, `handlers/presentResult.ts`).
   */
  validation: 'validation',
  /**
   * `submit_findings` reached an engine in a status other than `awaiting_findings` and not
   * `complete` (`smBase.ts`).
   */
  invalidStatus: 'invalid_status',
  /** `submit_findings` reached an engine whose exploration is already `complete` (`smBase.ts`). */
  explorationComplete: 'exploration_complete',
  /**
   * `submit_findings.focus_node_id` is a real node other than the current hop focus (`smBase.ts`).
   */
  focusNodeIdMismatch: 'focus_node_id_mismatch',
  /**
   * A provider tool call failed its tool's input schema before dispatch; raised by a model port
   * that validates arguments itself (`modelPort.ts`, `toolAttempt.ts`).
   */
  invalidToolInput: 'invalid_tool_input',
  /**
   * A text value of a provider tool call carries tool-call notation (`toolCallNotation.ts`,
   * `toolAttempt.ts`).
   */
  toolCallNotation: 'tool_call_notation',
  /**
   * A provider tool call named a tool the phase does not expose (`vscodeModelPort.ts`,
   * `toolAttempt.ts`).
   */
  unknownTool: 'unknown_tool',
  /** The synthetic structured-output call was missing, duplicated or schema-invalid. */
  invalidStructuredOutput: 'invalid_structured_output',
  /**
   * A `supplement`/`start_exploration` id resolves to a real node with no dependency path (in
   * either direction) to the traced graph — refused, never silently admitted (`smBase.ts`
   * `admitSupplementTargets`).
   */
  notConnectedToTrace: 'not_connected_to_trace',
  /** A second call to a once-per-reply tool in one provider reply; only the first is evaluated. */
  extraCallNotEvaluated: 'extra_call_not_evaluated',
  /** A `supplement` lead id names no unresolved pending lead of the completed exploration. */
  invalidPendingLead: 'invalid_pending_lead',
  /**
   * `lineage_present_result` ran with no presentation source: no loaded scope and no completed
   * exploration (`presentResultRules.ts`).
   */
  missingResultGraph: 'missing_result_graph',
  /** A refine proposal identical to the reviewed pending proposal (`startExploration.ts`). */
  noOpRefine: 'no_op_refine',
  /** `start_exploration` origin resolves to no node of the loaded model (`smBase.ts`). */
  originNotFound: 'origin_not_found',
  /**
   * `lineage_get_neighbor_columns` ids that are not direct neighbors of the current object or lie
   * outside the scope (`toolProvider.ts`).
   */
  outOfScopeOrNotNeighbor: 'out_of_scope_or_not_neighbor',
  /** `lineage_start_exploration` called a second time in one reply (`startExplorationRules.ts`). */
  parallelCallForbidden: 'parallel_call_forbidden',
  /** A sibling call not executed because an earlier call of the same batch closed the phase. */
  phaseClosed: 'phase_closed',
  /** A graph preview requested with no discovery narrative or scope behind it. */
  previewSourceUnavailable: 'preview_source_unavailable',
  /** A substring-mode search query of punctuation only, which no object name contains. */
  queryNotAName: 'query_not_a_name',
  /** A search query too short to be a name fragment (`tools.ts`). */
  queryTooShort: 'query_too_short',
  /** A tool result over the turn budget's evidence share, replaced by this reply. */
  resultTooLarge: 'result_too_large',
  /** `start_exploration.targetColumns` names columns the origin does not carry (`smBase.ts`). */
  unknownColumns: 'unknown_columns',
  /** `excludeNodeIds`/`passNodeIds` name nodes absent from the loaded model (`smBase.ts`). */
  unknownNodeIds: 'unknown_node_ids',
} as const;
