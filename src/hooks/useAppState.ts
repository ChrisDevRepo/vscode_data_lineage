import { useState, useCallback, useRef } from 'react';
import type { 
  DatabaseModel, ObjectType, FilterState, ExtensionConfig, 
  AnalysisMode, LoadingPhase, AppView 
} from '../engine/types';
import { DEFAULT_CONFIG } from '../engine/types';
import type { Project, FilterProfile, AIViewMetadata } from '../engine/projectStore';

/** Transient AI view — shown as a preview before the user decides to save. */
export interface AiPreview {
  name: string;
  nodeIds: Set<string>;
  aiMetadata: AIViewMetadata;
}

export interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  nodeName: string;
  schema: string;
  externalType?: 'et' | 'file' | 'db';
  externalUrl?: string;
  fullName?: string;
  objectType: ObjectType;
}

export function useAppState(isAutoVisualize: boolean) {
  const [view, setView] = useState<AppView>(isAutoVisualize ? 'visualizing' : 'start');
  const [model, setModel] = useState<DatabaseModel | null>(null);
  const [config, setConfig] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [projects, setProjects] = useState<Project[]>([]);
  const [lastOpenedId, setLastOpenedId] = useState<string | null>(null);
  const [lastWizardView, setLastWizardView] = useState<'main' | 'projects'>('main');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [loadingProjectId, setLoadingProjectId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // VisualizingScreen state
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>('load');
  const [loadingStats, setLoadingStats] = useState<string | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [startScreenMessage, setStartScreenMessage] = useState<string | null>(null);

  // Graph source name (for toolbar/export)
  const [sourceName, setSourceName] = useState<string | null>(isAutoVisualize ? 'AdventureWorks (demo)' : null);

  const [filter, setFilter] = useState<FilterState>({
    schemas: new Set(),
    types: new Set<ObjectType>(['table', 'view', 'procedure', 'function', 'external']),
    searchTerm: '',
    hideIsolated: true,
    focusSchemas: new Set(),
    showExternalRefs: true,
    externalRefTypes: new Set<'file' | 'db'>(['file', 'db']),
    exclusionPatterns: [],
  });

  const [isRebuilding, setIsRebuilding] = useState(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [infoBarNodeId, setInfoBarNodeId] = useState<string | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isDetailSearchOpen, setIsDetailSearchOpen] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode | null>(null);

  const [activeAdvancedProfile, setActiveAdvancedProfile] = useState<FilterProfile | null>(null);
  const [aiPreview, setAiPreview] = useState<AiPreview | null>(null);
  
  // Viewport/Position state for bookmarks
  const [pendingPositions, setPendingPositions] = useState<Record<string, { x: number; y: number }> | undefined>(undefined);
  const [pendingViewport, setPendingViewport] = useState<{ x: number; y: number; zoom: number } | undefined>(undefined);

  return {
    view, setView,
    model, setModel,
    config, setConfig,
    projects, setProjects,
    lastOpenedId, setLastOpenedId,
    lastWizardView, setLastWizardView,
    activeProjectId, setActiveProjectId,
    activeViewId, setActiveViewId,
    loadingProjectId, setLoadingProjectId,
    contextMenu, setContextMenu,
    loadingPhase, setLoadingPhase,
    loadingStats, setLoadingStats,
    loadingError, setLoadingError,
    startScreenMessage, setStartScreenMessage,
    sourceName, setSourceName,
    filter, setFilter,
    isRebuilding, setIsRebuilding,
    highlightedNodeId, setHighlightedNodeId,
    infoBarNodeId, setInfoBarNodeId,
    isDetailOpen, setIsDetailOpen,
    isDetailSearchOpen, setIsDetailSearchOpen,
    analysisMode, setAnalysisMode,
    activeAdvancedProfile, setActiveAdvancedProfile,
    aiPreview, setAiPreview,
    pendingPositions, setPendingPositions,
    pendingViewport, setPendingViewport
  };
}
