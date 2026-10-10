import type { InteractionRuleResult } from '../types';
import { makeRejection } from '../../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../support/rejectionCodes';

/**
 * `present_result` requires either a bounded preview scope or a completed exploration graph.
 *
 * @param hasPresentationSource - True if a bounded scope or result graph exists.
 * @returns A rule result error if no presentation source is available, otherwise null.
 */
export function evaluatePresentResultPreconditionsRule(hasPresentationSource: boolean): InteractionRuleResult {
  if (hasPresentationSource) return null;
  return makeRejection({
    code: 'missing_result_graph',
    reason: 'No presentation source is available.',
    hint: 'Load one bounded scope for a visual preview or complete the active exploration first.',
  });
}

/** Handles an external `present_result` names: a scope walk to draw, or a rendered view to edit. */
export interface ExternalRenderHandle {
  readonly scopeId?: string;
  readonly viewId?: string;
}

/**
 * An external render names exactly one kept scope walk or view.
 *
 * @param handle - The handles the call sent.
 * @param scopeKept - Whether the named scope walk is still kept.
 * @param viewKept - Whether the named view is still kept.
 * @returns A rejection naming the call that supplies a valid handle, otherwise null.
 */
export function evaluateExternalRenderHandleRule(handle: ExternalRenderHandle, scopeKept: boolean, viewKept: boolean): InteractionRuleResult {
  if ((handle.scopeId === undefined) === (handle.viewId === undefined)) {
    return makeRejection({
      code: REJECTION_CODES.invalidInput,
      reason: 'Send exactly one of scope_id and view_id.',
      hint: 'scope_id draws the scope a lineage_get_scope_bundle call returned; view_id edits a view a lineage_present_result call returned.',
      issuePaths: ['scope_id', 'view_id'],
    });
  }
  if (handle.scopeId !== undefined && !scopeKept) {
    return makeRejection({
      code: 'missing_result_graph',
      reason: `scope_id ${handle.scopeId} is not a kept scope walk.`,
      hint: 'Call lineage_get_scope_bundle and send the scope_id it returns.',
      issuePaths: ['scope_id'],
    });
  }
  if (handle.viewId !== undefined && !viewKept) {
    return makeRejection({
      code: 'missing_result_graph',
      reason: `view_id ${handle.viewId} is not a kept view.`,
      hint: 'Render the scope again with scope_id, then edit the view_id that call returns.',
      issuePaths: ['view_id'],
    });
  }
  return null;
}
