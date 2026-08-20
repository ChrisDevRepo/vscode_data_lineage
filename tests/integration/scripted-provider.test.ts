import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import type { DatabaseModel } from '../../src/engine/types';
import { VscodeModelPort } from '../../src/ai/model/vscodeModelPort';
import { LineageRuntime } from '../../src/ai/runtime/lineageRuntime';
import { TurnEventSink } from '../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../src/ai/session/session';
import { NavigationEngine } from '../../src/ai/sm/smBase';
import { buildAiToolRegistry } from '../../src/ai/tools/toolProvider';
import { buildBareGraph } from '../../src/ai/support/graphUtils';
import { announceLaneTier } from './laneTier';

const TEST_VENDOR = 'lineage-test';
const TEST_MODEL_ID = 'lineage-deterministic-v1';

suite('Scripted provider — runtime wiring through the public vscode.lm API', () => {
  suiteSetup(() => announceLaneTier(
    'scripted-provider',
    'scripted',
    'the selected model is used once with no fallback, and the NavigationEngine is published only after the consent gate',
  ));

  setup(async () => {
    const fixture = vscode.extensions.getExtension('data-lineage-test.data-lineage-test-model-provider');
    assert.ok(fixture, 'isolated scripted provider fixture must be installed in this Electron lane');
    await fixture.activate();
    await vscode.commands.executeCommand('lineageTestModel.reset');
    await waitForModel();
  });

  test('uses the public selected scripted model exactly once without credentials or fallback', async () => {
    assert.strictEqual(process.env.AZURE_API, undefined);
    assert.strictEqual(process.env.OPENAI_API, undefined);
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

    assert.strictEqual(
      (await providerRequests()).length,
      1,
      'one request reaches the exact selected provider for this adapter-only probe',
    );
    assert.strictEqual(result.status, 'completed');
    assert.deepStrictEqual(result.toolCalls[0], {
      valid: true,
      callId: 'scripted-call-001',
      toolName: 'lineage_present_result',
      input: { id: 'snapshot-only' },
    });
  });

  test('constructs the production LineageRuntime with the canonical dispatcher and carries a correlated tool result', async function () {
    this.timeout(60_000);
    const session = snapshotSession();
    const output = vscode.window.createOutputChannel('lineage scripted runtime', { log: true }) as vscode.LogOutputChannel;
    const events: unknown[] = [];
    const runtime = new LineageRuntime({
      getSession: () => session,
      createRegistry: lease => buildAiToolRegistry(() => session, output, () => undefined, lease),
      maxRounds: 1,
    });
    try {
      const model = await waitForModel();
      const result = await runtime.run({
        model: new VscodeModelPort(model),
        request: { id: 'scripted-runtime-001', prompt: 'Find Orders in the loaded snapshot.' },
        sink: new TurnEventSink(event => events.push(event)),
      });

      assert.strictEqual(result.outcome, 'ok');
      assert.ok(events.some(event => (event as { type?: string }).type === 'terminal'));
      const requests = await providerRequests();
      // Three provider generations are mandatory for this scripted turn: the structured entry
      // detector, the discovery generation that emits `search-001`, and the discovery generation
      // that reads the dispatched result back and finishes. Anything fewer means a phase was
      // skipped; anything more means the discovery attempt loop retried.
      assert.ok(requests.length >= 3, 'entry detector, dispatcher call, and correlated follow-up are provider-visible');
      const last = requests.at(-1);
      assert.ok(last, 'the scripted provider recorded at least one request');
      // Correlation proof: the provider call ID the fixture issued for `lineage_search_objects`
      // must come back to the provider on the follow-up generation. An accepted observation rides
      // a user-role `<runtime_tool_context>` block carrying `"callId":"search-001"`; a rejected one
      // rides a native tool-result part. Either shape proves the ID survived the dispatch.
      const correlated = last.messages
        .flatMap(message => [...message.content])
        .some(part => (part.type === 'tool-result' && part.callId === 'search-001')
          || (part.type === 'text' && part.value.includes('search-001')));
      assert.ok(correlated, 'the direct dispatcher result keeps the provider call ID into the follow-up');
    } finally {
      output.dispose();
    }
  });

  test('lineage_start_exploration stops at the consent gate without publishing a NavigationEngine', async () => {
    const session = snapshotSession();
    // start_exploration is an SM_ENTRY tool, not a DISCOVERY tool (src/ai/tools/toolPolicy.ts).
    session.activeLmStage = { kind: 'sm_entry' };
    const output = vscode.window.createOutputChannel('lineage scripted mutation', { log: true }) as vscode.LogOutputChannel;
    try {
      const result = await startExploration(session, output);
      const payload = JSON.parse(result) as { error?: string; gate?: string; proposalRevision?: number };

      assert.strictEqual(payload.error, 'action_required', 'the mutation pauses the tool call at the gate');
      assert.strictEqual(payload.gate, 'confirm_sm_start', 'the gate is the SM-start consent gate');
      assert.ok(session.pendingExploration, 'the proposal is stored on the session for the gate to review');
      assert.strictEqual(session.pendingExploration?.revision, 1, 'the first proposal of a turn is revision 1');
      assert.strictEqual(payload.proposalRevision, 1, 'the gate payload carries the stored proposal revision');
      assert.strictEqual(
        session.stateMachine,
        null,
        'the engine is committed only by gate approval, never by the tool call itself',
      );
    } finally {
      output.dispose();
    }
  });

  test('gate approval activates the stored proposal and publishes the NavigationEngine', async () => {
    const session = snapshotSession();
    session.activeLmStage = { kind: 'sm_entry' };
    const output = vscode.window.createOutputChannel('lineage scripted approval', { log: true }) as vscode.LogOutputChannel;
    try {
      const epoch = session.beginTurn();
      await startExploration(session, output, epoch);
      const proposal = session.pendingExploration;
      assert.ok(proposal, 'the gate cannot be approved without a stored proposal');

      // Mirrors approveGateNode (src/ai/agent/graph.ts) — the only committer of session.stateMachine.
      const activation = session.activatePendingExploration(proposal.revision, epoch, candidateProposal => {
        const candidate = new NavigationEngine(
          session.model!,
          session.graph!,
          () => undefined,
          { activeFilter: candidateProposal.activeFilter },
          session.columnStore,
        );
        candidate.sessionId = session.id;
        candidate.classification = candidateProposal.classification;
        const initialized = candidate.init(candidateProposal.init);
        if ('error' in initialized) return { error: initialized.error };
        return candidate;
      });

      assert.strictEqual(
        activation.kind,
        'accepted',
        `activation must commit the reviewed proposal (got ${JSON.stringify(activation)})`,
      );
      assert.ok(session.stateMachine, 'NavigationEngine is published only after the gate is approved');
      assert.strictEqual(session.pendingExploration, null, 'the activated proposal is cleared from the session');
    } finally {
      output.dispose();
    }
  });

  test('refines the pending 28-node proposal in place and preserves untouched fields', async () => {
    const session = scopeRefinementSession();
    session.activeLmStage = { kind: 'sm_entry' };
    const output = vscode.window.createOutputChannel('lineage scripted refinement', { log: true }) as vscode.LogOutputChannel;
    try {
      const epoch = session.beginTurn();
      const initialResult = await invokeStartExploration(session, output, epoch, {
        origin: '[ai].[FactSalesReport]',
        question: 'What are all upstream sources feeding FactSalesReport?',
        mission_brief: 'Explain the business logic transforming every upstream source.',
        analysisMode: 'bb',
        direction: 'upstream',
        depth: 'all',
        classification: 'business',
      });
      const initialPayload = JSON.parse(initialResult) as { detail: string; proposalRevision: number };
      const initial = session.pendingExploration;
      assert.ok(initial, 'the initial proposal is pending');
      assert.strictEqual(initial.revision, 1);
      assert.strictEqual(initial.summary.scopeCount, 28);
      assert.strictEqual(initialPayload.proposalRevision, 1);
      assert.ok(!initialPayload.detail.includes('more)'), 'all 28 object names are rendered without truncation');
      for (const node of session.model!.nodes) {
        assert.ok(initialPayload.detail.includes(node.name), `initial gate renders ${node.name}`);
      }

      session.enterGate({
        gate: 'confirm_sm_start',
        classes: [],
        nodeIds: [],
        detail: initialPayload.detail,
        proposalRevision: 1,
      }, epoch);
      const revisedResult = await invokeStartExploration(session, output, epoch, {
        proposalRevision: 1,
        excludeNodeIds: ['[ai].[DimCalendar]'],
      });
      const revisedPayload = JSON.parse(revisedResult) as { detail: string; proposalRevision: number };
      const revised = session.pendingExploration;
      assert.ok(revised, 'the revised proposal remains pending for approval');
      assert.strictEqual(revised.revision, 2);
      assert.strictEqual(revisedPayload.proposalRevision, 2);
      assert.strictEqual(revised.summary.scopeCount, 27);
      assert.ok(revisedPayload.detail.includes('**27 nodes in scope**'));
      assert.ok(revisedPayload.detail.includes('**Active filters**'));
      assert.ok(revisedPayload.detail.includes('[ai].[DimCalendar]'));
      assert.strictEqual(session.stateMachine, null, 'refinement does not publish a NavigationEngine');

      const { excludeNodeIds: _initialExcluded, ...initialUntouched } = initial.init;
      const { excludeNodeIds: revisedExcluded, ...revisedUntouched } = revised.init;
      assert.deepStrictEqual(revisedUntouched, initialUntouched, 'all untouched init fields are byte-for-byte stable');
      assert.deepStrictEqual(revisedExcluded, ['[ai].[DimCalendar]']);
      assert.deepStrictEqual(revised.activeFilter, initial.activeFilter, 'the original GUI filter snapshot is preserved');
      assert.strictEqual(revised.classification, initial.classification);

      const validRevision = JSON.stringify(revised);
      for (const [label, input, expectedError] of [
        ['stale revision', { proposalRevision: 1, excludeNodeIds: ['[ai].[PriceMaster]'] }, 'stale_proposal_revision'],
        ['no-op patch', { proposalRevision: 2, excludeNodeIds: ['[ai].[DimCalendar]'] }, 'no_op_refine'],
        ['unknown object', { proposalRevision: 2, excludeNodeIds: ['[ai].[DoesNotExist]'] }, 'unknown_node_ids'],
      ] as const) {
        const failedResult = await invokeStartExploration(session, output, epoch, input);
        assert.strictEqual(JSON.parse(failedResult).error, expectedError, `${label} returns its stable rejection code`);
        assert.strictEqual(JSON.stringify(session.pendingExploration), validRevision, `${label} preserves revision 2 unchanged`);
      }
    } finally {
      output.dispose();
    }
  });
});

/** Invokes the canonical registry mutation exactly as the graph dispatcher does. */
async function startExploration(
  session: AiSession,
  output: vscode.LogOutputChannel,
  turnEpoch?: number,
): Promise<string> {
  const epoch = turnEpoch ?? session.beginTurn();
  return invokeStartExploration(session, output, epoch, {
    origin: '[dbo].[Orders]',
    question: 'Trace the loaded Orders snapshot upstream.',
    analysisMode: 'bb',
    direction: 'upstream',
    depth: 1,
    classification: 'business',
  });
}

async function invokeStartExploration(
  session: AiSession,
  output: vscode.LogOutputChannel,
  epoch: number,
  input: Record<string, unknown>,
): Promise<string> {
  const registry = buildAiToolRegistry(
    () => session,
    output,
    () => undefined,
    { sessionId: session.id, epoch, signal: new AbortController().signal },
  );
  const result = await registry.invoke('lineage_start_exploration', input);
  assert.ok(result.length > 0, 'the canonical mutation returns its structured gate payload');
  return result;
}

function publicLanguageModelApi(): {
  selectChatModels(selector: { vendor: string; id: string }): Thenable<readonly vscode.LanguageModelChat[]>;
} {
  // The repository's stable 1.101 typings intentionally remain unchanged. The
  // pinned 1.130 Electron host supplies this public API; keep the compatibility
  // cast local to the test fixture rather than widening production typings.
  return vscode.lm as unknown as ReturnType<typeof publicLanguageModelApi>;
}

async function waitForModel(): Promise<vscode.LanguageModelChat> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const models = await publicLanguageModelApi().selectChatModels({
      vendor: TEST_VENDOR,
      id: TEST_MODEL_ID,
    });
    if (models.length === 1) return models[0];
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('scripted language model was not available from the public VS Code API');
}

/**
 * The three part shapes `normalizePart` in tests/fixtures/lm-provider-extension/extension.js
 * produces. Modelled as a discriminated union so the assertions above narrow instead of casting.
 */
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

function snapshotSession(): AiSession {
  const session = new AiSession();
  session.model = {
    nodes: [
      { id: '[dbo].[Orders]', schema: 'dbo', name: 'Orders', type: 'table', columns: [{ name: 'OrderId', type: 'int' }] },
      { id: '[dbo].[OrderLines]', schema: 'dbo', name: 'OrderLines', type: 'table', columns: [{ name: 'OrderId', type: 'int' }] },
    ],
    edges: [{ source: '[dbo].[OrderLines]', target: '[dbo].[Orders]', type: 'SELECT' }],
    schemas: [{ name: 'dbo', nodeCount: 2, types: { table: 2, view: 0, procedure: 0, function: 0, external: 0 } }],
    catalog: {},
    dbPlatform: 'SQL Server',
    neighborIndex: {
      '[dbo].[Orders]': { in: ['[dbo].[OrderLines]'], out: [] },
      '[dbo].[OrderLines]': { in: [], out: ['[dbo].[Orders]'] },
    },
  } as unknown as DatabaseModel;
  session.graph = buildBareGraph(session.model);
  // The Electron fixture exercises only the snapshot fields read by the
  // canonical registry/NavigationEngine path. It deliberately is not a full
  // DACPAC extraction result, so retain the narrow fixture cast locally.
  return session;
}

function scopeRefinementSession(): AiSession {
  const procedureNames = [
    'spArchiveOldOrders',
    'spBuildSalesReport',
    'spCleanOrders',
    'spImportOrders',
    'spLoadSalesStaging',
    'spRefreshPrices',
    'spRefreshSegments',
  ];
  const viewNames = [
    'vwConsolidatedSales',
    'vwDiscountCalc',
    'vwExternalOrders',
    'vwPriceList',
    'vwRawOrders',
  ];
  const tableNames = [
    'CustomerMaster',
    'CustomerSegmentMap',
    'DimCalendar',
    'DiscountRules',
    'FactSalesReport',
    'PriceMaster',
    'RegionLookup',
    'SalesStaging',
    'ImportedOrders',
    'LegacyFacts',
    'OracleOrders',
    'RawOrderImport',
    'SAPOrders',
    'ProductMaster',
    'SalesOrder',
    'TerritoryLookup',
  ];
  const nodes = [
    ...procedureNames.map(name => ({ id: `[ai].[${name}]`, schema: 'ai', name, type: 'procedure' as const, bodyScript: `CREATE PROCEDURE [ai].[${name}] AS SELECT 1` })),
    ...viewNames.map(name => ({ id: `[ai].[${name}]`, schema: 'ai', name, type: 'view' as const, bodyScript: `CREATE VIEW [ai].[${name}] AS SELECT 1 AS id` })),
    ...tableNames.map(name => ({ id: `[ai].[${name}]`, schema: 'ai', name, type: 'table' as const })),
  ];
  const originId = '[ai].[FactSalesReport]';
  const sourceIds = nodes.map(node => node.id).filter(id => id !== originId);
  const edges = sourceIds.map(source => ({ source, target: originId, type: 'SELECT' }));
  const neighborIndex = Object.fromEntries(nodes.map(node => [
    node.id,
    node.id === originId
      ? { in: sourceIds, out: [] }
      : { in: [], out: [originId] },
  ]));

  const session = new AiSession();
  session.model = {
    nodes,
    edges,
    schemas: [{
      name: 'ai',
      nodeCount: nodes.length,
      types: { table: 16, view: 5, procedure: 7, function: 0, external: 0 },
    }],
    catalog: {},
    dbPlatform: 'SQL Server',
    neighborIndex,
  } as unknown as DatabaseModel;
  session.graph = buildBareGraph(session.model);
  return session;
}
