/** Loads public DACPAC data and production parse rules/templates into a headless runtime session. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAiOutputTemplatesYaml, parseParseRulesYaml, REQUIRED_AI_TEMPLATE_KEYS } from '../../src/configCore';
import { extractDacpac } from '../../src/engine/dacpacExtractor';
import { populateColumnStore } from '../../src/engine/modelBuilder';
import { loadRules } from '../../src/engine/sqlBodyParser';
import { buildBareGraph } from '../../src/ai/support/graphUtils';
import { AiSession } from '../../src/ai/session/session';
import { EMPTY_AI_TEMPLATES, type AiOutputTemplates } from '../../src/ai/session/types';
import * as tokenBudgetModule from '../../src/ai/support/tokenBudget';
import {
  DEFAULT_DISCOVERY_NODE_CAP,
  DEFAULT_DISCOVERY_TOKEN_BUDGET,
  DISCOVERY_WINDOW_SHARE,
  type TurnTokenBudget,
} from '../../src/ai/support/tokenBudget';

/** Ceilings a pinned pre-admission tree read; the current tree has no token axis. */
const LEGACY_EXPLORATION_TOKEN_BUDGET = 80_000;
const LEGACY_EXPLORATION_WINDOW_SHARE = 0.5;

/** Repository root: launchers run with the repository as their working directory. */
export function repoPath(...segments: string[]): string {
  return join(process.cwd(), ...segments);
}

/** Inputs for one headless session; every path defaults to the tracked fixture/asset. */
export interface HarnessSessionOptions {
  /** Absolute path of the dacpac to load. */
  readonly dacpacPath?: string;
  /** Parse rules applied before extraction; without them the recovered edge count drops sharply. */
  readonly parseRulesPath?: string;
  readonly outputTemplatesPath?: string;
  /**
   * The lane model's input window, in tokens.
   *
   * @remarks
   * Drives the same calibration `lineageParticipant.ts` performs from `request.model.maxInputTokens`.
   * A lane that does not know its window passes `Number.POSITIVE_INFINITY`, which leaves both
   * configured ceilings untouched — the participant's behaviour for a model that reports none.
   */
  readonly contextWindow: number;
  /**
   * Injection-probe payloads: appended to the stored DDL of the named node after
   * {@link populateColumnStore} runs, so the hop loop's `store.getDdl` read (`src/ai/sm/smBase.ts`)
   * returns the tampered body — the same channel `<hop_context>` carries to the model, behind the
   * untrusted-content banner in `src/ai/agent/stagePrompts.ts`.
   */
  readonly ddlOverrides?: ReadonlyArray<{ readonly nodeId: string; readonly appendComment: string }>;
}

/**
 * Loads the tracked output templates exactly as activation does.
 *
 * @remarks
 * Same parser, same required-key projection, same "skip a key whose `instruction` is missing"
 * behaviour — only the VS Code file API and the user-overlay setting are left out, because a headless
 * lane has neither.
 */
async function loadOutputTemplates(path: string): Promise<AiOutputTemplates> {
  const templates: AiOutputTemplates = { ...EMPTY_AI_TEMPLATES };
  const parsed = parseAiOutputTemplatesYaml(await readFile(path, 'utf8'));
  for (const key of REQUIRED_AI_TEMPLATE_KEYS) {
    const instruction = parsed?.[key]?.instruction;
    if (typeof instruction === 'string' && instruction) templates[key] = instruction.trim();
  }
  return templates;
}

/**
 * Builds the participant's per-turn budget calibration for a lane of the given context window.
 *
 * @remarks
 * Mirrors src/ai/participant/lineageParticipant.ts. The configured ceilings arrive as the shipped
 * defaults because the headless shim answers `getConfiguration().get(key, default)` with that
 * default verbatim — reading them through the shim would produce the same numbers with more
 * indirection, so the constants are used directly and stay the single source of the ceiling.
 * The harness never learns a model window from its lanes, so — as before this returned a value —
 * `modelWindowTokens` is left unset and resolves to `Infinity` via `createTurnTokenBudget`.
 *
 * @param contextWindow - Model input window in tokens; `POSITIVE_INFINITY` when unknown.
 * @returns The frozen budget the turn's model port carries.
 */
export function calibrateTokenBudgets(contextWindow: number): TurnTokenBudget {
  const window = contextWindow > 0 ? contextWindow : Number.POSITIVE_INFINITY;
  const settings = {
    discoveryNodeCap: DEFAULT_DISCOVERY_NODE_CAP,
    discoveryTokenBudget: Math.min(
      DEFAULT_DISCOVERY_TOKEN_BUDGET,
      Math.floor(window * DISCOVERY_WINDOW_SHARE),
    ),
  };
  if (typeof tokenBudgetModule.createTurnTokenBudget === 'function') {
    return tokenBudgetModule.createTurnTokenBudget(settings);
  }
  // A pinned tree that predates the per-turn budget object (`main` `20356737e`) calibrates the
  // module-level ceilings instead, exactly as its lineageParticipant.ts did; its engine never reads
  // a port budget, so none is returned.
  const legacy = tokenBudgetModule as unknown as Record<
    'setDiscoveryNodeCap' | 'setDiscoveryTokenBudget' | 'setExplorationTokenBudget',
    (value: number) => void
  >;
  legacy.setDiscoveryNodeCap(settings.discoveryNodeCap);
  legacy.setDiscoveryTokenBudget(settings.discoveryTokenBudget);
  legacy.setExplorationTokenBudget(Math.min(LEGACY_EXPLORATION_TOKEN_BUDGET, Math.floor(window * LEGACY_EXPLORATION_WINDOW_SHARE)));
  return undefined as unknown as TurnTokenBudget;
}

/** A fully loaded harness session plus the token budget calibrated for its lane. */
export interface HarnessSession {
  /** A session in the state a completed model load leaves behind. */
  readonly session: AiSession;
  /** The turn budget the caller's model port must carry ({@link calibrateTokenBudgets}). */
  readonly budget: TurnTokenBudget;
}

/**
 * Builds one fully loaded session: parse rules, dacpac model, column store, bare graph, templates.
 *
 * @param options - Fixture paths and the lane's context window.
 * @returns The session and the budget calibrated for it.
 */
export async function createHarnessSession(options: HarnessSessionOptions): Promise<HarnessSession> {
  const parseRulesPath = options.parseRulesPath ?? repoPath('assets', 'defaultParseRules.yaml');
  const dacpacPath = options.dacpacPath ?? repoPath('assets', 'demo.dacpac');
  const templatesPath = options.outputTemplatesPath ?? repoPath('assets', 'aiOutputTemplates.yaml');

  // Rules FIRST: `parseSqlBody` recovers far fewer dependencies without them, so a graph built
  // before this call is merely smaller rather than wrong — the hardest kind of defect to notice.
  loadRules(parseParseRulesYaml(await readFile(parseRulesPath, 'utf8')));
  const buffer = await readFile(dacpacPath);
  const model = await extractDacpac(buffer);

  const session = new AiSession(await loadOutputTemplates(templatesPath));
  populateColumnStore(model, session.columnStore);
  for (const override of options.ddlOverrides ?? []) {
    const existing = session.columnStore.getDdl(override.nodeId)
      ?? model.nodes.find(n => n.id === override.nodeId)?.bodyScript;
    if (existing === undefined) {
      throw new Error(`ddlOverrides: unknown node id "${override.nodeId}"`);
    }
    session.columnStore.setDdl(override.nodeId, `${existing}\n${override.appendComment}\n`);
  }
  session.model = model;
  session.graph = buildBareGraph(model);
  const budget = calibrateTokenBudgets(options.contextWindow);
  return { session, budget };
}
