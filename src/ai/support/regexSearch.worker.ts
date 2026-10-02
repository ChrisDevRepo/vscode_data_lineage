import { parentPort, workerData } from 'node:worker_threads';
import { compileSearchRegex, searchCatalog, scanBodyMatches, type SearchableNode } from '../../utils/modelSearch';
import { checkScopeBudget, type TurnTokenBudget } from './tokenBudget';

/** Structured input to isolated native-regexp execution; patterns are data, never worker code. */
export type RegexSearchJob = {
  readonly pattern: string;
  readonly nodes: SearchableNode[];
  readonly types?: SearchableNode['type'][];
} & (
  | { readonly kind: 'catalog'; readonly schemas?: string[]; readonly limit: number }
  | { readonly kind: 'ddl'; readonly budget: TurnTokenBudget; readonly rowChars: number }
);

/** Complete isolated result, returned only after the entire requested search finishes. */
export type RegexSearchReply =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly kind: 'catalog'; readonly ids: string[] }
  | { readonly ok: true; readonly kind: 'ddl'; readonly scan: ReturnType<typeof scanBodyMatches> };

const job = workerData as RegexSearchJob;
const compiled = compileSearchRegex(job.pattern);
if (!compiled.ok) {
  parentPort?.postMessage({ ok: false, error: 'Pattern failed to compile in the search worker.' } satisfies RegexSearchReply);
} else {
  const types = job.types ? new Set(job.types) : undefined;
  const result: RegexSearchReply = job.kind === 'catalog'
    ? {
      ok: true, kind: 'catalog',
      ids: searchCatalog(job.nodes, job.pattern, types, job.schemas ? new Set(job.schemas) : undefined, job.limit, 'regex').map(node => node.id),
    }
    : {
      ok: true, kind: 'ddl',
      scan: scanBodyMatches(job.nodes, compiled.regex, types, count => checkScopeBudget(job.budget, 0, count * job.rowChars) === null),
    };
  parentPort?.postMessage(result);
}
