import type { ObjectType } from '../engine/types';
import { schemaKey } from './sql';

/**
 * Visual markers (icons) associated with different SQL object types.
 * Used for consistent identification in UI lists and labels.
 */
export const TYPE_COLORS: Record<ObjectType, { icon: string }> = {
  table:     { icon: '■' },
  view:      { icon: '●' },
  procedure: { icon: '▲' },
  function:  { icon: '◆' },
  external:  { icon: '⬡' },
};

/**
 * Human-readable display labels for SQL object types.
 */
export const TYPE_LABELS: Record<ObjectType, string> = {
  table: 'Table',
  view: 'View',
  procedure: 'Stored Procedure',
  function: 'Function',
  external: 'External Table',
};

/**
 * Primary color palette for light themes, based on Tableau 10.
 * Provides high-contrast, vibrant colors for distinct schema identification.
 */
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

/**
 * Primary color palette for dark themes.
 * Uses lightened and desaturated variants of the Tableau 10 palette
 * to maintain visibility and accessibility on dark backgrounds.
 */
const SCHEMA_COLORS_DARK = [
  '#8AB8E6', // Lighter Blue
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

/**
 * Generates a deterministic 32-bit integer hash for a given string.
 * This ensures that the same schema name always resolves to the same color index.
 * 
 * @param str - The input string to hash.
 * @returns A deterministic hash value.
 */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

/**
 * Retrieves a deterministic theme-aware color for a given SQL schema.
 * 
 * @param schema - The schema name.
 * @param forceLight - If true, ignores the current theme and returns the light variant.
 * @returns A CSS hex color string.
 */
export function getSchemaColor(schema: string, forceLight?: boolean): string {
  const colors = forceLight || !isDarkTheme() ? SCHEMA_COLORS_LIGHT : SCHEMA_COLORS_DARK;
  const idx = Math.abs(hashString(schemaKey(schema))) % colors.length;
  return colors[idx];
}

/** Fixed color for virtual external nodes in light theme (e.g., files, cross-DB refs). */
export const VIRTUAL_EXT_COLOR_LIGHT = '#6B7A8D';
/** Fixed color for virtual external nodes in dark theme (e.g., files, cross-DB refs). */
export const VIRTUAL_EXT_COLOR_DARK  = '#94A3B8';

/** 
 * Returns the theme-aware fixed color for virtual external nodes.
 * Virtual nodes use a distinct steel-gray palette to differentiate them from verified schemas.
 * 
 * @returns A CSS hex color string.
 */
export function getVirtualExtColor(): string {
  return isDarkTheme() ? VIRTUAL_EXT_COLOR_DARK : VIRTUAL_EXT_COLOR_LIGHT;
}

/**
 * Mapping of two-letter AI color codes to CSS variables.
 * These variables are themed automatically via --vscode-charts-* tokens.
 */
export const AI_COLOR_HEX: Record<string, string> = {
  bu: 'var(--ln-ai-bu)',
  gn: 'var(--ln-ai-gn)',
  rd: 'var(--ln-ai-rd)',
  ye: 'var(--ln-ai-ye)',
  or: 'var(--ln-ai-or)',
  gy: 'var(--ln-ai-gy)',
};

/**
 * Maps semantic AI roles to their corresponding two-letter color codes.
 */
export const AI_ROLE_TO_COLOR: Record<string, string> = {
  source: 'bu', transform: 'or', target: 'gn',
  good: 'gn', warn: 'ye', fail: 'rd',
  gy: 'gy',
};

/** 
 * Resolves a semantic AI role or a raw color code to a standard two-letter color code.
 * 
 * @param role - The semantic role (e.g., 'source', 'target') or a color code.
 * @returns A valid two-letter color code, defaulting to 'gy' (gray).
 */
export function resolveAiColor(role: string): string {
  return AI_ROLE_TO_COLOR[role] ?? 'gy';
}

/**
 * Mapping of AI color codes to theme-aware glow and shadow CSS variables.
 * Used for highlighting nodes in the graph canvas.
 */
export const AI_COLOR_GLOW: Record<string, { glow: string; shadow: string }> = {
  bu: { glow: 'var(--ln-ai-bu-glow)', shadow: 'var(--ln-ai-bu-shadow)' },
  gn: { glow: 'var(--ln-ai-gn-glow)', shadow: 'var(--ln-ai-gn-shadow)' },
  rd: { glow: 'var(--ln-ai-rd-glow)', shadow: 'var(--ln-ai-rd-shadow)' },
  ye: { glow: 'var(--ln-ai-ye-glow)', shadow: 'var(--ln-ai-ye-shadow)' },
  or: { glow: 'var(--ln-ai-or-glow)', shadow: 'var(--ln-ai-or-shadow)' },
  gy: { glow: 'var(--ln-ai-gy-glow)', shadow: 'var(--ln-ai-gy-shadow)' },
};

/** 
 * Detects if the VS Code environment is currently using a dark or high-contrast theme.
 * This is determined by inspecting the `data-vscode-theme-kind` attribute on the document body.
 * 
 * @returns `true` if a dark theme is active; otherwise `false`.
 */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  const kind = document.body?.dataset?.vscodeThemeKind;
  return kind === 'vscode-dark' || kind === 'vscode-high-contrast';
}
