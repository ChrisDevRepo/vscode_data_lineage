/** Executing DMV queries on a {@link DbSession}; the persistable shape of a stored connection. */

import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { SimpleExecuteResult } from '../types/database';
import { expandSchemaPlaceholder, validateSchemaPlaceholder } from '../utils/sql';
import { Logger, trunc, sanitizeForLog, type LogChannel } from '../utils/log';
import { StoredConnectionInfoSchema, type StoredConnectionInfo } from './shared/bridgeContract';
import type { DbSession } from './db/dbSession';

/** A Dynamic Management View (DMV) query used to extract metadata from SQL Server. */
export interface DmvQuery {
  /**
   * The unique name/key of the query.
   *
   * Two classes, because they fail differently. Required ('schema-preview', 'nodes', 'columns',
   * 'dependencies') are in the loader's `KNOWN_NAMES` and warn when a custom YAML omits them, since
   * the import cannot complete without them. Optional ('all-objects', 'platform-info',
   * 'constraints') are absent from that list and degrade silently by design: omitting 'all-objects'
   * leaves cross-schema references unclassified, 'platform-info' leaves the platform unknown,
   * 'constraints' drops constraint enrichment.
   */
  name: string;
  /** A human-readable description of the query's purpose. Never consumed by the import path. */
  description?: string;
  sql: string;
  /**
   * Execution phase: `1` preliminary (unfiltered), `2` main extraction (typically schema-filtered).
   * @defaultValue 2
   */
  phase?: number;
}

/**
 * Reduces connection info to exactly the fields that may be persisted. An allow-list read from
 * {@link StoredConnectionInfoSchema}, so the two cannot drift.
 *
 * A deny-list is unsafe because the object can be wider than the stored shape (a legacy
 * workspace-state record carries `applicationName`, `connectTimeout`, ...). Spreading the rest
 * wrote those keys into the project store; the strict read side then rejected the record and
 * `migrateProjectStore` discarded the saved project on the next load. `.strict()` on the read side
 * stays on purpose: it keeps a future leaked credential out of the store. This is the only write
 * path, so it narrows here and parses what it built, failing at save time rather than dropping the
 * project on the next load.
 *
 * @returns A persistable clone with only schema-declared fields; secrets are never among them.
 * @throws When the narrowed record still violates {@link StoredConnectionInfoSchema}, e.g. a
 *   server-scoped profile with no `database`.
 */
export function stripSensitiveFields(source: Record<string, unknown>): StoredConnectionInfo {
  const persistable: Record<string, unknown> = {};
  for (const key of Object.keys(StoredConnectionInfoSchema.shape)) {
    if (source[key] !== undefined) persistable[key] = source[key];
  }
  return StoredConnectionInfoSchema.parse(persistable);
}

const DmvQueriesConfigSchema = z.object({
  version: z.coerce.number().optional(),
  queries: z.array(z.unknown()).optional()
}).passthrough();

/** The fields the import path requires; every other {@link DmvQuery} field degrades gracefully. */
const DmvQuerySchema = z.object({ name: z.string().min(1), sql: z.string().min(1) });
export const isDmvQuery = (q: unknown): q is DmvQuery => DmvQuerySchema.safeParse(q).success;

/** Root configuration structure for DMV query definition files. */
export interface DmvQueriesConfig {
  version: number;
  queries: DmvQuery[];
}

/** Parses the text of a DMV queries YAML file; `version` and `queries` may be absent. */
export function parseDmvQueriesYaml(text: string) {
  return DmvQueriesConfigSchema.parse(yaml.load(text));
}

/**
 * Validates the text of the built-in `assets/dmvQueries.yaml`.
 *
 * @throws If the file has no `queries` array, declares no `version`, or holds an invalid query.
 */
export function parseBuiltInDmvConfig(text: string): DmvQueriesConfig {
  const { version, queries } = parseDmvQueriesYaml(text);
  if (!queries || !Array.isArray(queries)) {
    throw new Error('Built-in dmvQueries.yaml is invalid — missing "queries" array');
  }
  if (version === undefined) {
    throw new Error('Built-in dmvQueries.yaml is invalid — missing "version"');
  }
  const validQueries = queries.filter(isDmvQuery);
  if (validQueries.length !== queries.length) {
    throw new Error('Built-in dmvQueries.yaml is invalid — a query is missing "name" or "sql"');
  }

  return { version, queries: validQueries };
}

/** Wraps an async operation with a timeout; rejects with `timeoutMessage` after `ms`. */
function withQueryTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(handle)),
    new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    }),
  ]);
}

/** Error text when a DMV query outlives `dataLineageViz.dmvQueryTimeout`. */
function dmvTimeoutMessage(name: string, queryTimeoutMs: number): string {
  return `DMV query "${name}" timed out after ${queryTimeoutMs / 1000}s. Increase dataLineageViz.dmvQueryTimeout if needed.`;
}

/**
 * Runs one query on a session, bounded by an optional timeout. The session receives the same budget
 * so a provider that owns the wire cancels the request instead of leaving it running behind the
 * timeout.
 */
async function runTimed(
  session: DbSession,
  sql: string,
  timeoutMs: number | undefined,
  timeoutMessage: string,
): Promise<SimpleExecuteResult> {
  if (!timeoutMs) return session.executeSimpleQuery(sql);
  return withQueryTimeout(session.executeSimpleQuery(sql, { timeoutMs, timeoutMessage }), timeoutMs, timeoutMessage);
}

/**
 * Executes a batch of DMV queries sequentially; returns a map of query name to result.
 *
 * @param queryTimeoutMs - Optional per-query timeout in milliseconds.
 */
export async function executeDmvQueries(
  session: DbSession,
  queries: DmvQuery[],
  outputChannel: LogChannel,
  onProgress?: (step: number, total: number, label: string) => void,
  queryTimeoutMs?: number,
): Promise<Map<string, SimpleExecuteResult>> {
  const logger = Logger.create(outputChannel, 'DB');

  const results = new Map<string, SimpleExecuteResult>();
  const total = queries.length;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const step = i + 1;

    onProgress?.(step, total, query.name);
    logger.debug(`Executing ${query.name} (${step}/${total}) — SQL: ${trunc(sanitizeForLog(query.sql), 300)}`);

    const start = Date.now();
    const result = await runTimed(session, query.sql, queryTimeoutMs, dmvTimeoutMessage(query.name, queryTimeoutMs ?? 0));
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    logger.debug(`Query '${query.name}' — ${result.rowCount} rows (${elapsed}s)`);
    results.set(query.name, result);
  }

  return results;
}

/**
 * Whether a query belongs to the schema-filtered Phase 2 sweep. Exported so callers size progress
 * from the same predicate the sweep uses: `phase: 1` means "not schema-filtered", not "runs during
 * Phase 1" (the platform probe carries that tag while running at Phase 2 time), so a
 * re-implementation would miscount the steps.
 */
export const isPhase2Query = (q: DmvQuery): boolean => (q.phase ?? 2) !== 1;

/**
 * Executes the Phase 2 queries among `queries` with `{{SCHEMAS}}` substitution from `schemas`.
 *
 * @param queryTimeoutMs - Optional per-query timeout in milliseconds.
 */
export async function executeDmvQueriesFiltered(
  session: DbSession,
  queries: DmvQuery[],
  schemas: string[],
  outputChannel: LogChannel,
  onProgress?: (step: number, total: number, label: string) => void,
  queryTimeoutMs?: number,
): Promise<Map<string, SimpleExecuteResult>> {
  const logger = Logger.create(outputChannel, 'DB');

  const phase2Queries = queries.filter(isPhase2Query);

  for (const q of phase2Queries) {
    const warning = validateSchemaPlaceholder(q.name, q.sql, q.phase ?? 2);
    if (warning) logger.warn(warning);
  }

  const results = new Map<string, SimpleExecuteResult>();
  const total = phase2Queries.length;

  for (let i = 0; i < phase2Queries.length; i++) {
    const query = phase2Queries[i];
    const step = i + 1;
    const sql = expandSchemaPlaceholder(query.sql, schemas);

    onProgress?.(step, total, query.name);
    logger.debug(`Executing ${query.name} (${step}/${total}) — SQL: ${trunc(sanitizeForLog(sql), 300)}`);

    const start = Date.now();
    const result = await runTimed(session, sql, queryTimeoutMs, dmvTimeoutMessage(query.name, queryTimeoutMs ?? 0));
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    logger.debug(`Query '${query.name}' — ${result.rowCount} rows (${elapsed}s)`);
    results.set(query.name, result);
  }

  return results;
}

/**
 * Executes a single SQL command without batching or placeholders.
 *
 * @param timeout - Optional budget; the session cancels the request when it is spent.
 */
export async function executeSimpleQuery(
  session: DbSession,
  sql: string,
  outputChannel: LogChannel,
  timeout?: { ms: number; message: string },
): Promise<SimpleExecuteResult> {
  const logger = Logger.create(outputChannel, 'DB');
  logger.debug(`Executing simple query — SQL: ${trunc(sanitizeForLog(sql), 300)}`);
  const start = Date.now();
  const result = await runTimed(session, sql, timeout?.ms, timeout?.message ?? '');
  logger.debug(`Simple query — ${result.rowCount} rows (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  return result;
}
