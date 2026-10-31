// Owner: src/ai/tools/toolProvider.ts and tools/handlers; raw tool admission and handler functional contracts.
/** The strict boundary that runs first owns these rejections, so the handler and engine never see the shapes below: a start with no origin/supplement/revision, a non-string scope list, an empty highlight-group list in any served present_result stage, and a neighbour id the engine has not validated as an in-scope direct neighbour. */
import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { z } from 'zod';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import {
  modelUserMessage,
  type ModelMessage,
} from '../../../src/ai/model/modelPort';
import {
  REGEX_MAX_LENGTH,
  checkScopeBudget,
  createTurnTokenBudget,
} from '../../../src/ai/support/tokenBudget';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { compileInstructionPlan } from '../../../src/ai/agent/instructionPlan';
import {
  executeToolAttempt,
  initialToolPhaseAttemptState,
  recordToolAttempt,
} from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import {
  overrideRegistrySchemas,
  resolveRegistrySchemas,
} from '../../../src/ai/tools/registry';
import { normalizeModelInput } from '../../../src/ai/tools/normalizeModelInput';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import {
  ingestToolInput,
  toolInputReceipt,
  type ToolInputView,
} from '../../../src/ai/support/toolIngestion';
import { ToolDraft } from '../../../src/ai/support/toolDraft';
import { getAllowedLmToolNames } from '../../../src/ai/tools/toolPolicy';
import { buildActiveHopInstruction } from '../../../src/ai/agent/stagePrompts';
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { executePruneCurrent } from '../../../src/ai/tools/handlers/pruneCurrent';
import { executeStartExploration } from '../../../src/ai/tools/handlers/startExploration';
import {
  ColumnFlowSchema,
  StartExplorationInputSchema,
  startExplorationSchemaForState,
  StartExplorationFreshProviderInputSchema,
  StartExplorationProviderInputSchema,
  StartExplorationRefineProviderInputSchema,
  PruneCurrentInputSchema,
  presentResultSchemaForPhase,
  submitFindingsSchemaForMode,
} from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import Ajv from 'ajv/dist/2020';
import * as toolValidation from '../../../src/ai/support/toolValidation';
import * as graphUtils from '../../../src/ai/support/graphUtils';
const { validateToolCandidate } = toolValidation;
import {
  ISSUES,
  at,
  isAdmissionRefusal,
  isConsentGateRejection,
  makeRejection,
  readToolErrorText,
  renderProblem,
  type ToolProblem,
} from '../../../src/ai/support/toolErrorEnvelope';

/** The errors delivered by the shared renderer. */
const shownErrors = (problem: ToolProblem) => problem.errors;
/** Whether any error carries its issue-owned fallback. */
const hasFallback = (problem: ToolProblem) =>
  problem.errors.some((error) => {
    const issue = ISSUES[error.code];
    return 'fallback' in issue && error.message.endsWith(issue.fallback);
  });
import {
  detectOverBudgetFromResult,
  queueDiscoveryBudgetNotice,
} from '../../../src/ai/agent/discoveryCapture';
import { scriptedRegistry } from '../../harness/scriptedModelPort';
import {
  makeGraph,
  makeIndexedModel,
  makeModel,
  makeNode,
} from '../helpers/modelFixtures';
import { TOOL_DEFS } from '../../../src/ai/tools/toolDefs';
import {
  schemaFaults,
  withSchemaFaults,
  stubToolServices,
} from './helpers/toolServices';
import { hopDraft, servedTools } from './helpers/modelRequests';

vi.mock('../../../src/ai/tools/normalizeModelInput', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/ai/tools/normalizeModelInput')
    >();
  return { ...actual, normalizeModelInput: vi.fn(actual.normalizeModelInput) };
});

const ORIGIN = '[hop].[origin]';
const BRANCH = '[hop].[branch]';
const OTHER = '[hop].[other]';

// Approved02 origin ownership and D-026: columnless tables/views cannot own an invented CT target.
it.each(
  (['table', 'view'] as const).flatMap((type) =>
    [false, true].map((missing) => ({ type, missing })),
  ),
)(
  'rejects an undeclared CT origin target ($type, metadata missing=$missing)',
  async ({ type, missing }) => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const origin = model.nodes.find((node) => node.id === ORIGIN)!;
    origin.type = type;
    origin.columns = missing ? undefined : [];
    graph.setNodeAttribute(ORIGIN, 'type', type);
    const { services } = stubToolServices({ session, model, graph });
    const memoryBefore = structuredClone(session.memory.toJSON());
    const result = JSON.parse(
      await executeStartExploration(
        {
          origin: ORIGIN,
          analysisMode: 'ct',
          targetColumns: ['Ghost'],
          classification: 'technical',
          depth: {
            upstream: { levels: 1, exactness: 'exact' },
            downstream: { levels: 0, exactness: 'exact' },
          },
        },
        services,
      ),
    );
    expect(result).toMatchObject({
      code: 'invalid_input',
      errors: expect.arrayContaining([
        expect.objectContaining({
          path: 'targetColumns.0',
          code: 'unknown_target_column',
        }),
      ]),
    });
    expect(session.pendingExploration).toBeNull();
    expect(session.stateMachine).toBeNull();
    expect(session.memory.toJSON()).toEqual(memoryBefore);
    const corrected = JSON.parse(
      await executeStartExploration(
        {
          origin: ORIGIN,
          analysisMode: 'bb',
          classification: 'technical',
          depth: {
            upstream: { levels: 1, exactness: 'exact' },
            downstream: { levels: 0, exactness: 'exact' },
          },
        },
        services,
      ),
    );
    expect(corrected).toMatchObject({ code: 'action_required' });
    expect(session.pendingExploration?.init).toMatchObject({
      origin: ORIGIN,
      analysisMode: 'bb',
    });
    expect(session.pendingExploration?.init.targetColumns).toBeUndefined();
    expect(session.stateMachine).toBeNull();
  },
);

it.each(['table', 'view', 'procedure'] as const)(
  'accepts valid CT origin metadata/trust control (%s)',
  async (type) => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const origin = model.nodes.find((node) => node.id === ORIGIN)!;
    origin.type = type;
    origin.columns =
      type === 'procedure'
        ? []
        : [{ name: 'Ghost', type: 'int', nullable: 'NULL', extra: '' }];
    graph.setNodeAttribute(ORIGIN, 'type', type);
    const { services } = stubToolServices({ session, model, graph });
    const result = JSON.parse(
      await executeStartExploration(
        {
          origin: ORIGIN,
          analysisMode: 'ct',
          targetColumns: ['Ghost'],
          classification: 'technical',
          depth: {
            upstream: { levels: 1, exactness: 'exact' },
            downstream: { levels: 0, exactness: 'exact' },
          },
        },
        services,
      ),
    );
    expect(result).toMatchObject({ code: 'action_required' });
    expect(session.pendingExploration?.init).toMatchObject({
      analysisMode: 'ct',
      targetColumns: ['Ghost'],
    });
    expect(session.stateMachine).toBeNull();
  },
);

it('keeps tool payloads in results and hop evidence while host logs contain metadata only', async () => {
  const marker = 'ToolPayloadLeakSentinel';
  const node = makeNode({
    id: '[hop].[logging]',
    schema: 'hop',
    name: 'logging',
    type: 'view',
    bodyScript: `SELECT '${marker}' AS Value;`,
  });
  const session = new AiSession();
  session.model = makeModel([node], [], ['hop']);
  session.graph = makeGraph([node], []);
  session.columnStore.setDdl(node.id, node.bodyScript!);
  session.beginTurn();
  const channel = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const registry = buildAiToolRegistry(
    () => session,
    channel as never,
    () => undefined,
  );
  await registry.invoke('lineage_search_objects', { query: marker });
  const accepted = await registry.invoke('lineage_get_object_detail', {
    id: node.id,
  });
  const rejected = await registry.invoke('lineage_get_object_detail', {
    id: `[missing].[${marker}]`,
  });
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  const gate = await registry.invoke('lineage_start_exploration', {
    origin: node.id,
    question: marker,
    mission_brief: marker,
    analysisMode: 'bb',
    classification: 'technical',
    depth: {
      upstream: { levels: 1, exactness: 'exact' },
      downstream: { levels: 0, exactness: 'exact' },
    },
  });
  expect(String(accepted)).toContain(marker);
  expect(String(rejected)).toContain(marker);
  expect(String(gate)).toContain(marker);
  expect(JSON.parse(String(gate)).code).toBe('action_required');
  expect(JSON.stringify(session.hopLog)).toContain(marker);
  const logs = [channel.debug, channel.info, channel.warn, channel.error]
    .flatMap((logger) => logger.mock.calls.flat())
    .join(' ');
  expect(logs).not.toContain(marker);
  expect(logs).toContain('resultChars=');
  expect(logs).toContain('code=invalid_input');
});

function ctWorld(
  options: {
    deferred?: boolean;
    scalar?: boolean;
    caseSensitive?: boolean;
    mode?: 'bb' | 'ct';
    selfLoop?: boolean;
    sibling?: boolean;
    other?: boolean;
    outsideWrite?: boolean;
    extraSource?: boolean;
  } = {},
) {
  const column = [
    { name: 'Value', type: 'int', nullable: 'NULL', extra: '' },
    ...(options.other
      ? [{ name: 'Other', type: 'int', nullable: 'NULL', extra: '' }]
      : []),
  ];
  const nodes = [
    makeNode({
      id: ORIGIN,
      schema: 'hop',
      name: 'origin',
      type: options.selfLoop ? 'procedure' : 'view',
      columns: column,
      bodyScript: options.scalar
        ? `SELECT ${BRANCH}(1) AS Value;`
        : `SELECT Value FROM ${BRANCH};`,
    }),
    makeNode({
      id: BRANCH,
      schema: 'hop',
      name: 'branch',
      type: options.scalar ? 'function' : options.selfLoop ? 'table' : 'view',
      columns: options.scalar ? [] : column,
      bodyScript: options.scalar
        ? `CREATE FUNCTION ${BRANCH}(@Amount int) RETURNS int AS BEGIN RETURN @Amount END`
        : 'SELECT 1 AS Value;',
    }),
    makeNode({
      id: OTHER,
      schema: 'hop',
      name: 'other',
      type: 'table',
      columns: column,
    }),
    ...(options.extraSource
      ? [
          makeNode({
            id: '[hop].[extra]',
            schema: 'hop',
            name: 'extra',
            type: 'view',
            columns: column,
            bodyScript: 'SELECT 1 AS Value;',
          }),
        ]
      : []),
  ];
  const pairs: Array<[string, string]> = [
    [BRANCH, ORIGIN],
    ...(options.selfLoop ? [[ORIGIN, BRANCH] as [string, string]] : []),
    ...(options.deferred ? [[OTHER, BRANCH] as [string, string]] : []),
    ...(options.sibling ? [[OTHER, ORIGIN] as [string, string]] : []),
    ...(options.outsideWrite ? [[ORIGIN, OTHER] as [string, string]] : []),
    ...(options.extraSource
      ? [['[hop].[extra]', ORIGIN] as [string, string]]
      : []),
  ];
  const model = makeIndexedModel(nodes, pairs);
  model.identifierCaseSensitive = options.caseSensitive ?? false;
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model;
  session.graph = graph;
  session.classification = 'technical';
  session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.classification = 'technical';
  expect(
    engine.init({
      origin: ORIGIN,
      question: 'Trace Value.',
      analysisMode: options.mode ?? 'ct',
      ...(options.mode === 'bb'
        ? {}
        : { targetColumns: options.other ? ['Value', 'Other'] : ['Value'] }),
      direction: 'upstream',
      depthIntent: {
        upstream: { levels: options.deferred ? 1 : 'all', exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    }),
  ).toMatchObject({ ok: true });
  engine.getHopContext();
  session.stateMachine = engine;
  session.enterExploring(session.turnEpoch);
  const noop = () => {};
  const registry = buildAiToolRegistry(
    () => session,
    { info: noop, debug: noop, warn: noop, error: noop } as never,
    () => undefined,
  );
  return { session, model, graph, registry, engine };
}

/** Drives a correction that follows the feedback and the served card (D-099): the focus and the parts the rejection asks to resend, plus every required field of the model's own draft resent; a resent field replaces the held one (D-098). */
/** Native SDK generations drive the direct-boundary lifecycle fixtures; compiled dispatcher cases remain separate. */
function ownedInputWorld(
  options: {
    signal?: AbortSignal;
    stage?: Parameters<AiSession['enterLmStage']>[0];
  } = {},
) {
  const world = ctWorld();
  let queued: Array<{ tool: string; input: object }> = [];
  const offered: Array<
    Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown> };
    }>
  > = [];
  const port = new VscodeModelPort(
    {
      id: 'owned-boundary',
      name: 'owned-boundary',
      vendor: 'test',
      family: 'test',
      version: '1',
      maxInputTokens: 128000,
      countTokens: async () => 1,
      sendRequest: async (
        _messages: unknown,
        options: vscode.LanguageModelChatRequestOptions,
      ) => {
        offered.push(
          structuredClone(options.tools!) as (typeof offered)[number],
        );
        return {
          stream: {
            async *[Symbol.asyncIterator]() {
              for (const [index, call] of queued.entries())
                yield new vscode.LanguageModelToolCallPart(
                  `owned-${port.modelCalls}-${index}`,
                  call.tool,
                  call.input,
                );
            },
          },
        };
      },
    } as never,
    { budget: createTurnTokenBudget({}) },
  );
  const registry = buildAiToolRegistry(
    () => world.session,
    { info() {}, debug() {}, warn() {}, error() {} } as never,
    () => undefined,
    undefined,
    { model: port, signal: options.signal },
  );
  const batch = async (
    calls: Array<{ tool: string; input: object }>,
    parallel = true,
  ) => {
    queued = calls;
    const projected = overrideRegistrySchemas(
      registry,
      new Map([
        [
          'lineage_start_exploration',
          world.session.phase.kind === 'awaiting_gate'
            ? StartExplorationRefineProviderInputSchema
            : StartExplorationFreshProviderInputSchema,
        ],
      ]),
    );
    const offeredRegistry = options.stage
      ? compileInstructionPlan({
          kind: 'converse',
          stage: options.stage,
          registry: projected,
          messages: [],
          sink: new TurnEventSink(() => {}),
          presentResultRetainableSections: () =>
            world.session.retainableReportSections() !== null,
        }).input.registry
      : projected;
    const reply = await port.generateToolTurn({
      messages: [modelUserMessage('Boundary fixture.')],
      tools: offeredRegistry.getTools().map((tool) => ({
        name: tool.name,
        description: tool.modelDescription ?? tool.name,
        inputSchema: tool.inputSchema,
      })),
      phase:
        world.session.activeLmStage?.kind === 'sm_entry'
          ? 'sm_entry'
          : 'discover',
    });
    const results: string[] = [];
    const dispatch = (call: (typeof reply.toolCalls)[number]) => {
      expect(call.valid).toBe(true);
      return registry.invoke(call.toolName, call.input);
    };
    if (parallel) return Promise.all(reply.toolCalls.map(dispatch));
    for (const call of reply.toolCalls) results.push(await dispatch(call));
    return results;
  };
  return {
    ...world,
    registry,
    port,
    offered,
    queue: (calls: typeof queued) => {
      queued = calls;
    },
    batch,
    invoke: async (tool: string, input: object) =>
      (await batch([{ tool, input }]))[0]!,
  };
}

it.each([
  'start',
  'nested-start',
  'present',
  'whole-replacement',
  'unnamed-sibling-leaf',
] as const)(
  'advertises the actual held %s correction and preserves atomic admission',
  async (kind) => {
    const present = kind === 'present';
    const { session, invoke, offered } = ownedInputWorld({
      stage: { kind: present ? 'completed' : 'sm_entry' },
    });
    const depth = {
      upstream: { levels: 1, exactness: 'exact' },
      downstream: { levels: 0, exactness: 'exact' },
    };
    if (present) {
      session.resultGraph = {
        nodeIds: [ORIGIN, BRANCH],
        edges: [[BRANCH, ORIGIN, 'read']],
        source: 'blackboard',
        originNodeId: ORIGIN,
      };
      session.enterCompleted(session.turnEpoch);
    } else {
      session.stateMachine = null;
      session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
    }
    const tool = present
      ? 'lineage_present_result'
      : 'lineage_start_exploration';
    const first = present
      ? {
          name: 'Result',
          summary: 42,
          sections: [
            {
              label: 'Flow',
              node_ids: [ORIGIN, BRANCH],
              text: 'Source feeds Result.',
            },
          ],
          highlight_groups: [
            { label: 'Flow', color: 'source', node_ids: [ORIGIN, BRANCH] },
          ],
        }
      : {
          origin: ORIGIN,
          analysisMode: 'bb',
          classification: kind === 'start' ? 'wrong' : 'technical',
          depth:
            kind === 'start'
              ? depth
              : { ...depth, upstream: { levels: 1, exactness: 'wrong' } },
        };
    const before = JSON.stringify({
      proposal: session.pendingExploration,
      graph: session.resultGraph,
      artifact: session.presentationArtifact,
    });
    expect(JSON.parse(await invoke(tool, first))).toHaveProperty(
      'code',
      'invalid_input',
    );
    expect(
      JSON.stringify({
        proposal: session.pendingExploration,
        graph: session.resultGraph,
        artifact: session.presentationArtifact,
      }),
    ).toBe(before);
    const patch = present
      ? { summary: 'Source feeds Result.' }
      : kind === 'start'
        ? { classification: 'technical' }
        : kind === 'whole-replacement'
          ? {
              depth: {
                upstream: { exactness: 'exact' },
                downstream: depth.downstream,
              },
            }
          : kind === 'unnamed-sibling-leaf'
            ? // D-101: an unnamed sibling makes the patch a whole depth replacement that drops held downstream.
              { depth: { upstream: { levels: 1, exactness: 'exact' } } }
            : { depth: { upstream: { exactness: 'exact' } } };
    const result = JSON.parse(await invoke(tool, patch));
    const card = offered.at(-1)!.find((t) => t.name === tool)!.inputSchema;
    const validate = new Ajv({ strict: false }).compile(card);
    const replaced =
      kind === 'whole-replacement' || kind === 'unnamed-sibling-leaf';
    expect(validate(patch), JSON.stringify(validate.errors)).toBe(!replaced);
    if (replaced) {
      expect(result).toHaveProperty('code', 'invalid_input');
      expect(
        JSON.stringify({
          proposal: session.pendingExploration,
          graph: session.resultGraph,
          artifact: session.presentationArtifact,
        }),
      ).toBe(before);
    } else {
      expect(
        present ? result.success === true : result.code === 'action_required',
      ).toBe(true);
      expect(validate({ ...patch, rogue: true })).toBe(false);
    }
  },
);

it.each(['start', 'present'] as const)(
  'keeps fresh requirements, strict keys, array-item fields and required values in the actual %s card',
  async (kind) => {
    const present = kind === 'present';
    const { session, invoke, offered } = ownedInputWorld({
      stage: { kind: present ? 'completed' : 'sm_entry' },
    });
    if (present) {
      session.resultGraph = {
        nodeIds: [ORIGIN, BRANCH],
        edges: [[BRANCH, ORIGIN, 'read']],
        source: 'blackboard',
        originNodeId: ORIGIN,
      };
      session.enterCompleted(session.turnEpoch);
    } else {
      session.stateMachine = null;
      session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
    }
    const tool = present
      ? 'lineage_present_result'
      : 'lineage_start_exploration';
    expect(JSON.parse(await invoke(tool, {}))).toHaveProperty(
      'code',
      'invalid_input',
    );
    expect(
      new Ajv({ strict: false }).compile(
        offered.at(-1)!.find((t) => t.name === tool)!.inputSchema,
      )({}),
    ).toBe(false);
    const original = present
      ? {
          name: 'Result',
          summary: 42,
          sections: [
            {
              label: 'Flow',
              node_ids: [ORIGIN, BRANCH],
              text: 'Source feeds Result.',
            },
          ],
          highlight_groups: [
            { label: 'Flow', color: 'source', node_ids: [ORIGIN, BRANCH] },
          ],
        }
      : {
          origin: ORIGIN,
          analysisMode: 'bb',
          classification: 'wrong',
          depth: {
            upstream: { levels: 1, exactness: 'exact' },
            downstream: { levels: 0, exactness: 'exact' },
          },
        };
    expect(JSON.parse(await invoke(tool, original))).toHaveProperty(
      'code',
      'invalid_input',
    );
    const before = JSON.stringify({
      proposal: session.pendingExploration,
      graph: session.resultGraph,
      artifact: session.presentationArtifact,
    });
    const bad = present
      ? { summary: 'Source feeds Result.', sections: [{ label: 'Flow' }] }
      : { classification: 'technical', origin: null };
    expect(JSON.parse(await invoke(tool, bad))).toHaveProperty(
      'code',
      'invalid_input',
    );
    expect(
      new Ajv({ strict: false }).compile(
        offered.at(-1)!.find((t) => t.name === tool)!.inputSchema,
      )(bad),
    ).toBe(false);
    expect(
      JSON.stringify({
        proposal: session.pendingExploration,
        graph: session.resultGraph,
        artifact: session.presentationArtifact,
      }),
    ).toBe(before);
  },
);

it.each([['Value'], null, []])(
  'preserves held CT mode during target-only repair: %j',
  async (targetColumns) => {
    const { session, invoke, offered } = ownedInputWorld({
      stage: { kind: 'sm_entry' },
    });
    session.stateMachine = null;
    session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
    const tool = 'lineage_start_exploration';
    const patch = { targetColumns };
    const fresh = JSON.parse(await invoke(tool, patch));
    expect(fresh.code).toBe('invalid_input');
    expect(
      new Ajv({ strict: false }).compile(
        offered.at(-1)!.find((t) => t.name === tool)!.inputSchema,
      )(patch),
    ).toBe(false);
    const rejected = JSON.parse(
      await invoke(tool, {
        origin: ORIGIN,
        analysisMode: 'ct',
        classification: 'technical',
        targetColumns: ['Missing'],
        depth: {
          upstream: { levels: 1, exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      }),
    );
    expect(rejected.issuePaths).toContain('targetColumns.0');
    expect(session.pendingExploration).toBeNull();
    const result = JSON.parse(await invoke(tool, patch));
    const valid = Array.isArray(targetColumns) && targetColumns.length > 0;
    if (valid) {
      expect(
        new Ajv({ strict: false }).compile(
          offered.at(-1)!.find((t) => t.name === tool)!.inputSchema,
        )(patch),
      ).toBe(true);
      expect(result.code).toBe('action_required');
      expect(session.pendingExploration?.init).toMatchObject({
        analysisMode: 'ct',
        targetColumns: ['Value'],
      });
    } else {
      expect(result.code).toBe('invalid_input');
      expect(session.pendingExploration).toBeNull();
      expect(session.startExplorationDraft.get()).toMatchObject({
        analysisMode: 'ct',
      });
    }
    expect(session.stateMachine).toBeNull();
  },
);

it('states whole action-list replacement and preserves explicit withdrawal without merging decisions', () => {
  const { engine, session, model, graph } = ctWorld({
    mode: 'bb',
    sibling: true,
  });
  const { services } = stubToolServices({ session, model, graph });
  const first = { nodeId: BRANCH, question: 'Explain the source.' };
  const second = { nodeId: OTHER, question: 'Explain the other source.' };
  const submit = (input: object) =>
    JSON.parse(executeSubmitFindings(input, services));
  const initial = submit({
    summary: 'Authored summary.',
    sections: { technical: 'Authored evidence.' },
    questions: [first],
  });
  expect(initial.errors).toEqual(
    expect.arrayContaining([
      { path: '', code: 'neighbor_undecided', values: [OTHER] },
    ]),
  );
  expect(initial.resend).toEqual(['questions', 'prune_neighbors']);
  const schema = toModelJsonSchema(
    submitFindingsSchemaForMode(
      'bb',
      'technical',
      false,
      engine.hopSubmitColumns,
    ),
  );
  expect(schema.description).toContain(
    'questions or prune_neighbors list replaces its held list whole',
  );
  expect(submit({ questions: [second] }).errors).toEqual(
    expect.arrayContaining([
      { path: '', code: 'neighbor_undecided', values: [BRANCH] },
    ]),
  );
  expect(submit({ questions: [] }).errors).toEqual([
    { path: '', code: 'neighbor_undecided', values: [BRANCH] },
    { path: '', code: 'neighbor_undecided', values: [OTHER] },
  ]);
  expect(submit({ questions: [first, second] })).toHaveProperty('ok', true);
  expect(
    engine.getDetailSlots().find((slot) => slot.nodeId === ORIGIN),
  ).toMatchObject({
    summary: 'Authored summary.',
    sections: [{ angle: 'technical', text: 'Authored evidence.' }],
  });
});

it('rejects a whitespace-only findings section instead of dropping it and saving the rest', () => {
  const { engine, session, model, graph } = ctWorld({
    mode: 'bb',
    sibling: true,
  });
  const { services } = stubToolServices({ session, model, graph });
  const submit = (input: object) =>
    JSON.parse(executeSubmitFindings(input, services));
  const held = submit({
    focus_node_id: ORIGIN,
    summary: 'Authored summary.',
    sections: { technical: 'Authored evidence.' },
    questions: [{ nodeId: BRANCH, question: 'Explain the source.' }],
  });
  expect(held).not.toHaveProperty('ok');
  const before = engine.toJSON();
  const blank = submit({
    focus_node_id: ORIGIN,
    sections: { technical: '   ' },
    questions: [
      { nodeId: BRANCH, question: 'Explain the source.' },
      { nodeId: OTHER, question: 'Explain the other source.' },
    ],
  });
  const saved = engine.getDetailSlots().find((slot) => slot.nodeId === ORIGIN);
  expect({ ok: blank.ok, code: blank.code, section: saved?.sections }).toEqual({
    ok: undefined,
    code: expect.any(String),
    section: undefined,
  });
  for (const key of ['agenda', 'visited', 'removedSet'] as const)
    expect(engine.toJSON()[key]).toEqual(before[key]);
  expect(engine.toJSON().memory.detailSlots).toEqual(before.memory.detailSlots);
});

it('rejects a whitespace-only neighbor prune reason instead of committing the prune', () => {
  const { engine, session, model, graph } = ctWorld({
    mode: 'bb',
    sibling: true,
  });
  const { services } = stubToolServices({ session, model, graph });
  const before = engine.toJSON();
  const result = JSON.parse(
    executeSubmitFindings(
      {
        focus_node_id: ORIGIN,
        summary: 'Other supplies Value.',
        sections: { technical: 'Branch is not on the answer.' },
        questions: [{ nodeId: OTHER, question: 'Explain the other source.' }],
        prune_neighbors: [{ id: BRANCH, reason: ' ' }],
      },
      services,
    ),
  );
  expect({ ok: result.ok, code: result.code, pruned: result.pruned }).toEqual({
    ok: undefined,
    code: expect.any(String),
    pruned: undefined,
  });
  expect(engine.toJSON().removedSet).not.toContain(BRANCH);
  expect(engine.getDetailSlots()).toEqual([]);
  for (const key of ['agenda', 'visited', 'removedSet'] as const)
    expect(engine.toJSON()[key]).toEqual(before[key]);
  expect(engine.toJSON().memory.detailSlots).toEqual(before.memory.detailSlots);
});

it.each(
  (['bb', 'ct'] as const).flatMap((mode) =>
    ['object', 'markdown', 'invalid-json'].map((sectionShape) => ({
      mode,
      sectionShape,
    })),
  ),
)(
  'reports missing $mode neighbor decisions alongside shape faults (sections: $sectionShape)',
  ({ mode, sectionShape }) => {
    const malformedSections = sectionShape !== 'object';
    const { engine, session, model, graph } = ctWorld({ mode, sibling: true });
    const { services } = stubToolServices({ session, model, graph });
    const questions = [
      { nodeId: BRANCH, question: 'Explain the source Value.' },
    ];
    const before = engine.toJSON();
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          focus_node_id: ORIGIN,
          summary: 'Value provenance.',
          sections:
            sectionShape === 'markdown'
              ? '# Findings\nPlain authored Markdown.'
              : sectionShape === 'invalid-json'
                ? '{"technical":"Authored "quoted" evidence."}'
                : { technical: 'Preserve this authored evidence.' },
          questions,
          badge_label: 42,
          ...(mode === 'ct'
            ? {
                column_flow: [
                  {
                    out_col: 'Value',
                    upstream_columns: [{ node: BRANCH, col: 'Value' }],
                  },
                ],
              }
            : {}),
        },
        services,
      ),
    );
    expect(rejected.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'badge_label' }),
        { path: '', code: 'neighbor_undecided', values: [OTHER] },
      ]),
    );
    if (malformedSections)
      expect(rejected.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'sections' })]),
      );
    expect(rejected.detail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'neighbor_outcome_missing',
          id: OTHER,
        }),
      ]),
    );
    const after = engine.toJSON();
    for (const key of [
      'agenda',
      'columnAspect',
      'removedSet',
      'visited',
    ] as const)
      expect(after[key]).toEqual(before[key]);
    expect(engine.getDetailSlots()).toEqual([]);
    const heldRetry = JSON.parse(
      executeSubmitFindings({ focus_node_id: ORIGIN }, services),
    );
    expect(heldRetry).toHaveProperty('code');
    expect(
      heldRetry.errors.filter(
        (error: { code: string }) => error.code === 'neighbor_undecided',
      ),
    ).toEqual([{ path: '', code: 'neighbor_undecided', values: [OTHER] }]);
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            ...(malformedSections
              ? { sections: { technical: 'Corrected authored evidence.' } }
              : {}),
            questions: [
              ...questions,
              { nodeId: OTHER, question: 'Explain the other source.' },
            ],
          },
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
      summary: 'Value provenance.',
      sections: [
        {
          angle: 'technical',
          text: malformedSections
            ? 'Corrected authored evidence.'
            : 'Preserve this authored evidence.',
        },
      ],
    });
    expect(engine.getCurrentTasks()).toContainEqual(
      expect.objectContaining({ question: questions[0].question }),
    );
    if (mode === 'ct')
      expect(engine.columnAspect?.edges).toEqual([
        expect.objectContaining({ from_node: BRANCH, to_node: ORIGIN }),
      ]);
  },
);

describe('missing neighbor outcomes beside an invalid column_flow', () => {
  const missingIds = (result: {
    detail?: Array<{ kind?: string; id?: string }>;
  }) =>
    (result.detail ?? [])
      .filter((fault) => fault.kind === 'neighbor_outcome_missing')
      .map((fault) => fault.id);
  const setup = () => {
    const world = ctWorld({ sibling: true });
    const { services } = stubToolServices({
      session: world.session,
      model: world.model,
      graph: world.graph,
    });
    const before = world.engine.toJSON();
    const submit = (column_flow: unknown) =>
      JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            summary: 'Value provenance.',
            sections: { technical: 'Authored evidence.' },
            column_flow,
          },
          services,
        ),
      );
    const unchanged = () => {
      const after = world.engine.toJSON();
      for (const key of [
        'agenda',
        'columnAspect',
        'removedSet',
        'visited',
      ] as const)
        expect(after[key]).toEqual(before[key]);
      expect(world.engine.getDetailSlots()).toEqual([]);
    };
    return { ...world, services, submit, unchanged };
  };

  it('reports a structurally unmentioned neighbor in the same first feedback as the flow fault', () => {
    const { submit, unchanged, services } = setup();
    const rejected = submit([
      {
        out_col: 'Value',
        upstream_columns: [{ node: BRANCH, col: 'Missing' }],
      },
    ]);
    expect(rejected.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringMatching(/^column_flow\.0/),
        }),
      ]),
    );
    // The neighbor named only inside the invalid entry has an authored (if faulty) outcome; only the absent one is owed.
    expect(missingIds(rejected)).toEqual([OTHER]);
    unchanged();
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns: [{ node: BRANCH, col: 'Value' }],
              },
            ],
            questions: [
              { nodeId: OTHER, question: 'Explain the other source.' },
            ],
          },
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
  });

  it('owes the same neighbors as the corrected flow when a faulty procedure entry lands nowhere', () => {
    for (const col of ['Missing', 'Value']) {
      const world = ctWorld({ sibling: true, selfLoop: true });
      const { services } = stubToolServices({
        session: world.session,
        model: world.model,
        graph: world.graph,
      });
      const rejected = JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            summary: 'Value provenance.',
            sections: { technical: 'Authored evidence.' },
            column_flow: [
              { out_col: 'Value', upstream_columns: [{ node: BRANCH, col }] },
            ],
          },
          services,
        ),
      );
      // A procedure entry without out_node maps no supplier, even when its supplied column is valid.
      expect(missingIds(rejected)).toEqual([BRANCH, OTHER]);
    }
  });

  it('Approved05/07: served CT inputs map direct and indirect neighbors without separate questions or prunes', () => {
    const world = setup();
    const flow = [
      {
        out_col: 'Value',
        upstream_columns: [
          { node: BRANCH, col: 'Value', transforms: ['compute'] },
          { node: OTHER, col: 'Value', transforms: ['filter'] },
        ],
      },
    ];
    const schema = servedTools(world, hopDraft(world)).find(
      (tool) => tool.name === 'lineage_submit_findings',
    )!.inputSchema;
    expect(
      new Ajv({ strict: false }).compile(schema)({
        focus_node_id: ORIGIN,
        summary: 'Value provenance.',
        sections: { technical: 'Authored evidence.' },
        column_flow: flow,
      }),
    ).toBe(true);
    expect(world.submit(flow)).toHaveProperty('ok', true);
    expect(world.engine.columnAspect?.edges).toEqual([
      expect.objectContaining({ from_node: BRANCH, transforms: ['compute'] }),
      expect.objectContaining({ from_node: OTHER, transforms: ['filter'] }),
    ]);
  });

  it.each([
    ['unparseable text', '[{"out_col": "Value", "upstream_columns": ['],
    [
      'unresolvable reference',
      [
        {
          out_col: 'Value',
          upstream_columns: [{ node: '[hop].[nowhere]', col: 'Value' }],
        },
      ],
    ],
  ])(
    'claims no missing outcome when the flow cannot be read structurally: %s',
    (_label, flow) => {
      const { submit, unchanged } = setup();
      const rejected = submit(flow);
      expect(rejected).toHaveProperty('code');
      expect(missingIds(rejected)).toEqual([]);
      unchanged();
    },
  );

  it('keeps readable neighbor identity beside malformed supplier annotations', () => {
    const { submit, unchanged } = setup();
    const rejected = submit([
      {
        out_col: 'Value',
        upstream_columns: [{ node: BRANCH, col: 'Missing', bogus: 1 }],
      },
    ]);
    expect(rejected.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'column_flow.0.upstream_columns.0.bogus',
          code: 'unknown_key',
        }),
        expect.objectContaining({
          path: 'column_flow.0.upstream_columns.0.col',
          code: 'unknown_column',
        }),
      ]),
    );
    expect(missingIds(rejected)).toEqual([OTHER]);
    unchanged();
  });

  it('claims no missing outcome when a faulty flow reaching the engine names an unresolvable object', () => {
    const { engine, unchanged } = setup();
    const rejected = engine.submitFindings({
      focus_node_id: ORIGIN,
      summary: 'Value provenance.',
      sections: [{ angle: 'technical', text: 'Authored evidence.' }],
      column_flow: [
        {
          out_col: 'Value',
          upstream_columns: [{ node: '[hop].[nowhere]', col: 'Value' }],
        },
      ],
    });
    expect(rejected).toHaveProperty('code');
    expect(missingIds(rejected as never)).toEqual([]);
    unchanged();
  });
});

/** An inherited investigation reaches a reader that does not use the table's Value. */
function tableArrivalWorld(mode: 'bb' | 'ct') {
  const nodes = [
    makeNode({
      id: ORIGIN,
      schema: 'hop',
      name: 'origin',
      type: 'table',
      columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }],
    }),
    makeNode({
      id: BRANCH,
      schema: 'hop',
      name: 'branch',
      type: 'view',
      bodyScript: `SELECT Other FROM ${ORIGIN};`,
    }),
    makeNode({
      id: OTHER,
      schema: 'hop',
      name: 'other',
      type: 'view',
      bodyScript: `SELECT Other FROM ${BRANCH};`,
    }),
  ];
  const pairs: Array<[string, string]> = [
    [ORIGIN, BRANCH],
    [BRANCH, OTHER],
  ];
  const model = makeIndexedModel(nodes, pairs);
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model;
  session.graph = graph;
  session.classification = 'technical';
  session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.classification = 'technical';
  expect(
    engine.init({
      origin: ORIGIN,
      question: 'Follow the Value investigation.',
      analysisMode: mode,
      ...(mode === 'ct' ? { targetColumns: ['Value'] } : {}),
      direction: 'downstream',
      depthIntent: {
        upstream: { levels: 0, exactness: 'exact' },
        downstream: { levels: 'all', exactness: 'exact' },
      },
    }),
  ).toHaveProperty('ok', true);
  const hop = engine.getHopContext();
  expect(hop).toMatchObject({ focus_node: { id: BRANCH } });
  expect(engine.toJSON().visited).toContain(ORIGIN);
  expect(engine.columnAspect?.edges ?? []).toEqual([]);
  session.stateMachine = engine;
  session.enterExploring(session.turnEpoch);
  const { services } = stubToolServices({ session, model, graph });
  return { engine, session, services };
}

describe('large findings repairs', () => {
  it('reports every independent fault of one submission in a single rejection without committing', () => {
    const { engine, session, model, graph } = ctWorld({ sibling: true });
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          summary: 'Value comes from Branch.',
          sections: { technical: 'Branch supplies Value.' },
          badge_label: 42,
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [{ node: BRANCH, col: 'Missing' }],
            },
          ],
          questions: [
            { nodeId: '[hop].[absent]', question: 'Explain Absent.' },
          ],
          prune_neighbors: [
            { id: '[hop].[absent]', reason: 'Unknown object.' },
          ],
        },
        services,
      ),
    );
    expect(rejected.issuePaths, JSON.stringify(rejected)).toEqual(
      expect.arrayContaining([
        'badge_label',
        'column_flow.0.upstream_columns.0.col',
        'questions.0.nodeId',
        'prune_neighbors.0.id',
      ]),
    );
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
  });
  // D-099: a focus mismatch cannot hide independent metadata or topology faults in the same reply.
  it.each(
    (['bb', 'ct'] as const).flatMap((mode) =>
      [OTHER, null, 42].map((focus) => ({ mode, focus })),
    ),
  )(
    'reports independent $mode faults without holding an invalid explicit focus $focus',
    ({ mode, focus }) => {
      const { engine, session, model, graph } = ctWorld({ mode });
      const { services } = stubToolServices({ session, model, graph });
      const before = engine.toJSON();
      const input = {
        focus_node_id: focus,
        summary: 'Value provenance.',
        sections: {
          technical: 'A complete finding for the wrong or unnamed focus.',
        },
        ...(mode === 'ct'
          ? {
              column_flow: [
                {
                  out_col: 'Value',
                  upstream_columns: [{ node: BRANCH, col: 'Missing' }],
                },
              ],
            }
          : {
              prune_neighbors: [
                { id: BRANCH, reason: 'Do not investigate this supplier.' },
              ],
            }),
        questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
      };
      const rejected = JSON.parse(executeSubmitFindings(input, services));
      expect(rejected.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'focus_node_id',
            code: 'not_current_object',
          }),
          expect.objectContaining(
            mode === 'ct'
              ? {
                  path: 'column_flow.0.upstream_columns.0.col',
                  code: 'unknown_column',
                }
              : { path: 'questions.0.nodeId', code: 'conflict' },
          ),
        ]),
      );
      expect(engine.heldPartsOfCurrentFocus()).toBeNull();
      expect(engine.toJSON()).toEqual(before);
      const corrected = {
        ...input,
        focus_node_id: ORIGIN,
        ...(mode === 'ct'
          ? {
              column_flow: [
                {
                  out_col: 'Value',
                  upstream_columns: [{ node: BRANCH, col: 'Value' }],
                },
              ],
            }
          : { prune_neighbors: [] }),
      };
      expect(
        JSON.parse(executeSubmitFindings(corrected, services)),
      ).toHaveProperty('ok', true);
    },
  );
  it('holds shape-valid content under the dispatched hop and commits a correction that omits the faulty field and names it withdrawn', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const raw = {
      summary: 'Original Value provenance.',
      sections: { technical: 'Retain this authored SQL evidence.' },
      column_flow: [
        {
          out_col: 'Value',
          upstream_columns: [
            { node: BRANCH, col: 'Value', note: 'Original mapping note.' },
          ],
        },
      ],
      questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
      badge_label: 42,
    };
    const original = structuredClone(raw);
    const before = engine.toJSON();
    const rejected = JSON.parse(executeSubmitFindings(raw, services));
    expect(raw).toEqual(original);
    expect(raw).not.toHaveProperty('focus_node_id');
    expect(rejected).toMatchObject({
      code: 'invalid_input',
      issuePaths: ['badge_label'],
    });
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({
      summary: true,
      sections: ['technical'],
      fields: expect.arrayContaining(['column_flow', 'questions']),
    });
    expect(engine.heldPartsOfCurrentFocus()!.fields).not.toContain(
      'badge_label',
    );
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.toJSON().visited).toEqual(before.visited);
    const held = engine.toJSON();
    expect(
      JSON.parse(executeSubmitFindings({ focus_node_id: BRANCH }, services)),
    ).toMatchObject({
      code: 'invalid_input',
      errors: expect.arrayContaining([
        { path: 'focus_node_id', code: 'not_current_object', values: [ORIGIN] },
      ]),
    });
    expect(engine.toJSON()).toEqual(held);
    expect(JSON.parse(executeSubmitFindings({}, services))).toMatchObject({
      ok: true,
      withdrawn: ['badge_label'],
    });
    expect(engine.columnAspect!.edges).toEqual([
      expect.objectContaining({
        from_node: BRANCH,
        note: 'Original mapping note.',
      }),
    ]);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
      summary: raw.summary,
      sections: [{ angle: 'technical', text: raw.sections.technical }],
    });
    expect(engine.heldPartsOfCurrentFocus()).toBeNull();
    expect(
      JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN }, services)),
    ).toHaveProperty('code');
  });
  it('owes a faulty field only while its ToolDraft holds the hop: the next hop owes nothing (D-126 one hold owner)', () => {
    const { engine, session, model, graph } = ctWorld({ mode: 'bb' });
    const { services } = stubToolServices({ session, model, graph });
    const finding = {
      summary: 'Origin reads Branch.',
      sections: { technical: 'SELECT Value FROM Branch.' },
    };
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            ...finding,
            questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
            badge_label: 42,
          },
          services,
        ),
      ),
    ).toMatchObject({ code: 'invalid_input', issuePaths: ['badge_label'] });
    expect(engine.getDetailSlots()).toEqual([]);
    expect(JSON.parse(executeSubmitFindings({}, services))).toMatchObject({
      ok: true,
      next_focus: BRANCH,
      withdrawn: ['badge_label'],
    });
    expect(JSON.parse(executeSubmitFindings(finding, services))).toSatisfy(
      (ack: object) => 'ok' in ack && !('withdrawn' in ack),
    );
  });
  it('does not provisionally retain a missing-focus payload before a hop is dispatched', () => {
    const { engine, session, model, graph } = ctWorld();
    expect(
      engine.init({
        origin: ORIGIN,
        question: 'Trace Value.',
        analysisMode: 'ct',
        targetColumns: ['Value'],
        direction: 'upstream',
        depthIntent: {
          upstream: { levels: 'all', exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      }),
    ).toHaveProperty('ok', true);
    const { services } = stubToolServices({ session, model, graph });
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            summary: 'Unbound.',
            sections: { technical: 'No dispatched hop.' },
            column_flow: [],
          },
          services,
        ),
      ),
    ).toHaveProperty('code');
    expect(engine.heldPartsOfCurrentFocus()).toBeNull();
  });
  it('commits an omitted focus as the dispatched hop and names it in the acknowledgement', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const accepted = JSON.parse(
      executeSubmitFindings(
        {
          summary: 'Original summary.',
          sections: { technical: 'Original findings.' },
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [{ node: BRANCH, col: 'Value' }],
            },
          ],
          questions: [],
        },
        services,
      ),
    );
    expect(accepted).toMatchObject({
      ok: true,
      accepted_focus: ORIGIN,
      next_focus: BRANCH,
    });
    expect(engine.toJSON().columnAspect).not.toEqual(before.columnAspect);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
      summary: 'Original summary.',
      sections: [{ angle: 'technical', text: 'Original findings.' }],
    });
  });
  it.each(['malformed-note', 'unsupported-key'] as const)(
    'reports a bad column independently of $0 on the same supplier',
    (fault) => {
      const { engine, session, model, graph } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const before = engine.toJSON();
      const rejected = JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            summary: 'Branch supplies Value.',
            sections: { technical: 'Keep the valid prose.' },
            questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns: [
                  {
                    node: BRANCH,
                    col: 'Missing',
                    ...(fault === 'malformed-note'
                      ? { note: 42 }
                      : { unsupported: true }),
                  },
                ],
              },
            ],
          },
          services,
        ),
      );
      expect(rejected).toMatchObject({
        code: 'invalid_input',
        issuePaths: expect.arrayContaining([
          `column_flow.0.upstream_columns.0.${fault === 'malformed-note' ? 'note' : 'unsupported'}`,
          'column_flow.0.upstream_columns.0.col',
        ]),
        detail: expect.arrayContaining([
          expect.objectContaining({
            kind: 'bad_contributor_col',
            path: 'column_flow.0.upstream_columns.0.col',
          }),
        ]),
      });
      const after = engine.toJSON();
      for (const key of [
        'agenda',
        'visited',
        'removedSet',
        'columnAspect',
        'scopeNodeIds',
      ] as const)
        expect(after[key]).toEqual(before[key]);
      expect(rejected.resend).toEqual(['column_flow']);
      expect(
        JSON.parse(
          executeSubmitFindings(
            {
              focus_node_id: ORIGIN,
              column_flow: [
                {
                  out_col: 'Value',
                  upstream_columns: [
                    {
                      node: BRANCH,
                      col: 'Value',
                      ...(fault === 'malformed-note'
                        ? { note: 'Corrected supplier note.' }
                        : {}),
                    },
                  ],
                },
              ],
            },
            services,
          ),
        ),
      ).toHaveProperty('ok', true);
      expect(engine.columnAspect!.edges).toHaveLength(1);
      expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
        summary: 'Branch supplies Value.',
        sections: [{ angle: 'technical', text: 'Keep the valid prose.' }],
      });
    },
  );
  it('MW7: a malformed sections container never invents missing child bodies beside independent faults', () => {
    const { engine, session, model, graph } = ctWorld();
    engine.classification = 'both';
    session.classification = 'both';
    const { services } = stubToolServices({ session, model, graph });
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          summary: 'Preserve findings.',
          badge_label: 42,
          sections: '{broken JSON',
          questions: [{ nodeId: BRANCH, question: 'Resolve Value.' }],
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [{ node: BRANCH, col: 'Value' }],
            },
          ],
        },
        services,
      ),
    );
    expect(rejected.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'sections', code: 'json_text' }),
        expect.objectContaining({ path: 'badge_label', code: 'type' }),
      ]),
    );
    expect(
      rejected.errors.filter((error: { path: string }) =>
        error.path.startsWith('sections.'),
      ),
    ).toEqual([]);
    expect(engine.getDetailSlots()).toEqual([]);
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            sections: {
              business: 'Business evidence.',
              technical: 'Technical evidence.',
            },
            badge_label: 'Short',
          },
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
  });

  it('MW7: keeps an independent missing neighbor outcome beside a required out_node omission', () => {
    const { engine, session, model, graph } = ctWorld({
      selfLoop: true,
      outsideWrite: true,
    });
    const { services } = stubToolServices({ session, model, graph });
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          summary: 'Outside supplier evidence.',
          sections: { technical: 'Retain the supplied evidence.' },
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [{ node: OTHER, col: 'Value' }],
            },
          ],
        },
        services,
      ),
    );
    expect(rejected.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'column_flow.0.out_node',
          code: 'missing',
        }),
        expect.objectContaining({
          path: '',
          code: 'neighbor_undecided',
          values: [BRANCH],
        }),
      ]),
    );
    expect(engine.getDetailSlots()).toEqual([]);
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            column_flow: [],
            questions: [
              { nodeId: BRANCH, question: 'Resolve the source Value.' },
            ],
          },
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
  });

  it('MW7: validates a findings candidate once and derives partial diagnostics without reparsing its fields', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const schema = engine.findingSchema();
    const owners = new Set<z.ZodType>();
    const visit = (owner: z.ZodType): void => {
      if (owners.has(owner)) return;
      owners.add(owner);
      if (owner instanceof z.ZodObject)
        Object.values(owner.shape).forEach((child) =>
          visit(child as z.ZodType),
        );
      else if (owner instanceof z.ZodArray) visit(owner.element as z.ZodType);
      else if (owner instanceof z.ZodOptional || owner instanceof z.ZodNullable)
        visit(owner.unwrap() as z.ZodType);
      else if (owner instanceof z.ZodUnion)
        owner.options.forEach((child) => visit(child as z.ZodType));
    };
    visit(schema);
    const full = vi.spyOn(toolValidation, 'validateToolCandidate');
    const children = [...owners]
      .filter((owner) => owner !== schema)
      .map((owner) => vi.spyOn(owner, 'safeParse'));
    const baseFlow = vi.spyOn(ColumnFlowSchema, 'safeParse');
    try {
      const rejected = JSON.parse(
        executeSubmitFindings(
          {
            summary: 'Preserve findings.',
            sections: { technical: 'Retain SQL evidence.' },
            badge_label: 42,
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns: [{ node: BRANCH, col: 'Missing' }],
              },
            ],
            questions: [{ nodeId: BRANCH, question: 'Resolve Value.' }],
          },
          services,
        ),
      );
      expect(rejected.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'badge_label', code: 'type' }),
          expect.objectContaining({
            path: 'column_flow.0.upstream_columns.0.col',
            code: 'unknown_column',
          }),
        ]),
      );
      expect(full).toHaveBeenCalledTimes(1);
      // Zod's optional metadata probe may parse undefined; candidate fields are never reparsed.
      expect(
        children
          .flatMap((spy) => spy.mock.calls)
          .every((args) => args[0] === undefined),
      ).toBe(true);
      expect(baseFlow).not.toHaveBeenCalled();
      expect(engine.getDetailSlots()).toEqual([]);
    } finally {
      full.mockRestore();
      children.forEach((spy) => spy.mockRestore());
      baseFlow.mockRestore();
    }
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns: [{ node: BRANCH, col: 'Value' }],
              },
            ],
          },
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
    expect(engine.getDetailSlots()).toContainEqual(
      expect.objectContaining({ summary: 'Preserve findings.' }),
    );
  });

  it.each(['unsupported-key', 'bad-output'] as const)(
    'reports a bad supplier independently of its $0 entry header',
    (fault) => {
      const { engine, session, model, graph } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const before = engine.toJSON();
      const rejected = JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            summary: 'Branch supplies Value.',
            sections: { technical: 'Keep this analysis.' },
            questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
            column_flow: [
              {
                out_col: fault === 'bad-output' ? 'AbsentOutput' : 'Value',
                ...(fault === 'unsupported-key' ? { unsupported: true } : {}),
                upstream_columns: [{ node: BRANCH, col: 'Missing' }],
              },
            ],
          },
          services,
        ),
      );
      expect(rejected).toMatchObject({
        code: 'invalid_input',
        issuePaths: expect.arrayContaining([
          `column_flow.0.${fault === 'unsupported-key' ? 'unsupported' : 'out_col'}`,
          'column_flow.0.upstream_columns.0.col',
        ]),
        detail: expect.arrayContaining([
          expect.objectContaining({
            kind: 'bad_contributor_col',
            path: 'column_flow.0.upstream_columns.0.col',
          }),
        ]),
      });
      const after = engine.toJSON();
      for (const key of [
        'agenda',
        'visited',
        'removedSet',
        'columnAspect',
        'scopeNodeIds',
      ] as const)
        expect(after[key]).toEqual(before[key]);
      expect(
        JSON.parse(
          executeSubmitFindings(
            {
              focus_node_id: ORIGIN,
              column_flow: [
                {
                  out_col: 'Value',
                  upstream_columns: [{ node: BRANCH, col: 'Value' }],
                },
              ],
            },
            services,
          ),
        ),
      ).toHaveProperty('ok', true);
      expect(engine.columnAspect!.edges).toHaveLength(1);
      expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
        summary: 'Branch supplies Value.',
        sections: [{ angle: 'technical', text: 'Keep this analysis.' }],
      });
    },
  );
  it.each(
    (['unsupported-key', 'wrong-type'] as const).flatMap((fault) =>
      [0, 1].map((entryIndex) => ({ fault, entryIndex })),
    ),
  )(
    'reports an independent bad column beside $fault at original entry $entryIndex without committing either',
    ({ fault, entryIndex }) => {
      const { engine, session, model, graph } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const malformed =
        fault === 'unsupported-key'
          ? { node: BRANCH, col: 'Value', unsupported: true }
          : { node: BRANCH, col: 42 };
      const before = engine.toJSON();
      const rejected = JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            summary: 'Branch supplies Value.',
            sections: { technical: 'Keep this valid analysis.' },
            column_flow: [
              ...(entryIndex
                ? [
                    {
                      out_col: 'Value',
                      upstream_columns: [],
                      unsupported: true,
                    },
                  ]
                : []),
              {
                out_col: 'Value',
                upstream_columns: [
                  malformed,
                  { node: BRANCH, col: 'Missing' },
                  {
                    node: BRANCH,
                    col: 'Value',
                    note: 'This valid sibling stays held.',
                  },
                ],
              },
            ],
            questions: [
              { nodeId: BRANCH, question: 'Establish Value provenance.' },
            ],
          },
          services,
        ),
      );
      expect(rejected).toMatchObject({
        code: 'invalid_input',
        issuePaths: expect.arrayContaining([
          `column_flow.${entryIndex}.upstream_columns.0.${fault === 'unsupported-key' ? 'unsupported' : 'col'}`,
          `column_flow.${entryIndex}.upstream_columns.1.col`,
        ]),
        detail: expect.arrayContaining([
          expect.objectContaining({
            kind: 'bad_contributor_col',
            path: `column_flow.${entryIndex}.upstream_columns.1.col`,
          }),
        ]),
      });
      const after = engine.toJSON();
      for (const key of [
        'agenda',
        'visited',
        'removedSet',
        'columnAspect',
        'scopeNodeIds',
      ] as const)
        expect(after[key]).toEqual(before[key]);
      expect(rejected.resend).toEqual(['column_flow']);
      expect(
        JSON.parse(
          executeSubmitFindings(
            {
              focus_node_id: ORIGIN,
              column_flow: [
                {
                  out_col: 'Value',
                  upstream_columns: [
                    { node: BRANCH, col: 'Value' },
                    { node: BRANCH, col: 'Value' },
                    {
                      node: BRANCH,
                      col: 'Value',
                      note: 'This valid sibling is resent with the list.',
                    },
                  ],
                },
              ],
            },
            services,
          ),
        ),
      ).toHaveProperty('ok', true);
      expect(engine.columnAspect!.edges).toHaveLength(3);
      expect(engine.columnAspect!.edges[2].note).toBe(
        'This valid sibling is resent with the list.',
      );
    },
  );
  it('keeps a valid resent held field, reports the faulty one and keeps its held copy (D-098)', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const original = {
      focus_node_id: ORIGIN,
      summary: 'Branch supplies Value.',
      sections: { technical: 'Preserve this original finding.' },
      column_flow: [
        {
          out_col: 'Value',
          upstream_columns: [{ node: BRANCH, col: 'Missing' }],
        },
      ],
      questions: [{ nodeId: BRANCH, question: 'Establish Value provenance.' }],
    };
    expect(
      JSON.parse(executeSubmitFindings(original, services)),
    ).toHaveProperty('code');
    const correction = {
      focus_node_id: ORIGIN,
      summary: 'Amended summary.',
      column_flow: [
        {
          out_col: 'Value',
          upstream_columns: [{ node: BRANCH, col: 'Value' }],
        },
      ],
    };
    const before = engine.toJSON();
    const malformed = JSON.parse(
      executeSubmitFindings({ ...correction, sections: 42 }, services),
    );
    expect(malformed).toMatchObject({
      code: 'invalid_input',
      issuePaths: ['sections'],
      resend: ['sections'],
    });
    for (const key of [
      'agenda',
      'visited',
      'removedSet',
      'columnAspect',
      'scopeNodeIds',
    ] as const)
      expect(engine.toJSON()[key]).toEqual(before[key]);
    expect(
      JSON.parse(executeSubmitFindings({ focus_node_id: ORIGIN }, services)),
    ).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toHaveLength(1);
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
      summary: correction.summary,
      sections: [{ angle: 'technical', text: original.sections.technical }],
    });
  });
  it.each([false, true])(
    'holds intrinsically valid mappings for an action-only prune correction (schema fault: %s)',
    (schemaFault) => {
      const { engine, session, model, graph } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const before = engine.toJSON();
      const draft = {
        focus_node_id: ORIGIN,
        summary: 'Value comes from Branch.',
        sections: { technical: 'Retain the original SQL findings.' },
        column_flow: [
          {
            out_col: 'Value',
            upstream_columns: [
              { node: BRANCH, col: 'Value', note: 'Keep this mapping.' },
            ],
          },
        ],
        prune_neighbors: [{ id: BRANCH, reason: 'No further investigation.' }],
      };
      const rejected = JSON.parse(
        executeSubmitFindings(
          { ...draft, ...(schemaFault ? { badge_label: 42 } : {}) },
          services,
        ),
      );
      expect(rejected).toMatchObject({
        issuePaths: expect.arrayContaining([
          'prune_neighbors.0.id',
          'column_flow.0.upstream_columns.0',
        ]),
      });
      expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
      expect(engine.toJSON().agenda).toEqual(before.agenda);
      expect(engine.toJSON().removedSet).toEqual(before.removedSet);
      expect(engine.heldPartsOfCurrentFocus()?.fields).toContain('column_flow');
      const correction = {
        focus_node_id: ORIGIN,
        prune_neighbors: [],
        questions: [
          { nodeId: BRANCH, question: 'Establish the source of Value.' },
        ],
      };
      const schema = engine.findingSchema();
      const card = new Ajv({ strict: false }).compile(
        toModelJsonSchema(schema),
      );
      // D-098/D-099: the live card accepts the correction that admission composes with held findings.
      expect(card(correction)).toBe(true);
      expect(card({ ...draft, ...correction })).toBe(true);
      expect(
        JSON.parse(executeSubmitFindings(correction, services)),
      ).toHaveProperty('ok', true);
      expect(engine.columnAspect!.edges).toEqual([
        expect.objectContaining({
          from_node: BRANCH,
          from_col: 'Value',
          note: 'Keep this mapping.',
        }),
      ]);
      expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
        summary: 'Value comes from Branch.',
        sections: [
          { angle: 'technical', text: 'Retain the original SQL findings.' },
        ],
      });
      expect(engine.toJSON().removedSet).toEqual([]);
    },
  );
  it.each([true, false])(
    'uses only validated pairs for prune diagnostics beside a malformed entry (valid destination: %s)',
    (validDestination) => {
      const { engine, session, model, graph } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const before = engine.toJSON();
      const draft = {
        focus_node_id: ORIGIN,
        summary: 'Original findings.',
        sections: { technical: 'Keep the SQL evidence.' },
      };
      const rejected = JSON.parse(
        executeSubmitFindings(
          {
            ...draft,
            questions: [],
            column_flow: [
              {
                out_col: validDestination ? 'Value' : 'Missing',
                upstream_columns: [{ node: BRANCH, col: 'Value' }],
              },
              {
                out_col: 'Value',
                upstream_columns: [],
                note: 'Misplaced header field.',
              },
            ],
            prune_neighbors: [
              { id: BRANCH, reason: 'Outside the investigation.' },
            ],
          },
          services,
        ),
      );
      expect(rejected).toMatchObject({
        code: 'invalid_input',
        issuePaths: expect.arrayContaining(['column_flow.1.note']),
      });
      const pruneFaults = (rejected.detail ?? []).filter(
        (fault: { kind: string }) => fault.kind === 'prune_unsupported',
      );
      expect(pruneFaults).toHaveLength(validDestination ? 1 : 0);
      if (validDestination)
        expect(pruneFaults[0]).toMatchObject({
          id: BRANCH,
          path: 'prune_neighbors.0.id',
        });
      expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
      expect(engine.toJSON().agenda).toEqual(before.agenda);
      expect(engine.toJSON().removedSet).toEqual(before.removedSet);
      expect(engine.toJSON().visited).toEqual(before.visited);
      const correction = {
        focus_node_id: ORIGIN,
        column_flow: [
          {
            out_col: 'Value',
            upstream_columns: [{ node: BRANCH, col: 'Value' }],
          },
          { out_col: 'Value', upstream_columns: [] },
        ],
        prune_neighbors: [],
        questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
      };
      const repaired = JSON.parse(executeSubmitFindings(correction, services));
      expect(repaired).toHaveProperty('ok', true);
      expect(engine.columnAspect!.edges).toHaveLength(1);
    },
  );
  it.each([
    {
      name: 'rejected suppliers',
      explicitEmpty: false,
      born: false,
      validSupplier: false,
      sibling: false,
      badTarget: false,
      rejectedSibling: false,
      protectedTarget: false,
    },
    // D-130: a procedure-created value is the pair procedure.col -> out_node.out_col; [] records no pair.
    {
      name: 'procedure-created value',
      explicitEmpty: false,
      born: true,
      validSupplier: false,
      sibling: false,
      badTarget: false,
      rejectedSibling: false,
      protectedTarget: true,
    },
    {
      name: 'valid partial supplier',
      explicitEmpty: false,
      born: false,
      validSupplier: true,
      sibling: false,
      badTarget: false,
      rejectedSibling: false,
      protectedTarget: true,
    },
    {
      name: 'valid sibling mapping',
      explicitEmpty: false,
      born: false,
      validSupplier: false,
      sibling: true,
      badTarget: false,
      rejectedSibling: false,
      protectedTarget: true,
    },
    {
      name: 'independent target fault',
      explicitEmpty: false,
      born: false,
      validSupplier: false,
      sibling: false,
      badTarget: true,
      rejectedSibling: false,
      protectedTarget: false,
    },
    {
      name: 'authored empty suppliers beside a rejected sibling',
      explicitEmpty: true,
      born: false,
      validSupplier: false,
      sibling: false,
      badTarget: false,
      rejectedSibling: true,
      protectedTarget: false,
    },
  ])(
    'preserves original source-list presence in $name diagnostics',
    ({
      explicitEmpty,
      born,
      validSupplier,
      sibling,
      badTarget,
      rejectedSibling,
      protectedTarget,
    }) => {
      const { engine, session, model, graph } = ctWorld({
        selfLoop: true,
        sibling: true,
      });
      const { services } = stubToolServices({ session, model, graph });
      const before = engine.toJSON();
      const result = JSON.parse(
        executeSubmitFindings(
          {
            summary: 'Authored evidence.',
            sections: { technical: 'Keep the supplied source facts.' },
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns: explicitEmpty
                  ? []
                  : born
                    ? [{ node: ORIGIN, col: 'Value' }]
                    : [
                        { node: '[hop].[unknown]', col: 'Value' },
                        ...(validSupplier
                          ? [{ node: OTHER, col: 'Value' }]
                          : []),
                      ],
                out_node: BRANCH,
                ...(badTarget ? { out_col: 'Missing' } : {}),
              },
              ...(rejectedSibling
                ? [
                    {
                      out_node: BRANCH,
                      out_col: 'Value',
                      upstream_columns: [
                        { node: '[hop].[unknown]', col: 'Value' },
                      ],
                    },
                  ]
                : []),
              ...(sibling
                ? [
                    {
                      out_node: BRANCH,
                      out_col: 'Value',
                      upstream_columns: [{ node: OTHER, col: 'Value' }],
                    },
                  ]
                : []),
            ],
            prune_neighbors: [
              { id: BRANCH, reason: 'Outside this investigation.' },
            ],
            questions:
              validSupplier || sibling
                ? []
                : [{ nodeId: OTHER, question: 'Explain Value.' }],
          },
          services,
        ),
      );
      expect(
        [result.detail ?? []]
          .flat()
          .filter(
            (fault: { kind: string }) => fault.kind === 'prune_unsupported',
          ),
      ).toHaveLength(protectedTarget ? 1 : 0);
      if (badTarget)
        expect(result.detail).toContainEqual(
          expect.objectContaining({
            kind: 'bad_out_col',
            path: 'column_flow.0.out_col',
          }),
        );
      expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
      expect(engine.toJSON().agenda).toEqual(before.agenda);
      expect(engine.toJSON().removedSet).toEqual(before.removedSet);
    },
  );
  it('accepts authored empty suppliers at a procedure as no pair, so the out_node prune applies (D-130)', () => {
    const { engine, session, model, graph } = ctWorld({
      selfLoop: true,
      sibling: true,
    });
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            summary: 'Authored evidence.',
            sections: { technical: 'Keep the supplied source facts.' },
            column_flow: [
              { out_node: BRANCH, out_col: 'Value', upstream_columns: [] },
            ],
            prune_neighbors: [
              { id: BRANCH, reason: 'Outside this investigation.' },
            ],
            questions: [{ nodeId: OTHER, question: 'Explain Value.' }],
          },
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().removedSet).toEqual([BRANCH]);
  });
  it.each(['alternatives', 'mixed', 'flowfault'] as const)(
    'keeps the original hop task after %s faults without a saved-field inventory',
    (kind) => {
      const { engine, session, model, graph } = ctWorld({ sibling: true });
      const { services } = stubToolServices({ session, model, graph });
      const originalMessage = buildActiveHopInstruction(
        session,
        engine,
        ORIGIN,
      ).message;
      const rejected = JSON.parse(
        executeSubmitFindings(
          {
            summary: 'Authored evidence.',
            sections: { technical: 'Keep these source facts.' },
            column_flow:
              kind === 'flowfault'
                ? 42
                : [
                    {
                      out_col: 'Value',
                      upstream_columns: [{ node: BRANCH, col: 'Value' }],
                    },
                  ],
            ...(kind === 'mixed' ? { badge_label: 'x'.repeat(51) } : {}),
          },
          services,
        ),
      );
      const required =
        kind === 'flowfault'
          ? ['column_flow']
          : kind === 'mixed'
            ? ['badge_label']
            : [];
      const alternatives =
        kind === 'flowfault'
          ? []
          : ['questions', 'prune_neighbors', 'column_flow'];
      expect(engine.heldPartsOfCurrentFocus()).toMatchObject({
        resend: required,
      });
      expect(rejected.resend).toEqual([
        ...new Set([...required, ...alternatives]),
      ]);
      const message = buildActiveHopInstruction(
        session,
        engine,
        ORIGIN,
      ).message;
      expect(message).not.toContain('Fields to correct:');
      expect(message).toBe(originalMessage);
      expect(message).not.toContain('Saved valid content:');
      if (kind === 'alternatives') {
        expect(
          JSON.parse(
            executeSubmitFindings(
              {
                prune_neighbors: [
                  { id: OTHER, reason: 'No requested contribution.' },
                ],
              },
              services,
            ),
          ),
        ).toHaveProperty('ok', true);
        expect(engine.getDetailSlots()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ summary: 'Authored evidence.' }),
          ]),
        );
      }
    },
  );
  it.each([
    { target: OTHER, shape: 'normal', scope: true },
    { target: OTHER.toUpperCase(), shape: 'normal', scope: true },
    { target: '[hop].[missing]', shape: 'normal', scope: false },
    { target: OTHER, shape: 'target-type', scope: false },
    { target: OTHER, shape: 'source-type', scope: true },
  ])(
    'reports write references and only established scope alternatives beside $shape faults ($target)',
    ({ target, shape, scope }) => {
      const { engine, session, model, graph } = ctWorld({
        selfLoop: true,
        outsideWrite: true,
      });
      const { services } = stubToolServices({ session, model, graph });
      const before = engine.toJSON();
      const result = JSON.parse(
        executeSubmitFindings(
          {
            summary: 'Known outside destination.',
            sections: {
              technical: 'Keep the outside write in these findings.',
            },
            questions: [
              { nodeId: BRANCH, question: 'Establish the supplied Value.' },
            ],
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns:
                  shape === 'source-type'
                    ? 42
                    : [{ node: BRANCH, col: 'Value' }],
                out_node: shape === 'target-type' ? 42 : target,
              },
            ],
          },
          services,
        ),
      );
      const errors = result.errors as Array<{ path: string; code: string }>;
      expect(
        errors.some(
          (error) =>
            error.path === 'column_flow.0.out_node' &&
            error.code === (scope ? 'column_out_of_scope' : 'not_neighbor'),
        ),
      ).toBe(shape !== 'target-type');
      if (scope) {
        expect(
          errors.filter((error) => error.path === 'column_flow.0.out_node'),
        ).toHaveLength(1);
        const firstFeedback = JSON.parse(
          renderProblem(readToolErrorText(JSON.stringify(result))!, 1),
        );
        const scopeIssue = shownErrors(firstFeedback).find(
          (error) => error.code === 'column_out_of_scope',
        );
        expect(scopeIssue).toMatchObject({
          path: 'column_flow.0.out_node',
          code: 'column_out_of_scope',
        });
        expect(scopeIssue).not.toHaveProperty('allowed');
      }
      const shapePath =
        shape === 'target-type'
          ? 'column_flow.0.out_node'
          : shape === 'source-type'
            ? 'column_flow.0.upstream_columns'
            : undefined;
      if (shapePath)
        expect(errors.some((error) => error.path === shapePath)).toBe(true);
      expect([...result.resend].sort()).toEqual(
        scope ? ['column_flow', 'questions', 'sections'] : ['column_flow'],
      );
      expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
      expect(engine.toJSON().agenda).toEqual(before.agenda);
      expect(
        JSON.parse(executeSubmitFindings({ column_flow: [] }, services)),
      ).toHaveProperty('ok', true);
      expect(engine.getDetailSlots()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ summary: 'Known outside destination.' }),
        ]),
      );
    },
  );
  it.each([
    'known',
    'unknown-target',
    'unreadable-target',
    'unknown-source',
    'unreadable-sources',
  ] as const)(
    'reports certain missing outcomes without admitting a %s flow header',
    (kind) => {
      const { engine, session, model, graph } = ctWorld({
        selfLoop: true,
        outsideWrite: true,
        extraSource: true,
      });
      const { services } = stubToolServices({ session, model, graph });
      const before = engine.toJSON();
      const draft = {
        summary: 'Known reference facts.',
        sections: { technical: 'Outside destination retained as evidence.' },
      };
      const result = JSON.parse(
        executeSubmitFindings(
          {
            ...draft,
            questions: [
              { nodeId: BRANCH, question: 'Establish the source Value.' },
            ],
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns:
                  kind === 'unreadable-sources'
                    ? 42
                    : [
                        {
                          node:
                            kind === 'unknown-source'
                              ? '[hop].[missing]'
                              : BRANCH,
                          col: 'Value',
                        },
                      ],
                out_node:
                  kind === 'unreadable-target'
                    ? 42
                    : kind === 'unknown-target'
                      ? '[hop].[missing]'
                      : OTHER,
              },
            ],
          },
          services,
        ),
      );
      const missingIds = (result.detail ?? [])
        .filter(
          (fault: { kind: string }) =>
            fault.kind === 'neighbor_outcome_missing',
        )
        .map((fault: { id: string }) => fault.id);
      expect(missingIds).toEqual(kind === 'known' ? ['[hop].[extra]'] : []);
      expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
      expect(engine.toJSON().agenda).toEqual(before.agenda);
      const correction = {
        column_flow: [],
        prune_neighbors: [
          { id: '[hop].[extra]', reason: 'No required contribution.' },
        ],
      };
      const repaired = JSON.parse(executeSubmitFindings(correction, services));
      expect(repaired).toHaveProperty('ok', true);
      expect(engine.getDetailSlots()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ summary: 'Known reference facts.' }),
        ]),
      );
    },
  );
  it('rejects an unsupported prune key without committing when prune identities are valid', () => {
    const { engine, session, model, graph } = ctWorld({ sibling: true });
    const { services } = stubToolServices({ session, model, graph });
    const before = engine.toJSON();
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          focus_node_id: ORIGIN,
          summary: 'Value comes from Branch.',
          sections: { technical: 'Keep these valid SQL findings.' },
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [{ node: BRANCH, col: 'Value' }],
            },
          ],
          questions: [],
          prune_neighbors: [
            {
              id: OTHER,
              reason: 'This neighbor is outside the requested calculation.',
              reasons: '',
            },
          ],
        },
        services,
      ),
    );
    expect(rejected).toMatchObject({
      issuePaths: ['prune_neighbors.0.reasons'],
    });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.toJSON().removedSet).toEqual(before.removedSet);
  });
  it('reports a malformed entry and a separate supplier together and accepts the whole corrected list', () => {
    const { engine, session, model, graph } = ctWorld({ other: true });
    const { services } = stubToolServices({ session, model, graph });
    const sibling = {
      node: BRANCH,
      col: 'Value',
      note: 'Retain this valid sibling verbatim.',
    };
    const before = engine.toJSON();
    const draft = {
      focus_node_id: ORIGIN,
      summary: 'Original summary.',
      sections: { technical: 'Original SQL findings.' },
    };
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          ...draft,
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [{ node: BRANCH, col: 'Missing' }],
              note: 'Misplaced header field.',
            },
            {
              out_col: 'Other',
              upstream_columns: [
                sibling,
                {
                  node: BRANCH,
                  col: 'Missing',
                  note: 'Retain this supplier note.',
                },
              ],
            },
          ],
          questions: [
            { nodeId: BRANCH, question: 'Establish both source columns.' },
          ],
        },
        services,
      ),
    );
    expect(rejected).toMatchObject({
      code: 'invalid_input',
      issuePaths: expect.arrayContaining([
        'column_flow.0.note',
        'column_flow.0.upstream_columns.0.col',
        'column_flow.1.upstream_columns.1.col',
      ]),
      resend: ['column_flow'],
    });
    expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    const correction = {
      focus_node_id: ORIGIN,
      column_flow: [
        {
          out_col: 'Value',
          upstream_columns: [{ node: BRANCH, col: 'Value' }],
        },
        {
          out_col: 'Other',
          upstream_columns: [
            sibling,
            { node: BRANCH, col: 'Other', note: 'Retain this supplier note.' },
          ],
        },
      ],
    };
    expect(
      JSON.parse(executeSubmitFindings(correction, services)),
    ).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toHaveLength(3);
    expect(engine.columnAspect!.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_col: 'Value',
          to_col: 'Other',
          note: sibling.note,
        }),
        expect.objectContaining({
          from_col: 'Other',
          to_col: 'Other',
          note: 'Retain this supplier note.',
        }),
      ]),
    );
    expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
      summary: 'Original summary.',
      sections: [{ angle: 'technical', text: 'Original SQL findings.' }],
    });
  });
  it.each(['column', 'schema', 'remove'] as const)(
    'resends the whole list after a rejected tuple: %s',
    (defect) => {
      const { engine, session, model, graph } = ctWorld({ other: true });
      const { services } = stubToolServices({ session, model, graph });
      const valid = {
        node: BRANCH,
        col: 'Other',
        note: 'Original tuple note.',
        transforms: ['compute'],
      };
      const bad =
        defect === 'column'
          ? { ...valid, col: 'Missing' }
          : defect === 'schema'
            ? { ...valid, unsupported: true }
            : { ...valid, node: OTHER };
      const flow = ['Value', 'Other'].map((out_col) => ({
        out_col,
        upstream_columns: [
          { node: BRANCH, col: 'Value', note: 'Keep this tuple verbatim.' },
          valid,
        ],
      }));
      flow[1]!.upstream_columns[1] = bad;
      const before = engine.toJSON();
      const draft = {
        focus_node_id: ORIGIN,
        summary: 'Both outputs use both inputs.',
        sections: {
          technical: 'Retain all valid relations and this original prose.',
        },
        column_flow: flow,
        questions: [
          { nodeId: BRANCH, question: 'Establish both source columns.' },
        ],
      };
      const rejected = JSON.parse(executeSubmitFindings(draft, services));
      expect(rejected).toHaveProperty('code');
      expect(rejected.issuePaths).toEqual(
        expect.arrayContaining([
          expect.stringContaining('column_flow.1.upstream_columns.1'),
        ]),
      );
      expect(engine.toJSON().columnAspect).toEqual(before.columnAspect);
      expect(engine.currentFocus).toBe(ORIGIN);
      const patch = {
        focus_node_id: ORIGIN,
        column_flow: flow.map((entry, index) =>
          index === 1
            ? {
                ...entry,
                upstream_columns:
                  defect === 'remove'
                    ? entry.upstream_columns.slice(0, 1)
                    : [entry.upstream_columns[0]!, valid],
              }
            : entry,
        ),
      };
      // D-099: the served schema admits the canonical resend; D-098: the held fields still compose with the flow patch.
      const schema = engine.findingSchema();
      const resend = patch;
      expect(
        new Ajv({ strict: false }).compile(toModelJsonSchema(schema))(resend),
      ).toBe(true);
      expect(JSON.parse(executeSubmitFindings(patch, services))).toHaveProperty(
        'ok',
        true,
      );
      expect(engine.columnAspect!.edges).toHaveLength(
        defect === 'remove' ? 3 : 4,
      );
      expect(
        engine.columnAspect!.edges.filter((edge) => edge.from_col === 'Value'),
      ).toHaveLength(2);
      if (defect !== 'remove')
        expect(
          engine.columnAspect!.edges.find(
            (edge) => edge.from_col === 'Other' && edge.to_col === 'Other',
          ),
        ).toMatchObject({
          note: 'Original tuple note.',
          transforms: ['compute'],
        });
      expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
        summary: 'Both outputs use both inputs.',
        sections: [
          {
            angle: 'technical',
            text: 'Retain all valid relations and this original prose.',
          },
        ],
      });
    },
  );
  it('rejects the removed column_flow_repairs field as an unknown key and holds nothing for it', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          focus_node_id: ORIGIN,
          column_flow_repairs: [
            {
              entry_index: 0,
              upstream_index: 0,
              replacement: { col: 'Value' },
            },
          ],
        },
        services,
      ),
    );
    expect(rejected).toMatchObject({
      code: 'invalid_input',
      issuePaths: expect.arrayContaining(['column_flow_repairs']),
      errors: expect.arrayContaining([
        expect.objectContaining({
          path: 'column_flow_repairs',
          code: 'unknown_key',
        }),
      ]),
    });
    expect(engine.heldPartsOfCurrentFocus()).toBeNull();
  });
  it('names separate defective suppliers at their original indexes and accepts the corrected whole list', () => {
    const { engine, session, model, graph } = ctWorld();
    model.nodes
      .find((node) => node.id === BRANCH)!
      .columns!.push({
        name: 'Other',
        type: 'int',
        nullable: 'NULL',
        extra: '',
      });
    const { services } = stubToolServices({ session, model, graph });
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          focus_node_id: ORIGIN,
          summary: 'Both inputs contribute.',
          sections: { technical: 'Keep this complete finding.' },
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [
                {
                  node: BRANCH,
                  col: 'Value',
                  note: 'This valid sibling stays unchanged.',
                },
                { node: OTHER, col: 'Value' },
                {
                  node: BRANCH,
                  col: 12,
                  note: 'Preserve this note during a column correction.',
                },
              ],
            },
          ],
          questions: [{ nodeId: BRANCH, question: 'Establish both inputs.' }],
        },
        services,
      ),
    );
    expect(rejected).toHaveProperty('code');
    expect(
      rejected.errors.map((error: { path: string }) => error.path),
    ).toEqual(
      expect.arrayContaining([
        'column_flow.0.upstream_columns.1.node',
        'column_flow.0.upstream_columns.2.col',
      ]),
    );
    expect(engine.columnAspect!.edges).toEqual([]);
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns: [
                  {
                    node: BRANCH,
                    col: 'Value',
                    note: 'This valid sibling stays unchanged.',
                  },
                  {
                    node: BRANCH,
                    col: 'Other',
                    note: 'Preserve this note during a column correction.',
                  },
                ],
              },
            ],
          },
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
    expect(
      engine.columnAspect!.edges.map((edge) => [edge.from_col, edge.note]),
    ).toEqual([
      ['Value', 'This valid sibling stays unchanged.'],
      ['Other', 'Preserve this note during a column correction.'],
    ]);
  });
  it.each([
    { malformed: { questions: 42 }, path: 'questions' },
    { malformed: { sections: { technical: 42 } }, path: 'sections.technical' },
    { malformed: { column_flow: 42 }, path: 'column_flow' },
    { malformed: { summary: 42 }, path: 'summary' },
  ])(
    'reports a faulty $path resent with a summary repair and keeps its held copy (D-098)',
    ({ malformed, path }) => {
      const { engine, session, model, graph } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const sections = { technical: 'Branch supplies Value unchanged.' };
      const column_flow = [
        {
          out_col: 'Value',
          upstream_columns: [{ node: BRANCH, col: 'Value' }],
        },
      ];
      const questions = [
        { nodeId: BRANCH, question: 'Establish the origin of Value.' },
      ];
      const submit = (input: object) =>
        JSON.parse(
          executeSubmitFindings({ focus_node_id: ORIGIN, ...input }, services),
        );
      expect(engine.heldPartsOfCurrentFocus()).toBeNull();
      expect(submit({ sections, column_flow, questions })).toMatchObject({
        code: 'invalid_input',
        issuePaths: ['summary'],
      });
      expect(engine.heldPartsOfCurrentFocus()).toMatchObject({
        sections: ['technical'],
        summary: false,
      });
      const before = engine.toJSON();
      const rejected = submit({
        summary: 'A valid replacement summary.',
        ...malformed,
      });
      expect(rejected).toHaveProperty('code', 'invalid_input');
      expect(rejected.issuePaths).toEqual([path]);
      expect(rejected.resend).toEqual(
        path === 'sections.technical' ? ['sections'] : [path],
      );
      const after = engine.toJSON();
      const summaryHeld = path !== 'summary';
      expect(engine.heldPartsOfCurrentFocus()).toMatchObject({
        sections: ['technical'],
        summary: summaryHeld,
        resend: [path],
      });
      for (const key of [
        'agenda',
        'visited',
        'removedSet',
        'columnAspect',
        'scopeNodeIds',
      ] as const)
        expect(after[key]).toEqual(before[key]);
      expect(
        submit(summaryHeld ? {} : { summary: 'Branch supplies Value.' }),
      ).toMatchObject({ ok: true, next_focus: BRANCH });
      expect(engine.getDetailSlots()).toContainEqual(
        expect.objectContaining({
          summary: summaryHeld
            ? 'A valid replacement summary.'
            : 'Branch supplies Value.',
        }),
      );
      expect(engine.columnAspect?.edges).toEqual([
        expect.objectContaining({
          from_node: BRANCH,
          from_col: 'Value',
          to_node: ORIGIN,
          to_col: 'Value',
        }),
      ]);
      expect(engine.heldPartsOfCurrentFocus()).toBeNull();
      expect(
        engine.getDetailSlots().find((slot) => slot.nodeId === ORIGIN)
          ?.sections,
      ).toEqual([{ angle: 'technical', text: sections.technical }]);
      expect(engine.getCurrentTasks()).toContainEqual(
        expect.objectContaining({ question: questions[0].question }),
      );
    },
  );

  it('holds long valid prose through repeated column errors and accepts only the corrected list', () => {
    const { engine, session, model, graph } = ctWorld();
    const { services } = stubToolServices({ session, model, graph });
    const text =
      'The supplied SQL establishes this business and technical finding. '.repeat(
        3000,
      );
    const valid = {
      focus_node_id: ORIGIN,
      summary: 'Branch supplies Value.',
      sections: { technical: text },
      questions: [
        { nodeId: BRANCH, question: 'Establish the origin of Value.' },
      ],
    };
    for (const [index, col] of ['Missing', 'StillMissing'].entries()) {
      const rejected = JSON.parse(
        executeSubmitFindings(
          {
            ...(index === 0 ? valid : { focus_node_id: ORIGIN }),
            column_flow: [
              { out_col: 'Value', upstream_columns: [{ node: BRANCH, col }] },
            ],
          },
          services,
        ),
      );
      expect(rejected).toMatchObject({
        code: 'invalid_input',
        issuePaths: ['column_flow.0.upstream_columns.0.col'],
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: 'column_flow.0.upstream_columns.0.col',
            code: 'unknown_column',
          }),
        ]),
      });
      expect(rejected.resend).toEqual(['column_flow']);
      expect(rejected).not.toHaveProperty('hint');
      expect(JSON.stringify(rejected)).not.toContain(text);
      expect(engine.getDetailSlots()).toEqual([]);
    }
    const accepted = JSON.parse(
      executeSubmitFindings(
        {
          focus_node_id: ORIGIN,
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [{ node: BRANCH, col: 'Value' }],
            },
          ],
        },
        services,
      ),
    );
    expect(accepted).toMatchObject({
      ok: true,
      accepted_focus: ORIGIN,
      next_focus: BRANCH,
    });
    expect(
      engine.getDetailSlots().find((slot) => slot.nodeId === ORIGIN)?.sections,
    ).toEqual([{ angle: 'technical', text }]);
  });
});

describe('lineage_prune_current boundary', () => {
  it.each(['[hop].[bran\u200bch]', 'hop..branch', 'other.branch'])(
    'rejects different or malformed focus identity %s before changing state',
    (focus_node_id) => {
      const { engine, services } = tableArrivalWorld('ct');
      const before = engine.toJSON();
      expect(
        JSON.parse(
          executePruneCurrent({ focus_node_id, reason: 'Off path.' }, services),
        ),
      ).toMatchObject({
        code: 'invalid_input',
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: 'focus_node_id',
            code: 'not_current_object',
          }),
        ]),
      });
      expect(engine.toJSON()).toEqual(before);
      expect(
        JSON.parse(
          executePruneCurrent(
            { focus_node_id: BRANCH, reason: 'Off path.' },
            services,
          ),
        ),
      ).toHaveProperty('ok', true);
    },
  );

  it.each(['bb', 'ct'] as const)(
    'accepts the exact current %s focus and completes through the shared acknowledgement',
    (mode) => {
      const { engine, session, services } = tableArrivalWorld(mode);
      const input = {
        focus_node_id: BRANCH,
        reason:
          'The supplied SQL uses only Other and does not answer the inherited purpose.',
      };
      const before = structuredClone(input);
      expect(engine.canPruneCurrent).toBe(true);
      const result = JSON.parse(executePruneCurrent(input, services));
      expect(result).toMatchObject({
        ok: true,
        done: true,
        pruned: [BRANCH],
        cut_ids: [OTHER],
      });
      expect(engine.status).toBe('complete');
      expect(engine.getResult().fullNodes.map((node) => node.id)).toEqual([
        ORIGIN,
      ]);
      expect(session.resultGraph?.nodeIds).toEqual([ORIGIN]);
      expect(input).toEqual(before);
    },
  );

  it.each([
    null,
    {},
    { focus_node_id: BRANCH, reason: '' },
    { focus_node_id: BRANCH, reason: 1 },
    { focus_node_id: BRANCH, reason: 'Off path.', column_flow: [] },
    { focus_node_id: OTHER, reason: 'Wrong focus.' },
  ])('rejects malformed or stale commands without mutation: %j', (input) => {
    const { engine, services } = tableArrivalWorld('ct');
    const before = engine.toJSON();
    expect(JSON.parse(executePruneCurrent(input, services))).toHaveProperty(
      'code',
    );
    expect(engine.toJSON()).toEqual(before);
  });

  it('keeps provider and runtime schemas strict for the reason-only command', () => {
    const wire = new Ajv({ strict: false }).compile(
      toModelJsonSchema(PruneCurrentInputSchema),
    );
    for (const input of [
      { focus_node_id: BRANCH, reason: 'Irrelevant to this investigation.' },
      {},
      { focus_node_id: BRANCH },
      { focus_node_id: BRANCH, reason: 'Off path.', verdict: 'end_branch' },
    ]) {
      expect(wire(input)).toBe(
        PruneCurrentInputSchema.safeParse(input).success,
      );
    }
  });

  it.each([false, true])(
    'refuses protected pruning and accepts its legal alternative (repeat fault=%s)',
    (repeatFault) => {
      const { engine, session, model, graph } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      expect(
        JSON.parse(
          executeSubmitFindings(
            {
              focus_node_id: ORIGIN,
              summary: 'Value comes from branch.',
              sections: { technical: 'The source endpoint is assigned.' },
              column_flow: [
                {
                  out_col: 'Value',
                  upstream_columns: [{ node: BRANCH, col: 'Value' }],
                },
              ],
              questions: [
                { nodeId: BRANCH, question: 'Resolve the source endpoint.' },
              ],
            },
            services,
          ),
        ),
      ).toHaveProperty('next_focus', BRANCH);
      expect(engine.canPruneCurrent).toBe(false);
      const before = engine.toJSON();
      for (const final of repeatFault ? [false, true] : [false]) {
        const rejected = readToolErrorText(
          executePruneCurrent(
            { focus_node_id: BRANCH, reason: 'No continuation.' },
            services,
          ),
        );
        expect(rejected).not.toBeNull();
        // The legal alternative (the tool to call instead) is named in the correction of the call-level error at every feedback.
        expect(rejected!.errors).toEqual([
          { path: '', code: 'prune_current_refused' },
        ]);
        expect(renderProblem(rejected!, final ? 2 : 1)).toContain(
          ISSUES.prune_current_refused.correction,
        );
        expect(engine.toJSON()).toEqual(before);
      }
      expect(
        JSON.parse(
          executeSubmitFindings(
            {
              summary: 'This assigned column terminates here.',
              sections: {
                technical:
                  'The original mapping remains; no further source contributes.',
              },
              column_flow: [],
            },
            services,
          ),
        ),
      ).toMatchObject({ ok: true, done: true });
      expect(engine.columnAspect?.edges).toEqual(before.columnAspect?.edges);
      expect(engine.toJSON().removedSet).not.toContain(BRANCH);
    },
  );
});

describe('lineage_start_exploration boundary', () => {
  it('serves a fresh approval proposal after completion, with no direct supplement branch', () => {
    const proposal = {
      origin: OTHER,
      analysisMode: 'bb',
      classification: 'technical',
      depth: {
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    };
    const legacy = { supplement: { nodeIds: [OTHER] } };
    expect(
      StartExplorationFreshProviderInputSchema.safeParse(proposal).success,
    ).toBe(true);
    expect(
      StartExplorationFreshProviderInputSchema.safeParse(legacy).success,
    ).toBe(false);
    expect(StartExplorationProviderInputSchema.safeParse(legacy).success).toBe(
      false,
    );
    const validate = new Ajv({ strict: false }).compile(
      toModelJsonSchema(StartExplorationFreshProviderInputSchema),
    );
    expect(validate(proposal)).toBe(true);
    expect(validate(legacy)).toBe(false);
  });
  it.each([0, 1])(
    'validates the imported depth rule natively with upstream level %s',
    (upstream) => {
      const result = validateToolCandidate(
        startExplorationSchemaForState(false),
        {
          origin: ORIGIN,
          analysisMode: 'bb',
          classification: 'technical',
          depth: {
            upstream: { levels: upstream, exactness: 'exact' },
            downstream: { levels: 0, exactness: 'exact' },
          },
        },
      );
      expect(result.success).toBe(upstream === 1);
      if (!result.success)
        expect(result.rejection.errors).toEqual([
          expect.objectContaining({ path: 'depth', code: 'invalid' }),
        ]);
    },
  );

  it('rejects string depth without decoding it into a number', () => {
    const payload = {
      origin: ORIGIN,
      analysisMode: 'bb',
      classification: 'technical',
      depth: {
        upstream: { levels: '2', exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    };
    expect(
      startExplorationSchemaForState(false).safeParse(payload).success,
    ).toBe(false);
  });

  it.each([{}, { question: 'What feeds it?' }, { excludeTypes: ['table'] }])(
    'rejects a start with no origin, supplement or revision at the schema: %j',
    (input) => {
      const parsed = validateToolCandidate(
        startExplorationSchemaForState(false),
        input,
      );
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('Fresh omissions admitted');
      expect(
        parsed.rejection.errors
          .map(({ code, path }) => ({ code, path }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      ).toEqual(
        ['origin', 'analysisMode', 'classification', 'depth']
          .sort()
          .map((path) => ({ code: 'missing', path })),
      );
    },
  );

  // Invalid classification never becomes a reviewable proposal.
  it.each([
    {
      input: { question: 'What feeds it?' },
      faults: ['origin', 'analysisMode', 'classification', 'depth'].map(
        (path) => ({ path, code: 'missing' }),
      ),
    },
    {
      input: {
        origin: ORIGIN,
        analysisMode: 'bb',
        classification: 'invalid',
        depth: {
          upstream: { levels: 1, exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      },
      faults: [{ path: 'classification', code: 'enum' }],
    },
  ])(
    'rejects invalid start fields before storing a proposal: $faults',
    async ({ input, faults }) => {
      const { session, model, graph } = ctWorld();
      session.stateMachine = null;
      const { services } = stubToolServices({ session, model, graph });
      const result = JSON.parse(await executeStartExploration(input, services));
      expect(result).toMatchObject({
        code: 'invalid_input',
        errors: expect.arrayContaining(
          faults.map((fault) => expect.objectContaining(fault)),
        ),
      });
      expect(session.pendingExploration).toBeNull();
    },
  );

  it('directs an origin plus legacy supplement to a fresh approval proposal', async () => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const text = await executeStartExploration(
      {
        origin: ORIGIN,
        analysisMode: 'bb',
        classification: 'technical',
        depth: {
          upstream: { levels: 1, exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
        supplement: { nodeIds: [OTHER] },
      } as never,
      services,
    );
    expect(text).toMatch(/new exploration/);
    expect(text).toMatch(/fresh proposal with origin and scope/);
    expect(text).not.toMatch(/without supplement/);
    expect(text).not.toContain('keep every other field unchanged');
  });

  it('opens the approval gate for a fresh proposal whatever phase the session holds, never a hop', async () => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    expect(session.phase.kind).toBe('exploring');
    const { services } = stubToolServices({
      session,
      model,
      graph,
      turnEpoch: () => session.turnEpoch,
    });
    const result = JSON.parse(
      await executeStartExploration(
        {
          origin: ORIGIN,
          analysisMode: 'bb',
          classification: 'technical',
          question: 'What feeds it?',
          depth: {
            upstream: { levels: 1, exactness: 'exact' },
            downstream: { levels: 0, exactness: 'exact' },
          },
        },
        services,
      ),
    );
    expect(result).toMatchObject({
      code: 'action_required',
      detail: { gate: 'confirm_sm_start', proposalRevision: 1 },
    });
    expect(result).not.toHaveProperty('focus_node');
    expect(result.errors).toEqual([{ path: '', code: 'awaiting_approval' }]);
    expect(session.stateMachine).toBeNull();
  });

  it.each([
    'excludeTypes',
    'excludeSchemas',
    'excludeNodeIds',
    'passNodeIds',
    'scopeNotes',
  ])('rejects a non-string-array %s at the schema', (field) => {
    expect(
      StartExplorationInputSchema.safeParse({ origin: ORIGIN, [field]: [1] })
        .success,
    ).toBe(false);
    expect(
      StartExplorationInputSchema.safeParse({ origin: ORIGIN, [field]: 'one' })
        .success,
    ).toBe(false);
  });

  it('requires fresh discovery and a new approval card after completion while keeping the completed run intact', async () => {
    const { engine, session, model, graph } = ctWorld({ deferred: true });
    const { services } = stubToolServices({
      session,
      model,
      graph,
      turnEpoch: () => session.turnEpoch,
    });
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            summary: 'Value comes from branch.',
            sections: { technical: 'Branch supplies Value.' },
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns: [{ node: BRANCH, col: 'Value' }],
              },
            ],
            questions: [{ nodeId: BRANCH, question: 'Establish Value.' }],
          },
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
    expect(
      JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: BRANCH,
            summary: 'Source is beyond depth 1.',
            sections: { technical: 'Other is beyond the border.' },
            column_flow: [],
            questions: [
              {
                nodeId: OTHER,
                question: 'Establish how Other produces Value.',
              },
            ],
          },
          services,
        ),
      ),
    ).toHaveProperty('done', true);
    const result = engine.getResult();
    session.resultGraph = {
      nodeIds: result.fullNodes.map((n) => n.id),
      edges: result.edges,
      source: 'column_trace',
      originNodeId: ORIGIN,
      ...(result.columnAspect
        ? { columnAspect: { edges: result.columnAspect.edges } }
        : {}),
    };
    session.enterCompleted(session.turnEpoch);
    const beforeEngine = engine.toJSON();
    const beforeGraph = structuredClone(session.resultGraph);
    const legacy = JSON.parse(
      await executeStartExploration(
        { supplement: { nodeIds: [OTHER] } } as never,
        services,
      ),
    );
    expect(legacy).not.toHaveProperty('focus_node');
    expect(session.phase.kind).toBe('completed');
    expect(engine.toJSON()).toEqual(beforeEngine);
    expect(session.resultGraph).toEqual(beforeGraph);
    const proposal = JSON.parse(
      await executeStartExploration(
        {
          origin: OTHER,
          analysisMode: 'bb',
          classification: 'technical',
          depth: {
            upstream: { levels: 0, exactness: 'exact' },
            downstream: { levels: 1, exactness: 'exact' },
          },
        },
        services,
      ),
    );
    expect(proposal).toMatchObject({
      code: 'action_required',
      detail: { gate: 'confirm_sm_start', proposalRevision: 1 },
    });
    expect(proposal).not.toHaveProperty('focus_node');
    expect(session.pendingExploration?.init).toMatchObject({
      origin: OTHER,
      analysisMode: 'bb',
      direction: 'downstream',
    });
    expect(session.stateMachine).toBe(engine);
    expect(engine.toJSON()).toEqual(beforeEngine);
    expect(session.resultGraph).toEqual(beforeGraph);
  });
});

describe('lineage_present_result boundary', () => {
  const base = {
    name: 'View',
    summary: 'Summary.',
    sections: [{ label: 'One', node_ids: [ORIGIN], text: 'Body.' }],
  };
  it.each([
    ['completed', false],
    ['completed', true],
    ['synthesis', false],
    ['synthesis', true],
  ] as const)(
    'rejects missing or empty highlight_groups in the %s schema (retainable=%s)',
    (stage, retainable) => {
      const schema = presentResultSchemaForPhase(stage, retainable);
      expect(
        schema.safeParse({
          ...base,
          is_update: stage === 'completed' ? true : undefined,
        }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...base, highlight_groups: [] }).success).toBe(
        false,
      );
    },
  );

  it('rejects empty highlight_groups in the preview schema', () => {
    const preview = presentResultSchemaForPhase('visual_preview', false, 1);
    expect(
      preview.safeParse({
        name: 'View',
        sections: [{ label: 'One', node_ids: [ORIGIN], start: 'B1' }],
        highlight_groups: [],
      }).success,
    ).toBe(false);
  });
});

describe('lineage_get_neighbor_columns boundary', () => {
  it.each(['[hop].[missing]', 'hop.missing', OTHER])(
    'refuses %s at the engine before any column lookup',
    async (id) => {
      const { registry } = ctWorld();
      const result = JSON.parse(
        await registry.invoke('lineage_get_neighbor_columns', { ids: [id] }),
      );
      expect(result).toMatchObject({ code: 'invalid_input' });
      expect(result).toMatchObject({
        issuePaths: ['ids.0'],
        errors: [{ path: 'ids.0', code: 'not_neighbor', values: [BRANCH] }],
      });
      expect(result).not.toHaveProperty('results');
    },
  );

  it('serves and authorizes only the BB tools on BB work, so the read is off policy and the engine untouched', async () => {
    const { registry, engine } = ctWorld({ mode: 'bb' });
    const before = engine.toJSON();
    expect([
      ...getAllowedLmToolNames({ kind: 'active', mode: 'sm_bb' }),
    ]).toEqual(['lineage_submit_findings', 'lineage_prune_current']);
    expect(
      getAllowedLmToolNames({ kind: 'active', mode: 'sm_ct' }).has(
        'lineage_get_neighbor_columns',
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        await registry.invoke('lineage_get_neighbor_columns', {
          ids: [BRANCH],
        }),
      ),
    ).toMatchObject({
      code: 'invalid_input',
      errors: [{ path: '', code: 'off_policy' }],
    });
    expect(engine.toJSON()).toEqual(before);
  });

  it('binds a case-equivalent neighbor without changing the supplied request', async () => {
    const { registry } = ctWorld();
    const input = { ids: ['HOP.BRANCH'] };
    expect(
      JSON.parse(await registry.invoke('lineage_get_neighbor_columns', input)),
    ).toMatchObject({ total: 1, results: [{ id: BRANCH }] });
    expect(input).toEqual({ ids: ['HOP.BRANCH'] });
    const result = JSON.parse(
      await registry.invoke('lineage_get_neighbor_columns', { ids: [BRANCH] }),
    );
    expect(result).toMatchObject({
      total: 1,
      results: [{ id: BRANCH, columns: [expect.objectContaining({})] }],
    });
    expect(JSON.stringify(result)).not.toContain('not_found');
  });
});

describe('lineage_submit_findings boundary', () => {
  const finding = (mode: 'bb' | 'ct' = 'ct') => ({
    focus_node_id: ORIGIN,
    summary: 'Branch supplies Value.',
    sections: { technical: 'The selected Value comes from branch.' },
    ...(mode === 'ct'
      ? {
          column_flow: [
            {
              out_col: 'Value',
              upstream_columns: [{ node: BRANCH, col: 'Value' }],
            },
          ],
        }
      : {}),
    questions: [
      { nodeId: BRANCH, question: 'Establish the SQL source of Value.' },
    ],
    prune_neighbors: [],
  });
  it.each([
    'fresh-held',
    'existing-held',
    'none',
    'existing-missing-focus',
    'existing-wrong-focus',
  ] as const)(
    'uses one coherent schema repair instruction with %s content',
    (heldCase) => {
      const { session, model, graph, engine } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const valid = {
        focus_node_id: ORIGIN,
        summary: 'Branch supplies Value.',
        sections: { technical: 'Preserve this SQL finding verbatim.' },
        column_flow: [
          {
            out_col: 'Value',
            upstream_columns: [{ node: BRANCH, col: 'Value' }],
          },
        ],
        questions: [
          { nodeId: BRANCH, question: 'Establish Value provenance.' },
        ],
      };
      const existing = heldCase.startsWith('existing');
      const wrongFocus = heldCase === 'existing-wrong-focus';
      if (existing) {
        expect(
          JSON.parse(
            executeSubmitFindings({ ...valid, summary: undefined }, services),
          ),
        ).toHaveProperty('code', 'invalid_input');
      }
      const before = engine.toJSON();
      const input =
        heldCase === 'none' || existing
          ? {
              focus_node_id:
                heldCase === 'existing-missing-focus'
                  ? undefined
                  : heldCase === 'existing-wrong-focus'
                    ? OTHER
                    : ORIGIN,
              column_flow: 42,
            }
          : { ...valid, column_flow: 42 };
      const result = JSON.parse(executeSubmitFindings(input, services));
      expect(result).toMatchObject({
        code: 'invalid_input',
        issuePaths: expect.arrayContaining(['column_flow']),
        errors: expect.arrayContaining([
          expect.objectContaining({ path: 'column_flow', code: 'type' }),
        ]),
      });
      expect(
        result.errors.find(
          (error: { path: string }) => error.path === 'column_flow',
        ),
      ).not.toHaveProperty('got');
      expect(result).not.toHaveProperty('hint');
      expect(result.resend).toEqual(
        expect.arrayContaining(
          existing && !wrongFocus
            ? ['summary', 'column_flow']
            : ['column_flow'],
        ),
      );
      if (heldCase === 'none' || wrongFocus) {
        if (!existing) expect(engine.heldFindingFocus).toBeNull();
        if (!existing) expect(engine.heldPartsOfCurrentFocus()).toBeNull();
        else
          expect(
            engine.toJSON(),
            'an unbound repair cannot borrow or replace the current draft',
          ).toEqual(before);
      } else if (existing) {
        expect(
          [...result.resend].sort(),
          'D-098: the faulty resent field is reported with the owed summary',
        ).toEqual(['column_flow', 'summary']);
      } else expect(result.resend).toEqual(['column_flow']);
      const correction =
        heldCase === 'none'
          ? valid
          : existing
            ? { focus_node_id: ORIGIN, summary: valid.summary }
            : { focus_node_id: ORIGIN, column_flow: valid.column_flow };
      expect(
        JSON.parse(executeSubmitFindings(correction, services)),
      ).toHaveProperty('ok', true);
      expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
        summary: valid.summary,
        sections: [{ angle: 'technical', text: valid.sections.technical }],
      });
      expect(engine.columnAspect?.edges).toEqual([
        expect.objectContaining({
          from_node: BRANCH,
          from_col: 'Value',
          to_node: ORIGIN,
          to_col: 'Value',
        }),
      ]);
      expect(engine.getCurrentTasks()).toContainEqual(
        expect.objectContaining({ question: valid.questions[0].question }),
      );
    },
  );

  it.each([
    { unavailable: 'questions', protectedEndpoint: true },
    { unavailable: 'column_flow', protectedEndpoint: false },
  ])(
    'reports only established prune protection with unavailable $unavailable',
    ({ unavailable, protectedEndpoint }) => {
      const { session, model, graph, engine } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const input = {
        focus_node_id: ORIGIN,
        summary: 'Branch supplies Value.',
        sections: { technical: 'Value comes from branch.' },
        column_flow: [
          {
            out_col: 'Value',
            upstream_columns: [{ node: BRANCH, col: 'Value' }],
          },
        ],
        questions: [],
        prune_neighbors: [
          { id: BRANCH, reason: 'Do not investigate this supplier.' },
        ],
      };
      const before = engine.toJSON();
      const result = JSON.parse(
        executeSubmitFindings({ ...input, [unavailable]: 42 }, services),
      );
      expect(result).toMatchObject({
        code: 'invalid_input',
        issuePaths: expect.arrayContaining([unavailable]),
      });
      const protection =
        result.detail?.filter(
          (fault: { kind?: string; id?: string; path?: string }) =>
            fault.kind === 'prune_unsupported' &&
            fault.id === BRANCH &&
            fault.path === 'prune_neighbors.0.id',
        ) ?? [];
      expect(protection).toHaveLength(protectedEndpoint ? 1 : 0);
      const after = engine.toJSON();
      for (const key of [
        'agenda',
        'visited',
        'removedSet',
        'columnAspect',
        'scopeNodeIds',
      ] as const)
        expect(after[key]).toEqual(before[key]);
      const correction = {
        focus_node_id: ORIGIN,
        prune_neighbors: [],
        column_flow: input.column_flow,
        questions: [
          { nodeId: BRANCH, question: 'Establish Value provenance.' },
        ],
      };
      const corrected = JSON.parse(executeSubmitFindings(correction, services));
      expect(corrected, JSON.stringify(corrected)).toHaveProperty('ok', true);
      expect(engine.toJSON().memory.detailSlots[ORIGIN]).toMatchObject({
        summary: input.summary,
        sections: [{ angle: 'technical', text: input.sections.technical }],
      });
    },
  );

  it.each([
    {
      name: 'bad supplier column',
      selfLoop: false,
      kind: 'bad_contributor_col',
      path: 'column_flow.0.upstream_columns.0.col',
    },
    {
      name: 'bad out_node column',
      selfLoop: true,
      kind: 'bad_out_col',
      path: 'column_flow.0.out_col',
    },
  ])(
    'collects a safe CT fault beside invalid narrative: $name',
    ({ selfLoop, kind, path }) => {
      const { session, model, graph, engine } = ctWorld({ selfLoop });
      const { services } = stubToolServices({ session, model, graph });
      const input = {
        summary: 'SQL findings retained.',
        sections: { technical: 42 },
        column_flow: [
          {
            out_col: selfLoop ? 'Absent' : 'Value',
            upstream_columns: [
              { node: BRANCH, col: selfLoop ? 'Value' : 'Absent' },
            ],
            ...(selfLoop ? { out_node: BRANCH } : {}),
          },
        ],
        questions: [
          { nodeId: BRANCH, question: 'Establish Value provenance.' },
        ],
      };
      const before = engine.toJSON();
      const result = JSON.parse(executeSubmitFindings(input, services));
      const after = engine.toJSON();
      expect.soft(result).toMatchObject({
        code: 'invalid_input',
        issuePaths: expect.arrayContaining(['sections.technical', path]),
      });
      expect
        .soft(result.detail)
        .toEqual(
          expect.arrayContaining([expect.objectContaining({ kind, path })]),
        );
      for (const key of [
        'agenda',
        'visited',
        'removedSet',
        'currentFocusNodeId',
        'columnAspect',
        'scopeNodeIds',
      ] as const)
        expect(after[key], `${key} remains atomic`).toEqual(before[key]);
      const control = JSON.parse(
        executeSubmitFindings(
          {
            column_flow: input.column_flow,
            sections: { technical: 'SQL findings retained.' },
          },
          services,
        ),
      );
      expect(
        control.detail,
        `the same typed CT fault is independently observable when narrative is valid: ${JSON.stringify(control)}`,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind, path })]),
      );
      const repaired = JSON.parse(
        executeSubmitFindings(
          {
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns: selfLoop
                  ? []
                  : [{ node: BRANCH, col: 'Value' }],
                ...(selfLoop ? { out_node: BRANCH } : {}),
              },
            ],
          },
          services,
        ),
      );
      expect(repaired, JSON.stringify(repaired)).toHaveProperty('ok', true);
    },
  );

  it.each(
    [
      {
        name: 'unrelated sections',
        patch: { sections: { technical: 42 } },
        schemaPath: 'sections.technical',
      },
      {
        name: 'unrelated flow',
        patch: { column_flow: 42 },
        schemaPath: 'column_flow',
      },
      {
        name: 'unknown questions',
        patch: { questions: 42 },
        schemaPath: 'questions',
      },
      {
        name: 'unknown prune decisions',
        patch: { sections: { technical: 42 }, prune_neighbors: 42 },
        schemaPath: 'prune_neighbors',
      },
    ].flatMap((row) =>
      (['bb', 'ct'] as const)
        .filter((mode) => mode === 'ct' || row.schemaPath !== 'column_flow')
        .map((mode) => ({ ...row, mode })),
    ),
  )(
    'reports each fault without inventing unavailable decisions ($mode): $name',
    ({ patch, schemaPath, mode }) => {
      const { session, model, graph, engine } = ctWorld({ mode });
      const { services } = stubToolServices({ session, model, graph });
      const durable = () => {
        const state = engine.toJSON();
        return {
          agenda: state.agenda,
          visited: state.visited,
          removed: state.removedSet,
          focus: state.currentFocusNodeId,
          status: state.status,
          columnAspect: state.columnAspect,
          scope: state.scopeNodeIds,
          nodeStates: state.nodeStates,
        };
      };
      const before = structuredClone(durable());
      const result = JSON.parse(
        executeSubmitFindings(
          { ...finding(mode), questions: [], ...patch },
          services,
        ),
      );
      expect(result.code).toBe('invalid_input');
      expect(result.issuePaths).toContain(schemaPath);
      expect(
        durable(),
        'a rejected draft cannot commit graph, agenda or removal state',
      ).toEqual(before);
      expect(
        result.issuePaths,
        'no decision is invented for an omitted or unavailable list',
      ).not.toContain('questions.0');
      const complete = finding(mode);
      const correction =
        schemaPath === 'focus_node_id'
          ? complete
          : {
              focus_node_id: ORIGIN,
              ...(schemaPath.startsWith('sections') ||
              schemaPath === 'prune_neighbors'
                ? { sections: complete.sections }
                : {}),
              ...(schemaPath === 'column_flow'
                ? { column_flow: complete.column_flow }
                : {}),
              ...(schemaPath === 'prune_neighbors'
                ? { prune_neighbors: [] }
                : {}),
              ...(schemaPath === 'questions' ||
              schemaPath === 'prune_neighbors' ||
              (mode === 'bb' && schemaPath.startsWith('sections'))
                ? { questions: complete.questions }
                : {}),
            };
      const accepted = JSON.parse(executeSubmitFindings(correction, services));
      expect(accepted).toMatchObject({ ok: true, next_focus: BRANCH });
      expect(
        engine.toJSON().visited.filter((id) => id === ORIGIN),
      ).toHaveLength(1);
    },
  );

  it.each([49, 50, 51])(
    'keeps badge bound %i identical at the public schema and handler boundary',
    (length) => {
      const { session, model, graph, engine } = ctWorld();
      const { services } = stubToolServices({ session, model, graph });
      const input = { ...finding(), badge_label: 'x'.repeat(length) };
      const before = structuredClone(input);
      const schema = engine.findingSchema();
      const wireValid = new Ajv({ strict: false }).compile(
        toModelJsonSchema(schema),
      )(input);
      const result = JSON.parse(executeSubmitFindings(input, services));
      expect(schema.safeParse(input).success).toBe(length <= 50);
      expect(wireValid).toBe(length <= 50);
      expect(result.ok === true).toBe(length <= 50);
      if (length === 51)
        expect(result).toMatchObject({
          code: 'invalid_input',
          issuePaths: ['badge_label'],
        });
      expect(input).toEqual(before);
    },
  );

  it.each([false, true])(
    'requires a current summary while archived sections stay retained (held=%s)',
    (withHeld) => {
      const { engine, session, model, graph } = ctWorld({ mode: 'bb' });
      const { services } = stubToolServices({ session, model, graph });
      const submit = (input: object) =>
        JSON.parse(executeSubmitFindings(input, services));
      engine.publishMemoryTo(session.memory);
      const sections = [
        { angle: 'technical' as const, text: 'Previously captured SQL.' },
      ];
      session.memory.storeDetail(
        model.nodes.find((node) => node.id === ORIGIN)!,
        sections,
        'Earlier visit summary.',
      );
      const summary = 'Updated summary for this visit.';
      const questions = [{ nodeId: BRANCH, question: 'Establish Value.' }];
      if (withHeld)
        expect(submit({ summary, questions, badge_label: 42 })).toHaveProperty(
          'code',
          'invalid_input',
        );
      else
        expect(submit({ questions }).errors).toEqual([
          { path: 'summary', code: 'missing' },
        ]);
      const nullSummary = submit({ summary: null });
      expect(nullSummary.errors).toContainEqual({
        path: 'summary',
        code: 'type',
        values: ['string'],
      });
      if (withHeld)
        expect(nullSummary.errors).toContainEqual({
          path: 'summary',
          code: 'not_overwritten',
        });
      expect(submit(withHeld ? {} : { summary })).toHaveProperty('ok', true);
      expect(engine.getDetailSlots()).toContainEqual(
        expect.objectContaining({ summary, sections }),
      );
    },
  );

  it.each([false, true])(
    'replaces a resent sections object whole; a faulty replacement keeps the held copy (D-101, complete=%s)',
    (complete) => {
      const { engine, session, model, graph } = ctWorld({ mode: 'bb' });
      engine.classification = 'both';
      const { services } = stubToolServices({ session, model, graph });
      const submit = (input: object) =>
        JSON.parse(executeSubmitFindings(input, services));
      const held = { business: 'Held business.', technical: 'Held technical.' };
      expect(
        submit({
          ...finding('bb'),
          sections: held,
          badge_label: 'x'.repeat(51),
        }),
      ).toHaveProperty('code', 'invalid_input');
      const replacement = complete
        ? { business: 'New business.', technical: 'New technical.' }
        : { technical: 'Changed technical.' };
      const result = submit({ sections: replacement, badge_label: 'Short' });
      if (!complete) {
        expect(result.errors).toEqual(
          expect.arrayContaining([
            { path: 'sections', code: 'not_overwritten' },
            expect.objectContaining({
              path: 'sections.business',
              code: 'missing',
            }),
          ]),
        );
        expect(submit({})).toHaveProperty('ok', true);
      } else expect(result).toHaveProperty('ok', true);
      const kept = complete ? replacement : held;
      expect(engine.getDetailSlots()[0]?.sections).toEqual([
        { angle: 'business', text: kept.business },
        { angle: 'technical', text: kept.technical },
      ]);
    },
  );

  it.each([false, true])(
    'preserves explicit route dispositions when done=%s',
    (done) => {
      const { session, model, graph } = ctWorld({ deferred: true });
      const { services } = stubToolServices({ session, model, graph });
      const first = JSON.parse(
        executeSubmitFindings(
          {
            focus_node_id: ORIGIN,
            summary: 'Supplies Value.',
            sections: { technical: 'Value comes from branch.' },
            column_flow: [
              {
                out_col: 'Value',
                upstream_columns: [{ node: BRANCH, col: 'Value' }],
              },
            ],
            questions: [
              { nodeId: BRANCH, question: 'Establish the source of Value.' },
            ],
          },
          services,
        ),
      );
      const result = done
        ? JSON.parse(
            executeSubmitFindings(
              {
                focus_node_id: BRANCH,
                summary: 'Value is constant.',
                sections: { technical: 'The value is defined locally.' },
                column_flow: [{ out_col: 'Value', upstream_columns: [] }],
                questions: [
                  {
                    nodeId: OTHER,
                    question: 'Inspect this source if the depth is expanded.',
                  },
                ],
              },
              services,
            ),
          )
        : first;
      expect(result).toMatchObject({
        ok: true,
        done,
        route_outcomes: expect.arrayContaining([
          done
            ? {
                nodeId: OTHER,
                accepted: false,
                deferred: true,
                reason: 'depth',
              }
            : { nodeId: BRANCH, accepted: true },
        ]),
      });
    },
  );

  it.each([
    {
      caseSensitive: false,
      node: '[HOP].[BRANCH]',
      extra: false,
      accepted: true,
    },
    {
      caseSensitive: true,
      node: '[HOP].[BRANCH]',
      extra: false,
      accepted: false,
    },
    { caseSensitive: false, node: BRANCH, extra: false, accepted: true },
    { caseSensitive: true, node: BRANCH, extra: false, accepted: true },
    { caseSensitive: false, node: BRANCH, extra: true, accepted: false },
  ])(
    'binds only equivalent caller-neighbor identity before strict validation: %j',
    async (options) => {
      const { session, model, graph, engine } = ctWorld({
        scalar: true,
        caseSensitive: options.caseSensitive,
      });
      const { services } = stubToolServices({ session, model, graph });
      const input = {
        focus_node_id: ORIGIN,
        summary: 'The function computes Value.',
        sections: { technical: 'Inspect its supplied caller argument.' },
        column_flow: [],
        questions: [
          {
            nodeId: options.node,
            question: 'Establish Value from the caller argument.',
            caller_context: { node: ORIGIN, col: 'Value' },
          },
        ],
        ...(options.extra ? { undeclared: true } : {}),
      };
      const before = structuredClone(input);
      const port = new VscodeModelPort({
        id: 'caller-identity',
        name: 'caller-identity',
        vendor: 'test',
        family: 'test',
        version: '1',
        maxInputTokens: 128000,
        countTokens: async () => 1,
        sendRequest: async () => ({
          stream: {
            async *[Symbol.asyncIterator]() {
              yield new vscode.LanguageModelToolCallPart(
                'caller-identity',
                'lineage_submit_findings',
                input,
              );
            },
          },
        }),
      } as never);
      const schema = submitFindingsSchemaForMode(
        'ct',
        'technical',
        true,
        engine.hopSubmitColumns,
      );
      const reply = await port.generateToolTurn({
        messages: [modelUserMessage('Analyze the supplied caller.')],
        tools: [
          {
            name: 'lineage_submit_findings',
            description: 'Record findings.',
            inputSchema: schema,
          },
        ],
        phase: 'active',
      });
      expect(reply.status).toBe('completed');
      if (reply.status !== 'completed' || !reply.toolCalls[0]?.valid)
        throw new Error('Expected a native call for handler admission');
      const result = JSON.parse(
        executeSubmitFindings(reply.toolCalls[0].input, services),
      );
      expect(result.ok === true).toBe(options.accepted);
      if (options.accepted) expect(result.next_focus).toBe(BRANCH);
      else expect(result).toHaveProperty('code', 'invalid_input');
      expect(input).toEqual(before);
    },
  );

  it('keeps a route to an already queued table accepted', () => {
    const V = '[bb].[v]';
    const W = '[bb].[w]';
    const T = '[bb].[t]';
    const nodes = [
      makeNode({
        id: V,
        schema: 'bb',
        name: 'v',
        type: 'view',
        bodyScript: 'SELECT 1 AS One;',
      }),
      makeNode({
        id: W,
        schema: 'bb',
        name: 'w',
        type: 'view',
        bodyScript: 'SELECT 1 AS One;',
      }),
      makeNode({ id: T, schema: 'bb', name: 't', type: 'table' }),
    ];
    const pairs: Array<[string, string]> = [
      [T, V],
      [W, V],
      [T, W],
    ];
    const model = makeModel(nodes, pairs, ['bb']);
    const graph = makeGraph(nodes, pairs);
    const session = new AiSession();
    session.model = model;
    session.graph = graph;
    session.classification = 'technical';
    session.beginTurn();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.classification = 'technical';
    expect(
      engine.init({
        origin: V,
        question: 'What feeds v?',
        analysisMode: 'bb',
        direction: 'upstream',
        depthIntent: {
          upstream: { levels: 'all', exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      }),
    ).toMatchObject({ ok: true });
    engine.getHopContext();
    session.stateMachine = engine;
    session.enterExploring(session.turnEpoch);
    const { services } = stubToolServices({ session, model, graph });
    const first = JSON.parse(
      executeSubmitFindings(
        {
          focus_node_id: V,
          summary: 'Reads t and w.',
          sections: { technical: 'Selects from both sources.' },
          questions: [
            { nodeId: T, question: 'What does t hold?' },
            { nodeId: W, question: 'What does w add?' },
          ],
        },
        services,
      ),
    );
    expect(first).toMatchObject({ ok: true, next_focus: W });
    const second = JSON.parse(
      executeSubmitFindings(
        {
          focus_node_id: W,
          summary: 'Reads t.',
          sections: { technical: 'Selects from t.' },
          questions: [{ nodeId: T, question: 'Which rows does w read?' }],
        },
        services,
      ),
    );
    expect(second).toMatchObject({
      ok: true,
      done: true,
      route_outcomes: [{ nodeId: T, accepted: true }],
    });
    expect(engine.toJSON().visited).toContain(T);
    expect(session.resultGraph?.nodeIds).toEqual(
      expect.arrayContaining([V, W, T]),
    );
  });
});

it.each([
  { missingSummary: false, badPrune: false },
  { missingSummary: true, badPrune: false },
  { missingSummary: false, badPrune: true },
])(
  'never owes an unknown root key after its removal ($missingSummary/$badPrune)',
  ({ missingSummary, badPrune }) => {
    const { engine, session, model, graph } = ctWorld({ mode: 'bb' });
    const { services } = stubToolServices({ session, model, graph });
    const questions = [{ nodeId: BRANCH, question: 'Explain this source.' }];
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          ...(missingSummary ? {} : { summary: 'Keep this authored summary.' }),
          sections: { technical: 'Keep these authored findings.' },
          questions,
          neighbors: [
            { id: OTHER, reason: 'Unsupported field, never an action.' },
          ],
          ...(badPrune
            ? {
                prune_neighbors: [
                  { id: OTHER, reason: 'Not an admitted neighbor.' },
                ],
              }
            : {}),
        },
        services,
      ),
    );
    expect(rejected).toMatchObject({
      code: 'invalid_input',
      errors: expect.arrayContaining([
        expect.objectContaining({ path: 'neighbors', code: 'unknown_key' }),
      ]),
      resend: missingSummary
        ? ['summary']
        : badPrune
          ? ['prune_neighbors']
          : [],
    });
    expect(engine.currentFocus).toBe(ORIGIN);
    expect(engine.getDetailSlots()).toEqual([]);
    expect(engine.heldPartsOfCurrentFocus()?.resend).not.toContain('neighbors');
    if (missingSummary)
      expect(JSON.parse(executeSubmitFindings({}, services))).toMatchObject({
        code: 'invalid_input',
        resend: ['summary'],
        errors: expect.arrayContaining([
          expect.objectContaining({ path: 'summary', code: 'missing' }),
        ]),
      });
    expect(
      JSON.parse(
        executeSubmitFindings(
          missingSummary
            ? { summary: 'Corrected authored summary.' }
            : badPrune
              ? { prune_neighbors: [] }
              : {},
          services,
        ),
      ),
    ).toHaveProperty('ok', true);
    expect(engine.getDetailSlots()).toContainEqual(
      expect.objectContaining({
        nodeId: ORIGIN,
        summary: missingSummary
          ? 'Corrected authored summary.'
          : 'Keep this authored summary.',
        sections: [
          { angle: 'technical', text: 'Keep these authored findings.' },
        ],
      }),
    );
  },
);

it.each([
  { unsupported: 'column_flow', missingTechnical: false },
  { unsupported: 'sections.business', missingTechnical: false },
  { unsupported: 'questions.0.extra', missingTechnical: false },
  { unsupported: 'sections.business', missingTechnical: true },
])(
  'owes only active declared parts after $unsupported (missing technical=$missingTechnical)',
  ({ unsupported, missingTechnical }) => {
    const { engine, session, model, graph } = ctWorld({ mode: 'bb' });
    const { services } = stubToolServices({ session, model, graph });
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          summary: 'Keep this authored summary.',
          sections: {
            ...(missingTechnical
              ? {}
              : { technical: 'Keep these authored findings.' }),
            ...(unsupported === 'sections.business'
              ? { business: 'Unsupported angle.' }
              : {}),
          },
          questions: [
            {
              nodeId: BRANCH,
              question: 'Explain this source.',
              ...(unsupported === 'questions.0.extra'
                ? { extra: 'Unsupported nested field.' }
                : {}),
            },
          ],
          ...(unsupported === 'column_flow' ? { column_flow: [] } : {}),
        },
        services,
      ),
    );
    expect(rejected).toMatchObject({
      code: 'invalid_input',
      resend: missingTechnical
        ? ['sections.technical']
        : unsupported === 'questions.0.extra'
          ? ['questions']
          : [],
      errors: expect.arrayContaining([
        expect.objectContaining({ path: unsupported, code: 'unknown_key' }),
      ]),
    });
    expect(engine.getDetailSlots()).toEqual([]);
    const corrected = missingTechnical
      ? { sections: { technical: 'Keep these authored findings.' } }
      : unsupported === 'questions.0.extra'
        ? { questions: [{ nodeId: BRANCH, question: 'Explain this source.' }] }
        : {};
    // D-098: the held valid parts still satisfy admission beside a correction of only the owed parts.
    expect(
      JSON.parse(executeSubmitFindings(corrected, services)),
    ).toHaveProperty('ok', true);
    expect(engine.getDetailSlots()).toContainEqual(
      expect.objectContaining({
        nodeId: ORIGIN,
        summary: 'Keep this authored summary.',
        sections: [
          { angle: 'technical', text: 'Keep these authored findings.' },
        ],
      }),
    );
  },
);

it.each([
  {
    name: 'valid business with unknown sibling',
    classification: 'business',
    sections: {
      business: 'Keep this exact business body.',
      business_extra: 'Unsupported sibling.',
    },
    retained: 'business',
  },
  {
    name: 'bad business with unknown sibling',
    classification: 'business',
    sections: { business: 42, business_extra: 'Unsupported sibling.' },
    retained: null,
  },
  {
    name: 'valid technical with wrong classification and unknown sibling',
    classification: 'technical',
    sections: {
      technical: 'Keep this exact technical body.',
      business: 'Wrong classification.',
      business_extra: 'Unsupported sibling.',
    },
    retained: 'technical',
  },
  {
    name: 'empty required body with unknown sibling',
    classification: 'business',
    sections: { business: '', business_extra: 'Unsupported sibling.' },
    retained: null,
  },
  {
    name: 'unknown sibling only',
    classification: 'business',
    sections: { business_extra: 'Not a canonical angle.' },
    retained: null,
  },
  {
    name: 'wrong whole container type',
    classification: 'business',
    sections: 'Not a section object.',
    retained: null,
  },
] as const)(
  'preserves only independently valid section bodies: $name',
  (row) => {
    const { engine, session, model, graph } = ctWorld({ mode: 'bb' });
    engine.classification = row.classification;
    session.classification = row.classification;
    const { services } = stubToolServices({ session, model, graph });
    const rejected = JSON.parse(
      executeSubmitFindings(
        {
          summary: 'Keep this summary.',
          sections: row.sections,
          questions: [{ nodeId: BRANCH, question: 'Explain this source.' }],
        },
        services,
      ),
    );
    expect(rejected.code).toBe('invalid_input');
    expect(engine.getDetailSlots()).toEqual([]);
    if (typeof row.sections !== 'string')
      expect(rejected.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'sections.business_extra',
            code: 'unknown_key',
          }),
        ]),
      );
    const text =
      row.retained === 'technical'
        ? 'Keep this exact technical body.'
        : 'Keep this exact business body.';
    const last = row.retained
      ? rejected
      : JSON.parse(executeSubmitFindings({}, services));
    expect(last).toMatchObject(
      row.retained
        ? { resend: [] }
        : {
            code: 'invalid_input',
            resend: expect.arrayContaining([`sections.${row.classification}`]),
          },
    );
    const correction = row.retained
      ? {}
      : { sections: { [row.classification]: 'Corrected canonical body.' } };
    // D-098: the held valid body still satisfies admission beside a correction of only the owed parts.
    expect(
      JSON.parse(executeSubmitFindings(correction, services)),
    ).toHaveProperty('ok', true);
    expect(engine.getDetailSlots()).toContainEqual(
      expect.objectContaining({
        nodeId: ORIGIN,
        summary: 'Keep this summary.',
        sections: [
          {
            angle: row.classification,
            text: row.retained ? text : 'Corrected canonical body.',
          },
        ],
      }),
    );
  },
);

it.each([
  { origin: ORIGIN, mode: 'ct', targets: ['Missing'], columnFault: true },
  {
    origin: ORIGIN.toUpperCase(),
    mode: 'ct',
    targets: ['Missing'],
    columnFault: true,
  },
  { origin: ORIGIN, mode: 'ct', targets: ['[Value]'], columnFault: false },
  {
    origin: '[hop].[missing]',
    mode: 'ct',
    targets: ['Missing'],
    columnFault: false,
  },
  { origin: 42, mode: 'ct', targets: ['Missing'], columnFault: false },
  { origin: ORIGIN, mode: 'bb', targets: ['Missing'], columnFault: false },
  { origin: ORIGIN, mode: 'ct', targets: 42, columnFault: false },
])(
  'reports only independently established target metadata beside depth faults: %j',
  async (row) => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const result = JSON.parse(
      await executeStartExploration(
        {
          origin: row.origin,
          analysisMode: row.mode,
          targetColumns: row.targets,
          classification: 'technical',
          depth: {
            upstream: { levels: -1, exactness: 'exact' },
            downstream: { levels: 0, exactness: 'exact' },
          },
        },
        services,
      ),
    );
    expect(JSON.stringify(result)).toContain('depth.upstream.levels');
    expect(
      (result.issuePaths ?? []).includes('targetColumns.0') &&
        result.reason.includes('declared columns'),
    ).toBe(row.columnFault);
    expect(session.pendingExploration).toBeNull();
    expect(session.stateMachine).toBeNull();
  },
);

it('keeps outside-supplier withdrawal in first feedback', () => {
  const { engine, session, model, graph } = ctWorld({
    selfLoop: true,
    outsideWrite: true,
  });
  const { services } = stubToolServices({ session, model, graph });
  const rejected = JSON.parse(
    executeSubmitFindings(
      {
        summary: 'Outside supplier evidence.',
        sections: { technical: 'Keep the outside supplier fact.' },
        column_flow: [
          {
            out_node: BRANCH,
            out_col: 'Value',
            upstream_columns: [{ node: OTHER, col: 'Value' }],
          },
        ],
        questions: [{ nodeId: BRANCH, question: 'Trace the reachable Value.' }],
      },
      services,
    ),
  );
  const first = JSON.parse(
    renderProblem(readToolErrorText(JSON.stringify(rejected))!, 1),
  );
  const scopeIssue = shownErrors(first).find(
    (error) => error.code === 'column_out_of_scope',
  );
  expect(scopeIssue).toMatchObject({
    path: 'column_flow.0.upstream_columns.0.node',
    code: 'column_out_of_scope',
  });
  expect(scopeIssue).not.toHaveProperty('allowed');
  expect(engine.getDetailSlots()).toEqual([]);
  expect(
    JSON.parse(executeSubmitFindings({ column_flow: [] }, services)),
  ).toHaveProperty('ok', true);
  expect(engine.getDetailSlots()).toContainEqual(
    expect.objectContaining({ summary: 'Outside supplier evidence.' }),
  );
});

const startEnumFaults = [
  {
    field: 'analysisMode',
    patch: { analysisMode: 'wrong' },
    path: 'analysisMode',
    allowed: ['bb', 'ct'],
  },
  {
    field: 'classification',
    patch: { classification: 'wrong' },
    path: 'classification',
    allowed: ['business', 'technical', 'both'],
  },
  {
    field: 'depth exactness',
    patch: {
      depth: {
        upstream: { levels: 2, exactness: 'wrong' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    },
    path: 'depth.upstream.exactness',
    allowed: ['exact', 'approximate'],
  },
];
const startEnumCombinations = Array.from(
  { length: (1 << startEnumFaults.length) - 1 },
  (_, index) => {
    const selected = startEnumFaults.filter(
      (_row, bit) => (index + 1) & (1 << bit),
    );
    return {
      field: selected.map((row) => row.field).join(' + '),
      selected,
      patch: Object.assign({}, ...selected.map((row) => row.patch)),
    };
  },
);
it.each(
  startEnumCombinations.flatMap((row) =>
    [false, true].map((refining) => ({ ...row, refining })),
  ),
)(
  'stages native start $field values and accepts the corrected proposal (refining=$refining)',
  async (row) => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const proposal = {
      origin: ORIGIN,
      analysisMode: 'bb',
      classification: 'technical',
      depth: {
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    };
    if (row.refining) {
      const opened = JSON.parse(
        await executeStartExploration(proposal, services),
      );
      expect(opened).toMatchObject({
        code: 'action_required',
        detail: { proposalRevision: 1 },
      });
      session.enterGate(session.turnEpoch);
    }
    const desired = {
      ...proposal,
      depth: { ...proposal.depth, upstream: { levels: 2, exactness: 'exact' } },
    };
    const faulty = {
      ...desired,
      ...(row.refining ? { proposalRevision: 1 } : {}),
      ...row.patch,
    };
    const rejected = JSON.parse(
      await executeStartExploration(faulty, services),
    );
    expect(rejected.code).toBe('invalid_input');
    expect(rejected.issuePaths.sort()).toEqual(
      row.selected.map((fault) => fault.path).sort(),
    );
    for (const fault of row.selected)
      expect(rejected.errors).toContainEqual(
        expect.objectContaining({ path: fault.path, code: 'enum' }),
      );
    // D-105: feedback 1 names every fault without allowed values; feedback 2 adds them; start arguments get no fallback at 3.
    const first = JSON.parse(
      renderProblem(rejected, 1, undefined, 'session_start'),
    );
    expect(Object.keys(first).sort()).toEqual([
      'attempt',
      'code',
      'errors',
      'resend',
    ]);
    for (const fault of row.selected)
      expect(shownErrors(first)).toContainEqual(
        expect.objectContaining({ path: fault.path }),
      );
    for (const error of shownErrors(first))
      expect(error).not.toHaveProperty('allowed');
    for (const fault of row.selected)
      for (const value of fault.allowed)
        expect(JSON.stringify(first)).not.toContain(JSON.stringify(value));
    for (const stage of [2, 3] as const) {
      const later = JSON.parse(
        renderProblem(rejected, stage, undefined, 'session_start'),
      );
      for (const fault of row.selected)
        expect(shownErrors(later)).toContainEqual(
          expect.objectContaining({
            path: fault.path,
            allowed: expect.arrayContaining(fault.allowed),
          }),
        );
      expect(hasFallback(later)).toBe(false);
    }
    expect(session.stateMachine).toBeNull();
    expect(session.pendingExploration?.revision ?? null).toBe(
      row.refining ? 1 : null,
    );
    const corrected = JSON.parse(
      await executeStartExploration(
        { ...desired, ...(row.refining ? { proposalRevision: 1 } : {}) },
        services,
      ),
    );
    expect(corrected).toMatchObject({
      code: 'action_required',
      detail: {
        gate: 'confirm_sm_start',
        proposalRevision: row.refining ? 2 : 1,
      },
    });
    expect(session.pendingExploration?.init).toMatchObject({
      origin: ORIGIN,
      analysisMode: 'bb',
    });
    expect(session.stateMachine).toBeNull();
  },
);

// Spec 05 BB has no column targets; spec 08 rejects supplied content instead of silently projecting it away (DEF-15).
it.each([
  ...([undefined, 'bb'] as const).flatMap((analysisMode) =>
    (['empty', 'named'] as const).map((targets) => ({
      analysisMode,
      targets,
      badDepth: false,
    })),
  ),
  ...(['empty', 'named'] as const).map((targets) => ({
    analysisMode: undefined,
    targets,
    badDepth: true,
  })),
  ...(['scalar', 'item'] as const).map((targets) => ({
    analysisMode: undefined,
    targets,
    badDepth: false,
  })),
])(
  'rejects target columns on a pending BB refine and accepts a legal correction (analysisMode=$analysisMode, targets=$targets, badDepth=$badDepth)',
  async (row) => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const proposal = {
      origin: ORIGIN,
      analysisMode: 'bb',
      classification: 'technical',
      depth: {
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    };
    expect(
      JSON.parse(await executeStartExploration(proposal, services)),
    ).toMatchObject({
      code: 'action_required',
      detail: { proposalRevision: 1 },
    });
    session.enterGate(session.turnEpoch);
    const before = structuredClone(session.pendingExploration);
    const column = model.nodes.find((node) => node.id === ORIGIN)!.columns![0]
      .name;
    const targetColumns =
      row.targets === 'empty'
        ? []
        : row.targets === 'named'
          ? [column]
          : row.targets === 'scalar'
            ? 42
            : [42];
    const rejected = JSON.parse(
      await executeStartExploration(
        {
          proposalRevision: 1,
          targetColumns,
          ...(row.analysisMode ? { analysisMode: row.analysisMode } : {}),
          ...(row.badDepth
            ? {
                depth: {
                  ...proposal.depth,
                  upstream: { levels: -1, exactness: 'exact' },
                },
              }
            : {}),
        },
        services,
      ),
    );
    expect(rejected).toMatchObject({
      code: 'invalid_input',
      errors: expect.arrayContaining([
        expect.objectContaining({
          path: row.targets === 'item' ? 'targetColumns.0' : 'targetColumns',
          code:
            row.targets === 'scalar' || row.targets === 'item'
              ? 'type'
              : 'never',
        }),
        ...(row.badDepth
          ? [
              expect.objectContaining({
                path: 'depth.upstream.levels',
                code: 'size',
              }),
            ]
          : []),
      ]),
    });
    expect(session.pendingExploration).toEqual(before);
    expect(session.stateMachine).toBeNull();
    expect(
      JSON.parse(
        await executeStartExploration(
          {
            proposalRevision: 1,
            analysisMode: 'ct',
            targetColumns: [column],
            ...(row.badDepth ? { depth: proposal.depth } : {}),
          },
          services,
        ),
      ),
    ).toMatchObject({
      code: 'action_required',
      detail: { proposalRevision: 2 },
    });
    expect(session.pendingExploration?.init).toMatchObject({
      analysisMode: 'ct',
      targetColumns: [column],
    });
  },
);

it.each([false, true])(
  'rejects a BB-to-CT refine without named columns alongside independent faults (badSibling=%s)',
  async (badSibling) => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const proposal = {
      origin: ORIGIN,
      analysisMode: 'bb',
      classification: 'technical',
      depth: {
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    };
    expect(
      JSON.parse(await executeStartExploration(proposal, services)),
    ).toMatchObject({
      code: 'action_required',
      detail: { proposalRevision: 1 },
    });
    session.enterGate(session.turnEpoch);
    const before = structuredClone(session.pendingExploration);
    const rejected = JSON.parse(
      await executeStartExploration(
        {
          proposalRevision: 1,
          analysisMode: 'ct',
          ...(badSibling ? { excludeTypes: [42] } : {}),
        },
        services,
      ),
    );
    expect(rejected).toMatchObject({
      code: 'invalid_input',
      errors: expect.arrayContaining([
        expect.objectContaining({ path: 'targetColumns', code: 'missing' }),
        ...(badSibling
          ? [expect.objectContaining({ path: 'excludeTypes.0', code: 'type' })]
          : []),
      ]),
    });
    expect(session.pendingExploration).toEqual(before);
    const column = model.nodes.find((node) => node.id === ORIGIN)!.columns![0]
      .name;
    expect(
      JSON.parse(
        await executeStartExploration(
          {
            proposalRevision: 1,
            analysisMode: 'ct',
            targetColumns: [column],
            ...(badSibling ? { excludeTypes: [] } : {}),
          },
          services,
        ),
      ),
    ).toMatchObject({
      code: 'action_required',
      detail: { proposalRevision: 2 },
    });
    expect(session.pendingExploration?.init).toMatchObject({
      analysisMode: 'ct',
      targetColumns: [column],
    });
    // Changing the mode explicitly withdraws the pending CT scope; it supplies no forbidden BB target field.
    expect(
      JSON.parse(
        await executeStartExploration(
          { proposalRevision: 2, analysisMode: 'bb' },
          services,
        ),
      ),
    ).toMatchObject({
      code: 'action_required',
      detail: { proposalRevision: 3 },
    });
    expect(session.pendingExploration?.init.analysisMode).toBe('bb');
    expect(session.pendingExploration?.init.targetColumns).toBeUndefined();
  },
);

it.each(
  [
    {
      name: 'unknown object metadata',
      tool: 'lineage_get_object_detail',
      bad: { id: '[hop].[missing]' },
      good: { id: ORIGIN },
      code: 'not_found',
    },
    {
      name: 'invalid object-search regex',
      tool: 'lineage_search_objects',
      bad: { query: '[', mode: 'regex' },
      good: { query: 'origin' },
      code: 'invalid_regex',
    },
    {
      name: 'invalid DDL-search regex',
      tool: 'lineage_search_ddl',
      bad: { query: '[' },
      good: { query: 'Value' },
      code: 'invalid_regex',
    },
    {
      name: 'unknown context field',
      tool: 'lineage_get_context',
      bad: { unknown: true },
      good: {},
      code: 'unknown_key',
    },
  ].flatMap((row) =>
    [false, true].map((repeatFault) => ({ ...row, repeatFault })),
  ),
)(
  'recovers a native discovery $name fault through its legal read alternative (repeat fault=$repeatFault)',
  async (row) => {
    const { session, registry } = ctWorld();
    session.stateMachine = null;
    session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
    for (const final of row.repeatFault ? [false, true] : [false]) {
      const raw = String(await registry.invoke(row.tool, row.bad));
      const rejection = readToolErrorText(raw);
      expect(rejection).not.toBeNull();
      expect(rejection!.code).toBe('invalid_input');
      expect(rejection!.errors.map((error) => error.code)).toContain(row.code);
      const served = JSON.parse(renderProblem(rejection!, final ? 2 : 1));
      expect(shownErrors(served).length).toBeGreaterThan(0);
      for (const error of shownErrors(served))
        expect(error.message).toEqual(expect.any(String));
      if (!final)
        for (const error of shownErrors(served))
          expect(error).not.toHaveProperty('allowed');
      expect(session.pendingExploration).toBeNull();
      expect(session.stateMachine).toBeNull();
    }
    const accepted = String(await registry.invoke(row.tool, row.good));
    expect(readToolErrorText(accepted), accepted).toBeNull();
    expect(session.pendingExploration).toBeNull();
    expect(session.stateMachine).toBeNull();
  },
);

it('holds normalized valid start integers and accepts only the two invalid depth corrections', async () => {
  const { session, port, invoke } = ownedInputWorld();
  session.stateMachine = null;
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  const opened = JSON.parse(
    await invoke('lineage_start_exploration', {
      origin: ORIGIN,
      analysisMode: 'bb',
      classification: 'technical',
      depth: {
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    }),
  );
  expect(opened).toMatchObject({
    code: 'action_required',
    detail: { proposalRevision: 1 },
  });
  session.enterGate(session.turnEpoch);
  const rejected = JSON.parse(
    await invoke('lineage_start_exploration', {
      proposalRevision: '1',
      depth: {
        upstream: { levels: null, exactness: 'exact' },
        downstream: { levels: 'three', exactness: 'exact' },
      },
    }),
  );
  expect(session.hopLog.at(-1)?.input).toMatchObject({ proposalRevision: 1 });
  expect(rejected.issuePaths.sort()).toEqual([
    'depth.downstream.levels',
    'depth.upstream.levels',
  ]);
  expect(session.pendingExploration?.revision).toBe(1);
  const patch = {
    depth: { upstream: { levels: 2 }, downstream: { levels: 0 } },
  };
  const accepted = JSON.parse(await invoke('lineage_start_exploration', patch));
  expect(accepted).toMatchObject({
    code: 'action_required',
    detail: { proposalRevision: 2 },
  });
  expect(port.modelCalls).toBe(3);
  expect(session.pendingExploration?.init).toMatchObject({
    depthIntent: {
      upstream: { levels: 2, exactness: 'exact' },
      downstream: { levels: 0, exactness: 'exact' },
    },
  });
  expect(session.stateMachine).toBeNull();
});

// D-103 step 2: read tools are stateless. A resend after a rejection is evaluated on its own args only; a valid
// value of the earlier rejected call is never held. Each row faults one field next to a valid required one and
// resends only the faulted field, so a held value would turn the resend into a different (accepted) call.
// lineage_get_context is absent: its schema has no field that could be held.
const STATELESS_READS = [
  {
    tool: 'lineage_search_objects',
    stage: 'discover',
    bad: { query: 'origin', mode: 'bogus' },
    resend: { mode: 'substring' },
  },
  {
    tool: 'lineage_search_ddl',
    stage: 'discover',
    bad: { query: 'Value', types: ['table'] },
    resend: { types: ['view'] },
  },
  {
    tool: 'lineage_get_object_detail',
    stage: 'discover',
    bad: { id: ORIGIN, cursor: 'x' },
    resend: { cursor: '0' },
  },
  {
    tool: 'lineage_detect_graph_patterns',
    stage: 'discover',
    bad: { type: 'hubs', min_degree: 'x' },
    resend: { min_degree: 1 },
  },
  {
    tool: 'lineage_get_screen_state',
    stage: 'discover',
    bad: { ids: [ORIGIN], cursor: 'x' },
    resend: { cursor: '0' },
  },
  {
    tool: 'lineage_get_scope_bundle',
    stage: 'discover',
    bad: {
      origin: ORIGIN,
      upstream_depth: 1,
      downstream_depth: 'x',
      include_ddl: false,
    },
    resend: { downstream_depth: 0 },
  },
  {
    tool: 'lineage_get_neighbor_columns',
    stage: 'active',
    bad: { ids: [BRANCH], unknown: true },
    resend: {},
  },
] as const;

it('D-103: the stateless read table covers every non-commit read tool with a field', () => {
  const reads = TOOL_DEFS.filter(
    (def) =>
      ['read', 'scope_store'].includes(def.effect) &&
      def.name !== 'lineage_get_context',
  ).map((def) => def.name);
  expect(STATELESS_READS.map((row) => row.tool).sort()).toEqual(
    [...reads].sort(),
  );
});

it.each(STATELESS_READS)(
  'D-103: a $tool resend after a rejection is evaluated on its own args only',
  async (row) => {
    const { session, invoke } = ownedInputWorld();
    if (row.stage === 'discover') {
      session.stateMachine = null;
      session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
    } else
      session.enterLmStage(
        { kind: 'active', mode: 'sm_ct' },
        session.turnEpoch,
      );
    expect(
      readToolErrorText(await invoke(row.tool, row.bad)),
      'the first call is rejected',
    ).not.toBeNull();
    const actual = await invoke(row.tool, row.resend);
    const fresh = ctWorld();
    if (row.stage === 'discover') {
      fresh.session.stateMachine = null;
      fresh.session.enterLmStage({ kind: 'discover' }, fresh.session.turnEpoch);
    } else
      fresh.session.enterLmStage(
        { kind: 'active', mode: 'sm_ct' },
        fresh.session.turnEpoch,
      );
    expect(actual).toBe(await fresh.registry.invoke(row.tool, row.resend));
    expect(session.hopLog.at(-1)?.input).toEqual(row.resend);
  },
);

it('preserves raw read arguments, also of concurrent reads, in hop evidence', async () => {
  const { session, invoke, batch } = ownedInputWorld();
  session.stateMachine = null;
  session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
  expect(
    readToolErrorText(
      await invoke('lineage_search_objects', {
        query: 42,
        schemas: ['hop', 7],
        types: ['table'],
        unknown: 'x',
      }),
    ),
  ).not.toBeNull();
  await invoke('lineage_search_objects', { query: 'origin', schemas: ['hop'] });
  expect(session.hopLog.at(-1)?.input).toEqual({
    query: 'origin',
    schemas: ['hop'],
  });
  const inputs = [{ query: 'origin' }, { query: 'branch', types: ['view'] }];
  await batch(
    inputs.map((input) => ({ tool: 'lineage_search_objects', input })),
  );
  expect(session.hopLog.slice(-2).map((entry) => entry.input)).toEqual(inputs);
});

it('clears a held start draft on cancellation and never revives it in a new turn', async () => {
  const cancellation = new AbortController();
  const { session, port, registry, invoke, batch } = ownedInputWorld({
    signal: cancellation.signal,
  });
  session.stateMachine = null;
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  await invoke('lineage_start_exploration', {
    origin: ORIGIN,
    analysisMode: 'bb',
    classification: 'technical',
    depth: {
      upstream: { levels: null, exactness: 'exact' },
      downstream: { levels: 0, exactness: 'exact' },
    },
  });
  cancellation.abort();
  const partial = { depth: { upstream: { levels: 1, exactness: 'exact' } } };
  await expect(
    registry.invoke('lineage_start_exploration', partial),
  ).rejects.toBeDefined();
  const fresh = ctWorld();
  fresh.session.stateMachine = null;
  fresh.session.enterLmStage({ kind: 'sm_entry' }, fresh.session.turnEpoch);
  const expected = await fresh.registry.invoke(
    'lineage_start_exploration',
    partial,
  );
  expect(readToolErrorText(expected)).not.toBeNull();
  // A later generation of the same model, through a registry that was not cancelled.
  const resume = buildAiToolRegistry(
    () => session,
    { info() {}, debug() {}, warn() {}, error() {} } as never,
    () => undefined,
    undefined,
    { model: port },
  );
  await batch([]);
  const afterCancel = JSON.parse(
    await resume.invoke('lineage_start_exploration', partial),
  );
  expect(afterCancel, 'nothing revived after cancellation').toMatchObject({
    ...JSON.parse(expected),
    resend: expect.arrayContaining([
      'depth',
      'origin',
      'analysisMode',
      'classification',
    ]),
  });
  expect(afterCancel.resend).toHaveLength(4);
  expect(
    afterCancel.errors.map((error: { path: string }) => error.path).sort(),
  ).toEqual(
    ['depth.downstream', 'origin', 'analysisMode', 'classification'].sort(),
  );
  expect(session.pendingExploration).toBeNull();
  session.beginTurn();
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  await batch([]);
  const afterTurn = JSON.parse(
    await resume.invoke('lineage_start_exploration', partial),
  );
  expect(afterTurn, 'nothing revived in a new turn').toMatchObject({
    ...JSON.parse(expected),
    resend: expect.arrayContaining([
      'depth',
      'origin',
      'analysisMode',
      'classification',
    ]),
  });
  expect(afterTurn.resend).toHaveLength(4);
  expect(
    afterTurn.errors.map((error: { path: string }) => error.path).sort(),
  ).toEqual(
    ['depth.downstream', 'origin', 'analysisMode', 'classification'].sort(),
  );
  expect(session.pendingExploration).toBeNull();
});

it('clears proposal repair on cancel and keeps mission text redacted in original-call evidence', async () => {
  const { session, registry, invoke } = ownedInputWorld();
  session.stateMachine = null;
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  const projected = overrideRegistrySchemas(
    registry,
    new Map([
      ['lineage_start_exploration', StartExplorationRefineProviderInputSchema],
    ]),
  );
  await invoke('lineage_start_exploration', {
    origin: ORIGIN,
    analysisMode: 'bb',
    classification: 'technical',
    depth: {
      upstream: { levels: 1, exactness: 'exact' },
      downstream: { levels: 0, exactness: 'exact' },
    },
  });
  session.enterGate(session.turnEpoch);
  void projected.get('lineage_start_exploration')!.inputSchema;
  await invoke('lineage_start_exploration', {
    proposalRevision: 1,
    mission_brief: 'private mission text',
    depth: { upstream: { levels: null, exactness: 'exact' } },
  });
  expect(session.startExplorationDraft.get()).not.toBeNull();
  expect(session.hopLog.at(-1)?.input).toMatchObject({
    mission_brief: { provenance: 'tool_payload', length: 20 },
  });
  expect(JSON.stringify(session.hopLog)).not.toContain('private mission text');
  session.cancelPendingExploration(session.turnEpoch);
  expect(session.startExplorationDraft.get()).toBeNull();
  expect(
    projected.get('lineage_start_exploration')!.inputSchema.safeParse({})
      .success,
  ).toBe(false);
});

it('does not treat two initial serialized writes in the same model round as repairs', async () => {
  const { session, registry, invoke, batch } = ownedInputWorld();
  session.stateMachine = null;
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  const projected = overrideRegistrySchemas(
    registry,
    new Map([
      ['lineage_start_exploration', StartExplorationFreshProviderInputSchema],
    ]),
  );
  void projected.get('lineage_start_exploration')!.inputSchema;
  const bad = {
    origin: ORIGIN,
    analysisMode: 'bb',
    classification: 'technical',
    depth: {
      upstream: { levels: null, exactness: 'exact' },
      downstream: { levels: 0, exactness: 'exact' },
    },
  };
  const results = await batch([
    { tool: 'lineage_start_exploration', input: bad },
    {
      tool: 'lineage_start_exploration',
      input: { ...bad, scopeNotes: 'Another independent proposal.' },
    },
  ]);
  expect(
    results.map((result) =>
      JSON.parse(result).errors.some(
        (error: { code: string }) => error.code === 'ambiguous_repair',
      ),
    ),
  ).toEqual([true, true]);
  expect(
    projected
      .get('lineage_start_exploration')!
      .inputSchema.safeParse({ depth: { upstream: { levels: 2 } } }).success,
  ).toBe(false);
  const rejected = JSON.parse(
    await invoke('lineage_start_exploration', {
      depth: { upstream: { levels: 2 } },
    }),
  );
  expect(rejected.code).not.toBe('action_required');
  expect(session.pendingExploration).toBeNull();
  expect(session.stateMachine).toBeNull();
});

it.each([
  {
    tool: 'lineage_search_objects',
    stage: 'discover',
    path: 'schemas',
    input: { query: 'origin', schemas: '["hop"]' },
  },
  {
    tool: 'lineage_start_exploration',
    stage: 'sm_entry',
    path: 'depth.upstream.levels',
    input: {
      origin: ORIGIN,
      analysisMode: 'bb',
      classification: 'technical',
      depth: {
        upstream: { levels: '1', exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    },
  },
  {
    tool: 'lineage_submit_findings',
    stage: 'active',
    path: 'column_flow',
    input: {
      focus_node_id: ' HOP . ORIGIN ',
      summary: 'Branch supplies Value.',
      sections: { technical: 'The selected Value comes from branch.' },
      prune_neighbors: [],
      column_flow: JSON.stringify([
        {
          out_col: 'Value',
          upstream_columns: [{ node: 'HOP.BRANCH', col: 'Value' }],
        },
      ]),
      questions: [
        { nodeId: BRANCH, question: 'Establish the SQL source of Value.' },
      ],
    },
  },
] as const)(
  'D-086/D-103: normalizes a lossless $tool spelling once, at the model port with the served schema, and accepts it',
  async (row) => {
    const world = ctWorld();
    if (row.stage !== 'active') {
      world.session.stateMachine = null;
      world.session.enterLmStage({ kind: row.stage }, world.session.turnEpoch);
    }
    const logs: string[] = [];
    const port = new VscodeModelPort(
      {
        id: 'normalize-once',
        name: 'normalize-once',
        vendor: 'test',
        family: 'test',
        version: '1',
        maxInputTokens: 128000,
        countTokens: async () => 1,
        sendRequest: async () => ({
          stream: {
            async *[Symbol.asyncIterator]() {
              yield new vscode.LanguageModelToolCallPart(
                'once',
                row.tool,
                row.input,
              );
            },
          },
        }),
      } as never,
      {
        budget: createTurnTokenBudget({}),
        debugLog: (line) => logs.push(line),
      },
    );
    const registry = buildAiToolRegistry(
      () => world.session,
      {
        info() {},
        debug: (line: string) => logs.push(line),
        warn() {},
        error() {},
      } as never,
      () => undefined,
      undefined,
      { model: port },
    );
    const engine = world.engine;
    const served = resolveRegistrySchemas(
      registry,
      new Map<string, () => import('zod').ZodType>([
        [
          'lineage_start_exploration',
          () => StartExplorationFreshProviderInputSchema,
        ],
        ['lineage_submit_findings', () => engine.findingSchema()],
      ]),
    );
    const tools = served.getTools().map((tool) => ({
      name: tool.name,
      description: tool.name,
      inputSchema: tool.inputSchema,
    }));
    vi.mocked(normalizeModelInput).mockClear();
    const reply = await port.generateToolTurn({
      messages: [modelUserMessage('Normalize once.')],
      tools,
      phase: row.stage,
    });
    expect(reply.status).toBe('completed');
    if (reply.status !== 'completed') return;
    const [call] = reply.toolCalls;
    expect(call?.valid).toBe(true);
    if (!call?.valid) return;
    const result = JSON.parse(
      await registry.invoke(call.toolName, call.input, call.callId),
    );
    expect(
      readToolErrorText(JSON.stringify(result)) === null ||
        result.code === 'action_required',
    ).toBe(true);
    if (row.tool === 'lineage_submit_findings')
      expect(result).toMatchObject({
        ok: true,
        accepted_focus: ORIGIN,
        next_focus: BRANCH,
      });
    const normalizations = vi.mocked(normalizeModelInput).mock.calls;
    expect(normalizations, 'one normalization per call').toHaveLength(1);
    expect(normalizations[0]![0], 'with the served schema').toBe(
      tools.find((tool) => tool.name === row.tool)!.inputSchema,
    );
    expect(
      logs.filter((line) =>
        line.startsWith(`[Normalize] tool=${row.tool} path=${row.path} `),
      ),
    ).toHaveLength(1);
    expect(
      reply.message.tool_calls?.[0]?.args,
      'spec 08: raw evidence stays in the transcript',
    ).toEqual(row.input);
  },
);

it('does not resurrect an authoritative metadata-invalid optional list when repair switches mode', async () => {
  const { session, registry, invoke } = ownedInputWorld();
  session.stateMachine = null;
  session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
  const projected = overrideRegistrySchemas(
    registry,
    new Map([
      ['lineage_start_exploration', StartExplorationFreshProviderInputSchema],
    ]),
  );
  void projected.get('lineage_start_exploration')!.inputSchema;
  const rejected = JSON.parse(
    await invoke('lineage_start_exploration', {
      origin: ORIGIN,
      analysisMode: 'ct',
      classification: 'technical',
      targetColumns: ['Missing'],
      depth: {
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    }),
  );
  expect(rejected.issuePaths).toEqual(['targetColumns.0']);
  expect(session.startExplorationDraft.get()).not.toHaveProperty(
    'targetColumns',
  );
  const gate = JSON.parse(
    await invoke('lineage_start_exploration', { analysisMode: 'bb' }),
  );
  expect(gate.code).toBe('action_required');
  expect(session.pendingExploration?.init.analysisMode).toBe('bb');
  expect(session.pendingExploration?.init.targetColumns).toBeUndefined();
  expect(session.stateMachine).toBeNull();
});

it.each(
  ['lineage_search_objects', 'lineage_search_ddl'].flatMap((tool) =>
    ['syntax', 'length'].map((fault) => ({ tool, fault })),
  ),
)(
  'D-103: names only the $tool query $fault fault and evaluates the query resend on its own args',
  async ({ tool, fault }) => {
    const { session, invoke } = ownedInputWorld();
    session.stateMachine = null;
    session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
    const filters =
      tool === 'lineage_search_objects'
        ? { mode: 'regex', schemas: ['elsewhere'], types: ['view'] }
        : { types: ['procedure'] };
    const query = fault === 'syntax' ? '[' : 'x'.repeat(REGEX_MAX_LENGTH + 1);
    expect(JSON.parse(await invoke(tool, { query, ...filters }))).toMatchObject(
      {
        code: 'invalid_input',
        errors: [{ path: 'query', code: 'invalid_regex' }],
        issuePaths: ['query'],
      },
    );
    const actual = await invoke(tool, { query: 'origin' });
    const fresh = ctWorld();
    fresh.session.stateMachine = null;
    fresh.session.enterLmStage({ kind: 'discover' }, fresh.session.turnEpoch);
    expect(readToolErrorText(String(actual))).toBeNull();
    expect(actual).toBe(await fresh.registry.invoke(tool, { query: 'origin' }));
    expect(session.hopLog.at(-1)?.input).toEqual({ query: 'origin' });
  },
);

it.each([
  {
    tool: 'lineage_search_objects',
    bad: { query: 42, schemas: ['hop'] },
    field: 'query',
    corrected: { query: 'origin' },
  },
  {
    tool: 'lineage_get_object_detail',
    bad: { id: 42 },
    field: 'id',
    corrected: { id: ORIGIN },
  },
])(
  'stages the $tool type fault with no fallback at any feedback (a read tool) and accepts its first corrected resend',
  async (row) => {
    // D-103/D-105 retire the generated example; the required field never gets the stage-3 fallback.
    const { session, registry } = ctWorld();
    session.stateMachine = null;
    session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
    session.currentRoundId = 1;
    const rejection = JSON.parse(await registry.invoke(row.tool, row.bad));
    for (const stage of [1, 2, 3] as const) {
      const problem = JSON.parse(
        renderProblem(rejection, stage, undefined, 'read'),
      );
      expect(shownErrors(problem)).toContainEqual(
        expect.objectContaining({ path: row.field, code: 'type' }),
      );
      expect(hasFallback(problem)).toBe(false);
    }
    session.currentRoundId = 2;
    expect(
      readToolErrorText(await registry.invoke(row.tool, row.corrected)),
    ).toBeNull();
    expect(session.stateMachine).toBeNull();
    expect(session.pendingExploration).toBeNull();
  },
);

it.each([
  'feedback marker',
  'next provider schema and acknowledgement',
  'second feedback allowed values',
  'held-field resend accepted',
] as const)(
  'uses actual generation identity through the compiled native start repair: %s',
  async (check) => {
    const { session } = ctWorld();
    session.stateMachine = null;
    session.currentRoundId = 1; // One user request contains both provider generations.
    session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
    const offered: Array<{
      properties: Record<
        string,
        { enum?: string[]; properties?: Record<string, { enum?: string[] }> }
      >;
      required?: string[];
    }> = [];
    const inputs: Array<Record<string, unknown>> =
      check === 'second feedback allowed values'
        ? [
            {
              origin: ORIGIN,
              analysisMode: 'bad-mode',
              classification: 'technical',
              depth: {
                upstream: { levels: 1, exactness: 'exact' },
                downstream: { levels: 0, exactness: 'exact' },
              },
            },
            { analysisMode: 'still-bad' },
            { analysisMode: 'bb' },
          ]
        : [
            {
              origin: ORIGIN,
              analysisMode: 'bb',
              classification: 'technical',
              depth: {
                upstream: { levels: 1, exactness: 'all' },
                downstream: { levels: 0, exactness: 'all' },
              },
            },
            {
              depth: {
                upstream: { exactness: 'exact' },
                downstream: { exactness: 'exact' },
              },
            },
          ];
    if (check === 'held-field resend accepted')
      inputs.splice(1, 0, {
        ...inputs[0],
        depth: {
          upstream: { levels: 1, exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      });
    let sends = 0;
    const model = new VscodeModelPort(
      {
        id: 'native-repair',
        name: 'native-repair',
        vendor: 'test',
        family: 'test',
        version: '1',
        maxInputTokens: 128000,
        countTokens: async () => 1,
        sendRequest: async (
          _messages: unknown,
          options: vscode.LanguageModelChatRequestOptions,
        ) => {
          offered.push(
            options.tools!.find(
              (tool) => tool.name === 'lineage_start_exploration',
            )!.inputSchema as (typeof offered)[number],
          );
          const input = inputs[sends++]!;
          return {
            stream: {
              async *[Symbol.asyncIterator]() {
                yield new vscode.LanguageModelToolCallPart(
                  `generation-${sends}`,
                  'lineage_start_exploration',
                  input,
                );
              },
            },
          };
        },
      } as never,
      { budget: createTurnTokenBudget({}) },
    );
    const registry = buildAiToolRegistry(
      () => session,
      { info() {}, debug() {}, warn() {}, error() {} } as never,
      () => undefined,
      undefined,
      { model },
    );
    const plan = (messages: ModelMessage[]) =>
      compileInstructionPlan({
        kind: 'converse',
        stage: { kind: 'sm_entry' },
        registry,
        toolSchemaOverrides: new Map([
          [
            'lineage_start_exploration',
            StartExplorationFreshProviderInputSchema,
          ],
        ]),
        facts: { memorySections: [] },
        messages,
        sink: new TurnEventSink(() => {}),
        toolChoice: 'auto',
      });
    let state = initialToolPhaseAttemptState('sm_entry');
    const first = await executeToolAttempt(
      model,
      plan([modelUserMessage('Start this exploration.')]),
      { priorState: state },
    );
    state = recordToolAttempt(state, first, registry);
    expect(model.modelCalls).toBe(1);
    expect(session.currentRoundId).toBe(1);
    if (check === 'feedback marker') {
      const toolResult = first.messages.find(
        (message) => message.getType() === 'tool',
      )!;
      const problem = JSON.parse(String(toolResult.content));
      expect(Object.keys(problem).sort()).toEqual([
        'attempt',
        'code',
        'errors',
        'resend',
      ]);
      expect(shownErrors(problem).map((error) => error.path)).toEqual(
        expect.arrayContaining([
          'depth.upstream.exactness',
          'depth.downstream.exactness',
        ]),
      );
      return;
    }
    const second = await executeToolAttempt(
      model,
      plan([modelUserMessage('Start this exploration.'), ...first.messages]),
      { priorState: state },
    );
    if (check === 'second feedback allowed values') {
      const firstContent = JSON.parse(
        String(
          first.messages.find((message) => message.getType() === 'tool')!
            .content,
        ),
      );
      expect(shownErrors(firstContent)).toContainEqual(
        expect.objectContaining({ path: 'analysisMode' }),
      );
      for (const error of shownErrors(firstContent))
        expect(error).not.toHaveProperty('allowed');
      const content = JSON.parse(
        String(
          second.messages.find((message) => message.getType() === 'tool')!
            .content,
        ),
      );
      expect(shownErrors(content)).toContainEqual(
        expect.objectContaining({
          path: 'analysisMode',
          allowed: expect.arrayContaining(['bb']),
        }),
      );
      state = recordToolAttempt(state, second, registry);
      await executeToolAttempt(
        model,
        plan([modelUserMessage('Start this exploration.'), ...second.messages]),
        { priorState: state },
      );
      expect(model.modelCalls).toBe(3);
      expect(session.currentRoundId).toBe(1);
      expect(session.pendingExploration?.revision).toBe(1);
      return;
    }
    if (check === 'held-field resend accepted') {
      expect(
        JSON.parse(
          String(
            second.messages.find((message) => message.getType() === 'tool')!
              .content,
          ),
        ),
      ).not.toHaveProperty('repair');
      const validate = new Ajv({ strict: false, allErrors: true }).compile(
        offered[1]!,
      );
      expect(validate(inputs[1]), JSON.stringify(validate.errors)).toBe(true);
      expect(session.pendingExploration?.revision).toBe(1);
      expect(session.pendingExploration?.init.depthIntent).toMatchObject({
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      });
      expect(session.hopLog.at(-1)?.input).toEqual(inputs[1]);
      return;
    }
    expect(model.modelCalls).toBe(2);
    expect(session.currentRoundId).toBe(1);
    const validate = new Ajv({ strict: false, allErrors: true }).compile(
      offered[1]!,
    );
    expect(validate(inputs[1]), JSON.stringify(validate.errors)).toBe(true);
    expect(session.pendingExploration?.revision).toBe(1);
    expect(session.pendingExploration?.init.depthIntent).toMatchObject({
      upstream: { levels: 1, exactness: 'exact' },
      downstream: { levels: 0, exactness: 'exact' },
    });
    expect(session.hopLog.at(-1)?.input).toEqual(inputs[1]);
    expect(session.stateMachine).toBeNull();
  },
);

it('fails closed to a complete start call when no model generation owner is available', async () => {
  const world = () => {
    const w = ctWorld();
    w.session.stateMachine = null;
    w.session.enterLmStage({ kind: 'sm_entry' }, w.session.turnEpoch);
    // Serve the fresh start schema, as a turn does, so a generation owner could hold its parts.
    void overrideRegistrySchemas(
      w.registry,
      new Map([
        ['lineage_start_exploration', StartExplorationFreshProviderInputSchema],
      ]),
    ).get('lineage_start_exploration')!.inputSchema;
    return w;
  };
  const { session, registry } = world();
  const complete = {
    origin: ORIGIN,
    analysisMode: 'bb',
    classification: 'technical',
    depth: {
      upstream: { levels: 1, exactness: 'exact' },
      downstream: { levels: 0, exactness: 'exact' },
    },
  };
  const rejection = JSON.parse(
    await registry.invoke('lineage_start_exploration', {
      ...complete,
      depth: {
        ...complete.depth,
        upstream: { levels: null, exactness: 'exact' },
      },
    }),
  );
  expect(readToolErrorText(JSON.stringify(rejection))).not.toBeNull();
  expect(rejection).not.toHaveProperty('repair');
  session.currentRoundId += 1;
  const partial = { depth: { upstream: { levels: 1, exactness: 'exact' } } };
  expect(await registry.invoke('lineage_start_exploration', partial)).toBe(
    await world().registry.invoke('lineage_start_exploration', partial),
  );
  expect(
    JSON.parse(await registry.invoke('lineage_start_exploration', complete)),
  ).toMatchObject({ code: 'action_required', detail: { proposalRevision: 1 } });
  expect(session.pendingExploration?.init).toMatchObject({
    origin: ORIGIN,
    analysisMode: 'bb',
  });
});

it.each([
  {
    tool: 'lineage_search_objects',
    valid: { query: 'origin', schemas: ['hop'], types: ['table'] },
    siblings: false,
  },
  {
    tool: 'lineage_search_ddl',
    valid: { query: 'Value', types: ['view'] },
    siblings: false,
  },
  {
    tool: 'lineage_search_objects',
    valid: { query: 'origin', schemas: ['hop'], types: ['table'] },
    siblings: true,
  },
])(
  'D-103: evaluates a compiled $tool correction generation on its own args (siblings=$siblings)',
  async (row) => {
    const { session, registry, port, queue, offered } = ownedInputWorld();
    session.stateMachine = null;
    session.currentRoundId = 1;
    session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
    const owner = TOOL_DEFS.find((tool) => tool.name === row.tool)!.inputSchema;
    const fault = schemaFaults(toModelJsonSchema(owner), row.valid).find(
      (fault) => fault.kind === 'type' && fault.path.join('.') === 'query',
    )!;
    expect(fault).toBeDefined();
    const invalid = withSchemaFaults(row.valid, [fault]);
    const results: string[] = [];
    const plan = () =>
      compileInstructionPlan({
        kind: 'converse',
        stage: { kind: 'discover' },
        registry,
        facts: { memorySections: [] },
        messages: [modelUserMessage('Find this declared object.')],
        sink: new TurnEventSink(() => {}),
        onToolResult: (_tool, _input, _error, result) => {
          results.push(result);
        },
      });
    queue([
      { tool: row.tool, input: invalid },
      ...(row.siblings
        ? [{ tool: row.tool, input: { ...invalid, schemas: [] } }]
        : []),
    ]);
    const first = await executeToolAttempt(port, plan(), {
      priorState: initialToolPhaseAttemptState('discover'),
    });
    expect(port.modelCalls).toBe(1);
    expect(session.currentRoundId).toBe(1);
    expect(
      results.map((result) => readToolErrorText(result)?.issuePaths),
    ).toEqual(results.map(() => ['query']));
    const patch = { query: row.valid.query };
    queue([{ tool: row.tool, input: patch }]);
    await executeToolAttempt(port, plan(), {
      priorState: recordToolAttempt(
        initialToolPhaseAttemptState('discover'),
        first,
        registry,
      ),
    });
    expect(port.modelCalls).toBe(2);
    expect(session.currentRoundId).toBe(1);
    expect(
      offered[1]!.find((tool) => tool.name === row.tool)!.inputSchema,
      'D-098: a repair serves the full schema',
    ).toEqual(offered[0]!.find((tool) => tool.name === row.tool)!.inputSchema);
    const fresh = ctWorld();
    fresh.session.stateMachine = null;
    fresh.session.enterLmStage({ kind: 'discover' }, fresh.session.turnEpoch);
    expect(results.at(-1)).toBe(await fresh.registry.invoke(row.tool, patch));
    expect(readToolErrorText(results.at(-1)!)).toBeNull();
    expect(session.hopLog.at(-1)?.input).toEqual(patch);
  },
);

it.each([false, true])(
  'accepts a declared regex mode correction as a full resend (repeat bad mode=%s)',
  async (repeat) => {
    const { session, registry, invoke } = ownedInputWorld();
    session.stateMachine = null;
    session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
    const original = {
      query: '[',
      mode: 'regex',
      schemas: ['hop'],
      types: ['table'],
    };
    expect(
      JSON.parse(await invoke('lineage_search_objects', original)),
    ).toMatchObject({
      code: 'invalid_input',
      errors: [{ path: 'query', code: 'invalid_regex' }],
      resend: ['mode'],
    });
    expect(
      registry
        .get('lineage_search_objects')!
        .inputSchema.safeParse({ mode: 'substring' }).success,
      'D-098: a correction is served the full schema',
    ).toBe(false);
    if (repeat)
      expect(
        readToolErrorText(await invoke('lineage_search_objects', original))
          ?.errors[0].code,
      ).toBe('invalid_regex');
    const resend = { ...original, mode: 'substring' };
    const corrected = await invoke('lineage_search_objects', resend);
    expect(readToolErrorText(corrected)).toBeNull();
    const fresh = ctWorld();
    fresh.session.stateMachine = null;
    fresh.session.enterLmStage({ kind: 'discover' }, fresh.session.turnEpoch);
    expect(corrected).toBe(
      await fresh.registry.invoke('lineage_search_objects', resend),
    );
    expect(session.hopLog.at(-1)?.input).toEqual(resend);
  },
);

it.each([false, true])(
  'repairs an owed section through the compiled active hop under the canonical schema (full resend=%s)',
  async (full) => {
    const { session, engine, registry, port, queue, offered } =
      ownedInputWorld();
    session.classification = 'both';
    engine.classification = 'both';
    session.enterLmStage({ kind: 'active', mode: 'sm_ct' }, session.turnEpoch);
    const input = {
      focus_node_id: ORIGIN,
      summary: 'Held summary remains byte exact.',
      badge_label: 'Held badge',
      sections: {
        business: 'Held business body remains byte exact.',
        technical: ' ',
      },
      column_flow: [
        {
          out_col: 'Value',
          upstream_columns: [{ node: BRANCH, col: 'Value' }],
        },
      ],
      questions: [{ nodeId: BRANCH, question: 'Trace the supplied Value.' }],
    };
    const patch = { sections: { technical: 'Corrected technical body.' } };
    const plan = () =>
      compileInstructionPlan({
        kind: 'converse',
        stage: { kind: 'active', mode: 'sm_ct' },
        registry,
        facts: {
          analysisMode: 'ct',
          targetColumns: ['Value'],
          classification: 'both',
          memorySections: [],
        },
        messages: [modelUserMessage('Trace Value.')],
        sink: new TurnEventSink(() => {}),
        findingSchema: () => engine.findingSchema(),
        toolChoice: 'required',
        requiredTerminalTool: 'lineage_submit_findings',
      });
    queue([{ tool: 'lineage_submit_findings', input }]);
    const first = await executeToolAttempt(port, plan(), {
      priorState: initialToolPhaseAttemptState('active'),
    });
    expect(first.rejections).toHaveLength(1);
    expect(engine.heldPartsOfCurrentFocus()?.resend).toEqual([
      'sections.technical',
    ]);
    queue([
      {
        tool: 'lineage_submit_findings',
        input: full ? { ...input, ...patch } : patch,
      },
    ]);
    const second = await executeToolAttempt(port, plan(), {
      priorState: recordToolAttempt(
        initialToolPhaseAttemptState('active'),
        first,
        registry,
      ),
    });
    const schema = offered[1]!.find(
      (tool) => tool.name === 'lineage_submit_findings',
    )!.inputSchema;
    expect(Object.keys(schema.properties)).toEqual(
      Object.keys(
        offered[0]!.find((tool) => tool.name === 'lineage_submit_findings')!
          .inputSchema.properties,
      ),
    );
    expect(
      new Ajv({ strict: false }).compile(schema)(patch),
      'D-098/D-099: the actual retry card accepts the named technical leaf while the business leaf stays held',
    ).toBe(true);
    expect(
      new Ajv({ strict: false }).compile(schema)({
        ...input,
        sections: { ...input.sections, ...patch.sections },
      }),
      'D-098/D-101: the composed candidate, with the held business leaf, satisfies the original full schema',
    ).toBe(true);
    expect(
      second.rejections,
      'D-098: held fields compose with the patch; resent saved fields replace them and are never rejected',
    ).toHaveLength(0);
    const detail = engine
      .getDetailSlots()
      .find((slot) => slot.nodeId === ORIGIN)!;
    expect(detail.summary).toBe(input.summary);
    expect(detail.sections).toContainEqual(
      expect.objectContaining({
        angle: 'business',
        text: input.sections.business,
      }),
    );
    expect(detail.sections).toContainEqual(
      expect.objectContaining({
        angle: 'technical',
        text: patch.sections.technical,
      }),
    );
  },
);

it('keeps the original provider schema while rechecking held fields against current metadata', async () => {
  const { session, engine, registry, port, queue, offered } = ownedInputWorld();
  session.enterLmStage({ kind: 'active', mode: 'sm_ct' }, session.turnEpoch);
  const original = {
    summary: 'Held finding.',
    sections: { technical: 'Supplied source facts.' },
    badge_label: 42,
    column_flow: [
      { out_col: 'Value', upstream_columns: [{ node: BRANCH, col: 'Value' }] },
    ],
  };
  const plan = () =>
    compileInstructionPlan({
      kind: 'converse',
      stage: { kind: 'active', mode: 'sm_ct' },
      registry,
      facts: {
        analysisMode: 'ct',
        targetColumns: ['Value'],
        classification: 'technical',
      },
      messages: [modelUserMessage('Trace Value.')],
      sink: new TurnEventSink(() => {}),
      findingSchema: () => engine.findingSchema(),
      toolChoice: 'required',
      requiredTerminalTool: 'lineage_submit_findings',
    });
  queue([{ tool: 'lineage_submit_findings', input: original }]);
  const state = initialToolPhaseAttemptState('active');
  const first = await executeToolAttempt(port, plan(), { priorState: state });
  expect(first.rejections).toHaveLength(1);
  expect(engine.getDetailSlots()).toEqual([]);
  const branch = session.model!.nodes.find((node) => node.id === BRANCH)!;
  branch.columns = [
    { name: 'Other', type: 'int', nullable: 'NULL', extra: '' },
  ];
  queue([
    { tool: 'lineage_submit_findings', input: { badge_label: 'Source' } },
  ]);
  const next = recordToolAttempt(state, first, registry);
  const second = await executeToolAttempt(port, plan(), { priorState: next });
  expect(
    second.rejections.flatMap((rejection) => rejection.issuePaths ?? []),
  ).toContain('column_flow.0.upstream_columns.0.col');
  const repairCard = offered[1]!.find(
    (tool) => tool.name === 'lineage_submit_findings',
  )!;
  expect(
    new Ajv({ strict: false }).compile(repairCard.inputSchema)({
      badge_label: 'Source',
    }),
  ).toBe(true);
  expect(engine.getDetailSlots()).toEqual([]);
  queue([
    {
      tool: 'lineage_submit_findings',
      input: {
        column_flow: [
          {
            out_col: 'Value',
            upstream_columns: [{ node: BRANCH, col: 'Other' }],
          },
        ],
      },
    },
  ]);
  const third = await executeToolAttempt(port, plan(), {
    priorState: recordToolAttempt(next, second, registry),
  });
  expect(third.rejections).toHaveLength(0);
  expect(engine.getDetailSlots()).toContainEqual(
    expect.objectContaining({ summary: original.summary }),
  );
});

it.each(['column_flow', 'unknown-root'] as const)(
  'uses the existing active authorization for an atomic %s repair',
  async (fault) => {
    const { session, engine, registry, port, queue, offered } =
      ownedInputWorld();
    session.enterLmStage({ kind: 'active', mode: 'sm_ct' }, session.turnEpoch);
    const valid = {
      focus_node_id: ORIGIN,
      summary: 'Held source finding.',
      sections: { technical: 'Held SQL body.' },
      column_flow: [
        {
          out_col: 'Value',
          upstream_columns: [
            { node: BRANCH, col: 'Value', note: 'Keep source note.' },
          ],
        },
      ],
      questions: [{ nodeId: BRANCH, question: 'Explain Value.' }],
    };
    const invalid =
      fault === 'column_flow'
        ? {
            ...valid,
            column_flow: [
              {
                ...valid.column_flow[0]!,
                upstream_columns: [
                  {
                    ...valid.column_flow[0]!.upstream_columns[0]!,
                    col: 'Missing',
                  },
                ],
              },
            ],
          }
        : { ...valid, unknown: true };
    const plan = () =>
      compileInstructionPlan({
        kind: 'converse',
        stage: { kind: 'active', mode: 'sm_ct' },
        registry,
        facts: {
          analysisMode: 'ct',
          targetColumns: ['Value'],
          classification: 'technical',
          memorySections: [],
        },
        messages: [modelUserMessage('Trace Value.')],
        sink: new TurnEventSink(() => {}),
        findingSchema: () => engine.findingSchema(),
        toolChoice: 'required',
        requiredTerminalTool: 'lineage_submit_findings',
      });
    queue([{ tool: 'lineage_submit_findings', input: invalid }]);
    const first = await executeToolAttempt(port, plan(), {
      priorState: initialToolPhaseAttemptState('active'),
    });
    expect(first.rejections).toHaveLength(1);
    expect(engine.heldPartsOfCurrentFocus()?.resend).toEqual(
      fault === 'column_flow' ? ['column_flow'] : [],
    );
    const patch =
      fault === 'column_flow' ? { column_flow: valid.column_flow } : {};
    queue([{ tool: 'lineage_submit_findings', input: patch }]);
    const second = await executeToolAttempt(port, plan(), {
      priorState: recordToolAttempt(
        initialToolPhaseAttemptState('active'),
        first,
        registry,
      ),
    });
    const schema = offered[1]!.find(
      (tool) => tool.name === 'lineage_submit_findings',
    )!.inputSchema;
    expect(
      Object.keys(schema.properties),
      'D-098: a repair serves the full schema',
    ).toEqual(
      Object.keys(
        offered[0]!.find((tool) => tool.name === 'lineage_submit_findings')!
          .inputSchema.properties,
      ),
    );
    if (fault === 'column_flow')
      expect(
        new Ajv({ strict: false }).compile(schema)({
          ...valid,
          column_flow: [{ out_col: 'Value' }],
        }),
      ).toBe(false);
    expect(second.rejections).toHaveLength(0);
    expect(
      engine.getDetailSlots().find((slot) => slot.nodeId === ORIGIN),
    ).toMatchObject({
      summary: valid.summary,
      sections: [{ angle: 'technical', text: valid.sections.technical }],
    });
    expect(engine.columnAspect!.edges).toContainEqual(
      expect.objectContaining({ note: 'Keep source note.' }),
    );
  },
);

describe('control routing takes the typed handler signal, never the result text (MW-2 audit)', () => {
  // graph.ts no longer parses start_exploration text: the handler records a typed gate/refusal on the session and the dispatcher takes it.
  // Over-budget reroute (discoveryCapture.ts) and the runtime trace status (lineageRuntime.ts) still read the raw registry record, never the rendered problem.
  const startInput = (levels: 1 | 'all') => ({
    origin: ORIGIN,
    analysisMode: 'bb' as const,
    classification: 'technical' as const,
    question: 'What feeds it?',
    depth: {
      upstream: { levels, exactness: 'exact' as const },
      downstream: { levels: 0 as const, exactness: 'exact' as const },
    },
  });
  const routedPlan = (
    session: AiSession,
    registry:
      | ReturnType<typeof buildAiToolRegistry>
      | ReturnType<typeof scriptedRegistry>['registry'],
    stage: 'sm_entry' | 'discover',
  ) =>
    compileInstructionPlan({
      kind: 'converse',
      stage: { kind: stage },
      registry,
      facts: { memorySections: [] },
      messages: [modelUserMessage('Route this.')],
      sink: new TurnEventSink(() => {}),
      toolChoice: 'auto',
      detectReroute: detectOverBudgetFromResult,
      takeControlSignal: () => session.takeControlSignal(),
    });
  const portCalling = (tool: string, input: object) =>
    new VscodeModelPort({
      id: 'routing',
      name: 'routing',
      vendor: 'test',
      family: 'test',
      version: '1',
      maxInputTokens: 128000,
      countTokens: async () => 1,
      sendRequest: async () => ({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield new vscode.LanguageModelToolCallPart('route-1', tool, input);
          },
        },
      }),
    } as never);
  async function startThroughAttempt(
    levels: 1 | 'all',
    budget = createTurnTokenBudget({}),
  ) {
    const { session } = ctWorld();
    session.stateMachine = null;
    session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
    const registry = buildAiToolRegistry(
      () => session,
      { info() {}, debug() {}, warn() {}, error() {} } as never,
      () => undefined,
      undefined,
      { budget },
    );
    const attempt = await executeToolAttempt(
      portCalling('lineage_start_exploration', startInput(levels)),
      routedPlan(session, registry, 'sm_entry'),
      { priorState: initialToolPhaseAttemptState('sm_entry') },
    );
    return { attempt, session };
  }

  it('routes the real handler gate and refusal through the typed signal', async () => {
    const opened = await startThroughAttempt(1);
    expect(opened.attempt.stop).toBe('gate');
    expect(opened.session.pendingExploration?.revision).toBe(1);
    expect(opened.session.takeControlSignal()).toBeNull();
    const refused = await startThroughAttempt(
      'all',
      createTurnTokenBudget({ maxRounds: 1 }),
    );
    expect(refused.attempt.stop).toBe('refused');
    expect(refused.attempt.refusal).toEqual(expect.any(String));
  });

  it('does not route gate- or refusal-shaped text that carries no typed signal', async () => {
    const session = new AiSession();
    for (const text of [
      JSON.stringify({
        code: 'action_required',
        reason: 'r',
        detail: {
          gate: 'confirm_sm_start',
          classes: [],
          nodeIds: [],
          detail: 'r',
          proposalRevision: 1,
        },
      }),
      JSON.stringify({
        code: 'over_active_scope_budget',
        reason: 'Too large.',
      }),
    ]) {
      const { registry } = scriptedRegistry([
        { name: 'lineage_start_exploration', result: text },
      ]);
      const attempt = await executeToolAttempt(
        portCalling('lineage_start_exploration', {}),
        routedPlan(session, registry, 'sm_entry'),
        { priorState: initialToolPhaseAttemptState('sm_entry') },
      );
      expect(attempt.stop).not.toBe('gate');
      expect(attempt.stop).not.toBe('refused');
    }
  });

  it('routes the real over-budget record, classifies raw records for the trace and never routes the rendered problem', async () => {
    const overBudget = JSON.stringify(
      checkScopeBudget(createTurnTokenBudget({}), 1_000_000, 1_000_000_000),
    );
    const { registry } = scriptedRegistry([
      { name: 'lineage_get_scope_bundle', result: overBudget },
    ]);
    expect(
      (
        await executeToolAttempt(
          portCalling('lineage_get_scope_bundle', {}),
          routedPlan(new AiSession(), registry, 'discover'),
          { priorState: initialToolPhaseAttemptState('discover') },
        )
      ).stop,
    ).toBe('reroute');
    const notices: string[] = [];
    queueDiscoveryBudgetNotice(
      {
        queueClosingNotice: (_key: string, notice: string) => {
          notices.push(notice);
        },
      },
      'lineage_search_objects',
      overBudget,
    );
    expect(notices).toHaveLength(1);
    const grouped = JSON.stringify({
      ...JSON.parse(overBudget),
      detail: [JSON.parse(overBudget).detail],
    });
    expect(
      detectOverBudgetFromResult('lineage_get_scope_bundle', grouped),
    ).toBe(true);
    queueDiscoveryBudgetNotice(
      {
        queueClosingNotice: (_key: string, notice: string) => {
          notices.push(notice);
        },
      },
      'lineage_search_objects',
      grouped,
    );
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain('(1000000 projected nodes)');
    for (const stage of [1, 2, 3] as const)
      expect(
        detectOverBudgetFromResult(
          'lineage_get_scope_bundle',
          renderProblem(
            readToolErrorText(overBudget)!,
            stage,
            undefined,
            'scope_store',
          ),
        ),
      ).toBe(false);
    expect(isConsentGateRejection('action_required')).toBe(true);
    expect(
      isAdmissionRefusal(
        readToolErrorText(
          JSON.stringify({
            code: 'over_active_scope_budget',
            reason: 'Too large.',
            errors: [{ path: '', code: 'over_budget' }],
          }),
        )!.code,
      ),
    ).toBe(true);
  });
});

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path.localeCompare(b.path);

describe('independent read faults', () => {
  it.each([
    {
      name: 'detail structural control',
      tool: 'lineage_get_object_detail',
      input: { id: ORIGIN, cursor: 42 },
      faults: [{ path: 'cursor', code: 'type' }],
    },
    {
      name: 'detail reference control',
      tool: 'lineage_get_object_detail',
      input: { id: '[hop].[Missing]' },
      faults: [{ path: 'id', code: 'not_found' }],
    },
    {
      name: 'detail combined faults',
      tool: 'lineage_get_object_detail',
      input: { id: '[hop].[Missing]', cursor: 42 },
      faults: [
        { path: 'cursor', code: 'type' },
        { path: 'id', code: 'not_found' },
      ],
    },
    {
      name: 'scope structural control',
      tool: 'lineage_get_scope_bundle',
      input: { origin: ORIGIN, direction: 'sideways' },
      faults: [{ path: 'direction', code: 'enum' }],
    },
    {
      name: 'scope reference control',
      tool: 'lineage_get_scope_bundle',
      input: { origin: '[hop].[Missing]' },
      faults: [{ path: 'origin', code: 'not_found' }],
    },
    {
      name: 'scope combined faults',
      tool: 'lineage_get_scope_bundle',
      input: { origin: '[hop].[Missing]', direction: 'sideways' },
      faults: [
        { path: 'direction', code: 'enum' },
        { path: 'origin', code: 'not_found' },
      ],
    },
  ])('$name', async ({ tool, input, faults }) => {
    const { session, engine, registry } = ctWorld();
    session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
    const before = engine.toJSON();
    const result = JSON.parse(String(await registry.invoke(tool, input)));
    expect(
      result.errors
        ?.map(({ path, code }: { path: string; code: string }) => ({
          path,
          code,
        }))
        .sort(byPath),
    ).toEqual(faults);
    expect(engine.toJSON()).toEqual(before);
    expect(engine.heldFindingFocus).toBeNull();
    expect(session.discoveryScopeArtifact).toBeNull();
  });
});

describe('shared ingestion transaction', () => {
  const references = z.array(z.string().meta({ toolStringFact: 'reference' }));
  const schema = z
    .object({ title: z.string(), detail: z.string(), refs: references })
    .strict();
  /** Facts collect their problems on the context, so each call takes its own. */
  const unknownReference = () => ({
    strings: new Map([
      [
        'reference',
        (value: string, context: { instancePath: string }) =>
          value === 'missing'
            ? makeRejection({
                code: 'invalid_input',
                errors: at('not_found', [
                  context.instancePath.slice(1).replace('/', '.'),
                ]),
              })
            : null,
      ],
    ]),
  });

  it('collects independent schema and metadata faults once, then accepts a minimal repair without partial publication', () => {
    const parse = vi.spyOn(toolValidation, 'validateToolCandidate');
    const draft = new ToolDraft<object>();
    const published: unknown[] = [];
    const inspect = vi.fn((view: ToolInputView<typeof schema>) =>
      view.parsed.success
        ? () => {
            published.push(view.parsed.success ? view.parsed.data : null);
            return { ok: true };
          }
        : undefined,
    );
    try {
      const rejected = ingestToolInput({
        input: {
          title: 42,
          detail: 'Keep exact authored detail.',
          refs: ['known', 'missing'],
        },
        schema,
        context: 'same',
        draft,
        facts: unknownReference(),
        inspect,
      });
      expect(rejected).toHaveProperty('code');
      if (!('errors' in rejected)) throw new Error('Expected rejection');
      expect(
        rejected.errors.map(({ path, code }) => ({ path, code })).sort(byPath),
      ).toEqual([
        { path: 'refs.1', code: 'not_found' },
        { path: 'title', code: 'type' },
      ]);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(published).toEqual([]);
      expect(draft.get()).toEqual({ detail: 'Keep exact authored detail.' });
      expect(
        ingestToolInput({
          input: { title: 'Correct title', refs: ['known'] },
          schema,
          context: 'same',
          draft,
          facts: unknownReference(),
          inspect,
        }),
      ).toEqual({ ok: true });
      expect(parse).toHaveBeenCalledTimes(2);
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(published).toEqual([
        {
          title: 'Correct title',
          detail: 'Keep exact authored detail.',
          refs: ['known'],
        },
      ]);
      expect(draft.get()).toBeNull();
    } finally {
      parse.mockRestore();
    }
  });

  it('does not treat an inapplicable union alternative as proof of a selected field type', () => {
    const union = z
      .union([
        z.object({ kind: z.literal('a'), value: z.string() }),
        z.object({ kind: z.literal('b'), value: z.number() }),
      ])
      .meta({ toolValidated: 'choice' });
    const receive = vi.fn();
    expect(
      validateToolCandidate(
        union,
        { kind: 'a', value: 42 },
        {
          validated: new Map([
            ['choice', toolValidation.captureToolFact(union, receive)],
          ]),
        },
      ).success,
    ).toBe(false);
    expect(receive).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'valid field beside invalid sibling',
      input: { other: 'wrong', rows: [{ id: 'a' }] },
      success: false,
      facts: ['row:/rows/0', 'rows:/rows'],
      checks: 1,
    },
    {
      name: 'mixed items preserve original index',
      input: { rows: [42, { id: 'a' }] },
      success: false,
      facts: ['row:/rows/1'],
      checks: 1,
    },
    {
      name: 'explicit empty list',
      input: { rows: [] },
      success: true,
      facts: ['rows:/rows'],
      checks: 0,
    },
    {
      name: 'malformed parent',
      input: { rows: 42 },
      success: false,
      facts: [],
      checks: 0,
    },
    { name: 'missing parent', input: {}, success: false, facts: [], checks: 0 },
  ])('native facts: $name', ({ input, success, facts, checks }) => {
    const row = z
      .object({ id: z.string().meta({ toolStringFact: 'checkedId' }) })
      .strict()
      .meta({ toolValidated: 'row' });
    const rows = z.array(row).meta({ toolValidated: 'rows' });
    const received: string[] = [];
    const checked = vi.fn();
    const before = structuredClone(input);
    const result = validateToolCandidate(
      z.object({ other: z.number().optional(), rows }).strict(),
      input,
      {
        strings: new Map([['checkedId', checked]]),
        validated: new Map([
          [
            'row',
            toolValidation.captureToolFact(row, (_value, path) => {
              received.push(`row:${path}`);
            }),
          ],
          [
            'rows',
            toolValidation.captureToolFact(rows, (_value, path) => {
              received.push(`rows:${path}`);
            }),
          ],
        ]),
      },
    );
    expect(result.success).toBe(success);
    expect(received.sort()).toEqual([...facts].sort());
    expect(checked).toHaveBeenCalledTimes(checks);
    expect(input).toEqual(before);
  });
});

describe('committed REPORT link dependencies (Approved08 / D-099)', () => {
  it.each([
    {
      label: 'omitted links retain the committed set',
      section: { label: 'Sources' },
      errors: [
        {
          path: 'sections.*.node_ids',
          code: 'node_unexplained',
          values: [BRANCH],
        },
      ],
    },
    {
      label: 'malformed links remain unknown rather than retained',
      section: { label: 'Sources', node_ids: 42 },
      errors: [
        { path: 'sections.0.node_ids', code: 'type', values: ['array'] },
      ],
    },
  ])('$label', async ({ section, errors }) => {
    const { session, registry } = ctWorld({ mode: 'bb' });
    session.explorationRunId = 'synthetic-report-run';
    session.resultGraph = {
      nodeIds: [ORIGIN, BRANCH],
      edges: [[BRANCH, ORIGIN, 'read']],
      source: 'blackboard',
      originNodeId: ORIGIN,
      sectionsRunId: session.explorationRunId,
      sections: [
        { label: 'Sources', node_ids: [ORIGIN], text: 'Committed body.' },
      ],
    };
    session.enterCompleted(session.turnEpoch);
    const before = structuredClone(session.resultGraph);
    const report = {
      name: 'Report',
      summary: 'Branch supplies the report.',
      sections: [section],
      highlight_groups: [
        { label: 'Origin', color: 'target', node_ids: [ORIGIN] },
      ],
    };
    expect(
      JSON.parse(await registry.invoke('lineage_present_result', report))
        .errors,
    ).toEqual(errors);
    expect(session.resultGraph).toEqual(before);
    expect(session.presentationArtifact).toBeNull();
    expect(
      JSON.parse(
        await registry.invoke('lineage_present_result', {
          sections: [{ label: 'Sources', node_ids: [ORIGIN, BRANCH] }],
        }),
      ),
    ).toMatchObject({ success: true });
    expect(session.resultGraph?.sections).toEqual([
      { label: 'Sources', node_ids: [ORIGIN, BRANCH], text: 'Committed body.' },
    ]);
  });
});

describe('shared ingestion draft ownership', () => {
  it('preserves staged values when publication throws instead of clearing them before commit', () => {
    const schema = z.object({ title: z.string(), detail: z.string() }).strict();
    const draft = new ToolDraft<object>();
    draft.retain(
      draft.apply('same', { detail: 'Preserved draft' }, schema),
      [],
      schema,
    );
    expect(() =>
      ingestToolInput({
        input: { title: 'Title' },
        schema,
        context: 'same',
        draft,
        inspect: () => () => {
          throw new Error('Publication interrupted');
        },
      }),
    ).toThrow('Publication interrupted');
    expect(draft.get()).toEqual({ detail: 'Preserved draft' });
  });

  it('retains no read listeners and one cancellable draft subscription across repeated rejected calls', () => {
    const schema = z.object({ saved: z.string(), correction: z.string() });
    const controller = new AbortController();
    const draft = new ToolDraft<object>();
    const run = (input: unknown, store?: ToolDraft<object>) =>
      toolInputReceipt.run(
        { input, context: 'turn', signal: controller.signal },
        () =>
          ingestToolInput({
            input,
            schema,
            context: 'turn',
            draft: store,
            inspect: (view) =>
              view.parsed.success ? () => 'accepted' : undefined,
          }),
      );
    const listeners = () => getEventListeners(controller.signal, 'abort');
    for (let index = 0; index < 12; index++)
      run({ saved: 'Read', correction: 'Complete' });
    expect(listeners()).toHaveLength(0);
    for (let index = 0; index < 12; index++)
      run({ saved: 'Held exact text', correction: 42 }, draft);
    expect(draft.get()).toEqual({ saved: 'Held exact text' });
    expect(listeners()).toHaveLength(1);
    expect(run({ correction: 'Complete' }, draft)).toBe('accepted');
    expect(listeners()).toHaveLength(0);
    run({ saved: 'New held text', correction: 42 }, draft);
    controller.abort();
    expect(draft.get()).toBeNull();
    expect(listeners()).toHaveLength(0);
  });
});

it.each([
  {
    cap: 1,
    faults: [
      { path: '', code: 'over_budget' },
      { path: 'include_ddl', code: 'type' },
    ],
  },
  { cap: 3, faults: [{ path: 'include_ddl', code: 'type' }] },
])(
  'reports independent discovery scope budget and native include_ddl faults before any publication: cap=$cap',
  async ({ cap, faults }) => {
    const { session } = ctWorld();
    session.stateMachine = null;
    session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
    const registry = buildAiToolRegistry(
      () => session,
      { info() {}, debug() {}, warn() {}, error() {} } as never,
      () => undefined,
      undefined,
      { budget: createTurnTokenBudget({ discoveryNodeCap: cap }) },
    );
    const input = {
      origin: ORIGIN,
      upstream_depth: 'all',
      downstream_depth: 0,
      include_ddl: 42,
    };
    const before = structuredClone({ input, memory: session.memory.toJSON() });
    const native = vi.spyOn(toolValidation, 'validateToolCandidate');
    const ddl = vi.spyOn(graphUtils, 'getNodeDdl');
    try {
      const result = JSON.parse(
        await registry.invoke('lineage_get_scope_bundle', input),
      );
      expect(native).toHaveBeenCalledTimes(1);
      const admission = native.mock.results[0]!.value;
      expect(admission.success).toBe(false);
      expect(
        admission.errors.map(
          (error: { instancePath: string; keyword: string }) => [
            error.instancePath,
            error.keyword,
          ],
        ),
      ).toEqual([['/include_ddl', 'type']]);
      expect(
        result.errors
          .map(({ path, code }: { path: string; code: string }) => ({
            path,
            code,
          }))
          .sort(byPath),
      ).toEqual(faults);
      expect(ddl).not.toHaveBeenCalled();
      expect(result.code).toBe('invalid_input');
      expect(
        detectOverBudgetFromResult(
          'lineage_get_scope_bundle',
          JSON.stringify(result),
        ),
      ).toBe(false);
      expect(session.discoveryScopeArtifact).toBeNull();
      expect(session.pendingExploration).toBeNull();
      expect(session.stateMachine).toBeNull();
      expect(session.memory.toJSON()).toEqual(before.memory);
      expect(input).toEqual(before.input);
      const corrected = JSON.parse(
        await registry.invoke('lineage_get_scope_bundle', {
          ...input,
          include_ddl: false,
          upstream_depth: 0,
          downstream_depth: 1,
        }),
      );
      expect(corrected).toMatchObject({
        origin: ORIGIN,
        nodes: [{ id: ORIGIN }],
        edges: [],
      });
      expect(session.discoveryScopeArtifact).toMatchObject({
        origin: ORIGIN,
        nodeIds: [ORIGIN],
        edges: [],
      });
      expect(session.pendingExploration).toBeNull();
      expect(session.stateMachine).toBeNull();
    } finally {
      native.mockRestore();
      ddl.mockRestore();
    }
  },
);

// Synthetic calls exercise the production admission boundary without a model provider.
describe('synthetic discovery and START budget boundary', () => {
  it('routes a real discovery scope refusal and accepts a smaller scope without publishing rejected evidence', async () => {
    const { session } = ctWorld();
    session.stateMachine = null;
    session.enterLmStage({ kind: 'discover' }, session.turnEpoch);
    const budget = createTurnTokenBudget({ discoveryNodeCap: 1 });
    let input = { origin: ORIGIN, upstream_depth: 'all', downstream_depth: 0 };
    const port = new VscodeModelPort(
      {
        id: 'synthetic-discovery-budget',
        name: 'synthetic-discovery-budget',
        vendor: 'test',
        family: 'test',
        version: '1',
        maxInputTokens: 128000,
        countTokens: async () => 1,
        sendRequest: async () => ({
          stream: {
            async *[Symbol.asyncIterator]() {
              yield new vscode.LanguageModelToolCallPart(
                `synthetic-${port.modelCalls}`,
                'lineage_get_scope_bundle',
                input,
              );
            },
          },
        }),
      } as never,
      { budget },
    );
    const registry = buildAiToolRegistry(
      () => session,
      { info() {}, debug() {}, warn() {}, error() {} } as never,
      () => undefined,
      undefined,
      { model: port, budget },
    );
    const results: string[] = [];
    const plan = compileInstructionPlan({
      kind: 'converse',
      stage: { kind: 'discover' },
      registry,
      facts: { memorySections: [] },
      messages: [modelUserMessage('Synthetic scope-budget contract.')],
      sink: new TurnEventSink(() => {}),
      toolChoice: 'auto',
      detectReroute: detectOverBudgetFromResult,
      onToolResult: (_tool, _input, _error, result) => {
        results.push(result);
      },
    });
    const before = structuredClone(session.memory.toJSON());
    const rejected = await executeToolAttempt(port, plan, {
      priorState: initialToolPhaseAttemptState('discover'),
    });
    expect(JSON.parse(results[0]!)).toMatchObject({
      code: 'invalid_input',
      reason: 'over_discovery_budget',
      errors: [{ path: '', code: 'over_budget' }],
      detail: [
        {
          counts: { nodes: 2 },
          limits: { node_cap: 1 },
          scope_proposal: { origin: ORIGIN, direction: 'bidirectional' },
        },
      ],
    });
    expect(rejected.stop).toBe('reroute');
    expect(rejected.observations).toEqual([]);
    expect(session.discoveryScopeArtifact).toBeNull();
    expect(session.pendingExploration).toBeNull();
    expect(session.startExplorationDraft.get()).toBeNull();
    expect(session.memory.toJSON()).toEqual(before);
    input = { ...input, origin: BRANCH };
    const accepted = await executeToolAttempt(port, plan, {
      priorState: initialToolPhaseAttemptState('discover'),
    });
    expect(accepted.rejections).toEqual([]);
    expect(accepted.observations).toHaveLength(1);
    expect(JSON.parse(results[1]!)).toMatchObject({
      origin: BRANCH,
      nodes: [{ id: BRANCH }],
      edges: [],
    });
    expect(session.discoveryScopeArtifact).toMatchObject({
      origin: BRANCH,
      nodeIds: [BRANCH],
      edges: [],
    });
    expect(session.pendingExploration).toBeNull();
    expect(session.stateMachine).toBeNull();
  });

  it.each([
    {
      name: 'scope refusal',
      badMission: false,
      lowBudget: true,
      code: 'over_active_scope_budget',
      faults: [{ path: '', code: 'over_budget' }],
    },
    {
      name: 'native fault',
      badMission: true,
      lowBudget: false,
      code: 'invalid_input',
      faults: [{ path: 'mission_brief', code: 'type' }],
    },
    {
      name: 'independent native and scope faults',
      badMission: true,
      lowBudget: true,
      code: 'invalid_input',
      faults: [
        { path: '', code: 'over_budget' },
        { path: 'mission_brief', code: 'type' },
      ],
    },
  ])(
    'holds only valid fields and admits the exact correction: $name',
    async ({ badMission, lowBudget, code, faults }) => {
      const { session } = ctWorld();
      session.stateMachine = null;
      session.enterLmStage({ kind: 'sm_entry' }, session.turnEpoch);
      const budget = createTurnTokenBudget({ maxRounds: lowBudget ? 1 : 100 });
      const original = {
        origin: ORIGIN,
        analysisMode: 'bb',
        classification: 'technical',
        mission_brief: badMission ? 42 : 'Exact authored mission.',
        depth: {
          upstream: { levels: 'all', exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      };
      let input: object = original;
      const port = new VscodeModelPort(
        {
          id: 'synthetic-start-budget',
          name: 'synthetic-start-budget',
          vendor: 'test',
          family: 'test',
          version: '1',
          maxInputTokens: 128000,
          countTokens: async () => 1,
          sendRequest: async () => ({
            stream: {
              async *[Symbol.asyncIterator]() {
                yield new vscode.LanguageModelToolCallPart(
                  `synthetic-${port.modelCalls}`,
                  'lineage_start_exploration',
                  input,
                );
              },
            },
          }),
        } as never,
        { budget },
      );
      const registry = buildAiToolRegistry(
        () => session,
        { info() {}, debug() {}, warn() {}, error() {} } as never,
        () => undefined,
        undefined,
        { model: port, budget },
      );
      const results: string[] = [];
      const plan = compileInstructionPlan({
        kind: 'converse',
        stage: { kind: 'sm_entry' },
        registry,
        facts: { memorySections: [] },
        messages: [modelUserMessage('Synthetic active-scope-budget contract.')],
        sink: new TurnEventSink(() => {}),
        toolChoice: 'auto',
        takeControlSignal: () => session.takeControlSignal(),
        onToolResult: (_tool, _input, _error, result) => {
          results.push(result);
        },
      });
      const native = validateToolCandidate(
        startExplorationSchemaForState(false),
        original,
      );
      expect(native.success).toBe(!badMission);
      if (!native.success)
        expect(
          native.errors.map((error) => [error.instancePath, error.keyword]),
        ).toEqual([['/mission_brief', 'type']]);
      const before = structuredClone({
        memory: session.memory.toJSON(),
        original,
      });
      const rejected = await executeToolAttempt(port, plan, {
        priorState: initialToolPhaseAttemptState('sm_entry'),
      });
      const problem = JSON.parse(results[0]!);
      expect(problem.code).toBe(code);
      expect(
        problem.errors
          .map(({ path, code }: { path: string; code: string }) => ({
            path,
            code,
          }))
          .sort(byPath),
      ).toEqual(faults);
      expect(rejected.stop).toBe(badMission ? 'continue' : 'refused');
      expect(rejected.observations).toEqual([]);
      expect(session.pendingExploration).toBeNull();
      expect(session.stateMachine).toBeNull();
      expect(session.discoveryScopeArtifact).toBeNull();
      expect(session.memory.toJSON()).toEqual(before.memory);
      expect(original).toEqual(before.original);
      const { mission_brief: _mission, ...valid } = original;
      expect(session.startExplorationDraft.get()).toEqual(
        badMission ? valid : original,
      );
      const depth = lowBudget
        ? {
            upstream: { levels: 0, exactness: 'exact' },
            downstream: { levels: 1, exactness: 'exact' },
          }
        : original.depth;
      input = {
        ...(badMission ? { mission_brief: 'Corrected authored mission.' } : {}),
        ...(lowBudget ? { depth } : {}),
      };
      const accepted = await executeToolAttempt(port, plan, {
        priorState: recordToolAttempt(
          initialToolPhaseAttemptState('sm_entry'),
          rejected,
          registry,
        ),
      });
      expect(accepted.stop).toBe('gate');
      expect(accepted.rejections).toEqual([]);
      expect(JSON.parse(results[1]!)).toMatchObject({
        code: 'action_required',
        detail: { gate: 'confirm_sm_start', proposalRevision: 1 },
      });
      expect(session.pendingExploration).toMatchObject({
        revision: 1,
        classification: 'technical',
        init: {
          origin: ORIGIN,
          analysisMode: 'bb',
          depthIntent: depth,
          mission_brief: badMission
            ? 'Corrected authored mission.'
            : original.mission_brief,
        },
      });
      expect(session.startExplorationDraft.get()).toBeNull();
      expect(session.stateMachine).toBeNull();
    },
  );
});

describe('BB hops carry no column-trace continuation', () => {
  const tasks = [{ kind: 'root' as const, question: 'Trace Value.' }];

  it.each([undefined, []])(
    'the task renderer suppresses CT-only blocks without active columns: %j',
    (columns) => {
      const bb = buildCurrentTaskBlock(tasks, columns, ['Trace stale Value.']);
      expect(bb).toContain('Trace Value.');
      expect(bb).not.toContain('<lineage_questions>');
      expect(bb).not.toContain('<column_trace>');
      const ct = buildCurrentTaskBlock(tasks, ['Value'], ['Trace Value.']);
      for (const block of [
        '<lineage_questions>',
        '<column_trace>',
        'Trace Value.',
      ])
        expect(ct).toContain(block);
    },
  );

  it('a BB hop of a CT run projects no stale lineage rider and keeps the authored question', async () => {
    const { session, engine, registry } = ctWorld();
    // BRANCH gets an explicit outcome (a question, D-031); no value lands, so its visit is object-level.
    const accepted = JSON.parse(
      await registry.invoke('lineage_submit_findings', {
        focus_node_id: ORIGIN,
        summary: 'Origin reads Branch.',
        sections: { technical: 'Origin selects from Branch.' },
        column_flow: [],
        questions: [
          { nodeId: BRANCH, question: 'How does Branch affect the rows?' },
        ],
      }),
    );
    expect(accepted).toHaveProperty('ok', true);
    expect(engine.peekHopContext()).toMatchObject({
      analysis_mode: 'bb',
      focus_node: { id: BRANCH },
    });
    (
      engine as unknown as { _pendingLineageQuestions: string[] }
    )._pendingLineageQuestions = ['Trace stale Value at this branch'];
    const { message } = buildActiveHopInstruction(session, engine, BRANCH);
    expect(message).toContain(
      '<sub_question>How does Branch affect the rows?</sub_question>',
    );
    expect(message).not.toContain('<lineage_questions>');
    expect(message).not.toContain('<column_trace>');
  });
});
