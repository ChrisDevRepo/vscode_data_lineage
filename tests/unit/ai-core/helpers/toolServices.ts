/**
 * Minimal `ToolServices` for driving a tool handler (typically `executeStartExploration`) without a
 * registry: a silent logger, the shipped turn budget, and a `logAndReturn` that records the payload.
 */
import type { ToolServices } from '../../../../src/ai/tools/handlers/toolServices';
import { DEFAULT_TURN_TOKEN_BUDGET, type TurnTokenBudget } from '../../../../src/ai/support/tokenBudget';
import type { SerializedFilterState } from '../../../../src/engine/shared/bridgeContract';

export interface StubToolServicesOptions {
  readonly session: unknown;
  readonly model: unknown;
  readonly graph: unknown;
  readonly activeFilter?: SerializedFilterState | Record<string, never>;
  readonly turnEpoch?: () => number;
  readonly budget?: TurnTokenBudget;
  readonly textModel?: unknown;
}

/** Builds the stub and a reader for the last payload the handler returned. */
export function stubToolServices(options: StubToolServicesOptions): {
  services: ToolServices;
  getReturned: () => Record<string, unknown>;
} {
  let returned: Record<string, unknown> = {};
  const services = {
    getSession: () => options.session,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    budget: options.budget ?? DEFAULT_TURN_TOKEN_BUDGET,
    textModel: options.textModel,
    turnEpoch: options.turnEpoch ?? (() => 1),
    requireModel: () => options.model,
    requireGraph: () => options.graph,
    buildActiveFilter: () => options.activeFilter ?? {},
    logAndReturn: (_tool: string, data: Record<string, unknown>) => {
      returned = data;
      return JSON.stringify(data);
    },
    toolError: (_tool: string, error: unknown) => { throw error; },
  } as unknown as ToolServices;
  return { services, getReturned: () => returned };
}
