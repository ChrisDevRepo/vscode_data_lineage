/** Executes the approval-gated `lineage_start_exploration` lifecycle. */
import { NavigationEngine } from '../../sm/smBase';
import { sameExplorationProposal } from '../../session/session';
import { DEFAULT_EXPLORATION_QUESTION, type DepthIntent, type NavigationInitParams } from '../../sm/smTypes';
import { depthSidesDiffer, directionFromDepth } from '../../../engine/shared/explorationDepthContract';
import { sanitizeForLog, trunc } from '../../../utils/log';
import { schemaKey } from '../../../utils/sql';
import { StartExplorationInputSchema } from '../../tools/toolSchemas';
import { renderProposalDetailMd } from '../../prompting/scopeSummaryRenderer';
import { redactMissionBriefForLog } from '../../support/missionBriefDiagnostics';
import { toEngineLog } from '../../support/engineLog';
import { isCancellationOutcome } from '../../support/cancellation';
import {
  buildStartExplorationReject,
  inspectTargetColumns,
  evaluateBbTargetColumnsRule,
  evaluateAlreadyStartedRule,
  evaluateParallelStartRule,
  resolveCanonicalQuestion,
} from '../../interaction/rules/startExplorationRules';
import type { ToolServices } from './toolServices';
import { composeDiscoverySummaryText } from './discoverySummary';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { checkScopeAdmission } from '../../support/tokenBudget';
import { buildNodeMap, getNodeColumns } from '../../support/graphUtils';
import { resolveModelNodeId } from '../../support/modelReferences';
import { at, combineToolRejections, makeRejection } from '../../support/toolErrorEnvelope';

/** Validates a fresh or refined exploration proposal and opens its approval gate. */
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

      // A completed answer grants no consent to read new SQL. Legacy callers receive the same
      // fresh-proposal route the model is offered; the prior result and memory stay untouched.
      if (input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'supplement')) {
        return s.logAndReturn('lineage_start_exploration', makeRejection({
          code: REJECTION_CODES.freshProposalRequired,
          reason: 'Additional SQL requires a new exploration with its own approval card: a fresh proposal with origin and scope.',
          errors: at('fresh_proposal', ['supplement']),
        }), loggedInput);
      }

      const parsed = StartExplorationInputSchema.safeParse(input);
      if (!parsed.success) {
        const rawObject = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
        const rejections = [buildStartExplorationReject(parsed.error, rawObject)];
        const origin = StartExplorationInputSchema.shape.origin.safeParse(rawObject.origin);
        const mode = StartExplorationInputSchema.shape.analysisMode.safeParse(rawObject.analysisMode);
        const targets = StartExplorationInputSchema.shape.targetColumns.safeParse(rawObject.targetColumns);
        if (origin.success && origin.data !== undefined && mode.success && mode.data === 'ct' && targets.success && targets.data !== undefined) {
          const nodes = buildNodeMap(m);
          const id = resolveModelNodeId(origin.data, nodes, m.identifierCaseSensitive);
          if (id) {
            const { rejection } = inspectTargetColumns(id, (getNodeColumns(id, nodes, sess.columnStore) ?? []).map(column => column.name), targets.data, m.identifierCaseSensitive);
            if (rejection) rejections.push(rejection);
          }
        }
        return s.logAndReturn('lineage_start_exploration', rejections.length > 1 ? combineToolRejections(rejections) : rejections[0], loggedInput);
      }
      const data = parsed.data;
      if (data.mission_brief !== undefined) {
        s.logger.debug(`[Mission] provenance=tool_payload len=${data.mission_brief.length}`);
      }

      if (data.proposalRevision !== undefined && !isRefining) {
        return s.logAndReturn('lineage_start_exploration', makeRejection({
          code: REJECTION_CODES.staleProposalRevision, reason: 'No approval gate is pending to refine.', errors: at('stale_revision', ['proposalRevision']),
        }), loggedInput);
      }
      if (isRefining && data.proposalRevision !== sess.pendingExploration!.revision) {
        return s.logAndReturn('lineage_start_exploration', makeRejection({
          code: REJECTION_CODES.staleProposalRevision, reason: 'Not the pending gate revision.', errors: at('stale_revision', ['proposalRevision'], [String(sess.pendingExploration!.revision)]),
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
        return s.logAndReturn('lineage_start_exploration', makeRejection({ code: REJECTION_CODES.missingField, errors: at('missing', ['depth']) }), loggedInput);
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
        return s.logAndReturn('lineage_start_exploration', makeRejection({ code: REJECTION_CODES.missingField, errors: at('missing', ['classification']) }), loggedInput);
      }
      engine.classification = classification;
      const summary = engine.getScopeSummary();

      const scopeMeasure = engine.measureAdmissionScope();
      const refusal = checkScopeAdmission(s.budget, scopeMeasure);
      if (refusal) {
        s.logger.debug(`[ScopeBudget] refused limit=${refusal.limit} origin=${engine.currentOrigin ?? data.origin} nodes=${scopeMeasure.nodes} rounds=${scopeMeasure.rounds} columns=${scopeMeasure.columns}`);
        const reason = isRefining ? refusal.refineText : refusal.text;
        sess.signalControl({ kind: 'refused', reason });
        return s.logAndReturn('lineage_start_exploration', makeRejection({
          code: REJECTION_CODES.overActiveScopeBudget,
          reason,
          errors: at('over_budget'),
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
        return s.logAndReturn('lineage_start_exploration', makeRejection({ code: REJECTION_CODES.noOpRefine, errors: at('no_op_refine') }), loggedInput);
      }
      const stored = sess.storePendingExploration(nextProposal, s.turnEpoch(sess));
      if (stored.kind !== 'accepted') {
        return s.logAndReturn('lineage_start_exploration', makeRejection({ code: REJECTION_CODES.staleTurn, reason: 'The turn no longer owns this session; the proposal was not stored.', errors: at('backend_fault') }), loggedInput);
      }
      sess.startExplorationRoundId = sess.currentRoundId;
      let proposal = sess.pendingExploration!;
      const proposalRevision = proposal.revision;
      s.logger.debug(`[AI] [Proposal] revision=${proposalRevision} origin=${sanitizeForLog(refineOrigin)} direction=${refineDirection} depth=${sanitizeForLog(JSON.stringify(depthIntent))}`);

      if (sess.lastDiscoveryQuestion && sess.lastDiscoveryAnswer && s.textModel) {
        const discoverySummary = await composeDiscoverySummaryText(
          s.textModel,
          s.signal,
          s.logger,
          sess.lastDiscoveryQuestion,
          sess.lastDiscoveryAnswer,
          classification,
          engine,
        );
        if (discoverySummary && sess.attachDiscoverySummary(proposalRevision, discoverySummary, s.turnEpoch(sess)).kind === 'accepted') {
          proposal = { ...proposal, discoverySummary };
        }
      }
      const detail = renderProposalDetailMd(proposal);
      s.logger.debug(
        `[ScopeEstimate] origin=${engine.currentOrigin ?? data.origin} ` +
        `scope_nodes=${summary.scopeCount} ` +
        `estimated_ddl_tokens=${summary.estimatedDdlTokens} ` +
        `estimated_ddl_chars=${summary.estimatedDdlChars}`
      );

      sess.signalControl({ kind: 'gate' });
      return s.logAndReturn('lineage_start_exploration', makeRejection({
        code: REJECTION_CODES.actionRequired,
        reason: detail || undefined,
        errors: [...at('awaiting_approval'), ...(missionBriefClearedOnScopeChange ? at('missing', ['mission_brief']) : [])],
        detail: { gate: 'confirm_sm_start', proposalRevision },
      }), loggedInput);
    } catch (err) {
      if (isCancellationOutcome(err, s.signal)) throw err;
      return s.toolError('start_exploration', err);
    }
}
