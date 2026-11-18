/**
 * Single typed channel for tool-result rejections.
 *
 * @remarks
 * Every tool, guard and engine refusal is emitted by {@link makeRejection} in one shape —
 * `{ code, reason, hint?, detail?, issuePaths?, entryIds? }` — and serialized as the
 * tool result. {@link readToolError} reads that shape back. Provider-pure.
 */
import { z } from 'zod';
import { REJECTION_CODES } from './rejectionCodes';

const ISSUE_CATEGORIES = ['shape', 'required', 'reference', 'value', 'protocol', 'stage'] as const;
type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

/** The fixed category of one issue code. */
interface IssueText {
  readonly category: IssueCategory;
}

type RegistryCode = (typeof REJECTION_CODES)[keyof typeof REJECTION_CODES];
/** Codes of a schema fault, mapped from Zod issue codes by {@link rejectionFromZodError}. */
type SchemaIssueCode = 'type' | 'unknown_key' | 'never' | 'missing' | 'enum' | 'size' | 'invalid';

/**
 * Every issue code's fixed category: each registry code and each schema fault code. A fault on a
 * rejection's `errors` names one of these keys.
 */
export const ISSUES = {
  type: { category: 'shape' },
  unknown_key: { category: 'shape' },
  never: { category: 'shape' },
  missing: { category: 'required' },
  enum: { category: 'value' },
  size: { category: 'value' },
  invalid: { category: 'value' },
  [REJECTION_CODES.offPolicy]: { category: 'stage' },
  [REJECTION_CODES.alreadyStarted]: { category: 'protocol' },
  [REJECTION_CODES.duplicateCallId]: { category: 'protocol' },
  [REJECTION_CODES.emptyGeneration]: { category: 'stage' },
  [REJECTION_CODES.duplicateRead]: { category: 'protocol' },
  [REJECTION_CODES.noRunMemory]: { category: 'stage' },
  [REJECTION_CODES.staleTurn]: { category: 'stage' },
  [REJECTION_CODES.invalidInput]: { category: 'value' },
  [REJECTION_CODES.notFound]: { category: 'reference' },
  [REJECTION_CODES.supplementRequiresCompleteEngine]: { category: 'stage' },
  [REJECTION_CODES.supplementEmpty]: { category: 'value' },
  [REJECTION_CODES.supplementAllRefused]: { category: 'reference' },
  [REJECTION_CODES.invalidRegex]: { category: 'value' },
  [REJECTION_CODES.overDiscoveryBudget]: { category: 'stage' },
  [REJECTION_CODES.overActiveScopeBudget]: { category: 'stage' },
  [REJECTION_CODES.actionRequired]: { category: 'stage' },
  [REJECTION_CODES.missingField]: { category: 'required' },
  [REJECTION_CODES.ctFieldForbiddenInBb]: { category: 'value' },
  [REJECTION_CODES.noActiveSession]: { category: 'stage' },
  [REJECTION_CODES.noProjectLoaded]: { category: 'stage' },
  [REJECTION_CODES.staleProposalRevision]: { category: 'protocol' },
  [REJECTION_CODES.routeValidationFailed]: { category: 'reference' },
  [REJECTION_CODES.outColNotOnNode]: { category: 'reference' },
  [REJECTION_CODES.outColNotTracked]: { category: 'reference' },
  [REJECTION_CODES.contributorColNotOnSource]: { category: 'reference' },
  [REJECTION_CODES.continuationNotWriter]: { category: 'reference' },
  [REJECTION_CODES.columnSelfLoop]: { category: 'value' },
  [REJECTION_CODES.writesToNamesReader]: { category: 'reference' },
  [REJECTION_CODES.prunedContributor]: { category: 'reference' },
  [REJECTION_CODES.columnOutOfScope]: { category: 'reference' },
  [REJECTION_CODES.emptyStructuredOutput]: { category: 'stage' },
  [REJECTION_CODES.missingRequiredToolCall]: { category: 'stage' },
  [REJECTION_CODES.toolExecutionError]: { category: 'stage' },
  [REJECTION_CODES.internalError]: { category: 'stage' },
  [REJECTION_CODES.engineCrash]: { category: 'stage' },
  [REJECTION_CODES.validation]: { category: 'value' },
  [REJECTION_CODES.invalidStatus]: { category: 'stage' },
  [REJECTION_CODES.explorationComplete]: { category: 'stage' },
  [REJECTION_CODES.focusNodeIdMismatch]: { category: 'reference' },
  [REJECTION_CODES.invalidToolInput]: { category: 'shape' },
  [REJECTION_CODES.toolCallNotation]: { category: 'shape' },
  [REJECTION_CODES.unknownTool]: { category: 'stage' },
  [REJECTION_CODES.invalidStructuredOutput]: { category: 'shape' },
  [REJECTION_CODES.notConnectedToTrace]: { category: 'reference' },
  [REJECTION_CODES.extraCallNotEvaluated]: { category: 'protocol' },
  [REJECTION_CODES.invalidPendingLead]: { category: 'reference' },
  [REJECTION_CODES.missingResultGraph]: { category: 'stage' },
  [REJECTION_CODES.noOpRefine]: { category: 'protocol' },
  [REJECTION_CODES.originNotFound]: { category: 'reference' },
  [REJECTION_CODES.outOfScopeOrNotNeighbor]: { category: 'reference' },
  [REJECTION_CODES.parallelCallForbidden]: { category: 'protocol' },
  [REJECTION_CODES.phaseClosed]: { category: 'protocol' },
  [REJECTION_CODES.previewSourceUnavailable]: { category: 'stage' },
  [REJECTION_CODES.queryNotAName]: { category: 'value' },
  [REJECTION_CODES.queryTooShort]: { category: 'value' },
  [REJECTION_CODES.resultTooLarge]: { category: 'stage' },
  [REJECTION_CODES.unknownColumns]: { category: 'reference' },
  [REJECTION_CODES.unknownNodeIds]: { category: 'reference' },
  [REJECTION_CODES.asymmetricDepthBothZero]: { category: 'value' },
} as const satisfies Record<RegistryCode | SchemaIssueCode, IssueText>;

/** Closed set of issue codes a fault may carry. */
export type IssueCode = keyof typeof ISSUES;
const ISSUE_CODES = Object.keys(ISSUES) as [IssueCode, ...IssueCode[]];

/**
 * One independently decidable fault: its dotted path and issue code, with the backend facts it
 * concerns (allowed `values`, accepted `types`, a size `bound`), never a submitted value.
 */
const ToolErrorShape = z.object({
  path: z.string(),
  code: z.enum(ISSUE_CODES),
  values: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  bound: z.object({ keyword: z.string().min(1), limit: z.number(), sent: z.number().int().nonnegative().optional() }).strict().optional(),
}).strict();

/** One fault of a rejection. */
export type ToolError = z.infer<typeof ToolErrorShape>;

/** The one rejection shape: what was wrong (`reason`), how to repair it (`hint`), machine facts. */
export interface ToolRejection {
  /** Stable machine code. */
  code: string;
  /** Human-readable reason line; equals `code` when the emit site states nothing more. */
  reason: string;
  /** Optional remediation hint the model should act on next round. */
  hint?: string;
  /** Structured dispatcher facts retained for bounded graph-owned correction projection. */
  detail?: unknown;
  /** Dotted paths of the offending fields; correction-echo and observability read them. */
  issuePaths?: string[];
  /** Exact offending entry ids, for a violation whose offender is an id, not a field path. */
  entryIds?: readonly string[];
  /** Every independent fault, by path and issue code. */
  errors?: ToolError[];
}

/**
 * Engine code carried by the consent gate, which shares the rejection envelope without being one.
 * Reuses {@link REJECTION_CODES.actionRequired} — the one constant every emission site
 * (`start_exploration`'s gate return, the graph's gate detector) interpolates, so a rename cannot
 * drift between them.
 */
const CONSENT_GATE_CODE = REJECTION_CODES.actionRequired;

/**
 * Whether a rejection code is the consent gate rather than a failure. The gate reuses the rejection
 * envelope so one dispatch path serves both, but is never charged against the semantic budget or
 * rendered as a failure; every surface separating the two reads this predicate.
 *
 * @param code - Rejection code from {@link readToolError}.
 */
export function isConsentGateRejection(code: string): boolean {
  return code === CONSENT_GATE_CODE;
}

/**
 * Zod view of the {@link makeRejection} shape, parsed once at the read boundary. Strict: the
 * emitter writes exactly these keys, so a success payload carrying any other key is never read as a
 * rejection.
 */
const RejectionShape = z.object({
  code: z.string(),
  reason: z.string().trim().min(1),
  hint: z.string().optional(),
  detail: z.unknown().optional(),
  issuePaths: z.array(z.string()).optional(),
  entryIds: z.array(z.string()).optional(),
  errors: z.array(ToolErrorShape).optional(),
}).strict();

/**
 * Write-side builder for the one tool-execution failure envelope both LM lanes record when a
 * handler throws; the run ends on it. Owning it here keeps the graph-owned dispatch result
 * provider-neutral.
 * @param toolName - Canonical tool name whose handler threw.
 * @returns Generic JSON rejection safe to project into graph attempt state.
 */
export function buildToolExecutionError(toolName: string): string {
  return JSON.stringify(makeRejection({
    code: REJECTION_CODES.toolExecutionError,
    reason: `${toolName} failed inside the extension.`,
  }));
}

/** Stable message shared by {@link NoProjectLoadedError} and {@link buildNoProjectLoadedError}. */
const NO_PROJECT_LOADED_MESSAGE =
  'No project is loaded in the Data Lineage panel (closed or not opened yet); open the project and ask again.';

/**
 * Thrown by a tool host's `requireModel`/`requireGraph` when no model/graph is loaded: the panel
 * closed mid-turn and cleared them (`panelProvider.ts`'s `onDidDispose`, the one site that nulls
 * them), or an external read tool ran with no project opened. One class and one code, not a guess
 * at the cause. Distinct from a generic execution failure so the dispatcher returns a stable,
 * non-retryable rejection instead of a hint inviting correction of input that was never the
 * problem.
 */
export class NoProjectLoadedError extends Error {
  constructor() {
    super(NO_PROJECT_LOADED_MESSAGE);
    this.name = 'NoProjectLoadedError';
  }
}

/**
 * Rejection for a tool call dispatched with no project loaded.
 * @returns JSON rejection carrying {@link REJECTION_CODES.noProjectLoaded} and the stable hint.
 */
export function buildNoProjectLoadedError(): string {
  return JSON.stringify(makeRejection({ code: REJECTION_CODES.noProjectLoaded, hint: NO_PROJECT_LOADED_MESSAGE }));
}

/**
 * Reader: the typed {@link ToolRejection} a tool result carries, or `null` when the payload is not
 * a refusal. Recognizes exactly one shape — the {@link makeRejection} shape every emit site uses.
 *
 * @param data - Parsed untrusted tool result.
 * @returns The rejection, or `null` for a successful/non-rejection result.
 */
export function readToolError(data: unknown): ToolRejection | null {
  const parsed = RejectionShape.safeParse(data);
  if (!parsed.success) return null;
  const { detail, ...rest } = parsed.data;
  return { ...rest, ...(detail !== undefined ? { detail } : {}) };
}

/** Longest one dotted-path segment: an identifier, or an index. */
const MAX_PATH_SEGMENT_CHARS = 100;
/**
 * One dotted-path segment: an identifier up to {@link MAX_PATH_SEGMENT_CHARS} chars, or an index.
 */
const PATH_SEGMENT = `(?:[A-Za-z_][A-Za-z0-9_-]{0,${MAX_PATH_SEGMENT_CHARS - 1}}|\\d+)`;
/** Dotted identifier grammar every recorded issue path must match; safe to log, unlike prose. */
const ISSUE_PATH_GRAMMAR = new RegExp(`^${PATH_SEGMENT}(?:\\.${PATH_SEGMENT})*$`);

/**
 * Faults sharing a path and code are one fault; a `required` fault keeps its subjects apart, so
 * distinct raw faults stay distinct. Listed values merge.
 */
function mergeToolErrors(errors: readonly ToolError[]): ToolError[] {
  const merged = new Map<string, ToolError>();
  for (const error of errors) {
    const subjects = ISSUES[error.code].category === 'required' ? [...new Set(error.values ?? [])].sort() : undefined;
    const key = JSON.stringify([error.path, error.code, subjects]);
    const known = merged.get(key);
    const values = known?.values || error.values ? [...new Set([...(known?.values ?? []), ...(error.values ?? [])])] : undefined;
    merged.set(key, { ...known, ...error, ...(values ? { values } : {}) });
  }
  return [...merged.values()];
}

/**
 * The one producer of a {@link ToolRejection}. Trims `reason` (default: the `code`) and throws when
 * it is empty: a rejection the model cannot read is indistinguishable from a silent hang, so an
 * empty-reason reject is unrepresentable. `errors` merge per path and code; a path outside the
 * dotted grammar becomes the call itself (`''`). `issuePaths` default to the error paths and keep
 * only dotted-identifier paths, deduped and bounded, so a model-controlled key never reaches a
 * record that forbids prose.
 */
export function makeRejection(input: {
  code: string;
  reason?: string;
  hint?: string;
  detail?: unknown;
  issuePaths?: readonly string[];
  entryIds?: readonly string[];
  errors?: readonly ToolError[];
}): ToolRejection {
  const reason = (input.reason ?? input.code).trim();
  if (!reason) throw new Error('makeRejection: reason must not be empty');
  const errors = mergeToolErrors((input.errors ?? []).map(error =>
    (error.path === '' || ISSUE_PATH_GRAMMAR.test(error.path) ? error : { ...error, path: '' })));
  const issuePaths = [...new Set(input.issuePaths ?? errors.map(error => error.path))]
    .filter((path) => ISSUE_PATH_GRAMMAR.test(path));
  return {
    code: input.code,
    reason,
    ...(input.hint !== undefined ? { hint: input.hint } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(issuePaths.length > 0 ? { issuePaths } : {}),
    ...(input.entryIds?.length ? { entryIds: [...input.entryIds] } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * Unions independently assessed faults into one rejection (one rejection is its own union): reasons
 * one per line, distinct hints, every path, entry id, detail and fault. An `invalid_input` fault owns the outcome code, else the
 * first rejection's code does.
 */
export function combineToolRejections(rejections: readonly ToolRejection[]): ToolRejection {
  if (rejections.length === 0) throw new Error('Cannot combine an empty rejection set.');
  if (rejections.length === 1) return rejections[0];
  const details = rejections.flatMap(rejection =>
    (rejection.detail === undefined ? [] : Array.isArray(rejection.detail) ? rejection.detail : [rejection.detail]));
  const hints = [...new Set(rejections.flatMap(rejection => rejection.hint ?? []))];
  return makeRejection({
    code: rejections.some(rejection => rejection.code === REJECTION_CODES.invalidInput)
      ? REJECTION_CODES.invalidInput
      : rejections[0].code,
    reason: [...new Set(rejections.map(rejection => rejection.reason))].join('\n'),
    ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
    issuePaths: rejections.flatMap(rejection => rejection.issuePaths ?? []),
    entryIds: rejections.flatMap(rejection => rejection.entryIds ?? []),
    ...(details.length > 0 ? { detail: [...new Map(details.map(detail => [JSON.stringify(detail), detail])).values()] } : {}),
    errors: rejections.flatMap(rejection => rejection.errors ?? []),
  });
}

/**
 * Narrowed view of a Zod v4 `invalid_union` issue. Its `errors` field holds one sub-issue array per
 * union branch — the raw material {@link describeInvalidUnion} expands into a per-branch required-
 * field breakdown. (Zod v4 renamed the v3 `unionErrors: ZodError[]` shape to `errors:
 * $ZodIssue[][]`.)
 */
type InvalidUnionIssue = Extract<z.core.$ZodIssue, { code: 'invalid_union' }>;

/**
 * Enriches one Zod issue's message with the measured size against the bound for
 * `too_big`/`too_small` (models cannot count characters), and names a structured field that
 * arrived as text that is not valid JSON. The received value is never echoed: the
 * rejected call stays in the transcript with its arguments.
 */
function enrichedIssueMessage(issue: z.core.$ZodIssue, received: unknown): string {
  if (issue.code === 'too_big' || issue.code === 'too_small') {
    return describeSizeIssue(issue, received) ?? issue.message;
  }
  if (issue.code === 'invalid_type' && typeof received === 'string' && /^\s*[[{]/.test(received)) {
    const kind = received.trimStart().startsWith('[') ? 'array' : 'object';
    return `received ${received.length} characters of text that is not valid JSON. Send it again as one complete JSON ${kind}, with line breaks inside strings written as \\n.`;
  }
  return baseIssueMessage(issue);
}

/**
 * Describes one union branch: its deduped required-field names (first-seen order, prefixed with the
 * union issue's own path so a nested union reads as a full path from the payload root) and one
 * model-facing line per sub-issue: the bare dotted path when absent from `input` (the missing name
 * is the defect), else `"<path>: <enriched message>"` when present but matching no branch (e.g.
 * `depth: Invalid input: expected number, received string`). Without the defect message a scalar
 * union collapses to `variant 1: depth; variant 2: depth`, naming the field but not the defect, and
 * the model regenerates the identical call blind.
 */
function describeUnionBranch(
  branchIssues: readonly z.core.$ZodIssue[],
  basePath: readonly PropertyKey[],
  input: unknown,
): { fields: string[]; descriptors: string[] } {
  const fields: string[] = [];
  const descriptors: string[] = [];
  for (const sub of branchIssues) {
    const full = [...basePath, ...sub.path];
    const field = full.join('.') || '(root)';
    if (!fields.includes(field)) fields.push(field);
    const received = input === undefined ? undefined : resolveAtPath(input, full);
    descriptors.push(received === undefined ? field : `${field}: ${enrichedIssueMessage(sub, received)}`);
  }
  return { fields, descriptors };
}

/**
 * Splices nested `invalid_union` sub-issues in place so every branch is one leaf alternative: Zod
 * wrappers such as `.nullable()` compile to a union whose first branch is the authored union, and
 * an authored union may nest too. Unspliced, the nested level adds a `"Invalid input"` variant
 * naming no field or defect, and variant numbering miscounts. A branch mixing nested-union and leaf
 * sub-issues keeps its leaves as one branch beside the spliced ones. Bounded by the schema's static
 * nesting.
 *
 * @param prefix - Path of the nested union being spliced, relative to the outermost union's path,
 *   rebased onto every leaf so a union on a named field (`depth.upstream`) keeps that field in the
 *   reason and `issuePaths` (a collapsed parent name resolves to the wrong value when the message
 *   is enriched).
 */
function flattenUnionBranches(
  issue: InvalidUnionIssue,
  prefix: readonly PropertyKey[] = [],
): (readonly z.core.$ZodIssue[])[] {
  const out: (readonly z.core.$ZodIssue[])[] = [];
  for (const branch of issue.errors.length > 0 ? issue.errors : [[]]) {
    const leaves: z.core.$ZodIssue[] = [];
    let spliced = false;
    for (const sub of branch) {
      if (sub.code === 'invalid_union') {
        out.push(...flattenUnionBranches(sub, [...prefix, ...sub.path]));
        spliced = true;
      } else {
        leaves.push(prefix.length > 0 ? { ...sub, path: [...prefix, ...sub.path] } : sub);
      }
    }
    if (leaves.length > 0 || !spliced) out.push(leaves);
  }
  return out;
}

/**
 * Shared fragment naming a field the model never sent at all, reused by every rejection surface
 * that tells a missing field apart from one merely typed wrong ({@link missingFieldRepairHint},
 * {@link describeInvalidUnion}) — one wording, not a second phrase invented per call site.
 */
const MISSING_FIELD_FRAGMENT = 'missing entirely from this call';

/**
 * One union branch's text: the comma-joined descriptors, except a branch reducing to exactly one
 * bare (missing) field, which states that the field is required and absent rather than leaving a
 * lone dotted name to be read as the defect. Several fields, or one present-but-wrong-type field,
 * keep {@link describeUnionBranch}'s listing.
 */
function describeUnionBranchText(descriptors: string[]): string {
  if (descriptors.length === 0) return '(no field detail)';
  if (descriptors.length === 1 && !descriptors[0].includes(':')) {
    return `${descriptors[0]} is required and ${MISSING_FIELD_FRAGMENT}`;
  }
  return descriptors.join(', ');
}

/**
 * Expands one `invalid_union` issue into a mechanical "no variant matched" reason naming every
 * branch's required fields, plus the flattened, first-branch-first paths for `issuePaths`. Derived
 * purely from the ZodError's issue tree (no per-tool text), so it is generic across union schemas
 * (BB/CT `submit_findings`, entry-detection). Branches whose rendered text is byte-identical
 * collapse to one numbered entry; repeating a line under a second variant number adds nothing.
 *
 * @param input - The failed value, when available; enables per-field defect enrichment
 *   ({@link describeUnionBranch}).
 */
function describeInvalidUnion(issue: InvalidUnionIssue, input?: unknown): { line: string; paths: string[] } {
  const allPaths: string[] = [];
  const branchTexts: string[] = [];
  for (const branchIssues of flattenUnionBranches(issue)) {
    const { fields, descriptors } = describeUnionBranch(branchIssues, issue.path, input);
    for (const field of fields) if (!allPaths.includes(field)) allPaths.push(field);
    const text = describeUnionBranchText(descriptors);
    if (!branchTexts.includes(text)) branchTexts.push(text);
  }
  const branches = branchTexts.map((text, i) => `variant ${i + 1}: ${text}`);
  return {
    line: `input matched no variant; supply all required fields of one variant — ${branches.join('; ')}`,
    paths: allPaths,
  };
}

/**
 * The generic resend rule of a schema-invalid tool call whose tool holds no draft: the complete
 * call is resent with a minimal edit. It is the only resend directive a rejection carries; a tool
 * that holds a draft states its own held rule in its place.
 */
export const INVALID_TOOL_INPUT_REPAIR_HINT
  = 'Resend the full tool call with only the offending field(s) corrected; keep every other field unchanged, and resend every element of a corrected list, repeating the unflagged elements exactly as first sent.';

/**
 * The distinct offending key(s) of every `unrecognized_keys` issue on `error`.
 *
 * @returns The offending key names, empty when `error` carries no `unrecognized_keys` issue.
 */
function zodUnrecognizedKeys(error: z.ZodError): string[] {
  return [...new Set(
    error.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' ? issue.keys : [])),
  )];
}

/** The message of one Zod issue, with an `unrecognized_keys` echo of every offending key whole. */
function baseIssueMessage(issue: z.core.$ZodIssue): string {
  return issue.code === 'unrecognized_keys'
    ? `Unrecognized key${issue.keys.length > 1 ? 's' : ''}: ${issue.keys.map(quoteKey).join(', ')}`
    : issue.message;
}

/** The slice of a JSON Schema node the repair hints read. */
interface JsonSchemaShape {
  type?: string | string[];
  anyOf?: JsonSchemaShape[];
  oneOf?: JsonSchemaShape[];
  items?: JsonSchemaShape;
  properties?: Record<string, JsonSchemaShape>;
  required?: string[];
  enum?: unknown[];
  minItems?: number;
}

/** A Zod issue path as the model reads it: `sections[2].blocks`. */
function dottedPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, key) => (typeof key === 'number' ? `${acc}[${key}]` : acc ? `${acc}.${String(key)}` : String(key)), '');
}

/** The JSON Schema node `path` addresses in `schema`; `undefined` if the path leaves the schema. */
function jsonSchemaNodeAt(schema: z.ZodType | undefined, path: readonly PropertyKey[]): JsonSchemaShape | undefined {
  if (!schema) return undefined;
  const variantsOf = (node: JsonSchemaShape): JsonSchemaShape[] => [node, ...(node.anyOf ?? []), ...(node.oneOf ?? [])];
  let node = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaShape;
  for (const key of path) {
    const next: JsonSchemaShape | undefined = variantsOf(node)
      .map((variant) => (typeof key === 'number' ? variant.items : variant.properties?.[String(key)]))
      .find((candidate) => candidate !== undefined);
    if (!next) return undefined;
    node = next;
  }
  return node;
}

/** Non-null branch of a nullable node (`anyOf: [X, {type: 'null'}]`); any other node unchanged. */
function unwrapNullable(node: JsonSchemaShape): JsonSchemaShape {
  const branches = node.anyOf;
  if (!branches) return node;
  const nonNull = branches.filter((branch) => branch.type !== 'null');
  return nonNull.length === 1 && nonNull.length < branches.length ? nonNull[0]! : node;
}

/**
 * A literal value the node accepts, built from the schema alone: an enum's first member, a
 * placeholder for a scalar type, and the required members of an object.
 */
function exampleOf(node: JsonSchemaShape): unknown {
  const target = unwrapNullable(node);
  if (target.enum?.length) return target.enum[0];
  if (target.properties) {
    const keys = target.required ?? Object.keys(target.properties);
    return Object.fromEntries(keys.map(key => [key, exampleOf(target.properties![key] ?? {})]));
  }
  const type = Array.isArray(target.type) ? target.type[0] : target.type;
  if (type === 'array') return [];
  return type === 'number' || type === 'integer' ? 0 : type === 'boolean' ? false : '...';
}

/** Whether the schema accepts `null` at `path`. */
function acceptsNullAt(schema: z.ZodType | undefined, path: readonly PropertyKey[]): boolean {
  const node = jsonSchemaNodeAt(schema, path);
  if (!node) return false;
  return [node, ...(node.anyOf ?? []), ...(node.oneOf ?? [])]
    .some((variant) => variant.type === 'null' || (Array.isArray(variant.type) && variant.type.includes('null')));
}

/**
 * Hint for `unrecognized_keys` issues: the key is no field, and the fields of the object it sits in
 * are named so a misspelt key is renamed and an invented one dropped (the call itself is the object
 * for a root issue). A root key that a list entry of the call defines is answered with that list,
 * so a flattened entry is moved back instead of dropped.
 *
 * @returns The object-directed hint; `undefined` when the schema is absent or does not resolve the
 *   object, so the caller keeps the key-only wording.
 */
function objectKeyRemovalHint(error: z.ZodError, schema: z.ZodType | undefined): string | undefined {
  const issues = error.issues.filter((issue) => issue.code === 'unrecognized_keys');
  if (issues.length === 0) return undefined;
  const clauses = new Map<string, { keys: Set<string>; allowed: string[] }>();
  const homes = new Map<string, Set<string>>();
  for (const issue of issues) {
    const node = jsonSchemaNodeAt(schema, issue.path);
    const properties = (node ? unwrapNullable(node) : undefined)?.properties ?? {};
    const allowed = Object.keys(properties);
    if (allowed.length === 0) return undefined;
    if (issue.path.length === 0) {
      for (const [list, listNode] of Object.entries(properties)) {
        const entry = unwrapNullable(listNode).items;
        const entryKeys = new Set([entry, ...(entry?.anyOf ?? []), ...(entry?.oneOf ?? [])].flatMap(variant => Object.keys(variant?.properties ?? {})));
        for (const key of issue.keys) {
          if (entryKeys.has(key)) homes.set(list, (homes.get(list) ?? new Set<string>()).add(key));
        }
      }
    }
    const where = issue.path.reduce<string>((acc, key) => (typeof key === 'number' ? `${acc}[]` : acc ? `${acc}.${String(key)}` : String(key)), '') || 'the call';
    const clause = clauses.get(where) ?? { keys: new Set<string>(), allowed };
    for (const key of issue.keys) clause.keys.add(key);
    clauses.set(where, clause);
  }
  const parts = [...clauses].map(([where, { keys, allowed }]) =>
    `${[...keys].map(quoteKey).join(', ')} ${keys.size > 1 ? 'are not fields' : 'is not a field'} of ${where}; its fields are ${allowed.join(', ')}`);
  const sentence = parts.join('; ');
  const nestedHomes = [...homes].map(([list, keys]) =>
    ` ${[...keys].map(quoteKey).join(', ')} ${keys.size > 1 ? 'are fields' : 'is a field'} of a ${list}[] entry: send ${keys.size > 1 ? 'them' : 'it'} there.`);
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.${nestedHomes.join('')}`;
}

/**
 * Repair hint for an `invalid_tool_input` rejection with at least one `unrecognized_keys` issue:
 * names the offending key(s) and directs removal; the resend rule is the caller's.
 *
 * @param schema - The failed schema; when given, a key nested in an object or array element is
 *   answered with the keys that element accepts.
 * @returns The removal-directed hint, or `undefined` so the caller falls back to
 *   {@link INVALID_TOOL_INPUT_REPAIR_HINT}.
 */
function unrecognizedKeyRepairHint(error: z.ZodError, schema?: z.ZodType): string | undefined {
  const offendingKeys = zodUnrecognizedKeys(error);
  if (offendingKeys.length === 0) return undefined;
  const elementRemoval = objectKeyRemovalHint(error, schema);
  if (elementRemoval) return elementRemoval;

  const plural = offendingKeys.length > 1;
  const keyList = offendingKeys.map(quoteKey).join(', ');
  const nested = error.issues.some((issue) => issue.code === 'unrecognized_keys' && issue.path.length > 0);
  return nested
    ? `Remove ${keyList} where ${plural ? 'they were' : 'it was'} nested; a field this tool defines at another level goes at that level.`
    : `Remove ${keyList} entirely; do not send ${plural ? 'them' : 'it'} under any name or nesting.`;
}

/**
 * Repair hint for an `invalid_tool_input` rejection whose `invalid_type` issue names a field absent
 * from the call, not merely of the wrong type. The generic {@link INVALID_TOOL_INPUT_REPAIR_HINT}
 * presumes the field is present and wrong, so a model told only that loops the same omission; this
 * names the missing field(s) and directs addition. Checked after {@link unrecognizedKeyRepairHint};
 * the two issue kinds never share a path.
 *
 * @param input - The rejected payload; needed because an `invalid_type` issue alone cannot tell
 *   "absent" from "wrong type".
 * @param schema - The failed schema; names `null` as the value of a missing field that accepts it.
 * @returns The addition-directed hint, or `undefined` so the caller falls back to
 *   {@link INVALID_TOOL_INPUT_REPAIR_HINT}.
 */
function missingFieldRepairHint(error: z.ZodError, input: unknown, schema?: z.ZodType): string | undefined {
  if (input === undefined) return undefined;
  const isMissingFieldIssue = (issue: z.core.$ZodIssue): boolean =>
    (issue.code === 'invalid_type' || issue.code === 'invalid_value')
    && resolveAtPath(input, issue.path) === undefined && issue.path.length > 0;

  const missingFields = [...new Set(
    error.issues.filter(isMissingFieldIssue).map((issue) => issue.path.join('.')),
  )];
  if (missingFields.length === 0) return undefined;

  const plural = missingFields.length > 1;
  const fieldList = missingFields.map((field) => `"${field}"`).join(', ');
  const nullable = missingFields.filter((field) => acceptsNullAt(schema, field.split('.').map((key) => (/^\d+$/.test(key) ? Number(key) : key))));
  const nullNote = nullable.length === 0
    ? ''
    : ` ${nullable.map((field) => `"${field}"`).join(', ')} must be present; send null when ${nullable.length > 1 ? 'they do' : 'it does'} not apply.`;
  const addition = `Field${plural ? 's' : ''} ${fieldList} ${plural ? 'are' : 'is'} ${MISSING_FIELD_FRAGMENT}, `
    + `not present with the wrong type — add ${plural ? 'them' : 'it'} at the required type.${nullNote}`;
  return addition;
}

/**
 * General field-repair hint chain shared by every Zod-validation reject regardless of `code`, in
 * order: a refinement's own hint, an unrecognized key (removal is unambiguous), a field absent
 * outright (addition), a present value of the wrong JSON type, a value outside its enum, an array
 * outside its size bound. Schema-derived, so any caller composing its own envelope gets the same
 * repair intelligence as {@link rejectionFromZodError}. A hint states the fault and field repair
 * only; the caller appends the resend rule once, last.
 *
 * @param input - The rejected payload; see {@link missingFieldRepairHint}.
 * @param schema - The failed schema; lets a hint name what it accepts (an element's keys, `null`
 *   for a nullable field). Absent, every link keeps its schema-free wording.
 * @returns The distinct applicable hints joined, or `undefined` when no link applies.
 */
export function zodFieldRepairHint(error: z.ZodError, input: unknown, schema?: z.ZodType): string | undefined {
  const hints = [
    issueOwnedRepairHint(error),
    unrecognizedKeyRepairHint(error, schema),
    missingFieldRepairHint(error, input, schema),
    typeMismatchRepairHint(error, input, schema),
    invalidValueRepairHint(error, input, schema),
    sizeBoundRepairHint(error),
  ].filter((hint): hint is string => hint !== undefined);
  return hints.length > 0 ? [...new Set(hints)].join(' ') : undefined;
}

/**
 * Whether `issue` is a present value outside its accepted values ({@link invalidValueRepairHint}).
 */
function isPresentInvalidValue(issue: z.core.$ZodIssue, input: unknown): boolean {
  return issue.code === 'invalid_value' && issue.path.length > 0
    && (input === undefined || resolveAtPath(input, issue.path) !== undefined);
}

/** Reason line of an issue whose accepted values the repair hint states, once, in the hint. */
const INVALID_VALUE_REASON = 'Invalid value';

/**
 * Repair hint for a present value outside the values its field accepts (enum or literal): names the
 * accepted values and the allowed repairs, setting the field to one of them or, for a field inside
 * an array element, dropping that entry when the array stays within its served minimum. Issues
 * sharing a field shape and accepted values are one clause. An absent field belongs to
 * {@link missingFieldRepairHint}.
 */
function invalidValueRepairHint(error: z.ZodError, input: unknown, schema?: z.ZodType): string | undefined {
  const issues = error.issues.filter((issue): issue is Extract<z.core.$ZodIssue, { code: 'invalid_value' }> =>
    isPresentInvalidValue(issue, input));
  const entryDepth = (path: readonly PropertyKey[]): number => path.map((key) => typeof key === 'number').lastIndexOf(true);
  const flaggedEntries = new Map<string, Set<PropertyKey>>();
  for (const issue of issues) {
    const index = entryDepth(issue.path);
    if (index < 0) continue;
    const array = dottedPath(issue.path.slice(0, index));
    flaggedEntries.set(array, (flaggedEntries.get(array) ?? new Set()).add(issue.path[index]!));
  }
  const clauses = new Set<string>();
  for (const issue of issues) {
    const field = issue.path.reduce<string>((acc, key) => (typeof key === 'number' ? `${acc}[]` : acc ? `${acc}.${String(key)}` : String(key)), '');
    const set = `Set "${field}" to one of ${issue.values.map((value) => JSON.stringify(value)).join(', ')}`;
    const index = entryDepth(issue.path);
    if (index < 0) {
      clauses.add(`${set}.`);
      continue;
    }
    const arrayPath = issue.path.slice(0, index);
    const entries = input === undefined ? undefined : (resolveAtPath(input, arrayPath) as unknown[] | undefined)?.length;
    const arrayNode = jsonSchemaNodeAt(schema, arrayPath);
    const minItems = (arrayNode ? unwrapNullable(arrayNode) : undefined)?.minItems ?? 0;
    const removable = entries === undefined || entries - flaggedEntries.get(dottedPath(arrayPath))!.size >= minItems;
    clauses.add(removable ? `${set}, or remove the entry from "${dottedPath(arrayPath)}".` : `${set}.`);
  }
  return clauses.size > 0 ? [...clauses].join(' ') : undefined;
}

/**
 * Repair hint for a present value of the wrong JSON type (an array sent as its stringified form).
 *
 * @returns The type-directed hint naming the first such path, expected and received types;
 * `undefined` when no `invalid_type` issue has a present value.
 */
function typeMismatchRepairHint(error: z.ZodError, input: unknown, schema?: z.ZodType): string | undefined {
  if (input === undefined) return undefined;
  for (const issue of error.issues) {
    if (issue.code !== 'invalid_type' || issue.path.length === 0) continue;
    const value = resolveAtPath(input, issue.path);
    if (value === undefined) continue;
    const nullNote = acceptsNullAt(schema, issue.path) ? ', or null when it does not apply' : '';
    const node = jsonSchemaNodeAt(schema, issue.path);
    const example = issue.expected === 'object' && node ? JSON.stringify(exampleOf(node)) : undefined;
    return `Send the ${issue.expected} directly${example ? `, shaped like ${example}` : ''}${nullNote}.`;
  }
  return undefined;
}

/**
 * Repair action for an array outside its served size bound; the count and the bound ride on the
 * issue line.
 *
 * @returns The action for the first `too_big` / `too_small` array issue; `undefined` when none is
 * present.
 */
function sizeBoundRepairHint(error: z.ZodError): string | undefined {
  for (const issue of error.issues) {
    if (issue.code !== 'too_big' && issue.code !== 'too_small') continue;
    if (issue.origin !== 'array' && issue.origin !== 'set') continue;
    const path = issue.path.join('.');
    return issue.code === 'too_big' ? `Merge or drop the surplus in "${path}".` : `Add the missing items to "${path}".`;
  }
  return undefined;
}

/**
 * The repair instruction a schema refinement states itself, on `params.hint` of its custom issue.
 *
 * @returns Every distinct such hint, so a refinement that names its own concrete repair is never
 *   followed by the generic instruction it would contradict, and each flagged field gets its own;
 *   `undefined` when no issue carries one.
 */
function issueOwnedRepairHint(error: z.ZodError): string | undefined {
  const hints: string[] = [];
  for (const issue of error.issues) {
    if (issue.code !== 'custom') continue;
    const hint = (issue.params as { hint?: unknown } | undefined)?.hint;
    if (typeof hint === 'string' && !hints.includes(hint)) hints.push(hint);
  }
  return hints.length > 0 ? hints.join(' ') : undefined;
}

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

/** Longest object key quoted whole; a longer key is reported by length alone, never as a prefix. */
const KEY_ECHO_MAX_CHARS = 120;

/** Quoted echo of one offending object key. */
function quoteKey(key: string): string {
  return key.length > KEY_ECHO_MAX_CHARS ? `a ${key.length}-character key` : `"${key}"`;
}

/** Walks `input` down one Zod issue path; `undefined` when the path leaves the object graph. */
function resolveAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let value: unknown = input;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key as keyof object];
  }
  return value;
}

/** Size of the received value in the unit the model reasons about; `undefined` if unmeasurable. */
function measuredSize(value: unknown): string | undefined {
  if (typeof value === 'string') return `${value.length} chars`;
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === 'number') return `${value}`;
  return undefined;
}

/**
 * Composes one reason line for a size violation from the issue's own metadata plus the received
 * value: measured size and the bound. Falls back to the stock Zod message when the received value
 * is unmeasurable.
 */
function describeSizeIssue(
  issue: Extract<z.core.$ZodIssue, { code: 'too_big' | 'too_small' }>,
  received: unknown,
): string | undefined {
  const size = measuredSize(received);
  if (size === undefined) return undefined;
  const bound = issue.code === 'too_big' ? `limit ${issue.maximum}` : `minimum ${issue.minimum}`;
  return `${size}, ${bound}`;
}

/**
 * One dotted path per offending key; a key over {@link KEY_ECHO_MAX_CHARS} yields its container's
 * path.
 */
function unrecognizedKeyPaths(issue: Extract<z.core.$ZodIssue, { code: 'unrecognized_keys' }>): string[] {
  const base = issue.path.join('.');
  return issue.keys.map((key) => (key.length > KEY_ECHO_MAX_CHARS ? base : base ? `${base}.${key}` : key));
}

/** The schema keyword a Zod size issue breaks, named by its bound and the measured unit. */
function sizeKeyword(issue: Extract<z.core.$ZodIssue, { code: 'too_big' | 'too_small' }>): string {
  const unit = issue.origin === 'string' ? 'Length' : issue.origin === 'array' || issue.origin === 'set' ? 'Items' : 'imum';
  return `${issue.code === 'too_big' ? 'max' : 'min'}${unit}`;
}

/**
 * The typed faults of one Zod issue: `invalid_type` is `missing` for an absent field, `never` for a
 * forbidden one, else `type`; `unrecognized_keys` one `unknown_key` per key; `invalid_value` is
 * `enum` (`missing` when absent); `too_big`/`too_small` `size` with its bound; a custom issue the
 * issue code on its `params.code`; every other issue `invalid`. A union names the faults of its
 * flattened branches, the accepted types of one path merged into one fault.
 */
function issueErrors(issue: z.core.$ZodIssue, input: unknown): ToolError[] {
  const path = issue.path.join('.');
  const absent = input !== undefined && issue.path.length > 0 && resolveAtPath(input, issue.path) === undefined;
  switch (issue.code) {
    case 'invalid_union': {
      const faults: ToolError[] = [];
      for (const branch of flattenUnionBranches(issue)) {
        for (const sub of branch) {
          for (const fault of issueErrors({ ...sub, path: [...issue.path, ...sub.path] }, input)) {
            const same = fault.code === 'type' && faults.find(other => other.code === 'type' && other.path === fault.path);
            if (same) same.types = [...new Set([...(same.types ?? []), ...(fault.types ?? [])])];
            else faults.push(fault);
          }
        }
      }
      return faults;
    }
    case 'unrecognized_keys':
      return unrecognizedKeyPaths(issue).map(key => ({ path: key, code: 'unknown_key' }));
    case 'invalid_type':
      return [issue.expected === 'never'
        ? { path, code: 'never' }
        : { path, code: absent ? 'missing' : 'type', types: [issue.expected] }];
    case 'invalid_value':
      return [{ path, code: absent ? 'missing' : 'enum', values: issue.values.map(String) }];
    case 'too_big':
    case 'too_small': {
      const sent = resolveAtPath(input, issue.path);
      const size = typeof sent === 'string' || Array.isArray(sent) ? sent.length : undefined;
      const limit = Number(issue.code === 'too_big' ? issue.maximum : issue.minimum);
      return [{ path, code: 'size', bound: { keyword: sizeKeyword(issue), limit, ...(size !== undefined ? { sent: size } : {}) } }];
    }
    case 'custom': {
      const code = (issue.params as { code?: unknown } | undefined)?.code;
      return [{ path, code: typeof code === 'string' && code in ISSUES ? code as IssueCode : 'invalid' }];
    }
    default:
      return [{ path, code: 'invalid' }];
  }
}

/**
 * Sole producer of auto-generated {@link ToolRejection} reasons from a Zod validation error.
 *
 * @remarks The reason is `z.prettifyError` over the issues, each carrying its enriched message: an
 *   `invalid_union` expands via {@link describeInvalidUnion} into a per-branch required-field
 *   breakdown, and when `input` is supplied a size issue names the measured size — Zod v4 issues
 *   carry no input, so the enrichment happens here; a sent value is never echoed. Issues identical
 *   apart from their array index (same code, message and path shape) collapse into the first, which
 *   names the other indices, so one defect repeated across N entries is one line. A size issue at a
 *   path that also fails its type is dropped: the bound belongs to the declared type. Only
 *   STRUCTURAL bounds reach this function; a content cap is enforced and reported separately by the
 *   validator or engine. A present value outside its accepted values names them in the default hint
 *   ({@link invalidValueRepairHint}) and not again in the reason; a caller-supplied `hint` leaves
 *   the reason carrying them.
 * @param error - The Zod validation failure.
 * @param opts - `code` to stamp on the rejection; optional `hint` (default: the field repair chain,
 *   {@link zodFieldRepairHint}, followed by the one generic resend rule
 *   {@link INVALID_TOOL_INPUT_REPAIR_HINT}); optional `input` (the value that failed parsing)
 *   enabling measured-size enrichment and absent-field hints; optional `schema` (the schema it
 *   failed) enabling the hints that name what the schema accepts.
 * @returns A normalized {@link ToolRejection} built via {@link makeRejection}.
 */
export function rejectionFromZodError(
  error: z.ZodError,
  opts: { code: string; hint?: string; input?: unknown; schema?: z.ZodType },
): ToolRejection {
  const issuePaths: string[] = [];
  const errors: ToolError[] = [];
  const shown = new Map<string, { issue: z.core.$ZodIssue; message: string; others: string[] }>();
  const mistyped = new Set(error.issues.filter(issue => issue.code === 'invalid_type').map(issue => dottedPath(issue.path)));
  for (const issue of error.issues) {
    if ((issue.code === 'too_big' || issue.code === 'too_small') && mistyped.has(dottedPath(issue.path))) continue;
    errors.push(...issueErrors(issue, opts.input));
    let message: string;
    if (issue.code === 'invalid_union') {
      const { line, paths } = describeInvalidUnion(issue, opts.input);
      issuePaths.push(...paths);
      message = line;
    } else {
      const path = issue.path.join('.');
      if (issue.code === 'unrecognized_keys') issuePaths.push(...unrecognizedKeyPaths(issue));
      else if (path) issuePaths.push(path);
      message = opts.hint === undefined && isPresentInvalidValue(issue, opts.input)
        ? INVALID_VALUE_REASON
        : opts.input !== undefined
          ? enrichedIssueMessage(issue, resolveAtPath(opts.input, issue.path))
          : baseIssueMessage(issue);
    }
    const shape = `${issue.code}|${message}|${issue.path.map(key => (typeof key === 'number' ? '*' : String(key))).join('.')}`;
    const first = shown.get(shape);
    if (first) first.others.push(dottedPath(issue.path));
    else shown.set(shape, { issue, message, others: [] });
  }
  const collapsed = [...shown.values()].map(({ issue, message, others }) => (
    { ...issue, message: others.length > 0 ? `${message} (same at ${others.join(', ')})` : message }
  ));
  return makeRejection({
    code: opts.code,
    reason: z.prettifyError(new z.ZodError(collapsed)),
    hint: opts.hint ?? [zodFieldRepairHint(error, opts.input, opts.schema), INVALID_TOOL_INPUT_REPAIR_HINT].filter(Boolean).join(' '),
    issuePaths,
    errors,
  });
}
