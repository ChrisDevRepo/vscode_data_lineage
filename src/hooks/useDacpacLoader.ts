import { useState, useCallback, useEffect, useRef } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DacpacModel, SchemaInfo, SchemaPreview, ExtensionConfig, ExtensionMessage, XmlElement } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import { extractDacpac, extractSchemaPreview, extractDacpacFiltered } from '../engine/dacpacExtractor';

export type StatusMessage = {
  text: string;
  type: 'info' | 'success' | 'warning' | 'error';
};

export type LoadingContext = 'dacpac' | 'database' | null;

export type LastSource = { type: 'dacpac' | 'database'; name: string };

export interface DacpacLoaderState {
  model: DacpacModel | null;
  schemaPreview: SchemaPreview | null;
  selectedSchemas: Set<string>;
  isLoading: boolean;
  loadingContext: LoadingContext;
  fileName: string | null;
  status: StatusMessage | null;
  lastSource: LastSource | null;
  mssqlAvailable: boolean | null;
  pendingAutoVisualize: boolean;
  pendingVisualize: boolean;
  isDemo: boolean;
  openFile: () => void;
  resetToStart: () => void;
  reopenLast: () => void;
  loadDemo: () => void;
  connectToDatabase: () => void;
  cancelLoading: () => void;
  clearAutoVisualize: () => void;
  clearPendingVisualize: () => void;
  visualize: (selectedSchemas: Set<string>) => void;
  toggleSchema: (name: string) => void;
  selectAllSchemas: () => void;
  clearAllSchemas: () => void;
}

export function useDacpacLoader(onConfigReceived: (config: ExtensionConfig) => void): DacpacLoaderState {
  const vscodeApi = useVsCode();
  const [model, setModel] = useState<DacpacModel | null>(null);
  const [schemaPreview, setSchemaPreview] = useState<SchemaPreview | null>(null);
  const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [loadingContext, setLoadingContext] = useState<LoadingContext>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [lastSource, setLastSource] = useState<LastSource | null>(null);
  const [mssqlAvailable, setMssqlAvailable] = useState<boolean | null>(null);
  const [pendingAutoVisualize, setPendingAutoVisualize] = useState(false);
  const [pendingVisualize, setPendingVisualize] = useState(false);
  const isDemoRef = useRef(false);
  const loadGenRef = useRef(0);
  const cachedElementsRef = useRef<XmlElement[] | null>(null);

  // Auto-clear success/info status after 6s — keep warning/error visible, skip during active loading
  useEffect(() => {
    if (status && (status.type === 'success' || status.type === 'info') && !isLoading) {
      const timer = setTimeout(() => setStatus(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [status, isLoading]);

  /** Restore schema selection: all available selected, minus previously-deselected ones that still exist */
  const restoreSchemaSelection = useCallback((available: string[], deselected?: string[]) => {
    if (deselected && deselected.length > 0) {
      const deselectedSet = new Set(deselected);
      setSelectedSchemas(new Set(available.filter(s => !deselectedSet.has(s))));
    } else {
      setSelectedSchemas(new Set(available));
    }
  }, []);

  const applySchemaPreview = useCallback((preview: SchemaPreview, name: string, deselected?: string[]) => {
    setSchemaPreview(preview);
    const available = preview.schemas.map((s: SchemaInfo) => s.name);
    restoreSchemaSelection(available, deselected);
    setFileName(name);

    if (preview.warnings && preview.warnings.length > 0) {
      setStatus({ text: preview.warnings[0], type: 'warning' });
    } else {
      const s = preview.schemas.length !== 1 ? 's' : '';
      setStatus({ text: `Found ${preview.totalObjects} objects across ${preview.schemas.length} schema${s}`, type: 'success' });
    }
  }, [restoreSchemaSelection]);

  const applyModel = useCallback((result: DacpacModel, name: string, statusText: string, deselected?: string[]) => {
    setModel(result);
    const available = result.schemas.map((s: SchemaInfo) => s.name);
    restoreSchemaSelection(available, deselected);
    setFileName(name);

    if (result.warnings && result.warnings.length > 0) {
      setStatus({ text: result.warnings[0], type: 'warning' });
    } else if (result.nodes.length === 0) {
      setStatus({ text: 'No tables, views, or stored procedures found.', type: 'warning' });
    } else {
      const s = result.schemas.length !== 1 ? 's' : '';
      setStatus({ text: `Loaded ${result.nodes.length} objects across ${result.schemas.length} schema${s}`, type: 'success' });
    }

    if (result.parseStats) {
      vscodeApi.postMessage({
        type: 'parse-stats',
        stats: result.parseStats,
        objectCount: result.nodes.length,
        edgeCount: result.edges.length,
        schemaCount: result.schemas.length,
      });
    } else {
      vscodeApi.postMessage({ type: 'log', text: statusText });
    }
  }, [vscodeApi]);

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
        // Extension host sends a well-typed ExtensionConfigMessage; apply defaults for safety
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
        if (msg.lastSource) setLastSource(msg.lastSource);
        return;
      }

      if (msg.type === 'last-dacpac-gone') {
        setLastSource(null);
        setIsLoading(false);
        setLoadingContext(null);
        setStatus({ text: 'Previously opened file is no longer available.', type: 'warning' });
        return;
      }

      // MSSQL extension availability
      if (msg.type === 'mssql-status') {
        setMssqlAvailable(msg.available);
        return;
      }

      // DB connection progress
      if (msg.type === 'db-progress') {
        setStatus({ text: `Querying database: ${msg.label} (${msg.step}/${msg.total})...`, type: 'info' });
        return;
      }

      // DB connection cancelled by user (picker dismissed or native Cancel clicked)
      if (msg.type === 'db-cancelled') {
        setIsLoading(false);
        setLoadingContext(null);
        setStatus(null);
        return;
      }

      // DB Phase 1: schema preview received
      if (msg.type === 'db-schema-preview') {
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'Database';
        setLastSource({ type: 'database', name });
        cachedElementsRef.current = null; // DB path doesn't use element cache
        applySchemaPreview(msg.preview, name, msg.lastDeselectedSchemas);
        setIsLoading(false);
        setLoadingContext(null);
        return;
      }

      // DB Phase 2: full model received (also used by fallback full extraction)
      if (msg.type === 'db-model') {
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'Database';
        setLastSource({ type: 'database', name });
        applyModel(msg.model, name, `Loaded from ${name}: ${msg.model.nodes.length} objects, ${msg.model.edges.length} edges`, msg.lastDeselectedSchemas);
        setIsLoading(false);
        setLoadingContext(null);
        // If this was triggered by Phase 2 visualize, signal completion
        setPendingVisualize(true);
        return;
      }

      // DB connection error
      if (msg.type === 'db-error') {
        setStatus({ text: msg.message, type: 'error' });
        setIsLoading(false);
        setLoadingContext(null);
        return;
      }

      if (msg.type === 'dacpac-data') {
        if (msg.config) applyConfig(msg.config);
        const gen = ++loadGenRef.current;
        setIsLoading(true);
        setLoadingContext('dacpac');
        setStatus(null);
        const name = msg.fileName || 'dacpac';
        setFileName(name);
        setLastSource({ type: 'dacpac', name });
        try {
          const buffer = new Uint8Array(msg.data).buffer;

          if (msg.autoVisualize) {
            // autoVisualize (demo): bypass Phase 1, do full extraction immediately
            const result = await extractDacpac(buffer);
            if (gen !== loadGenRef.current) return;
            cachedElementsRef.current = null;
            applyModel(result, msg.fileName || 'dacpac', `Parsed: ${result.nodes.length} objects, ${result.edges.length} edges across ${result.schemas.length} schemas`, msg.lastDeselectedSchemas);
            setPendingAutoVisualize(true);
          } else {
            // Phase 1: lightweight schema preview
            const { preview, elements } = await extractSchemaPreview(buffer);
            if (gen !== loadGenRef.current) return;
            cachedElementsRef.current = elements;
            applySchemaPreview(preview, msg.fileName || 'dacpac', msg.lastDeselectedSchemas);
          }
        } catch (err) {
          if (gen !== loadGenRef.current) return; // stale load — discard
          vscodeApi.postMessage({ type: 'error', error: err instanceof Error ? err.message : 'Failed to parse file' });
          setStatus({ text: err instanceof Error ? err.message : 'Failed to parse file', type: 'error' });
        } finally {
          if (gen === loadGenRef.current) {
            setIsLoading(false);
            setLoadingContext(null);
          }
        }
      }
    };

    window.addEventListener('message', handler);
    vscodeApi.postMessage({ type: 'ready' });
    vscodeApi.postMessage({ type: 'check-mssql' });
    return () => window.removeEventListener('message', handler);
  }, [onConfigReceived, applyModel, applySchemaPreview, vscodeApi]);

  // Phase 2: trigger full extraction for selected schemas
  const visualize = useCallback((schemas: Set<string>) => {
    // Dacpac path: use cached elements from Phase 1
    if (cachedElementsRef.current) {
      setIsLoading(true);
      setLoadingContext('dacpac');
      const gen = ++loadGenRef.current;
      try {
        const result = extractDacpacFiltered(cachedElementsRef.current, schemas);
        if (gen !== loadGenRef.current) return;
        setModel(result);
        cachedElementsRef.current = null; // Free memory

        if (result.parseStats) {
          vscodeApi.postMessage({
            type: 'parse-stats',
            stats: result.parseStats,
            objectCount: result.nodes.length,
            edgeCount: result.edges.length,
            schemaCount: result.schemas.length,
          });
        }

        setIsLoading(false);
        setLoadingContext(null);
        setPendingVisualize(true);
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        setStatus({ text: err instanceof Error ? err.message : 'Phase 2 extraction failed', type: 'error' });
        setIsLoading(false);
        setLoadingContext(null);
      }
      return;
    }

    // DB path: send selected schemas to extension host for Phase 2
    vscodeApi.postMessage({ type: 'db-visualize', schemas: Array.from(schemas) });
    setIsLoading(true);
    setLoadingContext('database');
    setStatus({ text: 'Loading selected schemas from database...', type: 'info' });
  }, [vscodeApi]);

  const openFile = useCallback(() => {
    isDemoRef.current = false;
    vscodeApi.postMessage({ type: 'open-dacpac' });
  }, [vscodeApi]);

  const resetToStart = useCallback(() => {
    ++loadGenRef.current; // Invalidate any in-flight extractions
    setModel(null);
    setSchemaPreview(null);
    setSelectedSchemas(new Set());
    setIsLoading(false);
    setLoadingContext(null);
    setFileName(null);
    setStatus(null);
    setPendingAutoVisualize(false);
    setPendingVisualize(false);
    cachedElementsRef.current = null;
  }, []);

  const reopenLast = useCallback(() => {
    if (!lastSource) return;
    isDemoRef.current = false;
    setIsLoading(true);
    setStatus(null);
    if (lastSource.type === 'dacpac') {
      setLoadingContext('dacpac');
      vscodeApi.postMessage({ type: 'load-last-dacpac' });
    } else {
      setLoadingContext('database');
      setStatus({ text: 'Reconnecting to database...', type: 'info' });
      vscodeApi.postMessage({ type: 'db-reconnect' });
    }
  }, [vscodeApi, lastSource]);

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
    ++loadGenRef.current; // Invalidate any in-flight extractions
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

  // Schema selection uses schemaPreview (Phase 1) or model (Phase 2 / fallback)
  const schemas = schemaPreview?.schemas ?? model?.schemas ?? [];

  const toggleSchema = useCallback((name: string) => {
    setSelectedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const selectAllSchemas = useCallback(() => {
    setSelectedSchemas(new Set(schemas.map((s) => s.name)));
  }, [schemas]);

  const clearAllSchemas = useCallback(() => {
    setSelectedSchemas(new Set());
  }, []);

  return {
    model, schemaPreview, selectedSchemas, isLoading, loadingContext, fileName, status, lastSource,
    mssqlAvailable, pendingAutoVisualize, pendingVisualize, isDemo: isDemoRef.current,
    openFile, resetToStart, reopenLast, loadDemo, connectToDatabase, cancelLoading,
    clearAutoVisualize, clearPendingVisualize, visualize,
    toggleSchema, selectAllSchemas, clearAllSchemas,
  };
}
