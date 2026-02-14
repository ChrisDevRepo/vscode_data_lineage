import type { ObjectType } from '../engine/types';

export const TYPE_COLORS: Record<ObjectType, {
  bg: string;       // Light mode node background
  bgDark: string;   // Dark mode node background
  border: string;   // Border + badge color (same in both modes)
  text: string;     // Light mode text
  textDark: string; // Dark mode text
  icon: string;
}> = {
  table:     { bg: '#eff6ff', bgDark: '#1e3a5f', border: '#3b82f6', text: '#1e40af', textDark: '#93c5fd', icon: '■' },
  view:      { bg: '#f0fdf4', bgDark: '#14352a', border: '#22c55e', text: '#166534', textDark: '#86efac', icon: '●' },
  procedure: { bg: '#fefce8', bgDark: '#422006', border: '#eab308', text: '#854d0e', textDark: '#fde047', icon: '▲' },
  function:  { bg: '#fff7ed', bgDark: '#431407', border: '#f97316', text: '#9a3412', textDark: '#fdba74', icon: '◆' },
};

export const TYPE_LABELS: Record<ObjectType, string> = {
  table: 'Table',
  view: 'View',
  procedure: 'Stored Procedure',
  function: 'Function',
};

// ─── Tableau 10 color palette (official colors) ─────────────────────────────
// Light theme: Use original Tableau 10 colors (vibrant, high contrast)
// Dark theme: Use lightened variants for better visibility on dark backgrounds

export const SCHEMA_COLORS_LIGHT = [
  '#4E79A7', // Tableau Blue
  '#F28E2B', // Tableau Orange  
  '#E15759', // Tableau Red
  '#76B7B2', // Tableau Teal
  '#59A14F', // Tableau Green
  '#EDC948', // Tableau Yellow
  '#B07AA1', // Tableau Purple
  '#FF9DA7', // Tableau Pink
  '#9C755F', // Tableau Brown
  '#BAB0AC', // Tableau Gray
];

// Dark theme: Lightened and desaturated for better contrast on dark backgrounds
const SCHEMA_COLORS_DARK = [
  '#8AB8E6', // Lighter Blue (more visible on dark)
  '#FFAD5C', // Lighter Orange
  '#FF8A8C', // Lighter Red  
  '#A1D6D1', // Lighter Teal
  '#88C580', // Lighter Green
  '#F7E589', // Lighter Yellow
  '#D4A8C7', // Lighter Purple
  '#FFC2C9', // Lighter Pink
  '#C39B82', // Lighter Brown
  '#D9D2CE', // Lighter Gray
];

/** Deterministic hash so the same schema always gets the same color */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 32-bit integer
  }
  return hash;
}

export function getSchemaColor(schema: string): string {
  const colors = isDarkTheme() ? SCHEMA_COLORS_DARK : SCHEMA_COLORS_LIGHT;
  const idx = Math.abs(hashString(schema)) % colors.length;
  return colors[idx];
}

/** Detect if VS Code is running a dark theme */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  const kind = document.body?.dataset?.vscodeThemeKind;
  return kind === 'vscode-dark' || kind === 'vscode-high-contrast';
}
