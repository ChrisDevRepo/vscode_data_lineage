import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { ToolDraft } from './toolDraft';
import { REJECTION_CODES } from './rejectionCodes';
import { at, combineToolRejections, type ToolRejection } from './toolErrorEnvelope';
import { validateToolCandidate, type ToolValidation, type ToolFactContext } from './toolValidation';

/** Transport identity captured before serialized dispatch; input remains the raw normalized receipt. */
export const toolInputReceipt = new AsyncLocalStorage<{ input: unknown; generation?: number; context: string; signal?: AbortSignal; group?: { calls: number } }>();

/** One original parse and read-only candidate access for every domain rule. Unknown paths never become empty authored values. */
export class ToolInputView<S extends z.ZodType = z.ZodType> {
  readonly parsed: ToolValidation<z.output<S>>;
  readonly problems: ToolRejection[] = [];
  readonly holdPaths = new Set<string>();
  constructor(readonly schema: S, readonly candidate: unknown, facts?: ToolFactContext) {
    this.parsed = validateToolCandidate(schema, candidate, facts);
    if (!this.parsed.success) this.add(this.parsed.rejection);
  }
  /** Read the supplied value without claiming its type or validity. */
  value(path: string): unknown {
    return path.split('.').filter(Boolean).reduce<unknown>((value, key) => value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
      ? Reflect.get(value, key) : undefined, this.candidate);
  }
  /** Rules append checked facts, never render a model message or retain a draft. */
  add(problem: ToolRejection | null | undefined): void { if (problem) this.problems.push(problem); }
}

/** Shared staging, canonical parsing, one domain inspection, and the sole retain-or-commit decision. */
export function ingestToolInput<S extends z.ZodType, R>(options: {
  input: unknown; schema: S; context: string; draft?: ToolDraft<object>; facts?: ToolFactContext;
  inspect(view: ToolInputView<S>): (() => R) | undefined;
  rejected?(problem: ToolRejection, view: ToolInputView<S>): void;
  committed?(result: Awaited<R>): boolean;
  log?(message: string): void;
}): R | ToolRejection {
  const { schema, draft, context } = options;
  const receipt = toolInputReceipt.getStore();
  const ambiguous = draft && receipt?.generation !== undefined && ((receipt.group?.calls ?? 0) > 1 || !draft.own(receipt.context, receipt.generation));
  if (ambiguous) draft.clear();
  const candidate = draft && !ambiguous ? draft.apply(context, options.input, schema) : options.input;
  if (!ambiguous && receipt?.signal) draft?.bindCancellation(receipt.signal, context);
  if (draft?.unchanged) options.log?.('[Hold] identical resend no-op');
  const view = new ToolInputView(schema, candidate, options.facts);
  const commit = options.inspect(view);
  if (ambiguous) view.add({ code: REJECTION_CODES.invalidInput, reason: 'Ambiguous input ownership.', errors: at('ambiguous_repair') });
  if (view.problems.length) {
    const problem = combineToolRejections(view.problems);
    const paths = [...new Set([...problem.errors.map(error => error.path), ...view.holdPaths])];
    const overwritten = !ambiguous ? draft?.retain(candidate, paths, schema) ?? [] : [];
    problem.errors.push(...at('not_overwritten', overwritten));
    problem.resend = [...new Set([...(problem.resend ?? []), ...paths.map(path => path.split('.')[0]).filter(Boolean)])];
    options.rejected?.(problem, view);
    return problem;
  }
  if (!view.parsed.success || !commit) throw new Error('Validated tool input has no execution plan.');
  const result = commit();
  const completed = (value: Awaited<R>): Awaited<R> => {
    if (options.committed?.(value) !== false) draft?.clear();
    return value;
  };
  return (result instanceof Promise ? result.then(completed) : completed(result as Awaited<R>)) as R;
}
