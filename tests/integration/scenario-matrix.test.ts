import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import type { DatabaseModel } from '../../src/engine/types';
import { extractDacpac } from '../../src/engine/dacpacExtractor';
import { populateColumnStore } from '../../src/engine/modelBuilder';
import { loadRules } from '../../src/engine/sqlBodyParser';
import { parseParseRulesYaml } from '../../src/configCore';
import { buildBareGraph } from '../../src/ai/support/graphUtils';
import { VscodeModelPort } from '../../src/ai/model/vscodeModelPort';
import { LineageRuntime } from '../../src/ai/runtime/lineageRuntime';
import { TurnEventSink, type TurnEvent } from '../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../src/ai/session/session';
import type { NavigationEngine } from '../../src/ai/sm/smBase';
import type { ColumnEdge } from '../../src/ai/sm/smTypes';
import type { IToolRegistry } from '../../src/ai/tools/registry';
import { buildAiToolRegistry } from '../../src/ai/tools/toolProvider';
import { readToolError } from '../../src/ai/support/toolErrorEnvelope';

const TEST_VENDOR = 'lineage-test';
const TEST_MODEL_ID = 'lineage-deterministic-v1';

/**
 * Origin of the T6/T7 exploration and the anchor of every ground-truth cross-check.
 *
 * @remarks
 * Kept as a constant rather than read from the fixture's DEFAULT_CASES: the fixture is scripted
 * MODEL output, so reading the expected origin from it would make the oracle circular. This is the
 * suite's own independent statement of what the run must be about, and it happens to agree with
 * DEFAULT_CASES.T6/T7 — a disagreement is a real finding, not a maintenance chore.
 */
const SM_ORIGIN = '[ai].[FactSalesReport]';
/** The single column T7 traces. Same independence argument as {@link SM_ORIGIN}. */
const CT_TARGET_COLUMN = 'TotalRevenue';

/**
 * Production per-turn hop limit (`DEFAULT_MAX_ROUNDS`, src/ai/core/agentCore.ts).
 *
 * @remarks
 * T6 walks the whole 28-node upstream scope of {@link SM_ORIGIN} one bodied hop at a time. Anything
 * below the real bodied-node count makes `activeCoordinatorNode` take its `state.activeHopCount >=
 * maxRounds` backstop and synthesise a PARTIAL result — which still ends the turn `ok`, so a too-low
 * cap would quietly weaken the completeness oracle instead of failing it. Stated explicitly (rather
 * than left to the `LineageRuntime` default) so that trap is visible at the call site.
 */
const SM_MAX_ROUNDS = 50;

/**
 * The tracked T1-T7 scripted scenario matrix, driven through the production `LineageRuntime`.
 *
 * @remarks
 * The provider fixture (tests/fixtures/lm-provider-extension/extension.js) scripts the MODEL side of
 * each case; this suite asserts the RUNTIME side. That split is the whole point: an oracle that only
 * re-states what the fixture emitted proves nothing, so every assertion below is about something the
 * fixture cannot fake — that the dispatcher ACCEPTED the tool input against its Zod schema, that the
 * provider call id survived the dispatch round trip, that the turn reached a terminal state, that the
 * NavigationEngine was published only after the consent gate, and that the engine's own scope and
 * column chain agree with the structural ground truth extracted from the tracked dacpac.
 *
 * Cases T1-T5 are single discovery-tool turns. T6 (business-blueprint) and T7 (column-trace) are full
 * production loops: sm_entry → consent gate → approve → hop-by-hop analysis → synthesis.
 */
suite('Scenario matrix — scripted T1-T7 over the tracked AdventureWorks dacpac', () => {
  /**
   * Extracted once for the whole suite.
   *
   * @remarks
   * Dacpac extraction is the expensive part (ZIP + XML + body parsing over 148 objects); the per-test
   * `AiSession` around it is cheap. Each test still gets a FRESH session so no discovery transcript,
   * phase, or engine leaks between cases — sharing the model is a cache, not shared mutable state.
   */
  let sharedModel: DatabaseModel;

  suiteSetup(async function () {
    this.timeout(120_000);
    sharedModel = await loadTrackedDacpacModel();
  });

  setup(async () => {
    const fixture = vscode.extensions.getExtension('data-lineage-test.data-lineage-test-model-provider');
    assert.ok(fixture, 'isolated scripted provider fixture must be installed in this Electron lane');
    await fixture.activate();
    await vscode.commands.executeCommand('lineageTestModel.reset');
    await waitForModel();
  });

  teardown(async () => {
    // Leaves the fixture in the legacy no-case state for whatever runs next, so a case selected by
    // one test can never bleed into another test's turn.
    await vscode.commands.executeCommand('lineageTestModel.reset');
  });

  // ── T1-T5: single-tool discovery turns ─────────────────────────────────────
  //
  // The scripted tool and its input come from the fixture's DEFAULT_CASES, which were authored
  // against this exact dacpac — no `setCase` overrides are needed here, and passing any would
  // weaken the case (an override is the caller asserting the model's arguments for it).
  const DISCOVERY_CASES: ReadonlyArray<{
    readonly caseId: string;
    readonly tool: string;
    readonly prompt: string;
  }> = [
    { caseId: 'T1', tool: 'lineage_get_context', prompt: 'Summarise what this loaded snapshot contains before I dig in.' },
    { caseId: 'T2', tool: 'lineage_search_objects', prompt: 'List the objects that live in the ai schema.' },
    { caseId: 'T3', tool: 'lineage_search_ddl', prompt: 'Which object definitions mention raworderimport?' },
    { caseId: 'T4', tool: 'lineage_get_scope_bundle', prompt: 'Show the immediate neighbours of [ai].[RawOrderImport] on both sides.' },
    { caseId: 'T5', tool: 'lineage_get_scope_bundle', prompt: 'Show every upstream source of [ai].[spImportOrders] and its direct consumers.' },
  ];

  for (const { caseId, tool, prompt } of DISCOVERY_CASES) {
    test(`${caseId} dispatches ${tool} once, accepted and correlated, and ends terminal ok`, async function () {
      this.timeout(120_000);
      await vscode.commands.executeCommand('lineageTestModel.setCase', caseId);
      const session = buildDacpacSession(sharedModel);
      const turn = await runTurn(session, { requestId: `scenario-${caseId}`, prompt });

      try {
        assert.strictEqual(turn.result.outcome, 'ok', `${caseId} must end ok (failure: ${JSON.stringify(turn.result.failure)})`);
        assert.strictEqual(terminalStatus(turn.events), 'ok', `${caseId} emits exactly one terminal event and it is ok`);

        // Dispatch acceptance — the runtime contract the fixture cannot fake. The scripted arguments
        // had to survive the tool's own Zod schema AND the handler's semantic validation; a rejection
        // envelope here means the case's input no longer matches this dacpac or the tool contract.
        const dispatches = turn.dispatches.filter(record => record.toolName === tool);
        assert.strictEqual(dispatches.length, 1, `${caseId} dispatches ${tool} exactly once (got ${turn.dispatches.map(d => d.toolName).join(', ')})`);
        assert.strictEqual(
          dispatches[0].rejectionCode,
          null,
          `${caseId}'s ${tool} input is accepted, not rejected (code=${dispatches[0].rejectionCode})`,
        );

        // Correlation — the provider call id the fixture issued must come back TO the provider on a
        // later generation. An accepted observation rides a user-role `<runtime_tool_context>` text
        // block carrying the id; a rejected one rides a native tool-result part. Requiring the text
        // shape AND forbidding the tool-result shape is what makes this an acceptance proof rather
        // than a "something came back" proof.
        const callId = `${caseId}-discover-001`;
        const requests = await providerRequests();
        const parts = requests.flatMap(request => request.messages.flatMap(message => [...message.content]));
        assert.ok(
          parts.some(part => part.type === 'text' && part.value.includes(callId)),
          `${caseId}: the accepted observation for ${callId} is carried back to the provider`,
        );
        assert.ok(
          !parts.some(part => part.type === 'tool-result' && part.callId === callId),
          `${caseId}: ${callId} never rides back as a rejection exchange`,
        );

        // The scripted completion text is the fixture's own end-of-case marker. Asserting it last
        // (after the runtime-owned oracles above) keeps it as a case-identity check — proof the turn
        // that just passed is the case we selected — not as the pass criterion itself.
        assert.ok(
          turn.text.includes(`SCRIPTED_COMPLETE case=${caseId}`),
          `${caseId}: the final answer is the scripted completion for this case (got: ${turn.text.slice(0, 200)})`,
        );
      } finally {
        turn.dispose();
      }
    });
  }

  // ── T6: business-blueprint full loop ───────────────────────────────────────

  test('T6 runs the full BB loop behind the real consent gate and keeps its scope inside ground truth', async function () {
    this.timeout(180_000);
    await vscode.commands.executeCommand('lineageTestModel.setCase', 'T6');
    const session = buildDacpacSession(sharedModel);
    // The leading `/trace` is load-bearing, not decoration: `detectSlashRoute`
    // (src/ai/agent/slashCommands.ts) pins the route from the COMMAND, so `detectEntryNode` returns
    // before it ever calls the structured entry detector. The bracket tokens are two-part node ids,
    // never a three-part column reference, so `parseTraceColumns` yields no columns and the route is
    // the neutral `discovery` verdict with the `slash_trace` trigger — which
    // `selectInitialAgentStage` maps to `sm_entry`. DEFAULT_CASES.T6 has `entry: null` for exactly
    // this reason and the fixture must therefore never be asked for a `structured_output`.
    const turn = await runTurn(session, {
      requestId: 'scenario-T6',
      prompt: `/trace ${SM_ORIGIN} upstream — explain the business logic of every upstream source.`,
      maxRounds: SM_MAX_ROUNDS,
      autoApproveGate: true,
    });

    try {
      assert.strictEqual(turn.result.outcome, 'ok', `T6 must end ok (failure: ${JSON.stringify(turn.result.failure)})`);
      assert.strictEqual(terminalStatus(turn.events), 'ok', 'T6 emits exactly one terminal event and it is ok');

      // The slash route is deterministic, so no entry-detector generation may exist for this turn.
      const requests = await providerRequests();
      assert.ok(
        !requests.some(request => request.tools.some(offered => offered.name === 'structured_output')),
        'T6 pins its route through /trace — the entry detector is never asked',
      );

      // Gate ordering — the invariant the whole approve-gate design exists to hold. Every event up
      // to and INCLUDING the gate must have been observed with `session.stateMachine === null`;
      // `approveGateNode` is the only publisher, and it runs strictly after the interrupt resumes.
      const gateIndex = turn.events.findIndex(record => record.event.type === 'gate');
      assert.ok(gateIndex >= 0, 'T6 reaches the confirm_sm_start consent gate');
      assert.strictEqual(turn.gateApprovals, 1, 'T6 approves exactly one gate');
      for (let i = 0; i <= gateIndex; i += 1) {
        assert.strictEqual(
          turn.events[i].enginePublished,
          false,
          `T6 publishes no NavigationEngine before the gate (event #${i} = ${turn.events[i].event.type})`,
        );
      }
      const engine = turn.engine;
      assert.ok(engine, 'T6 publishes a NavigationEngine after the gate is approved');
      assert.ok(
        turn.events.slice(gateIndex + 1).some(record => record.enginePublished),
        'T6 publishes the engine on the post-gate side of the same turn',
      );

      // The engine's own terminal state — a turn can end `ok` on the partial-result backstop, so the
      // engine status is asserted separately from the turn outcome.
      assert.strictEqual(engine.status, 'complete', `T6's engine reaches its terminal state (got ${engine.status})`);

      // Ground truth: every node the engine kept in scope is genuinely upstream of the origin in the
      // tracked dacpac. This is the fixture-independent half — the fixture routes whatever neighbours
      // the ENGINE hands it, so a scope node outside this set means the engine walked the wrong way.
      const upstream = groundTruthUpstreamSet(SM_ORIGIN);
      const snapshot = engine.toJSON();
      assert.ok(snapshot.scopeNodeIds.length > 1, 'T6 explores more than the origin alone');
      for (const nodeId of snapshot.scopeNodeIds) {
        assert.ok(
          upstream.has(normalizeNodeId(nodeId)),
          `T6 kept ${nodeId} in scope, which is not upstream of ${SM_ORIGIN} in the ground truth`,
        );
      }
      assert.ok(
        snapshot.visited.length > 1,
        `T6 analyses multiple hops (visited ${snapshot.visited.length})`,
      );

      assertPresentResultAccepted(turn, 'T6');
    } finally {
      turn.dispose();
    }
  });

  // ── T7: column-trace full loop ─────────────────────────────────────────────

  test('T7 runs the full CT loop and its column chain is real, origin-anchored, and only ever stranded on a procedure', async function () {
    this.timeout(180_000);
    await vscode.commands.executeCommand('lineageTestModel.setCase', 'T7');
    const session = buildDacpacSession(sharedModel);
    // Deliberately NOT a slash command: T7's route comes from the structured entry detector
    // (DEFAULT_CASES.T7 answers `column_trace` + targetColumns), which is the second of the two
    // routes into SM and the only one that carries locked target columns from the model.
    const turn = await runTurn(session, {
      requestId: 'scenario-T7',
      prompt: `Trace the ${CT_TARGET_COLUMN} column in ${SM_ORIGIN} back to its original sources.`,
      maxRounds: SM_MAX_ROUNDS,
      autoApproveGate: true,
    });

    try {
      assert.strictEqual(turn.result.outcome, 'ok', `T7 must end ok (failure: ${JSON.stringify(turn.result.failure)})`);
      assert.strictEqual(terminalStatus(turn.events), 'ok', 'T7 emits exactly one terminal event and it is ok');

      const gateIndex = turn.events.findIndex(record => record.event.type === 'gate');
      assert.ok(gateIndex >= 0, 'T7 reaches the confirm_sm_start consent gate');
      assert.strictEqual(turn.gateApprovals, 1, 'T7 approves exactly one gate');
      for (let i = 0; i <= gateIndex; i += 1) {
        assert.strictEqual(turn.events[i].enginePublished, false, `T7 publishes no NavigationEngine before the gate (event #${i})`);
      }
      const engine = turn.engine;
      assert.ok(engine, 'T7 publishes a NavigationEngine after the gate is approved');
      assert.strictEqual(engine.status, 'complete', `T7's engine reaches its terminal state (got ${engine.status})`);

      const aspect = engine.columnAspect;
      assert.ok(aspect, 'T7 runs with an active column aspect (CT), not as a BB exploration');
      assert.deepStrictEqual(
        aspect.target_columns,
        [CT_TARGET_COLUMN],
        'T7 locks exactly the requested target column',
      );
      const edges = aspect.edges;
      assert.ok(edges.length > 0, 'T7 accumulates at least one validated column edge');

      // Every edge names a column on BOTH sides — the "columnAspect edges all carry columns" half —
      // and every named column is a REAL column of that object per the ColumnStore. The store is
      // populated straight from the dacpac, so this is a check against the source metadata rather
      // than against anything the engine or the fixture asserted about itself. Procedures and
      // functions expose no columns (`toCols` is empty for them in src/ai/sm/columnTracer.ts), so
      // only positions on objects that actually have a column list are checked.
      for (const edge of edges) {
        assert.ok(edge.from_col.length > 0 && edge.to_col.length > 0, `T7 edge ${describeEdge(edge)} carries columns on both sides`);
        assertRealColumn(session, edge.from_node, edge.from_col, `T7 edge ${describeEdge(edge)}`);
        assertRealColumn(session, edge.to_node, edge.to_col, `T7 edge ${describeEdge(edge)}`);
      }

      // Trace connectivity: follow an edge's TO side forward (`to_node.to_col` becomes some other
      // edge's `from_node.from_col`) until it lands on the traced column at the origin. Walking the
      // consumer side is the right direction because `ColumnEdge` points upstream→downstream by
      // construction (`from_node.from_col → to_node.to_col`, src/ai/sm/smTypes.ts).
      const root = columnKey(SM_ORIGIN, CT_TARGET_COLUMN);
      const consumers = new Map<string, ColumnEdge[]>();
      for (const edge of edges) {
        const key = columnKey(edge.from_node, edge.from_col);
        const bucket = consumers.get(key);
        if (bucket) bucket.push(edge);
        else consumers.set(key, [edge]);
      }
      assert.ok(
        edges.some(edge => columnKey(edge.to_node, edge.to_col) === root),
        `T7 produces the traced column itself — some edge must land on ${root}`,
      );
      const onTrace = edges.filter(edge => reachesRoot(edge, consumers, root));
      assert.ok(onTrace.length > 1, `T7's origin-anchored chain is more than the first hop (got ${onTrace.length} edges)`);

      // KNOWN FIXTURE GAP, asserted rather than tolerated. `ColumnFlowEntry.writes_to` is how a
      // WRITER PROCEDURE's out_col is redirected onto the table column it writes
      // (src/ai/sm/smTypes.ts; resolved in columnTracer.ts's `toNodeId`/`toCol`). The scripted
      // fixture's `buildCtColumnFlow` never emits `writes_to` at all, so every procedure hop's
      // out_col is a pseudo-column that nothing downstream consumes — its whole sub-chain is a dead
      // end by construction of the SCRIPT, not of the engine. Pinning it as "every off-trace chain
      // bottoms out on a procedure" keeps the oracle honest in both directions: it fails if the
      // engine ever strands a chain on a TABLE or VIEW (a real defect), and it also fails once the
      // fixture learns `writes_to`, at which point this block should be replaced by a plain
      // zero-off-trace assertion.
      const nodeTypes = nodeTypeIndex(session);
      const offTrace = edges.filter(edge => !reachesRoot(edge, consumers, root));
      const strandedOnNonProcedure = offTrace.flatMap(edge => chainSinkNodes(edge, consumers)
        .filter(nodeId => nodeTypes.get(normalizeNodeId(nodeId)) !== 'procedure')
        .map(nodeId => `${describeEdge(edge)} strands on ${nodeId} (${nodeTypes.get(normalizeNodeId(nodeId)) ?? 'unknown'})`));
      assert.deepStrictEqual(
        strandedOnNonProcedure,
        [],
        'T7 strands a column chain somewhere other than a writer procedure — that is an engine defect, not the writes_to fixture gap',
      );

      // Terminal sources of the ORIGIN-ANCHORED chain: the from-side columns that no edge produces.
      // They are where the trace this test is about bottoms out, and each must be a real upstream
      // node of the origin per ground truth.
      const producedKeys = new Set(edges.map(edge => columnKey(edge.to_node, edge.to_col)));
      const terminalSources = onTrace
        .filter(edge => !producedKeys.has(columnKey(edge.from_node, edge.from_col)))
        .map(edge => edge.from_node);
      assert.ok(terminalSources.length > 0, 'T7 bottoms out at at least one terminal source column');
      const upstream = groundTruthUpstreamSet(SM_ORIGIN);
      for (const nodeId of new Set(terminalSources.map(normalizeNodeId))) {
        assert.ok(
          upstream.has(nodeId),
          `T7 terminal source ${nodeId} is not upstream of ${SM_ORIGIN} in the ground truth`,
        );
      }

      assertPresentResultAccepted(turn, 'T7');
    } finally {
      turn.dispose();
    }
  });

  // ── Negative control ───────────────────────────────────────────────────────

  test('NEGATIVE CONTROL — a deliberately wrong case origin fails the same oracles T4 passes', async function () {
    this.timeout(120_000);
    // Same case, same prompt, same fixture, ONE changed fact: an origin that does not exist in the
    // dacpac. If this still satisfied T4's oracles, those oracles would be measuring the fixture's
    // willingness to emit a tool call rather than the dispatcher's willingness to accept it.
    await vscode.commands.executeCommand('lineageTestModel.setCase', 'T4', { origin: '[ai].[DoesNotExist]' });
    const session = buildDacpacSession(sharedModel);
    const turn = await runTurn(session, {
      requestId: 'scenario-T4-negative',
      prompt: 'Show the immediate neighbours of [ai].[RawOrderImport] on both sides.',
    });

    try {
      const dispatches = turn.dispatches.filter(record => record.toolName === 'lineage_get_scope_bundle');
      assert.ok(dispatches.length > 0, 'the fixture still attempts the scripted dispatch');
      assert.ok(
        dispatches.every(record => record.rejectionCode !== null),
        'every dispatch of the unresolvable origin is REJECTED by the handler, never accepted',
      );
      assert.strictEqual(dispatches[0].rejectionCode, 'not_found', 'the rejection names the unresolved origin');
      // The turn cannot reach T4's success oracle: discovery requires tool EVIDENCE, and a rejection
      // is not evidence, so the phase exhausts its semantic-failure budget instead of answering.
      assert.notStrictEqual(turn.result.outcome, 'ok', 'the turn does not reach a successful terminal state');
      assert.notStrictEqual(terminalStatus(turn.events), 'ok', 'the terminal event is not ok');
    } finally {
      turn.dispose();
    }
  });

  // ── Legacy guard ───────────────────────────────────────────────────────────

  test('LEGACY GUARD — with no case active the fixture still answers the original scripted sequence', async () => {
    // `setup` already ran `lineageTestModel.reset`, so `activeCase` is null and the fixture must take
    // its original fixed-sequence branch byte-for-byte. This reproduces the first probe of
    // tests/integration/ai-backend.test.ts inside THIS lane so a regression in the case-scripting
    // code above is caught here, in the file that introduced it, rather than only in ai-backend.
    const model = await waitForModel();
    const result = await new VscodeModelPort(model).generateToolTurn({
      messages: [new HumanMessage('Return the scripted backend tool call.')],
      tools: [{
        name: 'lineage_present_result',
        description: 'present snapshot result',
        inputSchema: z.object({ id: z.string() }).strict(),
      }],
      phase: 'synthesis',
    });

    assert.strictEqual((await providerRequests()).length, 1, 'one request reaches the scripted provider for this adapter-only probe');
    assert.strictEqual(result.status, 'completed');
    assert.deepStrictEqual(result.toolCalls[0], {
      valid: true,
      callId: 'scripted-call-001',
      toolName: 'lineage_present_result',
      input: { id: 'snapshot-only' },
    });
  });
});

// ── Turn harness ─────────────────────────────────────────────────────────────

/** One sink event plus whether the session had already published its engine when it was observed. */
interface ObservedEvent {
  readonly event: TurnEvent;
  readonly enginePublished: boolean;
}

/** One registry dispatch, classified exactly as `LineageRuntime`'s own trace instrumentation does. */
interface DispatchRecord {
  readonly toolName: string;
  readonly input: unknown;
  /** `null` when the handler returned a success envelope; otherwise the stable rejection code. */
  readonly rejectionCode: string | null;
}

interface TurnOptions {
  readonly requestId: string;
  readonly prompt: string;
  readonly maxRounds?: number;
  /** Resolves every consent gate through the production `LineageRuntime.resumeGate` seam. */
  readonly autoApproveGate?: boolean;
}

interface TurnObservation {
  readonly result: Awaited<ReturnType<LineageRuntime['run']>>;
  readonly events: readonly ObservedEvent[];
  readonly dispatches: readonly DispatchRecord[];
  /** Concatenated streamed text deltas — the user-visible answer for this turn. */
  readonly text: string;
  /** The first `NavigationEngine` the session published during this turn, captured before any reset. */
  readonly engine: NavigationEngine | null;
  readonly gateApprovals: number;
  dispose(): void;
}

/**
 * Runs one complete production turn and records everything an oracle may read.
 *
 * @remarks
 * Deliberately the WHOLE `LineageRuntime.run` path — entry routing, phase nodes, the LangGraph
 * consent interrupt, and the terminal event — because the lane exists to prove that path, not the
 * pieces around it. Two seams are used, both of which production also uses:
 *
 * - `createRegistry` wraps the canonical registry so each dispatch's accept/reject verdict is
 *   observable. This mirrors `instrumentRegistry` in src/ai/runtime/lineageRuntime.ts, including its
 *   `readToolError` classification, so the recorded verdict is the same one production traces.
 * - The gate is resolved by calling `runtime.resumeGate(gateId, { kind: 'approve', classes: [] })`
 *   from the sink consumer — the exact call `LineageParticipant.submitGateDecision` makes for the
 *   `dataLineageViz.aiResumeNativeGate` approve action, with the same default empty class list.
 *   `session.activatePendingExploration` is NOT called directly here: doing so would skip
 *   `approveGateNode` and hide the very ordering invariant T6/T7 assert.
 *
 * `resumeGate` is fire-and-forget because it resolves only after the owning turn reaches terminal
 * state — awaiting it inside the consumer would deadlock the turn that is waiting on the decision.
 */
async function runTurn(session: AiSession, options: TurnOptions): Promise<TurnObservation> {
  const output = vscode.window.createOutputChannel(`lineage scenario ${options.requestId}`, { log: true }) as vscode.LogOutputChannel;
  const events: ObservedEvent[] = [];
  const dispatches: DispatchRecord[] = [];
  let text = '';
  let engine: NavigationEngine | null = null;
  let gateApprovals = 0;

  const runtime = new LineageRuntime({
    getSession: () => session,
    createRegistry: lease => recordingRegistry(
      buildAiToolRegistry(() => session, output, () => undefined, lease),
      dispatches,
    ),
    ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
  });

  const sink = new TurnEventSink(event => {
    // Read BEFORE reacting: the ordering oracle needs the session state as it was when the event was
    // emitted, and approving the gate below would otherwise publish the engine first.
    const enginePublished = session.stateMachine !== null;
    if (!engine && session.stateMachine) engine = session.stateMachine as NavigationEngine;
    events.push({ event, enginePublished });
    if (event.type === 'text') text += event.delta;
    if (event.type === 'gate' && options.autoApproveGate) {
      gateApprovals += 1;
      void runtime.resumeGate(event.gateId, { kind: 'approve', classes: [] }).catch(() => {});
    }
  });

  const result = await runtime.run({
    model: new VscodeModelPort(await waitForModel()),
    request: { id: options.requestId, prompt: options.prompt },
    sink,
  });
  // A post-run read catches an engine published by a node that emitted no further event.
  if (!engine && session.stateMachine) engine = session.stateMachine as NavigationEngine;

  return {
    result,
    events,
    dispatches,
    text,
    engine,
    gateApprovals,
    dispose: () => output.dispose(),
  };
}

/** Wraps a registry so every dispatch's accept/reject verdict is recorded, changing no behaviour. */
function recordingRegistry(inner: IToolRegistry<string>, log: DispatchRecord[]): IToolRegistry<string> {
  return {
    register: tool => inner.register(tool),
    getTools: () => inner.getTools(),
    get: name => inner.get(name),
    has: name => inner.has(name),
    invoke: async (name, input) => {
      const result = await inner.invoke(name, input);
      log.push({ toolName: name, input, rejectionCode: parseRejectionCode(result) });
      return result;
    },
  };
}

/** Mirrors `parseRejectionCode` in src/ai/runtime/lineageRuntime.ts so both read one envelope contract. */
function parseRejectionCode(result: string): string | null {
  try {
    return readToolError(JSON.parse(result) as unknown)?.code ?? null;
  } catch {
    return null;
  }
}

/** The single claimed terminal status of a turn, or `null` when none was emitted. */
function terminalStatus(events: readonly ObservedEvent[]): string | null {
  const terminals = events.filter(record => record.event.type === 'terminal');
  assert.ok(terminals.length <= 1, `the sink claims at most one terminal event (got ${terminals.length})`);
  const terminal = terminals[0]?.event;
  return terminal && terminal.type === 'terminal' ? terminal.status : null;
}

/** Asserts the SM turn committed its rendered result through an accepted `present_result` dispatch. */
function assertPresentResultAccepted(turn: TurnObservation, caseId: string): void {
  const presented = turn.dispatches.filter(record => record.toolName === 'lineage_present_result');
  assert.ok(presented.length > 0, `${caseId} dispatches lineage_present_result at synthesis`);
  assert.ok(
    presented.some(record => record.rejectionCode === null),
    `${caseId}'s present_result is accepted (codes: ${presented.map(record => record.rejectionCode).join(', ')})`,
  );
}

// ── Model / session fixtures ────────────────────────────────────────────────

/** Repository root, resolved from the compiled test's location (`out/test/tests/integration`). */
function repoPath(...segments: string[]): string {
  return resolve(__dirname, '..', '..', '..', '..', ...segments);
}

/**
 * Extracts the tracked AdventureWorks dacpac through the production extractor.
 *
 * @remarks
 * The parse rules must be loaded FIRST: without them `parseSqlBody` recovers far fewer dependencies,
 * the edge count falls below the ground-truth baseline, and T6's scope oracle would then pass on a
 * graph that is merely smaller rather than correct. `assets/defaultParseRules.yaml` is the same file
 * `extensionRuntime.ts` reads at activation, parsed through the same `parseParseRulesYaml`.
 */
async function loadTrackedDacpacModel(): Promise<DatabaseModel> {
  loadRules(parseParseRulesYaml(readFileSync(repoPath('assets', 'defaultParseRules.yaml'), 'utf8')));
  const buffer = readFileSync(repoPath('tests', 'fixtures', 'AdventureWorks2025_AI.dacpac'));
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  return await extractDacpac(bytes);
}

/**
 * Builds one session over the shared model, exactly as a real model load leaves it.
 *
 * @remarks
 * Reproduces the three session-facing effects of `applyModelToSession`
 * (src/bridge/messageHandlers.ts) — populated column store, installed model, bare graph — and omits
 * only its webview/`setContext` side effects, which no tool reads. The column store is not optional
 * scenery: CT resolves every candidate column through it, so T7 cannot run without it.
 */
function buildDacpacSession(model: DatabaseModel): AiSession {
  const session = new AiSession();
  populateColumnStore(model, session.columnStore);
  session.model = model;
  session.graph = buildBareGraph(model);
  return session;
}

// ── Ground truth ─────────────────────────────────────────────────────────────

/** Shape of the fields this suite reads from tests/fixtures/ai-graph-groundtruth.json. */
interface GroundTruth {
  readonly upstreamSets: Readonly<Record<string, readonly string[]>>;
}

let groundTruthCache: GroundTruth | null = null;

/**
 * The verified upstream closure of `nodeId`, as normalized comparison keys.
 *
 * @remarks
 * The tracked baseline stores ids already lowercased and INCLUDES the origin itself, which is what
 * the engine's own `scopeNodeIds` does too — so the set is used as-is rather than adjusted, and a
 * missing origin would be a real mismatch.
 */
function groundTruthUpstreamSet(nodeId: string): ReadonlySet<string> {
  const truth = groundTruthCache ??= JSON.parse(
    readFileSync(repoPath('tests', 'fixtures', 'ai-graph-groundtruth.json'), 'utf8'),
  ) as GroundTruth;
  const key = normalizeNodeId(nodeId);
  const entry = Object.entries(truth.upstreamSets)
    .find(([id]) => normalizeNodeId(id) === key)?.[1];
  assert.ok(entry, `ai-graph-groundtruth.json carries an upstream set for ${nodeId}`);
  return new Set(entry.map(normalizeNodeId));
}

/** Case/bracket-insensitive node-id key (mirrors `normalizeSqlName`, src/ai/sm/smCompleteness.ts). */
function normalizeNodeId(id: string): string {
  return id.replace(/\[|\]/g, '').toLowerCase();
}

/** Comparison key for one `node.column` position in the column chain. */
function columnKey(nodeId: string, column: string): string {
  return `${normalizeNodeId(nodeId)}.${column.toLowerCase()}`;
}

/**
 * Whether `edge`'s consumer side reaches `root` by following further column edges downstream.
 *
 * @remarks
 * Cycle-safe by construction: a column position already on the walk is never expanded twice, so a
 * self-referential chain terminates as unreachable instead of hanging the lane.
 */
function reachesRoot(edge: ColumnEdge, consumers: ReadonlyMap<string, ColumnEdge[]>, root: string): boolean {
  const seen = new Set<string>();
  const queue = [columnKey(edge.to_node, edge.to_col)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === root) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of consumers.get(current) ?? []) {
      queue.push(columnKey(next.to_node, next.to_col));
    }
  }
  return false;
}

/**
 * The node ids where `edge`'s consumer chain runs out of consumers — where the chain bottoms out.
 *
 * @remarks
 * Same cycle-safe walk as {@link reachesRoot}, but it reports the dead ends instead of a boolean, so
 * a stranded chain can be attributed to the object that stranded it.
 */
function chainSinkNodes(edge: ColumnEdge, consumers: ReadonlyMap<string, ColumnEdge[]>): string[] {
  const seen = new Set<string>();
  const sinks: string[] = [];
  const queue: Array<{ readonly key: string; readonly nodeId: string }> = [
    { key: columnKey(edge.to_node, edge.to_col), nodeId: edge.to_node },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.key)) continue;
    seen.add(current.key);
    const next = consumers.get(current.key) ?? [];
    if (next.length === 0) sinks.push(current.nodeId);
    for (const consumer of next) {
      queue.push({ key: columnKey(consumer.to_node, consumer.to_col), nodeId: consumer.to_node });
    }
  }
  return sinks;
}

/** Readable one-line identity for a column edge, used in every T7 failure message. */
function describeEdge(edge: ColumnEdge): string {
  return `hop ${edge.hop} @${edge.hop_node}: ${edge.from_node}.${edge.from_col} → ${edge.to_node}.${edge.to_col}`;
}

/** Normalized node id → object type, read from the loaded model rather than inferred from names. */
function nodeTypeIndex(session: AiSession): ReadonlyMap<string, string> {
  return new Map((session.model?.nodes ?? []).map(node => [normalizeNodeId(node.id), node.type]));
}

/**
 * Asserts `column` is a real column of `nodeId` per the session's ColumnStore.
 *
 * @remarks
 * Silently satisfied for an object with no stored column list — procedures and functions expose
 * none, and their `column_flow` positions are pseudo-columns (parameters or writer targets) that no
 * source metadata can confirm.
 */
function assertRealColumn(session: AiSession, nodeId: string, column: string, context: string): void {
  const columns = session.columnStore.getColumns(nodeId);
  if (!columns || columns.length === 0) return;
  assert.ok(
    columns.some(candidate => candidate.name.toLowerCase() === column.toLowerCase()),
    `${context}: "${column}" is not a real column of ${nodeId} (has: ${columns.map(c => c.name).join(', ')})`,
  );
}

// ── Public language-model API access ─────────────────────────────────────────

function publicLanguageModelApi(): {
  selectChatModels(selector: { vendor: string; id: string }): Thenable<readonly vscode.LanguageModelChat[]>;
} {
  // Same compatibility cast as tests/integration/ai-backend.test.ts: the repository's stable 1.101
  // typings stay unchanged, and the pinned 1.130 Electron host supplies this public API.
  return vscode.lm as unknown as ReturnType<typeof publicLanguageModelApi>;
}

async function waitForModel(): Promise<vscode.LanguageModelChat> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const models = await publicLanguageModelApi().selectChatModels({ vendor: TEST_VENDOR, id: TEST_MODEL_ID });
    if (models.length === 1) return models[0];
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('scripted language model was not available from the public VS Code API');
}

/** The three part shapes `normalizePart` in the provider fixture produces. */
type ProviderContentPart =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'tool-call'; readonly callId: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool-result'; readonly callId: string; readonly content: readonly ProviderContentPart[] };

interface ProviderRequest {
  readonly messages: ReadonlyArray<{ readonly role: number; readonly content: readonly ProviderContentPart[] }>;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly schema: unknown }>;
  readonly toolMode: unknown;
}

async function providerRequests(): Promise<readonly ProviderRequest[]> {
  return await vscode.commands.executeCommand('lineageTestModel.getRequests') as readonly ProviderRequest[];
}
