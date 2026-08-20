import { describe, expect, it } from 'vitest';
import type { DatabaseModel } from '../../../src/engine/types';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { TurnEventSink, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import { ToolRegistry } from '../../../src/ai/tools/registry';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import {
  tryBuildDeterministicContextAnswer,
  type StagePromptContext,
} from '../../../src/ai/prompting/hostPrompts';

const FILTERED_CONTEXT: StagePromptContext = {
  dbPlatform: 'SQL Server 2025',
  filterSchemas: ['ai'],
  totalSchemaCount: 8,
  visibleNodes: 32,
  totalNodes: 148,
};

describe('deterministic host-context questions', () => {
  it('answers the reported current-schema object-count question from authoritative state', () => {
    expect(tryBuildDeterministicContextAnswer(
      'how many objects has the current schema',
      FILTERED_CONTEXT,
    )).toBe('The current `ai` schema has **32 objects**.');
  });

  it('answers schema-count and platform questions without model reasoning', () => {
    expect(tryBuildDeterministicContextAnswer('how many schemas are loaded?', FILTERED_CONTEXT))
      .toBe('The loaded snapshot contains **8 schemas**.');
    expect(tryBuildDeterministicContextAnswer('what database platform is this?', FILTERED_CONTEXT))
      .toBe('The loaded snapshot platform is **SQL Server 2025**.');
  });

  it('does not intercept semantic lineage or type-specific count questions', () => {
    expect(tryBuildDeterministicContextAnswer('what feeds dbo.Orders?', FILTERED_CONTEXT)).toBeNull();
    expect(tryBuildDeterministicContextAnswer('how many views feed dbo.Orders?', FILTERED_CONTEXT)).toBeNull();
  });

  it('completes the reported query with zero provider calls', async () => {
    const session = new AiSession();
    session.model = contextModel();
    session.filter = {
      schemas: ['ai'],
      types: ['table', 'view', 'procedure', 'function'],
      hideIsolated: false,
      focusSchemas: [],
      showExternalRefs: true,
      externalRefTypes: [],
    };
    const model = rejectingModel();
    const events: TurnEvent[] = [];
    const runtime = new LineageRuntime({
      getSession: () => session,
      createRegistry: () => new ToolRegistry<string>(),
    });

    const result = await runtime.run({
      model,
      request: { id: 'context-count', prompt: 'how many objects has the current schema' },
      sink: new TurnEventSink(event => events.push(event)),
    });

    expect(result).toMatchObject({ outcome: 'ok', modelCalls: 0 });
    expect(events).toContainEqual({
      type: 'text',
      delta: 'The current `ai` schema has **32 objects**.',
    });
  });
});

function rejectingModel(): ModelPort {
  let calls = 0;
  return {
    id: 'must-not-run',
    identity: { id: 'must-not-run', name: 'Must Not Run', vendor: 'test', family: 'test', version: '1' },
    get modelCalls() { return calls; },
    async generateStructured<T>(): Promise<T> { calls += 1; throw new Error('provider should not run'); },
    async generateToolTurn() { calls += 1; throw new Error('provider should not run'); },
    async completeText() { calls += 1; throw new Error('provider should not run'); },
  };
}

function contextModel(): DatabaseModel {
  const nodes = Array.from({ length: 32 }, (_, index) => ({
    id: `[ai].[object${index}]`,
    schema: 'ai',
    name: `Object${index}`,
    fullName: `[ai].[Object${index}]`,
    type: 'table' as const,
    columns: [],
  }));
  return {
    nodes,
    edges: [],
    schemas: Array.from({ length: 8 }, (_, index) => ({
      name: index === 0 ? 'ai' : `schema${index}`,
      nodeCount: index === 0 ? 32 : 0,
      types: { table: index === 0 ? 32 : 0, view: 0, procedure: 0, function: 0, external: 0 },
    })),
    catalog: {},
    neighborIndex: Object.fromEntries(nodes.map(node => [node.id, { in: [], out: [] }])),
    dbPlatform: 'SQL Server 2025',
  } as DatabaseModel;
}
