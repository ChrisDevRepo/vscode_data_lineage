/**
 * Single typed channel for tool-result rejections.
 *
 * @remarks
 * Every tool, guard and engine refusal is emitted by {@link makeRejection} in one shape —
 * `{ code, reason, hint?, detail?, issuePaths?, entryIds? }` — and serialized as the
 * tool result. {@link readToolError} reads that shape back. The one other shape it recognizes is the
 * `lineage_present_result` validator's `{ success: false, errors: […] }`, which that tool still emits
 * itself. Provider-pure.
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

/** Zod view of the `lineage_present_result` validator's `{ success: false, errors: […] }` failure. */
const PresentResultFailureShape = z.object({
  success: z.literal(false),
  errors: z.array(z.unknown()).optional(),
  hint: z.string().optional(),
  detail: z.unknown().optional(),
}).passthrough();

/**
 * Write-side builder for the one tool-execution failure envelope both LM lanes feed back to the
 * model when a handler throws. Owning it here keeps the graph-owned dispatch result provider-neutral.
 * @param toolName - Canonical tool name whose handler threw.
 * @returns Generic JSON rejection safe to project into graph retry state.
 */
export function buildToolExecutionError(toolName: string): string {
  return JSON.stringify(makeRejection({
    code: REJECTION_CODES.toolExecutionError,
    hint: `Correct the ${toolName} input and retry the same phase.`,
  }));
}

/** Stable message shared by {@link NoProjectLoadedError} and {@link buildNoProjectLoadedError}. */
export const NO_PROJECT_LOADED_MESSAGE =
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
 * Reads the `lineage_present_result` validator failure into a {@link ToolRejection}.
 *
 * @remarks
 * `detail` folds in every offender the validator attached: its per-path records, the full `errors[]`
 * array when it has more than one entry, and every sibling key (`repairFields`, `repairable`, …).
 * The typed `issuePaths` and `entryIds` are read from the flat per-path record
 * list the validator emits in `detail`.
 */
function readPresentResultFailure(data: unknown): ToolRejection | null {
  const parsed = PresentResultFailureShape.safeParse(data);
  if (!parsed.success) return null;
  const { success: _success, errors, hint, detail, ...siblings } = parsed.data;
  const reason = String(errors?.[0] ?? '').trim() || 'tool returned failure envelope';
  const extraFacts: Record<string, unknown> = {};
  if (errors && errors.length > 1) extraFacts.errors = errors;
  Object.assign(extraFacts, siblings);
  const hasExtraFacts = Object.keys(extraFacts).length > 0;
  const mergedDetail = !hasExtraFacts
    ? detail
    : detail === undefined
      ? extraFacts
      : typeof detail === 'object' && detail !== null && !Array.isArray(detail)
        ? { ...detail, ...extraFacts }
        : { detail, ...extraFacts };

  const records = (Array.isArray(detail) ? detail : []).filter(
    (record): record is Record<string, unknown> => typeof record === 'object' && record !== null,
  );
  const entryIds = [...new Set(records.flatMap((record) => (Array.isArray(record.entry_ids) ? record.entry_ids : [])))]
    .filter((id): id is string => typeof id === 'string');
  return makeRejection({
    code: REJECTION_CODES.validation,
    reason,
    hint,
    detail: mergedDetail,
    issuePaths: records.flatMap((record) => (typeof record.path === 'string' ? [record.path] : [])),
    entryIds,
  });
}

/**
 * Reader: the typed {@link ToolRejection} a tool result carries, or `null` when the payload is not
 * a refusal. Recognizes exactly two shapes — the {@link makeRejection} shape every emit site uses,
 * and the `lineage_present_result` validator's own `{ success: false, errors: […] }` failure.
 *
 * @param data - Parsed untrusted tool result.
 * @returns The rejection, or `null` for a successful/non-rejection result.
 */
export function readToolError(data: unknown): ToolRejection | null {
  const parsed = RejectionShape.safeParse(data);
  if (parsed.success) {
    const { detail, ...rest } = parsed.data;
    return { ...rest, ...(detail !== undefined ? { detail } : {}) };
  }
  return readPresentResultFailure(data);
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
 * Enriches one Zod issue's message with the received value: measured size against the bound for
 * `too_big`/`too_small` (models cannot count characters), and a bounded verbatim echo for scalar
 * leaves (the rejected call is replayed without arguments). All derived mechanically from the
 * issue's own metadata — the single enrichment used by every reject prose this module composes.
 */
function enrichedIssueMessage(issue: z.core.$ZodIssue, received: unknown): string {
  if (issue.code === 'too_big' || issue.code === 'too_small') {
    return describeSizeIssue(issue, received) ?? issue.message;
  }
  const echo = scalarEcho(received);
  const message = baseIssueMessage(issue);
  return echo !== undefined ? `${message}; sent: ${echo}` : message;
}

/**
 * Describes one union branch: its deduped required-field names (first-seen order, prefixed with the
 * union issue's own path so a nested union still reads as a full path from the payload root) and one
 * model-facing descriptor line per sub-issue — the bare dotted field path when it was absent from
 * `input` (the missing name *is* the defect), or `"<path>: <enriched message>"` when a value was
 * present but matched no branch (e.g. `depth: Invalid input: expected number, received string;
 * sent: "1"`). Both are derived from the same per-sub-issue full path in one pass. Without the
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
 * enrichment in {@link unionBranchFieldDescriptor}; absent fields keep their bare-name listing.
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
  = 'Resend the full tool call with only the offending field(s) corrected; keep every other field unchanged, and resend every element of a corrected list, repeating the unflagged elements exactly as first sent.';

/**
 * The distinct offending key(s) of every `unrecognized_keys` issue on `error`.
 *
 * @returns The offending key names, empty when `error` carries no `unrecognized_keys` issue.
 */
export function zodUnrecognizedKeys(error: z.ZodError): string[] {
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

/** Whether the schema accepts `null` at `path`. */
function acceptsNullAt(schema: z.ZodType | undefined, path: readonly PropertyKey[]): boolean {
  const node = jsonSchemaNodeAt(schema, path);
  if (!node) return false;
  return [node, ...(node.anyOf ?? []), ...(node.oneOf ?? [])]
    .some((variant) => variant.type === 'null' || (Array.isArray(variant.type) && variant.type.includes('null')));
}

/**
 * Removal hint for `unrecognized_keys` issues that all sit inside an object or array element, naming
 * the keys that element accepts.
 *
 * @returns The element-directed hint; `undefined` when an issue is at the root, or the schema is
 * absent or does not resolve the element, so the caller keeps the key-only wording.
 */
function nestedKeyRemovalHint(error: z.ZodError, schema: z.ZodType | undefined): string | undefined {
  const issues = error.issues.filter((issue) => issue.code === 'unrecognized_keys');
  if (issues.length === 0 || issues.some((issue) => issue.path.length === 0)) return undefined;
  const clauses = new Map<string, { keys: Set<string>; allowed: string[] }>();
  for (const issue of issues) {
    const node = jsonSchemaNodeAt(schema, issue.path);
    const allowed = Object.keys((node ? unwrapNullable(node) : undefined)?.properties ?? {});
    if (allowed.length === 0) return undefined;
    const where = issue.path.reduce<string>((acc, key) => (typeof key === 'number' ? `${acc}[]` : acc ? `${acc}.${String(key)}` : String(key)), '');
    const clause = clauses.get(where) ?? { keys: new Set<string>(), allowed };
    for (const key of issue.keys) clause.keys.add(key);
    clauses.set(where, clause);
  }
  const parts = [...clauses].map(([where, { keys, allowed }]) =>
    `remove ${[...keys].map(quoteKey).join(', ')} from ${where} (it accepts only ${allowed.join(', ')})`);
  return `Resend the tool call: ${parts.join('; ')}. Keep every other field unchanged.`;
}

/**
 * Repair hint for an `invalid_tool_input` rejection carrying at least one `unrecognized_keys` issue.
 *
 * @remarks
 * The standing {@link INVALID_TOOL_INPUT_REPAIR_HINT} says "keep every other field unchanged" —
 * wrong for a key the schema rejects outright, since resending it reproduces the same failure.
 * This names the offending key(s) and directs removal, stated alongside any other flagged field's
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
  const elementRemoval = nestedKeyRemovalHint(error, schema);
  if (elementRemoval) return elementRemoval;

  const plural = offendingKeys.length > 1;
  const keyList = offendingKeys.map(quoteKey).join(', ');
  const nested = error.issues.some((issue) => issue.code === 'unrecognized_keys' && issue.path.length > 0);
  const removal = nested
    ? `Resend the tool call without the unrecognized field${plural ? 's' : ''} ${keyList} where ${plural ? 'they were' : 'it was'} `
      + 'nested — a field this tool defines at another level goes at that level; anything else is not part of '
      + 'this tool\'s input. Keep every other field unchanged.'
    : `Resend the tool call with the unrecognized field${plural ? 's' : ''} ${keyList} removed entirely — `
      + `${plural ? 'they are' : 'it is'} not part of this tool's input schema at all, so do not resend `
      + `${plural ? 'them' : 'it'} under any name or nesting; keep every other field unchanged.`;

  const hasOtherIssues = error.issues.some((issue) => issue.code !== 'unrecognized_keys');
  return hasOtherIssues
    ? `${removal} Separately, correct the other offending field(s) named above; resend every element of a corrected `
      + 'list, repeating the unflagged elements exactly as first sent.'
    : removal;
}

/**
 * Repair hint for an `invalid_tool_input` rejection whose `invalid_type` issue names a field
 * absent from the call altogether, not merely of the wrong type.
 *
 * @remarks
 * The standing {@link INVALID_TOOL_INPUT_REPAIR_HINT} presumes the field is present and merely
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
    + `not present with the wrong type — resend the full tool call with ${plural ? 'them' : 'it'} added at the `
    + `required type; keep every other field unchanged.${nullNote}`;

  const hasOtherIssues = error.issues.some((issue) => !isMissingFieldIssue(issue));
  return hasOtherIssues
    ? `${addition} Separately, correct the other offending field(s) named above; resend every element of a corrected `
      + 'list, repeating the unflagged elements exactly as first sent.'
    : addition;
}

/**
 * General field-repair hint chain, shared by every Zod-validation reject regardless of `code`.
 *
 * @remarks
 * An unrecognized key first (removal is unambiguous), then a field absent outright (addition), a
 * present value of the wrong JSON type, and an array outside its size bound.
 * Both sub-hints are schema-derived, so any caller composing its own reject envelope gets the same
 * repair intelligence {@link rejectionFromZodError} already gives.
 *
 * @param error - The Zod validation failure.
 * @param input - The rejected payload; required to tell "absent" from "present but wrong type" —
 * see {@link missingFieldRepairHint}.
 * @param schema - The schema the payload failed; lets a hint name what the schema accepts (an element's
 * keys, `null` for a nullable field). Absent, every link keeps its schema-free wording.
 * @returns The first applicable repair hint, or `undefined` when no chain link applies.
 */
export function zodFieldRepairHint(error: z.ZodError, input: unknown, schema?: z.ZodType): string | undefined {
  return issueOwnedRepairHint(error)
    ?? unrecognizedKeyRepairHint(error, schema)
    ?? missingFieldRepairHint(error, input, schema)
    ?? typeMismatchRepairHint(error, input, schema)
    ?? sizeBoundRepairHint(error, input);
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
    const received = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const nullNote = acceptsNullAt(schema, issue.path) ? ', or null when it does not apply' : '';
    return `"${issue.path.join('.')}" must be a JSON ${issue.expected}, not a ${received}; send the ${issue.expected} directly${nullNote}.`;
  }
  return undefined;
}

/**
 * Repair hint for an array or string outside its served size bound.
 *
 * @returns The bound-directed hint from the first `too_big` / `too_small` issue; `undefined`
 * when none is present.
 */
function sizeBoundRepairHint(error: z.ZodError, input: unknown): string | undefined {
  for (const issue of error.issues) {
    if (issue.code !== 'too_big' && issue.code !== 'too_small') continue;
    if (issue.origin !== 'array' && issue.origin !== 'set') continue;
    const path = issue.path.join('.');
    const value = input === undefined ? undefined : resolveAtPath(input, issue.path);
    const held = Array.isArray(value) ? `holds ${value.length} items` : 'is outside its item bound';
    return issue.code === 'too_big'
      ? `"${path}" ${held}, limit ${String(issue.maximum)}; send at most ${String(issue.maximum)} — merge or drop the surplus.`
      : `"${path}" ${held}, minimum ${String(issue.minimum)}; send at least ${String(issue.minimum)}.`;
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

/**
 * Longest scalar echoed verbatim. A longer string is reported by path and length only — never a
 * prefix — and objects and arrays are never echoed, so the full-payload re-echo the minimal-delta
 * repair contract forbids stays closed.
 */
const SCALAR_ECHO_MAX_CHARS = 120;

/**
 * Quoted echo of one offending object key; a key longer than {@link SCALAR_ECHO_MAX_CHARS} is
 * reported by length alone, never as a prefix.
 */
function quoteKey(key: string): string {
  return key.length > SCALAR_ECHO_MAX_CHARS ? `a ${key.length}-character key` : `"${key}"`;
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

/** JSON-quoted echo of a short scalar leaf; long strings and non-scalars return `undefined`. */
function scalarEcho(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > SCALAR_ECHO_MAX_CHARS ? undefined : JSON.stringify(value);
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
 * Dotted issue paths for a raw `ZodError`. An `unrecognized_keys` issue yields one path per
 * offending key, since Zod's own `issue.path` stops at the containing object; every other issue
 * keeps `path.join('.')`.
 */
export function zodIssuePaths(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    if (issue.code !== 'unrecognized_keys') return [issue.path.join('.')];
    const base = issue.path.join('.');
    return issue.keys.map((key) => (key.length > SCALAR_ECHO_MAX_CHARS ? base : base ? `${base}.${key}` : key));
  });
}

/**
 * Sole producer of auto-generated {@link ToolRejection} reasons from a Zod validation error.
 *
 * @remarks
 * Maps each issue to `"<dottedPath>: <message>"`, except `invalid_union` which expands via
 * {@link describeInvalidUnion} into a per-branch required-field breakdown. When `input` is
 * supplied, each line is enriched with the measured size (`too_big`/`too_small`) or a bounded
 * scalar echo — Zod v4 issues carry no input, so the enrichment happens here. Only STRUCTURAL
 * bounds reach this function; a content cap is enforced and reported separately by the validator
 * or engine.
 * @param error - The Zod validation failure.
 * @param opts - `code` to stamp on the rejection; optional `hint` (default: the field repair chain,
 * {@link zodFieldRepairHint}, then {@link INVALID_TOOL_INPUT_REPAIR_HINT}); optional `input`
 * (the value that failed parsing) enabling measured-size and scalar-echo enrichment; optional `schema`
 * (the schema it failed) enabling the hints that name what the schema accepts.
 * @returns A normalized {@link ToolRejection} built via {@link makeRejection}.
 */
export function rejectionFromZodError(
  error: z.ZodError,
  opts: { code: string; hint?: string; input?: unknown; schema?: z.ZodType },
): ToolRejection {
  const issuePaths: string[] = [];
  const lines = error.issues.map(issue => {
    if (issue.code === 'invalid_union') {
      const { line, paths } = describeInvalidUnion(issue, opts.input);
      issuePaths.push(...paths);
      return line;
    }
    const path = issue.path.join('.');
    if (path) issuePaths.push(path);
    const message = opts.input !== undefined
      ? enrichedIssueMessage(issue, resolveAtPath(opts.input, issue.path))
      : baseIssueMessage(issue);
    return path ? `${path}: ${message}` : message;
  });
  return makeRejection({
    code: opts.code,
    reason: lines.join('; '),
    hint: opts.hint ?? zodFieldRepairHint(error, opts.input, opts.schema) ?? INVALID_TOOL_INPUT_REPAIR_HINT,
    issuePaths,
  });
}
