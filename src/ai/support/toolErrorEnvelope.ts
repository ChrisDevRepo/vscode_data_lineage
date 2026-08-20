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
 * Provider-pure: no `vscode` imports, so it stays usable from any model lane.
 */
import { z } from 'zod';

/** Normalized, typed read of either error envelope. A `null` reader result means "not an error". */
export interface ToolRejection {
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
 * Engine code carried by the consent gate, which shares the rejection envelope without being one.
 */
const CONSENT_GATE_CODE = 'action_required';

/**
 * Reports whether a rejection code is the consent gate rather than a failure.
 *
 * @param code - Rejection code from {@link readToolError}.
 * @returns `true` when the envelope is a paused-for-approval gate.
 *
 * @remarks
 * The gate reuses the rejection envelope so one dispatch path serves both, but it is never charged
 * against the semantic budget and must not be counted or rendered as a failure. Every surface that
 * separates the two reads this predicate, so the distinction is defined once.
 */
export function isConsentGateRejection(code: string): boolean {
  return code === CONSENT_GATE_CODE;
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

  // No sibling/multi-error facts: keep env.detail as-is (reference-preserving, e.g. an array).
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
 * Extracts exact field paths from structured rejection detail without interpreting reason prose.
 *
 * @remarks
 * Lives beside the envelope it reads rather than in any one consumer: the retry path turns these
 * into bounded correction fragments, and the diagnostic trace records them so two rejections
 * sharing a `code` stay distinguishable. Both read the same `detail` shape, so deriving the paths
 * twice would be the drift risk.
 *
 * The traversal is bounded (64 nodes, 16 paths) and every accepted value must match the dotted
 * identifier grammar, so the result is safe to record where prose is not allowed.
 *
 * @param detail - The rejection's `detail` field, in any nesting the producing tool chose.
 * @returns Deduped dotted paths, in first-seen order; empty when the detail names none.
 */
export function rejectionIssuePaths(detail: unknown): string[] {
  const paths: string[] = [];
  const queue: unknown[] = [detail];
  let visited = 0;
  while (queue.length > 0 && visited < 64 && paths.length < 16) {
    const value = queue.shift();
    visited++;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      queue.push(...value.slice(0, 32));
      continue;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.path === 'string'
      && record.path.length <= 512
      && /^(?:[A-Za-z_][A-Za-z0-9_-]{0,99}|\d+)(?:\.(?:[A-Za-z_][A-Za-z0-9_-]{0,99}|\d+))*$/.test(record.path)
    ) {
      paths.push(record.path);
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== 'path' && child && typeof child === 'object') queue.push(child);
    }
  }
  return [...new Set(paths)];
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
 * Standing repair instruction for a schema-invalid tool call. Truthful for the port-level reject:
 * nothing is held at that layer, so the model must resend the complete call — the instruction
 * directs a minimal edit, it does not promise server-side reuse.
 */
export const INVALID_TOOL_INPUT_REPAIR_HINT
  = 'Resend the full tool call with only the offending field(s) corrected; keep every other field unchanged.';

/**
 * Standing repair instruction for a provider call naming a tool outside this phase's catalog. The
 * valid names ride in the rejection's `detail.allowedTools`, not this sentence, so the instruction
 * stays one fixed sentence regardless of how many tools the phase offers.
 */
export const UNKNOWN_TOOL_REPAIR_HINT = 'Call one of the tools already offered in this response.';

/**
 * Standing repair instruction for a provider-emitted duplicate tool-call id. The duplicate is a
 * transport artifact, not a content mistake, so the repair is a fresh id rather than a resend.
 */
export const DUPLICATE_CALL_ID_REPAIR_HINT = 'Use a new, unique call id for this tool call.';

/**
 * Bounded verbatim echo of one offending scalar. Objects and arrays are never echoed — a scalar
 * leaf is a bounded correction fragment; anything larger would re-open the full-payload re-echo
 * the minimal-delta repair contract forbids.
 */
const SCALAR_ECHO_MAX_CHARS = 120;

/** Walks `input` down one Zod issue path; `undefined` when the path leaves the object graph. */
function resolveAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let value: unknown = input;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key as keyof object];
  }
  return value;
}

/** Measured size of the received value in the unit the model reasons about; `undefined` when unmeasurable. */
function measuredSize(value: unknown): string | undefined {
  if (typeof value === 'string') return `${value.length} chars`;
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === 'number') return `${value}`;
  return undefined;
}

/** JSON-quoted echo of a scalar leaf, hard-capped; non-scalars return `undefined` and are never echoed. */
function scalarEcho(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > SCALAR_ECHO_MAX_CHARS ? `${value.slice(0, SCALAR_ECHO_MAX_CHARS)}…` : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * Composes one reason line for a size violation from the issue's own metadata plus the received
 * value: measured size, the bound, and — for scalar leaves only — the verbatim text the model
 * cannot otherwise see (its rejected call is never replayed with arguments). Falls back to the
 * stock Zod message when the received value is unmeasurable.
 */
function describeSizeIssue(
  issue: Extract<z.core.$ZodIssue, { code: 'too_big' | 'too_small' }>,
  received: unknown,
): string | undefined {
  const size = measuredSize(received);
  if (size === undefined) return undefined;
  const bound = issue.code === 'too_big' ? `limit ${issue.maximum}` : `minimum ${issue.minimum}`;
  const echo = scalarEcho(received);
  return `${size}, ${bound}${echo !== undefined ? `; sent: ${echo}` : ''}`;
}

/**
 * Sole producer of auto-generated {@link ToolRejection} reasons from a Zod validation error. Maps
 * each issue to `"<dottedPath>: <message>"` (or just `<message>` for a root-level issue), except an
 * `invalid_union` issue — root or nested — which expands via {@link describeInvalidUnion} into a
 * per-branch required-field breakdown instead of Zod's generic "Invalid input". Joins all issues in
 * issue order (first issue first, so it survives downstream truncation), and carries the dotted
 * paths separately for correction-echo and observability.
 *
 * When the caller supplies the parsed `input`, each issue line is enriched from the issue's own
 * metadata and the received value — Zod v4 issues do not carry the input, so the measurement must
 * happen here: a `too_big`/`too_small` issue reports the measured size against the bound
 * (`badge_label: 61 chars, limit 50`) and echoes a scalar leaf verbatim (bounded). Models cannot
 * count characters, and the rejected call is replayed without arguments, so the measured value and
 * the sent text are the two facts that turn a blind regeneration into a directed edit. All derived
 * mechanically from the ZodError issue tree — no per-tool or per-field text.
 *
 * @remarks
 * Callers hand this a bare `z.ZodError`: the `vscode.lm` port validates tool input itself with
 * `safeParse` and passes `parsed.error` straight through, so there is no wrapper chain to unwrap.
 * @param error - The Zod validation failure.
 * @param opts - `code` to stamp on the rejection; optional remediation `hint`; optional `input`
 * (the value that failed parsing) enabling measured-size and scalar-echo enrichment.
 * @returns A normalized {@link ToolRejection} built via {@link makeRejection}.
 */
export function rejectionFromZodError(
  error: z.ZodError,
  opts: { code: string; hint?: string; input?: unknown },
): ToolRejection {
  const issuePaths: string[] = [];
  const lines = error.issues.map(issue => {
    if (issue.code === 'invalid_union') {
      const { line, paths } = describeInvalidUnion(issue);
      issuePaths.push(...paths);
      return line;
    }
    const path = issue.path.join('.');
    if (path) issuePaths.push(path);
    let message = issue.message;
    if (opts.input !== undefined) {
      const received = resolveAtPath(opts.input, issue.path);
      if (issue.code === 'too_big' || issue.code === 'too_small') {
        message = describeSizeIssue(issue, received) ?? message;
      } else {
        const echo = scalarEcho(received);
        if (echo !== undefined) message = `${message}; sent: ${echo}`;
      }
    }
    return path ? `${path}: ${message}` : message;
  });
  return makeRejection({
    code: opts.code,
    reason: lines.join('; '),
    hint: opts.hint,
    issuePaths,
  });
}
