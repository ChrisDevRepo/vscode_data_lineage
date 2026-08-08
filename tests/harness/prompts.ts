/**
 * The named prompt registry every real-model run is launched from.
 *
 * @remarks
 * A measurement is only comparable across runs, lanes and dates if the input text is byte-identical,
 * so the prompts live here as frozen constants rather than being retyped on a command line. Two
 * families are registered and they answer different questions:
 *
 * - **P1–P3, the quality baseline.** The three prompts the AI quality loop scores answer quality
 *   against a DDL-verified golden target. **RECONSTRUCTED (2026-08-07):** the verbatim originals were
 *   kept in `tmp/baseline/` on a machine this repository no longer has, and that directory does not
 *   exist here. These texts are expanded from the abbreviated forms recorded in the quality skill's
 *   prompt table and are **frozen from this point on** — the baseline is declared reset, and any
 *   later edit invalidates every cross-run comparison made against it. Treat a change here as an
 *   `ai-change-guard` change, not an ordinary edit.
 * - **T1–T7, the scenario matrix.** The same seven scenarios the scripted Extension Development Host
 *   lane pins (`tests/integration/scenario-matrix.test.ts`, driven by the fixture provider's
 *   `DEFAULT_CASES`). The texts are the scenario suite's own, verbatim, so the two lanes ask the
 *   model the same question. The difference is what is being measured: the scripted lane pins the
 *   answer and checks the runtime, whereas here the prompt is the ONLY thing pinned — a real model
 *   decides the route, and the run records what it decided. A T-run whose model picks a different
 *   tool than `DEFAULT_CASES` scripts is therefore a finding about the model or the prompt, never a
 *   test failure.
 *
 * Free text is always allowed (`--prompt "…"`); it is recorded with `source: 'free-text'` so a
 * summary can never be mistaken for a registry run.
 */

/** How a prompt reached the run: a frozen registry entry, or text typed on the command line. */
export type PromptSource = 'registry' | 'free-text';

/** One frozen, named prompt. */
export interface PromptDefinition {
  readonly id: string;
  /** The exact text sent as the user turn. */
  readonly text: string;
  /** `baseline` = the P-series quality baseline; `scenario` = the T-series matrix. */
  readonly family: 'baseline' | 'scenario';
  /** What this prompt is meant to exercise, for the `--list-prompts` output and run.json. */
  readonly intent: string;
}

/** A prompt as one run will use it. */
export interface ResolvedPrompt {
  readonly id: string;
  readonly text: string;
  readonly source: PromptSource;
}

function definition(
  id: string,
  family: PromptDefinition['family'],
  intent: string,
  text: string,
): PromptDefinition {
  return { id, family, intent, text };
}

/**
 * The registry.
 *
 * @remarks
 * Insertion order is display order. Every entry's `text` is load-bearing: see the module note on
 * the P-series reconstruction before changing one.
 */
export const PROMPTS: Readonly<Record<string, PromptDefinition>> = {
  // ── P1–P3: RECONSTRUCTED quality baseline, frozen 2026-08-07 ────────────────────────────────
  P1: definition(
    'P1',
    'baseline',
    'discovery, no gate, technical classification; bounded one level downstream',
    'Show me everything upstream from [ai].[spImportOrders], all levels up and one level down.',
  ),
  P2: definition(
    'P2',
    'baseline',
    'state machine / business blueprint, one consent gate, business classification',
    'Review [ai].[FactSalesReport]: what sources does it draw on, and explain the business logic behind them.',
  ),
  P3: definition(
    'P3',
    'baseline',
    'state machine / column trace, one consent gate, business classification',
    'Trace [TotalRevenue] in [ai].[FactSalesReport] back to its raw sources.',
  ),

  // ── T1–T7: scenario matrix, texts shared verbatim with the scripted EDH lane ────────────────
  T1: definition(
    'T1',
    'scenario',
    'discovery — expects lineage_get_context',
    'Summarise what this loaded snapshot contains before I dig in.',
  ),
  T2: definition(
    'T2',
    'scenario',
    'discovery — expects lineage_search_objects over the ai schema',
    'List the objects that live in the ai schema.',
  ),
  T3: definition(
    'T3',
    'scenario',
    'discovery — expects lineage_search_ddl for "raworderimport"',
    'Which object definitions mention raworderimport?',
  ),
  T4: definition(
    'T4',
    'scenario',
    'discovery — expects a bounded scope bundle around [ai].[RawOrderImport] (1 up / 1 down)',
    'Show the immediate neighbours of [ai].[RawOrderImport] on both sides.',
  ),
  T5: definition(
    'T5',
    'scenario',
    'discovery — expects an unbounded-upstream scope bundle for [ai].[spImportOrders] (all up / 1 down)',
    'Show every upstream source of [ai].[spImportOrders] and its direct consumers.',
  ),
  T6: definition(
    'T6',
    'scenario',
    'full business-blueprint loop; the leading /trace pins the route without an entry-detector call',
    '/trace [ai].[FactSalesReport] upstream — explain the business logic of every upstream source.',
  ),
  T7: definition(
    'T7',
    'scenario',
    'full column-trace loop; the route comes from the structured entry detector, not a slash command',
    'Trace the TotalRevenue column in [ai].[FactSalesReport] back to its original sources.',
  ),
};

/** Registry ids in display order. */
export const PROMPT_IDS: readonly string[] = Object.keys(PROMPTS);

/**
 * Resolves a `--prompt` argument.
 *
 * @param value - A registry id (case-insensitive) or any free-text prompt.
 * @returns The registry entry when `value` names one, otherwise the text verbatim as `free-text`.
 */
export function resolvePrompt(value: string): ResolvedPrompt {
  const key = value.trim().toUpperCase();
  const registered = PROMPTS[key];
  if (registered) {
    return { id: registered.id, text: registered.text, source: 'registry' };
  }
  return { id: 'custom', text: value, source: 'free-text' };
}

/** One line per registry entry, for `--list-prompts`. */
export function describePrompts(): string {
  return PROMPT_IDS
    .map((id) => {
      const prompt = PROMPTS[id];
      return `  ${id.padEnd(3)} [${prompt.family}] ${prompt.intent}\n      ${prompt.text}`;
    })
    .join('\n');
}
