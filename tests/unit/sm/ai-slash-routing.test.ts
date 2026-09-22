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

  /**
   * Specification-anchored contract test: every cell cites the `docs/ARCHITECTURE.md` line it
   * implements, and the table is typed against the FULL `AgentEntryRoute` x
   * `AgentExecutionTrigger` union (`src/ai/agent/state.ts:48,51`) so an added route or trigger
   * fails to compile here rather than silently defaulting through the router's fallthrough
   * `return 'discover'`.
   */
  it('routes every AgentEntryRoute x AgentExecutionTrigger pair per docs/ARCHITECTURE.md §Discovery and visual preview', () => {
    const ROUTING_TABLE: Record<AgentEntryRoute, Record<AgentExecutionTrigger, InitialAgentStage>> = {
      // docs/ARCHITECTURE.md §Discovery and visual preview — "Only a mechanical trigger opens SM
      // entry": a free-text column_trace verdict runs discovery first, so an oversized scope is
      // summarized and the detailed analysis offered instead of gated. The escalation stays keyed on
      // the trigger, never on size.
      column_trace: {
        free_text: 'discover',
        slash_trace: 'sm_entry',
        run_trace: 'sm_entry',
        preview_button: 'visual_preview',
      },
      // docs/ARCHITECTURE.md:154-155 — a render request "does not grant SM authority": it enters
      // discover, and only an explicit preview_button trigger on a later turn opens the preview.
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
          selectInitialAgentStage(trigger),
          `docs/ARCHITECTURE.md §Discovery and visual preview: (entry=${entry}, trigger=${trigger}) must route to '${expected}'`,
        ).toBe(expected);
      }
    }
  });
});
