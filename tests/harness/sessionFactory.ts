/**
 * Builds the `AiSession` a headless turn runs against, matching what a real model load leaves behind.
 *
 * @remarks
 * The dacpac→session chain itself is already proven vscode-free (tests/integration/scenario-matrix.ts
 * builds one the same way), but that suite reproduces only the three session-facing effects of
 * `applyModelToSession`. A live-provider measurement needs two more production behaviours that the
 * scripted lane can do without, and omitting either would silently change what the model is asked:
 *
 * - **`session.outputTemplates`.** Loaded at activation from `assets/aiOutputTemplates.yaml`
 *   (`loadAiOutputTemplates`, src/extensionRuntime.ts). They are the instructions that shape every
 *   synthesis section. A session left with `EMPTY_AI_TEMPLATES` answers a different question.
 * - **Token-budget calibration.** `lineageParticipant.ts` recalibrates both budgets per turn against
 *   the selected model's input window, so a small window shrinks discovery AND exploration with it.
 *   The window is a lane fact here (`contextWindow`) rather than provider metadata.
 *
 * Both are reproduced through the same production functions, never re-implemented.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAiOutputTemplatesYaml, parseParseRulesYaml, REQUIRED_AI_TEMPLATE_KEYS } from '../../src/configCore';
import { extractDacpac } from '../../src/engine/dacpacExtractor';
import { populateColumnStore } from '../../src/engine/modelBuilder';
import { loadRules } from '../../src/engine/sqlBodyParser';
import { buildBareGraph } from '../../src/ai/support/graphUtils';
import { AiSession } from '../../src/ai/session/session';
import { EMPTY_AI_TEMPLATES, type AiOutputTemplates } from '../../src/ai/session/types';
import {
  DEFAULT_DISCOVERY_NODE_CAP,
  DEFAULT_DISCOVERY_TOKEN_BUDGET,
  DEFAULT_EXPLORATION_NODE_CAP,
  DEFAULT_EXPLORATION_TOKEN_BUDGET,
  DISCOVERY_WINDOW_SHARE,
  EXPLORATION_WINDOW_SHARE,
  setExplorationNodeCap,
  setExplorationTokenBudget,
} from '../../src/ai/support/tokenBudget';
import { setDiscoveryNodeCap, setDiscoveryTokenBudget } from '../../src/ai/tools/tools';

/** Repository root, resolved from the compiled harness location (`out/test/tests/harness`). */
export function repoPath(...segments: string[]): string {
  return join(__dirname, '..', '..', '..', '..', ...segments);
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
 * Applies the participant's per-turn budget calibration for a lane of the given context window.
 *
 * @remarks
 * Mirrors src/ai/participant/lineageParticipant.ts. The configured ceilings arrive as the shipped
 * defaults because the headless shim answers `getConfiguration().get(key, default)` with that
 * default verbatim — reading them through the shim would produce the same numbers with more
 * indirection, so the constants are used directly and stay the single source of the ceiling.
 *
 * @param contextWindow - Model input window in tokens; `POSITIVE_INFINITY` when unknown.
 */
export function calibrateTokenBudgets(contextWindow: number): void {
  const window = contextWindow > 0 ? contextWindow : Number.POSITIVE_INFINITY;
  setDiscoveryNodeCap(DEFAULT_DISCOVERY_NODE_CAP);
  setDiscoveryTokenBudget(Math.min(
    DEFAULT_DISCOVERY_TOKEN_BUDGET,
    Math.floor(window * DISCOVERY_WINDOW_SHARE),
  ));
  setExplorationNodeCap(DEFAULT_EXPLORATION_NODE_CAP);
  setExplorationTokenBudget(Math.min(
    DEFAULT_EXPLORATION_TOKEN_BUDGET,
    Math.floor(window * EXPLORATION_WINDOW_SHARE),
  ));
}

/**
 * Builds one fully loaded session: parse rules, dacpac model, column store, bare graph, templates.
 *
 * @param options - Fixture paths and the lane's context window.
 * @returns A session in the state a completed model load leaves behind.
 */
export async function createHarnessSession(options: HarnessSessionOptions): Promise<AiSession> {
  const parseRulesPath = options.parseRulesPath ?? repoPath('assets', 'defaultParseRules.yaml');
  const dacpacPath = options.dacpacPath ?? repoPath('tests', 'fixtures', 'AdventureWorks2025_AI.dacpac');
  const templatesPath = options.outputTemplatesPath ?? repoPath('assets', 'aiOutputTemplates.yaml');

  // Rules FIRST: `parseSqlBody` recovers far fewer dependencies without them, so a graph built
  // before this call is merely smaller rather than wrong — the hardest kind of defect to notice.
  loadRules(parseParseRulesYaml(await readFile(parseRulesPath, 'utf8')));
  const buffer = await readFile(dacpacPath);
  const model = await extractDacpac(buffer);

  const session = new AiSession(await loadOutputTemplates(templatesPath));
  populateColumnStore(model, session.columnStore);
  session.model = model;
  session.graph = buildBareGraph(model);
  calibrateTokenBudgets(options.contextWindow);
  return session;
}
