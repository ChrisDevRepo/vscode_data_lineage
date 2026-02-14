import type { AnalysisType } from '../engine/types';

export interface AnalysisTypeInfo {
  title: string;
  icon: string;
  description: string;
}

export const ANALYSIS_TYPE_INFO: Record<AnalysisType, AnalysisTypeInfo> = {
  islands: {
    title: 'Islands',
    icon: 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5',
    description: 'Disconnected subgraphs that share no edges with each other.',
  },
  hubs: {
    title: 'Hubs',
    icon: 'M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z',
    description: 'Nodes with the highest number of connections (degree).',
  },
  orphans: {
    title: 'Orphan Nodes',
    icon: 'M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636',
    description: 'Nodes with no connections — zero edges in or out.',
  },
  'longest-path': {
    title: 'Longest Path',
    icon: 'M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3',
    description: 'Deepest dependency chains — the longest paths from source to sink.',
  },
  cycles: {
    title: 'Cycles',
    icon: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182',
    description: 'Circular dependencies where data flows back to its origin.',
  },
};

export const ANALYSIS_TYPE_LABELS: Record<AnalysisType, string> = {
  islands: 'Islands Analysis',
  hubs: 'Hubs Analysis',
  orphans: 'Orphan Nodes Analysis',
  'longest-path': 'Longest Path Analysis',
  cycles: 'Cycle Detection',
};
