import { useState, useEffect, useRef, useCallback } from 'react';
import type { DatabaseModel, ExtensionConfig, GraphMode } from '../engine/types';

/**
 * Options for the `useOverviewMode` hook.
 */
interface UseOverviewModeOptions {
  /** The current database model context. */
  model: DatabaseModel | null;
  /** 
   * The current count of nodes after all active filters have been applied.
   * This value is used to trigger the threshold-based auto-overview mode.
   */
  filteredCount: number;
  /** Extension-wide configuration settings including overview thresholds. */
  config: ExtensionConfig;
  /** 
   * A unique key representing the current set of selected schemas. 
   * Typically a sorted, comma-separated string of schema names.
   */
  schemasKey: string;
  /** 
   * Callback to isolate the view to a specific schema.
   * @param schema - The schema name to focus.
   * @param forceLayout - Whether to force a recalculation of the graph layout.
   */
  onSetFocusSchemaOnly: (schema: string, forceLayout: boolean) => number;
}

/**
 * The state and controls returned by the `useOverviewMode` hook.
 */
interface UseOverviewModeResult {
  /** The current graph rendering mode: 'full' (all nodes/edges) or 'overview' (aggregated view). */
  graphMode: GraphMode;
  /** Indicates if the user entered the focus view via a drill-down from the overview. */
  enteredFocusFromOverview: boolean;
  /** Toggles between 'full' and 'overview' modes manually. */
  toggleMode: () => void;
  /** 
   * Transitions from overview to full view focused on a specific schema.
   * @param schema - The name of the schema to drill into.
   */
  enterFocusFromOverview: (schema: string) => void;
  /** Resets the user override guard, allowing auto-trigger logic to resume for the current filter state. */
  resetUserChoice: () => void;
}

const log = (text: string, level: 'info' | 'debug' = 'debug') => window.vscode?.postMessage({ type: 'log', text, level });

/**
 * A state management hook that handles the transition between 'Full View' and 'Overview Mode'.
 * 
 * @remarks
 * This hook implements "Bidirectional Auto-Triggering":
 * 1. Automatically switches to `overview` when the node count exceeds the configured threshold.
 * 2. Automatically switches back to `full` when filters reduce the node count below the threshold.
 * 3. Respects manual user overrides (manual toggling stops the auto-trigger until filters change).
 * 4. Handles "Drill-Down" logic where clicking a schema node in overview mode switches to a focused full view.
 * 
 * @param options - Configuration and state inputs for mode calculation.
 * @returns State and control functions for managing the graph view mode.
 */
export function useOverviewMode({
  model,
  filteredCount,
  config,
  schemasKey,
  onSetFocusSchemaOnly,
}: UseOverviewModeOptions): UseOverviewModeResult {
  const [graphMode, setGraphMode] = useState<GraphMode>('full');
  const [enteredFocusFromOverview, setEnteredFocusFromOverview] = useState(false);
  // Once the user manually overrides mode, stop auto-triggering for this model session.
  const userChoseMode = useRef(false);
  // Set by enterFocusFromOverview, consumed by the schemasKey effect. Prevents the
  // schemasKey effect from resetting userChoseMode when the schema change was caused
  // by a drill-down (not a manual schema selection in the dropdown).
  const drillDownInProgress = useRef(false);

  // Reset when a new model is loaded — re-evaluate auto-trigger
  const prevModelRef = useRef<DatabaseModel | null>(null);
  useEffect(() => {
    if (model !== prevModelRef.current) {
      prevModelRef.current = model;
      userChoseMode.current = false;
      drillDownInProgress.current = false;
      setEnteredFocusFromOverview(false);
    }
  }, [model]);

  // Reset auto-trigger guard when schema selection changes (not on other filter changes).
  // Skip reset when the schema change was caused by a drill-down — the user intentionally
  // drilled into a schema and should stay in full view until they manually change schemas.
  const prevSchemasKey = useRef(schemasKey);
  useEffect(() => {
    if (schemasKey !== prevSchemasKey.current) {
      prevSchemasKey.current = schemasKey;
      if (drillDownInProgress.current) {
        drillDownInProgress.current = false;
      } else {
        userChoseMode.current = false;
        setEnteredFocusFromOverview(false);
      }
    }
  }, [schemasKey]);

  // Bidirectional auto-trigger: overview when above threshold, full when at/below threshold.
  useEffect(() => {
    if (!config.overview.enabled) return;
    if (userChoseMode.current) return;
    if (filteredCount > config.overview.threshold) {
      log(`[Filter] Switched to Overview — ${filteredCount} objects`, 'info');
      setGraphMode('overview');
    } else if (graphMode === 'overview') {
      log(`[Filter] Switched to Full View`, 'info');
      setGraphMode('full');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredCount, config.overview.enabled, config.overview.threshold]);

  /**
   * Manually toggles the graph mode and sets the user override guard.
   */
  const toggleMode = useCallback(() => {
    userChoseMode.current = true;
    setGraphMode((prev) => {
      const next = prev === 'overview' ? 'full' : 'overview';
      log(`[Filter] View: ${next === 'overview' ? 'Overview' : 'Full View'}`, 'info');
      return next;
    });
    setEnteredFocusFromOverview(false);
  }, []);

  /**
   * Switches from overview to a focused full view for a specific schema.
   */
  const enterFocusFromOverview = useCallback(
    (schema: string) => {
      log(`[Filter] Focusing on schema "${schema}"`, 'info');
      userChoseMode.current = true;
      drillDownInProgress.current = true;
      setEnteredFocusFromOverview(true);
      setGraphMode('full');

      // Drill down to target schema only (no neighbors).
      // Neighbors are only auto-selected via the star button in the schema dropdown.
      onSetFocusSchemaOnly(schema, true);
    },
    [onSetFocusSchemaOnly]
  );

  /**
   * Resets the user manual choice flags.
   */
  const resetUserChoice = useCallback(() => {
    userChoseMode.current = false;
    drillDownInProgress.current = false;
  }, []);

  return { graphMode, enteredFocusFromOverview, toggleMode, enterFocusFromOverview, resetUserChoice };
}
