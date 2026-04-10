import { useState, useEffect, useRef, useCallback } from 'react';
import type { DatabaseModel, ExtensionConfig, GraphMode } from '../engine/types';

interface UseOverviewModeOptions {
  model: DatabaseModel | null;
  /** Node count after all filters — cheap to compute, no dagre dependency. */
  filteredCount: number;
  config: ExtensionConfig;
  /** Sorted comma-separated schema names — changing this value resets the auto-trigger guard. */
  schemasKey: string;
  /** Called when entering focus from overview — always sets the schema (never toggles off). */
  onSetFocusSchema: (schema: string) => void;
}

interface UseOverviewModeResult {
  graphMode: GraphMode;
  enteredFocusFromOverview: boolean;
  toggleMode: () => void;
  enterFocusFromOverview: (schema: string) => void;
  /** Resets the userChoseMode guard so the auto-trigger re-evaluates on next render. */
  resetUserChoice: () => void;
}

const log = (text: string) => window.vscode?.postMessage({ type: 'log', text });

export function useOverviewMode({
  model,
  filteredCount,
  config,
  schemasKey,
  onSetFocusSchema,
}: UseOverviewModeOptions): UseOverviewModeResult {
  const [graphMode, setGraphMode] = useState<GraphMode>('full');
  const [enteredFocusFromOverview, setEnteredFocusFromOverview] = useState(false);
  // Once the user manually overrides mode, stop auto-triggering for this model session.
  const userChoseMode = useRef(false);

  // Reset when a new model is loaded — re-evaluate auto-trigger
  const prevModelRef = useRef<DatabaseModel | null>(null);
  useEffect(() => {
    if (model !== prevModelRef.current) {
      prevModelRef.current = model;
      userChoseMode.current = false;
      setEnteredFocusFromOverview(false);
    }
  }, [model]);

  // Reset auto-trigger guard when schema selection changes (not on other filter changes)
  const prevSchemasKey = useRef(schemasKey);
  useEffect(() => {
    if (schemasKey !== prevSchemasKey.current) {
      prevSchemasKey.current = schemasKey;
      userChoseMode.current = false;
    }
  }, [schemasKey]);

  // Bidirectional auto-trigger: overview when above threshold, full when at/below threshold.
  // Force guard: override userChoseMode when far above threshold (soft safety net).
  useEffect(() => {
    if (!config.overview.enabled) return;

    // Soft guard — force overview when node count is far above threshold
    if (filteredCount > config.overview.forceOverviewThreshold) {
      log(`[Filter] Mode auto: overview (forced, ${filteredCount} nodes > forceThreshold=${config.overview.forceOverviewThreshold})`);
      setGraphMode('overview');
      return;
    }

    if (userChoseMode.current) return;
    if (filteredCount > config.overview.threshold) {
      log(`[Filter] Mode auto: overview (${filteredCount} nodes > threshold=${config.overview.threshold})`);
      setGraphMode('overview');
    } else if (graphMode === 'overview') {
      log(`[Filter] Mode auto: full (${filteredCount} nodes <= threshold=${config.overview.threshold})`);
      setGraphMode('full');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredCount, config.overview.enabled, config.overview.threshold, config.overview.forceOverviewThreshold]);

  const toggleMode = useCallback(() => {
    userChoseMode.current = true;
    setGraphMode((prev) => {
      const next = prev === 'overview' ? 'full' : 'overview';
      log(`[Filter] Mode toggle: ${prev} → ${next} (user)`);
      return next;
    });
    setEnteredFocusFromOverview(false);
  }, []);

  const enterFocusFromOverview = useCallback(
    (schema: string) => {
      log(`[Filter] Mode focus: overview → full, schema="${schema}"`);
      userChoseMode.current = true;
      setEnteredFocusFromOverview(true);
      setGraphMode('full');
      onSetFocusSchema(schema);
    },
    [onSetFocusSchema]
  );

  const resetUserChoice = useCallback(() => {
    userChoseMode.current = false;
  }, []);

  return { graphMode, enteredFocusFromOverview, toggleMode, enterFocusFromOverview, resetUserChoice };
}
