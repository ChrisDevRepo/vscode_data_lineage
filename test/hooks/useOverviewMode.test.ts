/**
 * useOverviewMode state machine tests.
 *
 * Suite A — Auto-trigger on threshold
 * Suite C — Manual toggle
 * Suite D — Schema focus entry and drill-down protection
 * Suite E — Reset on model/schema change
 * Suite F — resetUserChoice
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useOverviewMode } from '../../src/hooks/useOverviewMode';
import type { DatabaseModel } from '../../src/engine/types';
import { DEFAULT_CONFIG } from '../../src/engine/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeModel(): DatabaseModel {
  return { nodes: [], edges: [], schemas: [], catalog: {}, neighborIndex: {} } as unknown as DatabaseModel;
}

const THRESHOLD = 3;

function defaultConfig(threshold = THRESHOLD) {
  return { ...DEFAULT_CONFIG, overview: { enabled: true, threshold } };
}

type HookProps = Parameters<typeof useOverviewMode>[0];

function defaultProps(overrides?: Partial<HookProps>): HookProps {
  return {
    model: makeModel(),
    filteredCount: 2, // below threshold
    config: defaultConfig(),
    schemasKey: 'dbo',
    onSetFocusSchemaOnly: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

// ─── Suite A — Auto-trigger on threshold ─────────────────────────────────────

describe('Suite A — Auto-trigger on threshold', () => {
  it('A1: starts in full mode when filteredCount below threshold', () => {
    const { result } = renderHook(() => useOverviewMode(defaultProps()));
    expect(result.current.graphMode).toBe('full');
  });

  it('A2: enters overview when filteredCount exceeds threshold', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result } = renderHook(() => useOverviewMode(props));
    expect(result.current.graphMode).toBe('overview');
  });

  it('A3: exits overview when filteredCount drops to threshold', () => {
    const props = { ...defaultProps({ filteredCount: THRESHOLD + 1 }) };
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });
    expect(result.current.graphMode).toBe('overview');

    rerender({ ...props, filteredCount: THRESHOLD });
    expect(result.current.graphMode).toBe('full');
  });

  it('A4: does not auto-trigger when overview.enabled is false', () => {
    const config = { ...defaultConfig(), overview: { enabled: false, threshold: THRESHOLD } };
    const props = defaultProps({ filteredCount: THRESHOLD + 1, config });
    const { result } = renderHook(() => useOverviewMode(props));
    expect(result.current.graphMode).toBe('full');
  });
});

// ─── Suite C — Manual toggle ─────────────────────────────────────────────────

describe('Suite C — Manual toggle', () => {
  it('C8: toggleMode switches full to overview', () => {
    const { result } = renderHook(() => useOverviewMode(defaultProps()));
    act(() => result.current.toggleMode());
    expect(result.current.graphMode).toBe('overview');
  });

  it('C9: toggleMode switches overview to full', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result } = renderHook(() => useOverviewMode(props));
    expect(result.current.graphMode).toBe('overview');

    act(() => result.current.toggleMode());
    expect(result.current.graphMode).toBe('full');
  });

  it('C10: guard set after toggle prevents auto-trigger', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });

    // toggle to full
    act(() => result.current.toggleMode());
    expect(result.current.graphMode).toBe('full');

    // rerender with same high count — guard blocks auto-trigger
    rerender({ ...props, filteredCount: THRESHOLD + 2 });
    expect(result.current.graphMode).toBe('full');
  });

  it('C11: toggleMode clears enteredFocusFromOverview', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result } = renderHook(() => useOverviewMode(props));

    act(() => result.current.enterFocusFromOverview('dbo'));
    expect(result.current.enteredFocusFromOverview).toBe(true);

    act(() => result.current.toggleMode());
    expect(result.current.enteredFocusFromOverview).toBe(false);
  });
});

// ─── Suite D — Schema focus entry ────────────────────────────────────────────

describe('Suite D — Schema focus entry', () => {
  it('D12: exits overview and sets enteredFocusFromOverview', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result } = renderHook(() => useOverviewMode(props));
    expect(result.current.graphMode).toBe('overview');

    act(() => result.current.enterFocusFromOverview('dbo'));
    expect(result.current.graphMode).toBe('full');
    expect(result.current.enteredFocusFromOverview).toBe(true);
  });

  it('D13: calls onSetFocusSchemaOnly with schema name and forceLayout=true', () => {
    const spy = vi.fn().mockReturnValue(0);
    const props = defaultProps({ filteredCount: THRESHOLD + 1, onSetFocusSchemaOnly: spy });
    const { result } = renderHook(() => useOverviewMode(props));

    act(() => result.current.enterFocusFromOverview('Sales'));
    expect(spy).toHaveBeenCalledWith('Sales', true);
  });

  it('D14: sets guard after focus entry — persists across filter changes', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });

    act(() => result.current.enterFocusFromOverview('dbo'));
    expect(result.current.graphMode).toBe('full');

    // rerender with high count — guard blocks
    rerender({ ...props, filteredCount: THRESHOLD + 2 });
    expect(result.current.graphMode).toBe('full');
  });

  it('D14b: drill-down protection persists across multiple filter changes', () => {
    const spy = vi.fn().mockReturnValue(0);
    const props = defaultProps({ filteredCount: THRESHOLD + 1, onSetFocusSchemaOnly: spy });
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });
    expect(result.current.graphMode).toBe('overview');

    // Drill down — schemasKey changes (simulates filter narrowing to one schema)
    act(() => result.current.enterFocusFromOverview('Sales'));
    expect(result.current.graphMode).toBe('full');

    // Simulate schemasKey change from drill-down
    rerender({ ...props, schemasKey: 'Sales', filteredCount: THRESHOLD + 2 });
    expect(result.current.graphMode).toBe('full');

    // Multiple subsequent filter changes (type toggles) — guard holds
    rerender({ ...props, schemasKey: 'Sales', filteredCount: THRESHOLD + 3 });
    expect(result.current.graphMode).toBe('full');

    rerender({ ...props, schemasKey: 'Sales', filteredCount: THRESHOLD + 5 });
    expect(result.current.graphMode).toBe('full');
  });

  it('D14c: enterFocusFromOverview always uses schema-only (no neighbors)', () => {
    const schemaOnlySpy = vi.fn().mockReturnValue(THRESHOLD);
    const props = defaultProps({
      filteredCount: THRESHOLD + 1,
      onSetFocusSchemaOnly: schemaOnlySpy,
    });
    const { result } = renderHook(() => useOverviewMode(props));

    act(() => result.current.enterFocusFromOverview('Sales'));
    expect(schemaOnlySpy).toHaveBeenCalledWith('Sales', true);
    expect(schemaOnlySpy).toHaveBeenCalledTimes(1);
    expect(result.current.graphMode).toBe('full');
  });

  it('D14d: manual schema change after drill-down re-enables auto-trigger', () => {
    const spy = vi.fn().mockReturnValue(0);
    const props = defaultProps({ filteredCount: THRESHOLD + 1, onSetFocusSchemaOnly: spy });
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });
    expect(result.current.graphMode).toBe('overview');

    // Drill down — schemasKey narrows to 'Sales'
    act(() => result.current.enterFocusFromOverview('Sales'));
    expect(result.current.graphMode).toBe('full');

    // Drill-down schemasKey change — guard preserved
    rerender({ ...props, schemasKey: 'Sales', filteredCount: THRESHOLD + 2 });
    expect(result.current.graphMode).toBe('full');

    // User manually changes schemas in dropdown — guard reset, auto-trigger re-evaluates.
    // filteredCount also changes (different schemas = different count).
    rerender({ ...props, schemasKey: 'dbo,Sales,HR', filteredCount: THRESHOLD + 3 });
    expect(result.current.graphMode).toBe('overview');
    expect(result.current.enteredFocusFromOverview).toBe(false);
  });
});

// ─── Suite E — Reset on model/schema change ──────────────────────────────────

describe('Suite E — Reset on model/schema change', () => {
  it('E15: new model resets guard and re-evaluates auto-trigger', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });

    // toggle to full (guard set)
    act(() => result.current.toggleMode());
    expect(result.current.graphMode).toBe('full');

    // new model reference resets guard; drop below threshold first to force effect re-eval
    rerender({ ...props, model: makeModel(), filteredCount: THRESHOLD });
    expect(result.current.graphMode).toBe('full');
    // now exceed threshold — auto-trigger fires because guard was reset
    rerender({ ...props, model: makeModel(), filteredCount: THRESHOLD + 2 });
    expect(result.current.graphMode).toBe('overview');
  });

  it('E16: new model clears enteredFocusFromOverview', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });

    act(() => result.current.enterFocusFromOverview('dbo'));
    expect(result.current.enteredFocusFromOverview).toBe(true);

    rerender({ ...props, model: makeModel() });
    expect(result.current.enteredFocusFromOverview).toBe(false);
  });

  it('E17: schemasKey change resets guard', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });

    // toggle to full (guard set)
    act(() => result.current.toggleMode());
    expect(result.current.graphMode).toBe('full');

    // change schemasKey → guard reset; drop below threshold then exceed to force effect
    rerender({ ...props, schemasKey: 'dbo,Sales', filteredCount: THRESHOLD });
    expect(result.current.graphMode).toBe('full');
    rerender({ ...props, schemasKey: 'dbo,Sales', filteredCount: THRESHOLD + 2 });
    expect(result.current.graphMode).toBe('overview');
  });

  it('E18: manual schemasKey change after drill-down clears enteredFocusFromOverview', () => {
    // Start with multiple schemas so drill-down narrows the key
    const props = defaultProps({ filteredCount: THRESHOLD + 1, schemasKey: 'dbo,Sales' });
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });

    // Drill down into 'Sales' — schemasKey narrows
    act(() => result.current.enterFocusFromOverview('Sales'));
    expect(result.current.enteredFocusFromOverview).toBe(true);

    // Drill-down schemasKey change — enteredFocusFromOverview preserved (drillDownInProgress consumed)
    rerender({ ...props, schemasKey: 'Sales' });
    expect(result.current.enteredFocusFromOverview).toBe(true);

    // Manual schemasKey change — enteredFocusFromOverview cleared
    rerender({ ...props, schemasKey: 'dbo,Sales,HR' });
    expect(result.current.enteredFocusFromOverview).toBe(false);
  });
});

// ─── Suite F — resetUserChoice ───────────────────────────────────────────────

describe('Suite F — resetUserChoice', () => {
  it('F19: allows auto-trigger to re-evaluate after manual override', () => {
    const props = defaultProps({ filteredCount: THRESHOLD + 1 });
    const { result, rerender } = renderHook((p: HookProps) => useOverviewMode(p), { initialProps: props });

    // toggle to full (guard set)
    act(() => result.current.toggleMode());
    expect(result.current.graphMode).toBe('full');

    // reset guard
    act(() => result.current.resetUserChoice());

    // drop below then exceed threshold to force effect re-eval
    rerender({ ...props, filteredCount: THRESHOLD });
    rerender({ ...props, filteredCount: THRESHOLD + 2 });
    expect(result.current.graphMode).toBe('overview');
  });
});
