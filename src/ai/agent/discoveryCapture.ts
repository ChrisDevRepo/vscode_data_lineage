/** Detects a multi-object discovery walk from accepted graph-owned tool observations. */
import { z } from 'zod';
import type { ToolAttemptObservation } from './toolAttempt';
import type { AiSession } from '../session/session';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { readToolError } from '../support/toolErrorEnvelope';
import { OVER_DISCOVERY_BUDGET_HINT } from '../support/tokenBudget';

/** The captured walk used to seed the SM-offer pill / `lineage_start_exploration`. */
interface DiscoveryWalk {
  /** Distinct objects inspected via `lineage_get_object_detail` (≥ 2 to qualify). */
  readonly walkCount: number;
  /** The first inspected node id — the SM-offer origin. */
  readonly origin: string;
  /** The AI's final discovery answer (markdown), for the deeper-analysis seed prompt. */
  readonly answer: string;
}

const OBJECT_DETAIL_TOOL = 'lineage_get_object_detail';

/**
 * The one tool whose over-budget rejection means "this scope is too large to answer inline".
 *
 * @remarks
 * `checkScopeBudget` is shared, so its envelope can surface from any caller — `presentRunRecall`
 * returns it for an oversized stored-run recall. Only an oversized *scope* request carries the
 * routing meaning: the user asked for a neighbourhood that has to be walked hop-by-hop. Matching on
 * the envelope alone turned "what did this run prune?" into a fresh exploration approval gate
 * instead of the recall rejection the model already reads.
 */
const SCOPE_BUNDLE_TOOL = 'lineage_get_scope_bundle';

const NodeCountsView = z.object({ nodes: z.number() }).loose();

/**
 * The over-budget refusal as any catalog tool serves it: the rejection (`detail.counts`,
 * `detail.scope_proposal`) or `lineage_search_ddl`'s partial reply (top-level `counts`) — both carry
 * the budget code as `reason`.
 */
const OverBudgetResultView = z.object({
  reason: z.literal(REJECTION_CODES.overDiscoveryBudget),
  counts: NodeCountsView.optional(),
  hint: z.string().optional(),
  detail: z.object({
    counts: NodeCountsView.optional(),
    scope_proposal: z.object({ origin: z.string().trim().min(1) }).loose().optional(),
  }).loose().optional(),
}).loose();

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
    if (readToolError(raw)) continue;
    const view = ObjectDetailIdView.safeParse(raw);
    if (!view.success) {
      onMalformed?.(observation.toolName, observation.callId);
      continue;
    }
    inspected.push(view.data.id.trim());
  }
  const distinct = new Set(inspected);
  if (distinct.size < 2) return null;
  return { walkCount: distinct.size, origin: inspected[0], answer };
}

/**
 * Whether one tool result means "this scope is too large to answer inline — reroute to SM".
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
interface OverBudgetNotice {
  /** Tool whose result carried the rejection envelope. */
  readonly toolName: string;
  /** Projected node count from the envelope, when the emitting guard provided one. */
  readonly nodes: number | null;
  /** The envelope's AI-facing hint, or the shipped default when omitted. */
  readonly hint: string;
}

/**
 * Reads an `over_discovery_budget` rejection from any tool result.
 *
 * @remarks
 * Unlike {@link detectOverBudgetFromResult} this is tool-agnostic: every catalog surface shares
 * `checkScopeBudget`, so the same envelope can arrive from scope bundles, DDL detail, group
 * requests, or screen recall. Returns `null` for anything else, including malformed JSON.
 *
 * @param toolName - Tool that produced `resultText`.
 * @param resultText - The tool's serialized result.
 * @returns The notice payload, or `null` when the result is not an over-budget rejection.
 */
function readOverBudgetNotice(toolName: string, resultText: string): OverBudgetNotice | null {
  let raw: unknown;
  try {
    raw = JSON.parse(resultText);
  } catch {
    return null;
  }
  const view = OverBudgetResultView.safeParse(raw);
  if (!view.success) return null;
  return { toolName, nodes: (view.data.detail?.counts ?? view.data.counts)?.nodes ?? null, hint: view.data.hint?.trim() || OVER_DISCOVERY_BUDGET_HINT };
}

/**
 * Queues the user-visible discovery-budget notice for the turn's closing markdown, once per turn.
 *
 * @remarks
 * The envelope itself is model-facing (an observation the model reads); without this
 * notice a budget rejection is silent to the user whenever the model does not mention it.
 * Recoverable, so it renders inline with the answer rather than claiming the turn's error
 * presentation.
 *
 * {@link SCOPE_BUNDLE_TOOL} is excluded: an oversized scope is not a rejection the user has to read
 * about, it is the mechanical reroute into the consent-gated exploration path
 * ({@link detectOverBudgetFromResult}), and the approval gate that opens next is the user-visible
 * signal. A notice there would announce an inline answer the turn is not going to give.
 *
 * @param session - The session whose turn carries the notice to its closing markdown.
 * @param toolName - Tool that produced `resultText`.
 * @param resultText - The tool's serialized result.
 */
export function queueDiscoveryBudgetNotice(session: Pick<AiSession, 'queueClosingNotice'>, toolName: string, resultText: string): void {
  if (toolName === SCOPE_BUNDLE_TOOL) return;
  const notice = readOverBudgetNotice(toolName, resultText);
  if (!notice) return;
  const scope = notice.nodes !== null && notice.nodes > 0 ? ` (${notice.nodes} projected nodes)` : '';
  session.queueClosingNotice(
    'discovery_budget',
    `**Discovery budget reached** — \`${notice.toolName}\` was rejected${scope}: the requested scope is more than a quick answer loads (\`dataLineageViz.ai.discoveryNodeCap\`, \`dataLineageViz.ai.discoveryTokenBudget\`). Ask for a detailed analysis to cover it.`,
  );
}
