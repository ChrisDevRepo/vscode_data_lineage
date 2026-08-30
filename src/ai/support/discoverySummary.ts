/**
 * Composes the discovery-to-exploration handoff memo — the one-shot, no-tool LM round that turns
 * the user's discovery Q/A into the `<discovery_summary>` stable-prefix field every later hop and
 * synthesis prompt reads as established fact.
 *
 * @remarks
 * Called once per reviewable exploration proposal, at proposal-build time
 * ({@link import('../tools/handlers/startExploration')}), never at approval. The composed text is
 * cached on the revision-bound proposal and shown verbatim at the bottom of the native approval
 * card; approval reuses that exact cached string via `NavigationEngine.setDiscoverySummary`
 * rather than recomposing it.
 */
import { z } from 'zod';
import type { ModelPort } from '../model/modelPort';
import { modelUserMessage } from '../model/modelPort';
import { compileInstructionPlan, executeInstructionPlan } from '../agent/instructionPlan';
import { explorationFacts } from '../agent/graph';
import { buildDiscoverySummaryComposePrompt } from '../prompting/prompts';
import type { NavigationEngine } from '../sm/smBase';
import type { ClassificationValue } from '../session/classification';
import { sanitizeForLog, type Logger } from '../../utils/log';

/** Validated boundary for the optional one-shot discovery-to-exploration memo. */
// Nonblank only — model-authored content is never length-rejected (R006). Brevity (2–4 sentences)
// is a prompt target, not a hard cap; the memo's length legitimately scales with the analysis it
// summarizes.
const DiscoverySummarySchema = z.string().trim().min(1);

// One mechanical re-ask on a rejected compose reply (empty output) — mirrors the reject-with-hint
// self-correction convention used at every other Zod boundary in this pipeline. Not a policy cap:
// a single retry of a one-shot, no-tool text round.
const DISCOVERY_SUMMARY_COMPOSE_ATTEMPTS = 2;

/**
 * @remarks
 * Compose is otherwise the only model call in the pipeline with no system key on the wire — the
 * memo it produces rides every later hop's stable prefix as established fact, so grounding and
 * formatting instructions belong at the system layer like every other stage.
 */
export const DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT = [
  'You are the @lineage assistant in the Data Lineage Viz VS Code extension, composing one internal memo for your own later hops — no user reads it.',
  'Every clause must come from the supplied <original_question> and <discovery_answer>, because later hops treat this memo as established fact.',
  'Plain prose only: no headings, bullets, or diagrams.',
].join('\n');

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
 * @returns The composed memo, or `undefined` when it should be omitted.
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
    const composePrompt = buildDiscoverySummaryComposePrompt(
      lastDiscoveryQuestion,
      lastDiscoveryAnswer,
      contractSummary,
    );
    let parsed: z.ZodSafeParseResult<string> | undefined;
    let rejectReason = '';
    for (let attempt = 1; attempt <= DISCOVERY_SUMMARY_COMPOSE_ATTEMPTS; attempt++) {
      // Structural reject-with-hint retry: feeds the exact Zod issue back, same convention as
      // every other self-correcting boundary in this pipeline — not new prompt wording/tuning.
      const prompt = attempt === 1
        ? composePrompt
        : `${composePrompt}\n\n## Retry — previous reply rejected\nReason: ${rejectReason}\nReply again as text only: ONE paragraph, 2-4 sentences.`;
      const composed = await executeInstructionPlan(model, compileInstructionPlan({
        kind: 'text',
        phase: 'compose',
        system: DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT,
        // Compose folds three inputs into the memo: the discovery Q/A and the approved contract summary,
        // declared inline at this — the sole — assembly site.
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
    // Re-throw on abort so the caller can surface a clean cancel; other errors are non-fatal.
    if (signal?.aborted) throw err;
    logger?.error('[AI] [DiscoveryHandoff] compose failed unexpectedly', err);
    return undefined;
  }
}
