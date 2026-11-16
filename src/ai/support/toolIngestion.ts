import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { ToolDraft } from './toolDraft';
import { REJECTION_CODES } from './rejectionCodes';
import {
  at,
  combineToolRejections,
  ISSUES,
  type ToolRejection,
} from './toolErrorEnvelope';
import {
  toolErrorPath,
  validateToolCandidate,
  type ToolValidation,
  type ToolFactContext,
} from './toolValidation';

/**
 * Transport identity captured before serialized dispatch; input remains the raw normalized receipt.
 */
export const toolInputReceipt = new AsyncLocalStorage<{
  input: unknown;
  generation?: number;
  context: string;
  signal?: AbortSignal;
  group?: { calls: number };
}>();

/**
 * One original parse and read-only candidate access for every domain rule. Unknown paths never
 * become empty authored values.
 */
export class ToolInputView<S extends z.ZodType = z.ZodType> {
  readonly parsed: ToolValidation<z.output<S>>;
  readonly problems: ToolRejection[] = [];
  readonly holdPaths = new Set<string>();
  /** The paths of the schema's own enum or const faults of identifier fields. */
  private readonly identifiers: ReadonlySet<string>;
  constructor(
    readonly schema: S,
    readonly candidate: unknown,
    facts?: ToolFactContext,
  ) {
    this.parsed = validateToolCandidate(schema, candidate, facts);
    this.identifiers = new Set(
      this.parsed.success
        ? []
        : this.parsed.errors
            .filter(
              (error) =>
                ['enum', 'const'].includes(error.keyword) &&
                error.parentSchema?.toolIdentifier,
            )
            .map(toolErrorPath),
    );
    if (!this.parsed.success) this.add(this.parsed.rejection);
  }
  /** Read the supplied value without claiming its type or validity. */
  value(path: string): unknown {
    return path
      .split('.')
      .filter(Boolean)
      .reduce<unknown>(
        (value, key) =>
          value !== null &&
          typeof value === 'object' &&
          Object.prototype.hasOwnProperty.call(value, key)
            ? Reflect.get(value, key)
            : undefined,
        this.candidate,
      );
  }
  /**
   * A fault at the path of the schema's own identifier enum or const fault takes its place, with
   * the values that fault offered unless it lists its own; a fault elsewhere is not added.
   */
  replace(problem: ToolRejection): void {
    const [native] = this.problems;
    const faults = new Map(
      problem.errors
        .filter((error) => this.identifiers.has(error.path))
        .map((error) => [error.path, error]),
    );
    if (!native || !faults.size) return;
    this.problems[0] = {
      ...native,
      errors: native.errors.map((error) => {
        const fault = this.identifiers.has(error.path)
          ? faults.get(error.path)
          : undefined;
        const values = fault?.values ?? error.values;
        return fault ? { ...fault, ...(values ? { values } : {}) } : error;
      }),
    };
  }
  /** Rules append checked facts, never render a model message or retain a draft. */
  add(problem: ToolRejection | null | undefined): void {
    if (!problem) return;
    this.replace(problem);
    this.problems.push(problem);
    // The field that answers a fault is owed beside the faulty one, from its issue code alone.
    for (const error of problem.errors) {
      const issue = ISSUES[error.code];
      if ('owedField' in issue) this.holdPaths.add(`${issue.owedField}.*`);
    }
  }
}

/**
 * Shared staging, canonical parsing, one domain inspection, and the sole retain-or-commit decision.
 */
export function ingestToolInput<S extends z.ZodType, R>(options: {
  input: unknown;
  schema: S;
  context: string;
  draft?: ToolDraft<object>;
  facts?: ToolFactContext;
  inspect(view: ToolInputView<S>): (() => R) | undefined;
  rejected?(problem: ToolRejection, view: ToolInputView<S>): void;
  committed?(result: Awaited<R>): boolean;
}): R | ToolRejection {
  const { schema, draft, context } = options;
  const receipt = toolInputReceipt.getStore();
  const ambiguous =
    draft &&
    receipt?.generation !== undefined &&
    ((receipt.group?.calls ?? 0) > 1 ||
      !draft.own(receipt.context, receipt.generation));
  if (ambiguous) draft.clear();
  const candidate =
    draft && !ambiguous ? draft.apply(context, options.input) : options.input;
  if (!ambiguous && receipt?.signal)
    draft?.bindCancellation(receipt.signal, context);
  const view = new ToolInputView(schema, candidate, options.facts);
  const commit = options.inspect(view);
  if (ambiguous)
    view.add({
      code: REJECTION_CODES.invalidInput,
      reason: 'Ambiguous input ownership.',
      errors: at('ambiguous_repair'),
    });
  if (view.problems.length) {
    const problem = combineToolRejections(view.problems);
    // A held draft writes the lists; a tool that holds nothing gets none, its card is the contract.
    const lists =
      draft && !ambiguous
        ? draft.retain(
            candidate,
            problem.errors.map((error) => error.path),
            schema,
            [...view.holdPaths],
          )
        : undefined;
    problem.errors.push(...at('not_overwritten', lists?.overwritten ?? []));
    problem.resend = lists?.resend;
    options.rejected?.(problem, view);
    return problem;
  }
  if (!view.parsed.success || !commit)
    throw new Error('Validated tool input has no execution plan.');
  const result = commit();
  const completed = (value: Awaited<R>): Awaited<R> => {
    if (options.committed?.(value) !== false) draft?.clear();
    return value;
  };
  return (
    result instanceof Promise
      ? result.then(completed)
      : completed(result as Awaited<R>)
  ) as R;
}
