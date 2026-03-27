/**
 * Project store — named sessions with connection + schema selection + saved filter views.
 *
 * Pure module: no VS Code imports. Usable in both extension host and tests.
 * Stored in context.globalState under key 'dataLineageViz.projectStore'.
 *
 * Schema versioning: schemaVersion field enables forward-compatible migrations.
 */

import type { FilterState } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectStore {
  schemaVersion: 1;
  projects: Project[];
  lastOpenedId: string | null;
  lastWizardView?: 'main' | 'projects';
}

/** Serialized FilterState — Sets become arrays for JSON storage. */
export interface SerializedFilterState {
  schemas: string[];
  types: string[];
  searchTerm: string;
  hideIsolated: boolean;
  focusSchemas: string[];
  showExternalRefs: boolean;
  externalRefTypes: string[];
  exclusionPatterns?: string[];  // optional for backward compat with existing saved profiles
  /** Allowlist: when non-empty, only these node IDs are shown. Empty/absent = no restriction. */
  allowlistNodeIds?: string[];
}

/** Named color group for AI-authored view highlight groups. */
export type AIHighlightColor = 'blue' | 'green' | 'red' | 'yellow' | 'orange';

/** Metadata attached to AI-authored advanced bookmarks. */
export interface AIViewMetadata {
  /** Plain text explanation of the view, max 500 chars. */
  narrative: string;
  /** Up to 5 color-coded node groups shown as legend in the info card. */
  highlightGroups: Array<{ label: string; color: AIHighlightColor; nodeIds: string[] }>;
  /** Up to 50 per-node text badges (e.g., "Step 1", "Hub", "⚠ Cycle"). */
  badges: Array<{ nodeId: string; text: string; color: AIHighlightColor | 'gray' }>;
  /** Dagre layout direction hint. Default: 'TB'. */
  layoutDirection?: 'LR' | 'TB';
}

export interface FilterProfile {
  id: string;
  name: string;
  createdAt: string;
  filter: SerializedFilterState;
  /** Keyboard shortcut slot. Alt+N applies this view. Optional — no slot assigned by default. */
  slot?: 1|2|3|4|5|6|7|8|9;
  /** How this profile was created — shown in the info card when the view is active. */
  source?: 'user' | 'trace' | 'analysis' | 'ai';
  /** Saved per-node positions (x, y) — applied after dagre as an overlay. */
  positions?: Record<string, { x: number; y: number }>;
  /** Saved ReactFlow viewport — restored together with positions. */
  viewport?: { x: number; y: number; zoom: number };
  /** AI-authored view metadata — only present on profiles created by @lineage. */
  aiMetadata?: AIViewMetadata;
}

export interface Project {
  id: string;         // crypto.randomUUID()
  name: string;       // user-defined; auto-generated as default
  createdAt: string;  // ISO 8601
  updatedAt: string;  // refreshed on every successful open
  connection: DacpacConnection | DatabaseConnection;
  filterProfiles?: FilterProfile[];
}

export interface DacpacConnection {
  type: 'dacpac';
  path: string;         // absolute path to .dacpac file
  displayName: string;  // filename without extension (for display)
  schemas: string[];    // positive list of schemas selected at creation time
}

/**
 * Stored fields from IConnectionInfo minus 'password' and 'connectionString'.
 * Structurally identical to Omit<IConnectionInfo, 'password' | 'connectionString'>.
 * Defined inline to keep this module free of mssql extension imports.
 */
export interface StoredConnectionInfo {
  server: string;
  database: string;
  user: string;
  authenticationType: string;
  email?: string;
  accountId?: string;
  tenantId?: string;
  port: number;
  encrypt?: string | boolean;
  trustServerCertificate?: boolean;
}

export interface DatabaseConnection {
  type: 'database';
  connectionInfo: StoredConnectionInfo;
  // Reconnect: extension calls connectDirect(connectionInfo as IConnectionInfo)
  // → MSSQL extension re-auths from its own credential store. Falls back to picker.
  sourceName: string;  // "database (server)" display name
  schemas: string[];
}

// ─── Empty Store ──────────────────────────────────────────────────────────────

function emptyStore(): ProjectStore {
  return { schemaVersion: 1, projects: [], lastOpenedId: null };
}

// ─── Migration & Validation ───────────────────────────────────────────────────

/**
 * Safe deserialization. Returns empty store on any parse failure.
 * Add version-specific transforms here when schemaVersion bumps.
 */
export function migrateProjectStore(raw: unknown): ProjectStore {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return emptyStore();
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    // Unknown version — cannot migrate safely; start fresh.
    return emptyStore();
  }
  if (!Array.isArray(obj.projects)) {
    return emptyStore();
  }
  const projects = (obj.projects as unknown[]).filter(isValidProject);
  return {
    schemaVersion: 1,
    projects,
    lastOpenedId: typeof obj.lastOpenedId === 'string' ? obj.lastOpenedId : null,
  };
}

export function isValidProject(p: unknown): p is Project {
  if (!p || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.createdAt === 'string' &&
    typeof obj.updatedAt === 'string' &&
    isValidConnection(obj.connection)
  );
}

function isValidConnection(c: unknown): c is DacpacConnection | DatabaseConnection {
  if (!c || typeof c !== 'object') return false;
  const obj = c as Record<string, unknown>;
  if (obj.type === 'dacpac') {
    return (
      typeof obj.path === 'string' &&
      typeof obj.displayName === 'string' &&
      Array.isArray(obj.schemas)
    );
  }
  if (obj.type === 'database') {
    return (
      typeof obj.connectionInfo === 'object' &&
      obj.connectionInfo !== null &&
      typeof obj.sourceName === 'string' &&
      Array.isArray(obj.schemas)
    );
  }
  return false;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/** Create a new Project record with fresh id and timestamps. */
export function createProject(
  name: string,
  connection: DacpacConnection | DatabaseConnection,
): Project {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now, connection };
}

/**
 * Upsert a project into the store and mark it as last opened.
 * If project.id already exists → replace it.
 * If project.id is new → append it.
 * Always sets lastOpenedId = project.id.
 */
export function updateProject(store: ProjectStore, project: Project): ProjectStore {
  const exists = store.projects.some(p => p.id === project.id);
  const projects = exists
    ? store.projects.map(p => (p.id === project.id ? project : p))
    : [...store.projects, project];
  return { ...store, projects, lastOpenedId: project.id };
}

/** Remove a project by id. Falls back lastOpenedId to next most-recent or null. */
export function deleteProject(store: ProjectStore, id: string): ProjectStore {
  const projects = store.projects.filter(p => p.id !== id);
  const lastOpenedId =
    store.lastOpenedId === id
      ? ([...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null)
      : store.lastOpenedId;
  return { ...store, projects, lastOpenedId };
}

// ─── Auto-name ────────────────────────────────────────────────────────────────

/**
 * Generate a default project name from a connection.
 * Format: "{source} YYYY-MM-DD HH:mm"  (timestamp unique to the minute)
 * User can edit this before clicking Visualize.
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

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

// ─── Filter Profiles ──────────────────────────────────────────────────────────

/** Add or replace a filter profile on a project (matched by profile.id). */
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

/** Remove a filter profile from a project. */
export function deleteFilterProfile(store: ProjectStore, projectId: string, profileId: string): ProjectStore {
  const projects = store.projects.map(p => {
    if (p.id !== projectId) return p;
    return { ...p, filterProfiles: (p.filterProfiles ?? []).filter(fp => fp.id !== profileId) };
  });
  return { ...store, projects };
}

/** Convert a live FilterState (with Sets) to a JSON-serializable form. */
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

/** Restore a SerializedFilterState back to a live FilterState (with Sets). */
export function deserializeFilter(s: SerializedFilterState): FilterState {
  return {
    schemas: new Set(s.schemas),
    types: new Set(s.types) as FilterState['types'],
    searchTerm: s.searchTerm,
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
