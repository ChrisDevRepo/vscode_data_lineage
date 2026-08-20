/**
 * Project store — named sessions with connection + schema selection + saved filter views.
 *
 * Pure module: no VS Code imports. Usable in both extension host and tests.
 * Stored in context.globalState under key 'dataLineageViz.projectStore'.
 *
 * Schema versioning: schemaVersion field enables forward-compatible migrations.
 */

import type { FilterState } from './types';
import {
  ProjectReadSchema,
  type DacpacConnection,
  type DatabaseConnection,
  type FilterProfile,
  type Project,
  type SerializedFilterState,
} from './shared/bridgeContract';

export type {
  AIViewMetadata,
  DacpacConnection,
  DatabaseConnection,
  FilterProfile,
  Project,
  SerializedFilterState,
  StoredConnectionInfo,
} from './shared/bridgeContract';

/**
 * Represents the root persistence object for the data lineage extension.
 * Contains all user projects and the state of the wizard.
 */
export interface ProjectStore {
  /** The current schema version of the store. Used for migrations. */
  schemaVersion: 1;
  /** The list of saved projects. */
  projects: Project[];
  /** The ID of the last opened project, or null if none was opened. */
  lastOpenedId: string | null;
  /** The last active view in the setup wizard. */
  lastWizardView?: 'main' | 'projects';
}

/**
 * Returns an empty ProjectStore initialized to the current schema version.
 *
 * @returns A fresh, empty project store instance.
 */
function emptyStore(): ProjectStore {
  return { schemaVersion: 1, projects: [], lastOpenedId: null };
}

/**
 * Diagnostic summary of persisted records discarded by {@link migrateProjectStore}.
 *
 * @remarks
 * Dropping a record is permanent data loss from the user's point of view, so the host must be
 * able to say it happened. Field *paths* are carried, never field values: the report reaches the
 * output channel, which must stay free of connection content.
 */
export interface ProjectStoreDropReport {
  /** Number of persisted project records that failed validation and were discarded. */
  dropped: number;
  /** Dot-joined paths of the rejected fields, de-duplicated and capped. Names only, no values. */
  issuePaths: string[];
}

/** Upper bound on reported field paths — a corrupt store must not flood the log. */
const MAX_REPORTED_ISSUE_PATHS = 10;

/**
 * Safely deserializes a raw object into a ProjectStore.
 * Validates the schema version and project shapes. Returns an empty store on any parse failure.
 *
 * @remarks
 * Validation is deliberately tolerant of fields it does not recognize — `ProjectReadSchema` drops
 * them rather than rejecting the record. A project written by an older build carries keys this one
 * never declared, and a record is discarded only when a field the schema *requires* is missing or
 * of the wrong type.
 *
 * Kept free of VS Code imports: discarded records are surfaced through the optional `onDropped`
 * callback so the extension host owns logging and notification, and the engine stays testable.
 * The callback fires at most once per call, and only when at least one record was discarded.
 *
 * @param raw - The untyped data loaded from persistent storage.
 * @param onDropped - Invoked with the drop report when records were discarded.
 * @returns A validated ProjectStore.
 */
export function migrateProjectStore(
  raw: unknown,
  onDropped?: (report: ProjectStoreDropReport) => void,
): ProjectStore {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return emptyStore();
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    // Unknown version — cannot migrate safely; start fresh, but never silently.
    const abandoned = Array.isArray(obj.projects) ? obj.projects.length : 0;
    if (abandoned > 0) onDropped?.({ dropped: abandoned, issuePaths: ['schemaVersion'] });
    return emptyStore();
  }
  if (!Array.isArray(obj.projects)) {
    return emptyStore();
  }
  let dropped = 0;
  const issuePaths: string[] = [];
  const projects = (obj.projects as unknown[]).flatMap((project) => {
    const parsed = ProjectReadSchema.safeParse(project);
    if (parsed.success) return [parsed.data];
    dropped += 1;
    for (const issue of parsed.error.issues) {
      const path = issue.path.map((segment) => String(segment)).join('.') || '(root)';
      if (issuePaths.length < MAX_REPORTED_ISSUE_PATHS && !issuePaths.includes(path)) {
        issuePaths.push(path);
      }
    }
    return [];
  });
  if (dropped > 0) onDropped?.({ dropped, issuePaths });
  return {
    schemaVersion: 1,
    projects,
    lastOpenedId: typeof obj.lastOpenedId === 'string' ? obj.lastOpenedId : null,
  };
}

/**
 * Creates a new Project record with a generated UUID and current timestamps.
 *
 * @param name - The user-defined or auto-generated name for the project.
 * @param connection - The validated DACPAC or Database connection.
 * @returns A newly instantiated Project object.
 */
export function createProject(
  name: string,
  connection: DacpacConnection | DatabaseConnection,
): Project {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now, connection };
}

/**
 * Upserts a project into the store and updates the last opened identifier.
 * If the project ID already exists, it is replaced; otherwise, it is appended.
 *
 * @param store - The current project store state.
 * @param project - The project to insert or update.
 * @returns A new project store instance with the applied changes.
 */
export function updateProject(store: ProjectStore, project: Project): ProjectStore {
  const exists = store.projects.some(p => p.id === project.id);
  const projects = exists
    ? store.projects.map(p => (p.id === project.id ? project : p))
    : [...store.projects, project];
  return { ...store, projects, lastOpenedId: project.id };
}

/**
 * Removes a project from the store by its identifier.
 * Automatically adjusts the last opened ID to the most recently updated project if the current active project is deleted.
 *
 * @param store - The current project store state.
 * @param id - The UUID of the project to delete.
 * @returns A new project store instance with the project removed.
 */
export function deleteProject(store: ProjectStore, id: string): ProjectStore {
  const projects = store.projects.filter(p => p.id !== id);
  const lastOpenedId =
    store.lastOpenedId === id
      ? ([...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null)
      : store.lastOpenedId;
  return { ...store, projects, lastOpenedId };
}

/**
 * Generates a default project name based on the connection type and current timestamp.
 * Format: "{sourceName or displayName} YYYY-MM-DD HH:mm".
 *
 * @param connection - The connection to derive the name from.
 * @returns A formatted string representing the default project name.
 */
export function generateProjectName(connection: DacpacConnection | DatabaseConnection): string {
  const now = new Date();
  const ts = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-') + ' ' + [pad(now.getHours()), pad(now.getMinutes())].join(':');

  return connection.type === 'dacpac'
    ? `${connection.displayName} ${ts}`
    : `${connection.sourceName} ${ts}`;
}

/**
 * Pads a number with a leading zero if it is less than 10.
 *
 * @param n - The number to pad.
 * @returns A two-character padded string.
 */
function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Adds or replaces a filter profile for a specific project.
 * Matches existing profiles based on their ID.
 *
 * @param store - The current project store state.
 * @param projectId - The UUID of the project to modify.
 * @param profile - The new or updated filter profile to insert.
 * @returns A new project store instance with the updated filter profiles.
 */
export function addFilterProfile(store: ProjectStore, projectId: string, profile: FilterProfile): ProjectStore {
  const projects = store.projects.map(p => {
    if (p.id !== projectId) return p;
    const existing = p.filterProfiles ?? [];
    const profiles = existing.some(fp => fp.id === profile.id)
      ? existing.map(fp => (fp.id === profile.id ? profile : fp))
      : [...existing, profile];
    return { ...p, filterProfiles: profiles };
  });
  return { ...store, projects };
}

/**
 * Removes a filter profile from a specific project.
 *
 * @param store - The current project store state.
 * @param projectId - The UUID of the project to modify.
 * @param profileId - The UUID of the filter profile to remove.
 * @returns A new project store instance with the filter profile removed.
 */
export function deleteFilterProfile(store: ProjectStore, projectId: string, profileId: string): ProjectStore {
  const projects = store.projects.map(p => {
    if (p.id !== projectId) return p;
    return { ...p, filterProfiles: (p.filterProfiles ?? []).filter(fp => fp.id !== profileId) };
  });
  return { ...store, projects };
}

/**
 * Converts a live FilterState containing Sets into a JSON-serializable SerializedFilterState.
 *
 * @param filter - The active in-memory filter state.
 * @returns A plain object suitable for persistent storage.
 */
export function serializeFilter(filter: FilterState): SerializedFilterState {
  return {
    schemas: Array.from(filter.schemas),
    types: Array.from(filter.types),
    searchTerm: filter.searchTerm,
    hideIsolated: filter.hideIsolated,
    focusSchemas: Array.from(filter.focusSchemas),
    showExternalRefs: filter.showExternalRefs,
    externalRefTypes: Array.from(filter.externalRefTypes),
    exclusionPatterns: filter.exclusionPatterns,
    ...(filter.allowlistNodeIds && filter.allowlistNodeIds.size > 0
      ? { allowlistNodeIds: Array.from(filter.allowlistNodeIds) }
      : {}),
  };
}

/**
 * Restores a SerializedFilterState from persistent storage back into a live FilterState.
 * Reconstructs Set objects where required.
 *
 * @param s - The serialized filter state object.
 * @returns An in-memory FilterState object with fully instantiated Sets.
 */
export function deserializeFilter(s: SerializedFilterState): FilterState {
  return {
    schemas: new Set(s.schemas),
    types: new Set(s.types) as FilterState['types'],
    searchTerm: s.searchTerm ?? '',
    hideIsolated: s.hideIsolated,
    focusSchemas: new Set(s.focusSchemas),
    showExternalRefs: s.showExternalRefs,
    externalRefTypes: new Set(s.externalRefTypes) as FilterState['externalRefTypes'],
    exclusionPatterns: s.exclusionPatterns ?? [],
    ...(s.allowlistNodeIds && s.allowlistNodeIds.length > 0
      ? { allowlistNodeIds: new Set(s.allowlistNodeIds) }
      : {}),
  };
}
