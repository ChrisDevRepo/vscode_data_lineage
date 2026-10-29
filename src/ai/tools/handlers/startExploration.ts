/** Executes the approval-gated `lineage_start_exploration` lifecycle. */
import { NavigationEngine } from '../../sm/smBase';
import { sameExplorationProposal } from '../../session/session';
import { DEFAULT_EXPLORATION_QUESTION, type DepthIntent, type NavigationInitParams } from '../../sm/smTypes';
import { depthSidesDiffer, directionFromDepth } from '../../../engine/shared/explorationDepthContract';
import { sanitizeForLog, trunc } from '../../../utils/log';
import { schemaKey } from '../../../utils/sql';
import { StartExplorationInputSchema, startAdmissionFacts, startExplorationSchemaForState } from '../../tools/toolSchemas';
import { renderProposalDetailMd } from '../../prompting/scopeSummaryRenderer';
import { redactMissionBriefForLog } from '../../support/missionBriefDiagnostics';
import { toEngineLog } from '../../support/engineLog';
import { isCancellationOutcome } from '../../support/cancellation';
import { ingestToolInput, toolInputReceipt } from '../../support/toolIngestion';
import {
  inspectTargetColumns,
  inspectStartReferences,
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
import { at, makeRejection } from '../../support/toolErrorEnvelope';

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
      const beforeRevision = sess.pendingExploration?.revision;
      const receipt = toolInputReceipt.getStore();
      const admission = startAdmissionFacts();
      const outcome = ingestToolInput<typeof StartExplorationInputSchema, Promise<string>>({ input, schema: startExplorationSchemaForState(isRefining),
        context: receipt?.context ?? JSON.stringify([sess.turnEpoch, sess.phase.kind, beforeRevision]), facts: admission.facts,
        draft: receipt?.generation !== undefined ? sess.startExplorationDraft : undefined,
        log: line => s.logger.debug(line),
        committed: () => sess.pendingExploration?.revision !== beforeRevision,
        rejected: problem => { if (problem.code === REJECTION_CODES.overActiveScopeBudget) sess.signalControl({ kind: 'refused', reason: problem.reason }); },
        inspect: view => {
      const parsed = view.parsed;
      const raw = admission.input();
      const supplied = (field: string) => raw !== undefined && Object.prototype.hasOwnProperty.call(raw, field);
      const annotations = admission.annotations;
      view.add(evaluateAlreadyStartedRule(preCheckLive, preCheckPrior?.sessionId === sess.id, isRefining));
      if (supplied('supplement')) view.add(makeRejection({ code: REJECTION_CODES.freshProposalRequired,
        reason: 'Additional SQL requires a new exploration with its own approval card: a fresh proposal with origin and scope.', errors: at('fresh_proposal', ['supplement']) }));
      if (!isRefining) view.add(evaluateParallelStartRule(sess.startExplorationRoundId, sess.currentRoundId));
      if (raw && (!supplied('proposalRevision') || annotations.proposalRevision !== undefined)
        && ((!isRefining && annotations.proposalRevision !== undefined)
          || (isRefining && annotations.proposalRevision !== sess.pendingExploration!.revision))) {
        view.add(makeRejection({ code: REJECTION_CODES.staleProposalRevision,
          errors: at('stale_revision', ['proposalRevision'], isRefining ? [String(sess.pendingExploration!.revision)] : undefined) }));
      }
      const activeFilter = isRefining ? structuredClone(sess.pendingExploration!.activeFilter) : s.buildActiveFilter(sess);
      const engine = new NavigationEngine(m, g, toEngineLog(s.logger), { activeFilter }, sess.columnStore);
      engine.sessionId = sess.id;
      const pendingInit = isRefining ? sess.pendingExploration!.init : undefined;
      const referenceList = (field: 'excludeNodeIds' | 'passNodeIds', fallback: readonly string[]) => supplied(field)
        ? new Map([...admission.references].filter(([path]) => path.startsWith(`/${field}/`)).map(([path, value]) => [Number(path.split('/')[2]), value]))
        : fallback;
      const nodes = buildNodeMap(m);
      const referenceInput = {
        origin: annotations.origin ?? (!supplied('origin') && isRefining ? pendingInit?.origin : undefined),
        excludeNodeIds: referenceList('excludeNodeIds', pendingInit?.excludeNodeIds ?? engine.getGuiExcludedNodeIds()),
        passNodeIds: referenceList('passNodeIds', pendingInit?.passNodeIds ?? []),
      };
      const references = inspectStartReferences(referenceInput, value => resolveModelNodeId(value, nodes, m.identifierCaseSensitive));
      view.add(references.rejection);
      const mode = annotations.analysisMode ?? (!supplied('analysisMode') && isRefining ? pendingInit?.analysisMode : undefined);
      const columns = references.originId && mode === 'ct'
        ? inspectTargetColumns(references.originId, (getNodeColumns(references.originId, nodes, sess.columnStore) ?? []).map(column => column.name),
          supplied('targetColumns') ? admission.targets : (pendingInit?.targetColumns ?? []), m.identifierCaseSensitive)
        : undefined;
      view.add(columns?.rejection);
      const scope = admission.scope();
      if (!scope || !references.originId || references.rejection || columns?.rejection) return undefined;
      const data = { ...scope, ...annotations };
      if (data.mission_brief !== undefined) s.logger.debug(`[Mission] provenance=tool_payload len=${data.mission_brief.length}`);

      if (sess.phase.kind === 'completed' && preCheckPrior && preCheckPrior.status === 'complete') {
        s.logger.debug(`[AI] [Proposal] completed result preserved during replacement review origin=${sanitizeForLog(data.origin ?? '')}`);
      }

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
      const depthIntent = data.depth ?? pendingInit!.depthIntent;
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
      const initResult = engine.init(proposalInit, { references, columns });

      if ('code' in initResult) { view.add(initResult); return undefined; }
      const scopeMeasure = engine.measureAdmissionScope();
      const refusal = checkScopeAdmission(s.budget, scopeMeasure);
      if (refusal) {
        s.logger.debug(`[ScopeBudget] refused limit=${refusal.limit} origin=${engine.currentOrigin ?? data.origin} nodes=${scopeMeasure.nodes} rounds=${scopeMeasure.rounds} columns=${scopeMeasure.columns}`);
        const reason = isRefining ? refusal.refineText : refusal.text;
        view.add(makeRejection({
          code: REJECTION_CODES.overActiveScopeBudget,
          reason,
          errors: at('over_budget'),
          detail: { limit: refusal.limit, nodes: scopeMeasure.nodes, rounds: scopeMeasure.rounds, columns: scopeMeasure.columns },
        })); return undefined;
      }

      if (!parsed.success) return undefined;
      const classification = data.classification ?? sess.pendingExploration!.classification;
      engine.classification = classification;
      const summary = engine.getScopeSummary();

      const nextProposal = {
        init: proposalInit,
        classification,
        activeFilter,
        summary,
      };
      if (isRefining && sess.pendingExploration && sameExplorationProposal(nextProposal, sess.pendingExploration)) {
        s.logger.debug(`[AI] [Proposal] no-op refine rejected revision=${sess.pendingExploration.revision}`);
        view.add(makeRejection({ code: REJECTION_CODES.noOpRefine, errors: at('no_op_refine') }));
      }
      return async () => {
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
      };
        },
      });
      return typeof outcome === 'object' && !(outcome instanceof Promise)
        ? s.logAndReturn('lineage_start_exploration', outcome, loggedInput) : await outcome;
    } catch (err) {
      if (isCancellationOutcome(err, s.signal)) throw err;
      return s.toolError('start_exploration', err);
    }
}
