/**
 * Executes the approval-gated `lineage_start_exploration` lifecycle.
 *
 * @remarks
 * Proposal validation and preview construction stay local to this handler.
 * Turn-lease validation and effect serialization remain in the registry wrapper.
 */
import * as vscode from 'vscode';
import { DEFAULT_MAX_ROUNDS } from '../../core/agentCore';
import { NavigationEngine } from '../../sm/smBase';
import { sameExplorationProposal } from '../../session/session';
import {
  DEFAULT_EXPLORATION_QUESTION,
  resolveDepthIntent,
  type DepthIntent,
} from '../../sm/smTypes';
import { sanitizeForLog, trunc } from '../../../utils/log';
import { StartExplorationInputSchema } from '../../tools/toolSchemas';
import { PendingGateSchema } from '../../session/sessionPhase';
import { CLASSIFICATION_LABEL } from '../../session/classification';
import { renderScopeSummaryMd } from '../../prompting/scopeSummaryRenderer';
import {
  normalizeStartExplorationInput,
  type StartExplorationInputObject,
} from '../../support/inputNormalization';
import { redactMissionBriefForLog } from '../../support/missionBriefDiagnostics';
import { toEngineLog } from '../../support/engineLog';
import { isCancellationOutcome } from '../../support/cancellation';
import {
  buildStartExplorationReject,
  evaluateBbTargetColumnsRule,
  evaluateAlreadyStartedRule,
  evaluateParallelStartRule,
  evaluateScopeBudgetRule,
  evaluateSupplementPrereqRule,
  resolveCanonicalQuestion,
} from '../../interaction/rules/startExplorationRules';
import type { ToolServices } from './toolServices';
import { AI_MAX_SCOPE_NODE_IDS } from '../../../engine/shared/bridgeContract';
import { composeDiscoverySummaryText } from '../../support/discoverySummary';

/** Reserve 30% of maxRounds as a buffer for retries and synthesis — never start SM on a scope that fills the whole budget. */
const SAFETY_RATIO = 0.7;

/**
 * Validates an exploration proposal and either opens its approval gate or resumes an approved supplement.
 *
 * @param input - Raw model-supplied tool input.
 * @param s - Host capabilities for the active tool session.
 * @returns The structured proposal, gate, hop context, or rejection envelope.
 */
export async function executeStartExploration(input: unknown, s: ToolServices): Promise<string> {
    try {
      const loggedInput = redactMissionBriefForLog(input);
      const sess = s.getSession();
      const m = s.requireModel();
      const g = s.requireGraph();

      // Pre-Zod duplicate-start guard keeps live explorations from retrying with alternate params.
      const preCheckPrior = sess.stateMachine as NavigationEngine | null;
      const preCheckLive  = !!preCheckPrior && preCheckPrior.status !== 'complete';
      // Computed once and reused verbatim later: nothing between here and the fresh-exploration
      // path below writes sess.phase/pendingExploration (the supplement branch returns early).
      const isRefining = sess.pendingExploration !== null
        && sess.phase.kind === 'awaiting_gate'
        && sess.phase.gate.gate === 'confirm_sm_start';
      {
        const alreadyStarted = evaluateAlreadyStartedRule(
          preCheckLive,
          preCheckPrior?.sessionId === sess.id,
          isRefining,
        );
        if (alreadyStarted) {
          return s.logAndReturn('start_exploration', alreadyStarted, loggedInput);
        }
      }

      const rawObject = input && typeof input === 'object' && !Array.isArray(input)
        ? input as StartExplorationInputObject
        : {};
      const explicitMode = rawObject.analysisMode === 'bb' || rawObject.analysisMode === 'ct'
        ? rawObject.analysisMode
        : undefined;
      const inheritedMode = isRefining ? sess.pendingExploration?.init.analysisMode : undefined;
      const normalizedStart = normalizeStartExplorationInput(rawObject, explicitMode ?? inheritedMode);
      for (const event of normalizedStart.normalizations) {
        s.logger.debug(`[AI] [StartExploration] normalized field=${event.field} reason=${event.reason} origin=${sanitizeForLog(typeof rawObject.origin === 'string' ? rawObject.origin : '')}`);
      }
      const parseInput = input && typeof input === 'object' && !Array.isArray(input)
        ? normalizedStart.input
        : input;
      const parsed = StartExplorationInputSchema.safeParse(parseInput);
      if (!parsed.success) {
        return s.logAndReturn('start_exploration', buildStartExplorationReject(parsed.error, normalizedStart.input), loggedInput);
      }
      const data = parsed.data;
      if (data.mission_brief !== undefined) {
        s.logger.debug(`[Mission] provenance=tool_payload len=${data.mission_brief.length}`);
      }

      // Supplements retain the completed engine while updating the follow-up mission context.
      // A rejected CT target list aborts the supplement before any context is applied — the
      // engine refuses object references as columns on every path, so the reject is surfaced
      // rather than swallowed.
      const applyFollowUpContext = (engine: NavigationEngine): { error: string; hint: string } | null => {
        if (data.analysisMode === 'ct' && data.targetColumns?.length) {
          const columnTargetReject = engine.setColumnTargets(data.targetColumns);
          if (columnTargetReject) return columnTargetReject;
        }
        if (data.classification) sess.setClassification(data.classification);
        if (data.mission_brief !== undefined) sess.memory.setMissionBrief(data.mission_brief);
        // User-authored text wins over the model's paraphrase for the canonical question.
        const canonicalQuestion = resolveCanonicalQuestion({
          lastDiscoveryQuestion: sess.lastDiscoveryQuestion,
          currentTurnPrompt: sess.currentTurnPrompt,
          modelQuestion: data.question,
          pendingInitQuestion: undefined,
        });
        if (canonicalQuestion) sess.memory.setUserQuestion(canonicalQuestion);
        return null;
      };

      // Supplement is origin-less by contract; an explicit origin starts a fresh exploration.
      if (data.supplement && !data.origin) {
        const priorEngine = sess.stateMachine as NavigationEngine | null;
        const supplementPrereq = evaluateSupplementPrereqRule(priorEngine?.status ?? null);
        if (supplementPrereq) {
          return s.logAndReturn('start_exploration', supplementPrereq, loggedInput);
        }
        if (!priorEngine) {
          return s.logAndReturn('start_exploration', {
            error: 'supplement_requires_complete_engine',
            hint: "supplement requires a completed prior exploration. Current engine status: none. Start a fresh exploration instead (omit the 'supplement' field, provide 'origin').",
          }, loggedInput);
        }
        const supplementIds = data.supplement.nodeIds ?? [];
        // Extend-then-supplement, the same ordering the approve gate uses: naming a node in a
        // follow-up is the consent that widens the allowlist to reach it. `supplementAgenda` stays a
        // side-effect-free reject, so without this step a schema-boundary lead was a dead end — the
        // target came straight back as `out_of_allowlist` with nothing on this path able to admit
        // it. Exclusions stay a hard wall.
        priorEngine.admitSupplementTargets(supplementIds);
        const res = priorEngine.supplementAgenda(supplementIds);
        if ('error' in res) return s.logAndReturn('start_exploration', res, loggedInput);
        const followUpReject = applyFollowUpContext(priorEngine);
        if (followUpReject) return s.logAndReturn('start_exploration', followUpReject, loggedInput);
        // Unguarded by design: tool dispatch runs synchronously inside the owning turn's graph-owned
        // generation attempt, so the live `turnEpoch` is always this turn's — the guard would always accept.
        sess.enterExploring(s.turnEpoch(sess));
        const skippedIdsSuffix = res.skippedDetails.length > 0
          ? ` skippedIds=[${res.skippedDetails.map(d => `${d.nodeId}:${d.reason}`).join(',')}]`
          : '';
        s.logger.info(`[${sess.id}] [Phase] completed → exploring (supplement) — nodeIds=${data.supplement.nodeIds?.length ?? 0} agendaed=${res.agendaed} contracted=${res.contracted} skipped=${res.skipped}${skippedIdsSuffix}`);
        const hopCtx = priorEngine.getHopContext();
        return s.logAndReturn('start_exploration', { ok: true, supplement: res, ...hopCtx }, loggedInput);
      }

      // Fresh exploration path: origin is required.
      if (!data.origin && data.proposalRevision === undefined) {
        return s.logAndReturn('start_exploration', {
          error: 'missing_field',
          hint: "Field 'origin' is required for a fresh exploration. Supply 'supplement' with nodeIds only when extending a completed prior exploration (follow-up phase).",
        }, loggedInput);
      }

      const prior = sess.stateMachine as NavigationEngine | null;
      const priorLive = !!prior && prior.status !== 'complete';

      // Refinement replaces the reviewable proposal. No active engine exists before approval.
      if (data.proposalRevision !== undefined && !isRefining) {
        return s.logAndReturn('start_exploration', {
          error: 'stale_proposal_revision',
          hint: 'proposalRevision is valid only while refining the matching pending approval gate.',
        }, loggedInput);
      }
      if (isRefining && data.proposalRevision !== sess.pendingExploration!.revision) {
        return s.logAndReturn('start_exploration', {
          error: 'stale_proposal_revision',
          hint: `Refine proposal revision ${sess.pendingExploration!.revision}; do not reuse an older gate revision.`,
        }, loggedInput);
      }

      const parallelViolation = evaluateParallelStartRule(sess.startExplorationRoundId, sess.currentRoundId);
      if (parallelViolation && !isRefining) {
        return s.logAndReturn('start_exploration', parallelViolation, loggedInput);
      }
      // A completed result remains authoritative while a fresh replacement is reviewed. The
      // existing engine/result/memory are replaced only by exact-revision approval; supplements
      // above remain the explicit no-gate continuation path.
      if (sess.phase.kind === 'completed' && prior && prior.status === 'complete') {
        s.logger.debug(`[AI] [Proposal] completed result preserved during replacement review origin=${sanitizeForLog(data.origin ?? '')}`);
      }
      if (priorLive && prior.sessionId && prior.sessionId !== sess.id) {
        sess.pendingUserNotice.add('A previous exploration was still running when you started this one. Its in-memory findings were discarded.');
        sess.resetExploration();
      } else if (priorLive) {
        const alreadyStarted = evaluateAlreadyStartedRule(
          priorLive,
          prior.sessionId === sess.id,
          isRefining,
        );
        if (alreadyStarted) return s.logAndReturn('start_exploration', alreadyStarted, loggedInput);
      }

      // A scope revision is a patch to the reviewed proposal, not a fresh read of mutable GUI state.
      const activeFilter = isRefining
        ? structuredClone(sess.pendingExploration!.activeFilter)
        : s.buildActiveFilter(sess);

      const engineLog = toEngineLog(s.logger);
      // Proposal preview uses an unpublished engine with isolated memory. It is discarded after
      // computing the scope summary; approval is the sole site that creates active engine state.
      // `classification` is intentionally left unset on this preview instance: it only reaches
      // getScopeSummary(), never a hop dispatch (the getHopContext() fall-through below is
      // unreachable for this path — phase/refine guards route here first), so
      // shouldPreserveTechContext() never runs against it. Its unset default (preserve tech
      // context) is the conservative choice, so an unreachable read would still be safe.
      const engine = new NavigationEngine(m, g, engineLog, { activeFilter }, sess.columnStore);

      engine.sessionId = sess.id;

      const pendingInit = sess.pendingExploration?.init;
      const stringArray = (v: unknown, fallback: string[] = []): string[] => v === undefined
        ? [...fallback]
        : Array.isArray(v) ? (v as unknown[]).filter((t): t is string => typeof t === 'string') : [];
      const excludeTypes = stringArray(data.excludeTypes, pendingInit?.excludeTypes);
      const excludeSchemas = stringArray(data.excludeSchemas, pendingInit?.excludeSchemas);
      const excludeNodeIds = stringArray(data.excludeNodeIds, pendingInit?.excludeNodeIds);
      const passNodeIds = stringArray(data.passNodeIds, pendingInit?.passNodeIds);
      // Mechanically preserved across refine rounds like every other omitted field: a scope change
      // must never silently drop a constraint the user already gave and confirmed.
      const scopeNotes = stringArray(data.scopeNotes, pendingInit?.scopeNotes);
      // Refine mechanically preserves omitted proposal fields; the model does not re-author them.
      const refineOrigin = isRefining ? (data.origin ?? pendingInit?.origin ?? '') : (data.origin ?? '');
      const refineDirection = data.direction ?? (isRefining ? pendingInit?.direction : 'bidirectional');
      // User-authored text wins over the model's paraphrase for the canonical question;
      // the model-supplied `question` and the refined proposal's retained question are fallbacks.
      const refineQuestion = resolveCanonicalQuestion({
        lastDiscoveryQuestion: sess.lastDiscoveryQuestion,
        currentTurnPrompt: sess.currentTurnPrompt,
        modelQuestion: data.question,
        pendingInitQuestion: isRefining ? pendingInit?.question : undefined,
      }) ?? DEFAULT_EXPLORATION_QUESTION;
      const refineMissionBrief = data.mission_brief !== undefined
        ? data.mission_brief
        : (isRefining ? pendingInit?.mission_brief : undefined);
      if (data.mission_brief === undefined && refineMissionBrief !== undefined) {
        s.logger.debug(`[Mission] provenance=pending_proposal len=${refineMissionBrief.length}`);
      }
      const refineAnalysisMode = data.analysisMode ?? (isRefining ? pendingInit?.analysisMode : 'bb');
      // Static Zod validation cannot know the prior mode inherited by a refine payload.
      const bbTargetConflict = refineAnalysisMode === 'bb'
        ? evaluateBbTargetColumnsRule(data.targetColumns)
        : null;
      if (bbTargetConflict) return s.logAndReturn('start_exploration', bbTargetConflict, loggedInput);
      // An explicit BB refine replaces CT-only snapshot columns after validation succeeds.
      const refineTargetColumns = refineAnalysisMode === 'ct'
        ? (data.targetColumns ?? (isRefining ? pendingInit?.targetColumns : undefined))
        : undefined;
      if (refineAnalysisMode === 'bb' && isRefining && pendingInit?.targetColumns?.length) {
        s.logger.debug(`[AI] [StartExploration] refine to BB drops proposal targetColumns cols=[${trunc(pendingInit.targetColumns.join(','), 120)}] origin=${sanitizeForLog(refineOrigin)}`);
      }
      const depthIntent: DepthIntent = data.depth === undefined && isRefining
        ? (pendingInit?.depthIntent ?? { kind: 'default_start' })
        : resolveDepthIntent(data.depth);

      const proposalInit = {
        question: refineQuestion || DEFAULT_EXPLORATION_QUESTION,
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
      } satisfies import('../../sm/smTypes').NavigationInitParams;
      const initResult = engine.init(proposalInit);

      // The preview engine is never published. Rejected proposals leave the prior proposal intact.
      if ('error' in initResult) return s.logAndReturn('start_exploration', initResult, loggedInput);
      const aiCfg = vscode.workspace.getConfiguration('dataLineageViz.ai');
      const maxRounds = aiCfg.get<number>('maxRounds', DEFAULT_MAX_ROUNDS);
      const safeMax = Math.max(1, Math.floor(maxRounds * SAFETY_RATIO));
      // Pathological breadth only: object lineage can fan out past the sliding-memory budget even
      // at a shallow depth (hub nodes). Recovery is structural narrowing / prune / ask-user — never
      // an engine-invented depth number. Depth intent stays AI-owned.
      const scopeViolation = evaluateScopeBudgetRule(initResult.scopeSize, safeMax, maxRounds);
      if (scopeViolation) {
        const scopeOrigin = engine.currentOrigin ?? data.origin;
        s.logger.debug(`[ScopeBudget] origin=${scopeOrigin} scope=${initResult.scopeSize} safe_max=${safeMax}`);
        return s.logAndReturn('start_exploration', scopeViolation, loggedInput);
      }

      const classification = data.classification ?? sess.pendingExploration?.classification;
      if (!classification) {
        return s.logAndReturn('start_exploration', { error: 'missing_field', hint: 'classification is required for the exploration proposal.' }, loggedInput);
      }
      // Native approval Markdown is the review surface, so every in-scope object must be visible.
      const summary = engine.getScopeSummary(AI_MAX_SCOPE_NODE_IDS);
      const nextProposal = {
        init: proposalInit,
        classification,
        activeFilter,
        summary,
      };
      if (isRefining && sess.pendingExploration && sameExplorationProposal(nextProposal, sess.pendingExploration)) {
        s.logger.debug(`[AI] [Proposal] no-op refine rejected revision=${sess.pendingExploration.revision}`);
        return s.logAndReturn('start_exploration', {
          error: 'no_op_refine',
          hint: 'The refinement did not change the reviewed proposal. Apply at least one requested scope, mode, classification, column, or filter change.',
        }, loggedInput);
      }
      const stored = sess.storePendingExploration(nextProposal, s.turnEpoch(sess));
      if (stored.kind !== 'accepted') {
        return s.logAndReturn('start_exploration', { error: 'stale_turn', hint: 'The proposal was not stored because this turn no longer owns the session.' }, loggedInput);
      }
      sess.startExplorationRoundId = sess.currentRoundId;
      s.logger.debug(`[AI] [Proposal] revision=${sess.pendingExploration!.revision} origin=${sanitizeForLog(refineOrigin)} direction=${refineDirection} depth=${sanitizeForLog(JSON.stringify(depthIntent))}`);

      // Discovery is content-blind: always gate before any analysis runs.
      // Refine path: re-emit the gate with the new tree so the loop continues.
      if (sess.phase.kind === 'idle' || sess.phase.kind === 'completed' || isRefining) {
        const isCt = !!engine.columnAspect;

        const classes = ['sliding_memory'];
        if (initResult.scopeSchemas) {
          const filterSet = new Set((activeFilter.schemas || []).map(schema => schema.toLowerCase()));
          for (const schema of initResult.scopeSchemas) {
            if (filterSet.size > 0 && !filterSet.has(schema.toLowerCase())) {
              classes.push(`schema:${schema.toLowerCase()}`);
            }
          }
        }

        const classLabel = CLASSIFICATION_LABEL[classification] + (isCt ? ' (Column Trace)' : '');
        const baseDetail = `${renderScopeSummaryMd(summary, sess.pendingExploration!.revision)}\n\n_Analysis: ${classLabel}_`;
        // Composed once per shown revision, never recomposed at approval — the same cached string
        // later rides verbatim into `NavigationEngine.setDiscoverySummary`. Missing discovery
        // context or a degraded compose just omits the memo; it never blocks the approval card.
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
            const attached = sess.attachDiscoverySummary(sess.pendingExploration!.revision, discoverySummary, s.turnEpoch(sess));
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
          proposalRevision: sess.pendingExploration!.revision,
        });
        const hint = isRefining
          ? 'Refine round — gate re-emitted. Wait for the user to Approve, Cancel, or Refine again.'
          : 'Tool paused — awaiting user confirmation before first hop. Hop context delivered for use after approval.';
        return s.logAndReturn('start_exploration', {
          error: 'action_required',
          ...gate,
          hint,
        }, loggedInput);
      }

      const hopResult = engine.getHopContext();
      return s.logAndReturn('start_exploration', { ...initResult, ...hopResult }, loggedInput);
    } catch (err) {
      // An abort thrown out of the discovery-summary compose call must reach the registry dispatcher
      // as a thrown cancellation, never a toolError envelope — the generic catch would otherwise
      // silently convert a user Stop into a normal `internal_error` result.
      if (isCancellationOutcome(err, s.signal)) throw err;
      return s.toolError('start_exploration', err);
    }
}
