import { useEffect, useState } from 'react';
import type { TraceNeighborAction, TraceNeighborPicker } from '../components/CustomNode';
import type { NeighborSide } from '../engine/graphGuards';
import type { TraceNeighborOption, TraceNodeControls } from '../engine/types';

/** Track the active add/prune neighbor picker for one trace-controlled node and apply its actions. */
export function useTraceNeighborPicker(traceControls: TraceNodeControls | undefined) {
  const [picker, setPicker] = useState<TraceNeighborPicker | null>(null);

  useEffect(() => {
    if (!traceControls) setPicker(null);
  }, [traceControls]);

  const applyTraceAction = (action: TraceNeighborAction, side: NeighborSide, options: TraceNeighborOption[]) => {
    if (!traceControls || options.length === 0) return;
    if (options.length === 1) {
      if (action === 'add') traceControls.onAdd(options[0].id);
      else traceControls.onPrune(options[0].id);
      setPicker(null);
      return;
    }
    setPicker(prev => (
      prev?.action === action && prev.side === side ? null : { action, side, options }
    ));
  };

  const closePicker = () => setPicker(null);

  const selectPickerOption = (option: TraceNeighborOption) => {
    if (!picker) return;
    if (picker.action === 'add') traceControls?.onAdd(option.id);
    else traceControls?.onPrune(option.id);
    setPicker(null);
  };

  return { picker, applyTraceAction, closePicker, selectPickerOption };
}
