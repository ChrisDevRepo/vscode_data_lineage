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
import { selectInitialAgentStage } from '../../../src/ai/agent/entryRouting';

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
    expect(selectInitialAgentStage('visual_render', 'free_text'), 'free-text visual intent enters approval-gated SM').toBe('sm_entry');
    expect(selectInitialAgentStage('visual_render', 'preview_button'), 'explicit preview action retains the bounded preview').toBe('visual_preview');
    expect(selectInitialAgentStage('discovery', 'slash_trace'), '/trace mechanically enters SM').toBe('sm_entry');
    expect(selectInitialAgentStage('visual_render', 'discovery_budget'), 'budget overflow mechanically enters SM').toBe('sm_entry');
    expect(selectInitialAgentStage('column_trace', 'free_text'), 'named-column trace enters gated CT').toBe('sm_entry');
  });
});
