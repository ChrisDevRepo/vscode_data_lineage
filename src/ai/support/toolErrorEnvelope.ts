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

/** The one rejection shape: what was wrong (`reason`), how to repair it (`hint`), and typed machine facts. */
export interface ToolRejection {
  /** Stable machine code. */
  code: string;
  /** Human-readable reason line; equals `code` when the emit site states nothing more. */
  reason: string;
  /** Optional remediation hint the model should act on next round. */
  hint?: string;
  /** Structured dispatcher facts retained for bounded graph-owned correction projection. */
  detail?: unknown;
  /** Dotted paths of the offending fields; downstream correction-echo and observability read these. */
  issuePaths?: string[];
  /** Exact offending entry ids, for a violation whose offender is an id rather than a field path. */
  entryIds?: readonly string[];
}

/**
 * Engine code carried by the consent gate, which shares the rejection envelope without being one.
 * Reuses {@link REJECTION_CODES.actionRequired} — the one constant every emission site
 * (`start_exploration`'s gate return, the graph's gate detector) interpolates, so a rename cannot
 * drift between them.
 */
const CONSENT_GATE_CODE = REJECTION_CODES.actionRequired;

/**
 * Reports whether a rejection code is the consent gate rather than a failure.
 *
 * @param code - Rejection code from {@link readToolError}.
 * @returns `true` when the envelope is a paused-for-approval gate.
 *
 * @remarks
 * The gate reuses the rejection envelope so one dispatch path serves both, but it is never charged
 * against the semantic budget or rendered as a failure; every surface that separates the two reads
 * this predicate.
 */
export function isConsentGateRejection(code: string): boolean {
  return code === CONSENT_GATE_CODE;
}

/**
 * Zod view of the {@link makeRejection} shape, parsed once at the read boundary. Strict: the emitter
 * writes exactly these keys, so a success payload carrying any other key is never read as a rejection.
 */
const RejectionShape = z.object({
  code: z.string(),
  reason: z.string().trim().min(1),
  hint: z.string().optional(),
  detail: z.unknown().optional(),
  issuePaths: z.array(z.string()).optional(),
  entryIds: z.array(z.string()).optional(),
}).strict();

/**
 * Write-side builder for the one tool-execution failure envelope both LM lanes record when a handler
 * throws; the run ends on it. Owning it here keeps the graph-owned dispatch result provider-neutral.
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
 * Thrown by a tool host's `requireModel`/`requireGraph` when no model/graph is loaded — the panel
 * closed mid-turn and cleared them (`panelProvider.ts`'s `onDidDispose`, the one site that nulls
 * them), or an externally registered read tool ran with no project ever opened. Both causes are one
 * true statement, so this is one class and one code rather than a guess at which applied.
 * Distinguished from a generic tool-execution failure so the dispatcher returns a stable,
 * non-retryable rejection instead of a hint that invites correcting input that was never the
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
/** One dotted-path segment: an identifier of at most {@link MAX_PATH_SEGMENT_CHARS} chars, or an index. */
const PATH_SEGMENT = `(?:[A-Za-z_][A-Za-z0-9_-]{0,${MAX_PATH_SEGMENT_CHARS - 1}}|\\d+)`;
/** Dotted identifier grammar every recorded issue path must match: safe to log where prose is not allowed. */
const ISSUE_PATH_GRAMMAR = new RegExp(`^${PATH_SEGMENT}(?:\\.${PATH_SEGMENT})*$`);

/**
 * The one producer of a {@link ToolRejection}. Trims `reason` (default: the `code`) and throws when
 * the trimmed value is empty — an empty-reason reject is unrepresentable
 * (make-illegal-states-unrepresentable), since a rejection the model cannot read is indistinguishable
 * from a silent hang. `issuePaths` keep only dotted-identifier paths, deduped and bounded, so a
 * model-controlled key can never reach a record that forbids prose.
 * @param input - Raw rejection fields.
 * @returns A normalized {@link ToolRejection}.
 */
export function makeRejection(input: {
  code: string;
  reason?: string;
  hint?: string;
  detail?: unknown;
  issuePaths?: readonly string[];
  entryIds?: readonly string[];
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
  };
}

/**
 * Narrowed view of a Zod v4 `invalid_union` issue. Its `errors` field holds one sub-issue array per
 * union branch — the raw material {@link describeInvalidUnion} expands into a per-branch required-
 * field breakdown. (Zod v4 renamed the v3 `unionErrors: ZodError[]` shape to `errors: $ZodIssue[][]`.)
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
 * union issue's own path so a nested union still reads as a full path from the payload root) and one
 * model-facing descriptor line per sub-issue — the bare dotted field path when it was absent from
 * `input` (the missing name *is* the defect), or `"<path>: <enriched message>"` when a value was
 * present but matched no branch (e.g. `depth: Invalid input: expected number, received string`).
 * Both are derived from the same per-sub-issue full path in one pass. Without the
 * defect message a scalar union — every variant naming the same single field — collapses to
 * `variant 1: depth; variant 2: depth`, which names the field but not the defect, so the model
 * regenerates the identical call blind.
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
 * Splices nested `invalid_union` sub-issues in place so every returned branch is one leaf
 * alternative — Zod wrappers such as `.nullable()` compile to a union whose first branch is the
 * authored union itself, and a schema-authored union may nest unions too. Unspliced, the nested
 * level contributes a `"Invalid input"` variant that names no field and no defect; spliced, variant
 * numbering counts real alternatives. A branch mixing nested-union and leaf sub-issues keeps its
 * leaves as one branch next to the spliced ones. Bounded by the schema's own static nesting.
 *
 * @param prefix - Path of the nested union being spliced, relative to the outermost union's own
 * path. Rebased onto every leaf it yields, so a nested union sitting on a named field
 * (`depth.upstream`) keeps that field in the reason and in `issuePaths` instead of collapsing to
 * its parent — the collapsed name resolves to the wrong value when the message is enriched.
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
 * One union branch's rendered text: the plain comma-joined descriptor listing, except a branch
 * that reduces to exactly one bare (missing) field, which states plainly that the field is
 * required and absent rather than leaving a lone dotted name to be read as the defect. A branch
 * naming several fields, or one present-but-wrong-type field, keeps the bare/enriched listing
 * {@link describeUnionBranch} already produced — only a single missing name is ambiguous enough
 * to need the extra words.
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
 * union branch's required fields, plus the flattened, first-branch-first field paths for
 * `issuePaths`. Purely derived from the ZodError's own issue tree — no hand-authored per-tool text,
 * so it stays generic across every union schema (BB/CT `submit_findings`, entry-detection, etc.).
 * Branches whose rendered text is byte-identical (the same field, or fields, reported the same way
 * by more than one candidate shape — e.g. every provider variant that carries the same required
 * nested field) collapse to one numbered entry: repeating an identical line under a second variant
 * number tells the model nothing beyond what the first already said.
 * @param issue - The narrowed `invalid_union` issue.
 * @param input - The value that failed parsing, when available — enables the per-field defect
 * enrichment in {@link describeUnionBranch}; absent fields keep their bare-name listing.
 * @returns The composed reason line and the deduped, first-branch-first field paths.
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
 * The generic resend rule of a schema-invalid tool call whose tool holds no draft: the complete call is
 * resent with a minimal edit. It is the only resend directive a rejection carries; a tool that holds a
 * draft states its own held rule in its place.
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

/**
 * The message of one Zod issue, with an `unrecognized_keys` echo of every offending key whole.
 */
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

/** The JSON Schema node `path` addresses inside `schema`; `undefined` when the path leaves the schema. */
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

/** The non-null branch of a nullable node (`anyOf: [X, {type: 'null'}]`); any other node unchanged. */
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
 * Hint for `unrecognized_keys` issues: states that the key is no field and names the fields of the
 * object it sits in, so a misspelt key is renamed and an invented one dropped; the
 * call itself is the object for an issue at the root. A root key that a list entry of the call
 * defines is answered with that list, so a flattened entry is moved back instead of dropped.
 *
 * @returns The object-directed hint; `undefined` when the schema is absent or does not resolve the
 * object, so the caller keeps the key-only wording.
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
 * Repair hint for an `invalid_tool_input` rejection carrying at least one `unrecognized_keys` issue.
 *
 * @remarks
 * Names the offending key(s) and directs removal; the resend rule is the caller's.
 *
 * @param error - The Zod validation failure under {@link rejectionFromZodError}.
 * @param schema - The schema the payload failed; when given, a key nested in an object or array element
 * is answered with the keys that element accepts.
 * @returns The removal-directed hint when any issue is `unrecognized_keys`; `undefined` otherwise,
 * so the caller falls back to {@link INVALID_TOOL_INPUT_REPAIR_HINT} unchanged.
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
 * Repair hint for an `invalid_tool_input` rejection whose `invalid_type` issue names a field
 * absent from the call altogether, not merely of the wrong type.
 *
 * @remarks
 * The generic {@link INVALID_TOOL_INPUT_REPAIR_HINT} presumes the field is present and merely
 * wrong, so a model told only that loops the identical omission. This names the missing field(s)
 * and directs addition, checked after {@link unrecognizedKeyRepairHint} since the two issue kinds
 * never share a path.
 *
 * @param error - The Zod validation failure under {@link rejectionFromZodError}.
 * @param input - The rejected payload; required to tell "absent" from "present but wrong type" —
 * an `invalid_type` issue alone does not distinguish the two.
 * @param schema - The schema the payload failed; names `null` as the value of a missing field that accepts it.
 * @returns The addition-directed hint when any issue names a field absent from `input`;
 * `undefined` otherwise, so the caller falls back to {@link INVALID_TOOL_INPUT_REPAIR_HINT}
 * unchanged.
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
 * General field-repair hint chain, shared by every Zod-validation reject regardless of `code`.
 *
 * @remarks
 * Every applicable link, in this order: a refinement's own hint, an unrecognized key (removal is
 * unambiguous), a field absent outright (addition), a present value of the wrong JSON type, a present
 * value outside its enum, and an array outside its size bound. The links are schema-derived, so any caller composing its own reject
 * envelope gets the same repair intelligence {@link rejectionFromZodError} already gives. A hint
 * states the fault and the field repair only; the resend rule is appended once, last, by the caller.
 *
 * @param error - The Zod validation failure.
 * @param input - The rejected payload; required to tell "absent" from "present but wrong type" —
 * see {@link missingFieldRepairHint}.
 * @param schema - The schema the payload failed; lets a hint name what the schema accepts (an element's
 * keys, `null` for a nullable field). Absent, every link keeps its schema-free wording.
 * @returns The distinct applicable repair hints joined, or `undefined` when no chain link applies.
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

/** Whether `issue` is a present value outside its accepted values, the issue kind {@link invalidValueRepairHint} states. */
function isPresentInvalidValue(issue: z.core.$ZodIssue, input: unknown): boolean {
  return issue.code === 'invalid_value' && issue.path.length > 0
    && (input === undefined || resolveAtPath(input, issue.path) !== undefined);
}

/** Reason line of an issue whose accepted values the repair hint states; the values are named once, in the hint. */
const INVALID_VALUE_REASON = 'Invalid value';

/**
 * Repair hint for a present value outside the values its field accepts (an enum or literal).
 *
 * @remarks
 * Names the accepted values and the repairs the call allows: set the field to one of them, or, for a
 * field inside an array element, drop that entry when the array stays within its served minimum
 * with every flagged entry of that array dropped.
 * Issues sharing a field shape and accepted values are one clause. An absent field belongs to
 * {@link missingFieldRepairHint}.
 *
 * @returns The value-directed hint; `undefined` when no `invalid_value` issue names a present value.
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
 * followed by the generic instruction it would contradict, and each flagged field gets its own; `undefined`
 * when no issue carries one.
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

/** Measured size of the received value in the unit the model reasons about; `undefined` when unmeasurable. */
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

/** One dotted path per offending key; a key over {@link KEY_ECHO_MAX_CHARS} yields its container's path, never the key. */
function unrecognizedKeyPaths(issue: Extract<z.core.$ZodIssue, { code: 'unrecognized_keys' }>): string[] {
  const base = issue.path.join('.');
  return issue.keys.map((key) => (key.length > KEY_ECHO_MAX_CHARS ? base : base ? `${base}.${key}` : key));
}

/**
 * Sole producer of auto-generated {@link ToolRejection} reasons from a Zod validation error.
 *
 * @remarks
 * The reason is `z.prettifyError` over the issues, each carrying its enriched message: an
 * `invalid_union` expands via {@link describeInvalidUnion} into a per-branch required-field
 * breakdown, and when `input` is supplied a size issue names the measured size — Zod v4 issues
 * carry no input, so the enrichment happens here; a sent value is never echoed. Issues identical
 * apart from their array index (same code, message and path shape) collapse into the first, which
 * names the other indices, so one defect repeated across N entries is one line. Only STRUCTURAL
 * bounds reach this function; a content cap is enforced and reported separately by the validator
 * or engine. A present value outside its accepted values names them in the default hint
 * ({@link invalidValueRepairHint}) and not again in the reason; a caller-supplied `hint` leaves the
 * reason carrying them.
 * @param error - The Zod validation failure.
 * @param opts - `code` to stamp on the rejection; optional `hint` (default: the field repair chain,
 * {@link zodFieldRepairHint}, followed by the one generic resend rule {@link INVALID_TOOL_INPUT_REPAIR_HINT}); optional `input`
 * (the value that failed parsing) enabling measured-size enrichment and absent-field hints; optional `schema`
 * (the schema it failed) enabling the hints that name what the schema accepts.
 * @returns A normalized {@link ToolRejection} built via {@link makeRejection}.
 */
export function rejectionFromZodError(
  error: z.ZodError,
  opts: { code: string; hint?: string; input?: unknown; schema?: z.ZodType },
): ToolRejection {
  const issuePaths: string[] = [];
  const shown = new Map<string, { issue: z.core.$ZodIssue; message: string; others: string[] }>();
  for (const issue of error.issues) {
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
  });
}
