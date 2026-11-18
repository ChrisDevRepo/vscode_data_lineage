/**
 * Canonical node-id resolution shared by the extension host, the AI subsystem and the webview.
 * Lives under `src/engine/shared/`, the VS Code-free surface both bundles may import, because the
 * webview's AI-view reconciler needs it and the Vite build must not reach into extension-host-only
 * `src/ai/**`. `src/ai/support/inputNormalization.ts` re-exports it.
 */
import { normalizeName } from './sqlIdentifier';

/**
 * Resolves a user/model-supplied node id against a canonical node map. Accepts equivalent
 * identifier delimiters and CI case variants; CS requires exact catalog casing. Returns the
 * canonical id present in `nodeMap` or `null`.
 *
 * @param identifierCaseSensitive - Checked source catalog policy; true forbids guessed identifier
 *   casing.
 */
export function resolveModelNodeId(raw: string, nodeMap: Map<string, unknown>, identifierCaseSensitive = false): string | null {
  const input = (raw ?? '').replace(/\p{Cf}/gu, '').trim();
  if (!input) return null;

  if (identifierCaseSensitive) {
    if (nodeMap.has(input)) return input;
    const canonical = normalizeName(input, true);
    return nodeMap.has(canonical) ? canonical : null;
  }

  const candidates = new Set<string>([input, input.toLowerCase()]);
  try {
    candidates.add(normalizeName(input));
  } catch {
  }

  for (const candidate of candidates) {
    if (nodeMap.has(candidate)) return candidate;
  }

  for (const key of nodeMap.keys()) {
    if (candidates.has(key.toLowerCase())) return key;
  }

  return null;
}
