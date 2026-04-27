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
import { NavigationEngine } from './smBase';
import type { AiSession } from './session';
import { Logger, trunc, sanitizeForLog } from '../utils/log';
import {
  suggestNarrowerDepth,
  shouldSmInline,
  getContext, searchObjects, getObjectDetail,
  runBfsTrace, runAnalysis, searchDdl,
  getNeighborColumns,
  validateToolInput,
  StartExplorationInputSchema,
  SubmitFindingsInputSchema,
  GetNeighborColumnsInputSchema,
  autoFixPresentResult, validatePresentResult, orderAndAssemble,
  type PresentResultInput,
} from './tools';
import { edgeApiType } from './aiPresenter';
import { prunePreserveOnly } from './viewPrune';
import { type ObjectType, type AnalysisType, type DatabaseModel, type LineageNode } from '../engine/types';
import { type SerializedFilterState, type AIViewMetadata } from '../engine/projectStore';
import { PendingGateSchema } from './sessionPhase';
import { buildSynthesisReminder } from './smPrompts';
import { ClassificationSchema, CLASSIFICATION_LABEL, type ClassificationValue } from './classification';
import type { CapturedSection } from './memoryManager';
import { getToolInvocationLabel } from './toolLabels';
import { renderScopeSummaryMd } from './scopeSummaryRenderer';
export { renderScopeSummaryMd } from './scopeSummaryRenderer';

/**
 * Minimum char-length floor for a captured section's `text`.
 *
 * @remarks
 * Structural floor only — catches near-empty submissions (e.g. one-line stubs
 * that bypass the YAML capture template's structured slots). Not a quality
 * threshold; depth/narrative judgments stay in the prompt. The floor is
 * deliberately well below any genuine business or technical capture — a
 * rejection here means the model emitted a placeholder, not that the prose
 * was "too short".
 */
const MIN_SECTION_TEXT_CHARS = 120;

/**
 * Validates per-section `text` length floor for analyze/pass verdicts.
 *
 * @remarks
 * `verdict: 'prune'` is exempt (pruned nodes may submit no sections). Each
 * section's `text` must be at least {@link MIN_SECTION_TEXT_CHARS} chars when
 * present — below that the captured slot is structurally a stub.
 *
 * @returns A structured hint string when any section is below the floor, `null` otherwise.
 */
function validateSectionLengths(
  sections: CapturedSection[] | undefined,
  verdict: 'analyze' | 'pass' | 'prune',
): string | null {
  if (verdict === 'prune') return null;
  const list = sections ?? [];
  for (const s of list) {
    const len = s.text?.length ?? 0;
    if (len < MIN_SECTION_TEXT_CHARS) {
      return `sections[].text must be at least ${MIN_SECTION_TEXT_CHARS} chars (got ${len} for angle="${s.angle}"). Re-emit the section using the fired *_capture template's structured slots — a near-empty body indicates the template was bypassed.`;
    }
  }
  return null;
}

/**
 * Validates a finding's `sections[]` against the locked session classification.
 *
 * @remarks
 * The agreement-phase `confirm_sm_start` gate locks `sess.classification`. After
 * the lock, `submit_findings.sections[]` must structurally match: `business` →
 * exactly one section with `angle: 'business'`; `technical` → one with
 * `angle: 'technical'`; `both` → one of each. `verdict: 'prune'` is exempt —
 * pruned nodes may submit no sections. Mechanical contract — does not judge
 * content quality.
 *
 * @returns A structured hint string when the contract is violated, `null` otherwise.
 */
function validateSectionsAgainstClassification(
  sections: CapturedSection[] | undefined,
  verdict: 'analyze' | 'pass' | 'prune',
  classification: ClassificationValue | undefined,
): string | null {
  if (verdict === 'prune') return null; // pruned nodes may submit no sections
  const list = sections ?? [];
  // When classification has not yet been locked (early hop before gate resolves), accept any non-empty shape.
  if (!classification) {
    return list.length === 0 ? 'sections[] must contain at least one section when verdict is analyze or pass.' : null;
  }
  const angles = new Set(list.map(s => s.angle));
  switch (classification) {
    case 'business':
      if (list.length === 0 || !angles.has('business')) {
        return 'classification=business requires exactly one section with angle="business".';
      }
      if (angles.has('technical')) {
        return 'classification=business rejects technical sections — submit only the business angle.';
      }
      if (list.length > 1) {
        return 'classification=business expects one section; got more.';
      }
      return null;
    case 'technical':
      if (list.length === 0 || !angles.has('technical')) {
        return 'classification=technical requires exactly one section with angle="technical".';
      }
      if (angles.has('business')) {
        return 'classification=technical rejects business sections — submit only the technical angle.';
      }
      if (list.length > 1) {
        return 'classification=technical expects one section; got more.';
      }
      return null;
    case 'both':
      if (!angles.has('business') || !angles.has('technical')) {
        return 'classification=both requires two sections — one with angle="business" and one with angle="technical".';
      }
      if (list.length !== 2) {
        return 'classification=both expects exactly two sections (one per angle).';
      }
      return null;
  }
}

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

  private logAndReturn(toolName: string, data: object, input?: any): vscode.LanguageModelToolResult {
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
    return this.toolResult(data);
  }

  private toolError(toolName: string, err: unknown): vscode.LanguageModelToolResult {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(`${toolName}: unhandled`, err instanceof Error ? err : new Error(msg));
    return this.toolResult({ error: 'internal_error', tool: toolName, message: msg });
  }

  private disabled() { 
    return this.toolResult({ error: 'disabled', hint: 'Enable via dataLineageViz.ai.enabled setting.' }); 
  }

  public getContext(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const ctx = getContext(this.requireModel(), sess.filter, sess.projectName, sess.views, sess.columnStore);
      return this.logAndReturn('get_context', ctx, input);
    } catch (err) { return this.toolError('get_context', err); }
  }

  public searchObjects(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const inputErr = validateToolInput(input, { query: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { query, types, schemas, mode } = input;
      return this.logAndReturn('search_objects', searchObjects(this.requireModel(), query, types, schemas, mode ?? 'substring', this.getSession().filter), input);
    } catch (err) { return this.toolError('search_objects', err); }
  }

  public startExploration(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const m = this.requireModel();
      const g = this.requireGraph();

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

      // Post-synthesis supplement path: reuse the existing engine, extend the agenda,
      // run one-shot inline. Merges new slots into the existing archive — no reset.
      if (data.supplement) {
        const priorEngine = sess.stateMachine as NavigationEngine | null;
        if (!priorEngine || priorEngine.status !== 'complete') {
          return this.logAndReturn('start_exploration', {
            error: 'supplement_requires_complete_engine',
            hint: `supplement requires a completed prior exploration. Current engine status: ${priorEngine?.status ?? 'none'}. Start a fresh exploration instead (omit the 'supplement' field, provide 'origin').`,
          }, input);
        }
        const res = priorEngine.supplementAgenda(data.supplement.nodeIds);
        if ('error' in res) return this.logAndReturn('start_exploration', res, input);
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

      sess.resetIfStale();

      if (sess.startExplorationRoundId !== null && sess.startExplorationRoundId === sess.currentRoundId) {
        return this.logAndReturn('start_exploration', {
          error: 'parallel_call_forbidden',
          hint: 'start_exploration is strictly serial and one-shot per round. Use submit_findings for the queued neighbors — after complete_rejected they are queued at priority 3 and will be served on the next submit_findings.',
          next_action: 'submit_findings',
        }, input);
      }
      sess.startExplorationRoundId = sess.currentRoundId;

      const prior = sess.stateMachine as NavigationEngine | null;
      const priorLive = !!prior && prior.status !== 'complete';

      // Refinement-ratchet path — when a `confirm_sm_start` gate is pending, the AI
      // re-calls start_exploration with updated filters as a full re-spec. Reuse the
      // existing engine and re-run init with merged params (origin/direction/depth fall
      // back to the prior init snapshot) instead of rejecting as `already_started`.
      const isRefining = sess.phase.kind === 'awaiting_gate'
        && sess.phase.gate.gate === 'confirm_sm_start'
        && !!prior
        && prior.status === 'initialized';
      // Fresh exploration from the completed (follow-up) phase: the AI has decided the
      // question is a genuinely new trace, not a refinement. Discard the prior archive
      // so the confirm_sm_start gate can fire and the new run starts clean.
      if (sess.phase.kind === 'completed' && prior && prior.status === 'complete') {
        this.logger.info(`[${sess.id}] [Phase] completed → discover — fresh start_exploration (origin=${data.origin}); prior archive discarded`);
        sess.resetExploration();
        sess.startExplorationRoundId = sess.currentRoundId;
      }
      if (priorLive && prior!.sessionId && prior!.sessionId !== sess.id) {
        sess.pendingUserNotice.add('A previous exploration was still running when you started this one. Its in-memory findings were discarded.');
        sess.resetExploration();
        sess.startExplorationRoundId = sess.currentRoundId;
      } else if (priorLive && prior!.sessionId === sess.id && !isRefining) {
        return this.logAndReturn('start_exploration', {
          error: 'already_started',
          hint: 'start_exploration is one-shot per turn. Use submit_findings to continue the current agenda. After complete_rejected, the unvisited neighbors are already queued at priority 3 — the next submit_findings will present one of them.',
          next_action: 'submit_findings',
        }, input);
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
      const forceMode: 'inline' | 'sm' | undefined = data.forceMode;

      // On refine, fall back to the prior init snapshot for fields the AI didn't re-send.
      const refineOrigin = isRefining ? (data.origin ?? prior!.currentOrigin ?? '') : (data.origin ?? '');
      const refineDirection = data.direction ?? (isRefining ? prior!.currentDirection : 'bidirectional');
      const refineDepth = data.depth ?? (isRefining ? (prior!.currentDepth ?? undefined) : undefined);
      const refineEnforcement = data.depth_enforcement ?? (isRefining ? prior!.currentDepthEnforcement : undefined);
      const refineQuestion = data.question ?? (isRefining ? prior!.currentQuestion : 'Explore lineage');
      const refineMissionBrief = typeof data.mission_brief === 'string' ? data.mission_brief : (isRefining ? (prior!.currentMissionBrief ?? undefined) : undefined);
      const refineTargetColumns = data.targetColumns ?? (isRefining ? (prior!.currentTargetColumns ?? undefined) : undefined);

      const initResult = engine.init({
        question: refineQuestion || 'Explore lineage',
        origin: refineOrigin,
        targetColumns: refineTargetColumns,
        direction: refineDirection,
        depth: refineDepth,
        depth_enforcement: refineEnforcement,
        excludeTypes,
        excludeSchemas,
        excludeNodeIds,
        passNodeIds,
        forceMode,
        mission_brief: refineMissionBrief,
      });

      if ('error' in initResult) return this.logAndReturn('start_exploration', initResult, input);

      const scopeDdlChars = engine.estimateScopeDdlChars();
      // forceMode (user/AI override) wins over the size+budget heuristic; null -> heuristic decides.
      const useInline = forceMode === 'inline'
        ? true
        : forceMode === 'sm'
          ? false
          : shouldSmInline(!!engine.columnAspect, scopeDdlChars, initResult.scopeSize);

      if (useInline) {
        engine.setInlineMode(true);
      } else {
        const aiCfg = vscode.workspace.getConfiguration('dataLineageViz.ai');
        const maxRounds = aiCfg.get<number>('maxRounds', 50);
        const SAFETY_RATIO = 0.7;
        const safeMax = Math.max(1, Math.floor(maxRounds * SAFETY_RATIO));
        if (initResult.scopeSize > safeMax) {
          const safeDepth = suggestNarrowerDepth(g, data.origin, data.direction || 'bidirectional', safeMax);
          sess.resetExploration();
          return this.logAndReturn('start_exploration', {
            error: 'scope_exceeds_budget',
            scope_size: initResult.scopeSize,
            max_rounds: maxRounds,
            safe_max_hops: safeMax,
            safe_depth_hint: safeDepth,
            hint: `Scope has ${initResult.scopeSize} nodes; sliding-memory budget allows ~${safeMax} hops (of ${maxRounds} with 30% reserve). Restart with depth=${safeDepth || 1}, narrow the direction, or raise 'dataLineageViz.ai.maxRounds'.`,
            next_action: 'retry_with_smaller_depth',
          }, input);
        }
      }

      if (!sess.classification) {
        const parsed = ClassificationSchema.safeParse(data.classification);
        sess.setClassification(parsed.success ? parsed.data : 'business');
        this.logger.info(`[${sess.id}] [Classification] fired=${sess.classification} (${useInline ? 'inline' : 'SM'} mode, AI-declared)`);
      } else if (data.classification) {
        // Refine round: the AI may re-issue a classification override; honour it.
        const parsed = ClassificationSchema.safeParse(data.classification);
        if (parsed.success && parsed.data !== sess.classification) {
          sess.setClassification(parsed.data);
          this.logger.info(`[${sess.id}] [Classification] refine-override → ${sess.classification}`);
        }
      }

      // Discovery is content-blind: always gate before any analysis runs, regardless of mode.
      // Inline mode (≤10 nodes) used to fall straight through to the hop loop without consent —
      // that hid wrong NL-filter interpretations (e.g. "ignore SPs A,B" → excludeTypes:['procedure']).
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

        engine.setInlineMode(useInline);

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

  public submitFindings(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const sess = this.getSession();
      const engine = sess.stateMachine as NavigationEngine | null;
      if (!engine) return this.logAndReturn('submit_findings', {
        error: 'no_active_session',
        hint: 'No active state machine. Call start_exploration first to begin a hop-by-hop investigation.',
        next_action: 'start_exploration',
      }, input);

      // Mechanical phase guard — symmetric with present_result's resultGraph precondition.
      // Once the engine seals (agenda drained), submit_findings is meaningless; without this
      // guard the AI burns minutes iterating shape variations against the unhelpful Zod hint.
      if (engine.status === 'complete') {
        return this.logAndReturn('submit_findings', {
          error: 'exploration_complete',
          hint: 'Hop loop is closed — every scope node has been analyzed and the archive is sealed. Call lineage_present_result to assemble the final report from the archive. Do not retry submit_findings.',
          next_action: 'present_result',
        }, input);
      }

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
        const lengthViolation = validateSectionLengths(f.sections, f.verdict);
        if (lengthViolation) {
          return this.logAndReturn('submit_findings', {
            error: 'section_too_short',
            hint: lengthViolation,
          }, input);
        }
        const violation = validateSectionsAgainstClassification(f.sections, f.verdict, sess.classification);
        if (violation) {
          return this.logAndReturn('submit_findings', {
            error: 'classification_lock_violation',
            hint: violation,
          }, input);
        }
      }

      // Identifier-match guard: detect slot-hijack where any captured section opens by naming a different scope node than the declared focus. SM mode only (single-entry) — inline batch arrays skip this check.
      if (!Array.isArray(parsed.data)) {
        const hijackedBy = engine.detectFocusSubjectMismatch(parsed.data.focus_node_id, parsed.data.sections ?? []);
        if (hijackedBy) {
          return this.logAndReturn('submit_findings', {
            error: 'focus_subject_mismatch',
            hint: `A captured section opens by naming \`${hijackedBy}\`, but focus_node_id is ${parsed.data.focus_node_id}. Rewrite each section so it describes the focus node.`,
          }, input);
        }
      }

      const result = engine.submitFindings(parsed.data);
      if ('error' in result) return this.logAndReturn('submit_findings', result, input);

      if ('done' in result && result.done && result.result) {
        sess.storeSmResult(result.result);
        // Slim the LM-bound payload: fullNodes[] and edges[] are routing context for
        // active-phase decisions, not synthesis. The agent writes present_result from
        // detail_slots[] alone — every nodeId, schema, and relationship the agent
        // needs is already inside each captured slot.text. The webview/engine still
        // hold the full graph via storeSmResult above.
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
      this.logger.debug(
        `[Hop ${diag.hop}] focus=${diag.focus} schema=${diag.schema} depth=${diag.depth}/${diag.depthBudget ?? '∞'} ` +
        `detail=${diag.detailChars} summary=${diag.summaryChars} authored=${diag.archiveChars} ` +
        `routed=${diag.routedNew}/${diag.routedRejected} agenda=${diag.agendaRemaining}`
      );

      const nextHop = engine.getHopContext();
      if (nextHop.done) {
        const finalResult = engine.getResult();
        sess.storeSmResult(finalResult);
        if (!sess.classification) sess.setClassification('business');
        const synthesisReminder = buildSynthesisReminder();
        // Slim the LM-bound payload for the synthesis transition (see comment above).
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
      const model = this.requireModel();

      if (input.sections !== undefined && !Array.isArray(input.sections)) input.sections = undefined;
      if (input.notes !== undefined && !Array.isArray(input.notes)) input.notes = undefined;
      if (input.add_node_ids !== undefined && !Array.isArray(input.add_node_ids)) input.add_node_ids = undefined;
      if (input.prune_node_ids !== undefined && !Array.isArray(input.prune_node_ids)) input.prune_node_ids = undefined;
      if (input.highlight_groups !== undefined && !Array.isArray(input.highlight_groups)) input.highlight_groups = undefined;

      if (!sess.resultGraph) {
        return this.logAndReturn('present_result', {
          success: false,
          errors: ['No state-machine result available — present_result requires a completed blackboard or column_trace exploration.'],
        }, input);
      }

      let resolvedNodeIds: string[] = [...sess.resultGraph.nodeIds];
      let resolvedEdges: [string, string, string][] = [...sess.resultGraph.edges];
      const graphSource = sess.resultGraph.source;

      if (input.is_update && input.add_node_ids?.length) {
        const currentSet = new Set(resolvedNodeIds);
        const toAdd = input.add_node_ids.filter(id => model.nodes.some(n => n.id === id) && !currentSet.has(id));
        resolvedNodeIds.push(...toAdd);
        const newSet = new Set(resolvedNodeIds);
        resolvedEdges = model.edges
          .filter(e => newSet.has(e.source) && newSet.has(e.target))
          .map(e => [e.source, e.target, edgeApiType(e.type)] as [string, string, string]);
      }

      if (input.prune_node_ids?.length) {
        const pruned = prunePreserveOnly(resolvedNodeIds, resolvedEdges, input.prune_node_ids);
        resolvedNodeIds = pruned.nodeIds;
        resolvedEdges = pruned.edges;
      }

      if (sess.resultGraph.notes?.length) {
        const userNoteIds = new Set((input.notes ?? []).map(n => (n as { node_id: string }).node_id));
        const resolvedSet = new Set(resolvedNodeIds);
        const autoNotes: Array<{ node_id: string; text: string }> = [];
        for (const { nodeId, summary } of sess.resultGraph.notes) {
          if (resolvedSet.has(nodeId) && !userNoteIds.has(nodeId) && summary) {
            autoNotes.push({ node_id: nodeId, text: summary });
          }
        }
        if (autoNotes.length > 0) input.notes = [...(input.notes ?? []), ...autoNotes];
      }

      if (sess.resultGraph.suggested_labels?.length && input.sections?.length) {
        const hasNodeIds = input.sections.some(s => s.node_ids && s.node_ids.length > 0);
        if (!hasNodeIds) {
          const stripNum = (s: string) => s.replace(/^\d+[\.\s]+/, '').trim();
          const labelToNodeIds = new Map<string, string[]>();
          for (const sl of sess.resultGraph.suggested_labels) {
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

      let assembledBadges: Array<{ node_id: string; text: string }> = [];
      let assembledDescription: string | undefined = undefined;
      if (input.sections?.length) {
        const nodeMap = new Map<string, LineageNode>((model.nodes as LineageNode[]).map(n => [n.id, n]));
        const assembled = orderAndAssemble(input.sections, { title: input.title, intro: input.intro, closing: input.closing, nodeMap });
        assembledBadges = assembled.badges;
        assembledDescription = assembled.description;
      }

      const { input: fixedInput } = autoFixPresentResult(model, input, resolvedNodeIds);
      const validation = validatePresentResult(fixedInput, resolvedNodeIds, assembledBadges, assembledDescription);

      if (!validation.success) return this.logAndReturn('present_result', validation, input);

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

      if (input.is_update && sess.resultGraph) {
        sess.resultGraph.nodeIds = resolvedNodeIds;
        sess.resultGraph.edges = resolvedEdges;
        const existingNotes = new Map((sess.resultGraph.notes ?? []).map(n => [n.nodeId, n]));
        for (const n of validation.notes) existingNotes.set(n.node_id, { nodeId: n.node_id, summary: n.text });
        sess.resultGraph.notes = Array.from(existingNotes.values());
      }
      // B-1: persist the synthesized body fields onto resultGraph so `GET /state` carries
      // the full description, not just topology + suggested_*. Pre-fix these fields were
      // only sent transiently to the webview; the persisted resultGraph was empty.
      if (sess.resultGraph) {
        sess.resultGraph.description = validation.description ?? undefined;
        sess.resultGraph.summary = validation.summary ?? undefined;
        sess.resultGraph.title = input.title ?? undefined;
        sess.resultGraph.intro = input.intro ?? undefined;
        sess.resultGraph.closing = input.closing ?? undefined;
        if (Array.isArray(input.sections)) {
          sess.resultGraph.sections = input.sections.map(s => ({
            label: s.label,
            node_ids: s.node_ids,
            text: s.text,
          }));
        }
      }
      sess.lastPresentResultDescription = validation.description ?? null;
      // Signal the button gate in dispatchExit that a graph was built this turn.
      sess.presentResultCalledThisTurn = true;

      this.logger.info(`AI view "${validation.name}" displayed (${validation.node_ids.length} objects)`);
      return this.logAndReturn('present_result', { success: true, view_name: validation.name, node_count: validation.node_ids.length, graph_source: graphSource }, input);
    } catch (err) { return this.toolError('present_result', err); }
  }

  public runBfsTrace(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const { id, upstream_hops, downstream_hops, types, schemas, include_ddl, target } = input;
      const result = runBfsTrace(this.requireModel(), this.requireGraph(), id, upstream_hops ?? 3, downstream_hops ?? 3, types, schemas, include_ddl ?? true, this.getSession().columnStore, target);
      return this.logAndReturn('get_neighborhood', result, input);
    } catch (err) { return this.toolError('get_neighborhood', err); }
  }

  public getObjectDetail(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const inputErr = validateToolInput(input, { id: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { id } = input;
      return this.logAndReturn('get_object_detail', getObjectDetail(this.requireModel(), id, this.getSession().columnStore), input);
    } catch (err) { return this.toolError('get_object_detail', err); }
  }

  public runAnalysis(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const inputErr = validateToolInput(input, { type: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { type, min_degree, max_size } = input;
      const anaCfg = vscode.workspace.getConfiguration('dataLineageViz');
      const resolvedMinDegree = min_degree ?? anaCfg.get<number>('analysis.hubMinDegree');
      const resolvedMaxSize   = max_size   ?? anaCfg.get<number>('analysis.islandMaxSize');
      const resolvedLongestPath = anaCfg.get<number>('analysis.longestPathMinNodes');
      return this.logAndReturn('detect_graph_patterns', runAnalysis(this.requireModel(), this.requireGraph(), type as AnalysisType, resolvedMinDegree, resolvedMaxSize, resolvedLongestPath), input);
    } catch (err) { return this.toolError('detect_graph_patterns', err); }
  }

  public searchDdl(input: any) {
    try {
      if (!this.isAiEnabled()) return this.disabled();
      const inputErr = validateToolInput(input, { query: 'string' });
      if (inputErr) return this.toolResult(inputErr);
      const { query, types } = input;
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
  public getNeighborColumns(input: any) {
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

    vscode.lm.registerTool('lineage_get_neighborhood', {
      prepareInvocation(options, _token) { return { invocationMessage: getToolInvocationLabel('lineage_get_neighborhood', options.input) }; },
      invoke(options, _token) { return handler.runBfsTrace(options.input); },
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
