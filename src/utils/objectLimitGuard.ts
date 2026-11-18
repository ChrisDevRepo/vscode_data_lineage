import type { DatabaseModel } from '../engine/types';
import { checkObjectLimit, formatObjectLimitMessage } from '../engine/modelFilters';

/**
 * Refuses a model that exceeds `dataLineageViz.maxNodes` on the webview side: posts the shared
 * limit warning to the host and logs the refusal under `tag` (`Visualize`, `Filter`). The one place
 * the webview wires {@link checkObjectLimit} to the host channels, so every surface refuses alike.
 *
 * @param model - Candidate model, already filtered to the selection under evaluation.
 * @returns The refusal message, or `null` when within the limit.
 */
export function refuseOverObjectLimit(model: DatabaseModel, maxNodes: number, tag: string): string | null {
  const check = checkObjectLimit(model, maxNodes);
  if (check.ok) return null;
  const text = formatObjectLimitMessage(check.count, check.limit);
  window.vscode?.postMessage({ type: 'show-warning', text });
  window.vscode?.postMessage({ type: 'log', text: `[${tag}] Refused — ${text}`, level: 'info' });
  return text;
}
