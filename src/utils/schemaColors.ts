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
 * Primary color palette for light themes, based on Tableau 20.
 * Colors 1–10 are the Tableau 10 base; colors 11–15 are the Tableau 20
 * paired lighter variants for Orange, Green, Pink, Brown, and Gray — the five
 * pairs that remain perceptually distinct from their T10 counterparts in dark mode.
 */
export const SCHEMA_COLORS_LIGHT = [
  '#4E79A7', // 1  Tableau Blue
  '#F28E2B', // 2  Tableau Orange
  '#E15759', // 3  Tableau Red
  '#76B7B2', // 4  Tableau Teal
  '#59A14F', // 5  Tableau Green
  '#EDC948', // 6  Tableau Yellow
  '#B07AA1', // 7  Tableau Purple
  '#FF9DA7', // 8  Tableau Pink
  '#9C755F', // 9  Tableau Brown
  '#BAB0AC', // 10 Tableau Gray
  '#FFBE7D', // 11 T20 Light Orange  (pairs with #F28E2B)
  '#8CD17D', // 12 T20 Light Green   (pairs with #59A14F)
  '#FABFD2', // 13 T20 Light Pink    (pairs with #FF9DA7)
  '#D7B5A6', // 14 T20 Light Brown   (pairs with #9C755F)
  '#CECCCA', // 15 T20 Light Gray    (pairs with #BAB0AC)
];

/**
 * Primary color palette for dark themes.
 * Colors 1–10 are lightened Tableau 10 variants; colors 11–15 are the dark-adapted
 * T20 lighter variants (L ≥ 72%) for Orange, Green, Pink, Brown, and Gray.
 * Blue, Red, Teal, Yellow, and Purple T20 pairs are excluded — their dark-mode
 * variants are indistinguishable from their T10 counterparts at these luminance levels.
 */
const SCHEMA_COLORS_DARK = [
  '#8AB8E6', // 1  Lighter Blue
  '#FFAD5C', // 2  Lighter Orange
  '#FF8A8C', // 3  Lighter Red
  '#A1D6D1', // 4  Lighter Teal
  '#88C580', // 5  Lighter Green
  '#F7E589', // 6  Lighter Yellow
  '#D4A8C7', // 7  Lighter Purple
  '#FFC2C9', // 8  Lighter Pink
  '#C39B82', // 9  Lighter Brown
  '#D9D2CE', // 10 Lighter Gray
  '#FFBE7D', // 11 Light Orange dark (L=74%)
  '#A8DFA0', // 12 Light Green dark  (L=74%, brightened from 65%)
  '#FABFD2', // 13 Light Pink dark   (L=83%)
  '#D7B5A6', // 14 Light Brown dark  (L=74%)
  '#CECCCA', // 15 Light Gray dark   (L=80%)
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

// 30-slot doubled palettes: original 15 + 15 lightness-shifted variants.
const SCHEMA_COLORS_LIGHT_DOUBLE = [
  ...SCHEMA_COLORS_LIGHT,
  ...SCHEMA_COLORS_LIGHT.map(c => shiftL(c, 14)),
];
const SCHEMA_COLORS_DARK_DOUBLE = [
  ...SCHEMA_COLORS_DARK,
  ...SCHEMA_COLORS_DARK.map(c => shiftL(c, -12)),
];

// schemaKey → sorted position; populated by buildSchemaColorMap before any render.
const _colorMap = new Map<string, number>();

/**
 * Assigns each distinct schema a unique palette index by sorted alphabetical position.
 * Matches the Tableau/D3 approach: sequential assignment, never hashing.
 * Call once per graph build, before any `getSchemaColor` call.
 *
 * @param schemas - All schema names from the model (may contain duplicates).
 */
export function buildSchemaColorMap(schemas: string[]): void {
  _colorMap.clear();
  [...new Set(schemas.map(schemaKey))].sort().forEach((key, i) => _colorMap.set(key, i));
}

/**
 * Retrieves a deterministic theme-aware color for a given SQL schema.
 * Uses the sorted position from `buildSchemaColorMap` to guarantee unique colors
 * for up to 30 schemas; cycles the 30-slot palette beyond that.
 *
 * @param schema - The schema name.
 * @param forceLight - If true, ignores the current theme and returns the light variant.
 * @returns A CSS hex color string.
 */
export function getSchemaColor(schema: string, forceLight?: boolean): string {
  const dark = !forceLight && isDarkTheme();
  const palette = dark ? SCHEMA_COLORS_DARK_DOUBLE : SCHEMA_COLORS_LIGHT_DOUBLE;
  const key = schemaKey(schema);
  const idx = _colorMap.has(key) ? _colorMap.get(key)! : Math.abs(hashString(key));
  return palette[idx % palette.length];
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
