/** Validates compiler-declared scalar return destinations without interpreting SQL expressions. */
import { createHash } from 'node:crypto';
import { edgeApiType } from '../support/aiPresenter';
import { normalizeColName, schemaKey, splitSqlName, stripBrackets } from '../../utils/sql';
import { getNodeColumns } from '../support/graphUtils';
import { resolveModelNodeId } from '../support/inputNormalization';
import type { ScalarReturnTarget } from './smTypes';

/** Keeps every qualified part, so a remote reference cannot collapse onto a local scalar identity. */
function referenceKey(name: string, identifierCaseSensitive: boolean): string {
  return JSON.stringify(splitSqlName(name).map(part => schemaKey(stripBrackets(part), identifierCaseSensitive)));
}

/** Resolves a real caller endpoint only when its column declares this loaded local scalar function. */
export function resolveScalarReturnTarget(
  functionId: string,
  target: ScalarReturnTarget,
  nodeMap: Parameters<typeof getNodeColumns>[1],
  store?: Parameters<typeof getNodeColumns>[2] | null,
  identifierCaseSensitive = false,
): ScalarReturnTarget | null {
  const identity = (name: string): string => referenceKey(name, identifierCaseSensitive);
  const fn = nodeMap.get(functionId);
  const callerId = resolveModelNodeId(target.node, nodeMap, identifierCaseSensitive);
  if (fn?.type !== 'function' || !callerId || callerId === functionId || identity(target.node) !== identity(callerId)) return null;
  const column = getNodeColumns(callerId, nodeMap, store ?? undefined)?.find(value => normalizeColName(value.name, identifierCaseSensitive) === normalizeColName(target.col, identifierCaseSensitive));
  if (!column?.expressionDependencies?.some(dependency =>
    dependency.externalSource === undefined && ['SqlScalarFunction', 'FN', 'FS'].includes(dependency.sourceElementType ?? '')
    && identity(dependency.reference) === identity(functionId))) return null;
  return { node: callerId, col: column.name };
}

/** Deduplicates qualified destinations while retaining the loaded spelling and first occurrence. */
export function uniqueScalarReturnTargets(targets: readonly ScalarReturnTarget[], identifierCaseSensitive = false): ScalarReturnTarget[] {
  return [...new Map(targets.map(target => [JSON.stringify([schemaKey(target.node, identifierCaseSensitive), normalizeColName(target.col, identifierCaseSensitive)]), { ...target }])).values()];
}

/** Resolves a declared caller destination structurally, without interpreting its SQL or assigning an edge. */
export function resolveFunctionCallerTarget(functionId: string, target: ScalarReturnTarget, nodeMap: Parameters<typeof getNodeColumns>[1], model: { readonly identifierCaseSensitive?: boolean; readonly edges: readonly { readonly source: string; readonly target: string; readonly type: Parameters<typeof edgeApiType>[0] }[] }, store?: Parameters<typeof getNodeColumns>[2] | null): ScalarReturnTarget | null {
  const identity = (name: string): string => referenceKey(name, model.identifierCaseSensitive === true);
  const fn = nodeMap.get(functionId);
  const callerId = resolveModelNodeId(target.node, nodeMap, model.identifierCaseSensitive);
  if (fn?.type !== 'function' || !callerId || callerId === functionId || identity(target.node) !== identity(callerId)) return null;
  if (!model.edges.some(edge => edge.source === functionId && edge.target === callerId && edgeApiType(edge.type, fn.type) === 'read')) return null;
  const column = getNodeColumns(callerId, nodeMap, store ?? undefined)?.find(value => normalizeColName(value.name, model.identifierCaseSensitive) === normalizeColName(target.col, model.identifierCaseSensitive));
  return column ? { node: callerId, col: column.name } : null;
}

/** Binds persisted caller context to the exact SQL snapshot without retaining another SQL copy. */
export function functionCallerDdlHash(ddl: string): string {
  return createHash('sha256').update(ddl).digest('hex');
}
