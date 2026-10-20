/** Capability seam supplied to mutating lineage-tool handlers. */
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

/** Who dispatches a tool call: an `@lineage` chat turn, or a caller without one (`vscode.lm`). */
export type ToolCaller = 'turn' | 'external';

/** Host capabilities available to mutating lineage-tool handlers. */
export interface ToolServices {
  /** Accessor for the active AI session — the single owner of all mutable tool state. */
  readonly getSession: () => AiSession;
  /** Delivers one validated preview message to the result panel. */
  deliverPreview(message: AiViewPreviewMessage): Promise<PreviewDelivery>;
  /** Resolves the persisted AI run behind an applied bookmark; absent when the host wires no store. */
  readonly getStoredRun?: StoredRunReader;
  /** Category-scoped logger shared by every handler so log provenance stays uniform. */
  readonly logger: Logger;
  /** Turn-neutral text-completion capability; absent for callers without a chat turn. */
  readonly textModel?: Pick<ModelPort, 'generateStructured' | 'completeText' | 'getNumTokens'>;
  /** Cooperative host cancellation, mirrored from the owning turn's lease. */
  readonly signal?: AbortSignal;
  /** Token budget of the turn that owns this registry. */
  readonly budget: TurnTokenBudget;
  /** Who dispatches: `turn` (an `@lineage` chat turn) or `external` (a caller without a chat turn, restricted to the read-only tool policy). */
  readonly caller: ToolCaller;
  /** Current turn epoch — the turn lease wins over the session field so stale-turn writes are rejectable. */
  turnEpoch(sess: AiSession): number;
  /** Returns the loaded database model, throwing the standard no-model error when none is loaded. */
  requireModel(): DatabaseModel;
  /** Returns the loaded graphology graph, throwing the standard no-model error when none is loaded. */
  requireGraph(): Graph;
  /** Logs the tool call to the hop log + channel, then returns the result — the standard return path. */
  logAndReturn(toolName: ToolName, data: object, input?: unknown): string;
  /** Materializes the session's partial filter into a fully-defaulted filter for engine construction. */
  buildActiveFilter(sess: AiSession): SerializedFilterState;
  /** Wraps a thrown error as an `internal_error` result; the `present_result` branch bumps failure counters. */
  toolError(toolName: string, err: unknown): string;
}

/** Per-model id→node lookup, memoized across the mutating handlers that all rebuild it. */
const modelNodeMapCache = new WeakMap<DatabaseModel, Map<string, LineageNode>>();

/** Returns the memoized id→node map for `model`, building it once per model instance. */
export function getModelNodeMap(model: DatabaseModel): Map<string, LineageNode> {
  const cached = modelNodeMapCache.get(model);
  if (cached) return cached;
  const map = new Map(model.nodes.map(n => [n.id, n]));
  modelNodeMapCache.set(model, map);
  return map;
}
