/**
 * The port-agnostic acceptance suite every {@link ModelPort} implementation must pass.
 *
 * @remarks
 * `VscodeModelPort` is the reference implementation of the model boundary, but it is no longer the
 * only one: the headless real-model harness speaks an OpenAI-compatible HTTP protocol against the
 * same contract. Those two ports share no code — one converts a `vscode.lm` part stream, the other
 * a JSON body — so the only thing that can keep them behaviourally identical is one suite that runs
 * against both. Everything asserted here is protocol-independent by construction: a case that could
 * only hold on one transport belongs in that port's own file, not in this module.
 *
 * The contract under test is the part of the boundary the graph depends on and cannot re-check:
 * validation happens *before* dispatch (an invalid call is a completed generation carrying a
 * rejection, never an exception), provider input is never mutated, a rejected call is classified by
 * a stable code, exactly one physical provider attempt is made per generation — the single-generation
 * invariant `toolAttempt.ts` throws on — and a pre-aborted signal spends nothing at all.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import type { ModelPort } from '../../../../src/ai/model/modelPort';

/** One provider-emitted content part, in the shape both lanes can script. */
export type ScriptedPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    };

/** What the scripted provider does when the port asks it for one generation. */
export interface PortScript {
  /** Parts the provider emits, in order. Ignored when {@link failure} is set. */
  readonly parts?: readonly ScriptedPart[];
  /**
   * How the provider fails, when it does.
   *
   * `'request'` rejects before any content exists; `'mid-response'` starts answering and then
   * fails while the port is consuming the response. Both must reach the caller as one attempt.
   */
  readonly failure?: 'request' | 'mid-response';
}

/** A port instance plus the physical-attempt counter its transport double observed. */
export interface ContractPort {
  readonly port: ModelPort;
  /**
   * Physical provider attempts — `sendRequest` calls, HTTP requests — observed by the double.
   *
   * @remarks
   * Deliberately not `port.modelCalls`: the port increments that itself, so a port that retried
   * internally could still report one. Only the transport can prove no retry happened.
   */
  providerAttempts(): number;
}

/** The per-port glue the shared suite needs: build a port over a scripted provider. */
export interface PortContractHarness {
  /** Name used in the `describe` title, e.g. `'VscodeModelPort'`. */
  readonly portName: string;
  createPort(script: PortScript): ContractPort;
}

const PRESENT = 'lineage_present_result';

function toolDefinition(name: string, schema: z.ZodType) {
  return { name, description: `Contract tool ${name}`, inputSchema: schema };
}

/** Strict schema whose default proves the caller receives parsed data rather than raw input. */
const presentSchema = z.object({
  id: z.string(),
  mode: z.string().default('bb'),
}).strict();

/**
 * Registers the shared acceptance suite for one model port.
 *
 * @param harness - Transport glue that scripts the provider for the port under test.
 */
export function describePortContract(harness: PortContractHarness): void {
  describe(`${harness.portName} model-port contract`, () => {
    it('preserves the provider call identifier and hands the caller schema-parsed input', async () => {
      const built = harness.createPort({
        parts: [{ type: 'tool-call', callId: 'call-42', toolName: PRESENT, input: { id: 'x' } }],
      });
      const result = await built.port.generateToolTurn({
        messages: [new HumanMessage('present')],
        tools: [toolDefinition(PRESENT, presentSchema)],
        phase: 'synthesis',
      });

      expect(result.status).toBe('completed');
      // `mode` is absent from the provider payload: seeing it proves `parsed.data` reached the
      // caller, not the raw object the provider sent.
      expect(result.toolCalls[0]).toEqual({
        valid: true, callId: 'call-42', toolName: PRESENT, input: { id: 'x', mode: 'bb' },
      });
      expect(result.content).toEqual([{ type: 'tool-call', call: result.toolCalls[0] }]);
      expect(built.providerAttempts()).toBe(1);
    });

    it('rejects unknown, missing, wrong-type, and unknown-field calls before dispatch without mutating provider input', async () => {
      const strict = z.object({ id: z.string() }).strict();
      const cases = [
        { label: 'unknown tool', name: 'lineage_unknown', input: { id: 'x' }, code: 'unknown_tool' },
        { label: 'missing field', name: PRESENT, input: {}, code: 'invalid_tool_input' },
        { label: 'wrong field type', name: PRESENT, input: { id: 9 }, code: 'invalid_tool_input' },
        { label: 'unknown field', name: PRESENT, input: { id: 'x', extra: true }, code: 'invalid_tool_input' },
      ] as const;

      for (const testCase of cases) {
        const raw: Record<string, unknown> = { ...testCase.input };
        const built = harness.createPort({
          parts: [{ type: 'tool-call', callId: `call-${testCase.label}`, toolName: testCase.name, input: raw }],
        });
        const result = await built.port.generateToolTurn({
          messages: [new HumanMessage('run')],
          tools: [toolDefinition(PRESENT, strict)],
          phase: 'synthesis',
        });

        // A rejected call is a completed generation, never a thrown provider failure: the graph
        // repairs it in the next round and a throw would end the turn instead.
        expect(result.status, testCase.label).toBe('completed');
        expect(result.toolCalls[0], testCase.label).toMatchObject({
          valid: false, callId: `call-${testCase.label}`, code: testCase.code,
        });
        expect(result.content, testCase.label).toEqual([{ type: 'tool-call', call: result.toolCalls[0] }]);
        expect(raw, testCase.label).toEqual(testCase.input);
      }
    });

    it('rejects a repeated call identifier as a duplicate before it can be judged an unknown tool', async () => {
      const built = harness.createPort({
        parts: [
          { type: 'tool-call', callId: 'call-007', toolName: PRESENT, input: { id: 'one' } },
          // Same id AND an unavailable tool: duplicate must win, because the id collision makes the
          // second call unpairable regardless of what it names.
          { type: 'tool-call', callId: 'call-007', toolName: 'lineage_unknown', input: { id: 'two' } },
        ],
      });
      const result = await built.port.generateToolTurn({
        messages: [new HumanMessage('present')],
        tools: [toolDefinition(PRESENT, z.object({ id: z.string() }).strict())],
        phase: 'synthesis',
      });

      expect(result.toolCalls).toEqual([
        expect.objectContaining({ valid: true, callId: 'call-007', input: { id: 'one' } }),
        expect.objectContaining({ valid: false, callId: 'call-007', code: 'duplicate_call_id' }),
      ]);
    });

    it('narrows the callable tool set to the tool choice so an off-choice call is unknown', async () => {
      const schema = z.object({ id: z.string() }).strict();
      const tools = [toolDefinition('lineage_first', schema), toolDefinition('lineage_second', schema)];
      const cases = [
        { label: 'named choice', choice: { type: 'tool' as const, toolName: 'lineage_first' } },
        { label: 'no tools allowed', choice: 'none' as const },
      ];

      for (const testCase of cases) {
        const built = harness.createPort({
          parts: [{ type: 'tool-call', callId: 'call-off', toolName: 'lineage_second', input: { id: 'x' } }],
        });
        const result = await built.port.generateToolTurn({
          messages: [new HumanMessage('choose')],
          tools,
          toolChoice: testCase.choice,
          phase: 'synthesis',
        });

        expect(result.status, testCase.label).toBe('completed');
        expect(result.toolCalls[0], testCase.label).toMatchObject({
          valid: false, code: 'unknown_tool',
        });
      }
    });

    it('spends no provider attempt when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const tool = harness.createPort({ parts: [{ type: 'text', text: 'never sent' }] });
      await expect(tool.port.generateToolTurn({
        messages: [new HumanMessage('run')],
        tools: [],
        signal: controller.signal,
        phase: 'discover',
      })).resolves.toEqual({ status: 'cancelled', content: [], text: '', toolCalls: [] });
      expect(tool.providerAttempts()).toBe(0);
      expect(tool.port.modelCalls).toBe(0);

      const structured = harness.createPort({ parts: [] });
      await expect(structured.port.generateStructured({
        messages: [new HumanMessage('classify')],
        schema: z.object({ entry: z.string() }).strict(),
        signal: controller.signal,
        phase: 'detect_entry',
      })).rejects.toMatchObject({ code: 'cancelled' });
      expect(structured.providerAttempts()).toBe(0);
      expect(structured.port.modelCalls).toBe(0);

      const text = harness.createPort({ parts: [] });
      await expect(text.port.completeText({
        messages: [new HumanMessage('compose')],
        signal: controller.signal,
        phase: 'compose',
      })).rejects.toMatchObject({ code: 'cancelled' });
      expect(text.providerAttempts()).toBe(0);
      expect(text.port.modelCalls).toBe(0);
    });

    it('reports the canonical finish reason and keeps content and tool calls consistently ordered', async () => {
      const schema = z.object({ id: z.string() }).strict();
      const withCalls = harness.createPort({
        parts: [
          { type: 'text', text: 'prose ' },
          { type: 'tool-call', callId: 'call-a', toolName: PRESENT, input: { id: 'a' } },
          { type: 'tool-call', callId: 'call-b', toolName: PRESENT, input: { id: 'b' } },
        ],
      });
      const generated = await withCalls.port.generateToolTurn({
        messages: [new HumanMessage('run')],
        tools: [toolDefinition(PRESENT, schema)],
        phase: 'synthesis',
      });

      expect(generated).toMatchObject({ status: 'completed', text: 'prose ', finishReason: 'tool-calls' });
      expect(generated.toolCalls.map((call) => call.callId)).toEqual(['call-a', 'call-b']);
      // `content` is the ordered transcript and `toolCalls` the call projection of it: every call in
      // one appears in the other, in the same order, or a downstream replay reorders the turn.
      expect(generated.content).toEqual([
        { type: 'text', text: 'prose ' },
        { type: 'tool-call', call: generated.toolCalls[0] },
        { type: 'tool-call', call: generated.toolCalls[1] },
      ]);

      const textOnly = harness.createPort({ parts: [{ type: 'text', text: 'answer' }] });
      await expect(textOnly.port.generateToolTurn({
        messages: [new HumanMessage('run')],
        tools: [toolDefinition(PRESENT, schema)],
        phase: 'synthesis',
      })).resolves.toMatchObject({
        status: 'completed', text: 'answer', toolCalls: [], finishReason: 'stop',
      });
    });

    it('classifies empty, schema-valid-empty, and repeated structured payloads', async () => {
      const empty = harness.createPort({
        parts: [{ type: 'tool-call', callId: 'call-empty', toolName: 'structured_output', input: {} }],
      });
      await expect(empty.port.generateStructured({
        messages: [new HumanMessage('classify')],
        schema: z.object({ entry: z.enum(['discovery']) }).strict(),
        phase: 'detect_entry',
      })).rejects.toMatchObject({ code: 'empty_structured_output' });

      // The same empty payload is a valid answer when the advertised schema asks for nothing —
      // emptiness is only a failure relative to what was required.
      const allowed = harness.createPort({
        parts: [{ type: 'tool-call', callId: 'call-empty-ok', toolName: 'structured_output', input: {} }],
      });
      await expect(allowed.port.generateStructured({
        messages: [new HumanMessage('empty is valid')],
        schema: z.object({}).strict(),
        phase: 'test',
      })).resolves.toEqual({});

      const repeated = harness.createPort({
        parts: [
          { type: 'tool-call', callId: 'call-1', toolName: 'structured_output', input: { entry: 'discovery' } },
          { type: 'tool-call', callId: 'call-2', toolName: 'structured_output', input: { entry: 'discovery' } },
        ],
      });
      await expect(repeated.port.generateStructured({
        messages: [new HumanMessage('classify')],
        schema: z.object({ entry: z.enum(['discovery']) }).strict(),
        phase: 'detect_entry',
      })).rejects.toMatchObject({ code: 'invalid_structured_output' });
    });

    it('returns joined text from a text completion and refuses one that carries a tool call', async () => {
      const text = harness.createPort({
        parts: [{ type: 'text', text: '  composed ' }, { type: 'text', text: 'answer  ' }],
      });
      await expect(text.port.completeText({
        messages: [new HumanMessage('compose')],
        phase: 'compose',
      })).resolves.toBe('composed answer');

      const withCall = harness.createPort({
        parts: [{ type: 'tool-call', callId: 'call-x', toolName: PRESENT, input: { id: 'x' } }],
      });
      await expect(withCall.port.completeText({
        messages: [new HumanMessage('compose')],
        phase: 'compose',
      })).rejects.toMatchObject({ code: 'unsupported_response' });
    });

    it('surfaces a request failure once on every entry point, without a second attempt', async () => {
      const tool = harness.createPort({ failure: 'request' });
      const failed = await tool.port.generateToolTurn({
        messages: [new HumanMessage('run')],
        tools: [],
        phase: 'discover',
      });
      expect(failed).toMatchObject({ status: 'error', content: [], text: '', toolCalls: [] });
      expect(failed.status === 'error' && failed.providerError.phase).toBe('discover');
      expect(tool.providerAttempts()).toBe(1);
      expect(tool.port.modelCalls).toBe(1);

      const structured = harness.createPort({ failure: 'request' });
      await expect(structured.port.generateStructured({
        messages: [new HumanMessage('classify')],
        schema: z.object({ entry: z.string() }).strict(),
        phase: 'detect_entry',
      })).rejects.toBeInstanceOf(Error);
      expect(structured.providerAttempts()).toBe(1);
      expect(structured.port.modelCalls).toBe(1);

      const text = harness.createPort({ failure: 'request' });
      await expect(text.port.completeText({
        messages: [new HumanMessage('compose')],
        phase: 'compose',
      })).rejects.toBeInstanceOf(Error);
      expect(text.providerAttempts()).toBe(1);
      expect(text.port.modelCalls).toBe(1);
    });

    it('surfaces a mid-response provider failure without replaying the request', async () => {
      const built = harness.createPort({ failure: 'mid-response' });
      await expect(built.port.generateToolTurn({
        messages: [new HumanMessage('stream')],
        tools: [],
        phase: 'discover',
      })).resolves.toMatchObject({ status: 'error' });
      expect(built.providerAttempts()).toBe(1);
      expect(built.port.modelCalls).toBe(1);
    });

    it('counts exactly one model call per generation across all three entry points', async () => {
      const built = harness.createPort({ parts: [{ type: 'text', text: 'answer' }] });
      expect(built.port.modelCalls).toBe(0);

      await built.port.generateToolTurn({
        messages: [new HumanMessage('one')], tools: [], phase: 'discover',
      });
      expect(built.port.modelCalls).toBe(1);
      await built.port.generateToolTurn({
        messages: [new HumanMessage('two')], tools: [], phase: 'discover',
      });
      expect(built.port.modelCalls).toBe(2);
      await built.port.completeText({ messages: [new HumanMessage('three')], phase: 'compose' });

      expect(built.port.modelCalls).toBe(3);
      expect(built.providerAttempts()).toBe(3);
    });
  });
}
