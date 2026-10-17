/** Persisted AI-run checkpoints keyed by the bookmark that presented them. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NavigationSnapshotSchema } from '../sm/navigationSnapshotSchema';
import type { SmState } from '../sm/smTypes';
import { sanitizeForLog, trunc, type Logger } from '../../utils/log';
import type { FilterProfile } from '../../engine/shared/bridgeContract';
import type { PresentationArtifact } from './types';

/** Persisted checkpoint of one presented AI run; written on bookmark save, read by lineage_get_screen_state. */
export interface StoredAiRun {
  /** Fail-closed contract version of this record. */
  readonly schemaVersion: 1;
  /** Absent on legacy records; current saves preserve literal identifier delimiters and URL identity. */
  readonly nodeIdEncodingVersion?: 2;
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
const AI_RUN_KEY_PREFIX = 'dataLineageViz.aiRun.';

/** Builds the global-state key holding the {@link StoredAiRun} for one bookmark. */
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

/** Read contract for one persisted run record. */
const StoredAiRunSchema = z.object({
  schemaVersion: z.literal(1),
  nodeIdEncodingVersion: z.literal(2).optional(),
  runId: z.string().min(1),
  savedAt: z.string(),
  origin: z.string().nullable().catch(null),
  ddlHashes: z.record(z.string(), z.string()).catch(() => ({})),
  snapshot: NavigationSnapshotSchema,
}).passthrough();

/** Reads the run record filed under one bookmark key. */
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

/** Hashes one object's DDL for staleness comparison. */
export function hashDdl(ddl: string | undefined): string {
  return typeof ddl === 'string' && ddl.length > 0
    ? createHash('sha256').update(ddl, 'utf8').digest('hex')
    : UNKNOWN_DDL_HASH;
}

/** Builds the run record for a bookmark the user is saving from an AI-authored view. */
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
  return {
    schemaVersion: 1,
    nodeIdEncodingVersion: 2,
    runId,
    savedAt: new Date().toISOString(),
    origin: checkpoint.engineInternals?.initSnapshot?.origin ?? null,
    ddlHashes,
    snapshot: checkpoint,
  };
}

/** Wraps the session's presented run as an unsaved record for recall. */
export function buildLiveRun(artifact: PresentationArtifact | null): StoredAiRun | undefined {
  const checkpoint = artifact?.checkpoint;
  if (!artifact?.runId || !checkpoint) return undefined;
  return {
    schemaVersion: 1,
    nodeIdEncodingVersion: 2,
    runId: artifact.runId,
    savedAt: new Date().toISOString(),
    origin: checkpoint.engineInternals?.initSnapshot?.origin ?? null,
    ddlHashes: {},
    snapshot: checkpoint,
  };
}

/** Persists one run record under its bookmark key. */
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
