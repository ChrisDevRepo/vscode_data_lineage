import { useState, useCallback, useEffect, useRef } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DacpacModel, SchemaInfo, ExtensionConfig, ExtensionMessage } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import { extractDacpac } from '../engine/dacpacExtractor';

export type StatusMessage = {
  text: string;
  type: 'info' | 'success' | 'warning' | 'error';
};

export type LoadingContext = 'dacpac' | 'database' | null;

export interface DacpacLoaderState {
  model: DacpacModel | null;
  selectedSchemas: Set<string>;
  isLoading: boolean;
  loadingContext: LoadingContext;
  fileName: string | null;
  status: StatusMessage | null;
  lastDacpacName: string | null;
  lastDbSourceName: string | null;
  mssqlAvailable: boolean | null;
  pendingAutoVisualize: boolean;
  openFile: () => void;
  resetToStart: () => void;
  loadLast: () => void;
  loadDemo: () => void;
  connectToDatabase: () => void;
  cancelLoading: () => void;
  clearAutoVisualize: () => void;
  toggleSchema: (name: string) => void;
  selectAllSchemas: () => void;
  clearAllSchemas: () => void;
}

export function useDacpacLoader(onConfigReceived: (config: ExtensionConfig) => void): DacpacLoaderState {
  const vscodeApi = useVsCode();
  const [model, setModel] = useState<DacpacModel | null>(null);
  const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [loadingContext, setLoadingContext] = useState<LoadingContext>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [lastDacpacName, setLastDacpacName] = useState<string | null>(null);
  const [lastDbSourceName, setLastDbSourceName] = useState<string | null>(null);
  const [mssqlAvailable, setMssqlAvailable] = useState<boolean | null>(null);
  const [pendingAutoVisualize, setPendingAutoVisualize] = useState(false);
  const loadGenRef = useRef(0);

  // Auto-clear success/info status after 6s — keep warning/error visible, skip during active loading
  useEffect(() => {
    if (status && (status.type === 'success' || status.type === 'info') && !isLoading) {
      const timer = setTimeout(() => setStatus(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [status, isLoading]);

  const applyModel = useCallback((result: DacpacModel, name: string, statusText: string, savedSchemas?: string[]) => {
    setModel(result);
    const available = result.schemas.map((s: SchemaInfo) => s.name);
    if (savedSchemas && savedSchemas.length > 0) {
      const availableSet = new Set(available);
      setSelectedSchemas(new Set(savedSchemas.filter(s => availableSet.has(s))));
    } else {
      setSelectedSchemas(new Set(available));
    }
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
        if (msg.lastDacpacName) setLastDacpacName(msg.lastDacpacName);
        if (msg.lastDbSourceName) setLastDbSourceName(msg.lastDbSourceName);
        return;
      }

      if (msg.type === 'last-dacpac-gone') {
        setLastDacpacName(null);
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

      // DB model received — same flow as dacpac
      if (msg.type === 'db-model') {
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'Database';
        setLastDbSourceName(name);
        applyModel(msg.model, name, `Loaded from ${name}: ${msg.model.nodes.length} objects, ${msg.model.edges.length} edges`, msg.lastSelectedSchemas);
        setIsLoading(false);
        setLoadingContext(null);
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
        setFileName(msg.fileName || 'dacpac');
        try {
          const buffer = new Uint8Array(msg.data).buffer;
          const result = await extractDacpac(buffer);
          if (gen !== loadGenRef.current) return; // stale load — discard
          applyModel(result, msg.fileName || 'dacpac', `Parsed: ${result.nodes.length} objects, ${result.edges.length} edges across ${result.schemas.length} schemas`, msg.lastSelectedSchemas);
          if (msg.autoVisualize) {
            setPendingAutoVisualize(true);
          }
        } catch (err) {
          if (gen !== loadGenRef.current) return; // stale load — discard
          vscodeApi.postMessage({ type: 'error', error: err instanceof Error ? err.message : 'Failed to parse .dacpac' });
          setStatus({ text: err instanceof Error ? err.message : 'Failed to parse .dacpac', type: 'error' });
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
  }, [onConfigReceived, applyModel, vscodeApi]);

  const openFile = useCallback(() => {
    vscodeApi.postMessage({ type: 'open-dacpac' });
  }, [vscodeApi]);

  const resetToStart = useCallback(() => {
    setModel(null);
    setSelectedSchemas(new Set());
    setFileName(null);
    setStatus(null);
  }, []);

  const loadLast = useCallback(() => {
    setIsLoading(true);
    setLoadingContext('dacpac');
    setStatus(null);
    vscodeApi.postMessage({ type: 'load-last-dacpac' });
  }, [vscodeApi]);

  const loadDemo = useCallback(() => {
    setIsLoading(true);
    setLoadingContext('dacpac');
    setStatus(null);
    vscodeApi.postMessage({ type: 'load-demo' });
  }, [vscodeApi]);

  const connectToDatabase = useCallback(() => {
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

  const toggleSchema = useCallback((name: string) => {
    setSelectedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const selectAllSchemas = useCallback(() => {
    if (model) setSelectedSchemas(new Set(model.schemas.map((s) => s.name)));
  }, [model]);

  const clearAllSchemas = useCallback(() => {
    setSelectedSchemas(new Set());
  }, []);

  return {
    model, selectedSchemas, isLoading, loadingContext, fileName, status, lastDacpacName, lastDbSourceName,
    mssqlAvailable, pendingAutoVisualize,
    openFile, resetToStart, loadLast, loadDemo, connectToDatabase, cancelLoading, clearAutoVisualize,
    toggleSchema, selectAllSchemas, clearAllSchemas,
  };
}
