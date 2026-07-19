import { REJECTION_CODES } from "../support/rejectionCodes";

import type { HopSubmission } from '../sm/smTypes';
import {
  SubmitFindingsBbInputSchema,
  SubmitFindingsBbRepairPatchSchema,
  SubmitFindingsCtInputSchema,
  SubmitFindingsCtRepairPatchSchema,
  type SubmitFindingsRepairPatch,
} from './toolSchemas';

export interface SubmitFindingPreparationOptions {
  isCtMode: boolean;
  heldFindingFocus: string | null;
  currentFocus: string | null;
  applyHeldPatch: (patch: SubmitFindingsRepairPatch) => unknown | null;
  applyHeldContent: (finding: HopSubmission) => HopSubmission;
}

export type SubmitFindingPreparation =
  | { success: true; finding: HopSubmission }
  | { success: false; rejection: Record<string, unknown> };

function issueDetails(issues: readonly { path: PropertyKey[]; message: string }[]): {
  issuePaths: string[];
  fieldErrors: string[];
} {
  const seen = new Set<string>();
  const fieldErrors: string[] = [];
  for (const issue of issues) {
    if (issue.path.length === 0) continue;
    const key = issue.path.join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    fieldErrors.push(`${key}: ${issue.message}`);
    if (fieldErrors.length >= 3) break;
  }
  return { issuePaths: [...seen], fieldErrors };
}

/** Strictly parses a full finding or a patch merged with the held server-side draft. */
export function prepareSubmitFinding(
  input: unknown,
  options: SubmitFindingPreparationOptions,
): SubmitFindingPreparation {
  const rawInput = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};

  if (!options.isCtMode && rawInput.column_flow !== undefined) {
    return { success: false, rejection: {
      error: 'bb_field_unknown',
      hint: 'This session is in BB mode — `column_flow` is not accepted. Submit verdict + sections + optional route_requests/prune_neighbors.',
    } };
  }

  const isRepairPatch = rawInput.repair === true;
  let candidate: unknown = input;
  if (isRepairPatch) {
    if (!options.heldFindingFocus || options.heldFindingFocus !== options.currentFocus) {
      return { success: false, rejection: {
        error: 'repair_context_missing',
        hint: 'The held finding expired because the session or focus changed. Submit one complete finding for the current hop.',
      } };
    }
    const patch = options.isCtMode
      ? SubmitFindingsCtRepairPatchSchema.safeParse(input)
      : SubmitFindingsBbRepairPatchSchema.safeParse(input);
    if (!patch.success) {
      const details = issueDetails(patch.error.issues);
      return { success: false, rejection: {
        error: 'invalid_repair_patch',
        issue_paths: details.issuePaths,
        hint: details.fieldErrors.join('; ') || 'Invalid repair patch.',
      } };
    }
    candidate = options.applyHeldPatch(patch.data);
    if (!candidate) {
      return { success: false, rejection: {
        error: 'repair_context_missing',
        hint: 'The held finding expired. Submit one complete finding for the current hop.',
      } };
    }
  }

  const parsed = options.isCtMode
    ? SubmitFindingsCtInputSchema.safeParse(candidate)
    : SubmitFindingsBbInputSchema.safeParse(candidate);
  if (!parsed.success) {
    if (options.isCtMode && rawInput.prune_neighbors !== undefined) {
      return { success: false, rejection: {
        error: 'bb_field_forbidden_in_ct',
        hint: 'CT mode forbids `prune_neighbors`. Submit `column_flow` (or `column_flow: []` for no interaction) and use route_requests for contributors.',
      } };
    }
    if (options.isCtMode && rawInput.verdict === 'prune') {
      return { success: false, rejection: {
        error: 'ct_verdict_forbidden',
        hint: 'CT mode allows verdict only `analyze` or `pass`. Use `column_flow: []` when the node has no tracked column interaction.',
      } };
    }
    const details = issueDetails(parsed.error.issues);
    const modeLabel = options.isCtMode ? 'CT' : 'BB';
    return { success: false, rejection: {
      error: options.isCtMode ? 'ct_field_required' : 'invalid_input',
      issue_paths: details.issuePaths,
      hint: details.fieldErrors.length > 0
        ? `Invalid ${modeLabel} submit_findings input — ${details.fieldErrors.join('; ')}.`
        : `Invalid ${modeLabel} submit_findings input: ${parsed.error.issues[0]?.message ?? 'validation failed'}. Required: focus_node_id, sections[], summary, verdict.`,
    } };
  }

  return { success: true, finding: options.applyHeldContent(parsed.data) };
}
