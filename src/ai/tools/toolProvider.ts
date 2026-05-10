/**
 * VS Code Language-Model tool registrations for the `@lineage` chat participant.
 *
 * @remarks
 * Owns the `vscode.lm.registerTool` bindings and acts as the Zod boundary
 * between untrusted LM-supplied tool input and the engine + retrieval layer:
 * - Discovery / synthesis tools delegate to the pure functions in
 *   [`tools.ts`](./tools.ts) — no `vscode` imports leak past this file.
 * - State-machine tools (`start_exploration`, `submit_findings`,
 *   `present_result`, `get_neighbor_columns`) drive `NavigationEngine`
 *   ([`smBase.ts`](./smBase.ts)) and read / write `AiSession` state.
 * - Section-shape conformance against the locked `sess.classification` is
 *   enforced here in `validateSectionsAgainstClassification` — content quality
 *   stays in the prompt; this layer rejects only on mechanical contract.
 */
import * as vscode from 'vscode';
import type Graph from 'graphology';
import { NavigationEngine } from '../sm/smBase';
import type { AiSession } from '../session/session';
import { Logger, trunc, sanitizeForLog } from '../../utils/log';
import {
  suggestNarrowerDepth,
  getContext, searchObjects, getObjectDetail,
  runAnalysis, searchDdl,
  getNeighborColumns,
  validateToolInput,
  StartExplorationInputSchema,
  SubmitFindingsInputSchema,
  GetNeighborColumnsInputSchema,
  autoFixPresentResult, validatePresentResult, orderAndAssemble,
  type PresentResultInput,
} from '../tools/tools';
import { edgeApiType } from '../infra/aiPresenter';
import { prunePreserveOnly } from '../infra/viewPrune';
import { type ObjectType, type AnalysisType, type DatabaseModel, type LineageNode } from '../../engine/types';
import { type SerializedFilterState, type AIViewMetadata } from '../../engine/projectStore';
import { PendingGateSchema } from '../session/sessionPhase';
import { buildSynthesisReminder, buildCtSynthesisBlock } from '../prompting/smPrompts';
import { getAllowedLmToolNames, activeModeOf, type LmStage } from '../tools/toolPolicy';
import { CLASSIFICATION_LABEL } from '../session/classification';
import { getToolInvocationLabel } from '../tools/toolLabels';
import { renderScopeSummaryMd } from '../prompting/scopeSummaryRenderer';
import { resolveModelNodeId, resolveModelNodeIds, sanitizeMissionBrief } from '../infra/inputNormalization';
import { evaluateToolPhaseRule } from '../interaction/rules/toolPhaseRules';
import {
  evaluateAlreadyStartedRule,
  evaluateParallelStartRule,
  evaluateScopeBudgetRule,
  evaluateSupplementPrereqRule,
} from '../interaction/rules/startExplorationRules';
import {
  evaluateExplorationCompleteRule,
  evaluateFocusMismatchRule,
  validateSectionsAgainstClassification,
} from '../interaction/rules/submitFindingsRules';
import { evaluatePresentResultPreconditionsRule } from '../interaction/rules/presentResultRules';
export { renderScopeSummaryMd } from '../prompting/scopeSummaryRenderer';

/** Reserve 30% of maxRounds as a buffer for retries and synthesis — never start SM on a scope that fills the whole budget. */
const SAFETY_RATIO = 0.7;

/**
 * Private handler for AI tool execution.
 *
 * Consolidates business logic, state-machine orchestration, and validation
 * for all lineage tools into a single testable class.
 */
class ToolHandler {
  private readonly logger: Logger;

  constructor(
    private readonly getSession: () => AiSession,
    outputChannel: vscode.LogOutputChannel,
    private readonly getPanel: () => vscode.WebviewPanel | undefined
  ) {
    this.logger = Logger.create(outputChannel, 'AI');
  }

  private isAiEnabled(): boolean {
    return vscode.workspace.getConfiguration('dataLineageViz.ai').get<boolean>('enabled') ?? true;
  }

  private requireModel(): DatabaseModel {
    const m = this.getSession().model;
    if (!m) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return m;
  }

  private requireGraph(): Graph {
    const g = this.getSession().graph;
    if (!g) throw new Error('No database loaded. Open a .dacpac file or connect to a database first.');
    return g;
  }

  private toolResult(data: object): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(data))]);
  }

  private logAndReturn(toolName: string, data: object, input?: unknown): vscode.LanguageModelToolResult {
    const sess = this.getSession();
    const json = JSON.stringify(data);
    const chars = json.length;
    const preview = trunc(sanitizeForLog(json), 300);

    if (input !== undefined) {
      const inputJson = trunc(sanitizeForLog(JSON.stringify(input)), 300);
      this.logger.debug(`Invoking ${toolName} — input: ${inputJson}`);
    }

    sess.hopLog.push({ tool: toolName, input: input, output: data, timestamp: new Date().toISOString() });
    this.logger.debug(`${toolName} → ${chars} chars: ${preview}`);
    const rejection = this.extractRejectionInfo(data);
    if (rejection) {
      const reason = trunc(sanitizeForLog(rejection.reason), 220);
      const hintPart = rejection.hint ? ` hint=${trunc(sanitizeForLog(rejection.hint), 220)}` : '';
      this.logger.debug(`[Reject] tool=${toolName} code=${rejection.code} reason=${reason}${hintPart}`);
    }
    return this.toolResult(data);
  }

  private extractRejectionInfo(data: object): { code: string; reason: string; hint?: string } | null {
    const anyData = data as {
      success?: unknown;
      error?: unknown;
      errors?: unknown;
      hint?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    const hasError = typeof anyData.error === 'string';
    const hasFailedSuccess = anyData.success === false;
    const hasErrors = Array.isArray(anyData.errors) && anyData.errors.length > 0;
    if (!hasError && !hasFailedSuccess && !hasErrors) return null;

    const code = hasError ? String(anyData.error) : 'validation';
    let reason = '';
    if (hasErrors) reason = String((anyData.errors as unknown[])[0] ?? '');
    if (!reason && typeof anyData.message === 'string') reason = anyData.message;
    if (!reason && typeof anyData.detail === 'string') reason = anyData.detail;
    if (!reason && hasError) reason = String(anyData.error);
    if (!reason) reason = 'tool returned failure envelope';
    const hint = typeof anyData.hint === 'string' ? anyData.hint : undefined;
    return { code, reason, hint };
  }

  private notePresentResultFailure(sess: AiSession, data: object): void {
    const rejection = this.extractRejectionInfo(data);
    if (!rejection) return;
    sess.presentResultFailureCountThisTurn += 1;
    const reason = rejection.hint
      ? `${rejection.reason} (${rejection.hint})`
      : rejection.reason;
    sess.presentResultLastFailureReasonThisTurn = trunc(sanitizeForLog(reason), 240);
  }

  private toolError(toolName: string, err: unknown): vscode.LanguageModelToolResult {
    const msg = err instanceof Error ? err.message : String(err);
    if (toolName === 'present_result') {
      const sess = this.getSession();
      sess.presentResultFailureCountThisTurn += 1;
      sess.presentResultLastFailureReasonThisTurn = trunc(sanitizeForLog(`internal_error: ${msg}`), 240);
    }
    this.logger.debug(`[Reject] tool=${toolName} code=internal_error reason=${trunc(sanitizeForLog(msg), 220)}`);
    return this.toolResult({ error: 'internal_error', tool: toolName, message: msg });
  }

  private disabled() {
    return this.toolResult({ error: 'disabled', hint: 'Enable via dataLineageViz.ai.enabled setting.' });
  }

  /**
   * Mechanical phase guard — enforces the per-phase tool policy at the handler
   * boundary, not just at the LM `tools[]` parameter.
   *
   * @remarks
   * The Copilot host treats the `tools` parameter on `request.model.sendRequest`
   * as advisory: tools registered globally via `vscode.lm.registerTool` remain
   * callable from the model regardless of what we passed. Eval evidence: a
   * `search_objects` invocation surfaced mid-active-SM despite our filter
   * excluding it. The fix is server-side — derive the active stage from
   * `sess.phase` + engine flags, then refuse to execute tools outside the
   * allowed set with an error directing the model to the right surface.
   *
   * @returns A `LanguageModelToolResult` carrying an `off_policy` error when the
   *   tool is not allowed in the current phase, or `null` when execution is
   *   permitted.
   */
  private offPolicyOrNull(toolName: string): vscode.LanguageModelToolResult | null {
    const sess = this.getSession();
    const stage = this.deriveLmStage(sess);
    const allowed = getAllowedLmToolNames(stage);
    const violation = evaluateToolPhaseRule(toolName, stage, allowed);
    return violation ? this.toolResult(violation) : null;
  }

  /**
   * Derives the {@link LmStage} from the session's current phase + engine state.
   */
  private deriveLmStage(sess: AiSession): LmStage {
    const phase = sess.phase.kind;
    const engine = sess.stateMachine;
    if (phase === 'exploring' && engine) {
      const mode = activeModeOf(engine.columnAspect !== null);
      return { kind: 'active', mode };
    }
    if (phase === 'synthesis') return { kind: 'synthesis' };
    if (phase === 'completed') return { kind: 'completed' };
    return { kind: 'discover' };
  }

  public getContext(input: unknown) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const offPolicy = this.offPolicyOrNull('lineage_get_context');
      if (offPolicy) return offPolicy;
      const sess = this.getSession();
      const ctx = getContext(this.requireModel(), sess.filter, sess.projectName, sess.views, sess.columnStore);
      return this.logAndReturn('get_context', ctx, input);
    } catch (err) { return this.toolError('get_context', err); }
  }

  public searchObjects(input: unknown) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const offPolicy = this.offPolicyOrNull('lineage_search_objects');
      if (offPolicy) return offPolicy;
      const inputErr = validateToolInput(input, { query: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { query, types, schemas, mode } = input as { query: string; types?: ObjectType[]; schemas?: string[]; mode?: 'substring' | 'regex' };
      return this.logAndReturn('search_objects', searchObjects(this.requireModel(), query, types, schemas, mode ?? 'substring', this.getSession().filter), input);
    } catch (err) { return this.toolError('search_objects', err); }
  }

  public startExploration(input: unknown) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const m = this.requireModel();
      const g = this.requireGraph();

      // Pre-Zod already_started guard: when an engine is live for this session
      // and we're not in a refine-ratchet, any further start_exploration call is
      // a duplicate — reject immediately before Zod can surface bad-param errors
      // that cause the AI to retry with different params instead of submitting.
      {
        const preCheckPrior = sess.stateMachine as NavigationEngine | null;
        const preCheckLive  = !!preCheckPrior && preCheckPrior.status !== 'complete';
        const preCheckRefining = preCheckLive
          && sess.phase.kind === 'awaiting_gate'
          && sess.phase.gate.gate === 'confirm_sm_start';
        const alreadyStarted = evaluateAlreadyStartedRule(preCheckLive, preCheckPrior?.sessionId === sess.id, preCheckRefining);
        if (alreadyStarted) {
          return this.logAndReturn('start_exploration', alreadyStarted, input);
        }
      }

      const parsed = StartExplorationInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path?.join('.') || '(root)';
        return this.logAndReturn('start_exploration', {
          error: 'missing_field',
          hint: `Invalid start_exploration input: field "${field}" — ${issue?.message ?? 'validation failed'}. Required: origin (non-empty string) OR supplement.nodeIds (post-synthesis add). Optional: question, direction, depth, depth_enforcement, excludeTypes, mission_brief, targetColumns.`,
        }, input);
      }
      const data = parsed.data;
      const normalizedMissionBrief = typeof data.mission_brief === 'string'
        ? sanitizeMissionBrief(data.mission_brief)
        : null;
      if (normalizedMissionBrief?.changed) {
        this.logger.debug(`[Mission] sanitized at tool boundary reasons=[${normalizedMissionBrief.reasons.join(',')}] old_len=${data.mission_brief!.length} new_len=${normalizedMissionBrief.text.length}`);
      }

      // DRY helper: propagates follow-up context updates shared by supplement + same-origin retrace.
      const applyFollowUpContext = (engine: NavigationEngine): void => {
        if (data.targetColumns?.length) engine.setColumnTargets(data.targetColumns);
        sess.setClassification(data.classification);
        if (normalizedMissionBrief?.text) sess.memory.setMissionBrief(normalizedMissionBrief.text);
        if (data.question) sess.memory.setUserQuestion(data.question);
      };

      // Post-synthesis supplement path: reuse the existing engine, extend the agenda,
      // run one-shot inline. Merges new slots into the existing archive — no reset.
      if (data.supplement) {
        const priorEngine = sess.stateMachine as NavigationEngine | null;
        const supplementPrereq = evaluateSupplementPrereqRule(priorEngine?.status ?? null);
        if (supplementPrereq) {
          return this.logAndReturn('start_exploration', supplementPrereq, input);
        }
        if (!priorEngine) {
          return this.logAndReturn('start_exploration', {
            error: 'supplement_requires_complete_engine',
            hint: "supplement requires a completed prior exploration. Current engine status: none. Start a fresh exploration instead (omit the 'supplement' field, provide 'origin').",
          }, input);
        }
        const res = priorEngine.supplementAgenda(data.supplement.nodeIds);
        if ('error' in res) return this.logAndReturn('start_exploration', res, input);
        applyFollowUpContext(priorEngine);
        sess.enterExploring();
        this.logger.info(`[${sess.id}] [Phase] completed → exploring (supplement) — nodeIds=${data.supplement.nodeIds.length} agendaed=${res.agendaed} contracted=${res.contracted} skipped=${res.skipped}`);
        const hopCtx = priorEngine.getHopContext();
        return this.logAndReturn('start_exploration', { ok: true, supplement: res, ...hopCtx }, input);
      }

      // Fresh exploration path: origin is required.
      if (!data.origin) {
        return this.logAndReturn('start_exploration', {
          error: 'missing_field',
          hint: "Field 'origin' is required for a fresh exploration. Supply 'supplement.nodeIds' only when extending a completed prior exploration (follow-up phase).",
        }, input);
      }

      const parallelViolation = evaluateParallelStartRule(sess.startExplorationRoundId, sess.currentRoundId);
      if (parallelViolation) {
        return this.logAndReturn('start_exploration', parallelViolation, input);
      }
      sess.startExplorationRoundId = sess.currentRoundId;

      const prior = sess.stateMachine as NavigationEngine | null;
      const priorLive = !!prior && prior.status !== 'complete';

      // Refinement-ratchet path — when a `confirm_sm_start` gate is pending, the AI
      // re-calls start_exploration with updated filters as a full re-spec. Reuse the
      // existing engine and re-run init with merged params (origin/direction/depth fall
      // back to the prior init snapshot) instead of rejecting as `already_started`.
      // Status check on `prior` is intentionally not engine-status: getHopContext() at
      // gate emission flips it to 'awaiting_findings' before the user replies, so a
      // status==='initialized' check would misclassify a legitimate refine as duplicate.
      const isRefining = sess.phase.kind === 'awaiting_gate'
        && sess.phase.gate.gate === 'confirm_sm_start'
        && priorLive;
      // Follow-up from completed phase: same-origin → convergent retrace (no gate, no wipe);
      // different origin → divergent fresh exploration (gate + archive reset).
      if (sess.phase.kind === 'completed' && prior && prior.status === 'complete') {
        const sameOrigin =
          !!data.origin && !!sess.resultGraph?.originNodeId &&
          resolveModelNodeId(data.origin, new Map(m.nodes.map(n => [n.id, n]))) === sess.resultGraph.originNodeId;

        if (sameOrigin) {
          const visitedIds = prior.getDetailSlots().map(s => s.nodeId);
          const toRetrace = visitedIds.length > 0 ? visitedIds : [data.origin];
          const res = prior.supplementAgenda(toRetrace);
          if (!('error' in res)) {
            applyFollowUpContext(prior);
            sess.startExplorationRoundId = sess.currentRoundId;
            sess.enterExploring();
            this.logger.info(`[${sess.id}] [Phase] completed → exploring (retrace) — origin=${data.origin} cols=${JSON.stringify(data.targetColumns)}`);
            return this.logAndReturn('start_exploration', { ok: true, retrace: true, ...prior.getHopContext() }, input);
          }
          // supplementAgenda failed → fall through to divergent path.
        }

        this.logger.info(`[${sess.id}] [Phase] completed → discover — fresh start_exploration (origin=${data.origin}); prior archive discarded`);
        sess.resetExploration();
        sess.startExplorationRoundId = sess.currentRoundId;
      }
      if (priorLive && prior!.sessionId && prior!.sessionId !== sess.id) {
        sess.pendingUserNotice.add('A previous exploration was still running when you started this one. Its in-memory findings were discarded.');
        sess.resetExploration();
        sess.startExplorationRoundId = sess.currentRoundId;
      } else if (priorLive) {
        const alreadyStarted = evaluateAlreadyStartedRule(priorLive, prior!.sessionId === sess.id, isRefining);
        if (alreadyStarted) return this.logAndReturn('start_exploration', alreadyStarted, input);
      }

      const filter = sess.filter;
      if (!filter) throw new Error('No filter state available.');

      const activeFilter: SerializedFilterState = {
        schemas: filter.schemas || [],
        types: filter.types || [],
        searchTerm: filter.searchTerm || '',
        hideIsolated: !!filter.hideIsolated,
        focusSchemas: filter.focusSchemas || [],
        showExternalRefs: !!filter.showExternalRefs,
        externalRefTypes: filter.externalRefTypes || [],
        exclusionPatterns: filter.exclusionPatterns || [],
      };

      const engineLog = (l: 'info' | 'debug' | 'warn', msg: string) => {
        const line = `[Engine] ${msg}`;
        if (l === 'debug') this.logger.debug(line);
        else if (l === 'warn') this.logger.warn(line);
        else this.logger.info(line);
      };
      // Refinement reuses the existing engine — only fresh runs build a new one.
      const engine: NavigationEngine = isRefining
        ? prior!
        : new NavigationEngine(m, g, engineLog, { activeFilter, memory: sess.memory }, sess.columnStore);

      engine.sessionId = sess.id;
      sess.stateMachine = engine;

      const stringArray = (v: unknown): string[] => Array.isArray(v) ? (v as unknown[]).filter((t): t is string => typeof t === 'string') : [];
      const excludeTypes:   string[] = stringArray(data.excludeTypes);
      const excludeSchemas: string[] = stringArray(data.excludeSchemas);
      const excludeNodeIds: string[] = stringArray(data.excludeNodeIds);
      const passNodeIds:    string[] = stringArray(data.passNodeIds);

      // On refine, fall back to the prior init snapshot for fields the AI didn't re-send.
      const refineOrigin = isRefining ? (data.origin ?? prior!.currentOrigin ?? '') : (data.origin ?? '');
      const refineDirection = data.direction ?? (isRefining ? prior!.currentDirection : 'bidirectional');
      const refineDepth = data.depth ?? (isRefining ? (prior!.currentDepth ?? undefined) : undefined);
      const refineUpstreamDepth = data.upstream_depth ?? (isRefining ? (prior!.currentUpstreamDepth ?? undefined) : undefined);
      const refineDownstreamDepth = data.downstream_depth ?? (isRefining ? (prior!.currentDownstreamDepth ?? undefined) : undefined);
      const refineEnforcement = data.depth_enforcement ?? (isRefining ? prior!.currentDepthEnforcement : undefined);
      const refineQuestion = data.question ?? (isRefining ? prior!.currentQuestion : 'Explore lineage');
      const refineMissionBrief = normalizedMissionBrief
        ? (normalizedMissionBrief.text || undefined)
        : (isRefining ? sanitizeMissionBrief(prior!.currentMissionBrief ?? '').text || undefined : undefined);
      const refineTargetColumns = data.targetColumns ?? (isRefining ? (prior!.currentTargetColumns ?? undefined) : undefined);

      const initResult = engine.init({
        question: refineQuestion || 'Explore lineage',
        origin: refineOrigin,
        targetColumns: refineTargetColumns,
        direction: refineDirection,
        depth: refineDepth,
        upstream_depth: refineUpstreamDepth,
        downstream_depth: refineDownstreamDepth,
        depth_enforcement: refineEnforcement,
        excludeTypes,
        excludeSchemas,
        excludeNodeIds,
        passNodeIds,
        mission_brief: refineMissionBrief,
      });

      if ('error' in initResult) return this.logAndReturn('start_exploration', initResult, input);

      const aiCfg = vscode.workspace.getConfiguration('dataLineageViz.ai');
      const maxRounds = aiCfg.get<number>('maxRounds', 50);
      const safeMax = Math.max(1, Math.floor(maxRounds * SAFETY_RATIO));
      const scopeViolation = evaluateScopeBudgetRule(
        initResult.scopeSize,
        safeMax,
        maxRounds,
        suggestNarrowerDepth(g, engine.currentOrigin ?? data.origin, data.direction || 'bidirectional', safeMax),
      );
      if (scopeViolation) {
        const scopeOrigin = engine.currentOrigin ?? data.origin;
        sess.resetExploration();
        this.logger.debug(`[ScopeBudget] origin=${scopeOrigin} scope=${initResult.scopeSize} safe_max=${safeMax}`);
        return this.logAndReturn('start_exploration', scopeViolation, input);
      }

      if (!sess.classification) {
        // Zod hard-required `classification` at the schema boundary; data.classification is
        // already a valid enum value here. No fallback path — invalid input was rejected earlier.
        sess.setClassification(data.classification);
        this.logger.info(`[${sess.id}] [Classification] fired=${sess.classification} (SM mode, AI-declared)`);
      } else if (data.classification && data.classification !== sess.classification) {
        // Refine round: the AI may re-issue a classification override; honour it.
        sess.setClassification(data.classification);
        this.logger.info(`[${sess.id}] [Classification] refine-override → ${sess.classification}`);
      }

      // Discovery is content-blind: always gate before any analysis runs.
      // Refine path: re-emit the gate with the new tree so the loop continues.
      if (sess.phase.kind === 'idle' || isRefining) {
        const hopCtx = engine.getHopContext();
        const isCt = !!engine.columnAspect;

        const classes = ['sliding_memory'];
        if (initResult.scopeSchemas) {
          const filterSet = new Set((activeFilter.schemas || []).map(s => s.toLowerCase()));
          for (const s of initResult.scopeSchemas) {
            if (filterSet.size > 0 && !filterSet.has(s.toLowerCase())) {
              classes.push(`schema:${s.toLowerCase()}`);
            }
          }
        }

        const summary = engine.getScopeSummary();
        const tree = renderScopeSummaryMd(summary);
        const classLabel = CLASSIFICATION_LABEL[sess.classification!] + (isCt ? ' (Column Trace)' : '');
        const detail = `${tree}\n\n_Analysis: ${classLabel}_`;

        const gate = PendingGateSchema.parse({
          gate: 'confirm_sm_start',
          classes,
          nodeIds: [],
          detail,
        });
        const hint = isRefining
          ? 'Refine round — gate re-emitted. Wait for the user to Approve, Cancel, or Refine again.'
          : 'Tool paused — awaiting user confirmation before first hop. Hop context delivered for use after approval.';
        return this.logAndReturn('start_exploration', {
          error: 'action_required',
          ...gate,
          hop_context: hopCtx,
          hint,
        }, input);
      }

      const hopResult = engine.getHopContext();
      return this.logAndReturn('start_exploration', { ...initResult, ...hopResult }, input);
    } catch (err) {
      const sess = this.getSession();
      sess.stateMachine = null;
      sess.startExplorationRoundId = null;
      return this.toolError('start_exploration', err);
    }
  }

  public submitFindings(input: unknown) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const engine = sess.stateMachine as NavigationEngine | null;
      if (!engine) return this.logAndReturn('submit_findings', {
        error: 'no_active_session',
        hint: 'No active state machine. Call start_exploration first to begin an investigation.',
        next_action: 'start_exploration',
      }, input);

      // Mechanical phase guard — symmetric with present_result's resultGraph precondition.
      // Once the engine seals (agenda drained), submit_findings is meaningless; without this
      // guard the AI burns minutes iterating shape variations against the unhelpful Zod hint.
      const completeViolation = evaluateExplorationCompleteRule(engine.status);
      if (completeViolation) return this.logAndReturn('submit_findings', completeViolation, input);

      const parsed = SubmitFindingsInputSchema.safeParse(input);
      if (!parsed.success) {
        // Surface specific field paths so the model can correct the right field on retry.
        const seen = new Set<string>();
        const fieldErrors: string[] = [];
        for (const issue of parsed.error.issues) {
          if (issue.path.length === 0) continue;
          const key = issue.path.join('.');
          if (seen.has(key)) continue;
          seen.add(key);
          fieldErrors.push(`${key}: ${issue.message}`);
          if (fieldErrors.length >= 3) break;
        }
        const hint = fieldErrors.length > 0
          ? `Invalid submit_findings input — ${fieldErrors.join('; ')}.`
          : `Invalid submit_findings input: ${parsed.error.issues[0]?.message ?? 'validation failed'}. Required: focus_node_id, sections[], summary, verdict.`;
        return this.logAndReturn('submit_findings', {
          error: 'invalid_input',
          hint,
        }, input);
      }

      // The agreement-phase gate locks `sess.classification`. Each finding's
      // sections[] must match the lock; verdict=prune may submit length 0.
      const findings = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
      for (const f of findings) {
        const violation = validateSectionsAgainstClassification(f.sections, f.verdict, sess.classification);
        if (violation) {
          return this.logAndReturn('submit_findings', {
            error: 'classification_lock_violation',
            hint: violation,
          }, input);
        }
      }

      // Identity guard: submitted focus_node_id must match the engine's current focus.
      const engineFocus = engine.currentFocus;
      const focusViolation = evaluateFocusMismatchRule(engineFocus, parsed.data.focus_node_id);
      if (focusViolation) return this.logAndReturn('submit_findings', focusViolation, input);

      const result = engine.submitFindings(parsed.data);
      if ('error' in result) {
        // Log each rejection reason untruncated — the detail array is buried past the 300-char JSON cap.
        const detail = (result as { detail?: Array<{ id?: string; reason?: string }> }).detail;
        if (Array.isArray(detail)) {
          for (const d of detail) {
            if (d.reason) this.logger.debug(`[AI] [CT] rejection: id=${d.id ?? '?'} — ${d.reason}`);
          }
        }
        return this.logAndReturn('submit_findings', result, input);
      }

      if ('done' in result && result.done && result.result) {
        sess.storeSmResult(result.result);
        const lmResult = {
          status: result.result.status,
          originNodeId: result.result.originNodeId,
          scope: { nodes: result.result.fullNodes.length, edges: result.result.edges.length },
          suggested_sections: result.result.suggested_sections,
          detail_slots: result.result.detail_slots,
        };
        return this.logAndReturn('submit_findings', { ...result, result: lmResult }, input);
      }

      const diag = engine.getHopDiagnostics();
      const ctSuffix = diag.columnEdgeCount !== undefined
        ? ` ct_edges=${diag.columnEdgeCount} cols=${diag.activeColumnCount} flow=${diag.columnFlowEntries}`
        : '';
      this.logger.debug(
        `[AI] [Hop ${diag.hop}] focus=${diag.focus} schema=${diag.schema} depth=${diag.depth}/${diag.depthBudget ?? '∞'} verdict=${diag.verdict ?? 'none'} ` +
        `detail=${diag.detailChars} summary=${diag.summaryChars} archive=${diag.archiveChars} ` +
        `routed=${diag.routedNew}/${diag.routedRejected} agenda=${diag.agendaRemaining} ` +
        `tally=R${diag.tally.analyze}/P${diag.tally.pass}/I${diag.tally.prune} expansions=${diag.scopeExpansions} allowed_schemas=${diag.allowedSchemaCount}${ctSuffix}`
      );

      const nextHop = engine.getHopContext();
      if (nextHop.done) {
        const finalResult = engine.getResult();
        sess.storeSmResult(finalResult);
        if (!sess.classification) sess.setClassification('business');
        const baseReminder = buildSynthesisReminder(sess.memory.getUserQuestion());
        const ctBlock = finalResult.columnAspect && finalResult.columnAspect.edges.length > 0
          ? '\n' + buildCtSynthesisBlock(finalResult.columnAspect.edges, finalResult.ctPrunedNodeIds)
          : '';
        const synthesisReminder = baseReminder + ctBlock;
        const lmResult = {
          status: finalResult.status,
          originNodeId: finalResult.originNodeId,
          scope: { nodes: finalResult.fullNodes.length, edges: finalResult.edges.length },
          suggested_sections: finalResult.suggested_sections,
          detail_slots: finalResult.detail_slots,
        };
        return this.logAndReturn('submit_findings', {
          ok: true,
          done: true,
          result: lmResult,
          deferred_questions: sess.stateMachine?.deferredQuestions ?? [],
          synthesis_reminder: synthesisReminder,
        }, input);
      }
      return this.logAndReturn('submit_findings', nextHop, input);
    } catch (err) { return this.toolError('submit_findings', err); }
  }

  public async presentResult(input: PresentResultInput) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      sess.presentResultAttemptCountThisTurn += 1;
      const model = this.requireModel();

      if (input.sections !== undefined && !Array.isArray(input.sections)) input.sections = undefined;
      if (input.notes !== undefined && !Array.isArray(input.notes)) input.notes = undefined;
      if (input.add_node_ids !== undefined && !Array.isArray(input.add_node_ids)) input.add_node_ids = undefined;
      if (input.prune_node_ids !== undefined && !Array.isArray(input.prune_node_ids)) input.prune_node_ids = undefined;
      if (input.highlight_groups !== undefined && !Array.isArray(input.highlight_groups)) input.highlight_groups = undefined;

      const presentPrecondition = evaluatePresentResultPreconditionsRule(!!sess.resultGraph);
      if (presentPrecondition) {
        this.notePresentResultFailure(sess, presentPrecondition);
        return this.logAndReturn('present_result', presentPrecondition, input);
      }
      const resultGraph = sess.resultGraph!;

      let resolvedNodeIds: string[] = [...resultGraph.nodeIds];
      let resolvedEdges: [string, string, string][] = [...resultGraph.edges];
      const graphSource = resultGraph.source;
      const modelNodeMap = new Map(model.nodes.map(n => [n.id, n]));

      if (input.is_update && input.add_node_ids?.length) {
        const currentSet = new Set(resolvedNodeIds);
        const addResolution = resolveModelNodeIds(input.add_node_ids, modelNodeMap);
        if (addResolution.unresolved.length > 0) {
          const failure = {
            success: false,
            errors: [
              `Unknown add_node_ids after bracket/case normalization: ${addResolution.unresolved.map(id => `\`${id}\``).join(', ')}.`,
              'Use lineage_search_objects to resolve canonical IDs, then retry present_result.',
            ],
          };
          this.notePresentResultFailure(sess, failure);
          return this.logAndReturn('present_result', failure, input);
        }
        const toAdd = addResolution.resolved.filter(id => !currentSet.has(id));
        resolvedNodeIds.push(...toAdd);
        const newSet = new Set(resolvedNodeIds);
        resolvedEdges = model.edges
          .filter(e => newSet.has(e.source) && newSet.has(e.target))
          .map(e => [e.source, e.target, edgeApiType(e.type)] as [string, string, string]);
      }

      if (input.prune_node_ids?.length) {
        const pruneResolution = resolveModelNodeIds(input.prune_node_ids, modelNodeMap);
        if (pruneResolution.unresolved.length > 0) {
          const failure = {
            success: false,
            errors: [
              `Unknown prune_node_ids after bracket/case normalization: ${pruneResolution.unresolved.map(id => `\`${id}\``).join(', ')}.`,
              'Use lineage_search_objects to resolve canonical IDs, then retry present_result.',
            ],
          };
          this.notePresentResultFailure(sess, failure);
          return this.logAndReturn('present_result', failure, input);
        }
        const pruned = prunePreserveOnly(resolvedNodeIds, resolvedEdges, pruneResolution.resolved);
        resolvedNodeIds = pruned.nodeIds;
        resolvedEdges = pruned.edges;
      }

      if (resultGraph.notes?.length) {
        const userNoteIds = new Set((input.notes ?? []).map(n => (n as { node_id: string }).node_id));
        const resolvedSet = new Set(resolvedNodeIds);
        const autoNotes: Array<{ node_id: string; text: string }> = [];
        for (const { nodeId, summary } of resultGraph.notes) {
          if (resolvedSet.has(nodeId) && !userNoteIds.has(nodeId) && summary) {
            autoNotes.push({ node_id: nodeId, text: summary });
          }
        }
        if (autoNotes.length > 0) input.notes = [...(input.notes ?? []), ...autoNotes];
      }

      if (resultGraph.suggested_labels?.length && input.sections?.length) {
        const hasNodeIds = input.sections.some(s => s.node_ids && s.node_ids.length > 0);
        if (!hasNodeIds) {
          const stripNum = (s: string) => s.replace(/^\d+[\.\s]+/, '').trim();
          const labelToNodeIds = new Map<string, string[]>();
          for (const sl of resultGraph.suggested_labels) {
            if (!sl.text) continue;
            const label = stripNum(sl.text);
            if (!labelToNodeIds.has(label)) labelToNodeIds.set(label, []);
            labelToNodeIds.get(label)!.push(sl.node_id);
          }
          input.sections = input.sections.map(sec => {
            const ids = labelToNodeIds.get(stripNum(sec.label));
            return ids?.length ? { ...sec, node_ids: ids } : sec;
          });
        }
      }

      this.logger.debug(`presentResult section[0] preview: ${trunc(input.sections?.[0]?.text ?? '(empty)', 200)}`);

      // Auto-fix AI output artifacts (newline unescaping, length truncation) before assembly.
      // $$ math is no longer converted here — AiDescriptionOverlay.tsx handles it client-side.
      const { input: fixedInput } = autoFixPresentResult(model, input, resolvedNodeIds);

      let assembledBadges: Array<{ node_id: string; text: string }> = [];
      let assembledDescription: string | undefined = undefined;
      if (fixedInput.sections?.length) {
        const nodeMap = new Map<string, LineageNode>((model.nodes as LineageNode[]).map(n => [n.id, n]));
        const assembled = orderAndAssemble(fixedInput.sections, { title: fixedInput.title, intro: fixedInput.intro, closing: fixedInput.closing, nodeMap });
        assembledBadges = assembled.badges;
        assembledDescription = assembled.description;
      }

      this.logger.info(
        `[Synthesis] Output assembled — title="${trunc(fixedInput.title ?? '(none)', 60)}" sections=${fixedInput.sections?.length ?? 0} badges=${assembledBadges.length} desc=${assembledDescription?.length ?? 0}chars classification=${sess.classification ?? '(none)'} slots=${sess.memory.slotCount}`
      );

      const validation = validatePresentResult(fixedInput, resolvedNodeIds, assembledBadges, assembledDescription);

      if (!validation.success) {
        this.notePresentResultFailure(sess, validation);
        return this.logAndReturn('present_result', validation, input);
      }

      const aiMetadata: AIViewMetadata = {
        summary: validation.summary,
        description: validation.description,
        createdAt: new Date().toISOString(),
        modelName: sess.modelName || 'unknown',
        highlightGroups: validation.highlight_groups.map(g => ({ label: g.label, color: g.color, nodeIds: g.node_ids })),
        badges: validation.badges.map(b => ({ nodeId: b.node_id, text: b.text })),
        notes: validation.notes.map(n => ({ nodeId: n.node_id, text: n.text })),
        layoutDirection: validation.layout_direction,
      };

      const panel = this.getPanel();
      if (panel) {
        panel.webview.postMessage({ type: 'ai-view-preview', name: validation.name, nodeIds: validation.node_ids, aiMetadata });
        panel.reveal(vscode.ViewColumn.One);
      }

      if (input.is_update) {
        resultGraph.nodeIds = resolvedNodeIds;
        resultGraph.edges = resolvedEdges;
        const existingNotes = new Map((resultGraph.notes ?? []).map(n => [n.nodeId, n]));
        for (const n of validation.notes) existingNotes.set(n.node_id, { nodeId: n.node_id, summary: n.text });
        resultGraph.notes = Array.from(existingNotes.values());
      }
      // B-1: persist the synthesized body fields onto resultGraph so `GET /state` carries
      // the full description, not just topology + suggested_*. Pre-fix these fields were
      // only sent transiently to the webview; the persisted resultGraph was empty.
      {
        resultGraph.description = validation.description ?? undefined;
        resultGraph.summary = validation.summary ?? undefined;
        resultGraph.title = input.title ?? undefined;
        resultGraph.intro = input.intro ?? undefined;
        resultGraph.closing = input.closing ?? undefined;
        if (Array.isArray(input.sections)) {
          resultGraph.sections = input.sections.map(s => ({
            label: s.label,
            node_ids: s.node_ids,
            text: s.text,
          }));
        }
      }
      sess.lastPresentResultDescription = validation.description ?? null;
      sess.lastPresentResultSummary = validation.summary ?? null;
      // Signal the button gate in dispatchExit that a graph was built this turn.
      sess.presentResultCalledThisTurn = true;

      this.logger.info(`AI view "${validation.name}" displayed — nodes=${validation.node_ids.length} sections=${fixedInput.sections?.length ?? 0} highlights=${validation.highlight_groups.length} badges=${validation.badges.length} classification=${sess.classification ?? '(none)'}`);
      return this.logAndReturn('present_result', { success: true, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource }, input);
    } catch (err) { return this.toolError('present_result', err); }
  }

  public getObjectDetail(input: unknown) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const offPolicy = this.offPolicyOrNull('lineage_get_object_detail');
      if (offPolicy) return offPolicy;
      const inputErr = validateToolInput(input, { id: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { id } = input as { id: string };
      return this.logAndReturn('get_object_detail', getObjectDetail(this.requireModel(), id, this.getSession().columnStore), input);
    } catch (err) { return this.toolError('get_object_detail', err); }
  }

  public runAnalysis(input: unknown) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const offPolicy = this.offPolicyOrNull('lineage_detect_graph_patterns');
      if (offPolicy) return offPolicy;
      const inputErr = validateToolInput(input, { type: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { type, min_degree, max_size } = input as { type: string; min_degree?: number; max_size?: number };
      const anaCfg = vscode.workspace.getConfiguration('dataLineageViz');
      const resolvedMinDegree = min_degree ?? anaCfg.get<number>('analysis.hubMinDegree');
      const resolvedMaxSize   = max_size   ?? anaCfg.get<number>('analysis.islandMaxSize');
      const resolvedLongestPath = anaCfg.get<number>('analysis.longestPathMinNodes');
      return this.logAndReturn('detect_graph_patterns', runAnalysis(this.requireModel(), this.requireGraph(), type as AnalysisType, resolvedMinDegree, resolvedMaxSize, resolvedLongestPath), input);
    } catch (err) { return this.toolError('detect_graph_patterns', err); }
  }

  public searchDdl(input: unknown) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const offPolicy = this.offPolicyOrNull('lineage_search_ddl');
      if (offPolicy) return offPolicy;
      const inputErr = validateToolInput(input, { query: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { query, types } = input as { query: string; types?: ('view' | 'procedure' | 'function')[] };
      return this.logAndReturn('search_ddl', searchDdl(this.requireModel(), query, types, this.getSession().columnStore), input);
    } catch (err) { return this.toolError('search_ddl', err); }
  }

  /**
   * SM ACTIVE pruning-verification affordance. Returns columns + FKs (no DDL)
   * for direct neighbors of the current focus node, bounded by the active scope.
   *
   * @remarks
   * Structural contract: ids must be direct neighbors of the current focus AND
   * within the active BFS scope. `NavigationEngine.validateNeighborIds` enforces
   * both conditions and returns a structured error on violation — the tool is
   * never a backdoor for out-of-scope exploration.
   */
  public getNeighborColumns(input: unknown) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const engine = sess.stateMachine as NavigationEngine | null;
      if (!engine) {
        return this.logAndReturn('get_neighbor_columns', {
          error: 'no_active_session',
          hint: 'This tool is only available during an active SM exploration. Call start_exploration first.',
        }, input);
      }

      const parsed = GetNeighborColumnsInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path?.join('.') || '(root)';
        return this.logAndReturn('get_neighbor_columns', {
          error: 'invalid_input',
          hint: `Invalid get_neighbor_columns input: field "${field}" — ${issue?.message ?? 'validation failed'}. Required: ids (non-empty array of node IDs).`,
        }, input);
      }

      const invalidIds = engine.validateNeighborIds(parsed.data.ids);
      if (invalidIds.length > 0) {
        return this.logAndReturn('get_neighbor_columns', {
          error: 'out_of_scope_or_not_neighbor',
          invalid_ids: invalidIds,
          hint: `These ids are not direct neighbors of the current focus node and/or not in the active scope: ${invalidIds.join(', ')}. This tool only inspects direct neighbors for pruning verification.`,
        }, input);
      }

      return this.logAndReturn('get_neighbor_columns', getNeighborColumns(this.requireModel(), parsed.data.ids, sess.columnStore), input);
    } catch (err) { return this.toolError('get_neighbor_columns', err); }
  }

}

/**
 * Registers all language model tools associated with the `@lineage` chat participant.
 *
 * @remarks
 * This function is the "central registration point for the AI toolset. It consolidates
 * various lineage operations (searching, tracing, exploring) into a set of VS Code
 * language model tools.
 *
 * It manages the lifecycle of the `NavigationEngine` for multi-hop exploration and
 * provides a unified logging and error-handling wrapper around tool invocations.
 *
 * @param getSession - A factory function to retrieve the current active AI session.
 * @param outputChannel - The log output channel for tracing tool activity.
 * @param getPanel - A function to retrieve the currently active webview panel.
 * @returns An array of disposables representing the registered tools.
 */
export function registerAiTools(
  getSession: () => AiSession,
  outputChannel: vscode.LogOutputChannel,
  getPanel: () => vscode.WebviewPanel | undefined
): vscode.Disposable[] {
  const handler = new ToolHandler(getSession, outputChannel, getPanel);

  return [
    vscode.lm.registerTool('lineage_get_context', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_get_context', options.input) }; },
      invoke(options, _token) { return handler.getContext(options.input); },
    }),

    vscode.lm.registerTool('lineage_search_objects', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_search_objects', options.input) }; },
      invoke(options, _token) { return handler.searchObjects(options.input); },
    }),

    vscode.lm.registerTool('lineage_start_exploration', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_start_exploration', options.input) }; },
      invoke(options, _token) { return handler.startExploration(options.input); },
    }),

    vscode.lm.registerTool('lineage_submit_findings', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_submit_findings', options.input) }; },
      invoke(options, _token) { return handler.submitFindings(options.input); },
    }),

    vscode.lm.registerTool('lineage_present_result', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_present_result', options.input) }; },
      invoke(options, _token) { return handler.presentResult(options.input as PresentResultInput); },
    }),

    vscode.lm.registerTool('lineage_get_object_detail', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_get_object_detail', options.input) }; },
      invoke(options, _token) { return handler.getObjectDetail(options.input); },
    }),

    vscode.lm.registerTool('lineage_detect_graph_patterns', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_detect_graph_patterns', options.input) }; },
      invoke(options, _token) { return handler.runAnalysis(options.input); },
    }),

    vscode.lm.registerTool('lineage_search_ddl', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_search_ddl', options.input) }; },
      invoke(options, _token) { return handler.searchDdl(options.input); },
    }),

    vscode.lm.registerTool('lineage_get_neighbor_columns', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_get_neighbor_columns', options.input) }; },
      invoke(options, _token) { return handler.getNeighborColumns(options.input); },
    }),
  ];
}

