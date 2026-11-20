/**
 * Shared provider-neutral tool registry and dispatch seam. `IToolRegistry` is the single dispatch
 * surface and authoritative list of the AI tool catalog: the host builds one, binds each entry's
 * `execute` to its handler and registers its tools with VS Code, so no parallel array can drift. VS
 * Code-free and Map-backed, so it is unit-testable and usable from a model transport or a LangGraph
 * node; generic over the result `O` so the host can use `vscode.LanguageModelToolResult` without a
 * VS Code import here.
 */
import type { z } from 'zod';

/**
 * The VS Code-free registry shape for a tool. Canonical entries come from the richer `ToolContract`
 * catalog in `toolDefs.ts`; lightweight third-party/test entries may omit presentation metadata.
 * The executable `RegisteredTool` pairs this shape with a handler at registration.
 */
export interface ToolDefinition {
  /** `snake_case` `verb_noun`, `lineage_`-prefixed, ≤64 chars — matches `package.json`. */
  readonly name: string;
  /** The single Zod source for this tool's model-facing JSON Schema AND runtime validation. */
  readonly inputSchema: z.ZodType;
  /** Manifest tags (e.g. `lineage-presentation`) — carried for parity assertions. */
  readonly tags?: readonly string[];
  /** Concise description intended for user-facing host surfaces. */
  readonly userDescription?: string;
  /** Detailed model-facing selection guidance. */
  readonly modelDescription?: string;
  /**
   * Whether invoking the tool reads state or commits a lifecycle transition. Anything except
   * `'read'` runs through the write-serializing effect queue; `'scope_store'` exists because the
   * scope-bundle lookup also stores the discovery-scope artifact, so it must serialize with the
   * other session writers though the model perceives a read.
   */
  readonly effect?: 'read' | 'scope_store' | 'session_start' | 'hop_commit' | 'preview_commit' | 'presentation_commit';
  /**
   * Short user-facing label shown while the tool executes (e.g. "Searching database objects…"). A
   * registered tool that omits it emits no status update, leaving the previous status visible; only
   * unregistered tools fall back to a generic running label.
   */
  readonly progressLabel?: string;
}

/** A registered tool: a {@link ToolDefinition} plus its bound handler; `O` is the result type. */
export interface RegisteredTool<O = unknown> extends ToolDefinition {
  /**
   * Runs the tool with the raw, model-supplied input unchanged, so handler boundary validation and
   * policy guards stay authoritative and the registry adds no second validation path.
   */
  execute(input: unknown): O | Promise<O>;
}

/** Provider-neutral tool dispatch + lookup surface. */
export interface IToolRegistry<O = unknown> {
  /** Registers a tool; throws on a duplicate name (drift/typo guard). */
  register(tool: RegisteredTool<O>): void;
  /** Dispatches `name` with the raw input and returns the handler's result; throws if unknown. */
  invoke(name: string, input: unknown, callId?: string): O | Promise<O>;
  /** All registered tools, in registration order. */
  getTools(): readonly RegisteredTool<O>[];
  get(name: string): RegisteredTool<O> | undefined;
  has(name: string): boolean;
}

/** Map-backed {@link IToolRegistry}. */
export class ToolRegistry<O = unknown> implements IToolRegistry<O> {
  private readonly tools = new Map<string, RegisteredTool<O>>();

  /** {@inheritDoc IToolRegistry.register} */
  public register(tool: RegisteredTool<O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool registration for "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  /** {@inheritDoc IToolRegistry.invoke} */
  public invoke(name: string, input: unknown, _callId?: string): O | Promise<O> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`ToolRegistry: no tool registered under "${name}"`);
    return tool.execute(input);
  }

  /** {@inheritDoc IToolRegistry.getTools} */
  public getTools(): readonly RegisteredTool<O>[] {
    return [...this.tools.values()];
  }

  /** {@inheritDoc IToolRegistry.get} */
  public get(name: string): RegisteredTool<O> | undefined {
    return this.tools.get(name);
  }

  /** {@inheritDoc IToolRegistry.has} */
  public has(name: string): boolean {
    return this.tools.has(name);
  }

}

/**
 * A read-only view of a registry restricted to an allowed tool-name set, so the phase-aware host
 * loop exposes only the current phase's tools without mutating the registry. Lookup and dispatch
 * are filtered, so a phase-disallowed name fails as an unknown tool; the single dispatch surface is
 * preserved and `register` is disabled because the view is immutable.
 */
export function filterRegistry<O>(reg: IToolRegistry<O>, allowed: ReadonlySet<string>): IToolRegistry<O> {
  const ensure = (name: string): void => {
    if (!allowed.has(name)) throw new Error(`ToolRegistry: no tool registered under "${name}"`);
  };
  return {
    register: () => { throw new Error('filterRegistry: view is read-only'); },
    invoke: (name, input, callId) => { ensure(name); return reg.invoke(name, input, callId); },
    getTools: () => reg.getTools().filter((t) => allowed.has(t.name)),
    get: (name) => (allowed.has(name) ? reg.get(name) : undefined),
    has: (name) => allowed.has(name) && reg.has(name),
  };
}

/** A registry view that also tracks every dispatch currently in flight. */
export interface TrackedRegistry<O> {
  /** Delegating view; every `invoke()` through it is tracked until its promise settles. */
  readonly registry: IToolRegistry<O>;
  /** Resolves once every dispatch in flight at call time has settled (accepted or rejected). */
  settled(): Promise<void>;
}

/**
 * Wraps a registry so the host turn boundary can await in-flight dispatch before it finalizes.
 *
 * A LangGraph node's task promise is not awaited by `graph.invoke` once an external `AbortSignal`
 * wins the runner's internal race (`@langchain/langgraph` `pregel/runner.js`
 * `_executeTasksWithRetry`): the node, and any `registry.invoke()` it awaits, keeps running after
 * `graph.invoke` rejected, so a host closing the turn on that rejection (releasing the lease,
 * finalizing state) races the tool's effect. Every phase's tool call goes through this view
 * ({@link IToolRegistry.invoke}), so tracking here covers every mutating tool without a second
 * dispatch path.
 *
 * @returns The tracked view plus the settle-await the host calls before finalizing a turn.
 */
export function trackInFlightDispatch<O>(reg: IToolRegistry<O>): TrackedRegistry<O> {
  const inFlight = new Set<Promise<unknown>>();
  const registry: IToolRegistry<O> = {
    register: (tool) => reg.register(tool),
    invoke: (name, input, callId) => {
      const call = Promise.resolve(reg.invoke(name, input, callId));
      inFlight.add(call);
      call.catch(() => undefined).finally(() => inFlight.delete(call));
      return call;
    },
    getTools: () => reg.getTools(),
    get: (name) => reg.get(name),
    has: (name) => reg.has(name),
  };
  return {
    registry,
    settled: async () => { await Promise.allSettled([...inFlight]); },
  };
}

/** Returns a read-only registry view with provider schemas replaced for selected visible tools. */
export function overrideRegistrySchemas<O>(
  reg: IToolRegistry<O>,
  overrides: ReadonlyMap<string, z.ZodType>,
): IToolRegistry<O> {
  return resolveRegistrySchemas(
    reg,
    new Map([...overrides].map(([name, schema]) => [name, () => schema])),
  );
}

/**
 * Returns a read-only registry view whose selected provider schemas are resolved on every access:
 * the projection seam for runtime facts resolved immediately before one model generation. Dispatch
 * stays delegated to the unchanged backing registry.
 */
export function resolveRegistrySchemas<O>(
  reg: IToolRegistry<O>,
  resolvers: ReadonlyMap<string, () => z.ZodType>,
): IToolRegistry<O> {
  const projected = (tool: RegisteredTool<O>): RegisteredTool<O> => {
    const resolve = resolvers.get(tool.name);
    if (!resolve) return tool;
    return {
      ...tool,
      get inputSchema(): z.ZodType { return resolve(); },
    };
  };
  return {
    register: () => { throw new Error('resolveRegistrySchemas: view is read-only'); },
    invoke: (name, input, callId) => reg.invoke(name, input, callId),
    getTools: () => reg.getTools().map(projected),
    get: (name) => {
      const tool = reg.get(name);
      return tool ? projected(tool) : undefined;
    },
    has: (name) => reg.has(name),
  };
}
