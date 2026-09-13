/** Detects a multi-object discovery walk from accepted graph-owned tool observations. */
import { z } from 'zod';
import type { ToolAttemptObservation } from './toolAttempt';
import type { TurnEventSink } from '../runtime/turnEventSink';
import { readToolError } from '../support/toolErrorEnvelope';

/** The captured walk used to seed the SM-offer pill / `lineage_start_exploration`. */
interface DiscoveryWalk {
  /** Distinct objects inspected via `lineage_get_object_detail` (≥ 2 to qualify). */
  readonly walkCount: number;
  /** The first inspected node id — the SM-offer origin. */
  readonly origin: string;
  /** The AI's final discovery answer (markdown), for the deeper-analysis seed prompt. */
  readonly answer: string;
}

/** Origin captured from an oversized `lineage_get_scope_bundle` so the existing SM-offer pill can still fire. */
export interface RejectedScopeOffer {
  /** Canonical origin id from the rejected call or its `scope_proposal`. */
  readonly origin: string;
  /** Projected node count that overflowed the discovery cap (may be 0 when the envelope omitted it). */
  readonly walkCount: number;
}

const OBJECT_DETAIL_TOOL = 'lineage_get_object_detail';
const SCOPE_BUNDLE_TOOL = 'lineage_get_scope_bundle';

const ScopeBundleOriginView = z.object({ origin: z.string().trim().min(1) }).loose();
const OverBudgetResultView = z.object({
  reason: z.literal('over_discovery_budget'),
  counts: z.object({ nodes: z.number() }).loose().optional(),
  hint: z.string().optional(),
  scope_proposal: z.object({ origin: z.string().trim().min(1) }).loose().optional(),
}).loose();

// Canonical object-detail output always carries a nonblank id; anything else is malformed engine
// output and must surface observably instead of being skipped in silence.
const ObjectDetailIdView = z.object({ id: z.string().trim().min(1) }).loose();

/**
 * Extracts a discovery walk from accepted provider-neutral observations.
 *
 * @param observations - Successful graph-owned read results retained for the discovery phase.
 * @param answer - Accepted final discovery answer.
 * @param onMalformed - Observable failure policy for canonical output that fails the Zod view.
 * @returns The walk when at least two distinct object-detail results were observed.
 */
export function captureDiscoveryWalkFromObservations(
  observations: readonly ToolAttemptObservation[],
  answer: string,
  onMalformed?: (toolName: string, callId: string) => void,
): DiscoveryWalk | null {
  const inspected: string[] = [];
  for (const observation of observations) {
    if (observation.toolName !== OBJECT_DETAIL_TOOL) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(observation.result);
    } catch {
      onMalformed?.(observation.toolName, observation.callId);
      continue;
    }
    // An error envelope in an observation slot is a read that inspected nothing — the engine's own
    // reply (a body refused storage, a dispatcher rejection), never malformed canonical output.
    if (readToolError(raw)) continue;
    const view = ObjectDetailIdView.safeParse(raw);
    if (!view.success) {
      onMalformed?.(observation.toolName, observation.callId);
      continue;
    }
    inspected.push(view.data.id.trim());
  }
  const distinct = new Set(inspected.map(id => id.toLowerCase()));
  if (distinct.size < 2) return null;
  return { walkCount: distinct.size, origin: inspected[0], answer };
}

/**
 * Extracts the SM-offer origin from an oversized `lineage_get_scope_bundle` result.
 *
 * @param toolName - Tool that produced `resultText`.
 * @param input - Provider-emitted tool arguments (origin lives here when the envelope omitted `scope_proposal`).
 * @param resultText - Serialized tool result.
 * @returns The rejected origin and walk count, or `null` when this is not an oversized scope bundle.
 */
export function captureRejectedScopeOffer(
  toolName: string,
  input: unknown,
  resultText: string,
): RejectedScopeOffer | null {
  if (toolName !== SCOPE_BUNDLE_TOOL) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(resultText);
  } catch {
    return null;
  }
  const view = OverBudgetResultView.safeParse(raw);
  if (!view.success) return null;
  const fromInput = ScopeBundleOriginView.safeParse(input);
  const origin = (view.data.scope_proposal?.origin ?? (fromInput.success ? fromInput.data.origin : '')).trim();
  if (!origin) return null;
  return { origin, walkCount: view.data.counts?.nodes ?? 0 };
}

/**
 * Whether one tool result is an oversized `lineage_get_scope_bundle` request.
 *
 * @remarks
 * `checkScopeBudget` is shared, so its envelope can surface from any caller — `presentRunRecall`
 * returns it for an oversized stored-run recall. Only an oversized *scope* request seeds the
 * SM-offer pill; matching on the envelope alone is not a routing trigger.
 *
 * @param toolName - Name of the tool that produced `resultText`.
 * @param resultText - The tool's serialized result.
 * @returns True only for an oversized scope-bundle request.
 */
export function detectOverBudgetFromResult(toolName: string, resultText: string): boolean {
  if (toolName !== SCOPE_BUNDLE_TOOL) return false;
  try {
    return OverBudgetResultView.safeParse(JSON.parse(resultText)).success;
  } catch {
    return false;
  }
}

/** A parsed `over_discovery_budget` rejection from any catalog tool — drives the user-visible notice. */
export interface OverBudgetNotice {
  /** Tool whose result carried the rejection envelope. */
  readonly toolName: string;
  /** Projected node count from the envelope, when the emitting guard provided one. */
  readonly nodes: number | null;
  /** The envelope's AI-facing hint, or the shipped default when omitted. */
  readonly hint: string;
}

const DEFAULT_OVER_BUDGET_HINT = 'Scope exceeds the discovery budget, so only partial data could be loaded. Answer the user briefly from the partial data this result carries, say the full question needs a detailed analysis, and offer to continue with lineage_start_exploration once the user confirms — do not start it yourself.';

/**
 * Reads an `over_discovery_budget` rejection from any tool result.
 *
 * @remarks
 * Unlike {@link captureRejectedScopeOffer} this is tool-agnostic: every catalog surface shares
 * `checkScopeBudget`, so the same envelope can arrive from scope bundles, DDL detail, group
 * requests, or screen recall. Returns `null` for anything else, including malformed JSON.
 *
 * @param toolName - Tool that produced `resultText`.
 * @param resultText - The tool's serialized result.
 * @returns The notice payload, or `null` when the result is not an over-budget rejection.
 */
export function readOverBudgetNotice(toolName: string, resultText: string): OverBudgetNotice | null {
  let raw: unknown;
  try {
    raw = JSON.parse(resultText);
  } catch {
    return null;
  }
  const view = OverBudgetResultView.safeParse(raw);
  if (!view.success) return null;
  return { toolName, nodes: view.data.counts?.nodes ?? null, hint: view.data.hint?.trim() || DEFAULT_OVER_BUDGET_HINT };
}

/** Sinks that already showed the budget notice this turn — one notice per turn, however many rejections fire. */
const budgetNoticeShown = new WeakSet<TurnEventSink>();

/**
 * Emits the user-visible discovery-budget notice, once per turn.
 *
 * @remarks
 * The envelope itself is model-facing (an observation the model summarizes); without this notice
 * a budget rejection is silent to the user whenever the model does not mention it. Recoverable,
 * so it renders inline rather than claiming the turn's error presentation.
 *
 * @param sink - The turn's event sink.
 * @param toolName - Tool that produced `resultText`.
 * @param resultText - The tool's serialized result.
 */
export function emitDiscoveryBudgetNotice(sink: TurnEventSink, toolName: string, resultText: string): void {
  if (budgetNoticeShown.has(sink)) return;
  const notice = readOverBudgetNotice(toolName, resultText);
  if (!notice) return;
  budgetNoticeShown.add(sink);
  const scope = notice.nodes !== null && notice.nodes > 0 ? ` (${notice.nodes} projected nodes)` : '';
  sink.error(
    `**Discovery budget reached** — \`${notice.toolName}\` could not load the full result${scope}: the requested scope exceeds what one turn can load. The assistant will answer from what was returned; ask about a narrower part of the lineage, or start a detailed analysis, to cover the rest.`,
  );
}
