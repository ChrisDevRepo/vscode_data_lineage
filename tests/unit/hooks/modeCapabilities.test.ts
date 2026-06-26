import { describe, expect, it } from 'vitest';
import { deriveModeCapabilities } from '../../../src/engine/modeCapabilities';
import type { TraceState } from '../../../src/engine/types';

function caps(input: Partial<Parameters<typeof deriveModeCapabilities>[0]>) {
  return deriveModeCapabilities({
    traceMode: 'none' as TraceState['mode'],
    hasAnalysisMode: false,
    hasAiPreview: false,
    hasAdvancedView: false,
    ...input,
  });
}

describe('mode capabilities', () => {
  it('allows global delete/exclude only in normal graph mode', () => {
    expect(caps({}).canExcludeHighlightedNode).toBe(true);
    expect(caps({ hasAiPreview: true }).canExcludeHighlightedNode).toBe(false);
    expect(caps({ hasAdvancedView: true }).canExcludeHighlightedNode).toBe(false);
    expect(caps({ traceMode: 'filtered' }).canExcludeHighlightedNode).toBe(false);
    expect(caps({ hasAnalysisMode: true }).canExcludeHighlightedNode).toBe(false);
  });

  it('allows node X removal only in curated AI or advanced views', () => {
    expect(caps({ hasAiPreview: true }).canRemoveNodeFromScopedView).toBe(true);
    expect(caps({ hasAdvancedView: true }).canRemoveNodeFromScopedView).toBe(true);
    expect(caps({}).canRemoveNodeFromScopedView).toBe(false);
    expect(caps({ traceMode: 'filtered' }).canRemoveNodeFromScopedView).toBe(false);
    expect(caps({ hasAnalysisMode: true }).canRemoveNodeFromScopedView).toBe(false);
  });

  it('allows trace add/prune controls only in editable trace views', () => {
    expect(caps({ traceMode: 'applied' }).canEditTraceScope).toBe(true);
    expect(caps({ traceMode: 'filtered' }).canEditTraceScope).toBe(true);
    expect(caps({ traceMode: 'path-applied' }).canEditTraceScope).toBe(false);
    expect(caps({ hasAiPreview: true }).canEditTraceScope).toBe(false);
    expect(caps({ hasAnalysisMode: true }).canEditTraceScope).toBe(false);
  });

  it('locks new scoped modes and graph mode switching while any scoped mode is active', () => {
    expect(caps({}).canStartNewScopedMode).toBe(true);
    expect(caps({}).canSwitchGraphMode).toBe(true);

    for (const input of [
      { traceMode: 'configuring' as const },
      { traceMode: 'filtered' as const },
      { traceMode: 'path-applied' as const },
      { hasAiPreview: true },
      { hasAdvancedView: true },
      { hasAnalysisMode: true },
    ]) {
      expect(caps(input).isModeLocked).toBe(true);
      expect(caps(input).canStartNewScopedMode).toBe(false);
      expect(caps(input).canSwitchGraphMode).toBe(false);
    }
  });
});
