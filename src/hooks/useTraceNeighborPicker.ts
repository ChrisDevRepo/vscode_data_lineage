import { useEffect, useState } from 'react';
import type { NeighborSide } from '../engine/graphGuards';
import type { TraceNeighborOption, TraceNodeControls } from '../engine/types';

/** User action supported by the interactive trace node controls. */
export type TraceNeighborAction = 'add' | 'prune';

/** Picker state for adding or pruning one inbound or outbound neighbor set. */
export type TraceNeighborPicker = {
  action: TraceNeighborAction;
  side: NeighborSide;
  options: TraceNeighborOption[];
};

/** The candidates `controls` currently offer for `action` on `side`; empty when there are no controls. */
function currentOptions(controls: TraceNodeControls | undefined, action: TraceNeighborAction, side: NeighborSide): TraceNeighborOption[] {
  return controls?.[side][action] ?? [];
}

function sameOptionIds(a: readonly TraceNeighborOption[], b: readonly TraceNeighborOption[]): boolean {
  return a.length === b.length && a.every((option, i) => option.id === b[i].id);
}

/**
 * Tracks the active add/prune neighbor picker for one trace-controlled node and applies its actions.
 *
 * @remarks
 * The picker shows only while the node's current controls still offer the candidates it opened
 * with: a trace edit that changes them, or the loss of the controls, closes it rather than leaving
 * stale candidates on screen. Controls rebuilt with the same candidates keep it open.
 */
export function useTraceNeighborPicker(traceControls: TraceNodeControls | undefined) {
  const [opened, setOpened] = useState<TraceNeighborPicker | null>(null);
  const picker = opened && sameOptionIds(opened.options, currentOptions(traceControls, opened.action, opened.side)) ? opened : null;

  useEffect(() => {
    if (opened && !picker) setOpened(null);
  }, [opened, picker]);

  const applyTraceAction = (action: TraceNeighborAction, side: NeighborSide, options: TraceNeighborOption[]) => {
    if (!traceControls || options.length === 0) return;
    if (options.length === 1) {
      if (action === 'add') traceControls.onAdd(options[0].id);
      else traceControls.onPrune(options[0].id);
      setOpened(null);
      return;
    }
    setOpened(prev => (
      prev?.action === action && prev.side === side ? null : { action, side, options }
    ));
  };

  const closePicker = () => setOpened(null);

  const selectPickerOption = (option: TraceNeighborOption) => {
    if (!picker) return;
    if (picker.action === 'add') traceControls?.onAdd(option.id);
    else traceControls?.onPrune(option.id);
    setOpened(null);
  };

  return { picker, applyTraceAction, closePicker, selectPickerOption };
}
