/**
 * The real-model lane table, its environment resolution, and its startup validation.
 *
 * @remarks
 * A lane is one provider endpoint the harness can run the production pipeline against. Three exist
 * and all three speak the same OpenAI-compatible `/chat/completions` protocol (DD-2), so a run on
 * one lane produces a trace diffable against a run on another.
 *
 * Two rules shape this module:
 *
 * - **Configuration is validated at startup, never at request time.** The user's `.env` must never
 *   need manual inspection to explain a failed run: a base URL carrying a `/chat/completions` or
 *   `/responses` suffix is a *configuration error* naming the offending variable, raised before the
 *   first request, not a `404` five minutes into a measurement.
 * - **No environment value is ever printed.** Every message names the variable; none quotes what it
 *   contains. That holds for the API key (obviously) and for the base URL (a Foundry resource name
 *   is not committed and should not be echoed into a log either).
 *
 * A lane whose key is absent self-skips rather than failing: the harness is a developer tool run on
 * machines that have credentials for some lanes and not others, and a hard failure there would make
 * `npm run gate` machine-dependent. All three lanes require a key — including `local-mlx`, whose
 * server is key-protected and receives it as a Bearer header exactly like the hosted lanes.
 */
import type { OpenAiCompatiblePortConfig, OpenAiRequestTuning } from './openAiCompatiblePort';

/** Every lane the harness knows. */
export const LANE_IDS = ['azure-foundry', 'openrouter', 'local-mlx'] as const;

/** One of {@link LANE_IDS}. */
export type LaneId = typeof LANE_IDS[number];

/** Static lane declaration; everything overridable arrives from the environment. */
export interface LaneDefinition {
  readonly id: LaneId;
  /**
   * API root **including the version prefix and nothing after it**, or `undefined` when the lane
   * has no committable default (Azure Foundry: the resource name is customer-specific).
   */
  readonly defaultBaseUrl?: string;
  readonly defaultModel: string;
  /** Input window used for the participant's token-budget calibration. */
  readonly contextWindow: number;
  readonly requestTimeoutMs: number;
  readonly capabilities: {
    readonly echoReasoning: boolean;
    readonly nativeToolCalling: boolean;
  };
  /** Whether the lane's model ids are namespaced `vendor/model`; a bare id is warned about. */
  readonly vendorPrefixedModels: boolean;
  /** Provider-specific request-body tuning; recorded verbatim in a verbose trace's provider-raw. */
  readonly requestTuning?: OpenAiRequestTuning;
}

/**
 * The lane table.
 *
 * @remarks
 * `openrouter` sets `echoReasoning` because its DeepSeek routes answer `500` when a prior assistant
 * turn returns without its `reasoning_content` (DD-3). Neither hosted lane's model id is pinned to a
 * specific snapshot here — `LINEAGE_<LANE>_MODEL` overrides it, and pinning a snapshot in tracked
 * code would silently expire.
 *
 * `openrouter` deliberately declares NO request tuning, after measurement (2026-08-07, T6 ×6):
 * `provider: {sort: 'throughput'}` routed every run to a backend (CoreWeave) that was ~10x faster
 * per generation but consistently unable to repair a strict-schema rejection (the same over-length
 * `badge_label` re-sent until the 3-failure semantic budget stopped the turn) — at every reasoning
 * level, including the model default. Default price-weighted routing (DeepInfra) was slower
 * (30–182s/hop, once tripping the 15-minute watchdog on a `depth="all"` plan) but repaired the
 * identical mistake in one retry, both times. A lane default must not distort the model behavior
 * the harness exists to measure; the `requestTuning` seam stays for explicit experiments only.
 */
export const LANES: Readonly<Record<LaneId, LaneDefinition>> = {
  'azure-foundry': {
    id: 'azure-foundry',
    defaultModel: 'gpt-4.1',
    contextWindow: 128_000,
    requestTimeoutMs: 300_000,
    capabilities: { echoReasoning: false, nativeToolCalling: true },
    vendorPrefixedModels: false,
  },
  openrouter: {
    id: 'openrouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    contextWindow: 64_000,
    requestTimeoutMs: 300_000,
    capabilities: { echoReasoning: true, nativeToolCalling: true },
    vendorPrefixedModels: true,
  },
  'local-mlx': {
    id: 'local-mlx',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    defaultModel: 'local-model',
    contextWindow: 32_000,
    requestTimeoutMs: 300_000,
    capabilities: { echoReasoning: false, nativeToolCalling: true },
    vendorPrefixedModels: false,
  },
};

/** A resolved lane: exactly a port configuration, plus what the caller needs beyond the port. */
export interface ResolvedLane extends OpenAiCompatiblePortConfig {
  readonly laneId: LaneId;
  readonly contextWindow: number;
}

/**
 * The outcome of resolving one lane against the environment.
 *
 * @remarks
 * Three states, three exit codes: `ready` runs, `skipped` exits `0` (the lane is simply not
 * configured on this machine), `config-error` exits `4` (the lane IS configured, incorrectly).
 * Never collapse skip into error — a machine without OpenRouter credentials must still be able to
 * run the gate.
 */
export type LaneResolution =
  | {
      readonly status: 'ready';
      readonly lane: ResolvedLane;
      /** Non-fatal configuration observations, already formatted for printing. */
      readonly warnings: readonly string[];
    }
  | {
      readonly status: 'skipped';
      readonly laneId: LaneId;
      /** Machine-readable cause, e.g. `missing-env:LINEAGE_OPENROUTER_API_KEY`. */
      readonly reason: string;
      /** The exact line the CLI prints, per the self-skip contract. */
      readonly message: string;
    }
  | {
      readonly status: 'config-error';
      readonly laneId: LaneId;
      /** Actionable message naming the offending variable — never its value. */
      readonly message: string;
    };

/** Environment variable names one lane reads. */
export interface LaneEnvNames {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** The `LINEAGE_<LANE>_*` variable names for a lane. */
export function laneEnvNames(id: LaneId): LaneEnvNames {
  const prefix = `LINEAGE_${id.replace(/-/g, '_').toUpperCase()}`;
  return {
    apiKey: `${prefix}_API_KEY`,
    baseUrl: `${prefix}_BASE_URL`,
    model: `${prefix}_MODEL`,
  };
}

/** Whether a string names a lane in {@link LANES}. */
export function isLaneId(value: string): value is LaneId {
  return (LANE_IDS as readonly string[]).includes(value);
}

/** Endpoint path suffixes that mean the variable holds a full endpoint rather than the API root. */
const ENDPOINT_SUFFIXES = ['/chat/completions', '/responses', '/completions'];

/**
 * Resolves one lane from the environment and validates it before anything can be sent.
 *
 * @param id - Lane to resolve.
 * @param env - Environment to read; defaults to `process.env`.
 * @returns A ready lane, a self-skip, or a configuration error. Never throws.
 */
export function resolveLane(
  id: LaneId,
  env: Record<string, string | undefined> = process.env,
): LaneResolution {
  const definition = LANES[id];
  const names = laneEnvNames(id);

  const apiKey = trimmed(env[names.apiKey]);
  if (!apiKey) return skip(id, `missing-env:${names.apiKey}`);

  const baseUrl = trimmed(env[names.baseUrl]) ?? definition.defaultBaseUrl;
  if (!baseUrl) {
    // Azure Foundry only: the resource name is customer-specific and is never committed, so an
    // unset base URL means the lane is not configured here — the same situation as a missing key.
    return skip(id, `missing-env:${names.baseUrl}`);
  }

  const urlProblem = validateBaseUrl(baseUrl, names.baseUrl);
  if (urlProblem) return { status: 'config-error', laneId: id, message: urlProblem };

  if (!definition.capabilities.nativeToolCalling) {
    return {
      status: 'config-error',
      laneId: id,
      message: `[e2e] CONFIG lane=${id}: nativeToolCalling is false; the lineage runtime requires native tool calling and never falls back.`,
    };
  }

  const model = trimmed(env[names.model]) ?? definition.defaultModel;
  const warnings: string[] = [];
  if (definition.vendorPrefixedModels && !/^[^/\s]+\/[^/\s]+/.test(model)) {
    // A warning, not an error: a private or proxied deployment may legitimately use a bare id, and
    // refusing it would make the lane unusable for exactly the setups the harness should support.
    warnings.push(
      `[e2e] WARN lane=${id}: ${names.model} is not vendor-prefixed (expected \`vendor/model\`); the provider may not route it.`,
    );
  }

  return {
    status: 'ready',
    warnings,
    lane: {
      laneId: id,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      apiKey,
      requestTimeoutMs: definition.requestTimeoutMs,
      capabilities: {
        echoReasoning: definition.capabilities.echoReasoning,
        nativeToolCalling: definition.capabilities.nativeToolCalling,
      },
      ...(definition.requestTuning ? { requestTuning: definition.requestTuning } : {}),
      contextWindow: definition.contextWindow,
    },
  };
}

/** The one line a caller prints for a lane it cannot run; presence of a key is never implied. */
function skip(id: LaneId, reason: string): LaneResolution {
  return {
    status: 'skipped',
    laneId: id,
    reason,
    message: `[e2e] SKIP lane=${id} reason=${reason}`,
  };
}

/**
 * Validates a base URL as an http(s) API root.
 *
 * @returns An actionable message naming `variable`, or `null` when the URL is usable.
 */
function validateBaseUrl(baseUrl: string, variable: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return `[e2e] CONFIG ${variable} is not a valid URL. Set it to the API root, for example https://openrouter.ai/api/v1 (value not shown).`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `[e2e] CONFIG ${variable} must use http or https.`;
  }
  if (parsed.search || parsed.hash) {
    return `[e2e] CONFIG ${variable} must be a bare API root without a query string or fragment.`;
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (path.endsWith(suffix)) {
      return `[e2e] CONFIG ${variable} must be the API root, not a full endpoint: remove the trailing ${suffix} (the port appends /chat/completions itself).`;
    }
  }
  return null;
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}
