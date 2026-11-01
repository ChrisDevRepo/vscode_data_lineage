/** Shared provider-neutral tool registry and dispatch seam. */
import type { z } from 'zod';

/**
 * VS Code-free registry shape for a tool; the executable `RegisteredTool` pairs it with a handler.
 */
export interface ToolDefinition {
  /** `snake_case` `verb_noun`, `lineage_`-prefixed, ≤64 chars — matches `package.json`. */
  readonly name: string;
  /** The single Zod source for this tool's model-facing JSON Schema AND runtime validation. */
  readonly inputSchema: z.ZodType;
  /** Applies context-owned held-field omissions after a phase resolves its full schema. */
  readonly projectInputSchema?: (schema: z.ZodType) => z.ZodType;
  /** Manifest tags (e.g. `lineage-presentation`) — carried for parity assertions. */
  readonly tags?: readonly string[];
  /** Concise description intended for user-facing host surfaces. */
  readonly userDescription?: string;
  /** Detailed model-facing selection guidance. */
  readonly modelDescription?: string;
  /**
   * Whether invoking the tool reads state or commits a transition; non-`'read'` effects run through
   * the write-serializing queue.
   */
  readonly effect?:
    | 'read'
    | 'scope_store'
    | 'session_start'
    | 'hop_commit'
    | 'presentation_commit';
  /** Short label shown while the tool executes; a tool without one emits no status update. */
  readonly progressLabel?: string;
}

/** A registered, executable tool: a {@link ToolDefinition} plus the bound handler. */
export interface RegisteredTool<O = unknown> extends ToolDefinition {
  /** Runs the tool with the raw, model-supplied input; handlers own validation. */
  execute(input: unknown): O | Promise<O>;
}

/** Provider-neutral tool dispatch + lookup surface. */
export interface IToolRegistry<O = unknown> {
  /** Registers a tool; throws on a duplicate name (drift/typo guard). */
  register(tool: RegisteredTool<O>): void;
  /**
   * Dispatches raw input with an optional provider call ID for trace correlation; throws if `name`
   * is unknown.
   */
  invoke(name: string, input: unknown, callId?: string): O | Promise<O>;
  getTools(): readonly RegisteredTool<O>[];
  /** Looks a tool up by name. */
  get(name: string): RegisteredTool<O> | undefined;
  /** Whether a tool is registered under `name`. */
  has(name: string): boolean;
}

/** Map-backed {@link IToolRegistry}. */
export class ToolRegistry<O = unknown> implements IToolRegistry<O> {
  private readonly tools = new Map<string, RegisteredTool<O>>();

  /** {@inheritDoc IToolRegistry.register} */
  public register(tool: RegisteredTool<O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(
        `ToolRegistry: duplicate tool registration for "${tool.name}"`,
      );
    }
    this.tools.set(tool.name, tool);
  }

  /** {@inheritDoc IToolRegistry.invoke} */
  public invoke(
    name: string,
    input: unknown,
    _callId?: string,
  ): O | Promise<O> {
    const tool = this.tools.get(name);
    if (!tool)
      throw new Error(`ToolRegistry: no tool registered under "${name}"`);
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

/** A read-only view of a registry restricted to an allowed tool-name set. */
export function filterRegistry<O>(
  reg: IToolRegistry<O>,
  allowed: ReadonlySet<string>,
): IToolRegistry<O> {
  const ensure = (name: string): void => {
    if (!allowed.has(name))
      throw new Error(`ToolRegistry: no tool registered under "${name}"`);
  };
  return {
    register: () => {
      throw new Error('filterRegistry: view is read-only');
    },
    invoke: (name, input, callId) => {
      ensure(name);
      return reg.invoke(name, input, callId);
    },
    getTools: () => reg.getTools().filter((t) => allowed.has(t.name)),
    get: (name) => (allowed.has(name) ? reg.get(name) : undefined),
    has: (name) => allowed.has(name) && reg.has(name),
  };
}

/** A registry view that also tracks every dispatch currently in flight. */
interface TrackedRegistry<O> {
  /** Delegating view; every `invoke()` through it is tracked until its promise settles. */
  readonly registry: IToolRegistry<O>;
  /** Resolves once every dispatch in flight at call time has settled (accepted or rejected). */
  settled(): Promise<void>;
}

/** Wraps a registry so the host turn boundary can await in-flight dispatch before it finalizes. */
export function trackInFlightDispatch<O>(
  reg: IToolRegistry<O>,
): TrackedRegistry<O> {
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
    settled: async () => {
      await Promise.allSettled([...inFlight]);
    },
  };
}

/**
 * Returns a read-only registry view whose provider schemas are resolved on every access; dispatch
 * stays with the backing registry.
 */
export function resolveRegistrySchemas<O>(
  reg: IToolRegistry<O>,
  resolvers: ReadonlyMap<string, () => z.ZodType>,
  overrides?: ReadonlyMap<string, z.ZodType>,
): IToolRegistry<O> {
  const projected = (tool: RegisteredTool<O>): RegisteredTool<O> => {
    const resolve = resolvers.get(tool.name);
    const override = overrides?.get(tool.name);
    if (!resolve && !override) return tool;
    return {
      ...tool,
      get inputSchema(): z.ZodType {
        const schema = resolve ? resolve() : override!;
        return tool.projectInputSchema?.(schema) ?? schema;
      },
    };
  };
  return {
    register: () => {
      throw new Error('resolveRegistrySchemas: view is read-only');
    },
    invoke: (name, input, callId) => reg.invoke(name, input, callId),
    getTools: () => reg.getTools().map(projected),
    get: (name) => {
      const tool = reg.get(name);
      return tool ? projected(tool) : undefined;
    },
    has: (name) => reg.has(name),
  };
}
