/** Validates compiler-declared scalar return destinations without interpreting SQL expressions. */
import { normalizeColName, splitSqlName, stripBrackets } from '../../utils/sql';
import { getNodeColumns } from '../support/graphUtils';
import { resolveModelNodeId } from '../support/inputNormalization';
import type { ScalarReturnTarget } from './smTypes';

/** Resolves a real caller endpoint only when its column declares this loaded local scalar function. */
export function resolveScalarReturnTarget(
  functionId: string,
  target: ScalarReturnTarget,
  nodeMap: Parameters<typeof getNodeColumns>[1],
  store?: Parameters<typeof getNodeColumns>[2] | null,
): ScalarReturnTarget | null {
  const identity = (name: string): string => JSON.stringify(splitSqlName(name).map(part => stripBrackets(part).toLowerCase()));
  const fn = nodeMap.get(functionId);
  const callerId = resolveModelNodeId(target.node, nodeMap);
  if (fn?.type !== 'function' || !callerId || callerId === functionId || identity(target.node) !== identity(callerId)) return null;
  const column = getNodeColumns(callerId, nodeMap, store ?? undefined)?.find(value => normalizeColName(value.name) === normalizeColName(target.col));
  if (!column?.expressionDependencies?.some(dependency =>
    dependency.externalSource === undefined && ['SqlScalarFunction', 'FN', 'FS'].includes(dependency.sourceElementType ?? '')
    && identity(dependency.reference) === identity(functionId))) return null;
  return { node: callerId, col: column.name };
}

/** Deduplicates qualified destinations while retaining the loaded spelling and first occurrence. */
export function uniqueScalarReturnTargets(targets: readonly ScalarReturnTarget[]): ScalarReturnTarget[] {
  return [...new Map(targets.map(target => [JSON.stringify([target.node.toLowerCase(), normalizeColName(target.col)]), { ...target }])).values()];
}
