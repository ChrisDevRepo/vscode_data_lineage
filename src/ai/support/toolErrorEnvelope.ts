/** Single typed channel for tool-result rejections. */
import { z } from 'zod';
import { REJECTION_CODES } from './rejectionCodes';

/** Product limit for a quick missing-content exchange; it does not change validation or reply budgets. */
export const CLARIFICATION_WINDOW_MS = 5000;

/** One fault of a form-style rejection: where it is, what is wrong and, from the owning schema or engine metadata, what the field accepts. */
export interface RejectionError {
  path: string;
  issue: string;
  expected?: string;
  /** Any one of these fields can supply the missing decision; valid copies stay held. */
  alternatives?: readonly string[];
  /** The submitted value, only when it is a short scalar; a longer value is never cut. */
  got?: string | number | boolean;
  allowed?: readonly string[];
  /** Object whose columns `allowed` lists. */
  when?: { node: string };
}

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
  /** Owner-verified missing authored content held safely for a narrow completion; absent on invalid values or identities. */
  missingParts?: readonly string[];
  /** When the backend owner created this missing-content request; separate from its later delivery to the model. */
  feedbackAt?: string;
  /** Every independently decidable fault of a form-style rejection; the model reads these instead of `reason` and `hint`. */
  errors?: RejectionError[];
  /** Top-level fields the model resends; every other field stays held. */
  resend?: string[];
  /** One call fragment of the first faulty structured field, shown with the last repair opportunity. */
  example?: unknown;
  /** The explicit way out, shown with the last repair opportunity. */
  wayOut?: string;
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
    path: z.string(), issue: z.string(), expected: z.string().optional(),
    alternatives: z.array(z.string()).optional(),
    got: z.union([z.string(), z.number(), z.boolean()]).optional(),
    allowed: z.array(z.string()).optional(), when: z.object({ node: z.string() }).strict().optional(),
  }).strict()).optional(),
  resend: z.array(z.string()).optional(),
  example: z.unknown().optional(),
  wayOut: z.string().optional(),
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

/** The reason line a reader meets for one rejection: the reason, unless it is only the code and a hint states the fault, so no reader meets a bare machine code. */
function rejectionReasonLines(rejection: ToolRejection): string[] {
  return rejection.reason === rejection.code && rejection.hint !== undefined ? [] : [rejection.reason];
}

/** Fixed meaning shown beside an empty allowed list. */
const EMPTY_ALLOWED_MEANING = 'nothing is allowed here: withdraw the field';

/** Emits the faults of a form-style rejection, or the owner guidance of any other; the last repair opportunity (`final`) adds the complete choices and, for a form, one example and the way out. Full diagnostics remain in the rejection artifact. */
export function rejectionModelContent(rejection: ToolRejection, final = true): string {
  if (rejection.errors?.length) {
    return JSON.stringify({ code: rejection.code,
      errors: rejection.errors.map(({ allowed, ...error }) => ({ ...error, ...(final && allowed ? { allowed } : {}),
        ...(allowed?.length === 0 ? { allowed_meaning: EMPTY_ALLOWED_MEANING } : {}) })),
      resend: rejection.resend ?? [],
      ...(final && rejection.example !== undefined ? { example: rejection.example } : {}),
      ...(final && rejection.wayOut ? { way_out: rejection.wayOut } : {}) });
  }
  const reason = rejection.reason === rejection.code && rejection.hint ? rejection.hint : rejection.reason;
  const hint = rejection.hint && rejection.hint !== reason ? rejection.hint : undefined;
  if (!final) {
    const paths = rejection.issuePaths?.filter(path => !reason.includes(path));
    return JSON.stringify({ code: rejection.code, reason,
      ...(hint ? { hint } : {}),
      ...(paths?.length ? { issuePaths: paths } : {}) });
  }
  const detail = (Array.isArray(rejection.detail) ? rejection.detail : [rejection.detail]).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const facts = Object.fromEntries(Object.entries(value).filter(([key]) => [
      'kind', 'id', 'path', 'reason', 'allowed_values', 'when', 'minimum', 'maximum', 'inclusive', 'expected', 'format', 'allowedTools', 'error', 'allowed',
    ].includes(key)));
    if (typeof facts.path === 'string' && typeof facts.reason === 'string'
      && rejection.reason.includes(`${facts.path}: ${facts.reason}`)) delete facts.reason;
    if (Array.isArray(facts.allowed_values) ? facts.allowed_values.length === 0 : Array.isArray(facts.allowed) && facts.allowed.length === 0) facts.allowed_meaning = EMPTY_ALLOWED_MEANING;
    const held = (value as { held_draft?: { sections?: Array<{ label: string; start?: string }> } }).held_draft;
    if (held?.sections) facts.held_draft = { sections: held.sections.map(({ label, start }) => ({ label, ...(start ? { start } : {}) })) };
    return Object.keys(facts).length ? [facts] : [];
  });
  const paths = rejection.issuePaths?.filter(path => !reason.includes(path)
    && !detail.some(fact => typeof fact.path === 'string' && fact.path.replace(/\[(\d+)\]/g, '.$1') === path));
  return JSON.stringify({ code: rejection.code, reason,
    ...(hint ? { hint } : {}),
    ...(detail.length ? { detail } : {}),
    ...(paths?.length ? { issuePaths: paths } : {}),
    ...(rejection.entryIds?.length ? { entryIds: rejection.entryIds } : {}),
    ...(rejection.missingParts?.length ? { missingParts: rejection.missingParts } : {}),
  });
}

/** Union independently assessed refusals without interpreting rejected arguments or reason prose. */
export function combineToolRejections(rejections: readonly ToolRejection[], hint?: string): ToolRejection {
  if (rejections.length === 0) throw new Error('Cannot combine an empty rejection set.');
  const details = rejections.flatMap(rejection => rejection.detail === undefined ? []
    : Array.isArray(rejection.detail) ? rejection.detail : [rejection.detail]);
  return makeRejection({
    code: rejections.some(rejection => rejection.code === REJECTION_CODES.invalidInput) ? REJECTION_CODES.invalidInput : rejections[0].code,
    reason: [...new Set(rejections.flatMap(rejectionReasonLines))].join('\n') || rejections[0].reason,
    hint: [...new Set([...rejections.flatMap(rejection => rejection.hint ? [rejection.hint] : []), ...(hint ? [hint] : [])])].join(' ') || undefined,
    issuePaths: rejections.flatMap(rejection => rejection.issuePaths ?? []),
    entryIds: [...new Set(rejections.flatMap(rejection => rejection.entryIds ?? []))],
    ...(details.length ? { detail: [...new Map(details.map(detail => [JSON.stringify(detail), detail])).values()] } : {}),
    errors: [...new Map(rejections.flatMap(rejection => rejection.errors ?? []).map(error => [`${error.path}|${error.issue}`, error])).values()],
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
  example?: unknown;
  wayOut?: string;
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
    ...(input.errors?.length ? { errors: [...input.errors], resend: [...(input.resend ?? [])] } : {}),
    ...(input.example !== undefined ? { example: input.example } : {}),
    ...(input.wayOut ? { wayOut: input.wayOut } : {}),
  };
}

/** Narrowed view of a Zod v4 `invalid_union` issue. Its `errors` field holds one sub-issue array per union branch — the raw material {@link describeInvalidUnion} expands into a per-branch required- field breakdown. */
type InvalidUnionIssue = Extract<z.core.$ZodIssue, { code: 'invalid_union' }>;

/** Enriches one Zod issue's message with the measured size against the bound for `too_big`/`too_small` (models cannot count characters), and names a structured field that arrived as text that is not valid JSON. The received value is never echoed: the rejected call stays in the transcript with its arguments. */
function enrichedIssueMessage(issue: z.core.$ZodIssue, received: unknown): string {
  if (issue.code === 'too_big' || issue.code === 'too_small') {
    return describeSizeIssue(issue, received) ?? issue.message;
  }
  if (issue.code === 'invalid_type' && (issue.expected === 'array' || issue.expected === 'object')
    && typeof received === 'string' && /^\s*[[{]/.test(received)) {
    try { JSON.parse(received); return baseIssueMessage(issue); } catch { /* Malformed JSON text still needs syntax guidance. */ }
    const kind = received.trimStart().startsWith('[') ? 'array' : 'object';
    return `received ${received.length} characters of text that is not valid JSON. Send it again as one complete JSON ${kind}, with line breaks inside strings written as \\n.`;
  }
  return baseIssueMessage(issue);
}

/** Describes one union branch: its deduped required-field names (first-seen order, prefixed with the union issue's own path so a nested union still reads as a full path from the payload root) and one model-facing descriptor line per sub-issue — the bare dotted field path when it was absent from `input` (the missing name *is* the defect), or `"<path>: <enriched message>"` when a value was present but matched no branch (e.g. `depth: Invalid input: expected number, received string`). Both are derived from the same per-sub-issue full path in one pass. Without the defect message a scalar union — every variant naming the same single field — collapses to `variant 1: depth; variant 2: depth`, which names the field but not the defect, so the model regenerates the identical call blind. */
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

/** Splices nested `invalid_union` sub-issues in place so every returned branch is one leaf alternative — Zod wrappers such as `.nullable()` compile to a union whose first branch is the authored union itself, and a schema-authored union may nest unions too. Unspliced, the nested level contributes a `"Invalid input"` variant that names no field and no defect; spliced, variant numbering counts real alternatives. A branch mixing nested-union and leaf sub-issues keeps its leaves as one branch next to the spliced ones. Bounded by the schema's own static nesting. */
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

/** Shared fragment naming a field the model never sent at all, reused by every rejection surface that tells a missing field apart from one merely typed wrong ({@link missingFieldRepairHint}, {@link describeInvalidUnion}) — one wording, not a second phrase invented per call site. */
const MISSING_FIELD_FRAGMENT = 'missing entirely from this call';

/** One union branch's rendered text: the plain comma-joined descriptor listing, except a branch that reduces to exactly one bare (missing) field, which states plainly that the field is required and absent rather than leaving a lone dotted name to be read as the defect. A branch naming several fields, or one present-but-wrong-type field, keeps the bare/enriched listing {@link describeUnionBranch} already produced — only a single missing name is ambiguous enough to need the extra words. */
function describeUnionBranchText(descriptors: string[]): string {
  if (descriptors.length === 0) return '(no field detail)';
  if (descriptors.length === 1 && !descriptors[0].includes(':')) {
    return `${descriptors[0]} is required and ${MISSING_FIELD_FRAGMENT}`;
  }
  return descriptors.join(', ');
}

/** Expands one `invalid_union` issue into a mechanical "no variant matched" reason naming every union branch's required fields, plus the flattened, first-branch-first field paths for `issuePaths`. Purely derived from the ZodError's own issue tree — no hand-authored per-tool text, so it stays generic across every union schema (BB/CT `submit_findings`, entry-detection, etc.). Branches whose rendered text is byte-identical (the same field, or fields, reported the same way by more than one candidate shape — e.g. every provider variant that carries the same required nested field) collapse to one numbered entry: repeating an identical line under a second variant number tells the model nothing beyond what the first already said. */
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

/** The generic resend rule of a schema-invalid tool call whose tool holds no draft: the complete call is resent with a minimal edit. It is the only resend directive a rejection carries; a tool that holds a draft states its own held rule in its place. */
export const INVALID_TOOL_INPUT_REPAIR_HINT
  = 'Resend the full tool call with only the offending field(s) corrected; keep every other field unchanged, and resend every element of a corrected list, repeating the unflagged elements exactly as first sent.';

/** The distinct offending key(s) of every `unrecognized_keys` issue on `error`. */
function zodUnrecognizedKeys(error: z.ZodError): string[] {
  return [...new Set(
    error.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' ? issue.keys : [])),
  )];
}

/** The message of one Zod issue, with an `unrecognized_keys` echo of every offending key whole. */
function baseIssueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_value') return INVALID_VALUE_REASON;
  if (issue.code === 'invalid_type' && issue.expected === 'never') return 'No values are allowed here.';
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

/** A literal value the node accepts, built from the schema alone: an enum's first member, a placeholder for a scalar type, and the required members of an object. */
function exampleOf(node: JsonSchemaShape): unknown {
  const target = unwrapNullable(node);
  if (target.enum?.length) return target.enum[0];
  if (target.properties) {
    const keys = target.required ?? Object.keys(target.properties);
    return Object.fromEntries(keys.map(key => [key, exampleOf(target.properties![key] ?? {})]));
  }
  const type = Array.isArray(target.type) ? target.type[0] : target.type;
  if (type === 'array') return target.items ? [exampleOf(target.items)] : [];
  return type === 'number' || type === 'integer' ? 0 : type === 'boolean' ? false : '...';
}

/** Whether the schema accepts `null` at `path`. */
function acceptsNullAt(schema: z.ZodType | undefined, path: readonly PropertyKey[]): boolean {
  const node = jsonSchemaNodeAt(schema, path);
  if (!node) return false;
  return [node, ...(node.anyOf ?? []), ...(node.oneOf ?? [])]
    .some((variant) => variant.type === 'null' || (Array.isArray(variant.type) && variant.type.includes('null')));
}

/** Hint for `unrecognized_keys` issues: states that the key is no field and names the fields of the object it sits in, so a misspelt key is renamed and an invented one dropped; the call itself is the object for an issue at the root. A root key that a list entry of the call defines is answered with that list, so a flattened entry is moved back instead of dropped. */
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
    const where = dottedPath(issue.path) || 'the call';
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

/** Repair hint for an `invalid_tool_input` rejection carrying at least one `unrecognized_keys` issue. */
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

/** Repair hint for an `invalid_tool_input` rejection whose `invalid_type` issue names a field absent from the call altogether, not merely of the wrong type. */
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

/** General field-repair hint chain, shared by every Zod-validation reject regardless of `code`. */
function zodFieldRepairHint(error: z.ZodError, input: unknown, schema?: z.ZodType): string | undefined {
  const hints = [
    emptyArgumentsHint(error, input),
    issueOwnedRepairHint(error),
    unrecognizedKeyRepairHint(error, schema),
    missingFieldRepairHint(error, input, schema),
    typeMismatchRepairHint(error, input, schema),
    invalidValueRepairHint(error, input, schema),
    sizeBoundRepairHint(error),
  ].filter((hint): hint is string => hint !== undefined);
  return hints.length > 0 ? [...new Set(hints)].join(' ') : undefined;
}

/** Names an empty argument object without guessing a transport cause or overriding a held draft's resend rule. */
function emptyArgumentsHint(error: z.ZodError, input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0) return undefined;
  const missing = error.issues.some((issue) => issue.code === 'invalid_type' && issue.path.length > 0);
  return missing ? 'The call arrived with no arguments at all; supply the required fields named below.' : undefined;
}

/** Whether `issue` is a present value outside its accepted values, the issue kind {@link invalidValueRepairHint} states. */
function isPresentInvalidValue(issue: z.core.$ZodIssue, input: unknown): boolean {
  return issue.code === 'invalid_value' && issue.path.length > 0
    && (input === undefined || resolveAtPath(input, issue.path) !== undefined);
}

/** Value faults disclose choices through structured detail, never in the first reason or hint. */
const INVALID_VALUE_REASON = 'Invalid value';

/** Repair hint for a present value outside the values its field accepts (an enum or literal). */
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
    const set = `Set "${field}" to an allowed value`;
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

/** The fields of one clause, quoted and joined, so a repair always names what it applies to. */
function quotedPaths(paths: Iterable<string>): string {
  return [...paths].map((path) => `"${path}"`).join(', ');
}

/** Repair hint for every present value of the wrong JSON type (an array sent as its stringified form, a number sent as text). One clause per expected shape, naming every field it applies to, so a call with several such faults gets a repair for each. */
function typeMismatchRepairHint(error: z.ZodError, input: unknown, schema?: z.ZodType): string | undefined {
  if (input === undefined) return undefined;
  const clauses = new Map<string, Set<string>>();
  const removals = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code !== 'invalid_type' || issue.path.length === 0) continue;
    const value = resolveAtPath(input, issue.path);
    if (value === undefined) continue;
    if (issue.expected === 'never') {
      const index = issue.path.reduce<number>((last, key, position) => typeof key === 'number' ? position : last, -1);
      const field = issue.path.join('.');
      const list = issue.path.slice(0, index).join('.');
      removals.add(index >= 0
        ? `Remove the entry at "${issue.path.slice(0, index + 1).join('.')}" from "${list}"; send "${list}": [] if no entries remain.`
        : `No values are allowed for "${field}"; omit that field.`);
      continue;
    }
    const nullNote = acceptsNullAt(schema, issue.path) ? ', or null when it does not apply' : '';
    const node = jsonSchemaNodeAt(schema, issue.path);
    const example = issue.expected === 'object' && node ? `, shaped like ${JSON.stringify(exampleOf(node))}` : '';
    const article = /^[aeiou]/i.test(issue.expected) ? 'an' : 'a';
    const shape = `as ${article} ${issue.expected}${example}${nullNote}`;
    clauses.set(shape, (clauses.get(shape) ?? new Set()).add(issue.path.join('.')));
  }
  const hints = [...removals, ...[...clauses].map(([shape, paths]) => `Send ${quotedPaths(paths)} ${shape}.`)];
  return hints.length > 0 ? hints.join(' ') : undefined;
}

/** Repair action for every value outside its served size bound; the measured size and the bound ride on the issue line. A list is merged or extended; a text is shortened or filled, never cut by the engine. One clause per action, naming every field it applies to. */
function sizeBoundRepairHint(error: z.ZodError): string | undefined {
  const clauses = new Map<string, Set<string>>();
  const mistyped = new Set(error.issues.filter(issue => issue.code === 'invalid_type').map(issue => dottedPath(issue.path)));
  for (const issue of error.issues) {
    if (issue.code !== 'too_big' && issue.code !== 'too_small') continue;
    if (mistyped.has(dottedPath(issue.path))) continue;
    let action: [lead: string, tail: string] | undefined;
    if (issue.origin === 'array' || issue.origin === 'set') {
      action = issue.code === 'too_big' ? ['Merge or drop the surplus in', '.'] : ['Add the missing items to', '.'];
    } else if (issue.origin === 'string') {
      action = issue.code === 'too_big'
        ? ['Shorten', ` to at most ${issue.maximum} characters; the engine never truncates authored text.`]
        : ['Send', ` with at least ${issue.minimum} character${issue.minimum === 1 ? '' : 's'}.`];
    }
    if (!action) continue;
    const key = JSON.stringify(action);
    clauses.set(key, (clauses.get(key) ?? new Set()).add(issue.path.join('.')));
  }
  if (clauses.size === 0) return undefined;
  return [...clauses].map(([key, paths]) => {
    const [lead, tail] = JSON.parse(key) as [string, string];
    return `${lead} ${quotedPaths(paths)}${tail}`;
  }).join(' ');
}

/** The repair instruction a schema refinement states itself, on `params.hint` of its custom issue. */
function issueOwnedRepairHint(error: z.ZodError): string | undefined {
  const hints: string[] = [];
  for (const issue of error.issues) {
    if (issue.code !== 'custom') continue;
    const hint = (issue.params as { hint?: unknown } | undefined)?.hint;
    if (typeof hint === 'string' && !hints.includes(hint)) hints.push(hint);
  }
  return hints.length > 0 ? hints.join(' ') : undefined;
}

/** Standing repair instruction for a provider call naming a tool outside this phase's catalog. The valid names ride in the rejection's `detail.allowedTools`, not this sentence, so the instruction stays one fixed sentence regardless of how many tools the phase offers. */
export const UNKNOWN_TOOL_REPAIR_HINT = 'Call one of the tools already offered in this response.';

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
function measuredSize(value: unknown): { readonly amount: number; readonly text: string } | undefined {
  if (typeof value === 'string') return { amount: value.length, text: `${value.length} chars` };
  if (Array.isArray(value)) return { amount: value.length, text: `${value.length} items` };
  if (typeof value === 'number') return { amount: value, text: `${value}` };
  return undefined;
}

/** Composes one reason line for a size violation from the issue's own metadata plus the received value: measured size and the bound. Falls back to the stock Zod message when the received value is unmeasurable or meets the bound before a schema transform. */
function describeSizeIssue(
  issue: Extract<z.core.$ZodIssue, { code: 'too_big' | 'too_small' }>,
  received: unknown,
): string | undefined {
  const size = measuredSize(received);
  if (size === undefined) return undefined;
  const inclusive = issue.inclusive ?? true;
  const limit = Number(issue.code === 'too_big' ? issue.maximum : issue.minimum);
  const fails = issue.code === 'too_big'
    ? (inclusive ? size.amount > limit : size.amount >= limit)
    : (inclusive ? size.amount < limit : size.amount <= limit);
  // A raw value inside the bound failed after a schema transform (a trimmed blank text): its measure would contradict the bound.
  if (!fails) return undefined;
  const bound = issue.code === 'too_big'
    ? (inclusive ? `limit ${issue.maximum}` : `less than ${issue.maximum}`)
    : (inclusive ? `minimum ${issue.minimum}` : `more than ${issue.minimum}`);
  return `${size.text}, ${bound}`;
}

/** One dotted path per offending key; a key over {@link KEY_ECHO_MAX_CHARS} yields its container's path, never the key. */
function unrecognizedKeyPaths(issue: Extract<z.core.$ZodIssue, { code: 'unrecognized_keys' }>): string[] {
  const base = issue.path.join('.');
  return issue.keys.map((key) => (key.length > KEY_ECHO_MAX_CHARS ? base : base ? `${base}.${key}` : key));
}

/** Longest submitted string echoed as `got`; a longer value is left out, never cut. */
const GOT_MAX_CHARS = 80;

/** The submitted value as `got`: a short scalar, or for a wrong type its JSON type name. */
function gotOf(value: unknown, typeName: boolean): RejectionError['got'] {
  if (typeof value === 'string') return value.length <= GOT_MAX_CHARS ? value : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return typeName && value !== undefined ? (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value) : undefined;
}

/** The faults of a Zod failure as {@link RejectionError}s, one per path and issue; union alternatives contribute their leaf issues and merge the values they accept. The accepted values come only from the issue itself (enum values, `params.allowed_values`) or the schema's declared keys. */
function zodRejectionErrors(error: z.ZodError, input: unknown, schema?: z.ZodType): RejectionError[] {
  const errors = new Map<string, RejectionError>();
  const add = (path: readonly PropertyKey[], fault: Omit<RejectionError, 'path'>, received: unknown, typeName = false): void => {
    const joined = path.join('.');
    const key = `${joined}|${fault.issue}`;
    const known = errors.get(key);
    const allowed = [...new Set([...(known?.allowed ?? []), ...(fault.allowed ?? [])])];
    const got = gotOf(received, typeName);
    errors.set(key, { ...known, ...fault, path: joined, ...(known?.allowed !== undefined || fault.allowed !== undefined ? { allowed } : {}), ...(got !== undefined ? { got } : {}) });
  };
  const visit = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[]): void => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path];
      const received = resolveAtPath(input, path);
      const missing = received === undefined ? 'Missing from this call' : undefined;
      if (issue.code === 'invalid_union') {
        for (const alternative of issue.errors) visit(alternative, path);
      } else if ((issue.code === 'too_big' || issue.code === 'too_small') && issues.some(other => other.code === 'invalid_type' && dottedPath(other.path) === dottedPath(issue.path))) {
        continue;
      } else if (issue.code === 'unrecognized_keys') {
        const node = jsonSchemaNodeAt(schema, path);
        const allowed = Object.keys((node ? unwrapNullable(node) : undefined)?.properties ?? {});
        for (const key of issue.keys) add(key.length > KEY_ECHO_MAX_CHARS ? path : [...path, key], { issue: 'Unrecognized key', ...(allowed.length ? { allowed } : {}) }, undefined);
      } else if (issue.code === 'invalid_type') {
        const text = enrichedIssueMessage(issue, received);
        add(path, { issue: missing ?? (text === baseIssueMessage(issue) ? 'Wrong type' : text), expected: issue.expected, ...(issue.expected === 'never' ? { allowed: [] } : {}) }, received, true);
      } else if (issue.code === 'invalid_value') {
        add(path, { issue: missing ?? INVALID_VALUE_REASON, allowed: issue.values.map(String) }, received);
      } else {
        const params = issue.code === 'custom' ? issue.params as { allowed_values?: string[]; when?: { node: string }; hint?: string } | undefined : undefined;
        add(path, { issue: [enrichedIssueMessage(issue, received), params?.hint].filter(Boolean).join(' '),
          ...(params?.allowed_values ? { allowed: params.allowed_values } : {}), ...(params?.when ? { when: params.when } : {}) }, received);
      }
    }
  };
  visit(error.issues, []);
  return [...errors.values()];
}

/**
 * One call fragment for the first of `fields` that `schema` defines as a structure, built from the schema alone.
 *
 * @returns `{ field: shape }`, or `undefined` when none of the fields is a structured one.
 */
export function exampleForFields(schema: z.ZodType, fields: readonly string[]): unknown {
  for (const field of fields) {
    const [name] = field.split('.');
    const node = jsonSchemaNodeAt(schema, [name!]);
    const target = node && unwrapNullable(node);
    if (target?.properties || target?.items) {
      const owner = schema instanceof z.ZodObject ? schema.shape[name!] : undefined;
      if (!owner) return undefined;
      const example = exampleOf(target);
      if (owner.safeParse(example).success) return { [name!]: example };
      if (Array.isArray(example) && owner.safeParse([]).success) return { [name!]: [] };
      return undefined;
    }
  }
  return undefined;
}

/** Build field repair once; `resend: 'owner'` leaves full-versus-held scope to the draft owner, and `form` states the faults as {@link RejectionError}s instead of a hint. */
export function rejectionFromZodError(
  error: z.ZodError,
  opts: { code: string; hint?: string; input?: unknown; schema?: z.ZodType; resend?: 'owner'; form?: true },
): ToolRejection {
  const issuePaths: string[] = [];
  const choices = new Map<string, Record<string, unknown>>();
  const collectChoices = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[] = []): void => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path];
      if (issue.code === 'invalid_union') {
        for (const branch of issue.errors) collectChoices(branch, path);
      } else if (issue.code === 'invalid_type' && issue.expected === 'never') {
        const choice = { kind: issue.code, path: path.join('.'), allowed_values: [] };
        choices.set(JSON.stringify(choice), choice);
      } else if (issue.code === 'invalid_value' || (issue.code === 'custom' && Array.isArray(issue.params?.allowed_values))) {
        const choice = { kind: issue.code, path: path.join('.'), allowed_values: issue.code === 'invalid_value' ? issue.values : issue.params!.allowed_values,
          ...(issue.code === 'custom' && issue.params?.when ? { when: issue.params.when } : {}) };
        choices.set(JSON.stringify(choice), choice);
      } else if (issue.code === 'unrecognized_keys') {
        const node = jsonSchemaNodeAt(opts.schema, path);
        const allowed = Object.keys((node ? unwrapNullable(node) : undefined)?.properties ?? {});
        for (const key of issue.keys) {
          const choice = { path: key.length > KEY_ECHO_MAX_CHARS ? dottedPath(path) : dottedPath([...path, key]),
            error: 'field_not_allowed', ...(allowed.length ? { allowed } : {}) };
          choices.set(JSON.stringify(choice), choice);
        }
      } else {
        const choice = { kind: issue.code, path: path.join('.'), ...Object.fromEntries(Object.entries(issue).filter(([key]) => ['expected', 'minimum', 'maximum', 'inclusive', 'format'].includes(key))) };
        choices.set(JSON.stringify(choice), choice);
      }
    }
  };
  collectChoices(error.issues.filter(issue => !((issue.code === 'too_big' || issue.code === 'too_small') && error.issues.some(other => other.code === 'invalid_type' && dottedPath(other.path) === dottedPath(issue.path)))));
  const shown = new Map<string, { issue: z.core.$ZodIssue; message: string; others: string[] }>();
  const mistyped = new Set(error.issues.filter(issue => issue.code === 'invalid_type').map(issue => dottedPath(issue.path)));
  for (const issue of error.issues) {
    if ((issue.code === 'too_big' || issue.code === 'too_small') && mistyped.has(dottedPath(issue.path))) continue;
    let message: string;
    if (issue.code === 'invalid_union') {
      const { line, paths } = describeInvalidUnion(issue, opts.input);
      issuePaths.push(...paths);
      message = line;
    } else {
      const path = issue.path.join('.');
      if (issue.code === 'unrecognized_keys') issuePaths.push(...unrecognizedKeyPaths(issue));
      else if (path) issuePaths.push(path);
      message = opts.input !== undefined
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
    hint: opts.hint ?? (opts.form ? undefined : [zodFieldRepairHint(error, opts.input, opts.schema),
      ...(opts.resend === 'owner' ? [] : [INVALID_TOOL_INPUT_REPAIR_HINT])].filter(Boolean).join(' ')),
    issuePaths,
    ...(choices.size ? { detail: [...choices.values()] } : {}),
    ...(opts.form ? { errors: zodRejectionErrors(error, opts.input, opts.schema) } : {}),
  });
}
