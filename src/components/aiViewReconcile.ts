import type { DatabaseModel } from '../engine/types';
import type { AIViewMetadata, FilterProfile } from '../engine/projectStore';
import { createSavedReferenceResolver, resolveModelNodeId } from '../engine/shared/nodeIdResolution';

/** Canonicalized AI-view payload plus unresolved node references. */
export interface ReconciledAiView {
  /** Canonical ids that resolved, deduplicated in submitted order. */
  nodeIds: string[];
  /** Raw references that matched no node in the loaded model. */
  unresolved: string[];
  /** View metadata with every node reference remapped to canonical ids. */
  metadata: AIViewMetadata;
}

/**
 * Canonicalizes AI-preview references; savedResolver applies strict persisted ownership instead.
 * Saved edges with unresolved endpoints are omitted; preview reconciliation retains its existing fallback.
 */
export function reconcileAiView(nodeIds: string[], metadata: AIViewMetadata, model: DatabaseModel, savedResolver?: (id: string) => string | null): ReconciledAiView {
  const nodeMap = new Map<string, unknown>(model.nodes.map(node => [node.id, node]));
  const canonicalize = savedResolver ?? ((id: string): string | null => resolveModelNodeId(id, nodeMap, model.identifierCaseSensitive));

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

  const mapIds = (ids: string[]): string[] => ids.map(canonicalize).filter((id): id is string => id !== null);
  const remapNodeText = <T extends { nodeId: string }>(items: T[]): T[] => items.flatMap(item => {
    const nodeId = canonicalize(item.nodeId);
    return nodeId ? [{ ...item, nodeId }] : [];
  });

  const reconciled: AIViewMetadata = {
    ...metadata,
    highlightGroups: metadata.highlightGroups.map(group => ({ ...group, nodeIds: mapIds(group.nodeIds) })),
    badges: remapNodeText(metadata.badges),
    ...(metadata.nodeVerdicts ? { nodeVerdicts: remapNodeText(metadata.nodeVerdicts) } : {}),
    ...(metadata.notes ? { notes: remapNodeText(metadata.notes) } : {}),
    ...(metadata.columnAspect ? {
      columnAspect: {
        edges: metadata.columnAspect.edges.flatMap(edge => {
          const hopNode = canonicalize(edge.hopNode), fromNode = canonicalize(edge.fromNode), toNode = canonicalize(edge.toNode);
          if (savedResolver && (!hopNode || !fromNode || !toNode)) return [];
          return [{ ...edge, hopNode: hopNode ?? edge.hopNode, fromNode: fromNode ?? edge.fromNode, toNode: toNode ?? edge.toNode }];
        }),
      },
    } : {}),
  };

  return { nodeIds: resolved, unresolved, metadata: reconciled };
}

/** Reconciles a saved profile in memory; original persisted records and unresolved history stay untouched. */
export function reconcileSavedView(profile: FilterProfile, model: DatabaseModel): { profile: FilterProfile; unresolved: string[] } {
  const resolve = createSavedReferenceResolver(model, profile.nodeIdEncodingVersion);
  const unresolved = new Set<string>();
  const checked = (raw: string, schema = false): string | null => {
    const id = schema ? resolve.schema(raw) : resolve.nodeId(raw);
    if (id === null) unresolved.add(raw);
    return id;
  };
  const ids = (raw: string[], schema = false): string[] => Array.from(new Set(raw.map(id => checked(id, schema)).filter((id): id is string => id !== null)));
  const positions = profile.positions && Object.fromEntries(Object.entries(profile.positions).flatMap(([raw, position]) => {
    const prefix = ['__schema__', '__expandedschemaviewcluster__'].find(value => raw.startsWith(value));
    const schema = prefix ? checked(raw.slice(prefix.length), true) : null;
    const id = prefix ? schema === null ? null : `${prefix}${schema}` : checked(raw);
    return id ? [[id, position]] : [];
  }));
  const reconciled: FilterProfile = {
    ...profile,
    filter: { ...profile.filter, schemas: ids(profile.filter.schemas, true), focusSchemas: ids(profile.filter.focusSchemas, true),
      ...(profile.filter.allowlistNodeIds !== undefined ? { allowlistNodeIds: ids(profile.filter.allowlistNodeIds) } : {}) },
    ...(positions ? { positions } : {}),
    ...(profile.expandedSchemaView ? { expandedSchemaView: {
      focusNodeId: profile.expandedSchemaView.focusNodeId === null ? null : checked(profile.expandedSchemaView.focusNodeId),
      expandedSchemas: ids(profile.expandedSchemaView.expandedSchemas, true),
    } } : {}),
    ...(profile.aiMetadata ? { aiMetadata: reconcileAiView([], profile.aiMetadata, model, id => checked(id)).metadata } : {}),
  };
  return { profile: reconciled, unresolved: [...unresolved] };
}

/** Ids carrying an AI badge or footnote in `metadata`, for the layout's annotation band. */
export function annotatedNodeIdsFromAiMetadata(metadata: AIViewMetadata): string[] {
  const ids = new Set<string>();
  for (const badge of metadata.badges) ids.add(badge.nodeId);
  for (const note of metadata.notes ?? []) ids.add(note.nodeId);
  return [...ids];
}
