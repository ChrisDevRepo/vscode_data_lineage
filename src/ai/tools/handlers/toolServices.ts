/**
 * Capability seam supplied to mutating lineage-tool handlers. It keeps host dependencies explicit:
 * handlers receive only the session, graph/model accessors, logging, filter materialization and
 * result delivery they need. Session state stays owned by {@link AiSession}; turn-lease validation
 * and effect serialization stay registry concerns.
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
import type { ToolName } from '../toolDefs';
import type { PreviewDelivery } from '../../support/chatAnswer';

/** The one webview message a tool handler may hand to the host for delivery. */
export type AiViewPreviewMessage = Extract<ExtensionToWebviewMsg, { type: 'ai-view-preview' }>;

/** Host capabilities available to mutating lineage-tool handlers. */
export interface ToolServices {
  /** Accessor for the active AI session — the single owner of all mutable tool state. */
  readonly getSession: () => AiSession;
  /**
   * Delivers one validated preview message to the result panel. The host owns the panel and
   * transport: it reveals before sending (a hidden panel measures its canvas at zero, and a graph
   * framed against a box that does not exist yet is never re-framed once the tab comes forward) and
   * returns the webview's render ACK, which `present_result` writes into the committed artifact.
   * The outcome is a {@link PreviewDelivery}: an absent panel is a deferral, a refused send a
   * failure; a transport throw propagates.
   */
  deliverPreview(message: AiViewPreviewMessage): Promise<PreviewDelivery>;
  /** Resolves the persisted AI run behind an applied bookmark; absent if the host has no store. */
  readonly getStoredRun?: StoredRunReader;
  /** Category-scoped logger shared by every handler so log provenance stays uniform. */
  readonly logger: Logger;
  /** Turn-neutral text-completion capability; absent on the read-only MCP registry. */
  readonly textModel?: Pick<ModelPort, 'generateStructured' | 'completeText' | 'getNumTokens'>;
  /** Cooperative host cancellation, mirrored from the owning turn's lease. */
  readonly signal?: AbortSignal;
  /**
   * Token budget of the turn that owns this registry, fixed when the lease-bound registry was built
   * so a superseded turn's still-running dispatch keeps measuring against the caps its own model
   * was admitted under. The MCP server, serving callers outside any turn, passes `null`: no
   * discovery or admission limit applies to its calls.
   */
  readonly budget: TurnTokenBudget | null;
  /** Current turn epoch; the turn lease beats the session field, so stale writes are rejectable. */
  turnEpoch(sess: AiSession): number;
  /** Returns the loaded database model, or throws the standard no-model error. */
  requireModel(): DatabaseModel;
  /** Returns the loaded graphology graph, or throws the standard no-model error. */
  requireGraph(): Graph;
  /** Logs the tool call to the hop log and channel, then returns the result (standard path). */
  logAndReturn(toolName: ToolName, data: object, input?: unknown): string;
  /** Materializes the session's partial filter into a fully-defaulted one for the engine. */
  buildActiveFilter(sess: AiSession): SerializedFilterState;
  /** Wraps a thrown error as an `internal_error` result; `present_result` counts the failure. */
  toolError(toolName: string, err: unknown): string;
}

/**
 * Per-model id→node lookup, memoized across the mutating handlers (`submit_findings`,
 * `present_result`) that all rebuild it. The model reference changes only when a new database is
 * loaded (a fresh `DatabaseModel` replaces `AiSession.model`), so keying a `WeakMap` on it
 * invalidates for free.
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
