/**
 * Capability seam supplied to mutating lineage-tool handlers.
 *
 * @remarks
 * The interface keeps host dependencies explicit: handlers receive only the
 * session, graph/model accessors, logging, filter materialization, and webview
 * access they need. Session state remains owned by {@link AiSession}; turn-lease
 * validation and effect serialization remain registry concerns.
 */
import type * as vscode from 'vscode';
import type Graph from 'graphology';
import type { AiSession } from '../../session/session';
import type { Logger } from '../../../utils/log';
import type { DatabaseModel, LineageNode } from '../../../engine/types';
import type { SerializedFilterState } from '../../../engine/projectStore';

/** Host capabilities available to mutating lineage-tool handlers. */
export interface ToolServices {
  /** Accessor for the active AI session — the single owner of all mutable tool state. */
  readonly getSession: () => AiSession;
  /** Accessor for the active webview panel; `present_result` posts the rendered view to it. */
  readonly getPanel: () => vscode.WebviewPanel | undefined;
  /** Category-scoped logger shared by every handler so log provenance stays uniform. */
  readonly logger: Logger;
  /** Current turn epoch — the turn lease wins over the session field so stale-turn writes are rejectable. */
  turnEpoch(sess: AiSession): number;
  /** Returns the loaded database model, throwing the standard no-model error when none is loaded. */
  requireModel(): DatabaseModel;
  /** Returns the loaded graphology graph, throwing the standard no-model error when none is loaded. */
  requireGraph(): Graph;
  /** Logs the tool call to the hop log + channel, then returns the result — the standard return path. */
  logAndReturn(toolName: string, data: object, input?: unknown): string;
  /** Materializes the session's partial filter into a fully-defaulted filter for engine construction. */
  buildActiveFilter(sess: AiSession): SerializedFilterState;
  /** Wraps a thrown error as an `internal_error` result; the `present_result` branch bumps failure counters. */
  toolError(toolName: string, err: unknown): string;
}

/**
 * Per-model id→node lookup, memoized across the mutating handlers that all rebuild it.
 *
 * @remarks
 * `submit_findings` and `present_result` each need an id→node map for the currently loaded
 * model, and every one of them previously rebuilt it from `model.nodes` on every call. The
 * model reference only changes when a new database is loaded (a fresh `DatabaseModel` object
 * replaces `AiSession.model`), so keying on that object in a `WeakMap` gives free invalidation:
 * the old entry falls out of scope with the old model, no explicit clear needed.
 */
const modelNodeMapCache = new WeakMap<DatabaseModel, Map<string, LineageNode>>();

/** Returns the memoized id→node map for `model`, building it once per model instance. */
export function getModelNodeMap(model: DatabaseModel): Map<string, LineageNode> {
  const cached = modelNodeMapCache.get(model);
  if (cached) return cached;
  const map = new Map(model.nodes.map(n => [n.id, n]));
  modelNodeMapCache.set(model, map);
  return map;
}
