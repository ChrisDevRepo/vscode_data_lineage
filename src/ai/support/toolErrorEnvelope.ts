/**
 * Single typed channel for tool-result error envelopes.
 *
 * @remarks
 * A tool result crosses the graph dispatch boundary as a JSON string. Two legitimate error shapes
 * exist, and this module is the one place that normalizes both:
 *
 * - **Engine-rejection shape** `{ error: <code>, hint?, message?, detail?, … }` — emitted by the
 *   state-machine tools; the graph-owned attempt executor interprets it.
 * - **Validation-failure shape** `{ success: false, errors: […], hint? }` — emitted by
 *   `present_result`; counted as a semantic failure, never a provider failure.
 *
 * Provider-pure: no `vscode` or framework imports — the VS Code Copilot lane and any
 * future lane can share this module without modification.
 */
import { z } from 'zod';

/** Normalized, typed read of either error envelope. A `null` reader result means "not an error". */
interface ToolRejection {
  /** Stable machine code — the engine `error` code, or `'validation'` for the `success:false` shape. */
  code: string;
  /** First human-readable reason line (resolved `errors[0]` → `message` → `detail` → `code`). */
  reason: string;
  /** Optional remediation hint the model should act on next round. */
  hint?: string;
  /** Structured dispatcher facts retained for bounded graph-owned correction projection. */
  detail?: unknown;
  /** Dotted paths of the offending fields, when derived from a Zod error; downstream correction-echo and observability read these. */
  issuePaths?: string[];
}

/**
 * Zod view of the untrusted tool-result payload — parsed once at the boundary. All fields optional and
 * `passthrough`; the readers below derive the typed verdict from this single parse.
 */
const ToolResultEnvelope = z
  .object({
    error: z.unknown().optional(),
    success: z.unknown().optional(),
    errors: z.unknown().optional(),
    hint: z.unknown().optional(),
    message: z.unknown().optional(),
    detail: z.unknown().optional(),
  })
  .passthrough();

/**
 * Write-side builder for the one tool-execution failure envelope both LM lanes feed back to the
 * model when a handler throws. Owning it here keeps the graph-owned dispatch result provider-neutral.
 * @param toolName - Canonical tool name whose handler threw.
 * @returns Generic JSON error envelope safe to project into graph retry state.
 */
export function buildToolExecutionError(toolName: string): string {
  return JSON.stringify({
    error: 'tool_execution_error',
    hint: `Correct the ${toolName} input and retry the same phase.`,
  });
}

/** Well-known envelope keys already surfaced as first-class `ToolRejection` fields or resolved into `reason`. */
const RECOGNIZED_ENVELOPE_KEYS = new Set(['error', 'success', 'errors', 'hint', 'message', 'detail']);

/**
 * Rich reader: normalize either error shape into `{ code, reason, hint }`, or `null` when the payload
 * is not an error. Recognizes the engine-rejection shape (`{ error }`), an explicit `{ success:false }`,
 * and a non-empty `{ errors[] }` list. Used for rejection logging and per-turn failure counting.
 *
 * @remarks
 * `detail` folds in every offender the emit site attached: any existing `env.detail`, the full
 * `errors[]` array when it has more than one entry (so a multi-issue reject surfaces every offender
 * in one round instead of one-per-retry), and any unrecognized top-level sibling key the emit site
 * set alongside `error`/`success`/`errors`/`hint`/`message`/`detail` (e.g. `offending_values`).
 * @param data - Parsed untrusted tool result.
 * @returns Normalized rejection, or `null` for a successful/non-envelope result.
 */
export function readToolError(data: unknown): ToolRejection | null {
  const parsed = ToolResultEnvelope.safeParse(data);
  if (!parsed.success) return null;
  const env = parsed.data;

  const hasError = typeof env.error === 'string';
  const hasFailedSuccess = env.success === false;
  const errorsArray = Array.isArray(env.errors) ? env.errors as unknown[] : undefined;
  const hasErrors = !!errorsArray && errorsArray.length > 0;
  if (!hasError && !hasFailedSuccess && !hasErrors) return null;

  const code = hasError ? String(env.error) : 'validation';
  let reason = '';
  if (hasErrors) reason = String((errorsArray as unknown[])[0] ?? '');
  if (!reason && typeof env.message === 'string') reason = env.message;
  if (!reason && typeof env.detail === 'string') reason = env.detail;
  if (!reason && hasError) reason = String(env.error);
  if (!reason) reason = 'tool returned failure envelope';
  const hint = typeof env.hint === 'string' ? env.hint : undefined;

  const extraFacts: Record<string, unknown> = {};
  if (errorsArray && errorsArray.length > 1) extraFacts.errors = errorsArray;
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (RECOGNIZED_ENVELOPE_KEYS.has(key)) continue;
    extraFacts[key] = value;
  }
  const hasExtraFacts = Object.keys(extraFacts).length > 0;

  // No sibling/multi-error facts to fold: return env.detail exactly as given (reference-preserving,
  // e.g. an array), matching the pre-existing single-offender contract untouched.
  let detail: unknown = env.detail;
  if (hasExtraFacts) {
    if (env.detail !== undefined && typeof env.detail === 'object' && env.detail !== null && !Array.isArray(env.detail)) {
      detail = { ...(env.detail as Record<string, unknown>), ...extraFacts };
    } else if (env.detail !== undefined) {
      detail = { detail: env.detail, ...extraFacts };
    } else {
      detail = extraFacts;
    }
  }

  return { code, reason, hint, ...(detail !== undefined ? { detail } : {}) };
}

/**
 * Fail-closed factory for a {@link ToolRejection} — the one producer that normalizes and validates
 * a reason before it can be constructed. Trims `reason` and throws when the trimmed value is empty:
 * an empty-reason reject is unrepresentable (make-illegal-states-unrepresentable), since a rejection
 * the model cannot read is indistinguishable from a silent hang.
 * @param input - Raw rejection fields; `reason` is trimmed before validation and storage.
 * @returns A normalized {@link ToolRejection}.
 */
export function makeRejection(input: { code: string; reason: string; hint?: string; detail?: unknown; issuePaths?: string[] }): ToolRejection {
  const reason = input.reason.trim();
  if (!reason) throw new Error('makeRejection: reason must not be empty');
  return {
    code: input.code,
    reason,
    ...(input.hint !== undefined ? { hint: input.hint } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.issuePaths !== undefined ? { issuePaths: input.issuePaths } : {}),
  };
}

/**
 * Narrowed view of a Zod v4 `invalid_union` issue. Its `errors` field holds one sub-issue array per
 * union branch — the raw material {@link describeInvalidUnion} expands into a per-branch required-
 * field breakdown. (Zod v4 renamed the v3 `unionErrors: ZodError[]` shape to `errors: $ZodIssue[][]`.)
 */
type InvalidUnionIssue = Extract<z.core.$ZodIssue, { code: 'invalid_union' }>;

/**
 * Lists the dotted field paths named by one union branch's sub-issues, deduped in first-seen order
 * and prefixed with the union issue's own path so a nested union (e.g. inside an array element)
 * still reads as a full path from the payload root.
 */
function unionBranchFieldPaths(branchIssues: readonly z.core.$ZodIssue[], basePath: readonly PropertyKey[]): string[] {
  const fields: string[] = [];
  for (const sub of branchIssues) {
    const full = [...basePath, ...sub.path].join('.');
    const field = full || '(root)';
    if (!fields.includes(field)) fields.push(field);
  }
  return fields;
}

/**
 * Expands one `invalid_union` issue into a mechanical "no variant matched" reason naming every
 * union branch's required fields, plus the flattened, first-branch-first field paths for
 * `issuePaths`. Purely derived from the ZodError's own issue tree — no hand-authored per-tool text,
 * so it stays generic across every union schema (BB/CT `submit_findings`, entry-detection, etc.).
 * @param issue - The narrowed `invalid_union` issue.
 * @returns The composed reason line and the deduped, first-branch-first field paths.
 */
function describeInvalidUnion(issue: InvalidUnionIssue): { line: string; paths: string[] } {
  const allPaths: string[] = [];
  const branches = (issue.errors.length > 0 ? issue.errors : [[]]).map((branchIssues, i) => {
    const fields = unionBranchFieldPaths(branchIssues, issue.path);
    for (const field of fields) if (!allPaths.includes(field)) allPaths.push(field);
    return `variant ${i + 1}: ${fields.length ? fields.join(', ') : '(no field detail)'}`;
  });
  const prefix = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return {
    line: `${prefix}input matched no variant; supply all required fields of one variant — ${branches.join('; ')}`,
    paths: allPaths,
  };
}

/**
 * Sole producer of auto-generated {@link ToolRejection} reasons from a Zod validation error. Maps
 * each issue to `"<dottedPath>: <message>"` (or just `<message>` for a root-level issue), except an
 * `invalid_union` issue — root or nested — which expands via {@link describeInvalidUnion} into a
 * per-branch required-field breakdown instead of Zod's generic "Invalid input". Joins all issues in
 * issue order (first issue first, so it survives downstream truncation), and carries the dotted
 * paths separately for correction-echo and observability.
 * @param error - The Zod validation failure.
 * @param opts - `code` to stamp on the rejection; optional remediation `hint`.
 * @returns A normalized {@link ToolRejection} built via {@link makeRejection}.
 */
export function rejectionFromZodError(error: z.ZodError, opts: { code: string; hint?: string }): ToolRejection {
  const issuePaths: string[] = [];
  const lines = error.issues.map(issue => {
    if (issue.code === 'invalid_union') {
      const { line, paths } = describeInvalidUnion(issue);
      issuePaths.push(...paths);
      return line;
    }
    const path = issue.path.join('.');
    if (path) issuePaths.push(path);
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return makeRejection({
    code: opts.code,
    reason: lines.join('; '),
    hint: opts.hint,
    issuePaths,
  });
}

/** Bounds the `.cause` walk in {@link unwrapZodError} so an unrelated error shape cannot spin. */
const MAX_ZOD_CAUSE_HOPS = 5;

/**
 * Unwraps an arbitrary thrown error down to the real `z.ZodError` nested inside it, when present.
 *
 * @remarks
 * Tool-input validation failures can nest a `ZodError` inside one or more `.cause` hops depending
 * on how the LM host wraps schema errors. This helper walks the `.cause` chain up to
 * {@link MAX_ZOD_CAUSE_HOPS} hops — a model-agnostic, encoding-only unwrap that inspects only the
 * error's own `.cause` chain and never changes meaning: a `ZodError` found at any hop depth is
 * exactly the `ZodError` the validator raised.
 * @param error - Any thrown value; only a `z.ZodError` found within {@link MAX_ZOD_CAUSE_HOPS} hops matches.
 * @returns The nested `ZodError`, or `undefined` when none is found within the bound.
 */
export function unwrapZodError(error: unknown): z.ZodError | undefined {
  let current: unknown = error;
  for (let hop = 0; hop < MAX_ZOD_CAUSE_HOPS; hop++) {
    if (current instanceof z.ZodError) return current;
    if (!current || typeof current !== 'object') return undefined;
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined) return undefined;
    current = cause;
  }
  return undefined;
}
