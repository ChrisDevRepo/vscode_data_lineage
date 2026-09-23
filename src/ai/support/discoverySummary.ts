/**
 * Composes the discovery-to-exploration handoff memo — the one-shot, no-tool LM round that turns
 * the user's discovery Q/A into the `<discovery_summary>` stable-prefix field every later hop and
 * synthesis prompt reads as established fact.
 *
 * @remarks
 * Called once per reviewable exploration proposal, at proposal-build time
 * (`src/ai/tools/handlers/startExploration.ts`), never at approval. The composed text is cached
 * on the revision-bound proposal; approval reuses that exact cached string via
 * `NavigationEngine.setDiscoverySummary` rather than recomposing it.
 */
import { z } from 'zod';
import type { ModelPort } from '../model/modelPort';
import { modelUserMessage } from '../model/modelPort';
import { compileInstructionPlan, executeInstructionPlan, explorationFacts } from '../agent/instructionPlan';
import { buildDiscoverySummaryComposePrompt, DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT } from '../prompting/prompts';
import type { NavigationEngine } from '../sm/smBase';
import type { ClassificationValue } from '../session/classification';
import { sanitizeForLog, type Logger } from '../../utils/log';

/**
 * Validated boundary for the optional one-shot discovery-to-exploration memo.
 *
 * @remarks
 * Nonblank only — model-authored content is never length-rejected. Brevity (2–4 sentences) is a
 * prompt target, not a hard cap: the memo's length legitimately scales with the analysis it
 * summarizes.
 */
const DiscoverySummarySchema = z.string().trim().min(1);

/** One mechanical re-ask on a rejected compose reply, the reject-with-hint convention every Zod boundary here follows. */
const DISCOVERY_SUMMARY_COMPOSE_ATTEMPTS = 2;

/**
 * Composes the memo, or returns `undefined` on an ordinary degrade (rejected output after retry,
 * or a non-abort provider failure) — the caller shows the approval card without a memo rather than
 * blocking or failing an otherwise valid proposal.
 *
 * @param model - Text-completion capability only; never dispatches tools.
 * @param signal - Host cancellation signal; an abort re-throws so the caller's own cancellation
 * path can surface a clean cancel instead of a silently degraded memo.
 * @param logger - Optional diagnostic sink; a lost memo is DEBUG (self-correcting boundary), a
 * thrown compose call is ERROR (implementation/provider failure).
 * @param lastDiscoveryQuestion - The user's verbatim discovery question.
 * @param lastDiscoveryAnswer - The AI's discovery chat answer (Markdown).
 * @param classification - The proposal's locked-in-waiting classification.
 * @param engine - The unpublished preview engine already initialized from the proposal being reviewed.
 */
export async function composeDiscoverySummaryText(
  model: Pick<ModelPort, 'generateStructured' | 'completeText'>,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
  lastDiscoveryQuestion: string,
  lastDiscoveryAnswer: string,
  classification: ClassificationValue,
  engine: NavigationEngine,
): Promise<string | undefined> {
  try {
    const scope = engine.getScopeSummary();
    const filters = scope.activeFilters;
    const analysisMode = engine.currentAnalysisMode;
    const targetColumns = analysisMode === 'ct' ? (engine.currentTargetColumns ?? undefined) : undefined;
    const contractSummary = [
      `- origin: ${engine.currentOrigin ?? '(unset)'}`,
      `- scope: ${scope.scopeCount} nodes`,
      `- direction: ${engine.currentDirection}`,
      `- analysisMode: ${analysisMode}`,
      ...(analysisMode === 'ct' ? [`- targetColumns: ${(targetColumns ?? []).join(', ')}`] : []),
      `- excludeTypes: ${filters.types.length ? filters.types.join(', ') : '(none)'}`,
      `- excludeSchemas: ${filters.schemas.length ? filters.schemas.join(', ') : '(none)'}`,
      `- excludeNodeIds: ${filters.nodeIds.length ? filters.nodeIds.join(', ') : '(none)'}`,
      `- passNodeIds: ${filters.passNodeIds.length ? filters.passNodeIds.join(', ') : '(none)'}`,
      `- classification: ${classification}`,
    ].join('\n');
    let parsed: z.ZodSafeParseResult<string> | undefined;
    let rejectReason = '';
    for (let attempt = 1; attempt <= DISCOVERY_SUMMARY_COMPOSE_ATTEMPTS; attempt++) {
      const prompt = buildDiscoverySummaryComposePrompt(
        lastDiscoveryQuestion,
        lastDiscoveryAnswer,
        contractSummary,
        attempt === 1 ? undefined : rejectReason,
      );
      const composed = await executeInstructionPlan(model, compileInstructionPlan({
        kind: 'text',
        phase: 'compose',
        system: DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT,
        facts: explorationFacts(analysisMode, targetColumns, {
          classification,
          memorySections: ['discovery_question', 'discovery_answer', 'approved_contract'],
        }),
        messages: [modelUserMessage(prompt)],
        signal,
      }));
      parsed = DiscoverySummarySchema.safeParse(composed);
      if (parsed.success) break;
      rejectReason = parsed.error.issues.map((issue: z.core.$ZodIssue) => issue.message).join('; ');
      logger?.debug(`[AI] [DiscoveryHandoff] attempt=${attempt} rejected reason=${sanitizeForLog(rejectReason)}`);
    }
    if (!parsed?.success) {
      logger?.debug('[AI] [DiscoveryHandoff] status=degraded reason=invalid_summary_after_retry');
      return undefined;
    }
    logger?.debug(`[AI] [DiscoveryHandoff] status=composed chars=${parsed.data.length}`);
    return parsed.data;
  } catch (err) {
    if (signal?.aborted) throw err;
    logger?.error('[AI] [DiscoveryHandoff] compose failed unexpectedly', err);
    return undefined;
  }
}
