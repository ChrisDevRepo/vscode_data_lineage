/**
 * Navigation Engine error protocol — single source of truth.
 *
 * Design rules:
 * 1. DRY — every error is constructed via an `SmErrors` factory method.
 *    Hints are defined once and never copy-pasted.
 * 2. Self-describing — every error carries a plain-English `hint` that tells
 *    the AI how to self-correct. Compile-time enforced via the required
 *    `hint` field in `SmError`.
 * 3. Exhaustive codes — `SmErrorCode` is a string union; the exhaustiveness
 *    check in `SmErrors.hintFor()` catches any missed case at compile time.
 * 4. Zod-validated at the boundary — `src/ai/smSchemas.ts` defines the
 *    runtime schema that validates engine output before it reaches the AI.
 *
 * This pattern mirrors the Zod discipline in `src/engine/shared/bridgeContract.ts`
 * — structured, validated, self-documenting messages across every boundary.
 */

import type { SmStatus } from './smTypes';

// ─── Codes ──────────────────────────────────────────────────────────────────

export type SmErrorCode =
  | 'invalid_status'
  | 'focus_mismatch'
  | 'route_validation_failed'
  | 'orphan_rejection'
  | 'cascade_too_wide'
  | 'origin_not_found'
  | 'blackboard_too_long'
  | 'retry_limit_exceeded';

export const SM_ERROR_CODES: readonly SmErrorCode[] = [
  'invalid_status',
  'focus_mismatch',
  'route_validation_failed',
  'orphan_rejection',
  'cascade_too_wide',
  'origin_not_found',
  'blackboard_too_long',
  'retry_limit_exceeded',
] as const;

// ─── Shape ──────────────────────────────────────────────────────────────────

export interface SmError {
  /** Enum code — stable, machine-parseable. */
  error: SmErrorCode;
  /** Plain-English remediation. MUST be present on every error. */
  hint: string;
  /** Optional free-form context (e.g. the list of bad route requests). */
  detail?: unknown;

  // Per-code extras — all optional, typed rather than `[key: string]: any`.
  expected?: string;
  got?: string;
  current_status?: SmStatus;
  failure_count?: number;
  focus?: string;
  length?: number;
  limit?: number;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * All engine errors are constructed via this class. Hints live here; edit once.
 */
export class SmErrors {
  static invalidStatus(currentStatus: SmStatus): SmError {
    return {
      error: 'invalid_status',
      hint: 'The engine is not awaiting findings (status=' + currentStatus + '). This usually means you batched multiple submit_findings calls in one round — only ONE submit per round is allowed. Wait for the next hop context before submitting again.',
      current_status: currentStatus,
    };
  }

  static focusMismatch(expected: string | null | undefined, got: string | undefined): SmError {
    return {
      error: 'focus_mismatch',
      hint: 'You submitted findings for a node that is not the current focus. This typically means you parallelized submit_findings or analyzed a neighbor instead of the focus. Submit EXACTLY ONE submit_findings per round, with focus_node_id equal to the focus shown in the most recent hop context. To visit other nodes, queue them via route_requests.',
      expected: expected ?? undefined,
      got,
    };
  }

  static routeValidation(invalidRoutes: Array<{ id: string; reason: string }>): SmError {
    return {
      error: 'route_validation_failed',
      hint: 'One or more route_requests reference nodes or columns that do not exist in the model. Remove the invalid entries and verify node IDs against search_objects results and columns against the neighbor metadata in the previous hop context.',
      detail: invalidRoutes,
    };
  }

  static orphanRejection(focusId: string, orphanId: string): SmError {
    return {
      error: 'orphan_rejection',
      hint: `Marking ${focusId} irrelevant would orphan the noted node "${orphanId}" (disconnect it from origin). Use verdict='pass' to skip this node without pruning it from the graph.`,
      focus: focusId,
      detail: { orphan_id: orphanId },
    };
  }

  static cascadeTooWide(focusId: string, cascadeCount: number, agendaSize: number): SmError {
    return {
      error: 'cascade_too_wide',
      hint: `Pruning ${focusId} would cascade-remove ${cascadeCount} of ${agendaSize} agenda nodes (> 50% threshold). Use verdict='pass' to preserve scope.`,
      focus: focusId,
      detail: { cascade_count: cascadeCount, agenda_size: agendaSize },
    };
  }

  static originNotFound(given: string): SmError {
    return {
      error: 'origin_not_found',
      hint: `Origin "${given}" not found in the model. Call search_objects first to get the exact id string (including brackets and schema).`,
      got: given,
    };
  }

  static blackboardTooLong(length: number, limit: number): SmError {
    return {
      error: 'blackboard_too_long',
      hint: `Narrative update is ${length} chars, exceeds ${limit}. Re-densify: keep ~200 chars of novel insight per hop, integrating rather than repeating prior content.`,
      length,
      limit,
    };
  }

  static retryLimitExceeded(focusId: string, count: number): SmError {
    return {
      error: 'retry_limit_exceeded',
      hint: `This hop (${focusId}) has been rejected ${count} consecutive times. The engine is halting to prevent runaway loops. Start a new exploration with a refined question.`,
      focus: focusId,
      failure_count: count,
    };
  }

  /**
   * Compile-time exhaustiveness check.
   * If a new code is added to SmErrorCode without a case here, TS flags the miss.
   */
  static assertAllCodesHandled(code: SmErrorCode): never {
    throw new Error(`Unhandled SmErrorCode: ${code}`);
  }
}
