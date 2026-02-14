import { useState, useCallback, useRef, useEffect } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';
import type { DacpacModel, SchemaInfo, ExtensionConfig } from '../engine/types';
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
  fileRef: React.RefObject<HTMLInputElement | null>;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
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
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-clear success/info status after 6s — keep warning/error visible
  useEffect(() => {
    if (status && (status.type === 'success' || status.type === 'info')) {
      const timer = setTimeout(() => setStatus(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [status]);

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
      const applyConfig = (msgConfig: Record<string, unknown>) => {
        const cfg: ExtensionConfig = {
          parseRules: (msgConfig.parseRules as ExtensionConfig['parseRules']) || undefined,
          excludePatterns: (msgConfig.excludePatterns as string[]) || [],
          maxNodes: (msgConfig.maxNodes as number) || 250,
          layout: {
            direction: ((msgConfig.layout as Record<string, unknown>)?.direction as 'TB' | 'LR') || 'LR',
            rankSeparation: ((msgConfig.layout as Record<string, unknown>)?.rankSeparation as number) || 120,
            nodeSeparation: ((msgConfig.layout as Record<string, unknown>)?.nodeSeparation as number) || 30,
            edgeAnimation: ((msgConfig.layout as Record<string, unknown>)?.edgeAnimation as boolean) ?? true,
            highlightAnimation: ((msgConfig.layout as Record<string, unknown>)?.highlightAnimation as boolean) ?? false,
            minimapEnabled: ((msgConfig.layout as Record<string, unknown>)?.minimapEnabled as boolean) ?? true,
          },
          edgeStyle: (msgConfig.edgeStyle as ExtensionConfig['edgeStyle']) || 'default',
          trace: {
            defaultUpstreamLevels: ((msgConfig.trace as Record<string, unknown>)?.defaultUpstreamLevels as number) || 3,
            defaultDownstreamLevels: ((msgConfig.trace as Record<string, unknown>)?.defaultDownstreamLevels as number) || 3,
          },
          analysis: {
            hubMinDegree: ((msgConfig.analysis as Record<string, unknown>)?.hubMinDegree as number) || 8,
            islandMaxSize: ((msgConfig.analysis as Record<string, unknown>)?.islandMaxSize as number) || 0,
            longestPathMinNodes: ((msgConfig.analysis as Record<string, unknown>)?.longestPathMinNodes as number) || 5,
          },
        };
        onConfigReceived(cfg);
        if (msgConfig.parseRules) {
          vscodeApi.postMessage({ type: 'log', text: 'Custom parse rules loaded' });
        }
      };

      if (msg?.type === 'config-only') {
        if (msg.config) applyConfig(msg.config);
        return;
      }

      if (msg?.type === 'dacpac-data') {
        if (msg.config) applyConfig(msg.config);
        setIsLoading(true);
        setStatus(null);
        setFileName(msg.fileName || 'dacpac');
        try {
          const buffer = new Uint8Array(msg.data).buffer;
          const result = await extractDacpac(buffer);
          applyModel(result, msg.fileName || 'dacpac', `Parsed: ${result.nodes.length} objects, ${result.edges.length} edges across ${result.schemas.length} schemas`);
        } catch (err) {
          vscodeApi.postMessage({ type: 'error', error: err instanceof Error ? err.message : 'Failed to parse .dacpac' });
          setStatus({ text: err instanceof Error ? err.message : 'Failed to parse .dacpac', type: 'error' });
        } finally {
          setIsLoading(false);
        }
      }
    };

    window.addEventListener('message', handler);
    vscodeApi.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [onConfigReceived, applyModel, vscodeApi]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setStatus(null);
    setModel(null);
    setSelectedSchemas(new Set());
    setFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const result = await extractDacpac(buffer);
      applyModel(result, file.name, `Parsed: ${result.nodes.length} objects, ${result.edges.length} edges across ${result.schemas.length} schemas`);
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : 'Failed to parse .dacpac', type: 'error' });
    } finally {
      setIsLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [applyModel]);

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
    model, selectedSchemas, isLoading, fileName, status,
    fileRef, handleFileChange, loadDemo, toggleSchema, selectAllSchemas, clearAllSchemas,
  };
}
