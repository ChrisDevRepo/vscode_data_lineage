/**
 * Project store: named sessions with connection, schema selection and saved filter views. Pure
 * module (no VS Code imports), stored in `context.globalState` under `dataLineageViz.projectStore`;
 * `schemaVersion` enables forward-compatible migrations.
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

/** Root persistence object of the extension: all user projects and the wizard state. */
export interface ProjectStore {
  /** The current schema version of the store. Used for migrations. */
  schemaVersion: 1;
  /** The list of saved projects. */
  projects: Project[];
  /** The ID of the last opened project, or null if none was opened. */
  lastOpenedId: string | null;
  lastWizardView?: 'main' | 'projects';
}

/** Returns an empty ProjectStore at the current schema version. */
function emptyStore(): ProjectStore {
  return { schemaVersion: 1, projects: [], lastOpenedId: null };
}

/**
 * Diagnostic summary of persisted records discarded by {@link migrateProjectStore}. A dropped
 * record is permanent data loss to the user, so the host must be able to say it happened. Field
 * *paths* are carried, never values: the report reaches the output channel, which must stay free of
 * connection content.
 */
export interface ProjectStoreDropReport {
  /** Number of persisted project records that failed validation and were discarded. */
  dropped: number;
  /** Saved views skipped inside retained projects; absent when none were skipped. */
  droppedViews?: number;
  /** Dot-joined paths of the rejected fields, de-duplicated and capped. Names only, no values. */
  issuePaths: string[];
}

/** Upper bound on reported field paths — a corrupt store must not flood the log. */
const MAX_REPORTED_ISSUE_PATHS = 10;

/**
 * Safely deserializes a raw object into a ProjectStore; returns an empty store on any parse
 * failure. Validation tolerates unknown fields (`ProjectReadSchema` drops them rather than
 * rejecting the record, since an older build's project carries keys this one never declared); a
 * record is discarded only when a required field is missing or mistyped.
 *
 * An unreadable saved view inside a readable project is skipped alone and counted in
 * `droppedViews`.
 *
 * Free of VS Code imports: discarded records surface through the optional `onDropped` callback (at
 * most once per call, only when something was discarded), so the host owns logging and notification
 * and the engine stays testable.
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
    const abandoned = Array.isArray(obj.projects) ? obj.projects.length : 0;
    if (abandoned > 0) onDropped?.({ dropped: abandoned, issuePaths: ['schemaVersion'] });
    return emptyStore();
  }
  if (!Array.isArray(obj.projects)) {
    return emptyStore();
  }
  let dropped = 0;
  let droppedViews = 0;
  const issuePaths: string[] = [];
  const addIssuePath = (path: string) => {
    if (issuePaths.length < MAX_REPORTED_ISSUE_PATHS && !issuePaths.includes(path)) issuePaths.push(path);
  };
  const projects = (obj.projects as unknown[]).flatMap((project) => {
    const parsed = ProjectReadSchema.safeParse(project);
    if (parsed.success) {
      const skipped =
        ((project as { filterProfiles?: unknown[] }).filterProfiles?.length ?? 0)
        - (parsed.data.filterProfiles?.length ?? 0);
      if (skipped > 0) {
        droppedViews += skipped;
        addIssuePath('filterProfiles');
      }
      return [parsed.data];
    }
    dropped += 1;
    for (const issue of parsed.error.issues) {
      addIssuePath(issue.path.map((segment) => String(segment)).join('.') || '(root)');
    }
    return [];
  });
  if (dropped > 0 || droppedViews > 0) {
    onDropped?.({ dropped, issuePaths, ...(droppedViews > 0 ? { droppedViews } : {}) });
  }
  return {
    schemaVersion: 1,
    projects,
    lastOpenedId: typeof obj.lastOpenedId === 'string' ? obj.lastOpenedId : null,
  };
}

/** Creates a Project record with a generated UUID and current timestamps. */
export function createProject(
  name: string,
  connection: DacpacConnection | DatabaseConnection,
): Project {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now, connection };
}

/**
 * Upserts a project and updates the last opened id: replaced if the id exists, else appended;
 * returns a new store.
 */
export function updateProject(store: ProjectStore, project: Project): ProjectStore {
  const exists = store.projects.some(p => p.id === project.id);
  const projects = exists
    ? store.projects.map(p => (p.id === project.id ? project : p))
    : [...store.projects, project];
  return { ...store, projects, lastOpenedId: project.id };
}

/**
 * Removes a project by id, returning a new store; deleting the active one moves the last opened id
 * to the newest.
 */
export function deleteProject(store: ProjectStore, id: string): ProjectStore {
  const projects = store.projects.filter(p => p.id !== id);
  const lastOpenedId =
    store.lastOpenedId === id
      ? ([...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null)
      : store.lastOpenedId;
  return { ...store, projects, lastOpenedId };
}

/** Default project name "{sourceName or displayName} YYYY-MM-DD HH:mm". */
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

/** Zero-pads a number below 10 to two characters. */
function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Adds or replaces (matched by ID) a filter profile of one project; returns a new store. */
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

/** Removes a filter profile from a project; returns a new store. */
export function deleteFilterProfile(store: ProjectStore, projectId: string, profileId: string): ProjectStore {
  const projects = store.projects.map(p => {
    if (p.id !== projectId) return p;
    return { ...p, filterProfiles: (p.filterProfiles ?? []).filter(fp => fp.id !== profileId) };
  });
  return { ...store, projects };
}

/** Converts a live FilterState containing Sets into a JSON-serializable SerializedFilterState. */
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

/** Restores a SerializedFilterState into a live FilterState, reconstructing the Sets. */
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
