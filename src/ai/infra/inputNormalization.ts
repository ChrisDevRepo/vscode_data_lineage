/**
 * Input normalization helpers for AI-controlled fields.
 *
 * @remarks
 * Keeps boundary normalization deterministic and reusable across tool handlers,
 * state-machine init, and prompt rendering.
 */
import { normalizeName } from '../../engine/modelBuilder';

const TOOL_MENTION_RE = /\b(?:lineage_[a-z_]+|search_objects|start_exploration|submit_findings|present_result|get_object_detail|get_neighbor_columns|search_ddl|get_context|detect_graph_patterns)\b/gi;
const BACKTICKED_TOOL_RE = /`[^`]*(?:lineage_|search_objects|start_exploration|submit_findings|present_result|get_object_detail|get_neighbor_columns|search_ddl|get_context|detect_graph_patterns)[^`]*`/gi;

/** Structured result of mission-brief sanitization. */
export type MissionBriefSanitizeResult = {
  text: string;
  changed: boolean;
  reasons: string[];
};

/**
 * Removes tool-name references from mission text so active-phase prompt marker
 * scanners do not misclassify discovery blocks as active leakage.
 */
export function sanitizeMissionBrief(brief: string): MissionBriefSanitizeResult {
  const input = (brief ?? '').trim();
  if (!input) return { text: '', changed: false, reasons: [] };

  const reasons: string[] = [];
  let text = input;

  const withoutBacktickedTools = text.replace(BACKTICKED_TOOL_RE, ' ');
  if (withoutBacktickedTools !== text) {
    text = withoutBacktickedTools;
    reasons.push('removed_backticked_tool_mentions');
  }

  const withoutToolTokens = text.replace(TOOL_MENTION_RE, ' ');
  if (withoutToolTokens !== text) {
    text = withoutToolTokens;
    reasons.push('removed_tool_tokens');
  }

  const cleaned = text
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\s+([)\]])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (cleaned !== text) reasons.push('normalized_whitespace');

  return { text: cleaned, changed: cleaned !== input, reasons };
}

/**
 * Resolves a user/model-supplied node id against a canonical node map.
 *
 * Accepts bracketed/unbracketed and mixed-case forms; returns the canonical id
 * present in `nodeMap` or `null` when no match exists.
 */
export function resolveModelNodeId(raw: string, nodeMap: Map<string, unknown>): string | null {
  const input = (raw ?? '').trim();
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

/**
 * Resolves multiple node ids while preserving order and removing duplicates.
 */
export function resolveModelNodeIds(
  raws: string[],
  nodeMap: Map<string, unknown>,
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seenResolved = new Set<string>();
  for (const raw of raws) {
    const id = resolveModelNodeId(raw, nodeMap);
    if (!id) {
      unresolved.push(raw);
      continue;
    }
    if (seenResolved.has(id)) continue;
    seenResolved.add(id);
    resolved.push(id);
  }
  return { resolved, unresolved };
}

/**
 * Normalizes a free-form `lineage_search_objects.query` string.
 *
 * @remarks
 * Accepts common id-like forms the AI may emit (e.g. `[dbo].[FactSales]`,
 * `dbo.FactSales`, `[db].[dbo].[FactSales]`) and extracts:
 * - `query`: the object token to search by (e.g. `FactSales`)
 * - `schemaHint`: optional schema token (`dbo`) usable as a schema filter
 *
 * If parsing fails, returns the trimmed input unchanged and no schema hint.
 */
export function normalizeSearchQueryInput(raw: string): { query: string; schemaHint?: string } {
  const input = (raw ?? '').trim();
  if (!input) return { query: '' };

  const debracket = (s: string): string => s.replace(/^\[|\]$/g, '');
  const parts = input.split('.').map(p => debracket(p.trim())).filter(Boolean);

  // [name] / name
  if (parts.length === 1) return { query: parts[0] };
  // [schema].[name] / schema.name
  if (parts.length === 2) return { query: parts[1], schemaHint: parts[0] };
  // [db].[schema].[name] / db.schema.name
  if (parts.length === 3) return { query: parts[2], schemaHint: parts[1] };

  return { query: input };
}
