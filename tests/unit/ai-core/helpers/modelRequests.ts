/** Request-assembly seam: renders the model requests the agent graph assembles for the AdventureWorks AI fixture, committing scripted findings through the registered tools instead of a model. */
import type Graph from 'graphology';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import * as vscode from 'vscode';
import { createHarnessSession, repoPath } from '../../../harness/sessionFactory';
import { buildActiveHopInstruction, buildActiveInstruction, buildSynthesisInstruction } from '../../../../src/ai/agent/stagePrompts';
import { buildSynthesisEnvelopeMessage } from '../../../../src/ai/agent/graph';
import { executeToolAttempt } from '../../../../src/ai/agent/toolAttempt';
import { VscodeModelPort } from '../../../../src/ai/model/vscodeModelPort';
import { compileInstructionPlan, explorationFacts, type ConversePlanDraft } from '../../../../src/ai/agent/instructionPlan';
import { deriveStagePromptContext } from '../../../../src/ai/prompting/hostPrompts';
import { buildSmCompletionEnvelope } from '../../../../src/ai/prompting/smPrompts';
import { readToolErrorText, type ToolRejection } from '../../../../src/ai/support/toolErrorEnvelope';
import { TurnEventSink } from '../../../../src/ai/runtime/turnEventSink';
import type { ClassificationValue } from '../../../../src/ai/session/classification';
import { AiSession } from '../../../../src/ai/session/session';
import type { DatabaseModel } from '../../../../src/engine/types';
import { NavigationEngine } from '../../../../src/ai/sm/smBase';
import type { InvestigationTask, NavigationInitParams, ScopeSummary } from '../../../../src/ai/sm/smTypes';
import { toModelJsonSchema } from '../../../../src/ai/tools/jsonSchema';
import type { ToolRegistry } from '../../../../src/ai/tools/registry';
import { buildAiToolRegistry } from '../../../../src/ai/tools/toolProvider';
import { activeModeOf } from '../../../../src/ai/tools/toolPolicy';

/** One tool as the model port serves it: name, description and the JSON Schema of its input. */
export interface ServedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** One model request: the system prompt, the user message and the tools served with it. */
export interface ModelRequest {
  readonly system: string;
  readonly message: string;
  readonly tools: readonly ServedTool[];
}

/** A scripted hop commit: findings for `lineage_submit_findings` (optionally preceded by `refused`, an invalid submission the backend must reject), or the reason for `lineage_prune_current`. */
export type ScriptedHop = { readonly submit: object; readonly refused?: object } | { readonly prune: string };

/** The request of one hop with the engine facts it was assembled from. */
export interface HopRecord {
  readonly focus: string;
  readonly request: ModelRequest;
  /** The hop's tasks as the engine held them when the request was assembled. */
  readonly tasks: readonly InvestigationTask[];
  /** Ids the engine had visited or removed when the request was assembled. */
  readonly closed: ReadonlySet<string>;
  /** The rejection the backend returned for the hop's scripted `refused` submission, with the input it answered. */
  readonly refusal?: { readonly input: object; readonly rejection: ToolRejection };
}

/** A fixture session with the production tool registry bound to it. */
export interface FixtureWalk {
  readonly session: AiSession;
  readonly registry: ToolRegistry<string>;
  engine: NavigationEngine | null;
}

/** Loads the AdventureWorks AI dacpac with the shipped parse rules and output templates. */
export async function openFixtureWalk(): Promise<FixtureWalk> {
  const { session } = await createHarnessSession({ dacpacPath: repoPath('tests', 'fixtures', 'AdventureWorks2025_AI.dacpac'), contextWindow: 128_000 });
  const silent = { info() {}, debug() {}, warn() {}, error() {} };
  const registry = buildAiToolRegistry(() => session, silent as never, () => undefined) as unknown as ToolRegistry<string>;
  return { session, registry, engine: null };
}

/** A session over a synthetic model with the production tool registry bound to it; no output templates are loaded, so only hop messages and tools are assembled from it. */
export function openModelWalk(model: DatabaseModel, graph: Graph): FixtureWalk {
  const session = new AiSession();
  session.model = model;
  session.graph = graph;
  const silent = { info() {}, debug() {}, warn() {}, error() {} };
  const registry = buildAiToolRegistry(() => session, silent as never, () => undefined) as unknown as ToolRegistry<string>;
  return { session, registry, engine: null };
}

/** The grounding context every host prompt of the loaded model carries. */
export const promptContext = (walk: FixtureWalk) => deriveStagePromptContext(walk.session.model, walk.session.filter, walk.session.uiState);

/** Starts the approved exploration as the graph's approval node does. */
export function startWalk(walk: FixtureWalk, init: NavigationInitParams, classification: ClassificationValue, discoverySummary?: string): NavigationEngine {
  const { session } = walk;
  const epoch = session.beginTurn();
  const engine = new NavigationEngine(session.model!, session.graph!, () => {}, {}, session.columnStore);
  engine.classification = classification;
  if (!('ok' in engine.init(init))) throw new Error('The scripted exploration was refused at init.');
  session.setClassification(classification);
  engine.publishMemoryTo(session.memory);
  if (discoverySummary) engine.setDiscoverySummary(discoverySummary);
  session.stateMachine = engine;
  session.enterExploring(epoch);
  walk.engine = engine;
  return engine;
}

/** The tools one plan draft serves, as the model port projects them. */
export function servedTools(walk: FixtureWalk, draft: Omit<ConversePlanDraft, 'kind' | 'registry' | 'sink' | 'messages'>): ServedTool[] {
  const plan = compileInstructionPlan({ kind: 'converse', registry: walk.registry, sink: new TurnEventSink(() => {}), messages: [], ...draft });
  return plan.input.registry.getTools().map(tool => ({
    name: tool.name,
    description: tool.modelDescription || tool.tags?.join(', ') || tool.name,
    inputSchema: toModelJsonSchema(tool.inputSchema),
  }));
}

/** The user message of the dispatched hop. */
export function hopMessage(walk: FixtureWalk): string {
  return buildActiveHopInstruction(walk.session, walk.engine!, walk.engine!.currentFocus!).message;
}

/** The plan draft of the dispatched hop: the stage, facts and terminal tool its model request is built from. */
function hopDraft(walk: FixtureWalk): Omit<ConversePlanDraft, 'kind' | 'registry' | 'sink' | 'messages'> {
  const { session, engine } = walk;
  const mode = engine!.currentHopAnalysisMode;
  return {
    stage: { kind: 'active', mode: activeModeOf(mode === 'ct') },
    facts: explorationFacts(mode, mode === 'ct' ? engine!.currentTargetColumns ?? undefined : undefined, { classification: session.requireLockedClassification() }),
    toolChoice: 'required',
    requiredTerminalTool: 'lineage_submit_findings',
    hopColumns: () => engine!.hopSubmitColumns,
    canPruneCurrent: () => engine!.canPruneCurrent,
  };
}

/** The tools served with the dispatched hop. */
export function hopTools(walk: FixtureWalk): ServedTool[] {
  return servedTools(walk, hopDraft(walk));
}

/** One provider reply to the dispatched hop through the production dispatcher: a submit call with `reply` as its arguments, or plain text when `reply` is a string. Returns the rejection the model reads, or null when the dispatcher accepted the call. */
export async function hopReply(walk: FixtureWalk, reply: object | string): Promise<ToolRejection | null> {
  const plan = compileInstructionPlan({ kind: 'converse', registry: walk.registry, sink: new TurnEventSink(() => {}),
    messages: [new HumanMessage('Inspect the current object.')], ...hopDraft(walk) });
  const part = typeof reply === 'string' ? new vscode.LanguageModelTextPart(reply) : new vscode.LanguageModelToolCallPart('reply', 'lineage_submit_findings', reply);
  const sendRequest = async () => ({ stream: { async *[Symbol.asyncIterator]() { yield part; } } });
  const port = new VscodeModelPort({ id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1', maxInputTokens: 128_000, countTokens: async () => 1, sendRequest } as never);
  const attempt = await executeToolAttempt(port, plan);
  const answer = attempt.messages.find((message): message is ToolMessage => message instanceof ToolMessage);
  return (answer?.artifact as ToolRejection | undefined) ?? attempt.rejections[0] as ToolRejection | undefined ?? null;
}

/** The request of the dispatched hop, assembled as the graph's active worker assembles it. */
function activeRequest(walk: FixtureWalk): ModelRequest {
  const { session, engine } = walk;
  return { system: buildActiveInstruction(session, promptContext(walk), engine!.currentHopAnalysisMode).system, message: hopMessage(walk), tools: hopTools(walk) };
}

/** The synthesis request of the completed exploration, assembled as the graph's synthesis node assembles it. */
function synthesisRequest(walk: FixtureWalk): ModelRequest {
  const { session, engine } = walk;
  const envelope = buildSmCompletionEnvelope(engine!.getResult(), session.memory.getUserQuestion(), engine!.identifierCaseSensitive, engine!.deferredQuestions);
  const tools = servedTools(walk, {
    stage: { kind: 'synthesis' },
    facts: explorationFacts(engine!.currentAnalysisMode, engine!.currentTargetColumns ?? undefined, { classification: session.requireLockedClassification() }),
    toolChoice: 'required',
    requiredTerminalTool: 'lineage_present_result',
  });
  return { system: buildSynthesisInstruction(session, promptContext(walk)).system, message: buildSynthesisEnvelopeMessage(envelope), tools };
}

/** Walks an approved exploration to completion: each hop is assembled, then committed from `script` through the registered tools. */
export async function driveWalk(
  walk: FixtureWalk,
  init: NavigationInitParams,
  classification: ClassificationValue,
  script: Readonly<Record<string, ScriptedHop>>,
  discoverySummary?: string,
): Promise<{ readonly scope: ScopeSummary; readonly hops: HopRecord[]; readonly synthesis: ModelRequest }> {
  const engine = startWalk(walk, init, classification, discoverySummary);
  const scope = engine.getScopeSummary();
  const hops: HopRecord[] = [];
  engine.getHopContext();
  while (engine.status === 'awaiting_findings') {
    const focus = engine.currentFocus!;
    const hop = script[focus];
    if (!hop) throw new Error(`No scripted commit for ${focus}.`);
    const { visited, removedSet } = engine.toJSON();
    const record = { focus, request: activeRequest(walk), tasks: structuredClone(engine.getCurrentTasks()) as InvestigationTask[], closed: new Set([...visited, ...removedSet]) };
    let refusal: HopRecord['refusal'];
    if ('submit' in hop && hop.refused) {
      const rejection = readToolErrorText(await walk.registry.invoke('lineage_submit_findings', hop.refused));
      if (!rejection) throw new Error(`The scripted refused submission for ${focus} was not rejected.`);
      refusal = { input: hop.refused, rejection };
    }
    hops.push(refusal ? { ...record, refusal } : record);
    const input = 'submit' in hop ? hop.submit : { reason: hop.prune };
    const result = JSON.parse(await walk.registry.invoke('submit' in hop ? 'lineage_submit_findings' : 'lineage_prune_current', input)) as { ok?: boolean };
    if (!result.ok) throw new Error(`The scripted commit for ${focus} was rejected: ${JSON.stringify(result)}`);
  }
  if (engine.status !== 'complete') throw new Error(`The exploration ended in status ${engine.status}.`);
  return { scope, hops, synthesis: synthesisRequest(walk) };
}
