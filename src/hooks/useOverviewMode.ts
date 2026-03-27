import { useState, useEffect, useRef, useCallback } from 'react';
import type { Node as FlowNode } from '@xyflow/react';
import type { DatabaseModel, ExtensionConfig, GraphMode } from '../engine/types';

interface UseOverviewModeOptions {
  model: DatabaseModel | null;
  flowNodes: FlowNode[];
  config: ExtensionConfig;
  searchTerm: string;
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

export function useOverviewMode({
  model,
  flowNodes,
  config,
  searchTerm,
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

  // Bidirectional auto-trigger: overview when above threshold, full when at/below threshold
  useEffect(() => {
    if (!config.overview.enabled) return;
    if (userChoseMode.current) return;
    if (flowNodes.length > config.overview.threshold) {
      setGraphMode('overview');
    } else if (graphMode === 'overview') {
      setGraphMode('full');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowNodes.length, config.overview.enabled, config.overview.threshold]);

  // Auto-exit overview when user types a search term
  useEffect(() => {
    if (graphMode === 'overview' && searchTerm.length > 0) {
      setGraphMode('full');
      userChoseMode.current = true;
    }
  }, [searchTerm, graphMode]);

  const toggleMode = useCallback(() => {
    userChoseMode.current = true;
    setGraphMode((prev) => (prev === 'overview' ? 'full' : 'overview'));
    setEnteredFocusFromOverview(false);
  }, []);

  const enterFocusFromOverview = useCallback(
    (schema: string) => {
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
