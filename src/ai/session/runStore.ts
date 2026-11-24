/**
 * Persisted AI-run checkpoints keyed by the bookmark that presented them. A bookmark saved from an
 * AI-authored view records the run that produced it, so a later turn can answer "what did this view
 * come from" without replaying the exploration. One record per saved view, and the view owns its
 * lifetime: `delete-view` and `delete-project` (`src/bridge/messageHandlers.ts`) clear their
 * records; a new route that removes a saved view must clear its record too.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NavigationSnapshotSchema } from '../sm/navigationSnapshotSchema';
import type { SmState } from '../sm/navigationSnapshotSchema';
import { sanitizeForLog, trunc, type Logger } from '../../utils/log';
import type { FilterProfile } from '../../engine/shared/bridgeContract';
import type { PresentationArtifact, ResultGraph } from './types';

/** Committed report section header persisted with an AI run: label and linked node ids, no body. */
interface StoredAiRunSection {
  readonly label: string;
  readonly node_ids: readonly string[];
}

/** Persisted checkpoint of one presented AI run, written on bookmark save and read back. */
export interface StoredAiRun {
  /** Fail-closed contract version of this record. */
  readonly schemaVersion: 1;
  /** Identifier of the run that authored the presented view. */
  readonly runId: string;
  /** ISO timestamp of the save that produced this record. */
  readonly savedAt: string;
  /** Resolved origin node id of the run, or `null` when the run recorded none. */
  readonly origin: string | null;
  /** DDL content hashes of the scope nodes at save time, keyed by node id. */
  readonly ddlHashes: Readonly<Record<string, string>>;
  /** Engine checkpoint the run ended on. */
  readonly snapshot: SmState;
  /** Committed report section labels and linked node ids (no bodies), absent on older records. */
  readonly sections?: readonly StoredAiRunSection[];
}

/** Resolves the stored run for one saved bookmark id, or `undefined` when none was persisted. */
export type StoredRunReader = (bookmarkId: string) => StoredAiRun | undefined;

/** Global-state key prefix under which one {@link StoredAiRun} is persisted per bookmark. */
const AI_RUN_KEY_PREFIX = 'dataLineageViz.aiRun.';

/** Builds the global-state key holding the {@link StoredAiRun} for one bookmark. @internal */
export function aiRunStorageKey(bookmarkId: string): string {
  return `${AI_RUN_KEY_PREFIX}${bookmarkId}`;
}

/** Stored hash for a scope node whose DDL was unavailable at save time; never counts as stale. */
export const UNKNOWN_DDL_HASH = 'unknown';

/** Minimal write surface of the global-state store the run records live in. */
type RunStoreWriter = {
  update(key: string, value: unknown): PromiseLike<void>;
};

/** Minimal read surface of the global-state store the run records live in. */
type RunStoreReader = {
  get<T>(key: string): T | undefined;
};

/**
 * Read contract for one persisted run record: tolerant where the record can degrade, strict where
 * it cannot. A top-level key from a newer build is carried through, not treated as corruption; an
 * unreadable `origin` or `ddlHashes` costs only the staleness annotation. The snapshot is validated
 * by the navigation snapshot schema, so a damaged record answers "no run memory" instead of
 * reaching the presenter half-shaped.
 */
const StoredAiRunSectionSchema = z.object({
  label: z.string(),
  node_ids: z.array(z.string()),
}).strict();

const StoredAiRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  savedAt: z.string(),
  origin: z.string().nullable().catch(null),
  ddlHashes: z.record(z.string(), z.string()).catch(() => ({})),
  snapshot: NavigationSnapshotSchema,
  sections: z.array(StoredAiRunSectionSchema).optional().catch(undefined),
}).passthrough();

/**
 * Reads the run record filed under one bookmark key. Fail-closed on the contract: a record of
 * another `schemaVersion`, or whose snapshot is not a navigation checkpoint, reads as absent, so a
 * consumer never meets an unknown shape.
 *
 * @param log - Optional logger; a rejected record is reported once at debug.
 * @returns The stored run, or `undefined` when none is persisted or the record fails validation.
 */
export function readStoredRun(
  store: RunStoreReader,
  bookmarkId: string,
  log?: Pick<Logger, 'debug'>,
): StoredAiRun | undefined {
  const record = store.get<unknown>(aiRunStorageKey(bookmarkId));
  if (record === undefined || record === null) return undefined;
  const parsed = StoredAiRunSchema.safeParse(record);
  if (parsed.success) return parsed.data;
  const paths = Array.from(new Set(parsed.error.issues.map(issue => issue.path.join('.') || '(root)')));
  log?.debug(`[RunStore] discarded unreadable run record bookmark=${sanitizeForLog(bookmarkId)} paths=${trunc(paths, 3)}`);
  return undefined;
}

/** Hashes an object's DDL for staleness checks: sha256 hex, or {@link UNKNOWN_DDL_HASH} if none. */
export function hashDdl(ddl: string | undefined): string {
  return typeof ddl === 'string' && ddl.length > 0
    ? createHash('sha256').update(ddl, 'utf8').digest('hex')
    : UNKNOWN_DDL_HASH;
}

function toStoredSections(
  sections: ReadonlyArray<{ readonly label: string; readonly node_ids?: readonly string[] }> | undefined,
): StoredAiRunSection[] | undefined {
  return sections
    ? sections.map(sec => ({ label: sec.label, node_ids: [...(sec.node_ids ?? [])] }))
    : undefined;
}

/**
 * Builds the run record for a bookmark saved from an AI-authored view.
 *
 * @param artifact - The session's last committed presentation, or `null` when none exists.
 * @param getDdl - Resolver for an object's current DDL text.
 * @returns The record to persist, or `null` when the profile does not belong to a captured run.
 */
export function buildStoredRun(
  profile: FilterProfile,
  artifact: PresentationArtifact | null,
  getDdl: (id: string) => string | undefined,
): StoredAiRun | null {
  if (profile.source !== 'ai') return null;
  const runId = profile.aiMetadata?.runId;
  if (typeof runId !== 'string' || !artifact || runId !== artifact.runId) return null;
  const checkpoint = artifact.checkpoint;
  if (!checkpoint) return null;
  const scopeNodeIds = checkpoint.scopeNodeIds ?? profile.filter.allowlistNodeIds ?? [];
  const ddlHashes: Record<string, string> = Object.fromEntries(scopeNodeIds.map(id => [id, hashDdl(getDdl(id))]));
  const sections = toStoredSections(artifact.sections);
  return {
    schemaVersion: 1,
    runId,
    savedAt: new Date().toISOString(),
    origin: checkpoint.engineInternals?.initSnapshot?.origin ?? null,
    ddlHashes,
    snapshot: checkpoint,
    ...(sections ? { sections } : {}),
  };
}

/**
 * Wraps the session's presented run as an unsaved record for recall: a completed run on screen has
 * the same checkpoint a bookmark save would persist. The DDL cannot have moved within the session,
 * so no hashes are recorded and no object reads as stale. `undefined` when the presentation carries
 * no run or checkpoint.
 */
export function buildLiveRun(
  artifact: PresentationArtifact | null,
  fallbackSections?: ResultGraph['sections'] | null,
): StoredAiRun | undefined {
  const checkpoint = artifact?.checkpoint;
  if (!artifact?.runId || !checkpoint) return undefined;
  const sections = toStoredSections(artifact.sections ?? fallbackSections ?? undefined);
  return {
    schemaVersion: 1,
    runId: artifact.runId,
    savedAt: new Date().toISOString(),
    origin: checkpoint.engineInternals?.initSnapshot?.origin ?? null,
    ddlHashes: {},
    snapshot: checkpoint,
    ...(sections ? { sections } : {}),
  };
}

/**
 * Persists one run record under its bookmark key. Never skipped or truncated for size: a bookmark
 * carries its whole run or none, the exploration node cap already bounds a record, and the
 * SQLite-backed store makes a multi-megabyte value an ordinary write. Returns the serialized size
 * in characters, for diagnostics.
 */
export async function writeStoredRun(
  store: RunStoreWriter,
  bookmarkId: string,
  run: StoredAiRun,
): Promise<number> {
  await store.update(aiRunStorageKey(bookmarkId), run);
  return JSON.stringify(run).length;
}

/** Clears the run record filed under one bookmark key. */
export async function clearStoredRun(store: RunStoreWriter, bookmarkId: string): Promise<void> {
  await store.update(aiRunStorageKey(bookmarkId), undefined);
}
