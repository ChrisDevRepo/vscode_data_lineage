import { describe, expect, it } from 'vitest';
import type { DatabaseModel } from '../../../src/engine/types';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { TurnEventSink, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import { ToolRegistry } from '../../../src/ai/tools/registry';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { StructuredOutputError } from '../../../src/ai/providers/structuredOutput';
import { z } from 'zod';

describe('provider tool-call compatibility', () => {
  it('reports repeated empty structured arguments as a compatibility failure', async () => {
    const session = new AiSession();
    session.model = oneNodeModel();
    const model = emptyStructuredModel();
    const events: TurnEvent[] = [];
    const runtime = new LineageRuntime({
      getSession: () => session,
      createRegistry: () => new ToolRegistry<string>(),
    });

    const result = await runtime.run({
      model,
      request: { id: 'empty-structured', prompt: 'what feeds dbo.Orders?' },
      sink: new TurnEventSink(event => events.push(event)),
    });

    expect(result).toMatchObject({
      outcome: 'error',
      modelCalls: 3,
      failure: {
        code: 'incompatible_tool_call_format',
        message: expect.stringContaining('empty arguments'),
      },
    });
    expect(events.filter(event => event.type === 'error')).toEqual([
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('compatible JSON tool calling'),
      }),
    ]);
  });

  it('withholds a tool-less false error and completes only after trusted discovery evidence', async () => {
    const session = new AiSession();
    session.model = oneNodeModel();
    const model = evidenceRepairModel();
    const events: TurnEvent[] = [];
    const runtime = new LineageRuntime({
      getSession: () => session,
      createRegistry: () => {
        const registry = new ToolRegistry<string>();
        registry.register({
          name: 'lineage_get_context',
          modelDescription: 'Loaded snapshot context.',
          inputSchema: z.object({}).strict(),
          execute: () => JSON.stringify({ schemas: 1, visible_objects: 1, total_objects: 1 }),
        });
        return registry;
      },
    });

    const result = await runtime.run({
      model,
      request: { id: 'evidence-repair', prompt: 'summarize the loaded context' },
      sink: new TurnEventSink(event => events.push(event)),
    });

    expect(result).toMatchObject({ outcome: 'ok', modelCalls: 4 });
    const text = events
      .filter((event): event is Extract<TurnEvent, { type: 'text' }> => event.type === 'text')
      .map(event => event.delta)
      .join('');
    expect(text).toBe('There is 1 object in the loaded snapshot.');
    expect(text).not.toContain('DB Error');
  });
});

function emptyStructuredModel(): ModelPort {
  let calls = 0;
  return {
    id: 'empty-structured',
    identity: { id: 'empty-structured', name: 'Empty Structured', vendor: 'test', family: 'test', version: '1' },
    get modelCalls() { return calls; },
    async generateStructured<T>(): Promise<T> {
      calls += 1;
      throw new StructuredOutputError('structured_output arguments were empty', 'empty_structured_output');
    },
    async generateToolTurn() { calls += 1; throw new Error('unexpected tool turn'); },
    async completeText() { calls += 1; throw new Error('unexpected text turn'); },
  };
}

function evidenceRepairModel(): ModelPort {
  let calls = 0;
  let toolTurns = 0;
  return {
    id: 'evidence-repair',
    identity: { id: 'evidence-repair', name: 'Evidence Repair', vendor: 'test', family: 'test', version: '1' },
    get modelCalls() { return calls; },
    async generateStructured<T>(): Promise<T> {
      calls += 1;
      return { entry: 'discovery', targetColumns: null } as T;
    },
    async generateToolTurn() {
      calls += 1;
      toolTurns += 1;
      if (toolTurns === 1) {
        return {
          status: 'completed' as const,
          content: [],
          text: '**DB Error**\n\nlineage_get_context() was blocked.',
          toolCalls: [],
          finishReason: 'stop',
        };
      }
      if (toolTurns === 2) {
        return {
          status: 'completed' as const,
          content: [],
          text: '',
          toolCalls: [{
            valid: true as const,
            callId: 'context-1',
            toolName: 'lineage_get_context',
            input: {},
          }],
          finishReason: 'tool-calls',
        };
      }
      return {
        status: 'completed' as const,
        content: [],
        text: 'There is 1 object in the loaded snapshot.',
        toolCalls: [],
        finishReason: 'stop',
      };
    },
    async completeText() { calls += 1; throw new Error('unexpected text turn'); },
  };
}

function oneNodeModel(): DatabaseModel {
  const node = {
    id: '[dbo].[orders]', schema: 'dbo', name: 'Orders', fullName: '[dbo].[Orders]', type: 'table' as const, columns: [],
  };
  return {
    nodes: [node], edges: [],
    schemas: [{ name: 'dbo', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } }],
    catalog: {}, neighborIndex: { [node.id]: { in: [], out: [] } }, dbPlatform: 'SQL Server',
  };
}
