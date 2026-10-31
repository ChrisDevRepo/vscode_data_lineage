import type { DatabaseModel } from '../engine/types';
import {
  checkObjectLimit,
  formatObjectLimitMessage,
} from '../engine/modelFilters';

/**
 * Refuses a model over `dataLineageViz.maxNodes`: posts the limit warning to the host and logs
 * under `tag`.
 */
export function refuseOverObjectLimit(
  model: DatabaseModel,
  maxNodes: number,
  tag: string,
): string | null {
  const check = checkObjectLimit(model, maxNodes);
  if (check.ok) return null;
  const text = formatObjectLimitMessage(check.count, check.limit);
  window.vscode?.postMessage({ type: 'show-warning', text });
  window.vscode?.postMessage({
    type: 'log',
    text: `[${tag}] Refused — ${text}`,
    level: 'info',
  });
  return text;
}
