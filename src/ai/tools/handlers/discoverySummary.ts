/** Composes the discovery-to-exploration handoff memo — the one-shot, no-tool LM round that turns the user's discovery Q/A into the `<discovery_summary>` stable-prefix field every later hop and synthesis prompt reads as established fact. */
import type { ModelPort } from '../../model/modelPort';
import { modelUserMessage } from '../../model/modelPort';
import {
  compileInstructionPlan,
  executeInstructionPlan,
  explorationFacts,
} from '../../agent/instructionPlan';
import {
  buildDiscoverySummaryComposePrompt,
  DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT,
  DISCOVERY_SUMMARY_EMPTY_REASON,
} from '../../prompting/prompts';
import type { NavigationEngine } from '../../sm/smBase';
import type { ClassificationValue } from '../../session/classification';
import { sanitizeForLog, type Logger } from '../../../utils/log';

/** One mechanical re-ask when composition returns no text. */
const DISCOVERY_SUMMARY_COMPOSE_ATTEMPTS = 2;

/** Composes the memo, or returns `undefined` on an ordinary degrade (rejected output after retry, or a non-abort provider failure) — the caller shows the approval card without a memo rather than blocking or failing an otherwise valid proposal. */
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
    const targetColumns =
      analysisMode === 'ct'
        ? (engine.currentTargetColumns ?? undefined)
        : undefined;
    const contractSummary = [
      `- origin: ${engine.currentOrigin ?? '(unset)'}`,
      `- scope: ${scope.scopeCount} nodes`,
      `- direction: ${engine.currentDirection}`,
      `- analysisMode: ${analysisMode}`,
      ...(analysisMode === 'ct'
        ? [`- targetColumns: ${(targetColumns ?? []).join(', ')}`]
        : []),
      `- excludeTypes: ${filters.types.length ? filters.types.join(', ') : '(none)'}`,
      `- excludeSchemas: ${filters.schemas.length ? filters.schemas.join(', ') : '(none)'}`,
      `- excludeNodeIds: ${filters.nodeIds.length ? filters.nodeIds.join(', ') : '(none)'}`,
      `- passNodeIds: ${filters.passNodeIds.length ? filters.passNodeIds.join(', ') : '(none)'}`,
      `- classification: ${classification}`,
    ].join('\n');
    let summary = '';
    let rejectReason = '';
    for (
      let attempt = 1;
      attempt <= DISCOVERY_SUMMARY_COMPOSE_ATTEMPTS;
      attempt++
    ) {
      const prompt = buildDiscoverySummaryComposePrompt(
        lastDiscoveryQuestion,
        lastDiscoveryAnswer,
        contractSummary,
        attempt === 1 ? undefined : rejectReason,
      );
      const composed = await executeInstructionPlan(
        model,
        compileInstructionPlan({
          kind: 'text',
          phase: 'compose',
          system: DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT,
          facts: explorationFacts(analysisMode, targetColumns, {
            classification,
            memorySections: [
              'discovery_question',
              'discovery_answer',
              'approved_contract',
            ],
          }),
          messages: [modelUserMessage(prompt)],
          signal,
        }),
      );
      summary = composed.trim();
      if (summary) break;
      rejectReason = DISCOVERY_SUMMARY_EMPTY_REASON;
      logger?.debug(
        `[AI] [DiscoveryHandoff] attempt=${attempt} rejected reason=${sanitizeForLog(rejectReason)}`,
      );
    }
    if (!summary) {
      logger?.debug(
        '[AI] [DiscoveryHandoff] status=degraded reason=invalid_summary_after_retry',
      );
      return undefined;
    }
    logger?.debug(
      `[AI] [DiscoveryHandoff] status=composed chars=${summary.length}`,
    );
    return summary;
  } catch (err) {
    if (signal?.aborted) throw err;
    logger?.error('[AI] [DiscoveryHandoff] compose failed unexpectedly', err);
    return undefined;
  }
}
