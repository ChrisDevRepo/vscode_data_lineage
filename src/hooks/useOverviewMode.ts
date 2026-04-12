import { useState, useEffect, useRef, useCallback } from 'react';
import type { DatabaseModel, ExtensionConfig, GraphMode } from '../engine/types';

interface UseOverviewModeOptions {
  model: DatabaseModel | null;
  /** Node count after all filters — cheap to compute, no dagre dependency. */
  filteredCount: number;
  config: ExtensionConfig;
  /** Sorted comma-separated schema names — changing this value resets the auto-trigger guard. */
  schemasKey: string;
  /** Focus only the target schema (no neighbors) — used for schema drill-down and quick search. */
  onSetFocusSchemaOnly: (schema: string, forceLayout: boolean) => number;
}

interface UseOverviewModeResult {
  graphMode: GraphMode;
  enteredFocusFromOverview: boolean;
  toggleMode: () => void;
  enterFocusFromOverview: (schema: string) => void;
  /** Resets the userChoseMode guard so the auto-trigger re-evaluates on next render. */
  resetUserChoice: () => void;
}

const log = (text: string, level: 'info' | 'debug' | 'trace' = 'debug') => window.vscode?.postMessage({ type: 'log', text, level });

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
        log(`[Filter] Schema changed (drill-down) — userChoseMode preserved`);
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

  const toggleMode = useCallback(() => {
    userChoseMode.current = true;
    setGraphMode((prev) => {
      const next = prev === 'overview' ? 'full' : 'overview';
      log(`[Filter] View: ${next === 'overview' ? 'Overview' : 'Full View'}`, 'info');
      return next;
    });
    setEnteredFocusFromOverview(false);
  }, []);

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

  const resetUserChoice = useCallback(() => {
    userChoseMode.current = false;
    drillDownInProgress.current = false;
  }, []);

  return { graphMode, enteredFocusFromOverview, toggleMode, enterFocusFromOverview, resetUserChoice };
}
