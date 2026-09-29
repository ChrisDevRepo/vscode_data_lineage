/**
 * `deriveModeCapabilities` table plus the `resolveRemoveAction` Delete dispatcher it feeds —
 * the single source of truth for what a locked mode allows and what Delete does in it.
 */

import { describe, expect, it } from 'vitest';
import { deriveModeCapabilities, resolveRemoveAction, type ModeCapabilityInput } from '../../../src/engine/modeCapabilities';

function capabilities(overrides: Partial<ModeCapabilityInput>) {
  return deriveModeCapabilities({
    traceMode: 'none',
    hasAnalysisMode: false,
    hasAiPreview: false,
    hasAdvancedView: false,
    ...overrides,
  });
}

describe('resolveRemoveAction', () => {
  it('normal view (no scoped mode) excludes the node', () => {
    const result = resolveRemoveAction(capabilities({}), { hasAnalysisMode: false, isTraceOrigin: false });
    expect(result).toEqual({ kind: 'exclude' });
  });

  it('an applied trace prunes the node', () => {
    const result = resolveRemoveAction(capabilities({ traceMode: 'applied' }), { hasAnalysisMode: false, isTraceOrigin: false });
    expect(result).toEqual({ kind: 'trace-prune' });
  });

  it('a filtered (immediate) trace also prunes the node', () => {
    const result = resolveRemoveAction(capabilities({ traceMode: 'filtered' }), { hasAnalysisMode: false, isTraceOrigin: false });
    expect(result).toEqual({ kind: 'trace-prune' });
  });

  it('the trace origin refuses removal even in an editable trace', () => {
    const result = resolveRemoveAction(capabilities({ traceMode: 'applied' }), { hasAnalysisMode: false, isTraceOrigin: true });
    expect(result.kind).toBe('refuse');
    expect((result as { reason: string }).reason).toMatch(/trace source/i);
  });

  it('a curated (AI preview) view removes the node from the view', () => {
    const result = resolveRemoveAction(capabilities({ hasAiPreview: true }), { hasAnalysisMode: false, isTraceOrigin: false });
    expect(result).toEqual({ kind: 'curated-remove' });
  });

  it('a curated (saved advanced bookmark) view removes the node from the view', () => {
    const result = resolveRemoveAction(capabilities({ hasAdvancedView: true }), { hasAnalysisMode: false, isTraceOrigin: false });
    expect(result).toEqual({ kind: 'curated-remove' });
  });

  it('analysis mode refuses with a reason, never a silent no-op', () => {
    const result = resolveRemoveAction(capabilities({ hasAnalysisMode: true }), { hasAnalysisMode: true, isTraceOrigin: false });
    expect(result.kind).toBe('refuse');
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  it('path finder (no editable trace scope, no curated view) refuses with a reason', () => {
    const result = resolveRemoveAction(capabilities({ traceMode: 'pathfinding' }), { hasAnalysisMode: false, isTraceOrigin: false });
    expect(result.kind).toBe('refuse');
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
  });
});

describe('deriveModeCapabilities — a shown AI preview leaves only the filter unlocked', () => {
  it('an AI preview releases the filter lock but not a new trace/analysis or the Schema View switch, which would replace it', () => {
    const result = deriveModeCapabilities({ traceMode: 'none', hasAnalysisMode: false, hasAiPreview: true, hasAdvancedView: false });
    expect(result.isModeLocked).toBe(false);
    expect(result.canStartNewScopedMode).toBe(false);
    expect(result.canSwitchGraphMode).toBe(false);
  });

  it('an AI preview still allows removing a node from the curated view', () => {
    const result = deriveModeCapabilities({ traceMode: 'none', hasAnalysisMode: false, hasAiPreview: true, hasAdvancedView: false });
    expect(result.canRemoveNodeFromScopedView).toBe(true);
  });

  it('a trace running alongside the AI preview keeps every lock — only the AI preview itself releases it', () => {
    const result = deriveModeCapabilities({ traceMode: 'applied', hasAnalysisMode: false, hasAiPreview: true, hasAdvancedView: false });
    expect(result.isModeLocked).toBe(true);
    expect(result.canStartNewScopedMode).toBe(false);
    expect(result.canSwitchGraphMode).toBe(false);
  });

  it('an active analysis run alongside the AI preview keeps every lock', () => {
    const result = deriveModeCapabilities({ traceMode: 'none', hasAnalysisMode: true, hasAiPreview: true, hasAdvancedView: false });
    expect(result.isModeLocked).toBe(true);
  });

  it('a saved advanced view alongside the AI preview keeps every lock', () => {
    const result = deriveModeCapabilities({ traceMode: 'none', hasAnalysisMode: false, hasAiPreview: true, hasAdvancedView: true });
    expect(result.isModeLocked).toBe(true);
  });
});
