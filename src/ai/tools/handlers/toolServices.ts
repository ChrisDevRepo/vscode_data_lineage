/**
 * Capability seam supplied to mutating lineage-tool handlers.
 *
 * @remarks
 * The interface keeps host dependencies explicit: handlers receive only the
 * session, graph/model accessors, logging, filter materialization, and result
 * delivery they need. Session state remains owned by {@link AiSession}; turn-lease
 * validation and effect serialization remain registry concerns.
 */
import type Graph from 'graphology';
import type { AiSession } from '../../session/session';
import type { Logger } from '../../../utils/log';
import type { DatabaseModel, LineageNode } from '../../../engine/types';
import type { SerializedFilterState } from '../../../engine/projectStore';
import type { StoredRunReader } from '../../session/runStore';
import type { ModelPort } from '../../model/modelPort';
import type { TurnTokenBudget } from '../../support/tokenBudget';
import type { ExtensionToWebviewMsg } from '../../../engine/shared/bridgeContract';

/** The one webview message a tool handler may hand to the host for delivery. */
export type AiViewPreviewMessage = Extract<ExtensionToWebviewMsg, { type: 'ai-view-preview' }>;

/** Host capabilities available to mutating lineage-tool handlers. */
export interface ToolServices {
  /** Accessor for the active AI session — the single owner of all mutable tool state. */
  readonly getSession: () => AiSession;
  /**
   * Delivers one validated preview message to the result panel.
   *
   * @remarks
   * The host owns the panel and the transport: it reveals before sending — a hidden panel measures
   * its canvas at zero, and a graph framed against a box that does not exist yet is never re-framed
   * once the tab comes forward — and it returns the webview's render ACK, which `present_result`
   * writes into the committed artifact. `false` covers every non-delivery: no panel open, a
   * rejected send, a transport error.
   */
  deliverPreview(message: AiViewPreviewMessage): Promise<boolean>;
  /** Resolves the persisted AI run behind an applied bookmark; absent when the host wires no store. */
  readonly getStoredRun?: StoredRunReader;
  /** Category-scoped logger shared by every handler so log provenance stays uniform. */
  readonly logger: Logger;
  /** Turn-neutral text-completion capability; absent on the external `vscode.lm` read-only registration. */
  readonly textModel?: Pick<ModelPort, 'generateStructured' | 'completeText'>;
  /** Cooperative host cancellation, mirrored from the owning turn's lease. */
  readonly signal?: AbortSignal;
  /**
   * Token budget of the turn that owns this registry.
   *
   * @remarks
   * Fixed when the lease-bound registry was built, so a superseded turn's still-running dispatch
   * keeps measuring against the caps its own model was admitted under. The external `vscode.lm`
   * registration, which serves callers outside any turn, carries the shipped defaults.
   */
  readonly budget: TurnTokenBudget;
  /** The hop cap the host resolved once at activation — the same value the graph runtime bounds the active loop with. */
  readonly maxRounds: number;
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
 * model. The model reference only changes when a new database is loaded (a fresh
 * `DatabaseModel` object replaces `AiSession.model`), so keying on that object in a `WeakMap`
 * gives free invalidation: the old entry falls out of scope with the old model, no explicit
 * clear needed.
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
