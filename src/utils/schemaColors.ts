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
 * 15-entry categorical color palette for light themes.
 * Colors 1–10 are saturated base hues; colors 11–15 are lighter variants
 * for Orange, Green, Pink, Brown, and Gray.
 */
export const SCHEMA_COLORS_LIGHT = [
  '#4E79A7', // 1  Blue
  '#F28E2B', // 2  Orange
  '#E15759', // 3  Red
  '#76B7B2', // 4  Teal
  '#59A14F', // 5  Green
  '#EDC948', // 6  Yellow
  '#B07AA1', // 7  Purple
  '#FF9DA7', // 8  Pink
  '#9C755F', // 9  Brown
  '#BAB0AC', // 10 Gray
  '#FFBE7D', // 11 Light Orange
  '#8CD17D', // 12 Light Green
  '#FABFD2', // 13 Light Pink
  '#D7B5A6', // 14 Light Brown
  '#CECCCA', // 15 Light Gray
];

/**
 * 15-entry categorical color palette for dark themes.
 * Colors 1–10 are brightened base hues; colors 11–15 are lighter variants
 * for Orange, Green, Pink, Brown, and Gray at L ≥ 72%.
 * Blue, Red, Teal, Yellow, and Purple lighter variants are excluded — their
 * dark-mode versions are indistinguishable from the base hues at these luminance levels.
 */
const SCHEMA_COLORS_DARK = [
  '#8AB8E6', // 1  Blue
  '#FFAD5C', // 2  Orange
  '#FF8A8C', // 3  Red
  '#A1D6D1', // 4  Teal
  '#88C580', // 5  Green
  '#F7E589', // 6  Yellow
  '#D4A8C7', // 7  Purple
  '#FFC2C9', // 8  Pink
  '#C39B82', // 9  Brown
  '#D9D2CE', // 10 Gray
  '#FFBE7D', // 11 Light Orange (L=74%)
  '#A8DFA0', // 12 Light Green  (L=74%)
  '#FABFD2', // 13 Light Pink   (L=83%)
  '#D7B5A6', // 14 Light Brown  (L=74%)
  '#CECCCA', // 15 Light Gray   (L=80%)
];

/**
 * Generates a deterministic 32-bit integer hash for a given string.
 * This ensures that the same schema name always resolves to the same color index.
 *
 * @param str - The input string to hash.
 * @returns A deterministic hash value.
 */
export function hashString(str: string): number {
  let hash = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
    hash |= 0;
  }
  return hash;
}

// Shifts the lightness of a hex color by `delta` percentage points.
function shiftL(hex: string, delta: number): string {
  const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0; const l = (max+min)/2;
  if (max !== min) {
    const d = max-min; s = l>0.5 ? d/(2-max-min) : d/(max+min);
    if (max===r) h=((g-b)/d+(g<b?6:0))/6;
    else if (max===g) h=((b-r)/d+2)/6;
    else h=((r-g)/d+4)/6;
  }
  const nl = Math.max(0.08, Math.min(0.92, l+delta/100));
  const q = nl<0.5 ? nl*(1+s) : nl+s-nl*s, p = 2*nl-q;
  const c = (t: number) => { if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
  return '#'+[h+1/3,h,h-1/3].map(t=>Math.round(c(t)*255).toString(16).padStart(2,'0')).join('');
}

// 30-slot palettes: base 15 + 15 lightness-shifted variants, computed once at module load.
const SCHEMA_COLORS_LIGHT_EXT = [
  ...SCHEMA_COLORS_LIGHT,
  ...SCHEMA_COLORS_LIGHT.map(c => shiftL(c, 14)),
];
const SCHEMA_COLORS_DARK_EXT = [
  ...SCHEMA_COLORS_DARK,
  ...SCHEMA_COLORS_DARK.map(c => shiftL(c, -12)),
];

/**
 * Retrieves a deterministic theme-aware color for a given SQL schema.
 * Hashes the schema name (FNV-1a) into a 30-slot palette — the base 15 colors
 * plus 15 lightness-shifted variants. The same schema name always produces the
 * same color regardless of how many other schemas are loaded.
 *
 * @param schema - The schema name.
 * @param forceLight - If true, ignores the current theme and returns the light variant.
 * @returns A CSS hex color string.
 */
export function getSchemaColor(schema: string, forceLight?: boolean): string {
  const dark = !forceLight && isDarkTheme();
  const palette = dark ? SCHEMA_COLORS_DARK_EXT : SCHEMA_COLORS_LIGHT_EXT;
  return palette[Math.abs(hashString(schemaKey(schema))) % palette.length];
}

/** Fixed color for external nodes in light theme — applies to all `type === 'external'` (catalog ET, file, cross-DB). */
export const EXTERNAL_NODE_COLOR_LIGHT = '#6B7A8D';
/** Fixed color for external nodes in dark theme — applies to all `type === 'external'` (catalog ET, file, cross-DB). */
export const EXTERNAL_NODE_COLOR_DARK  = '#94A3B8';

/**
 * Returns the theme-aware fixed color for external nodes.
 * All externals (catalog `et`, virtual `file`, virtual `db`) share this steel-gray to keep the
 * "external system" category visually distinct from real schemas in both light and dark themes.
 *
 * @returns A CSS hex color string.
 */
export function getExternalNodeColor(): string {
  return isDarkTheme() ? EXTERNAL_NODE_COLOR_DARK : EXTERNAL_NODE_COLOR_LIGHT;
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
