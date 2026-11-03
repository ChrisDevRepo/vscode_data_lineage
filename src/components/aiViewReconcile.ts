import type { DatabaseModel } from '../engine/shared/types';
import type { AIViewMetadata, FilterProfile } from '../engine/projectStore';
import type { ColumnTransformClass } from '../engine/shared/bridgeContract';
import {
  createSavedReferenceResolver,
  resolveModelNodeId,
} from '../engine/shared/nodeIdResolution';

/** Canonicalized AI-view payload plus unresolved node references. */
export interface ReconciledAiView {
  /** Canonical ids that resolved, deduplicated in submitted order. */
  nodeIds: string[];
  /** Raw references that matched no node in the loaded model. */
  unresolved: string[];
  /** View metadata with every node reference remapped to canonical ids. */
  metadata: AIViewMetadata;
}

/** An older saved edge whose every role is `combine` or `filter`: no value crosses it. */
const legacyIndirectOnly = (transforms?: readonly ColumnTransformClass[]) =>
  !!transforms?.length &&
  transforms.every((c) => c === 'combine' || c === 'filter');

/**
 * Canonicalizes AI-preview references; saved views use `savedResolver` instead. Unresolved
 * saved-edge endpoints and legacy indirect-only edges are omitted.
 */
export function reconcileAiView(
  nodeIds: string[],
  metadata: AIViewMetadata,
  model: DatabaseModel,
  savedResolver?: (id: string) => string | null,
): ReconciledAiView {
  const nodeMap = new Map<string, unknown>(
    model.nodes.map((node) => [node.id, node]),
  );
  const canonicalize =
    savedResolver ??
    ((id: string): string | null =>
      resolveModelNodeId(id, nodeMap, model.identifierCaseSensitive));

  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of nodeIds) {
    const id = canonicalize(raw);
    if (!id) {
      unresolved.push(raw);
    } else if (!seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  }

  const mapIds = (ids: string[]): string[] =>
    ids.map(canonicalize).filter((id): id is string => id !== null);
  const remapNodeText = <T extends { nodeId: string }>(items: T[]): T[] =>
    items.flatMap((item) => {
      const nodeId = canonicalize(item.nodeId);
      return nodeId ? [{ ...item, nodeId }] : [];
    });
  /** Canonical ids at `keys`; a saved view omits an item with an unresolved id. */
  const remapIds = <T extends Record<K, string>, K extends keyof T>(
    item: T,
    keys: readonly K[],
  ): T[] => {
    const ids = keys.map((key) => canonicalize(item[key]));
    if (savedResolver && ids.includes(null)) return [];
    const remapped = { ...item };
    keys.forEach((key, i) => (remapped[key] = (ids[i] ?? item[key]) as T[K]));
    return [remapped];
  };

  const requested = metadata.columnAspect?.requested;
  const requestedNode = requested ? canonicalize(requested.node) : null;
  const reconciled: AIViewMetadata = {
    ...metadata,
    highlightGroups: metadata.highlightGroups.map((group) => ({
      ...group,
      nodeIds: mapIds(group.nodeIds),
    })),
    badges: remapNodeText(metadata.badges),
    ...(metadata.notes ? { notes: remapNodeText(metadata.notes) } : {}),
    ...(metadata.columnAspect
      ? {
          columnAspect: {
            ...(requested && requestedNode
              ? {
                  requested: {
                    node: requestedNode,
                    columns: [...requested.columns],
                  },
                }
              : {}),
            edges: metadata.columnAspect.edges.flatMap((edge) =>
              legacyIndirectOnly(edge.transforms)
                ? []
                : remapIds(edge, ['hopNode', 'fromNode', 'toNode']),
            ),
            ...(metadata.columnAspect.indirect && {
              indirect: metadata.columnAspect.indirect.flatMap((fact) =>
                remapIds(fact, ['hopNode', 'node']),
              ),
            }),
          },
        }
      : {}),
  };

  return { nodeIds: resolved, unresolved, metadata: reconciled };
}

/**
 * Reconciles a saved profile in memory; original persisted records and unresolved history stay
 * untouched.
 */
export function reconcileSavedView(
  profile: FilterProfile,
  model: DatabaseModel,
): { profile: FilterProfile; unresolved: string[] } {
  const resolve = createSavedReferenceResolver(
    model,
    profile.nodeIdEncodingVersion,
  );
  const unresolved = new Set<string>();
  const checked = (raw: string, schema = false): string | null => {
    const id = schema ? resolve.schema(raw) : resolve.nodeId(raw);
    if (id === null) unresolved.add(raw);
    return id;
  };
  const ids = (raw: string[], schema = false): string[] =>
    Array.from(
      new Set(
        raw
          .map((id) => checked(id, schema))
          .filter((id): id is string => id !== null),
      ),
    );
  const reconciled: FilterProfile = {
    ...profile,
    filter: {
      ...profile.filter,
      schemas: ids(profile.filter.schemas, true),
      focusSchemas: ids(profile.filter.focusSchemas, true),
      ...(profile.filter.allowlistNodeIds !== undefined
        ? { allowlistNodeIds: ids(profile.filter.allowlistNodeIds) }
        : {}),
    },
    ...(profile.expandedSchemaView
      ? {
          expandedSchemaView: {
            focusNodeId:
              profile.expandedSchemaView.focusNodeId === null
                ? null
                : checked(profile.expandedSchemaView.focusNodeId),
            expandedSchemas: ids(
              profile.expandedSchemaView.expandedSchemas,
              true,
            ),
          },
        }
      : {}),
    ...(profile.aiMetadata
      ? {
          aiMetadata: reconcileAiView([], profile.aiMetadata, model, (id) =>
            checked(id),
          ).metadata,
        }
      : {}),
  };
  return { profile: reconciled, unresolved: [...unresolved] };
}

/** Ids carrying an AI badge or footnote in `metadata`, for the layout's annotation band. */
export function annotatedNodeIdsFromAiMetadata(
  metadata: AIViewMetadata,
): string[] {
  const ids = new Set<string>();
  for (const badge of metadata.badges) ids.add(badge.nodeId);
  for (const note of metadata.notes ?? []) ids.add(note.nodeId);
  return [...ids];
}
