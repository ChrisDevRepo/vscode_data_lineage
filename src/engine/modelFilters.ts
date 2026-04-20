import { DatabaseModel } from './types';
import { compileExclusionPattern } from '../utils/sql';

/**
 * Applies regex-based exclusion patterns to filter nodes by their schema or name.
 * 
 * @param model - The database model to filter.
 * @param patterns - A list of regex strings to match against object names.
 * @returns A filtered database model.
 */
export function applyExclusionFilter(model: DatabaseModel, patterns: string[]): DatabaseModel {
  if (!patterns || patterns.length === 0) return model;

  const regexes: RegExp[] = [];
  for (const p of patterns) {
    try {
      regexes.push(compileExclusionPattern(p));
    } catch (err) {
      console.warn(`[Exclusion] Skipping invalid pattern: ${p}`, err);
    }
  }

  if (regexes.length === 0) return model;

  const nodes = model.nodes.filter((n) => {
    const name = `${n.schema}.${n.name}`;
    return !regexes.some((r) => r.test(name) || r.test(n.fullName));
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { ...model, nodes, edges };
}

/**
 * Removes "isolated" nodes (nodes with zero edges) from the model.
 * 
 * @param model - The database model to filter.
 * @param hideIsolated - Whether to perform the removal.
 * @returns A filtered database model.
 */
export function applyIsolationFilter(model: DatabaseModel, hideIsolated: boolean): DatabaseModel {
  if (!hideIsolated) return model;

  const connectedIds = new Set<string>();
  for (const e of model.edges) {
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  }

  const nodes = model.nodes.filter((n) => connectedIds.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return { ...model, nodes, edges };
}

/**
 * Enforces an allowlist of specific node IDs, dropping all others.
 * 
 * @param model - The database model to filter.
 * @param allowlist - A set of node IDs permitted to remain.
 * @returns A filtered database model.
 */
export function applyAllowlistFilter(model: DatabaseModel, allowlist: Set<string> | undefined): DatabaseModel {
  if (!allowlist || allowlist.size === 0) return model;
  const nodes = model.nodes.filter((n) => allowlist.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { ...model, nodes, edges };
}
