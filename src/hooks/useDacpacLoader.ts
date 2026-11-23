import { useState, useCallback, useEffect, useRef } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DatabaseModel, SchemaInfo, SchemaPreview, ExtensionConfig } from '../engine/types';
import { ExtensionToWebviewMsgSchema, validateBridgeFrame } from '../engine/shared/bridgeContract';
import { DEFAULT_CONFIG } from '../engine/types';

/** Status notification shown during project loading or processing. */
type StatusMessage = {
  /** The descriptive text of the status message. */
  text: string;
  /** The semantic type of the message, affecting UI styling (color, icons). */
  type: 'info' | 'success' | 'warning' | 'error';
  /** An error the host classified as transient (the server may still be starting): one automatic retry can succeed. */
  transient?: boolean;
};

/** The source context currently being loaded. */
type LoadingContext = 'dacpac' | 'database' | null;

/**
 * State and actions of the project loader hook, bridging the webview and the extension host for
 * extraction and project lifecycle events.
 */
export interface DacpacLoaderState {
  /** The fully extracted database model (Phase 2 result). */
  model: DatabaseModel | null;
  /** The lightweight schema preview (Phase 1 result). */
  schemaPreview: SchemaPreview | null;
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
  /** Whether the project should immediately visualize upon load (e.g., demo or restore). */
  pendingAutoVisualize: boolean;
  /** Whether the UI should transition to the graph view. */
  pendingVisualize: boolean;
  /** Whether the currently loaded model is the AdventureWorks demo. */
  isDemo: boolean;
  /** The saved project the last `dacpac-model` named as its source; null when it named none. */
  projectId: string | null;
  /** Triggers the VS Code file picker to open a .dacpac. */
  openFile: () => void;
  /** Resets the internal loader state to the starting screen. */
  resetToStart: () => void;
  loadProject: (id: string) => void;
  /** Loads the built-in demo project. */
  loadDemo: () => void;
  connectToDatabase: () => void;
  /** Aborts the current load: tells the host to stop and drops any result it still posts. */
  cancelLoading: () => void;
  clearAutoVisualize: () => void;
  clearPendingVisualize: () => void;
  /** Starts the Phase 2 extraction for the selected schemas. */
  visualize: (selectedSchemas: Set<string>, projectName?: string, projectId?: string) => void;
  toggleSchema: (name: string) => void;
  selectAllSchemas: (names: string[]) => void;
  clearAllSchemas: (names: string[]) => void;
}

/**
 * Orchestrates the project load lifecycle through `postMessage` with the host. Extraction is
 * two-phase for DACPACs and live databases: a schema selector, then the full DDL parse and graph
 * build.
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
  const [pendingAutoVisualize, setPendingAutoVisualize] = useState(false);
  const [pendingVisualize, setPendingVisualize] = useState(false);
  const isDemoRef = useRef(false);
  /**
   * Set once a live database offers its schemas, until the source changes. `loadingContext` clears
   * on an error or a cancel, so `visualize` reads this to send a failed or cancelled database load
   * back to the database, not to the dacpac path.
   */
  const isDatabaseSourceRef = useRef(false);
  const projectIdRef = useRef<string | null>(null);
  /**
   * The last load this webview sent, and whether the user cancelled it. A result naming another
   * load or the cancelled one is dropped; with no load sent yet (fresh webview after reload) or a
   * result naming none, every result applies.
   */
  const loadRef = useRef<{ id: string | null; cancelled: boolean }>({ id: null, cancelled: false });
  /** Names a new load; the id travels on the request and comes back on its results. */
  const beginLoad = useCallback((): string => {
    const id = crypto.randomUUID();
    loadRef.current = { id, cancelled: false };
    return id;
  }, []);
  /**
   * Status auto-clear: transient info messages (progress, connecting, loading) clear 6 s after
   * loading ends; success, warning and error messages stay until the next status replaces them.
   */
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

  const applyModel = useCallback((result: DatabaseModel, name: string) => {
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

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const frame = validateBridgeFrame(ExtensionToWebviewMsgSchema, event.data);
      // `App` listens to the same frames and reports an invalid one; reporting it here too would show two toasts.
      if (!frame.ok) return;
      const msg = frame.data;

      const { id: sentId, cancelled } = loadRef.current;
      if ('loadId' in msg && msg.loadId !== undefined && sentId !== null && (msg.loadId !== sentId || cancelled)) return;

      const applyConfig = (raw: Partial<ExtensionConfig>) => {
        onConfigReceived({
          ...DEFAULT_CONFIG,
          ...raw,
          layout: { ...DEFAULT_CONFIG.layout, ...raw.layout },
          overview: { ...DEFAULT_CONFIG.overview, ...raw.overview },
          trace: { ...DEFAULT_CONFIG.trace, ...raw.trace },
          analysis: { ...DEFAULT_CONFIG.analysis, ...raw.analysis },
        });
      };

      if (msg.type === 'projects-list') {
        return; // Handled at App.tsx level
      }

      if (msg.type === 'last-dacpac-gone') {
        setIsLoading(false);
        setLoadingContext(null);
        setStatus({ text: 'Project file is no longer available.', type: 'error' });
        return;
      }

      if (msg.type === 'db-progress') {
        setStatus({ text: msg.step !== undefined && msg.total !== undefined ? `${msg.label} (${msg.step}/${msg.total})` : msg.label, type: 'info' });
        setLoadingContext('database');
        return;
      }

      if (msg.type === 'db-cancelled') {
        setIsLoading(false);
        setLoadingContext(null);
        setStatus(null);
        return;
      }

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

      if (msg.type === 'dacpac-model') {
        isDemoRef.current = msg.isDemo === true;
        projectIdRef.current = msg.projectId ?? null;
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'dacpac';
        setSchemaPreview(null);  // clear Phase 1 state once Phase 2 model arrives
        applyModel(msg.model as DatabaseModel, name);
        setIsLoading(false);
        setLoadingContext(null);
        if (msg.autoVisualize) {
          setPendingAutoVisualize(true);
        } else {
          setPendingVisualize(true);
        }
        return;
      }

      if (msg.type === 'db-schema-preview') {
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'Database';
        applySchemaPreview(msg.preview, name);
        isDatabaseSourceRef.current = true;
        setIsLoading(false);
        setLoadingContext('database');
        return;
      }

      if (msg.type === 'db-model') {
        projectIdRef.current = msg.projectId ?? null;
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'Database';
        applyModel(msg.model as DatabaseModel, name);
        setIsLoading(false);
        setLoadingContext(null);
        setPendingVisualize(true);
        return;
      }

      if (msg.type === 'db-error') {
        setStatus({ text: msg.message, type: 'error', transient: msg.transient });
        setIsLoading(false);
        setLoadingContext(null);
        return;
      }
    };

    window.addEventListener('message', handler);
    vscodeApi.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [onConfigReceived, applyModel, applySchemaPreview, vscodeApi]);

  const visualize = useCallback((schemas: Set<string>, projectName?: string, projectId?: string) => {
    const named = projectName ? { projectName } : {};
    if (schemaPreview !== null && model === null && !isDatabaseSourceRef.current) {
      vscodeApi.postMessage({ type: 'dacpac-visualize', schemas: Array.from(schemas), ...named, ...(projectId ? { projectId } : {}), loadId: beginLoad() });
      setIsLoading(true);
      setLoadingContext('dacpac');
      return;
    }

    vscodeApi.postMessage({ type: 'db-visualize', schemas: Array.from(schemas), ...named, loadId: beginLoad() });
    setIsLoading(true);
    setLoadingContext('database');
    setStatus({ text: 'Loading selected schemas from database...', type: 'info' });
  }, [vscodeApi, beginLoad, schemaPreview, model]);

  const openFile = useCallback(() => {
    isDemoRef.current = false;
    vscodeApi.postMessage({ type: 'open-dacpac', loadId: beginLoad() });
  }, [vscodeApi, beginLoad]);

  const resetToStart = useCallback(() => {
    isDatabaseSourceRef.current = false;
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
    vscodeApi.postMessage({ type: 'load-project', id, loadId: beginLoad() });
  }, [vscodeApi, beginLoad]);

  const loadDemo = useCallback(() => {
    isDemoRef.current = true;
    setIsLoading(true);
    setLoadingContext('dacpac');
    setStatus(null);
    vscodeApi.postMessage({ type: 'load-demo', loadId: beginLoad() });
  }, [vscodeApi, beginLoad]);

  const connectToDatabase = useCallback(() => {
    isDemoRef.current = false;
    setIsLoading(true);
    setLoadingContext('database');
    setStatus({ text: 'Connecting to database...', type: 'info' });
    vscodeApi.postMessage({ type: 'db-connect', loadId: beginLoad() });
  }, [vscodeApi, beginLoad]);

  const cancelLoading = useCallback(() => {
    const { id } = loadRef.current;
    if (id) {
      loadRef.current = { id, cancelled: true };
      vscodeApi.postMessage({ type: 'cancel-load', loadId: id });
    }
    setIsLoading(false);
    setLoadingContext(null);
    setStatus(null);
  }, [vscodeApi]);

  const clearAutoVisualize = useCallback(() => {
    setPendingAutoVisualize(false);
  }, []);

  const clearPendingVisualize = useCallback(() => {
    setPendingVisualize(false);
  }, []);

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
    pendingAutoVisualize, pendingVisualize, isDemo: isDemoRef.current, projectId: projectIdRef.current,
    openFile, resetToStart, loadProject, loadDemo, connectToDatabase, cancelLoading,
    clearAutoVisualize, clearPendingVisualize, visualize,
    toggleSchema, selectAllSchemas, clearAllSchemas,
  };
}
