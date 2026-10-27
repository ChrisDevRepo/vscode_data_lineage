/** Single typed channel for tool-result rejections, and the one renderer of the problem the model reads (D-103). */
import { z } from 'zod';
import { REJECTION_CODES } from './rejectionCodes';

/** Product limit for a quick missing-content exchange; it does not change validation or reply budgets. */
export const CLARIFICATION_WINDOW_MS = 5000;

/** One fault of a rejection: where it is, its issue code, a short message and, from schema or engine metadata, what the field accepts. */
interface RejectionError {
  path: string;
  code: string;
  message: string;
  /** Any one of these fields can supply the missing decision; valid copies stay held. */
  alternatives?: readonly string[];
  allowed?: readonly string[];
}

/** The one rejection record: stable code, a reason line for logs, and typed machine facts; {@link renderProblem} alone turns it into model feedback. */
export interface ToolRejection {
  /** Stable machine code. */
  code: string;
  /** Human-readable reason line; equals `code` when the emit site states nothing more. */
  reason: string;
  /** Owner guidance rendered as the call-level error. */
  hint?: string;
  /** Structured facts; a fact `{path?, allowed_values | allowed | allowedTools}` supplies the allowed values of that path. */
  detail?: unknown;
  /** Dotted paths of the offending fields; downstream correction-echo and observability read these. */
  issuePaths?: string[];
  /** Exact offending entry ids, for a violation whose offender is an id rather than a field path. */
  entryIds?: readonly string[];
  /** Owner-verified missing authored content held safely for a narrow completion; absent on invalid values or identities. */
  missingParts?: readonly string[];
  /** When the backend owner created this missing-content request; separate from its later delivery to the model. */
  feedbackAt?: string;
  /** Every independently decidable fault, by path and issue code. */
  errors?: RejectionError[];
  /** Top-level fields the model resends; every other field stays held. */
  resend?: string[];
}

/** Engine code carried by the consent gate, which shares the rejection envelope without being one. Reuses {@link REJECTION_CODES.actionRequired} — the one constant every emission site (`start_exploration`'s gate return, the graph's gate detector) interpolates, so a rename cannot drift between them. */
const CONSENT_GATE_CODE = REJECTION_CODES.actionRequired;

/** Reports whether a rejection code is the consent gate rather than a failure. */
export function isConsentGateRejection(code: string): boolean {
  return code === CONSENT_GATE_CODE;
}

/** Whether a rejection-shaped result is an admission refusal: the request ends with the reason shown to the user, so it is a control outcome like a consent gate, not a correction the model owes. */
export function isAdmissionRefusal(code: string): boolean {
  return code === REJECTION_CODES.overActiveScopeBudget;
}

/** Zod view of the {@link makeRejection} shape, parsed once at the read boundary. Strict: the emitter writes exactly these keys, so a success payload carrying any other key is never read as a rejection. */
const RejectionShape = z.object({
  code: z.string(),
  reason: z.string().trim().min(1),
  hint: z.string().optional(),
  detail: z.unknown().optional(),
  issuePaths: z.array(z.string()).optional(),
  entryIds: z.array(z.string()).optional(),
  missingParts: z.array(z.string().min(1)).min(1).optional(),
  feedbackAt: z.string().datetime().optional(),
  errors: z.array(z.object({
    path: z.string(), code: z.string(), message: z.string(),
    alternatives: z.array(z.string()).optional(), allowed: z.array(z.string()).optional(),
  }).strict()).optional(),
  resend: z.array(z.string()).optional(),
}).strict();

/** Write-side builder for the one tool-execution failure envelope both LM lanes record when a handler throws; the run ends on it. Owning it here keeps the graph-owned dispatch result provider-neutral. */
export function buildToolExecutionError(toolName: string): string {
  return JSON.stringify(makeRejection({
    code: REJECTION_CODES.toolExecutionError,
    reason: `${toolName} failed inside the extension.`,
  }));
}

/** Stable message shared by {@link NoProjectLoadedError} and {@link buildNoProjectLoadedError}. */
const NO_PROJECT_LOADED_MESSAGE =
  'No project is loaded in the Data Lineage panel (closed or not opened yet); open the project and ask again.';

/** Thrown by a tool host's `requireModel`/`requireGraph` when no model/graph is loaded — the panel closed mid-turn and cleared them (`panelProvider.ts`'s `onDidDispose`, the one site that nulls them), or an externally registered read tool ran with no project ever opened. Both causes are one true statement, so this is one class and one code rather than a guess at which applied. Distinguished from a generic tool-execution failure so the dispatcher returns a stable, non-retryable rejection instead of a hint that invites correcting input that was never the problem. */
export class NoProjectLoadedError extends Error {
  constructor() {
    super(NO_PROJECT_LOADED_MESSAGE);
    this.name = 'NoProjectLoadedError';
  }
}

/** Rejection for a tool call dispatched with no project loaded. */
export function buildNoProjectLoadedError(): string {
  return JSON.stringify(makeRejection({ code: REJECTION_CODES.noProjectLoaded, hint: NO_PROJECT_LOADED_MESSAGE }));
}

/** Reader: the typed {@link ToolRejection} a tool result carries, or `null` when the payload is not a refusal. Recognizes exactly one shape — the {@link makeRejection} shape every emit site uses. */
export function readToolError(data: unknown): ToolRejection | null {
  const parsed = RejectionShape.safeParse(data);
  if (!parsed.success) return null;
  const { detail, ...rest } = parsed.data;
  return { ...rest, ...(detail !== undefined ? { detail } : {}) };
}

/** Reader over a tool's JSON text: the rejection it carries, or `null` for a result or text that is not JSON. */
export function readToolErrorText(text: string): ToolRejection | null {
  try {
    return readToolError(JSON.parse(text));
  } catch {
    return null;
  }
}
/** Issue-code message table: the one source of model-facing problem prose (D-103). `fallback` is the stage-3 guidance added to a fault at a reference leaf, the same for each (D-105). */
export const PROBLEM_MESSAGES = {
  missing: 'Required; send it.',
  type: 'Wrong type.',
  enum: 'Not an allowed value.',
  unknown_key: 'Not a field here; remove it, or send it under the field it belongs to.',
  size: 'Outside its size bound.',
  never: 'No value is allowed here; remove it.',
  invalid: 'Invalid value.',
  fallback: 'If you cannot correct it, write that information in the detail memory instead, highlighted with a callout naming the unresolved issue.',
} as const;

/** Joins message parts as sentences. */
const sentences = (...parts: Array<string | undefined>): string =>
  parts.filter((part): part is string => !!part).map(part => (/[.!?]$/.test(part) ? part : `${part}.`)).join(' ');

/** The reference leaves of each commit-report tool, numeric segments as `*`: a node or column the backend may not find, which the AI can write in the detail memory instead (D-105). Text fields (they are the detail memory), enums, decisions, ids, structure, read tools and start arguments are absent, so their stage-3 feedback has no fallback. */
const REFERENCE_LEAVES: Readonly<Record<string, ReadonlySet<string>>> = {
  lineage_submit_findings: new Set(['column_flow.*.out_col', 'column_flow.*.writes_to.node', 'column_flow.*.writes_to.col',
    'column_flow.*.upstream_columns.*', 'column_flow.*.upstream_columns.*.node', 'column_flow.*.upstream_columns.*.col']),
  lineage_present_result: new Set(['sections.*.node_ids', 'sections.*.node_ids.*', 'notes.*.node_id',
    'highlight_groups.*.node_ids', 'highlight_groups.*.node_ids.*']),
};

/** Issue codes that never get the fallback: an absent value, or a key or value the schema does not allow at all. */
const NO_FALLBACK_CODES: ReadonlySet<string> = new Set(['missing', 'unknown_key', 'never']);

/** Feedback stage of one hop (D-105): 1 states every fault, 2 adds the allowed values, 3 adds the fallback guidance to faults at reference leaves. */
export type FeedbackStage = 1 | 2 | 3;

/** The slice of a JSON Schema node the renderer reads. */
interface JsonSchemaShape {
  type?: string | string[];
  anyOf?: JsonSchemaShape[];
  oneOf?: JsonSchemaShape[];
  items?: JsonSchemaShape;
  properties?: Record<string, JsonSchemaShape>;
}

/** The node and its union branches. */
const variantsOf = (node: JsonSchemaShape): JsonSchemaShape[] => [node, ...(node.anyOf ?? []), ...(node.oneOf ?? [])];

/** Whether a node accepts `null`. */
const isNullable = (node: JsonSchemaShape): boolean =>
  variantsOf(node).some(variant => variant.type === 'null' || (Array.isArray(variant.type) && variant.type.includes('null')));

/** The input JSON Schema of `schema`, or `undefined` when it has none. */
function inputJsonSchema(schema: z.ZodType | undefined): JsonSchemaShape | undefined {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaShape;
  } catch {
    return undefined;
  }
}

/** The JSON Schema node `path` addresses inside `root`; `undefined` when the path leaves the schema. */
function jsonSchemaNodeAt(root: JsonSchemaShape | undefined, path: readonly PropertyKey[]): JsonSchemaShape | undefined {
  let node = root;
  for (const key of path) {
    node = node && variantsOf(node)
      .map(variant => (typeof key === 'number' ? variant.items : variant.properties?.[String(key)]))
      .find(candidate => candidate !== undefined);
  }
  return node;
}

/** The allowed-value facts of `detail`: `{path?, allowed_values | allowed | allowedTools}`. */
function allowedFacts(detail: unknown): Array<{ path: string; allowed: string[] }> {
  return (Array.isArray(detail) ? detail : [detail]).flatMap(fact => {
    if (!fact || typeof fact !== 'object') return [];
    const { path, allowed_values, allowed, allowedTools } = fact as Record<string, unknown>;
    const values = [allowed_values, allowed, allowedTools].find(Array.isArray);
    return values ? [{ path: typeof path === 'string' ? path.replace(/\[(\d+)\]/g, '.$1') : '', allowed: values.map(String) }] : [];
  });
}

/** Renders one rejection as the problem the model reads: `{code, errors[{path, code, message, allowed?}], resend}`, staged by D-105. Bridge: it adapts the legacy `ToolRejection` record in one step; MW-9 deletes this adapter when handlers emit `ToolProblem` directly. A rejection without errors states its reason at each issue path (or the call), its hint at the call, and its missing parts as missing. */
export function renderProblem(rejection: ToolRejection, stage: FeedbackStage, toolName?: string): string {
  const reason = rejection.reason === rejection.code && rejection.hint ? rejection.hint : rejection.reason;
  const errors = new Map<string, RejectionError>();
  const put = (error: RejectionError): void => {
    const key = `${error.path}|${error.code}`;
    const known = errors.get(key);
    const allowed = known?.allowed || error.allowed ? [...new Set([...(known?.allowed ?? []), ...(error.allowed ?? [])])] : undefined;
    errors.set(key, { path: error.path, code: error.code, message: known?.message ?? error.message, ...(allowed ? { allowed } : {}) });
  };
  if (rejection.errors?.length) rejection.errors.forEach(put);
  const paths = rejection.errors?.length ? [] : [...rejection.issuePaths ?? [], ...rejection.entryIds ?? []];
  for (const path of paths) put({ path, code: rejection.code, message: reason });
  const call = [...(rejection.errors?.length || paths.length ? [] : [reason]), ...(rejection.hint && rejection.hint !== reason ? [rejection.hint] : [])];
  if (call.length) put({ path: '', code: rejection.code, message: call.join(' ') });
  for (const part of rejection.missingParts ?? []) if (![...errors.values()].some(error => error.path === part)) put({ path: part, code: 'missing', message: PROBLEM_MESSAGES.missing });
  for (const fact of allowedFacts(rejection.detail)) {
    const owners = [...errors.values()].filter(error => error.path === fact.path);
    for (const owner of owners.length ? owners : [{ path: fact.path, code: 'enum', message: PROBLEM_MESSAGES.enum }]) put({ ...owner, allowed: fact.allowed });
  }
  const instructed = new Set<string>(), leaves = toolName ? REFERENCE_LEAVES[toolName] : undefined;
  const withFallback = (path: string, code: string, message: string): string => {
    if (stage < 3 || !leaves?.has(path.replace(/(^|\.)\d+(?=\.|$)/g, '$1*')) || NO_FALLBACK_CODES.has(code) || instructed.has(path)) return message;
    instructed.add(path);
    return sentences(message, PROBLEM_MESSAGES.fallback);
  };
  return JSON.stringify({ code: rejection.code,
    errors: [...errors.values()].map(({ path, code, message, allowed }) => ({ path, code, message: withFallback(path, code, message),
      ...(stage >= 2 && allowed ? { allowed } : {}) })),
    resend: rejection.resend ?? [] });
}

/** Union independently assessed refusals without interpreting rejected arguments or reason prose. */
export function combineToolRejections(rejections: readonly ToolRejection[], hint?: string): ToolRejection {
  if (rejections.length === 0) throw new Error('Cannot combine an empty rejection set.');
  const details = rejections.flatMap(rejection => rejection.detail === undefined ? []
    : Array.isArray(rejection.detail) ? rejection.detail : [rejection.detail]);
  return makeRejection({
    code: rejections.some(rejection => rejection.code === REJECTION_CODES.invalidInput) ? REJECTION_CODES.invalidInput : rejections[0].code,
    reason: [...new Set(rejections.map(rejection => rejection.reason))].join('\n'),
    hint: [...new Set([...rejections.flatMap(rejection => rejection.hint ? [rejection.hint] : []), ...(hint ? [hint] : [])])].join(' ') || undefined,
    issuePaths: rejections.flatMap(rejection => rejection.issuePaths ?? []),
    entryIds: [...new Set(rejections.flatMap(rejection => rejection.entryIds ?? []))],
    ...(details.length ? { detail: [...new Map(details.map(detail => [JSON.stringify(detail), detail])).values()] } : {}),
    errors: [...new Map(rejections.flatMap(rejection => rejection.errors ?? []).map(error => [`${error.path}|${error.code}|${error.message}`, error])).values()],
    resend: [...new Set(rejections.flatMap(rejection => rejection.resend ?? []))],
  });
}

/** Longest one dotted-path segment: an identifier, or an index. */
const MAX_PATH_SEGMENT_CHARS = 100;
/** One dotted-path segment: an identifier of at most {@link MAX_PATH_SEGMENT_CHARS} chars, or an index. */
const PATH_SEGMENT = `(?:[A-Za-z_][A-Za-z0-9_-]{0,${MAX_PATH_SEGMENT_CHARS - 1}}|\\d+)`;
/** Dotted identifier grammar every recorded issue path must match: safe to log where prose is not allowed. */
const ISSUE_PATH_GRAMMAR = new RegExp(`^${PATH_SEGMENT}(?:\\.${PATH_SEGMENT})*$`);

/** The one producer of a {@link ToolRejection}. Trims `reason` (default: the `code`) and throws when the trimmed value is empty — an empty-reason reject is unrepresentable (make-illegal-states-unrepresentable), since a rejection the model cannot read is indistinguishable from a silent hang. `issuePaths` keep only dotted-identifier paths, deduped and bounded, so a model-controlled key can never reach a record that forbids prose. */
export function makeRejection(input: {
  code: string;
  reason?: string;
  hint?: string;
  detail?: unknown;
  issuePaths?: readonly string[];
  entryIds?: readonly string[];
  missingParts?: readonly string[];
  errors?: readonly RejectionError[];
  resend?: readonly string[];
}): ToolRejection {
  const reason = (input.reason ?? input.code).trim();
  if (!reason) throw new Error('makeRejection: reason must not be empty');
  const issuePaths = [...new Set(input.issuePaths ?? [])].filter((path) => ISSUE_PATH_GRAMMAR.test(path));
  return {
    code: input.code,
    reason,
    ...(input.hint !== undefined ? { hint: input.hint } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(issuePaths.length > 0 ? { issuePaths } : {}),
    ...(input.entryIds?.length ? { entryIds: [...input.entryIds] } : {}),
    ...(input.missingParts?.length ? { missingParts: [...input.missingParts], feedbackAt: new Date().toISOString() } : {}),
    ...(input.errors?.length ? { errors: [...input.errors] } : {}),
    ...(input.resend !== undefined || input.errors?.length ? { resend: [...(input.resend ?? [])] } : {}),
  };
}

/** Longest object key named in a path; a longer key is reported at its container, never as a prefix. */
const KEY_ECHO_MAX_CHARS = 120;

/** Walks `input` down one Zod issue path; `undefined` when the path leaves the object graph. */
function resolveAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let value: unknown = input;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key as keyof object];
  }
  return value;
}

/** The measured size against the bound of a size issue (models cannot count characters); `undefined` when unmeasurable or when the raw value met the bound before a schema transform. The value itself is never echoed. */
function describeSizeIssue(issue: Extract<z.core.$ZodIssue, { code: 'too_big' | 'too_small' }>, received: unknown): string | undefined {
  const size = typeof received === 'string' ? { amount: received.length, text: `${received.length} chars` }
    : Array.isArray(received) ? { amount: received.length, text: `${received.length} items` }
      : typeof received === 'number' ? { amount: received, text: `${received}` } : undefined;
  if (size === undefined) return undefined;
  const inclusive = issue.inclusive ?? true;
  const limit = Number(issue.code === 'too_big' ? issue.maximum : issue.minimum);
  const fails = issue.code === 'too_big'
    ? (inclusive ? size.amount > limit : size.amount >= limit)
    : (inclusive ? size.amount < limit : size.amount <= limit);
  if (!fails) return undefined;
  const bound = issue.code === 'too_big'
    ? (inclusive ? `limit ${issue.maximum}` : `less than ${issue.maximum}`)
    : (inclusive ? `minimum ${issue.minimum}` : `more than ${issue.minimum}`);
  return `${size.text}, ${bound}`;
}

/** The message of a wrong-type issue: a structured field sent as JSON text is named as such; otherwise the expected type from the schema. */
function typeMessage(issue: Extract<z.core.$ZodIssue, { code: 'invalid_type' }>, received: unknown, node: JsonSchemaShape | undefined): string {
  if ((issue.expected === 'array' || issue.expected === 'object') && typeof received === 'string' && /^\s*[[{]/.test(received)) {
    const kind = received.trimStart().startsWith('[') ? 'array' : 'object';
    try {
      JSON.parse(received);
      return `Received stringified JSON; send a native JSON ${kind}.`;
    } catch {
      return `Received ${received.length} characters of text that is not valid JSON; send one complete JSON ${kind}, with line breaks inside strings written as \\n.`;
    }
  }
  const expected = issue.expected === 'number' && node && variantsOf(node).some(variant => variant.type === 'integer') ? 'integer' : issue.expected;
  return `${PROBLEM_MESSAGES.type} Expected ${expected}${node && isNullable(node) ? ' or null' : ''}.`;
}

/** The faults of a Zod failure, one per path and issue code, with their messages from {@link PROBLEM_MESSAGES} and schema metadata; union alternatives contribute their leaf issues and merge the values they accept. An absent value is `missing`, whatever the issue. */
function zodProblemErrors(error: z.ZodError, input: unknown, root: JsonSchemaShape | undefined): RejectionError[] {
  const errors = new Map<string, RejectionError>();
  const add = (path: readonly PropertyKey[], code: string, message: string, allowed?: readonly string[]): void => {
    const joined = path.join('.');
    const known = errors.get(`${joined}|${code}`);
    const merged = known?.allowed || allowed ? [...new Set([...(known?.allowed ?? []), ...(allowed ?? [])])] : undefined;
    errors.set(`${joined}|${code}`, { path: joined, code, message: known?.message ?? message, ...(merged ? { allowed: merged } : {}) });
  };
  const visit = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[]): void => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path];
      const received = resolveAtPath(input, path);
      if (issue.code === 'invalid_union') {
        for (const alternative of issue.errors) visit(alternative, path);
      } else if (issue.code === 'unrecognized_keys') {
        const allowed = Object.keys(jsonSchemaNodeAt(root, path)?.properties ?? {});
        for (const key of issue.keys) add(key.length > KEY_ECHO_MAX_CHARS ? path : [...path, key], 'unknown_key', PROBLEM_MESSAGES.unknown_key, allowed.length ? allowed : undefined);
      } else if (input !== undefined && received === undefined && path.length > 0) {
        add(path, 'missing', issue.code === 'custom' ? sentences(issue.message, (issue.params as { hint?: string } | undefined)?.hint) : PROBLEM_MESSAGES.missing);
      } else if ((issue.code === 'too_big' || issue.code === 'too_small') && issues.some(other => other.code === 'invalid_type' && other.path.join('.') === issue.path.join('.'))) {
        continue;
      } else if (issue.code === 'invalid_type') {
        if (issue.expected === 'never') add(path, 'never', PROBLEM_MESSAGES.never, []);
        else add(path, 'type', typeMessage(issue, received, jsonSchemaNodeAt(root, path)));
      } else if (issue.code === 'invalid_value') {
        add(path, 'enum', PROBLEM_MESSAGES.enum, issue.values.map(String));
      } else if (issue.code === 'too_big' || issue.code === 'too_small') {
        const measured = describeSizeIssue(issue, received);
        add(path, 'size', measured ? `${PROBLEM_MESSAGES.size} ${measured}.` : issue.message);
      } else if (issue.code === 'custom') {
        const params = issue.params as { allowed_values?: string[]; hint?: string } | undefined;
        add(path, params?.allowed_values ? 'enum' : 'invalid', sentences(issue.message, params?.hint), params?.allowed_values);
      } else {
        add(path, 'invalid', issue.message || PROBLEM_MESSAGES.invalid);
      }
    }
  };
  visit(error.issues, []);
  return [...errors.values()];
}

/** The one Zod-failure rejection: every fault as an error by path and issue code; the reason lists them for logs. */
export function rejectionFromZodError(error: z.ZodError, opts: { code: string; hint?: string; input?: unknown; schema?: z.ZodType }): ToolRejection {
  const errors = zodProblemErrors(error, opts.input, inputJsonSchema(opts.schema));
  return makeRejection({
    code: opts.code,
    reason: errors.map(fault => (fault.path ? `${fault.path}: ${fault.message}` : fault.message)).join('\n'),
    hint: opts.hint,
    issuePaths: errors.map(fault => fault.path),
    errors,
  });
}
