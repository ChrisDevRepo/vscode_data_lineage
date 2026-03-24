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

export interface DacpacLoaderState {
  model: DacpacModel | null;
  schemaPreview: SchemaPreview | null;
  selectedSchemas: Set<string>;
  isLoading: boolean;
  loadingContext: LoadingContext;
  fileName: string | null;
  filePath: string | null;
  status: StatusMessage | null;
  mssqlAvailable: boolean | null;
  pendingAutoVisualize: boolean;
  pendingVisualize: boolean;
  openFile: () => void;
  resetToStart: () => void;
  loadProject: (id: string) => void;
  loadDemo: () => void;
  connectToDatabase: () => void;
  cancelLoading: () => void;
  clearAutoVisualize: () => void;
  clearPendingVisualize: () => void;
  visualize: (selectedSchemas: Set<string>, projectName?: string) => void;
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
  const [filePath, setFilePath] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [mssqlAvailable, setMssqlAvailable] = useState<boolean | null>(null);
  const [pendingAutoVisualize, setPendingAutoVisualize] = useState(false);
  const [pendingVisualize, setPendingVisualize] = useState(false);
  const isDemoRef = useRef(false);
  const loadGenRef = useRef(0);
  const cachedElementsRef = useRef<XmlElement[] | null>(null);

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

  const applyModel = useCallback((result: DacpacModel, name: string, statusText: string) => {
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

      // DB Phase 1: schema preview received (Create flow — shows schema selector)
      if (msg.type === 'db-schema-preview') {
        if (msg.config) applyConfig(msg.config);
        const name = msg.sourceName || 'Database';
        cachedElementsRef.current = null;
        applySchemaPreview(msg.preview, name);
        setIsLoading(false);
        setLoadingContext(null);
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

      if (msg.type === 'dacpac-data') {
        if (msg.config) applyConfig(msg.config);
        const gen = ++loadGenRef.current;
        setIsLoading(true);
        setLoadingContext('dacpac');
        setStatus(null);
        const name = msg.fileName || 'dacpac';
        setFileName(name);
        setFilePath(msg.filePath ?? null);
        try {
          const buffer = new Uint8Array(msg.data).buffer;

          if (msg.autoVisualize) {
            // Demo path: full extraction, bypass schema selector
            const result = await extractDacpac(buffer);
            if (gen !== loadGenRef.current) return;
            cachedElementsRef.current = null;
            applyModel(result, name, `Parsed: ${result.nodes.length} objects, ${result.edges.length} edges across ${result.schemas.length} schemas`);
            setPendingAutoVisualize(true);
          } else if (msg.preselectedSchemas && msg.preselectedSchemas.length > 0) {
            // Load-project path: skip schema selector, run Phase 2 immediately
            const { elements } = await extractSchemaPreview(buffer);
            if (gen !== loadGenRef.current) return;
            cachedElementsRef.current = null;
            const result = extractDacpacFiltered(elements, new Set(msg.preselectedSchemas));
            applyModel(result, name, `Loaded ${result.nodes.length} objects, ${result.edges.length} edges`);
            setPendingVisualize(true);
          } else {
            // Create-flow path: Phase 1 — show schema selector
            const { preview, elements } = await extractSchemaPreview(buffer);
            if (gen !== loadGenRef.current) return;
            cachedElementsRef.current = elements;
            applySchemaPreview(preview, name);
          }
        } catch (err) {
          if (gen !== loadGenRef.current) return;
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
  const visualize = useCallback((schemas: Set<string>, projectName?: string) => {
    // Dacpac path: use cached elements from Phase 1
    if (cachedElementsRef.current) {
      setIsLoading(true);
      setLoadingContext('dacpac');
      const gen = ++loadGenRef.current;
      try {
        const result = extractDacpacFiltered(cachedElementsRef.current, schemas);
        if (gen !== loadGenRef.current) return;
        setModel(result);
        cachedElementsRef.current = null;

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
    const payload: Record<string, unknown> = { type: 'db-visualize', schemas: Array.from(schemas) };
    if (projectName) payload.projectName = projectName;
    vscodeApi.postMessage(payload);
    setIsLoading(true);
    setLoadingContext('database');
    setStatus({ text: 'Loading selected schemas from database...', type: 'info' });
  }, [vscodeApi]);

  const openFile = useCallback(() => {
    isDemoRef.current = false;
    vscodeApi.postMessage({ type: 'open-dacpac' });
  }, [vscodeApi]);

  const resetToStart = useCallback(() => {
    ++loadGenRef.current;
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
    cachedElementsRef.current = null;
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
    ++loadGenRef.current;
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

  const selectAllSchemas = useCallback(() => {
    setSelectedSchemas(new Set(schemas.map((s) => s.name)));
  }, [schemas]);

  const clearAllSchemas = useCallback(() => {
    setSelectedSchemas(new Set());
  }, []);

  return {
    model, schemaPreview, selectedSchemas, isLoading, loadingContext, fileName, filePath, status,
    mssqlAvailable, pendingAutoVisualize, pendingVisualize,
    openFile, resetToStart, loadProject, loadDemo, connectToDatabase, cancelLoading,
    clearAutoVisualize, clearPendingVisualize, visualize,
    toggleSchema, selectAllSchemas, clearAllSchemas,
  };
}
