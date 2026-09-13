/**
 * Unit tests for deterministic /trace · /search slash routing.
 *
 * Slash commands pin the entry route in code and skip the LLM entry-detector call. Node ids are
 * 2-part [schema].[object], so a column trace requires a 3-part [schema].[table].[column] reference.
 *
 * Free-prose intent is EXCLUSIVELY the structured entry detector's call (the engine has no
 * authority over user-intent semantics) — the second half of this file locks that no natural-language
 * phrasing is ever routed deterministically.
 */

import { describe, expect, it } from 'vitest';
import { detectSlashRoute } from '../../../src/ai/agent/slashCommands';
import { selectInitialAgentStage, type InitialAgentStage } from '../../../src/ai/agent/entryRouting';
import type { AgentEntryRoute, AgentExecutionTrigger } from '../../../src/ai/agent/state';

describe('ai-slash-routing', () => {
  it('no command → detector runs (null)', () => {
    expect(detectSlashRoute('what feeds spImportOrders?'), 'plain prompt returns null').toBe(null);
    expect(detectSlashRoute(''), 'empty prompt returns null').toBe(null);
    expect(detectSlashRoute('tell me about the /trace flag'), 'non-leading /trace returns null').toBe(null);
  });

  it('/search → discovery', () => {
    const search = detectSlashRoute('/search customer');
    expect(search?.entry, '/search routes to discovery').toBe('discovery');
    expect(search?.trigger, '/search stays in bounded discovery').toBe('free_text');
    expect(search?.targetColumns, '/search carries no target columns').toBe(null);
    expect(detectSlashRoute('/SEARCH Orders')?.entry, '/search is case-insensitive').toBe('discovery');
  });

  it('/trace with fully-qualified column → column_trace', () => {
    const ct = detectSlashRoute('/trace [Sales].[SalesOrderHeader].[TotalDue]');
    expect(ct?.entry, 'qualified [schema].[table].[column] routes to column_trace').toBe('column_trace');
    expect(ct?.trigger, '/trace is an explicit SM trigger').toBe('slash_trace');
    expect(!!ct?.targetColumns && ct.targetColumns.includes('TotalDue'), 'last bracketed token is the column').toBe(true);

    const multi = detectSlashRoute('/trace [Sales].[Order].[Total], [Sales].[Order].[Tax]');
    expect(multi?.entry, 'multi-column trace routes to column_trace').toBe('column_trace');
    expect(multi?.targetColumns?.length ?? 0, 'two columns parsed across comma segments').toBe(2);
    expect(!!multi?.targetColumns?.includes('Total') && !!multi?.targetColumns?.includes('Tax'), 'both columns captured').toBe(true);
  });

  it('/trace without a qualified column → explicit BB trace trigger', () => {
    const objId = detectSlashRoute('/trace [dbo].[Customer]');
    expect(objId?.entry, '2-part object id carries no fabricated visual semantic verdict').toBe('discovery');
    expect(objId?.trigger, '2-part object id still explicitly triggers SM').toBe('slash_trace');
    expect(objId?.targetColumns, 'no columns for a 2-part object id').toBe(null);

    const bare = detectSlashRoute('/trace [Customer]');
    expect(bare?.entry, 'bare object carries no fabricated visual semantic verdict').toBe('discovery');
    expect(bare?.targetColumns, 'no columns when none qualified').toBe(null);

    expect(detectSlashRoute('/trace customer orders')?.entry, 'unbracketed text carries no fabricated semantic verdict').toBe('discovery');
    expect(detectSlashRoute('/trace customer orders')?.targetColumns, 'unbracketed text has no columns').toBe(null);
  });

  it('free prose is NEVER routed deterministically (detector-owned)', () => {
    const proseCases = [
      'Trace all dependencies upstream from [ai].[spImportOrders], all levels up.',
      'Show me the dependency graph for [ai].[spImportOrders] — render all upstream objects.',
      'Visualize the full upstream dependency graph for [ai].[FactSalesReport] — show all source objects.',
      'Trace the [NonExistentColumn] column in [ai].[factsalesreport] back to its raw sources.',
      'Trace the TotalRevenue column in [ai].[FactSalesReport] back to sources.',
      'Which procedures reference [ai].[RawOrderImport]?',
    ];
    for (const prompt of proseCases) {
      expect(detectSlashRoute(prompt), `free prose goes to the LLM detector: "${prompt.slice(0, 50)}..."`).toBe(null);
    }
  });

  it('semantic verdict and execution trigger stay separate', () => {
    // visual_render is a semantic classification, not an execution trigger: free-text render
    // intent runs the main discovery loop, same as any other free-text request, so the bounded
    // preview it may offer afterward stays reachable only through the explicit trigger.
    expect(selectInitialAgentStage('visual_render', 'free_text'), 'free-text visual intent enters discovery, not gated SM').toBe('discover');
    expect(selectInitialAgentStage('visual_render', 'preview_button'), 'explicit preview action retains the bounded preview').toBe('visual_preview');
    expect(selectInitialAgentStage('discovery', 'free_text'), 'plain discovery intent enters discovery').toBe('discover');
    expect(selectInitialAgentStage('column_trace', 'free_text'), 'named-column trace enters gated CT').toBe('sm_entry');

    // Every explicit mechanical trigger outranks the model's semantic classification, whatever
    // that classification was — this is the ranking the entry router exists to enforce.
    expect(selectInitialAgentStage('discovery', 'preview_button'), 'preview_button outranks a discovery verdict').toBe('visual_preview');
    expect(selectInitialAgentStage('discovery', 'slash_trace'), '/trace mechanically enters SM').toBe('sm_entry');
    expect(selectInitialAgentStage('visual_render', 'slash_trace'), 'slash_trace outranks a visual_render verdict').toBe('sm_entry');
    expect(selectInitialAgentStage('discovery', 'run_trace'), 'run_trace mechanically enters SM').toBe('sm_entry');
    expect(selectInitialAgentStage('visual_render', 'run_trace'), 'run_trace outranks a visual_render verdict').toBe('sm_entry');
  });

  /**
   * Specification-anchored contract test. `entryRouting.ts:23` routed `visual_render` to
   * `sm_entry` for the whole 1.1.0 lifetime (`08204f6c`..`37b2ef26`) while
   * `docs/ARCHITECTURE.md:154-155` already stated the opposite ("An explicit graph/render request
   * can commit a bounded transient preview; this path does not grant SM authority"). The two tests
   * that pinned the bug (`ai-slash-routing.test.ts`, `prompt-composition.test.ts`, both added in
   * `08204f6c`) were written by reading `entryRouting.ts`, not `docs/ARCHITECTURE.md` — a test
   * authored from the implementation can only ever confirm the implementation. This table is
   * authored from the spec instead: every cell cites the `docs/ARCHITECTURE.md` line it
   * implements, and the table is
   * typed against the FULL `AgentEntryRoute` x `AgentExecutionTrigger` union
   * (`src/ai/agent/state.ts:48,51`) so an added route or trigger fails to compile here rather than
   * silently defaulting through the router's fallthrough `return 'discover'`.
   */
  it('routes every AgentEntryRoute x AgentExecutionTrigger pair per docs/ARCHITECTURE.md §Discovery and visual preview', () => {
    const ROUTING_TABLE: Record<AgentEntryRoute, Record<AgentExecutionTrigger, InitialAgentStage>> = {
      // docs/ARCHITECTURE.md:178 — "A column-trace request always escalates to SM entry, budget
      // irrelevant — the escalation is keyed on request kind, not size." That contract confirms
      // entryRouting.ts:22 is correct and is NOT touched by the visual_render
      // repair: kind-based, never size-based, in every trigger column.
      column_trace: {
        free_text: 'sm_entry',
        slash_trace: 'sm_entry',
        run_trace: 'sm_entry',
        preview_button: 'visual_preview',
      },
      // Net routing contract after the repair:
      // `visual_render -> discover (main loop), then the bounded preview renders the discovery
      // answer` on a LATER turn via the explicit preview_button trigger only. docs/ARCHITECTURE.md
      // :154-155 states the same boundary: the render request "does not grant SM authority".
      // This is the exact cell that was wrong for the whole 1.1.0 lifetime (defect: 'sm_entry').
      visual_render: {
        free_text: 'discover',
        slash_trace: 'sm_entry',
        run_trace: 'sm_entry',
        preview_button: 'visual_preview',
      },
      // docs/ARCHITECTURE.md:148 — "Discovery is the default read-only chat state."
      discovery: {
        free_text: 'discover',
        slash_trace: 'sm_entry',
        run_trace: 'sm_entry',
        preview_button: 'visual_preview',
      },
    };

    const routes = Object.keys(ROUTING_TABLE) as AgentEntryRoute[];
    for (const entry of routes) {
      const triggers = ROUTING_TABLE[entry];
      const triggerKeys = Object.keys(triggers) as AgentExecutionTrigger[];
      for (const trigger of triggerKeys) {
        const expected = triggers[trigger];
        expect(
          selectInitialAgentStage(entry, trigger),
          `docs/ARCHITECTURE.md §Discovery and visual preview: (entry=${entry}, trigger=${trigger}) must route to '${expected}'`,
        ).toBe(expected);
      }
    }
  });
});
