/**
 * Executes the approval-gated `lineage_start_exploration` lifecycle.
 *
 * @remarks
 * Proposal validation and preview construction stay local to this handler.
 * Turn-lease validation and effect serialization remain in the registry wrapper.
 */
import { NavigationEngine } from '../../sm/smBase';
import { sameExplorationProposal } from '../../session/session';
import { DEFAULT_EXPLORATION_QUESTION, type DepthIntent, type NavigationInitParams } from '../../sm/smTypes';
import { depthSidesDiffer, directionFromDepth } from '../../../engine/shared/explorationDepthContract';
import { sanitizeForLog, trunc } from '../../../utils/log';
import { schemaKey } from '../../../utils/sql';
import { StartExplorationInputSchema } from '../../tools/toolSchemas';
import { PendingGateSchema } from '../../session/sessionPhase';
import { renderScopeSummaryMd } from '../../prompting/scopeSummaryRenderer';
import { redactMissionBriefForLog } from '../../support/missionBriefDiagnostics';
import { toEngineLog } from '../../support/engineLog';
import { isCancellationOutcome } from '../../support/cancellation';
import {
  buildStartExplorationReject,
  evaluateBbTargetColumnsRule,
  evaluateAlreadyStartedRule,
  evaluateParallelStartRule,
  evaluateSupplementPrereqRule,
  resolveCanonicalQuestion,
} from '../../interaction/rules/startExplorationRules';
import type { ToolServices } from './toolServices';
import { composeDiscoverySummaryText } from './discoverySummary';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { checkScopeAdmission } from '../../support/tokenBudget';
import { makeRejection } from '../../support/toolErrorEnvelope';

/** Validates an exploration proposal and either opens its approval gate or resumes an approved supplement. */
export async function executeStartExploration(input: unknown, s: ToolServices): Promise<string> {
    try {
      const loggedInput = redactMissionBriefForLog(input);
      const sess = s.getSession();
      const m = s.requireModel();
      const identifierKey = (value: string): string => schemaKey(value, m.identifierCaseSensitive);
      const g = s.requireGraph();

      const preCheckPrior = sess.stateMachine as NavigationEngine | null;
      const preCheckLive  = !!preCheckPrior && preCheckPrior.status !== 'complete';
      const isRefining = sess.pendingExploration !== null
        && sess.phase.kind === 'awaiting_gate';
      {
        const alreadyStarted = evaluateAlreadyStartedRule(
          preCheckLive,
          preCheckPrior?.sessionId === sess.id,
          isRefining,
        );
        if (alreadyStarted) {
          return s.logAndReturn('lineage_start_exploration', alreadyStarted, loggedInput);
        }
      }

      const parsed = StartExplorationInputSchema.safeParse(input);
      if (!parsed.success) {
        const rawObject = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
        return s.logAndReturn('lineage_start_exploration', buildStartExplorationReject(parsed.error, rawObject), loggedInput);
      }
      const data = parsed.data;
      if (data.mission_brief !== undefined) {
        s.logger.debug(`[Mission] provenance=tool_payload len=${data.mission_brief.length}`);
      }

      const applyFollowUpContext = (): void => {
        if (data.classification) sess.setClassification(data.classification);
        if (data.mission_brief !== undefined) sess.memory.setMissionBrief(data.mission_brief);
        const canonicalQuestion = resolveCanonicalQuestion({
          lastDiscoveryQuestion: sess.lastDiscoveryQuestion,
          currentTurnPrompt: sess.currentTurnPrompt,
          modelQuestion: data.question,
          pendingInitQuestion: undefined,
        });
        if (data.question && data.question !== canonicalQuestion) {
          s.logger.debug('[AI] [StartExploration] model question discarded — a higher-priority question source is in force (supplement)');
        }
        if (canonicalQuestion) sess.memory.setUserQuestion(canonicalQuestion);
      };

      if (data.supplement && !data.origin) {
        const priorEngine = sess.stateMachine as NavigationEngine | null;
        const supplementPrereq = evaluateSupplementPrereqRule(priorEngine?.status ?? null);
        if (supplementPrereq) {
          return s.logAndReturn('lineage_start_exploration', supplementPrereq, loggedInput);
        }
        if (!priorEngine) {
          throw new Error('[start_exploration] supplement prerequisite passed without a prior engine');
        }
        const supplementIds = data.supplement.nodeIds ?? [];
        const supplementScope = priorEngine.measureSupplementScope(supplementIds, data.supplement.chain);
        const supplementRefusal = checkScopeAdmission(s.budget, supplementScope);
        if (supplementRefusal) {
          s.logger.debug(`[ScopeBudget] supplement refused limit=${supplementRefusal.limit} nodes=${supplementScope.nodes} rounds=${supplementScope.rounds} columns=${supplementScope.columns}`);
          return s.logAndReturn('lineage_start_exploration', makeRejection({
            code: REJECTION_CODES.overActiveScopeBudget,
            reason: supplementRefusal.supplementText,
            detail: { limit: supplementRefusal.limit, nodes: supplementScope.nodes, rounds: supplementScope.rounds, columns: supplementScope.columns },
          }), loggedInput);
        }
        const res = priorEngine.supplementAgenda(supplementIds, [], data.supplement.chain);
        if ('code' in res) return s.logAndReturn('lineage_start_exploration', res, loggedInput);
        if (res.skippedDetails.length > 0) {
          s.logger.debug(`[${sess.id}] supplement skippedIds=[${sanitizeForLog(res.skippedDetails.map(d => `${d.nodeId}:${d.reason}`).join(','))}]`);
        }
        if (res.agendaed === 0 && res.contracted === 0) {
          s.logger.info(`[${sess.id}] [Phase] completed (supplement refused, nothing admitted) — nodeIds=${data.supplement.nodeIds?.length ?? 0} agendaed=0 contracted=0 skipped=${res.skipped}`);
          const unresolvedIds = res.skippedDetails.filter(skip => skip.reason === 'unresolved').map(skip => skip.nodeId);
          const borderSkips = res.skippedDetails.filter(skip => skip.reason !== 'unresolved');
          const hint = [
            'No id in this supplement was admitted into this trace (the rejection reason lists each id with its refusal), so there is nothing to explore. Do not resend this supplement.',
            ...(unresolvedIds.length > 0
              ? [`${unresolvedIds.join(', ')} ${unresolvedIds.length === 1 ? 'does' : 'do'} not resolve to an object in the loaded graph: call lineage_search_objects with each named identifier to resolve the canonical schema-qualified id before proposing it.`]
              : []),
            ...borderSkips.map(skip => skip.hint
              ?? `${skip.nodeId} is excluded by the approved scope: to analyse it, start a new lineage_start_exploration proposal (origin + scope, no supplement) that names it without that exclusion, for the user to approve at the confirm_sm_start gate.`),
          ].join(' ');
          return s.logAndReturn('lineage_start_exploration', makeRejection({
            code: REJECTION_CODES.supplementAllRefused,
            reason: `Supplement refused, nothing admitted: ${res.skippedDetails.map(skip => `${skip.nodeId} (${skip.reason})`).join(', ')}`,
            hint,
            detail: { skippedDetails: res.skippedDetails },
          }), loggedInput);
        }
        const admittedIds = supplementIds.filter(
          id => !res.skippedDetails.some(skip => identifierKey(skip.nodeId) === identifierKey(id)),
        );
        applyFollowUpContext();
        sess.enterExploring(s.turnEpoch(sess));
        s.logger.info(`[${sess.id}] [Phase] completed → exploring (supplement) — nodeIds=${data.supplement.nodeIds?.length ?? 0} agendaed=${res.agendaed} contracted=${res.contracted} skipped=${res.skipped}`);
        const hopCtx = priorEngine.getHopContext();
        return s.logAndReturn('lineage_start_exploration', { ok: true, supplement: res, admittedIds, ...hopCtx }, loggedInput);
      }

      if (data.proposalRevision !== undefined && !isRefining) {
        return s.logAndReturn('lineage_start_exploration', makeRejection({
          code: REJECTION_CODES.staleProposalRevision,
          hint: 'proposalRevision is valid only while refining the matching pending approval gate.',
        }), loggedInput);
      }
      if (isRefining && data.proposalRevision !== sess.pendingExploration!.revision) {
        return s.logAndReturn('lineage_start_exploration', makeRejection({
          code: REJECTION_CODES.staleProposalRevision,
          hint: `Refine proposal revision ${sess.pendingExploration!.revision}; do not reuse an older gate revision.`,
        }), loggedInput);
      }

      const parallelViolation = evaluateParallelStartRule(sess.startExplorationRoundId, sess.currentRoundId);
      if (parallelViolation && !isRefining) {
        return s.logAndReturn('lineage_start_exploration', parallelViolation, loggedInput);
      }
      if (sess.phase.kind === 'completed' && preCheckPrior && preCheckPrior.status === 'complete') {
        s.logger.debug(`[AI] [Proposal] completed result preserved during replacement review origin=${sanitizeForLog(data.origin ?? '')}`);
      }

      const activeFilter = isRefining
        ? structuredClone(sess.pendingExploration!.activeFilter)
        : s.buildActiveFilter(sess);

      const engineLog = toEngineLog(s.logger);
      const engine = new NavigationEngine(m, g, engineLog, { activeFilter }, sess.columnStore);

      engine.sessionId = sess.id;

      const pendingInit = sess.pendingExploration?.init;
      const listOr = (sent: readonly string[] | undefined, fallback: readonly string[] = []): string[] => [...(sent ?? fallback)];
      const excludeTypes = listOr(data.excludeTypes, pendingInit?.excludeTypes ?? engine.getGuiHiddenTypes());
      const excludeSchemas = listOr(data.excludeSchemas, pendingInit?.excludeSchemas ?? engine.getGuiHiddenSchemas());
      const excludeNodeIds = listOr(data.excludeNodeIds, pendingInit?.excludeNodeIds ?? engine.getGuiExcludedNodeIds());
      const passNodeIds = listOr(data.passNodeIds, pendingInit?.passNodeIds);
      const scopeNotes = listOr(data.scopeNotes, pendingInit?.scopeNotes);
      const refineOrigin = isRefining ? (data.origin ?? pendingInit?.origin ?? '') : (data.origin ?? '');
      const canonicalRefineQuestion = resolveCanonicalQuestion({
        lastDiscoveryQuestion: sess.lastDiscoveryQuestion,
        currentTurnPrompt: sess.currentTurnPrompt,
        modelQuestion: data.question,
        pendingInitQuestion: isRefining ? pendingInit?.question : undefined,
      });
      if (data.question && data.question !== canonicalRefineQuestion) {
        s.logger.debug('[AI] [StartExploration] model question discarded — a higher-priority question source is in force (refine)');
      }
      const refineQuestion = canonicalRefineQuestion ?? DEFAULT_EXPLORATION_QUESTION;
      const refineAnalysisMode = data.analysisMode ?? pendingInit?.analysisMode;
      const bbTargetConflict = refineAnalysisMode === 'bb'
        ? evaluateBbTargetColumnsRule(data.targetColumns)
        : null;
      if (bbTargetConflict) return s.logAndReturn('lineage_start_exploration', bbTargetConflict, loggedInput);
      const refineTargetColumns = refineAnalysisMode === 'ct'
        ? (data.targetColumns ?? (isRefining ? pendingInit?.targetColumns : undefined))
        : undefined;
      if (refineAnalysisMode === 'bb' && isRefining && pendingInit?.targetColumns?.length) {
        s.logger.debug(`[AI] [StartExploration] refine to BB drops proposal targetColumns cols=[${trunc(pendingInit.targetColumns.join(','), 120)}] origin=${sanitizeForLog(refineOrigin)}`);
      }
      const sameStringSet = (a?: string[], b?: string[]): boolean => {
        const norm = (v?: string[]): string => [...(v ?? [])].map(identifierKey).sort().join('\u0000');
        return norm(a) === norm(b);
      };
      const depthIntent = data.depth ?? pendingInit?.depthIntent;
      if (!depthIntent) {
        return s.logAndReturn('lineage_start_exploration', makeRejection({
          code: REJECTION_CODES.missingField,
          hint: 'depth is required for the exploration proposal: send levels and exactness for both upstream and downstream.',
        }), loggedInput);
      }
      const refineDirection = directionFromDepth(depthIntent);
      const sameDepthIntent = (a?: DepthIntent, b?: DepthIntent): boolean =>
        !!a && !!b && !depthSidesDiffer(a.upstream, b.upstream) && !depthSidesDiffer(a.downstream, b.downstream);
      const refineScopeChanged = isRefining && (
        identifierKey(refineOrigin) !== identifierKey(pendingInit?.origin ?? '')
        || refineAnalysisMode !== pendingInit?.analysisMode
        || !sameStringSet(refineTargetColumns, pendingInit?.targetColumns)
        || !sameDepthIntent(depthIntent, pendingInit?.depthIntent)
      );
      const missionBriefClearedOnScopeChange = isRefining
        && data.mission_brief === undefined
        && refineScopeChanged
        && !!pendingInit?.mission_brief;
      const refineMissionBrief = data.mission_brief !== undefined
        ? data.mission_brief
        : (isRefining && !refineScopeChanged ? pendingInit?.mission_brief : undefined);
      if (data.mission_brief === undefined && isRefining) {
        if (missionBriefClearedOnScopeChange) {
          s.logger.debug('[Mission] provenance=cleared_on_scope_change');
        } else if (refineMissionBrief !== undefined) {
          s.logger.debug(`[Mission] provenance=pending_proposal len=${refineMissionBrief.length}`);
        }
      }
      const proposalInit = {
        question: refineQuestion,
        origin: refineOrigin,
        analysisMode: refineAnalysisMode,
        targetColumns: refineTargetColumns,
        direction: refineDirection,
        depthIntent,
        excludeTypes,
        excludeSchemas,
        excludeNodeIds,
        passNodeIds,
        scopeNotes,
        mission_brief: refineMissionBrief,
      } satisfies NavigationInitParams;
      const initResult = engine.init(proposalInit);

      if ('code' in initResult) return s.logAndReturn('lineage_start_exploration', initResult, loggedInput);
      const classification = data.classification ?? sess.pendingExploration?.classification;
      if (!classification) {
        return s.logAndReturn('lineage_start_exploration', makeRejection({ code: REJECTION_CODES.missingField, hint: 'classification is required for the exploration proposal.' }), loggedInput);
      }
      engine.classification = classification;
      const summary = engine.getScopeSummary();

      const scopeMeasure = engine.measureAdmissionScope();
      const refusal = checkScopeAdmission(s.budget, scopeMeasure);
      if (refusal) {
        s.logger.debug(`[ScopeBudget] refused limit=${refusal.limit} origin=${engine.currentOrigin ?? data.origin} nodes=${scopeMeasure.nodes} rounds=${scopeMeasure.rounds} columns=${scopeMeasure.columns}`);
        return s.logAndReturn('lineage_start_exploration', makeRejection({
          code: REJECTION_CODES.overActiveScopeBudget,
          reason: isRefining ? refusal.refineText : refusal.text,
          detail: { limit: refusal.limit, nodes: scopeMeasure.nodes, rounds: scopeMeasure.rounds, columns: scopeMeasure.columns },
        }), loggedInput);
      }

      const nextProposal = {
        init: proposalInit,
        classification,
        activeFilter,
        summary,
      };
      if (isRefining && sess.pendingExploration && sameExplorationProposal(nextProposal, sess.pendingExploration)) {
        s.logger.debug(`[AI] [Proposal] no-op refine rejected revision=${sess.pendingExploration.revision}`);
        return s.logAndReturn('lineage_start_exploration', makeRejection({
          code: 'no_op_refine',
          hint: 'The refinement did not change the reviewed proposal. Apply at least one requested scope, mode, classification, column, or filter change; if the request needs no change to the plan, reply to the user in text instead.',
        }), loggedInput);
      }
      const stored = sess.storePendingExploration(nextProposal, s.turnEpoch(sess));
      if (stored.kind !== 'accepted') {
        return s.logAndReturn('lineage_start_exploration', makeRejection({ code: REJECTION_CODES.staleTurn, reason: 'The turn no longer owns this session; the proposal was not stored.' }), loggedInput);
      }
      sess.startExplorationRoundId = sess.currentRoundId;
      const proposalRevision = sess.pendingExploration!.revision;
      s.logger.debug(`[AI] [Proposal] revision=${proposalRevision} origin=${sanitizeForLog(refineOrigin)} direction=${refineDirection} depth=${sanitizeForLog(JSON.stringify(depthIntent))}`);

      const classes = ['sliding_memory'];
      const baseDetail = renderScopeSummaryMd(summary, proposalRevision, classification);
      let discoverySummary: string | undefined;
      if (sess.lastDiscoveryQuestion && sess.lastDiscoveryAnswer && s.textModel) {
        discoverySummary = await composeDiscoverySummaryText(
          s.textModel,
          s.signal,
          s.logger,
          sess.lastDiscoveryQuestion,
          sess.lastDiscoveryAnswer,
          classification,
          engine,
        );
        if (discoverySummary) {
          const attached = sess.attachDiscoverySummary(proposalRevision, discoverySummary, s.turnEpoch(sess));
          if (attached.kind !== 'accepted') discoverySummary = undefined;
        }
      }
      const detail = discoverySummary ? `${baseDetail}\n\n${discoverySummary}` : baseDetail;
      s.logger.debug(
        `[ScopeEstimate] origin=${engine.currentOrigin ?? data.origin} ` +
        `scope_nodes=${summary.scopeCount} ` +
        `estimated_ddl_tokens=${summary.estimatedDdlTokens} ` +
        `estimated_ddl_chars=${summary.estimatedDdlChars}`
      );

      const gate = PendingGateSchema.parse({
        gate: 'confirm_sm_start',
        classes,
        nodeIds: [],
        detail,
        proposalRevision,
      });
      const missionBriefClearedNote = missionBriefClearedOnScopeChange
        ? ' mission_brief from the previous revision was not kept because the scope changed; send mission_brief to restate it.'
        : '';
      const hint = (isRefining
        ? 'Refine round — gate re-emitted. Wait for the user to Approve, Cancel, or Refine again.'
        : 'Tool paused — awaiting user confirmation before the first hop.')
        + missionBriefClearedNote;
      return s.logAndReturn('lineage_start_exploration', makeRejection({
        code: REJECTION_CODES.actionRequired,
        reason: gate.detail || undefined,
        hint,
        detail: gate,
      }), loggedInput);
    } catch (err) {
      if (isCancellationOutcome(err, s.signal)) throw err;
      return s.toolError('start_exploration', err);
    }
}
