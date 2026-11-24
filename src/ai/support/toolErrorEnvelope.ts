/**
 * Single typed channel for tool-result rejections.
 *
 * @remarks
 * Every tool, guard and engine refusal is emitted by {@link makeRejection} in one shape —
 * `{ code, reason, hint?, detail?, issuePaths?, entryIds?, errors? }` — and serialized as the
 * tool result. {@link readToolError} reads that shape back. Provider-pure.
 */
import { z } from 'zod';
import { toModelJsonSchema } from '../tools/jsonSchema';
import { locateJsonTextFault, parseJson } from './inputNormalization';
import { REJECTION_CODES } from './rejectionCodes';
import { sectionField } from '../session/classification';

const ISSUE_CATEGORIES = ['shape', 'required', 'reference', 'value', 'protocol', 'stage'] as const;
type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

/**
 * Fixed wording of one issue code: the fault (`label`) and its repair (`correction`), absent where the
 * reason already states the repair.
 */
interface IssueText {
  readonly category: IssueCategory;
  readonly label: string;
  readonly correction?: string;
}

type RegistryCode = (typeof REJECTION_CODES)[keyof typeof REJECTION_CODES];
/** Codes of a schema fault, mapped from Zod issue codes by {@link rejectionFromZodError}. */
type SchemaIssueCode = 'type' | 'json_text' | 'unknown_key' | 'never' | 'missing' | 'enum' | 'size' | 'invalid';

const BACKEND_FAULT = {
  category: 'stage',
  label: 'extension fault',
  correction: 'The run ends; the extension reports the fault to the user.',
} as const;

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

/** The sections exit of a column fault, shared by its table row and {@link REFERENCE_FALLBACK}. */
const SECTIONS_EXIT = 'in the section fields; further work on it goes in questions.';

/** Stable message shared by {@link NoProjectLoadedError} and {@link buildNoProjectLoadedError}. */
const NO_PROJECT_LOADED_MESSAGE =
  'No project is loaded in the Data Lineage panel (closed or not opened yet); open the project and ask again.';

/**
 * Every issue code's fixed category and fault/correction text: each registry code and each schema
 * fault code. A fault on a rejection's `errors` names one of these keys.
 */
export const ISSUES = {
  type: {
    category: 'shape',
    label: 'wrong JSON type',
  },
  json_text: {
    category: 'shape',
    label: 'text that is not valid JSON',
  },
  unknown_key: {
    category: 'shape',
    label: 'not a field of this object',
  },
  never: {
    category: 'shape',
    label: 'field not accepted here',
    correction: "Put this content where the field's schema description places it; this field stays out of the call.",
  },
  missing: {
    category: 'required',
    label: 'required field',
    correction: 'Add a value for this field as its schema describes.',
  },
  enum: {
    category: 'value',
    label: 'not an allowed value',
  },
  size: {
    category: 'value',
    label: 'outside its size bound',
  },
  invalid: {
    category: 'value',
    label: 'breaks the rule of this field',
    correction: 'Send a value that meets the rule stated above.',
  },
  [REJECTION_CODES.offPolicy]: {
    category: 'stage',
    label: 'tool not offered in this step',
    correction: 'Call a tool this step offers.',
  },
  [REJECTION_CODES.alreadyStarted]: {
    category: 'protocol',
    label: 'an exploration is already running',
    correction: 'Continue the running exploration with lineage_submit_findings.',
  },
  [REJECTION_CODES.duplicateCallId]: {
    category: 'protocol',
    label: 'call id already used in this reply',
    correction: DUPLICATE_CALL_ID_REPAIR_HINT,
  },
  [REJECTION_CODES.emptyGeneration]: {
    category: 'stage',
    label: 'reply carried no text and no call',
    correction: 'Answer the user in text, or call a tool for more evidence.',
  },
  [REJECTION_CODES.duplicateRead]: {
    category: 'protocol',
    label: 'read already answered in this step',
    correction: 'Answer from the result already in the conversation, or call a different read.',
  },
  [REJECTION_CODES.noRunMemory]: {
    category: 'stage',
    label: 'no stored run for the applied view',
    correction: 'Answer from what the applied view shows.',
  },
  [REJECTION_CODES.staleTurn]: BACKEND_FAULT,
  [REJECTION_CODES.invalidInput]: {
    category: 'value',
    label: 'breaks the input contract of this tool',
    correction: 'Correct this field as its schema describes.',
  },
  [REJECTION_CODES.notFound]: {
    category: 'reference',
    label: 'not an object in the loaded model',
    correction: 'Name an object of the loaded model by its id.',
  },
  [REJECTION_CODES.supplementRequiresCompleteEngine]: {
    category: 'stage',
    label: 'no completed exploration to supplement',
    correction: 'Start a fresh exploration instead (omit /supplement, provide /origin).',
  },
  [REJECTION_CODES.supplementEmpty]: {
    category: 'value',
    label: 'supplement names no object',
    correction: 'Answer from what the completed exploration holds.',
  },
  [REJECTION_CODES.supplementAllRefused]: {
    category: 'reference',
    label: 'every supplement id was refused',
    correction: 'Propose a new exploration with lineage_start_exploration for an object the trace does not reach.',
  },
  [REJECTION_CODES.invalidRegex]: {
    category: 'value',
    label: 'pattern does not compile within the length and time limits',
    correction: 'Send a simpler pattern that compiles, or a plain name fragment.',
  },
  [REJECTION_CODES.overDiscoveryBudget]: {
    category: 'stage',
    label: 'scope exceeds the discovery budget',
    correction: 'Propose an exploration with lineage_start_exploration; it reads the scope hop by hop.',
  },
  [REJECTION_CODES.overActiveScopeBudget]: {
    category: 'stage',
    label: 'scope over the configured round or column limit',
    correction: 'Propose a narrower scope: fewer levels or fewer columns.',
  },
  [REJECTION_CODES.actionRequired]: {
    category: 'stage',
    label: 'waiting for the user decision on the card',
    correction: 'Wait for the user decision; the card holds the proposal.',
  },
  [REJECTION_CODES.missingField]: {
    category: 'required',
    label: 'required field',
    correction: 'Add a value for this field as its schema describes.',
  },
  [REJECTION_CODES.ctFieldForbiddenInBb]: {
    category: 'value',
    label: '/targetColumns sent with /analysisMode "bb"',
    correction: 'Omit /targetColumns and resubmit the BB specification.',
  },
  [REJECTION_CODES.noActiveSession]: {
    category: 'stage',
    label: 'no exploration is running',
    correction: 'Start an exploration with lineage_start_exploration, or answer from what the conversation holds.',
  },
  [REJECTION_CODES.noProjectLoaded]: {
    category: 'stage',
    label: 'no project is loaded in the Data Lineage panel',
    correction: NO_PROJECT_LOADED_MESSAGE,
  },
  [REJECTION_CODES.staleProposalRevision]: {
    category: 'protocol',
    label: 'not the revision the approval card shows',
    correction: 'proposalRevision is valid only while refining the matching pending approval gate.',
  },
  [REJECTION_CODES.routeValidationFailed]: {
    category: 'reference',
    label: 'reference not valid for this hop',
    correction: 'Correct the listed references; the other fields of the call stay held.',
  },
  [REJECTION_CODES.outColNotOnNode]: {
    category: 'reference',
    label: 'not a column of the current object',
    correction: 'Recheck the exact object and column identity against the supplied SQL; do not guess a replacement.',
  },
  [REJECTION_CODES.outColNotTracked]: {
    category: 'reference',
    label: 'not a tracked column of this hop',
    correction: 'Set column_flow[].out_col to a tracked column from the `<column_trace> Active columns` list supplied for this hop — the named column exists on this node but the trace does not follow it — or submit column_flow: [] if this node carries no tracked column.',
  },
  [REJECTION_CODES.contributorColNotOnSource]: {
    category: 'reference',
    label: 'not a declared column of that object',
    correction: 'Recheck the exact object and column identity against the supplied SQL; do not guess a replacement.',
  },
  [REJECTION_CODES.columnSelfLoop]: {
    category: 'value',
    label: 'upstream entry identical to its output destination',
    correction: 'Remove the upstream_columns entry identical to its output destination; keep a SQL-proved writes_to unchanged and explain any existing-destination read in the section fields.',
  },
  [REJECTION_CODES.writesToNamesReader]: {
    category: 'reference',
    label: 'a downstream reader, not a write destination',
    correction: 'Set writes_to to the table and column this hop\'s SQL writes, or to null when it writes no table or only a table outside the approved scope. A downstream reader is never a write destination: remove that node from writes_to; every open neighbor you do not prune is visited anyway.',
  },
  [REJECTION_CODES.prunedContributor]: {
    category: 'reference',
    label: 'node already pruned this run',
    correction: 'This upstream node was already pruned earlier this run and cannot supply the column — a removed node stays removed. Name a different, still-reachable supplier for this upstream_columns entry, or submit upstream_columns: [] and account for the column ending here.',
  },
  [REJECTION_CODES.columnOutOfScope]: {
    category: 'reference',
    label: 'column outside the approved scope',
    correction: `column_flow names only in-scope objects. Drop the outside entry from upstream_columns, or set writes_to to null; use column_flow: [] if no entry remains. State the fact about the outside object ${SECTIONS_EXIT}`,
  },
  [REJECTION_CODES.emptyStructuredOutput]: {
    category: 'stage',
    label: 'required call arrived with empty arguments',
    correction: 'Call the required tool now, with its content as arguments.',
  },
  [REJECTION_CODES.missingRequiredToolCall]: {
    category: 'stage',
    label: 'reply carried no call of the required tool',
    correction: 'Call the required tool now, with its content as arguments.',
  },
  [REJECTION_CODES.toolExecutionError]: BACKEND_FAULT,
  [REJECTION_CODES.internalError]: BACKEND_FAULT,
  [REJECTION_CODES.engineCrash]: BACKEND_FAULT,
  [REJECTION_CODES.validation]: {
    category: 'value',
    label: 'breaks the rule of this field',
    correction: 'Send a value that meets the rule stated above.',
  },
  [REJECTION_CODES.invalidStatus]: BACKEND_FAULT,
  [REJECTION_CODES.explorationComplete]: {
    category: 'stage',
    label: 'exploration complete',
    correction: 'Call lineage_present_result to assemble the report.',
  },
  [REJECTION_CODES.focusNodeIdMismatch]: {
    category: 'reference',
    label: 'not the current object',
    correction: 'Use the id of the current object.',
  },
  [REJECTION_CODES.invalidToolInput]: {
    category: 'shape',
    label: 'call does not match the tool schema',
    correction: 'Correct this field to match the tool schema.',
  },
  [REJECTION_CODES.toolCallNotation]: {
    category: 'shape',
    label: 'value carries tool-call notation',
    correction: 'Send each field as its own argument, without the notation.',
  },
  [REJECTION_CODES.unknownTool]: {
    category: 'stage',
    label: 'not a tool of this step',
    correction: UNKNOWN_TOOL_REPAIR_HINT,
  },
  [REJECTION_CODES.invalidStructuredOutput]: {
    category: 'shape',
    label: 'required call missing, repeated or schema-invalid',
    correction: 'Send one call of the required tool that matches its schema.',
  },
  [REJECTION_CODES.notConnectedToTrace]: {
    category: 'reference',
    label: 'no dependency path to the traced graph',
    correction: 'Propose a new exploration with lineage_start_exploration for an object the trace does not reach.',
  },
  [REJECTION_CODES.extraCallNotEvaluated]: {
    category: 'protocol',
    label: 'not evaluated: one commit call per reply',
    correction: 'Send one commit call per reply that carries all its content.',
  },
  [REJECTION_CODES.invalidPendingLead]: {
    category: 'reference',
    label: 'not an unresolved pending lead',
    correction: 'Use an unresolved pending lead id from the completed exploration, or provide explicit supplement nodeIds.',
  },
  [REJECTION_CODES.missingResultGraph]: {
    category: 'stage',
    label: 'no completed exploration to present',
    correction: 'Complete the active exploration first.',
  },
  [REJECTION_CODES.noOpRefine]: {
    category: 'protocol',
    label: 'refinement changes nothing in the proposal',
    correction: 'Apply the requested change to scope, mode, classification, columns or filter, or answer the user in text when the plan needs no change.',
  },
  [REJECTION_CODES.originNotFound]: {
    category: 'reference',
    label: 'not an object in the loaded model',
    correction: 'Verify the origin node id with lineage_search_objects first. Use the exact id it returns.',
  },
  [REJECTION_CODES.outOfScopeOrNotNeighbor]: {
    category: 'reference',
    label: 'not a neighbor of the current object in scope',
    correction: 'Send only ids listed as neighbors of the current object.',
  },
  [REJECTION_CODES.parallelCallForbidden]: {
    category: 'protocol',
    label: 'lineage_start_exploration already called in this reply',
    correction: 'Send lineage_submit_findings for the current object; each accepted finding serves the next queued object.',
  },
  [REJECTION_CODES.phaseClosed]: {
    category: 'protocol',
    label: 'not executed: an earlier call of this reply closed the step',
    correction: 'Do not retry it.',
  },
  [REJECTION_CODES.queryNotAName]: {
    category: 'value',
    label: 'punctuation only, which matches no name',
    correction: 'Send part of a name, or set mode to regex for a pattern.',
  },
  [REJECTION_CODES.queryTooShort]: {
    category: 'value',
    label: 'query too short to match a name',
    correction: 'Send a fragment of an object or column name.',
  },
  [REJECTION_CODES.resultTooLarge]: {
    category: 'stage',
    label: 'result larger than this step holds',
    correction: 'Send a narrower request: fewer ids, a filter or fewer types.',
  },
  [REJECTION_CODES.unknownColumns]: {
    category: 'reference',
    label: 'not a declared column of the origin',
    correction: 'Name a column declared on that object.',
  },
  [REJECTION_CODES.unknownNodeIds]: {
    category: 'reference',
    label: 'not an object in the loaded model',
    correction: 'Name an object of the loaded model by its id.',
  },
  [REJECTION_CODES.asymmetricDepthBothZero]: {
    category: 'value',
    label: 'both depth sides are 0',
    correction: 'Set at least one depth side above 0.',
  },
} as const satisfies Record<RegistryCode | SchemaIssueCode, IssueText>;

/** @internal */
export type IssueCode = keyof typeof ISSUES;
const ISSUE_CODES = Object.keys(ISSUES) as [IssueCode, ...IssueCode[]];

/**
 * One independently decidable fault: its dotted path and issue code, with the backend facts it
 * concerns (allowed `values`, accepted `types`, a size `bound`), never a submitted value. `stated`
 * marks a fault whose table correction the rejection's reason or hint already replaces (a
 * refinement's own hint, the variants of a union, a route fault's own reason).
 */
const ToolErrorShape = z.object({
  path: z.string(),
  code: z.enum(ISSUE_CODES),
  values: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  bound: z.object({ keyword: z.string().min(1), limit: z.number(), sent: z.number().int().nonnegative().optional() }).strict().optional(),
  stated: z.literal(true).optional(),
}).strict();

/** One independently decidable fault of a rejection. */
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
  /** Fields the session holds for the retry; the last feedback names them. */
  held?: string[];
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
  held: z.array(z.string()).optional(),
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
 * first rejection's code does. A rejection without typed faults is its own code at each issue path,
 * which its reason and hint state.
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
    issuePaths: [...new Set(rejections.flatMap(rejection => rejection.issuePaths ?? []))],
    entryIds: rejections.flatMap(rejection => rejection.entryIds ?? []),
    ...(details.length > 0 ? { detail: [...new Map(details.map(detail => [JSON.stringify(detail), detail])).values()] } : {}),
    errors: rejections.flatMap(rejection => rejection.errors
      ?? (rejection.code in ISSUES ? (rejection.issuePaths ?? []).map(path => ({ path, code: rejection.code as IssueCode, stated: true as const })) : [])),
  });
}

/**
 * Last-feedback fallback of a column reference fault that cannot be corrected, in the words of the
 * `column_out_of_scope` exit.
 */
const REFERENCE_FALLBACK = `If you cannot correct it, state the fact ${SECTIONS_EXIT}`;

/** The exit a missing or mistyped field that accepts `null` adds to its correction. */
const NULL_EXIT = 'Send null when it does not apply.';

/** The served schema path of a dotted fault path: an index segment addresses list items. */
function schemaPath(path: string): PropertyKey[] {
  return path.split('.').filter(Boolean).map(key => (/^\d+$/.test(key) ? Number(key) : key));
}

/**
 * The repair of one fault: the shape of a mistyped object, the direct send of a mistyped array, else
 * its table correction, and for a mistyped or missing field that accepts `null` the null exit after it.
 */
function faultCorrection(error: ToolError, schema: z.ZodType | undefined): string[] {
  const node = error.code === 'type' || error.code === 'json_text' || error.code === 'missing' ? jsonSchemaNodeAt(schema, schemaPath(error.path)) : undefined;
  const object = (error.code === 'type' || error.code === 'json_text') && node && unwrapNullable(node).properties ? unwrapNullable(node) : undefined;
  const row: IssueText = ISSUES[error.code];
  const correction = object
    ? `Send the object directly, shaped like ${JSON.stringify(exampleOf(object))}.`
    : (error.code === 'type' || error.code === 'json_text') && error.types?.[0] === 'array' ? 'Send the array directly.' : row.correction;
  const lines = correction === undefined ? [] : [correction];
  return node && acceptsNull(node) ? [...lines, NULL_EXIT] : lines;
}

/**
 * The model-facing lines of a rejection's faults: one `<pointer>: label. correction` line per path
 * that has a correction the rejection does not already state ({@link ToolError}`.stated`), with
 * every label of that path; paths with the same text share one line. A Zod fault's correction
 * rides its reason line instead (`stated`).
 *
 * @param schema - The tool's input schema as served when the rejection renders; names the shape of a
 *   mistyped object and the null exit of a nullable field.
 */
export function renderFaults(rejection: ToolRejection, schema?: () => z.ZodType | undefined): string[] {
  const byPath = new Map<string, ToolError[]>();
  for (const error of rejection.errors ?? []) byPath.set(error.path, [...(byPath.get(error.path) ?? []), error]);
  const served = schema?.();
  const lines = new Map<string, string[]>();
  for (const [path, errors] of byPath) {
    const labels = [...new Set(errors.map(error => ISSUES[error.code].label))].join('; ');
    const corrections = [...new Set(errors.filter(error => !error.stated).flatMap(error => faultCorrection(error, served)))];
    if (corrections.length === 0) continue;
    const text = [`${labels}.`, ...corrections].join(' ');
    lines.set(text, [...(lines.get(text) ?? []), path]);
  }
  return [...lines].map(([text, paths]) => [paths.filter(Boolean).map(path => jsonPointer(path.split('.'))).join(', '), text].filter(Boolean).join(': '));
}

/**
 * The help the last feedback adds to a rejection's faults, from the served schema alone (never a
 * sent value): the fallback of a column reference fault whose correction gives no sections exit of
 * its own (a rejection without faults is its code at each issue path); for an unknown key, the
 * nearest enclosing object that defines it, the home of prose (the served section fields) and the
 * shape of the object it was sent in, or for a root key no field defines at any level, that it has
 * no place in the call; and the shape of every other faulted object or list. Where none of these
 * applies: the full served meaning and the unstated constraints of the one field a schema keyword
 * failed, or for a fault with no path the tool that ends the step and its required fields.
 *
 * @param schema - The tool's input schema as served when the rejection renders.
 * @param context - The tool the rejected call named and the tool that ends the step with its served
 *   schema.
 */
export function renderLastFeedbackHelp(
  rejection: ToolRejection,
  schema: (() => z.ZodType | undefined) | undefined,
  context: FeedbackContext,
): string[] {
  const errors = rejection.errors ?? [];
  const lines: string[] = [];
  const faults = errors.length > 0 ? errors : (rejection.issuePaths ?? []).map(path => ({ path, code: rejection.code }));
  const table: Record<string, IssueText | undefined> = ISSUES;
  if (faults.some(({ path, code }) => table[code]?.category === 'reference' && /^column_flow(?:\.|$)/.test(path)
    && !table[code]!.correction?.endsWith(SECTIONS_EXIT))) {
    lines.push(REFERENCE_FALLBACK);
  }
  if (faults.length === 0 && context.terminal) return [...lines, ...stepTerminal(context.terminal)];
  const served = schema?.();
  const root = jsonSchemaNodeAt(served, []);
  if (!root) return lines;
  const homes = new Set<string>();
  const shapes = new Map<string, string>();
  const placeless = new Set<string>();
  let unknownKeys = false;
  for (const { path, code } of faults) {
    const segments = schemaPath(path);
    const node = jsonSchemaNodeAt(served, segments);
    if (code !== 'unknown_key') {
      if (segments.length > 0 && node && (objectBranch(node) || listBranch(node))) shapes.set(jsonPointer(segments), shapeOf(node));
      continue;
    }
    // A key too long to echo is reported at its object's path, so the key itself is unknown here.
    const key = path !== '' && !node ? String(segments.at(-1)) : undefined;
    const at = key === undefined ? segments : segments.slice(0, -1);
    const object = jsonSchemaNodeAt(served, at);
    if (!object || !objectBranch(object)) continue;
    unknownKeys = true;
    if (key !== undefined) {
      const home = ancestorHome(served, at, key);
      if (home) homes.add(home);
    }
    if (at.length > 0) {
      shapes.set(jsonPointer(at), shapeOf(object));
    } else if (key !== undefined && !definesKey(root, key)) {
      placeless.add(`No field of ${context.toolName} at any level is named ${quoteKey(key)}; it has no place in this call.`);
    } else if (key !== undefined) {
      shapes.set('', shapeOf(root, 1));
    }
  }
  const sections = (['business', 'technical'] as const).map(sectionField).filter(field => hasField(propertiesOf(root), field));
  const prose = unknownKeys && sections.length > 0 ? `Prose goes in ${sections.map(field => jsonPointer([field])).join(' or ')}.` : undefined;
  const facts = [
    ...homes,
    ...(prose ? [prose] : []),
    ...[...shapes].map(([at, shape]) => `${at ? `${at} is` : 'The call is'} shaped ${shape}.`),
    ...placeless,
  ];
  const paths = [...new Set(faults.map(({ path }) => path))];
  const field = facts.length === 0 && paths.length === 1 && paths[0] !== '' ? jsonSchemaNodeAt(served, schemaPath(paths[0]!)) : undefined;
  const keywordFault = field !== undefined && faults.some(({ code }) => MEANING_CODES.has(code)
    || (code === 'invalid' && variantsOf(field).some(variant => variant.pattern !== undefined)));
  return [...lines, ...facts, ...(keywordFault ? fieldMeaning(field, jsonPointer(schemaPath(paths[0]!)), errors) : [])];
}

/** What {@link renderLastFeedbackHelp} reads beyond the rejection and its tool's schema. */
export interface FeedbackContext {
  /** The tool the rejected call named. */
  readonly toolName: string;
  /** The tool that ends the step and its schema as served. */
  readonly terminal?: { readonly tool: string; readonly schema: () => z.ZodType | undefined };
}

/**
 * Fault codes of a schema keyword on one field (`enum`, `type`, a length or item bound), whose
 * meaning the last feedback adds; a `pattern` fault arrives as `invalid` on a field with a pattern.
 */
const MEANING_CODES: ReadonlySet<string> = new Set(['enum', 'type', 'size']);

/** The tool that ends the step and its required fields by pointer; empty if it requires none. */
function stepTerminal(terminal: NonNullable<FeedbackContext['terminal']>): string[] {
  const required = jsonSchemaNodeAt(terminal.schema(), [])?.required ?? [];
  return required.length > 0 ? [`This step ends with ${terminal.tool}; it requires ${required.map(field => jsonPointer([field])).join(', ')}.`] : [];
}

/**
 * The full served description of one field and each constraint of its schema (type, enum values,
 * pattern, length or item bounds) its faults did not state: a fault with `values` states the enum,
 * a `type` fault or one with `types` the type, a `size` fault its bound, a format fault
 * (`invalid`) the pattern.
 */
function fieldMeaning(node: JsonSchemaShape, pointer: string, faults: readonly Pick<ToolError, 'code' | 'values' | 'types' | 'bound'>[]): string[] {
  const description = variantsOf(node).map(variant => variant.description).find(Boolean)?.trim();
  const branch = variantsOf(node).find(variant => variant.type !== 'null' && (variant.type || variant.enum)) ?? node;
  const stated = (keyword: string) => faults.some(fault => (keyword === 'enum' ? fault.values !== undefined
    : keyword === 'type' ? fault.code === 'type' || fault.types !== undefined
      : keyword === 'pattern' ? fault.code === 'invalid' : fault.bound?.keyword === keyword));
  const constraints = [
    ...(branch.enum ? [['enum', branch.enum.map(value => JSON.stringify(value)).join(', ')]] : branch.type ? [['type', [branch.type].flat().join(' or ')]] : []),
    ...(branch.pattern ? [['pattern', branch.pattern]] : []),
    ...(['minLength', 'maxLength', 'minItems', 'maxItems'] as const).flatMap(keyword => (branch[keyword] === undefined ? [] : [[keyword, String(branch[keyword])]])),
  ].filter(([keyword]) => !stated(keyword!)).map(([keyword, value]) => `${keyword} ${value}`);
  const schemaText = constraints.length > 0 ? ` ${description ? 'Its schema' : 'schema'}: ${constraints.join(', ')}.` : '';
  if (description) return [`${pointer} means: ${description}${schemaText}`];
  return schemaText ? [`${pointer}${schemaText}`] : [];
}

/** Whether the served schema's field `field` is a list. */
export function isServedList(schema: () => z.ZodType | undefined, field: string): boolean {
  const node = jsonSchemaNodeAt(schema(), [field]);
  return node !== undefined && listBranch(node) !== undefined;
}

/**
 * The shape of a schema node: every property in schema order, an object as `{…}`, a list as
 * `[…]` around its item's shape and any other value as `…`; never an enum member or another
 * value.
 *
 * @param depth - Object levels whose properties are spelled out; deeper objects stay `{…}`.
 */
function shapeOf(node: JsonSchemaShape, depth = Infinity): string {
  const object = objectBranch(node);
  if (object) {
    return depth < 1 ? '{…}' : `{${Object.entries(object.properties!).map(([key, field]) => `${JSON.stringify(key)}: ${shapeOf(field, depth - 1)}`).join(', ')}}`;
  }
  const list = listBranch(node);
  return list ? `[${shapeOf(list.items!, depth)}]` : '…';
}

/**
 * The nearest object strictly enclosing `at` that defines `key`, as
 * `"key" is a field of …: <pointer>.`
 */
function ancestorHome(served: z.ZodType | undefined, at: readonly PropertyKey[], key: string): string | undefined {
  for (let end = at.length - 1; end >= 0; end--) {
    const ancestor = at.slice(0, end);
    if (hasField(propertiesOf(jsonSchemaNodeAt(served, ancestor)), key)) {
      return `${quoteKey(key)} is a field of ${jsonPointer(ancestor) || 'the call'}: ${jsonPointer([...ancestor, key])}.`;
    }
  }
  return undefined;
}

/** Whether any object of the node, at any depth, defines `key`. */
function definesKey(node: JsonSchemaShape, key: string): boolean {
  const object = objectBranch(node);
  const list = listBranch(node);
  return (object !== undefined && (hasField(object.properties!, key) || Object.values(object.properties!).some(field => definesKey(field, key))))
    || (list !== undefined && definesKey(list.items!, key));
}

/**
 * Narrowed view of a Zod v4 `invalid_union` issue. Its `errors` field holds one sub-issue array per
 * union branch — the raw material {@link describeInvalidUnion} expands into a per-branch required-
 * field breakdown. (Zod v4 renamed the v3 `unionErrors: ZodError[]` shape to
 * `errors: $ZodIssue[][]`.)
 */
type InvalidUnionIssue = Extract<z.core.$ZodIssue, { code: 'invalid_union' }>;

/** Whether a received value is text that opens an object or array, where the schema needs one. */
function isStructuredText(issue: z.core.$ZodIssue, received: unknown): issue is Extract<z.core.$ZodIssue, { code: 'invalid_type' }> {
  return issue.code === 'invalid_type' && typeof received === 'string' && /^\s*[[{]/.test(received)
    && (issue.expected === 'object' || issue.expected === 'array');
}

/** Whether that text is not valid JSON. */
const isUnparsedJsonText = (issue: z.core.$ZodIssue, received: unknown) => isStructuredText(issue, received) && parseJson(received as string) === undefined;

/**
 * Enriches one Zod issue's message with the measured size against the bound for
 * `too_big`/`too_small` (models cannot count characters), and names a structured field that
 * arrived as text where a JSON object or array is needed: text that is not valid JSON says so with
 * its first fault by position, short window and edit ({@link locateJsonTextFault}). Beyond that window the received value is
 * never echoed: the rejected call stays in the transcript with its arguments.
 */
function enrichedIssueMessage(issue: z.core.$ZodIssue, received: unknown): string {
  if (issue.code === 'too_big' || issue.code === 'too_small') {
    return describeSizeIssue(issue, received) ?? issue.message;
  }
  if (isStructuredText(issue, received)) {
    if (parseJson(received as string) === undefined) {
      const fault = locateJsonTextFault(received as string);
      return `not valid JSON${fault ? `: ${fault}` : ''}.`;
    }
    return `received text where ${issue.expected === 'array' ? 'an array' : 'an object'} is needed.`;
  }
  return baseIssueMessage(issue);
}

/**
 * Describes one union branch: its deduped required-field names (first-seen order, prefixed with the
 * union issue's own path so a nested union reads as a full path from the payload root) and one
 * model-facing line per sub-issue: the bare JSON Pointer when absent from `input` (the missing name
 * is the defect), else `"<path>: <enriched message>"` when present but matching no branch (e.g.
 * `/depth: Invalid input: expected number, received string`). Without the defect message a scalar
 * union collapses to `variant 1: /depth; variant 2: /depth`, naming the field but not the defect, and
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
    descriptors.push(`${jsonPointer(full) || '(root)'}${received === undefined ? '' : `: ${enrichedIssueMessage(sub, received)}`}`);
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
 * that tells a missing field apart from one merely typed wrong ({@link describeInvalidUnion}) — one
 * wording, not a second phrase invented per call site.
 */
const MISSING_FIELD_FRAGMENT = 'missing entirely from this call';

/**
 * One union branch's text: the comma-joined descriptors, except a branch reducing to exactly one
 * bare (missing) field, which states that the field is required and absent rather than leaving a
 * lone field pointer to be read as the defect. Several fields, or one present-but-wrong-type field,
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
  const?: unknown;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
}

/** The RFC 6901 JSON Pointer a served reason or fault line names: `/sections/2/blocks`; `''` is the call. */
export const jsonPointer = (path: readonly PropertyKey[]): string => path.map(key => `/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/** Whether the served schema has the dotted `path`. */
export function isServedField(schema: () => z.ZodType | undefined, path: string): boolean {
  return jsonSchemaNodeAt(schema(), path.split('.')) !== undefined;
}

/** The top-level fields the served schema requires that `input` does not send. */
export function unsentRequiredFields(schema: () => z.ZodType | undefined, input: unknown): string[] {
  const sent = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {};
  return (jsonSchemaNodeAt(schema(), [])?.required ?? []).filter(field => sent[field] === undefined);
}

/** The JSON Schema node `path` addresses in `schema`; `undefined` if the path leaves the schema. */
function jsonSchemaNodeAt(schema: z.ZodType | undefined, path: readonly PropertyKey[]): JsonSchemaShape | undefined {
  if (!schema) return undefined;
  let node = toModelJsonSchema(schema) as JsonSchemaShape;
  for (const key of path) {
    const next: JsonSchemaShape | undefined = variantsOf(node)
      .map((variant) => (typeof key === 'number' ? variant.items : variant.properties?.[String(key)]))
      .find((candidate) => candidate !== undefined);
    if (!next) return undefined;
    node = next;
  }
  return node;
}

/** Whether an object's own properties include `key` (a sent key may be any string). */
const hasField = (properties: object, key: string): boolean => Object.prototype.hasOwnProperty.call(properties, key);

/** A node and its union branches. */
const variantsOf = (node: JsonSchemaShape): JsonSchemaShape[] => [node, ...(node.anyOf ?? []), ...(node.oneOf ?? [])];

/** The branch of a node that is an object with properties; `undefined` for any other node. */
const objectBranch = (node: JsonSchemaShape): JsonSchemaShape | undefined => variantsOf(node).find(variant => variant.properties);

/** The branch of a node that is a list; `undefined` for any other node. */
const listBranch = (node: JsonSchemaShape): JsonSchemaShape | undefined => variantsOf(node).find(variant => variant.items);

/** The properties of a node's object branch; empty for a missing node or any other node. */
const propertiesOf = (node: JsonSchemaShape | undefined): Record<string, JsonSchemaShape> => (node && objectBranch(node)?.properties) ?? {};

/** Whether a node accepts `null`: its own type or one of its branches. */
function acceptsNull(node: JsonSchemaShape): boolean {
  return variantsOf(node).some(variant => [variant.type ?? []].flat().includes('null'));
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

/** Non-null branch of a nullable node (`anyOf: [X, {type: 'null'}]`); any other node unchanged. */
function unwrapNullable(node: JsonSchemaShape): JsonSchemaShape {
  const branches = node.anyOf;
  if (!branches) return node;
  const nonNull = branches.filter((branch) => branch.type !== 'null');
  return nonNull.length === 1 && nonNull.length < branches.length ? nonNull[0]! : node;
}

/**
 * Hint for `unrecognized_keys` issues, one sentence per object by JSON Pointer (the call for a root
 * issue): the key is no field of that object, it is removed, and the object's fields are named so a
 * misspelt key is renamed. A key that an entry of a list in that object defines is moved into an
 * entry of that list instead, so a flattened entry key keeps its value.
 *
 * @returns The object-directed hint; `undefined` when the schema is absent or does not resolve the
 *   object, so the caller keeps the key-only wording.
 */
function objectKeyRemovalHint(error: z.ZodError, schema: z.ZodType | undefined): string | undefined {
  const issues = error.issues.filter((issue) => issue.code === 'unrecognized_keys');
  if (issues.length === 0) return undefined;
  const objects = new Map<string, { homes: Map<string, Set<string>>; allowed: string[] }>();
  for (const issue of issues) {
    const properties = propertiesOf(jsonSchemaNodeAt(schema, issue.path));
    const allowed = Object.keys(properties);
    if (allowed.length === 0) return undefined;
    const at = jsonPointer(issue.path);
    const object = objects.get(at) ?? { homes: new Map<string, Set<string>>(), allowed };
    for (const key of issue.keys) {
      const homes = object.homes.get(key) ?? new Set<string>();
      for (const [list, listNode] of Object.entries(properties)) {
        const entry = listBranch(listNode)?.items;
        if (entry && hasField(propertiesOf(entry), key)) homes.add(jsonPointer([...issue.path, list]));
      }
      object.homes.set(key, homes);
    }
    objects.set(at, object);
  }
  return [...objects].map(([at, { homes, allowed }]) => {
    // Keys defined by the same lists share one action.
    const actions = new Map<string, string[]>();
    for (const [key, lists] of homes) {
      const into = [...lists].join(' or ');
      actions.set(into, [...(actions.get(into) ?? []), key]);
    }
    const act = (into: string, keys: string) => (into ? `move ${keys} into an entry of ${into}` : `remove ${keys}`);
    const action = actions.size === 1
      ? act([...actions.keys()][0]!, homes.size > 1 ? 'them' : 'it')
      : [...actions].map(([into, keys]) => act(into, keys.map(quoteKey).join(', '))).join(' and ');
    const sentence = `${[...homes.keys()].map(quoteKey).join(', ')} ${homes.size > 1 ? 'are not fields' : 'is not a field'} of ${at || 'the call'}: ${action}; its fields are ${allowed.join(', ')}.`;
    return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
  }).join(' ');
}

/**
 * Repair hint for an `invalid_tool_input` rejection with at least one `unrecognized_keys` issue:
 * names the offending key(s) and directs removal; the resend rule is the caller's.
 *
 * @param schema - The failed schema; when given, a key nested in an object or array element is
 *   answered with the keys that element accepts.
 * @returns The removal-directed hint, or `undefined` when no issue is an unrecognized key.
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
 * The repair a Zod rejection states beyond its faults' table rows: a refinement's own hint, the
 * fields an object accepts in place of an unrecognized key, and the values a field accepts with the
 * entry removal its array minimum allows (the table rows name no field, value or removal).
 *
 * @param input - The rejected payload; tells a present value from an absent one.
 * @param schema - The failed schema; lets a hint name the fields of an object and an array minimum.
 * @returns The distinct applicable hints joined, or `undefined` when none applies.
 */
export function zodFieldRepairHint(error: z.ZodError, input: unknown, schema?: z.ZodType): string | undefined {
  const hints = [issueOwnedRepairHint(error), unrecognizedKeyRepairHint(error, schema), invalidValueRepairHint(error, input, schema)]
    .filter((hint): hint is string => hint !== undefined);
  return hints.length > 0 ? hints.join(' ') : undefined;
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
 * Repair hint for a present value outside the values its field accepts (enum or literal), by JSON
 * Pointer: names the accepted values and the allowed repairs, setting the field to one of them or,
 * for a field inside an array element, dropping that entry when the array stays within its served
 * minimum. Fields of one list with the same accepted values share one clause. An absent field is a
 * `missing` fault.
 */
function invalidValueRepairHint(error: z.ZodError, input: unknown, schema?: z.ZodType): string | undefined {
  const issues = error.issues.filter((issue): issue is Extract<z.core.$ZodIssue, { code: 'invalid_value' }> =>
    isPresentInvalidValue(issue, input));
  const entryDepth = (path: readonly PropertyKey[]): number => path.map((key) => typeof key === 'number').lastIndexOf(true);
  const clauses = new Map<string, { fields: string[]; values: string; arrayPath?: readonly PropertyKey[] }>();
  const flaggedEntries = new Map<string, Set<PropertyKey>>();
  for (const issue of issues) {
    const index = entryDepth(issue.path);
    const arrayPath = index < 0 ? undefined : issue.path.slice(0, index);
    if (arrayPath) flaggedEntries.set(jsonPointer(arrayPath), (flaggedEntries.get(jsonPointer(arrayPath)) ?? new Set()).add(issue.path[index]!));
    const values = issue.values.map((value) => JSON.stringify(value)).join(', ');
    const key = `${arrayPath ? jsonPointer(arrayPath) : ''}|${values}`;
    const clause = clauses.get(key) ?? { fields: [], values, arrayPath };
    clause.fields.push(jsonPointer(issue.path));
    clauses.set(key, clause);
  }
  const hints = [...clauses.values()].map(({ fields, values, arrayPath }) => {
    const set = `Set ${fields.join(', ')} to one of ${values}`;
    if (!arrayPath) return `${set}.`;
    const entries = input === undefined ? undefined : (resolveAtPath(input, arrayPath) as unknown[] | undefined)?.length;
    const arrayNode = jsonSchemaNodeAt(schema, arrayPath);
    const minItems = (arrayNode ? unwrapNullable(arrayNode) : undefined)?.minItems ?? 0;
    const removable = entries === undefined || entries - flaggedEntries.get(jsonPointer(arrayPath))!.size >= minItems;
    return removable ? `${set}, or remove ${fields.length > 1 ? 'those entries' : 'the entry'} from ${jsonPointer(arrayPath)}.` : `${set}.`;
  });
  return hints.length > 0 ? hints.join(' ') : undefined;
}

/** Whether a schema refinement states the repair of its custom issue on `params.hint`. */
function issueStatesRepair(issue: z.core.$ZodIssue): boolean {
  return issue.code === 'custom' && typeof (issue.params as { hint?: unknown } | undefined)?.hint === 'string';
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
    if (issue.code !== 'custom' || !issueStatesRepair(issue)) continue;
    const hint = (issue.params as { hint: string }).hint;
    if (!hints.includes(hint)) hints.push(hint);
  }
  return hints.length > 0 ? hints.join(' ') : undefined;
}

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
 * flattened branches, the accepted types of one path merged into one fault. A fault whose repair the
 * reason or hint states is `stated`: a union's variants, a refinement's `params.hint`.
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
            else faults.push({ ...fault, stated: true });
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
        : { path, code: absent ? 'missing' : isUnparsedJsonText(issue, resolveAtPath(input, issue.path)) ? 'json_text' : 'type', types: [issue.expected] }];
    case 'invalid_value':
      return [absent ? { path, code: 'missing', values: issue.values.map(String) } : { path, code: 'enum', values: issue.values.map(String) }];
    case 'too_big':
    case 'too_small': {
      const sent = resolveAtPath(input, issue.path);
      const size = typeof sent === 'string' || Array.isArray(sent) ? sent.length : undefined;
      const limit = Number(issue.code === 'too_big' ? issue.maximum : issue.minimum);
      return [{ path, code: 'size', bound: { keyword: sizeKeyword(issue), limit, ...(size !== undefined ? { sent: size } : {}) } }];
    }
    case 'custom': {
      const params = issue.params as { code?: unknown } | undefined;
      const code = params?.code;
      return [{
        path,
        code: typeof code === 'string' && code in ISSUES ? code as IssueCode : 'invalid',
        ...(issueStatesRepair(issue) ? { stated: true as const } : {}),
      }];
    }
    default:
      return [{ path, code: 'invalid' }];
  }
}

/**
 * Sole producer of auto-generated {@link ToolRejection} reasons from a Zod validation error.
 *
 * @remarks The reason is one `✖` line per issue with its `→ at` JSON Pointer, each carrying its
 *   enriched message and the correction of its faults ({@link faultCorrection}; those faults are
 *   `stated`, so no fault line repeats them); an absent field reads as required with the type or
 *   values it expects; an `invalid_union` expands via {@link describeInvalidUnion} into a
 *   per-branch required-field breakdown, and when `input` is supplied a size issue names the
 *   measured size — Zod v4 issues carry no input, so the enrichment happens here; a sent value is
 *   never echoed. Issues identical
 *   apart from their array index (same code, message and path shape) collapse into the first, which
 *   names the other indices, so one defect repeated across N entries is one line. A size issue at a
 *   path that also fails its type is dropped: the bound belongs to the declared type. Only
 *   STRUCTURAL bounds reach this function; a content cap is enforced and reported separately by the
 *   validator or engine. A present value outside its accepted values names them in the default hint
 *   ({@link invalidValueRepairHint}) and not again in the reason; a caller-supplied `hint` leaves
 *   the reason carrying them.
 * @param error - The Zod validation failure.
 * @param opts - `code` to stamp on the rejection; optional `hint` (default:
 *   {@link zodFieldRepairHint}; the resend rule is the rendered feedback's); optional `input` (the
 *   value that failed parsing) enabling measured-size enrichment, absent-field faults and the value
 *   hint; optional `schema` (the schema it failed)
 *   enabling the hints that name what the schema accepts.
 * @returns A normalized {@link ToolRejection} built via {@link makeRejection}.
 */
export function rejectionFromZodError(
  error: z.ZodError,
  opts: { code: string; hint?: string; input?: unknown; schema?: z.ZodType },
): ToolRejection {
  const issuePaths: string[] = [];
  const errors: ToolError[] = [];
  const shown = new Map<string, { issue: z.core.$ZodIssue; message: string; corrections: string[]; others: string[] }>();
  const mistyped = new Set(error.issues.filter(issue => issue.code === 'invalid_type').map(issue => jsonPointer(issue.path)));
  for (const issue of error.issues) {
    if ((issue.code === 'too_big' || issue.code === 'too_small') && mistyped.has(jsonPointer(issue.path))) continue;
    // The fix of each fault rides its own reason line, so the fault is served once.
    const faults = issueErrors(issue, opts.input);
    const corrections = [...new Set(faults.filter(fault => !fault.stated).flatMap(fault => faultCorrection(fault, opts.schema)))];
    errors.push(...faults.map(fault => (corrections.length > 0 ? { ...fault, stated: true as const } : fault)));
    let message: string;
    if (issue.code === 'invalid_union') {
      const { line, paths } = describeInvalidUnion(issue, opts.input);
      issuePaths.push(...paths);
      message = line;
    } else {
      const path = issue.path.join('.');
      if (issue.code === 'unrecognized_keys') issuePaths.push(...unrecognizedKeyPaths(issue));
      else if (path) issuePaths.push(path);
      message = faults.some(fault => fault.code === 'missing') && (issue.code === 'invalid_type' || issue.code === 'invalid_value')
        ? `Required field, expected ${issue.code === 'invalid_value' ? `one of ${issue.values.map(value => JSON.stringify(value)).join(', ')}` : issue.expected}`
        : opts.hint === undefined && isPresentInvalidValue(issue, opts.input)
          ? INVALID_VALUE_REASON
          : opts.input !== undefined
            ? enrichedIssueMessage(issue, resolveAtPath(opts.input, issue.path))
            : baseIssueMessage(issue);
    }
    const shape = `${issue.code}|${message}|${issue.path.map(key => (typeof key === 'number' ? '*' : String(key))).join('.')}`;
    const first = shown.get(shape);
    if (first) first.others.push(jsonPointer(issue.path));
    else shown.set(shape, { issue, message, corrections, others: [] });
  }
  const lines = [...shown.values()].sort((a, b) => a.issue.path.length - b.issue.path.length).map(({ issue, message, corrections, others }) => {
    const fault = `${message}${others.length > 0 ? ` (same at ${others.join(', ')})` : ''}`;
    const fixed = corrections.length > 0 ? `${fault}${/[.!?]$/.test(fault) ? '' : '.'} ${corrections.join(' ')}` : fault;
    return `✖ ${fixed}${issue.path.length > 0 ? `\n  → at ${jsonPointer(issue.path)}` : ''}`;
  });
  return makeRejection({
    code: opts.code,
    reason: lines.join('\n'),
    hint: opts.hint ?? zodFieldRepairHint(error, opts.input, opts.schema),
    issuePaths,
    errors,
  });
}
