/**
 * Canonical node-id resolution shared by the extension host, the AI subsystem and the webview.
 *
 * @remarks
 * This lives under `src/engine/shared/` — the VS Code-free surface both bundles may import —
 * because the webview's AI-view reconciler needs it too. Keeping it here stops the Vite build
 * from reaching into `src/ai/**`, which is extension-host-only territory.
 * `src/ai/support/inputNormalization.ts` re-exports it so existing AI callers are unaffected.
 */
import { normalizeName } from '../modelBuilder';

/**
 * Resolves a user/model-supplied node id against a canonical node map.
 *
 * Accepts bracketed/unbracketed and mixed-case forms; returns the canonical id
 * present in `nodeMap` or `null` when no match exists.
 *
 * @param raw - The raw node id string.
 * @param nodeMap - The map of canonical nodes to check against.
 * @returns The canonical node id if resolved, otherwise null.
 */
export function resolveModelNodeId(raw: string, nodeMap: Map<string, unknown>): string | null {
  // `trim()` removes ASCII whitespace only. A model that pads an id with a zero-width or other
  // Unicode format character produces a string that renders identically to a valid id but fails
  // every lookup, so the rejection it earns is one no human or model can act on.
  const input = (raw ?? '').replace(/\p{Cf}/gu, '').trim();
  if (!input) return null;

  const candidates = new Set<string>([input, input.toLowerCase()]);
  try {
    candidates.add(normalizeName(input));
  } catch {
    // Keep fallback candidates only.
  }

  for (const candidate of candidates) {
    if (nodeMap.has(candidate)) return candidate;
  }

  const lowerInput = input.toLowerCase();
  for (const key of nodeMap.keys()) {
    if (key.toLowerCase() === lowerInput) return key;
  }

  return null;
}
