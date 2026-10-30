/** Single typed channel for tool-result rejections, and the one renderer of the problem the model reads (D-103, D-105). */
import { z } from 'zod';
import { REJECTION_CODES } from './rejectionCodes';

/** Product limit for a quick missing-content exchange; it does not change validation or reply budgets. */
export const CLARIFICATION_WINDOW_MS = 5000;

type IssueCategory = 'shape' | 'required' | 'reference' | 'value' | 'protocol' | 'stage';

/** The top-level `notice` at feedback 3. */
export const LAST_CORRECTION = 'This is the last correction before this hop ends.';

/** The text field a fallback writes its fact into; a rendered fallback adds it to `resend`. */
const FALLBACK_FIELD = 'sections';

/** Column identity text is shared; report references alone offer the final fallback. */
const COLUMN_IDENTITY_ISSUE = { category: 'reference', label: 'not a declared column of that object', correction: 'Name a column declared on that object.' } as const;
const REPORT_REFERENCE_FALLBACK = { fallback: 'If you cannot correct it, write that information in the detail memory instead, highlighted with a callout naming the unresolved issue.' } as const;
const OBJECT_IDENTITY_ISSUE = { category: 'reference', label: 'not an object in the loaded model', correction: 'Name an object of the loaded model by its id.' } as const;

/** Every issue code: its category, a fixed fault label without values, the one positive correction for that fault and, only where a required fact has no structured field that can hold it, the prose `fallback` sent with the third, last rejection (D-105). */
export const ISSUES = {
  type: { category: 'shape', label: 'wrong JSON type', correction: 'Send the value as the JSON type the schema defines for this field.' },
  json_text: { category: 'shape', label: 'text instead of a JSON object', correction: 'Send the value as a JSON object or array, not as a string that holds JSON.' },
  unknown_key: { category: 'shape', label: 'not a field of this object', correction: 'Use only field names the schema defines for this object.' },
  never: { category: 'shape', label: 'field not accepted here', correction: 'Put this content where the field\'s schema description places it; this field stays out of the call.' },
  tool_call_notation: { category: 'shape', label: 'tool-call notation inside a text value', correction: 'Give each argument its own field; a text value holds only its own content.' },
  unclosed_fence: { category: 'shape', label: 'SQL fence not closed', correction: 'Close each SQL fence with a bare line of three backticks after its opening line or its SQL, and keep the paragraphs around it.' },
  missing: { category: 'required', label: 'required field', correction: 'Add a value for this field as its schema describes.' },
  neighbor_undecided: { category: 'required', label: 'neighbor without a decision', correction: 'Give each listed neighbor one decision as the schema describes.' },
  slot_unplaced: { category: 'required', label: 'detail slot ids placed in no section', correction: 'Add each listed id to the node_ids of the section that describes it, with its findings in that section\'s text.' },
  node_unexplained: { category: 'required', label: 'result node ids placed in no section', correction: 'Add each listed id to the node_ids of the section that describes it.' },
  not_found: OBJECT_IDENTITY_ISSUE,
  report_not_found: { ...OBJECT_IDENTITY_ISSUE, ...REPORT_REFERENCE_FALLBACK },
  out_of_scope: { category: 'reference', label: 'outside the approved scope', correction: 'Name an object inside the approved scope; where the field\'s schema description names a form for an object outside it, use that form.' },
  column_out_of_scope: { category: 'reference', label: 'column outside the approved scope', correction: 'Remove the outside column; if it is the entry\'s only supplier or its out_node, omit the column_flow entry, never empty upstream_columns. Ask the outside object a follow-up in questions and record the fact in sections.',
    fallback: 'If no in-scope supplier can express the fact, write it in sections instead, highlighted with a callout naming the unresolved supplier and columns.' },
  result_out_of_scope: { category: 'reference', label: 'outside the approved scope, so not an id of the result', correction: 'Name only node ids of the result.',
    fallback: 'Where the fact concerns an object outside the result, it is still required: state it in the text of the section that describes it as a callout starting with ⚠️ that names the object. Keep every other section unchanged; its node_ids name only ids of the result.' },
  not_neighbor: { category: 'reference', label: 'not a neighbor of the current object', correction: 'Name a direct neighbor of the current object.' },
  unknown_target_column: COLUMN_IDENTITY_ISSUE,
  unknown_column: { ...COLUMN_IDENTITY_ISSUE, ...REPORT_REFERENCE_FALLBACK },
  closed_neighbor: { category: 'reference', label: 'neighbor already pruned or visited', correction: 'Name a neighbor that is still open; a pruned or visited neighbor takes no further decision.' },
  self_loop: { category: 'reference', label: 'identical to its own out_node target - a column cannot be its own upstream source', correction: 'Remove the upstream_columns entry identical to its output destination; keep a SQL-proved out_node unchanged and explain any existing-destination read in sections.' },
  bad_caller_output: { category: 'reference', label: 'not an active output of the caller', correction: 'Name an active output of the caller that reads this function.' },
  not_current_object: { category: 'reference', label: 'not the current object', correction: 'Use the id of the current object.' },
  not_in_result: { ...REPORT_REFERENCE_FALLBACK, category: 'reference', label: 'not in the result graph, which is fixed at this stage', correction: 'Name a node id of the result graph.' },
  addable_to_result: { ...REPORT_REFERENCE_FALLBACK, category: 'reference', label: 'not in the result graph', correction: 'Name a node id of the result graph, or bring the real id into view with add_node_ids.' },
  unknown_evidence_id: { category: 'reference', label: 'not an evidence id of this step', correction: 'Use an evidence id shown on a sql fence line of this step, or write the SQL inside the fence.' },
  uncommitted_label: { category: 'reference', label: 'not a committed section label', correction: 'Use a committed section label, or give the new label its own text.' },
  enum: { category: 'value', label: 'not an allowed value', correction: 'Send one of the values the schema lists for this field.' },
  size: { category: 'value', label: 'outside its size bound', correction: 'Keep the value within the length or count the schema states.' },
  invalid: { category: 'value', label: 'breaks the rule of this field', correction: 'Send a value that meets the rule in the field\'s schema description.' },
  duplicate: { category: 'value', label: 'repeats an earlier entry', correction: 'Keep one entry per key, with the repeated content merged into it.' },
  conflict: { category: 'value', label: 'neighbor has both a question and a prune entry', correction: 'Keep its question; prune_neighbors lists only neighbors without a question.' },
  depth_zero: { category: 'value', label: 'both depth sides are 0', correction: 'Set at least one depth side above 0.' },
  query_too_short: { category: 'value', label: 'query too short to match a name', correction: 'Send a fragment of an object or column name.' },
  query_not_a_name: { category: 'value', label: 'punctuation only, which matches no name', correction: 'Send part of a name, or set mode to regex for a pattern.' },
  invalid_regex: { category: 'value', label: 'pattern does not compile within the length and time limits', correction: 'Send a simpler pattern that compiles, or a plain name fragment.' },
  start_order: { category: 'value', label: 'starts at or before the section above it', correction: 'Give each section a start after the start of the section above it.' },
  prune_target: { category: 'value', label: 'this neighbor cannot be pruned here', correction: 'Prune only a neighbor the schema lists as prunable.' },
  prunes_origin: { category: 'value', label: 'would remove the origin from the view', correction: 'Keep the origin in the view; prune_node_ids names other nodes.' },
  disconnects_view: { category: 'value', label: 'would leave the view disconnected', correction: 'Keep every remaining node connected to the origin through the view.' },
  empty_view: { category: 'value', label: 'leaves no node in the view', correction: 'Keep at least one node in the view.' },
  not_overwritten: { category: 'protocol', label: 'held value could not be overwritten', correction: 'Correct the supplied replacement; the earlier valid value stays held.' },
  identical_resend: { category: 'protocol', label: 'same call as the one already rejected', correction: 'Change the listed fields before sending the call again.' },
  duplicate_read: { category: 'protocol', label: 'read already answered in this step', correction: 'Answer from the result already in the conversation, or call a different read.' },
  one_call: { category: 'protocol', label: 'not evaluated: one commit call per reply', correction: 'Send one commit call per reply that carries all its content.' },
  already_started: { category: 'protocol', label: 'an exploration is already running', correction: 'Continue the running exploration with lineage_submit_findings.' },
  no_op_refine: { category: 'protocol', label: 'refinement changes nothing in the proposal', correction: 'Apply the requested change to scope, mode, classification, columns or filter, or answer the user in text when the plan needs no change.' },
  stale_revision: { category: 'protocol', label: 'not the revision the approval card shows', correction: 'Copy the revision the approval card shows.' },
  ambiguous_repair: { category: 'protocol', label: 'several calls need correction and no values are held', correction: 'Send one complete call with every field.' },
  off_policy: { category: 'stage', label: 'tool not offered in this step', correction: 'Call a tool this step offers.' },
  exploration_complete: { category: 'stage', label: 'exploration complete', correction: 'Call lineage_present_result to assemble the report.' },
  no_session: { category: 'stage', label: 'no exploration is running', correction: 'Start an exploration with lineage_start_exploration, or answer from what the conversation holds.' },
  no_run_memory: { category: 'stage', label: 'no stored run for the applied view', correction: 'Answer from what the applied view shows.' },
  no_result_source: { category: 'stage', label: 'no preview scope or completed exploration to present', correction: 'Answer in text from what the conversation holds.' },
  over_budget: { category: 'stage', label: 'scope exceeds the discovery budget', correction: 'Propose an exploration with lineage_start_exploration; it reads the scope hop by hop.' },
  result_too_large: { category: 'stage', label: 'result larger than this step holds', correction: 'Send a narrower request: fewer ids, a filter or fewer types.' },
  fresh_proposal: { category: 'stage', label: 'additional SQL needs its own approval', correction: 'Send a new proposal with origin and scope.' },
  prune_current_refused: { category: 'stage', label: 'the current object cannot be pruned here', correction: 'Record the current object with lineage_submit_findings.' },
  no_tool_call: { category: 'stage', label: 'reply carried no call of the required tool', correction: 'Call the required tool now, with its content as arguments.' },
  empty_reply: { category: 'stage', label: 'reply carried no text and no call', correction: 'Answer the user in text, or call a tool for more evidence.' },
  awaiting_approval: { category: 'stage', label: 'waiting for the user decision on the card', correction: 'Wait for the user decision; the card holds the proposal.' },
  backend_fault: { category: 'stage', label: 'extension fault', correction: 'The run ends; the extension reports the fault to the user.' },
  no_project: { category: 'stage', label: 'no project is loaded in the Data Lineage panel', correction: 'Ask the user to load a project in the Data Lineage panel.' },
} as const satisfies Record<string, { category: IssueCategory; label: string; correction: string; fallback?: string }>;

/** Closed set of issue codes. */
export type IssueCode = keyof typeof ISSUES;
const ISSUE_CODES = Object.keys(ISSUES) as [IssueCode, ...IssueCode[]];

/** One fault of a rejection: where it is, its issue code and, from schema or engine facts, the backend values it concerns: what the field accepts, or for a required fault the subjects still missing. Never text, never a submitted value. */
export interface ToolError {
  path: string;
  code: IssueCode;
  values?: readonly string[];
}

/** The one rejection record: stable code, typed faults, and facts for logs and the held-draft protocol; {@link renderProblem} alone turns it into model feedback. */
export interface ToolRejection {
  /** Stable machine code. */
  code: string;
  /** Log line; never shown to the model. */
  reason: string;
  /** Structured facts for logs and traces; never shown to the model. */
  detail?: unknown;
  /** Every independently decidable fault, by path and issue code. */
  errors: ToolError[];
  /** Dotted paths of the offending fields for held-draft bookkeeping and observability; defaults to the error paths. */
  issuePaths?: string[];
  /** Owner-verified missing authored content held safely for a narrow completion; absent on invalid values or identities. */
  missingParts?: readonly string[];
  /** When the backend owner created this missing-content request; separate from its later delivery to the model. */
  feedbackAt?: string;
  /** Top-level fields the model resends; every other field stays held. */
  resend?: string[];
}

/** Engine code carried by the consent gate, which shares the rejection envelope without being one. */
const CONSENT_GATE_CODE = REJECTION_CODES.actionRequired;

/** Reports whether a rejection code is the consent gate rather than a failure. */
export function isConsentGateRejection(code: string): boolean {
  return code === CONSENT_GATE_CODE;
}

/** Whether a rejection-shaped result is an admission refusal: the request ends with the reason shown to the user, so it is a control outcome like a consent gate, not a correction the model owes. */
export function isAdmissionRefusal(code: string): boolean {
  return code === REJECTION_CODES.overActiveScopeBudget;
}

/** Zod view of the {@link makeRejection} shape, parsed once at the read boundary. Strict: a success payload carrying any other key is never read as a rejection. */
const RejectionShape = z.object({
  code: z.string(),
  reason: z.string().trim().min(1),
  detail: z.unknown().optional(),
  errors: z.array(z.object({ path: z.string(), code: z.enum(ISSUE_CODES), values: z.array(z.string()).optional() }).strict()).min(1),
  issuePaths: z.array(z.string()).optional(),
  missingParts: z.array(z.string().min(1)).min(1).optional(),
  feedbackAt: z.string().datetime().optional(),
  resend: z.array(z.string()).optional(),
}).strict();

/** Write-side builder for the one tool-execution failure envelope both LM lanes record when a handler throws; the run ends on it. */
export function buildToolExecutionError(toolName: string): string {
  return JSON.stringify(makeRejection({ code: REJECTION_CODES.toolExecutionError, reason: `${toolName} failed inside the extension.`, errors: at('backend_fault') }));
}

/** Stable message shared by {@link NoProjectLoadedError} and a caller without a chat turn. */
const NO_PROJECT_LOADED_MESSAGE =
  'No project is loaded in the Data Lineage panel (closed or not opened yet); open the project and ask again.';

/** Thrown by a tool host's `requireModel`/`requireGraph` when no model/graph is loaded, so the dispatcher returns a stable, non-retryable rejection. */
export class NoProjectLoadedError extends Error {
  constructor() {
    super(NO_PROJECT_LOADED_MESSAGE);
    this.name = 'NoProjectLoadedError';
  }
}

/** Rejection for a tool call dispatched with no project loaded. */
export function buildNoProjectLoadedError(): string {
  return JSON.stringify(makeRejection({ code: REJECTION_CODES.noProjectLoaded, reason: NO_PROJECT_LOADED_MESSAGE, errors: at('no_project') }));
}

/** Reader: the typed {@link ToolRejection} a tool result carries, or `null` when the payload is not a refusal. */
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

/** Feedback stage of one hop (D-105): 1 states every fault, 2 adds the allowed values, 3 adds the per-code fallbacks and the last-correction notice. */
export type FeedbackStage = 1 | 2 | 3;

/** The model-visible rejection: one flat list of coded faults with table-owned messages and staged metadata. */
export interface ToolProblem {
  code: string;
  attempt: `${FeedbackStage}/3`;
  notice?: string;
  errors: Array<{ path: string; code: IssueCode; message: string; allowed?: readonly string[] }>;
  resend: string[];
}

/** Normalized edit distance in [0, 1], case-insensitive: ranks allowed values against a submitted value that is never shown. */
function distance(a: string, b: string): number {
  const x = a.toLowerCase(), y = b.toLowerCase();
  let row = Array.from({ length: y.length + 1 }, (_, index) => index);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return row[y.length] / Math.max(x.length, y.length, 1);
}

/** The value at a dotted path of `input`. */
function valueAt(input: unknown, path: string): unknown {
  return (path ? path.split('.') : []).reduce<unknown>((value, key) => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), input);
}

/** Renders every independent fault once. Required subjects appear immediately, allowed values from feedback 2, and report-reference fallbacks only at feedback 3; submitted values are never echoed. */
export function renderProblem(rejection: ToolRejection, stage: FeedbackStage, input?: unknown): string {
  const merged = new Map<string, ToolError>();
  for (const error of rejection.errors) {
    const key = `${error.path}|${error.code}`, known = merged.get(key);
    const values = known?.values || error.values ? [...new Set([...(known?.values ?? []), ...(error.values ?? [])])] : undefined;
    merged.set(key, { path: error.path, code: error.code, ...(values ? { values } : {}) });
  }
  // An absent parent covers its descendants; children under a present or mistyped parent still explain the expected structure.
  const missingParents = [...merged.values()].filter(error => error.path && error.code === 'missing' && valueAt(input, error.path) == null).map(error => `${error.path}.`);
  let fallbackShown = false;
  const errors = [...merged.values()].filter(error => !missingParents.some(prefix => error.path.startsWith(prefix)))
    .sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)).map(error => {
      const issue = ISSUES[error.code];
      const fallback = stage === 3 && 'fallback' in issue ? issue.fallback : '';
      if (fallback) fallbackShown = true;
      const message = `${issue.label}. ${issue.correction}${fallback ? ` ${fallback}` : ''}`;
      const sent = valueAt(input, error.path);
      const allowed = error.values && (stage >= 2 || issue.category === 'required')
        ? [...error.values].sort((a, b) => (typeof sent === 'string' ? distance(sent, a) - distance(sent, b) : 0) || a.localeCompare(b)) : undefined;
      return { path: error.path, code: error.code, message, ...(allowed ? { allowed } : {}) };
    });
  const problem: ToolProblem = { code: rejection.code, attempt: `${stage}/3`, ...(stage === 3 ? { notice: LAST_CORRECTION } : {}), errors,
    resend: [...new Set([...(rejection.resend ?? []), ...(fallbackShown ? [FALLBACK_FIELD] : [])])] };
  return JSON.stringify(problem);
}

/** Faults with one issue code at each path; the call itself when no path is given. */
export function at(code: IssueCode, paths: readonly string[] = [''], values?: readonly string[]): ToolError[] {
  return paths.map(path => ({ path, code, ...(values ? { values } : {}) }));
}

/** Union independently assessed refusals without interpreting rejected arguments. */
export function combineToolRejections(rejections: readonly ToolRejection[]): ToolRejection {
  if (rejections.length === 0) throw new Error('Cannot combine an empty rejection set.');
  const details = rejections.flatMap(rejection => rejection.detail === undefined ? []
    : Array.isArray(rejection.detail) ? rejection.detail : [rejection.detail]);
  return makeRejection({
    code: rejections.some(rejection => rejection.code === REJECTION_CODES.invalidInput) ? REJECTION_CODES.invalidInput : rejections[0].code,
    reason: [...new Set(rejections.map(rejection => rejection.reason))].join('\n'),
    issuePaths: rejections.flatMap(rejection => rejection.issuePaths ?? rejection.errors.map(error => error.path)),
    ...(details.length ? { detail: [...new Map(details.map(detail => [JSON.stringify(detail), detail])).values()] } : {}),
    errors: rejections.flatMap(rejection => rejection.errors),
    resend: [...new Set(rejections.flatMap(rejection => rejection.resend ?? []))],
  });
}

/** Longest one dotted-path segment: an identifier, or an index. */
const MAX_PATH_SEGMENT_CHARS = 100;
/** One dotted-path segment: an identifier of at most {@link MAX_PATH_SEGMENT_CHARS} chars, an index, or `*` for every index. */
const PATH_SEGMENT = `(?:[A-Za-z_][A-Za-z0-9_-]{0,${MAX_PATH_SEGMENT_CHARS - 1}}|\\d+|\\*)`;
/** Dotted identifier grammar every recorded path must match: safe to log and to show where prose is not allowed. */
const ISSUE_PATH_GRAMMAR = new RegExp(`^${PATH_SEGMENT}(?:\\.${PATH_SEGMENT})*$`);

/** The one producer of a {@link ToolRejection}. At least one error is required; an error path outside the dotted grammar is stated at its call. `reason` (default: the code) is for logs. Missing parts the errors do not already state are added as `missing`. */
export function makeRejection(input: {
  code: string;
  errors: readonly ToolError[];
  reason?: string;
  detail?: unknown;
  issuePaths?: readonly string[];
  missingParts?: readonly string[];
  resend?: readonly string[];
}): ToolRejection {
  const reason = (input.reason ?? input.code).trim() || input.code;
  const errors = input.errors.map(error => (error.path === '' || ISSUE_PATH_GRAMMAR.test(error.path) ? error : { ...error, path: '' }));
  for (const part of input.missingParts ?? []) if (!errors.some(error => error.path === part)) errors.push({ path: part, code: 'missing' });
  if (!errors.length) throw new Error('makeRejection: a rejection states at least one error');
  const issuePaths = [...new Set(input.issuePaths ?? errors.map(error => error.path))].filter(path => ISSUE_PATH_GRAMMAR.test(path));
  return {
    code: input.code,
    reason,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    errors,
    ...(issuePaths.length > 0 ? { issuePaths } : {}),
    ...(input.missingParts?.length ? { missingParts: [...input.missingParts], feedbackAt: new Date().toISOString() } : {}),
    ...(input.resend !== undefined ? { resend: [...input.resend] } : {}),
  };
}

