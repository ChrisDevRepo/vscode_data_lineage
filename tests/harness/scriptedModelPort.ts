/** Provider-neutral scripted fixture for deterministic production runtime contracts. */
import { z } from 'zod';
import {
  ToolRegistry,
  type IToolRegistry,
  type RegisteredTool,
} from '../../src/ai/tools/registry';
import type {
  CompleteTextInput,
  GeneratedToolCall,
  InvalidGeneratedToolCall,
  ModelIdentity,
  SingleGenerationModelPort,
  ToolGenerationInput,
  ToolGenerationResult,
  ValidGeneratedToolCall,
} from '../../src/ai/model/modelPort';
import type { ProviderErrorDiagnostic } from '../../src/ai/support/text';
import { StructuredOutputError } from '../../src/ai/providers/structuredOutput';
import {
  DEFAULT_TURN_TOKEN_BUDGET,
  estimateTokens,
  type TurnTokenBudget,
} from '../../src/ai/support/tokenBudget';
import { messageContentToText, modelToolCallMessage } from '../../src/ai/model/modelPort';
import type { MessageContent } from '@langchain/core/messages';

/** One queued provider generation replayed by {@link ScriptedModelPort} in script order. */
export interface ScriptedGeneration {
  /** Terminal provider status; defaults to `'completed'`. */
  readonly status?: 'completed' | 'cancelled' | 'error';
  /** Aggregate prose returned by the generation. */
  readonly text?: string;
  /** Ordered validated/rejected tool calls the provider emitted. */
  readonly toolCalls?: readonly GeneratedToolCall[];
  /** Raw provider finish reason; defaults to a clean `'stop'`/`'tool-calls'`. */
  readonly finishReason?: string;
  /** Incremental deltas pushed through `onTextDelta` when the caller subscribed. */
  readonly textDeltas?: readonly string[];
  /** User-safe error text for a `'error'` generation. */
  readonly error?: string;
  /** Sanitized diagnostic for a `'error'` generation. */
  readonly providerError?: ProviderErrorDiagnostic;
  /** Opaque provider stream parts the generation carried (reasoning, signatures). */
  readonly providerParts?: readonly unknown[];
}

const SCRIPTED_IDENTITY: ModelIdentity = {
  id: 'scripted-test-model',
  name: 'Scripted Test Model',
  vendor: 'test',
  family: 'scripted',
  version: '1',
};

/**
 * Replays a fixed queue of generations through the one-generation model-port contract.
 *
 * @remarks
 * Every request is retained on {@link requests} so a test can assert exactly which messages,
 * tool definitions, tool choice, and instruction context the graph projected onto the provider —
 * this is the surface that proves what a retry attempt does and does not replay.
 */
export class ScriptedModelPort implements SingleGenerationModelPort {
  public readonly id = 'scripted-test-port';
  public readonly identity: ModelIdentity = SCRIPTED_IDENTITY;
  /** Every request received, in call order. */
  public readonly requests: ToolGenerationInput[] = [];
  private calls = 0;
  private textCalls = 0;

  /** Queued parsed payloads replayed by `generateStructured` (structured classification calls). */
  private readonly structuredScript: readonly unknown[];
  private structuredCalls = 0;

  public constructor(
    private readonly script: readonly ScriptedGeneration[],
    /** Queued replies for `completeText` — the discovery-summary compose round, not tool-turn generation. */
    private readonly textScript: readonly string[] = [],
    /** Queued parsed payloads for `generateStructured` — structured classification calls; an `Error` entry is thrown instead of parsed. */
    structuredScript: readonly unknown[] = [],
    /** Budget this scripted turn runs under; the shipped defaults unless a case sizes them. */
    public readonly budget: TurnTokenBudget = DEFAULT_TURN_TOKEN_BUDGET,
  ) {
    this.structuredScript = structuredScript;
  }

  /** Structured generations requested so far, failed ones included. */
  public get structuredCallCount(): number {
    return this.structuredCalls;
  }

  /** {@inheritDoc SingleGenerationModelPort.modelCalls} */
  public get modelCalls(): number {
    return this.calls;
  }

  /** Deterministic stand-in for a provider counter — LangChain's own chars/4 approximation, so a test can predict trim boundaries. */
  public async getNumTokens(content: MessageContent): Promise<number> {
    return estimateTokens(messageContentToText(content).length);
  }

  /** Replays the next queued text-only reply, standing in for `ModelPort.completeText`. */
  public async completeText(_input: CompleteTextInput): Promise<string> {
    const reply = this.textScript[this.textCalls];
    this.textCalls += 1;
    if (reply === undefined) {
      throw new Error(`ScriptedModelPort: no completeText reply scripted for call #${this.textCalls}`);
    }
    return reply;
  }

  /** Unused by the discovery-summary compose round this double supports; present only to satisfy `ModelPort`. */
  public async generateStructured<T>(input: { schema: z.ZodType<T> }): Promise<T> {
    const reply = this.structuredScript[this.structuredCalls];
    this.structuredCalls += 1;
    if (reply === undefined) {
      throw new Error(`ScriptedModelPort: no structured reply scripted for call #${this.structuredCalls}`);
    }
    // A scripted Error is thrown as the model port would: the provider failed instead of answering.
    if (reply instanceof Error) throw reply;
    const parsed = input.schema.safeParse(reply);
    if (!parsed.success) {
      throw new StructuredOutputError(
        `scripted structured reply failed schema: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    }
    return parsed.data;
  }

  /** Replays the next queued generation, incrementing the physical-call counter exactly once. */
  public async generateToolTurn(input: ToolGenerationInput): Promise<ToolGenerationResult> {
    const step = this.script[this.calls];
    this.calls += 1;
    this.requests.push(input);
    if (!step) {
      throw new Error(`ScriptedModelPort: no generation scripted for provider call #${this.calls}`);
    }
    if (input.onTextDelta) {
      for (const delta of step.textDeltas ?? []) input.onTextDelta(delta);
    }
    if (step.status === 'cancelled') {
      return { status: 'cancelled', content: [], text: '', toolCalls: [] };
    }
    if (step.status === 'error') {
      return {
        status: 'error',
        content: [],
        text: '',
        toolCalls: [],
        error: step.error ?? 'scripted provider error',
        providerError: step.providerError ?? {
          phase: input.phase,
          name: 'Error',
          message: step.error ?? 'scripted provider error',
        },
      };
    }
    const toolCalls = step.toolCalls ?? [];
    const text = step.text ?? '';
    return {
      status: 'completed',
      message: modelToolCallMessage(
        toolCalls.map((call) => ({
          callId: call.callId,
          toolName: call.toolName,
          input: call.input !== null && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : {},
        })),
        text,
        step.providerParts,
      ),
      content: [],
      text,
      toolCalls,
      finishReason: step.finishReason ?? (toolCalls.length > 0 ? 'tool-calls' : 'stop'),
    };
  }
}

/** Builds a schema-valid provider tool call that reaches registry dispatch. */
export function validCall(callId: string, toolName: string, input: unknown): ValidGeneratedToolCall {
  return { valid: true, callId, toolName, input };
}

/** Builds a provider call rejected before dispatch, mirroring SDK prevalidation output. */
export function invalidCall(
  callId: string,
  toolName: string,
  code: InvalidGeneratedToolCall['code'],
  reason: string,
  issuePaths?: readonly string[],
): InvalidGeneratedToolCall {
  return {
    valid: false,
    callId,
    toolName,
    code,
    reason,
    ...(issuePaths ? { issuePaths } : {}),
  };
}

/** One dispatch observed by {@link scriptedRegistry}. */
export interface RecordedInvocation {
  readonly toolName: string;
  readonly input: unknown;
}

/** Declarative registry entry: a fixed result string, or one derived from the dispatched input. */
export interface ScriptedTool {
  readonly name: string;
  /** Canonical JSON result text the handler returns, or a function of the dispatched input. */
  readonly result: string | ((input: unknown) => string);
  readonly progressLabel?: string;
  readonly effect?: RegisteredTool<string>['effect'];
  /** Thrown instead of returning, to exercise the dispatcher's failure envelope. */
  readonly thrown?: unknown;
}

/**
 * Builds a real {@link ToolRegistry} whose handlers are scripted and whose dispatches are recorded.
 *
 * @remarks
 * The production registry is used unchanged so lookup, duplicate-name guarding, and dispatch stay
 * authoritative; only the bound handlers are test-owned.
 * @param tools - Ordered tool entries to register.
 * @returns The registry plus the live ordered dispatch log.
 */
export function scriptedRegistry(tools: readonly ScriptedTool[]): {
  registry: IToolRegistry<string>;
  invocations: RecordedInvocation[];
} {
  const registry = new ToolRegistry<string>();
  const invocations: RecordedInvocation[] = [];
  for (const tool of tools) {
    const registered: RegisteredTool<string> = {
      name: tool.name,
      inputSchema: z.object({}).passthrough(),
      modelDescription: `Scripted ${tool.name}`,
      ...(tool.progressLabel ? { progressLabel: tool.progressLabel } : {}),
      ...(tool.effect ? { effect: tool.effect } : {}),
      execute: (input: unknown): string => {
        invocations.push({ toolName: tool.name, input });
        if (tool.thrown !== undefined) throw tool.thrown;
        return typeof tool.result === 'function' ? tool.result(input) : tool.result;
      },
    };
    registry.register(registered);
  }
  return { registry, invocations };
}
