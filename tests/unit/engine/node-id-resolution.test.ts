/**
 * Regression tests for `resolveModelNodeId` (`src/engine/shared/nodeIdResolution.ts`).
 *
 * @remarks
 * Guards the failure that made one `present_result` rejection unrepairable: the model padded every
 * node id with U+200B, `trim()` (ASCII whitespace only) left it in place, every lookup missed, and
 * the rejection then printed the offending ids *unquoted* — rendering them identical to correct
 * ones. Three rounds later the turn was dead without the model ever being shown what was wrong.
 */
import { describe, expect, it } from 'vitest';
import { resolveModelNodeId } from '../../../src/engine/shared/nodeIdResolution';

const nodeMap = new Map<string, unknown>([
  ['[ai].[saporders]', {}],
  ['[ai].[factsalesreport]', {}],
]);

describe('resolveModelNodeId', () => {
  it('resolves an id padded with a zero-width space', () => {
    expect(resolveModelNodeId('[ai].[saporders]\u200b', nodeMap)).toBe('[ai].[saporders]');
  });

  it('resolves ids carrying other Unicode format characters', () => {
    // \u200e LEFT-TO-RIGHT MARK, \ufeff ZERO WIDTH NO-BREAK SPACE — both invisible, both survive trim().
    expect(resolveModelNodeId('\ufeff[ai].[saporders]\u200e', nodeMap)).toBe('[ai].[saporders]');
  });

  it('still resolves ordinary padding and case differences', () => {
    expect(resolveModelNodeId('  [AI].[SAPOrders]  ', nodeMap)).toBe('[ai].[saporders]');
  });

  it('returns null for an id that is only invisible characters', () => {
    expect(resolveModelNodeId('\u200b\u200b', nodeMap)).toBeNull();
  });

  it('returns null for a genuinely unknown id', () => {
    expect(resolveModelNodeId('[ai].[missing]', nodeMap)).toBeNull();
  });
});
