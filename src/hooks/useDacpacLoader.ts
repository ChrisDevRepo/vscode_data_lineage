import { useState, useCallback, useEffect, useRef } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DacpacModel, SchemaInfo, ExtensionConfig } from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import { extractDacpac } from '../engine/dacpacExtractor';

export type StatusMessage = {
  text: string;
  type: 'info' | 'success' | 'warning' | 'error';
};

export interface DacpacLoaderState {
  model: DacpacModel | null;
  selectedSchemas: Set<string>;
  isLoading: boolean;
  fileName: string | null;
  status: StatusMessage | null;
  lastDacpacName: string | null;
  openFile: () => void;
  loadLast: () => void;
  loadDemo: () => void;
  toggleSchema: (name: string) => void;
  selectAllSchemas: () => void;
  clearAllSchemas: () => void;
}

export function useDacpacLoader(onConfigReceived: (config: ExtensionConfig) => void): DacpacLoaderState {
  const vscodeApi = useVsCode();
  const [model, setModel] = useState<DacpacModel | null>(null);
  const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [lastDacpacName, setLastDacpacName] = useState<string | null>(null);
  const loadGenRef = useRef(0);

  // Auto-clear success/info status after 6s — keep warning/error visible
  useEffect(() => {
    if (status && (status.type === 'success' || status.type === 'info')) {
      const timer = setTimeout(() => setStatus(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [status]);

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

    vscodeApi.postMessage({ type: 'log', text: statusText });
    if (result.parseStats) {
      vscodeApi.postMessage({ type: 'parse-stats', stats: result.parseStats });
    }
  }, [vscodeApi]);

  // Listen for dacpac-data from VS Code extension host
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
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
        if (raw.parseRules) {
          vscodeApi.postMessage({ type: 'log', text: 'Custom parse rules loaded' });
        }
      };

      if (msg.type === 'config-only') {
        if (msg.config) applyConfig(msg.config);
        if (msg.lastDacpacName) setLastDacpacName(msg.lastDacpacName);
        return;
      }

      if (msg.type === 'last-dacpac-gone') {
        setLastDacpacName(null);
        setStatus({ text: 'Previously opened file is no longer available.', type: 'warning' });
        return;
      }

      if (msg.type === 'dacpac-data') {
        if (msg.config) applyConfig(msg.config);
        const gen = ++loadGenRef.current;
        setIsLoading(true);
        setStatus(null);
        setFileName(msg.fileName || 'dacpac');
        try {
          const buffer = new Uint8Array(msg.data).buffer;
          const result = await extractDacpac(buffer);
          if (gen !== loadGenRef.current) return; // stale load — discard
          applyModel(result, msg.fileName || 'dacpac', `Parsed: ${result.nodes.length} objects, ${result.edges.length} edges across ${result.schemas.length} schemas`, msg.lastSelectedSchemas);
        } catch (err) {
          if (gen !== loadGenRef.current) return; // stale load — discard
          vscodeApi.postMessage({ type: 'error', error: err instanceof Error ? err.message : 'Failed to parse .dacpac' });
          setStatus({ text: err instanceof Error ? err.message : 'Failed to parse .dacpac', type: 'error' });
        } finally {
          if (gen === loadGenRef.current) setIsLoading(false);
        }
      }
    };

    window.addEventListener('message', handler);
    vscodeApi.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [onConfigReceived, applyModel, vscodeApi]);

  const openFile = useCallback(() => {
    vscodeApi.postMessage({ type: 'open-dacpac' });
  }, [vscodeApi]);

  const loadLast = useCallback(() => {
    setIsLoading(true);
    setStatus(null);
    vscodeApi.postMessage({ type: 'load-last-dacpac' });
  }, [vscodeApi]);

  const loadDemo = useCallback(() => {
    setIsLoading(true);
    setStatus(null);
    vscodeApi.postMessage({ type: 'load-demo' });
  }, [vscodeApi]);

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
    model, selectedSchemas, isLoading, fileName, status, lastDacpacName,
    openFile, loadLast, loadDemo, toggleSchema, selectAllSchemas, clearAllSchemas,
  };
}
