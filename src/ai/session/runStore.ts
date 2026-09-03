/**
 * Persisted AI-run checkpoints keyed by the bookmark that presented them.
 *
 * @remarks
 * A bookmark saved from an AI-authored view records the run that produced it, so a later turn can
 * answer "what did this view come from" without replaying the exploration. The record is written on
 * bookmark save and read back by `lineage_get_screen_state`; every consumer treats a missing or
 * older record as absent rather than as an error.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NavigationSnapshotSchema } from '../sm/navigationSnapshotSchema';
import type { SmState } from '../sm/smTypes';
import type { Logger } from '../../utils/log';
import type { FilterProfile } from '../../engine/shared/bridgeContract';
import type { PresentationArtifact } from './types';

/** Persisted checkpoint of one presented AI run; written on bookmark save, read by lineage_get_screen_state. */
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
}

/** Resolves the stored run for one saved bookmark id, or `undefined` when none was persisted. */
export type StoredRunReader = (bookmarkId: string) => StoredAiRun | undefined;

/** Global-state key prefix under which one {@link StoredAiRun} is persisted per bookmark. */
export const AI_RUN_KEY_PREFIX = 'dataLineageViz.aiRun.';

/**
 * Builds the global-state key holding the {@link StoredAiRun} for one bookmark.
 *
 * @param bookmarkId - Identifier of the saved filter profile the run was presented as.
 * @returns The prefixed storage key.
 */
export function aiRunStorageKey(bookmarkId: string): string {
  return `${AI_RUN_KEY_PREFIX}${bookmarkId}`;
}

/** Stored hash for a scope node whose DDL was unavailable at save time; never counts as stale. */
export const UNKNOWN_DDL_HASH = 'unknown';

/** Minimal write surface of the global-state store the run records live in. */
export type RunStoreWriter = {
  update(key: string, value: unknown): PromiseLike<void>;
};

/** Minimal read surface of the global-state store the run records live in. */
export type RunStoreReader = {
  get<T>(key: string): T | undefined;
};

/**
 * Read contract for one persisted run record.
 *
 * @remarks
 * Tolerant where the record can degrade and strict where it cannot. A top-level key from a newer
 * build is carried through rather than treated as corruption; an unreadable `origin` or
 * `ddlHashes` costs only the staleness annotation, so each falls back to its empty value instead
 * of dropping a whole run's memory. The snapshot is the one field a consumer walks structurally,
 * so it is validated by the same schema the engine restores from — a damaged checkpoint answers
 * "no run memory" rather than reaching the presenter as a half-shaped object.
 */
const StoredAiRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  savedAt: z.string(),
  origin: z.string().nullable().catch(null),
  ddlHashes: z.record(z.string(), z.string()).catch(() => ({})),
  snapshot: NavigationSnapshotSchema,
}).passthrough();

/**
 * Reads the run record filed under one bookmark key.
 *
 * @remarks
 * Fail-closed on the contract: a record of another `schemaVersion`, or one whose snapshot is not a
 * navigation checkpoint, reads as absent, so a consumer never meets a shape it does not know.
 *
 * @param store - The global-state reader.
 * @param bookmarkId - Identifier of the bookmark whose record is read.
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
  const paths = Array.from(new Set(parsed.error.issues.map(issue => issue.path.join('.') || '(root)'))).slice(0, 3);
  log?.debug(`[RunStore] discarded unreadable run record bookmark=${bookmarkId} paths=${paths.join(',')}`);
  return undefined;
}

/**
 * Hashes one object's DDL for staleness comparison.
 *
 * @param ddl - Current DDL text, or `undefined` when the object carries none.
 * @returns The lowercase sha256 hex digest, or {@link UNKNOWN_DDL_HASH} when there is no DDL.
 */
export function hashDdl(ddl: string | undefined): string {
  return typeof ddl === 'string' && ddl.length > 0
    ? createHash('sha256').update(ddl, 'utf8').digest('hex')
    : UNKNOWN_DDL_HASH;
}

/**
 * Builds the run record for a bookmark the user is saving from an AI-authored view.
 *
 * @param profile - The filter profile being saved.
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
  const ddlHashes: Record<string, string> = {};
  for (const id of scopeNodeIds) ddlHashes[id] = hashDdl(getDdl(id));
  return {
    schemaVersion: 1,
    runId,
    savedAt: new Date().toISOString(),
    origin: checkpoint.engineInternals?.initSnapshot?.origin ?? null,
    ddlHashes,
    snapshot: checkpoint,
  };
}

/**
 * Persists one run record under its bookmark key.
 *
 * @remarks
 * Never skipped or truncated for size: a bookmark either carries its whole run or none, and the
 * exploration node cap already bounds a record. The store is SQLite-backed, so a multi-megabyte
 * value is an ordinary write.
 *
 * @param store - The global-state writer.
 * @param bookmarkId - Identifier of the bookmark the run is filed under.
 * @param run - The record to persist.
 * @returns The serialized size of the written record in characters, for diagnostics.
 */
export async function writeStoredRun(
  store: RunStoreWriter,
  bookmarkId: string,
  run: StoredAiRun,
): Promise<number> {
  await store.update(aiRunStorageKey(bookmarkId), run);
  return JSON.stringify(run).length;
}

/**
 * Clears the run record filed under one bookmark key.
 *
 * @param store - The global-state writer.
 * @param bookmarkId - Identifier of the bookmark whose record is dropped.
 */
export async function clearStoredRun(store: RunStoreWriter, bookmarkId: string): Promise<void> {
  await store.update(aiRunStorageKey(bookmarkId), undefined);
}
