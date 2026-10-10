/**
 * Canonical node-id resolution shared by the extension host, the AI subsystem and the webview.
 *
 * @remarks
 * This lives under `src/engine/shared/` — the VS Code-free surface both bundles may import —
 * because the webview's AI-view reconciler needs it too. Keeping it here stops the Vite build
 * from reaching into `src/ai/**`, which is extension-host-only territory.
 * `src/ai/support/inputNormalization.ts` re-exports it so existing AI callers are unaffected.
 */
import { normalizeName } from './sqlIdentifier';
import { quoteIdentifier, schemaKey, splitSqlName, stripBrackets } from '../../utils/sql';
import { externalFileId, externalFileUrlId } from './externalFileId';
import type { DatabaseModel } from '../types';

/**
 * Resolves a user/model-supplied node id against a canonical node map.
 *
 * Accepts equivalent identifier delimiters and CI case variants; CS requires exact catalog casing.
 * Returns the canonical id present in `nodeMap` or `null` when no match exists.
 *
 * @param raw - The raw node id string.
 * @param nodeMap - The map of canonical nodes to check against.
 * @param identifierCaseSensitive - Checked source catalog policy; true forbids guessed identifier casing.
 * @returns The canonical node id if resolved, otherwise null.
 */
export function resolveModelNodeId(raw: string, nodeMap: Map<string, unknown>, identifierCaseSensitive = false): string | null {
  const input = (raw ?? '').replace(/\p{Cf}/gu, '').trim();
  if (!input) return null;

  if (identifierCaseSensitive) {
    if (nodeMap.has(input)) return input;
    const canonical = normalizeName(input, true);
    return nodeMap.has(canonical) ? canonical : null;
  }

  const candidates = new Set<string>([input, input.toLowerCase(), normalizeName(input)]);

  for (const candidate of candidates) {
    if (nodeMap.has(candidate)) return candidate;
  }

  for (const key of nodeMap.keys()) {
    if (candidates.has(key.toLowerCase())) return key;
  }

  return null;
}

/**
 * Resolves persisted references by unique ownership, including legacy delimiter/URL aliases.
 * Current tool/SQL inputs must use {@link resolveModelNodeId}, never this legacy recovery path.
 * @param model - Current physical identities and schema names; no inferred catalog entries.
 * @param nodeIdEncodingVersion - Two disables old SQL delimiter aliases; URL aliases apply to both.
 * @returns Exact persisted-ID and schema resolvers; ambiguous or absent references resolve to null.
 */
export function createSavedReferenceResolver(
  model: Pick<DatabaseModel, 'nodes' | 'schemas' | 'identifierCaseSensitive'>,
  nodeIdEncodingVersion?: 2,
): { nodeId: (raw: string) => string | null; schema: (raw: string) => string | null } {
  const ids = new Map<string, string | null>();
  const urlIds = new Map<string, string | null>();
  const schemas = new Map<string, string | null>();
  const cs = model.identifierCaseSensitive === true;
  const own = (map: Map<string, string | null>, key: string, owner: string): void => {
    map.set(key, map.has(key) && map.get(key) !== owner ? null : owner);
  };
  for (const node of model.nodes) {
    own(ids, node.id, node.id);
    if (node.externalType === 'file' && node.externalUrl !== undefined) {
      own(ids, externalFileId(node.externalUrl), node.id);
      own(ids, externalFileUrlId(node.externalUrl), node.id);
      own(urlIds, externalFileUrlId(node.externalUrl), node.id);
    }
  }
  for (const schema of model.schemas) own(schemas, schemaKey(schema.name, cs), schema.name);
  if (nodeIdEncodingVersion !== 2) {
    for (const node of model.nodes) {
      if (node.externalUrl !== undefined) {
        continue;
      }
      // Reproduce only the prior saved spelling, from the source's actual delimiters.
      const parts = splitSqlName(node.fullName).map(part => {
        const decoded = stripBrackets(part);
        return part.startsWith('[') ? decoded.replace(/""/g, '"')
          : part.startsWith('"') ? decoded.replace(/\]\]/g, ']') : decoded;
      });
      const quote = (part: string): string => cs ? quoteIdentifier(part) : `[${part.toLowerCase()}]`;
      const alias = parts.length >= 4 ? `[__external__].${quote(parts[parts.length - 1])}` : parts.map(quote).join('.');
      own(ids, alias, node.id);
      // Reconstructed virtual names lost delimiters: metadata had 1/2 quote reductions, bodies 2/3.
      if (node.externalType === 'db') {
        for (const sites of [2, 3]) {
          let aliases = [''];
          for (const raw of splitSqlName(node.fullName).map(stripBrackets)) {
            const variants = new Set<string>();
            let part = raw;
            for (let stage = 1; stage <= sites; stage++) {
              part = part.replace(/""/g, '"');
              if (stage >= sites - 1) {
                variants.add(quote(part));
                variants.add(quote(part.replace(/\]\]/g, ']')));
              }
            }
            aliases = aliases.flatMap(prefix => [...variants].map(part => prefix ? `${prefix}.${part}` : part));
          }
          for (const alias of aliases) own(ids, alias, node.id);
        }
      }
      if (node.schema && parts.length >= 2) own(schemas, schemaKey(parts[0], cs), node.schema);
    }
  }
  return {
    nodeId: raw => {
      // Old URL collision IDs added underscores when a catalog object occupied the spelling.
      const base = raw.replace(/^(\[__ext__\]\.\[[0-9a-f]{8}_url_(?:[0-9a-f]{4})+)_{1,}\]$/, '$1]');
      if (raw !== base && urlIds.has(base)) {
        const owner = urlIds.get(base) ?? null;
        return ids.has(raw) && ids.get(raw) !== owner ? null : owner;
      }
      if (ids.has(raw)) return ids.get(raw) ?? null;
      return ids.get(base) ?? null;
    },
    schema: raw => schemas.get(schemaKey(raw, cs)) ?? null,
  };
}
