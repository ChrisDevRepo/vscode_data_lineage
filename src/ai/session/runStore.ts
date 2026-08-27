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
import type { SmState } from '../sm/smTypes';
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
 * Reads the run record filed under one bookmark key.
 *
 * @remarks
 * Fail-closed on the contract version: a record of any other `schemaVersion` reads as absent, so a
 * consumer never meets a shape it does not know.
 *
 * @param store - The global-state reader.
 * @param bookmarkId - Identifier of the bookmark whose record is read.
 * @returns The stored run, or `undefined` when none is persisted or its version is not current.
 */
export function readStoredRun(store: RunStoreReader, bookmarkId: string): StoredAiRun | undefined {
  const record = store.get<unknown>(aiRunStorageKey(bookmarkId));
  return typeof record === 'object' && record !== null && (record as { schemaVersion?: unknown }).schemaVersion === 1
    ? (record as StoredAiRun)
    : undefined;
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
