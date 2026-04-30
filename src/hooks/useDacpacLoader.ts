import { useState, useCallback, useEffect, useRef } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DatabaseModel, SchemaInfo, SchemaPreview, ExtensionConfig, ExtensionMessage } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';

/**
 * Represents a status notification displayed in the UI during project loading or processing.
 */
export type StatusMessage = {
  /** The descriptive text of the status message. */
  text: string;
  /** The semantic type of the message, affecting UI styling (color, icons). */
  type: 'info' | 'success' | 'warning' | 'error';
};

/**
 * The source context currently being loaded.
 */
export type LoadingContext = 'dacpac' | 'database' | null;

/**
 * The full state and action set managed by the project loader hook.
 * 
 * @remarks
 * This interface defines the bridge between the React frontend and the VS Code 
 * extension host for all data extraction and project lifecycle events.
 */
export interface DacpacLoaderState {
  /** The fully extracted database model (Phase 2 result). */
  model: DatabaseModel | null;
  /** The lightweight schema preview (Phase 1 result). */
  schemaPreview: SchemaPreview | null;
  /** The set of schemas selected by the user for extraction. */
  selectedSchemas: Set<string>;
  /** Whether an extraction or connection process is active. */
  isLoading: boolean;
  /** The current loading source (dacpac file or live database). */
  loadingContext: LoadingContext;
  /** The display name of the current file or database. */
  fileName: string | null;
  /** The absolute path to the project file on disk. */
  filePath: string | null;
  /** The current status message to show in the UI. */
  status: StatusMessage | null;
  /** Whether the MSSQL extension is available for live connections. */
  mssqlAvailable: boolean | null;
  /** Whether the project should immediately visualize upon load (e.g., demo or restore). */
  pendingAutoVisualize: boolean;
  /** Whether the UI should transition to the graph view. */
  pendingVisualize: boolean;
  /** Whether the currently loaded model is the AdventureWorks demo. */
  isDemo: boolean;
  /** Triggers the VS Code file picker to open a .dacpac. */
  openFile: () => void;
  /** Resets the internal loader state to the starting screen. */
  resetToStart: () => void;
  /** Loads an existing project by its unique ID. */
  loadProject: (id: string) => void;
  /** Loads the built-in demo project. */
  loadDemo: () => void;
  /** Triggers the MSSQL connection picker flow. */
  connectToDatabase: () => void;
  /** Aborts the current loading process. */
  cancelLoading: () => void;
  /** Clears the auto-visualize trigger flag. */
  clearAutoVisualize: () => void;
  /** Clears the transition trigger flag. */
  clearPendingVisualize: () => void;
  /** Starts the Phase 2 extraction for the selected schemas. */
  visualize: (selectedSchemas: Set<string>, projectName?: string) => void;
  /** Toggles a schema's selection status. */
  toggleSchema: (name: string) => void;
  /** Selects all available schemas in a list. */
  selectAllSchemas: (names: string[]) => void;
  /** Deselects all available schemas in a list. */
  clearAllSchemas: (names: string[]) => void;
}

/**
 * Orchestrates the project loading lifecycle: from file picking to full lineage extraction.
 * 
 * @remarks
 * This hook handles the multi-phase extraction process used for both DACPACs and live databases.
 * Phase 1: Rapid metadata extraction to show a schema selector.
 * Phase 2: Full DDL parsing and graph building for the selected scope.
 * It communicates with the VS Code extension host via `postMessage`.
 * 
 * @param onConfigReceived - Callback triggered when the extension host delivers updated configuration.
 * @returns The project loader state and interactive actions.
 */
export function useDacpacLoader(onConfigReceived: (config: ExtensionConfig) => void): DacpacLoaderState {
  const vscodeApi = useVsCode();
  const [model, setModel] = useState<DatabaseModel | null>(null);
  const [schemaPreview, setSchemaPreview] = useState<SchemaPreview | null>(null);
  const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [loadingContext, setLoadingContext] = useState<LoadingContext>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [mssqlAvailable, setMssqlAvailable] = useState<boolean | null>(null);
  const [pendingAutoVisualize, setPendingAutoVisualize] = useState(false);
  const [pendingVisualize, setPendingVisualize] = useState(false);
  const isDemoRef = useRef(false);
  // Auto-clear transient info messages after 6s (progress, connecting, loading...).
  // Success messages persist until the next action — they carry meaningful summary information.
  // Warning/error messages are always kept visible until explicitly replaced.
  useEffect(() => {
    if (status && status.type === 'info' && !isLoading) {
      const timer = setTimeout(() => setStatus(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [status, isLoading]);

  const applySchemaPreview = useCallback((preview: SchemaPreview, name: string) => {
    setSchemaPreview(preview);
    setSelectedSchemas(new Set(preview.schemas.map((s: SchemaInfo) => s.name)));
    setFileName(name);

    if (preview.warnings && preview.warnings.length > 0) {
      setStatus({ text: preview.warnings[0], type: 'warning' });
    } else {
      const s = preview.schemas.length !== 1 ? 's' : '';
      setStatus({ text: `Found ${preview.totalObjects} objects across ${preview.schemas.length} schema${s}`, type: 'success' });
    }
  }, []);

  const applyModel = useCallback((result: DatabaseModel, name: string, statusText: string) => {
    setModel(result);
    setSelectedSchemas(new Set(result.schemas.map((s: SchemaInfo) => s.name)));
    setFileName(name);

    if (result.warnings && result.warnings.length > 0) {
      setStatus({ text: result.warnings[0], type: 'warning' });
    } else if (result.nodes.length === 0) {
      setStatus({ text: 'No tables, views, or stored procedures found.', type: 'warning' });
    } else {
      const s = result.schemas.length !== 1 ? 's' : '';
      setStatus({ text: `${result.nodes.length} nodes · ${result.edges.length} edges · ${result.schemas.length} schema${s}`, type: 'success' });
    }

  }, []);

  // Listen for messages from VS Code extension host
  useEffect(() => {
    const handler = async (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data;
      if (!msg?.type) return;

      // Theme changes from extension host — update body attribute before React re-renders
      if (msg.type === 'themeChanged') {
        document.body.setAttribute('data-vscode-theme-kind', msg.kind);
        return;
      }

      const applyConfig = (raw: ExtensionConfig) => {
        onConfigReceived({
          ...DEFAULT_CONFIG,
          ...raw,
          layout: { ...DEFAULT_CONFIG.layout, ...raw.layout },
          trace: { ...DEFAULT_CONFIG.trace, ...raw.trace },
          analysis: { ...DEFAULT_CONFIG.analysis, ...raw.analysis },
        });
      };

      if (msg.type === 'config-only') {
        if (msg.config) applyConfig(msg.config);
        return;
      }

      if (msg.type === 'projects-list') {
        return; // Handled at App.tsx level
      }

      if (msg.type === 'last-dacpac-gone') {
        setIsLoading(false);
        setLoadingContext(null);
        setStatus({ text: 'Project file is no longer available.', type: 'error' });
        return;
      }

      if (msg.type === 'mssql-status') {
        setMssqlAvailable(msg.available);
        return;
      }

      if (msg.type === 'db-progress') {
        setStatus({ text: `${msg.label} (${msg.step}/${msg.total})`, type: 'info' });
        return;
      }

      if (msg.type === 'db-cancelled') {
        setIsLoading(false);
        setLoadingContext(null);
        setStatus(null);
        return;
      }

      // Dacpac Phase 1: schema preview (extraction now runs in extension host)
      if (msg.type === 'dacpac-schema-preview') {
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'dacpac';
        setModel(null);  // clear stale model so visualize() routes to dacpac path
        setFilePath(msg.filePath ?? null);
        applySchemaPreview(msg.preview, name);
        setIsLoading(false);
        setLoadingContext(null);
        return;
      }

      // Dacpac Phase 2 + demo + panel restore: full model from extension host
      if (msg.type === 'dacpac-model') {
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'dacpac';
        setSchemaPreview(null);  // clear Phase 1 state once Phase 2 model arrives
        applyModel(msg.model, name, `Loaded from ${name}: ${msg.model.nodes.length} objects, ${msg.model.edges.length} edges`);
        setIsLoading(false);
        setLoadingContext(null);
        if (msg.autoVisualize) {
          setPendingAutoVisualize(true);
        } else {
          setPendingVisualize(true);
        }
        return;
      }

      // DB Phase 1: schema preview received (Create flow — shows schema selector)
      if (msg.type === 'db-schema-preview') {
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'Database';
        applySchemaPreview(msg.preview, name);
        setIsLoading(false);
        setLoadingContext('database');
        return;
      }

      // DB Phase 2: full model received
      if (msg.type === 'db-model') {
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'Database';
        applyModel(msg.model, name, `Loaded from ${name}: ${msg.model.nodes.length} objects, ${msg.model.edges.length} edges`);
        setIsLoading(false);
        setLoadingContext(null);
        setPendingVisualize(true);
        return;
      }

      if (msg.type === 'db-error') {
        setStatus({ text: msg.message, type: 'error' });
        setIsLoading(false);
        setLoadingContext(null);
        return;
      }
    };

    window.addEventListener('message', handler);
    vscodeApi.postMessage({ type: 'ready' });
    vscodeApi.postMessage({ type: 'check-mssql' });
    return () => window.removeEventListener('message', handler);
  }, [onConfigReceived, applyModel, applySchemaPreview, vscodeApi]);

  // Phase 2: trigger full extraction for selected schemas
  const visualize = useCallback((schemas: Set<string>, projectName?: string) => {
    // Dacpac path: request Phase 2 extraction from extension host
    // (dacpac-model response handled above — sets model + pendingVisualize)
    if (schemaPreview !== null && model === null && loadingContext !== 'database') {
      const payload: Record<string, unknown> = { type: 'dacpac-visualize', schemas: Array.from(schemas) };
      if (projectName) payload.projectName = projectName;
      vscodeApi.postMessage(payload);
      setIsLoading(true);
      setLoadingContext('dacpac');
      return;
    }

    // DB path: send selected schemas to extension host for Phase 2
    const payload: Record<string, unknown> = { type: 'db-visualize', schemas: Array.from(schemas) };
    if (projectName) payload.projectName = projectName;
    vscodeApi.postMessage(payload);
    setIsLoading(true);
    setLoadingContext('database');
    setStatus({ text: 'Loading selected schemas from database...', type: 'info' });
  }, [vscodeApi, schemaPreview, model, loadingContext]);

  const openFile = useCallback(() => {
    isDemoRef.current = false;
    vscodeApi.postMessage({ type: 'open-dacpac' });
  }, [vscodeApi]);

  const resetToStart = useCallback(() => {
    setModel(null);
    setSchemaPreview(null);
    setSelectedSchemas(new Set());
    setIsLoading(false);
    setLoadingContext(null);
    setFileName(null);
    setFilePath(null);
    setStatus(null);
    setPendingAutoVisualize(false);
    setPendingVisualize(false);
  }, []);

  const loadProject = useCallback((id: string) => {
    isDemoRef.current = false;
    setIsLoading(true);
    setStatus(null);
    setLoadingContext(null); // set when response message type is known
    vscodeApi.postMessage({ type: 'load-project', id });
  }, [vscodeApi]);

  const loadDemo = useCallback(() => {
    isDemoRef.current = true;
    setIsLoading(true);
    setLoadingContext('dacpac');
    setStatus(null);
    vscodeApi.postMessage({ type: 'load-demo' });
  }, [vscodeApi]);

  const connectToDatabase = useCallback(() => {
    isDemoRef.current = false;
    setIsLoading(true);
    setLoadingContext('database');
    setStatus({ text: 'Connecting to database...', type: 'info' });
    vscodeApi.postMessage({ type: 'db-connect' });
  }, [vscodeApi]);

  const cancelLoading = useCallback(() => {
    setIsLoading(false);
    setLoadingContext(null);
    setStatus(null);
  }, []);

  const clearAutoVisualize = useCallback(() => {
    setPendingAutoVisualize(false);
  }, []);

  const clearPendingVisualize = useCallback(() => {
    setPendingVisualize(false);
  }, []);

  const schemas = schemaPreview?.schemas ?? model?.schemas ?? [];

  const toggleSchema = useCallback((name: string) => {
    setSelectedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const selectAllSchemas = useCallback((names: string[]) => {
    setSelectedSchemas(prev => new Set([...prev, ...names]));
  }, []);

  const clearAllSchemas = useCallback((names: string[]) => {
    setSelectedSchemas(prev => {
      const next = new Set(prev);
      names.forEach(n => next.delete(n));
      return next;
    });
  }, []);

  return {
    model, schemaPreview, selectedSchemas, isLoading, loadingContext, fileName, filePath, status,
    mssqlAvailable, pendingAutoVisualize, pendingVisualize, isDemo: isDemoRef.current,
    openFile, resetToStart, loadProject, loadDemo, connectToDatabase, cancelLoading,
    clearAutoVisualize, clearPendingVisualize, visualize,
    toggleSchema, selectAllSchemas, clearAllSchemas,
  };
}
