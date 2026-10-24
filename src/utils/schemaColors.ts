import type { ObjectType } from '../engine/types';
import { schemaKey } from './sql';

/** Visual markers (icons) associated with different SQL object types. Used for consistent identification in UI lists and labels. */
export const TYPE_COLORS: Record<ObjectType, { icon: string }> = {
  table:     { icon: '■' },
  view:      { icon: '●' },
  procedure: { icon: '▲' },
  function:  { icon: '◆' },
  external:  { icon: '⬡' },
};

/** Human-readable display labels for SQL object types. */
export const TYPE_LABELS: Record<ObjectType, string> = {
  table: 'Table',
  view: 'View',
  procedure: 'Stored Procedure',
  function: 'Function',
  external: 'External Table',
};

/** Abbreviated type labels for compact UI surfaces (picker, badges). */
export const SHORT_TYPE_LABELS: Record<ObjectType, string> = {
  table: 'Table',
  view: 'View',
  procedure: 'SP',
  function: 'Fn',
  external: 'Ext',
};

/** 15-entry categorical color palette for light themes. Colors 1–10 are saturated base hues; colors 11–15 are lighter variants for Orange, Green, Pink, Brown, and Gray. */
export const SCHEMA_COLORS_LIGHT = [
  '#4E79A7',
  '#F28E2B',
  '#E15759',
  '#76B7B2',
  '#59A14F',
  '#EDC948',
  '#B07AA1',
  '#FF9DA7',
  '#9C755F',
  '#BAB0AC',
  '#FFBE7D',
  '#8CD17D',
  '#FABFD2',
  '#D7B5A6',
  '#CECCCA',
];

/** 15-entry categorical color palette for dark themes. Colors 1–10 are brightened base hues; colors 11–15 are lighter variants for Orange, Green, Pink, Brown, and Gray at L ≥ 72%. Blue, Red, Teal, Yellow, and Purple lighter variants are excluded — their dark-mode versions are indistinguishable from the base hues at these luminance levels. */
const SCHEMA_COLORS_DARK = [
  '#8AB8E6',
  '#FFAD5C',
  '#FF8A8C',
  '#A1D6D1',
  '#88C580',
  '#F7E589',
  '#D4A8C7',
  '#FFC2C9',
  '#C39B82',
  '#D9D2CE',
  '#FFBE7D',
  '#A8DFA0',
  '#FABFD2',
  '#D7B5A6',
  '#CECCCA',
];

/** Generates a deterministic 32-bit integer hash for a given string. This ensures that the same schema name always resolves to the same color index. */
function hashString(str: string): number {
  let hash = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
    hash >>>= 0;
  }
  return mix32(hash);
}

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

const SCHEMA_COLORS_LIGHT_EXT = [
  ...SCHEMA_COLORS_LIGHT,
  ...SCHEMA_COLORS_LIGHT.map(c => shiftL(c, 14)),
];
const SCHEMA_COLORS_DARK_EXT = [
  ...SCHEMA_COLORS_DARK,
  ...SCHEMA_COLORS_DARK.map(c => shiftL(c, -12)),
];

/** Resolved schema-color assignments keyed by schema name under the source comparison policy. */
export type SchemaColorMap = Map<string, string>;

function requireSchemaName(schema: string): string {
  const normalized = schema.trim();
  if (!normalized) {
    throw new Error('Schema color assignment requires a non-empty schema name');
  }
  return normalized;
}

function getSchemaPalette(forceLight?: boolean): string[] {
  return (!forceLight && isDarkTheme()) ? SCHEMA_COLORS_DARK_EXT : SCHEMA_COLORS_LIGHT_EXT;
}

function mix32(hash: number): number {
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** Retrieves a deterministic theme-aware color for a given SQL schema. Hashes the schema name (FNV-1a) into a 30-slot palette — the base 15 colors plus 15 lightness-shifted variants. The same schema name always produces the same color regardless of how many other schemas are loaded. */
export function getSchemaColor(schema: string, forceLight?: boolean, identifierCaseSensitive = false): string {
  const palette = getSchemaPalette(forceLight);
  return palette[getSchemaColorIndex(schema, palette.length, identifierCaseSensitive)];
}

/** Computes the stable preferred palette slot for a schema. The final avalanche improves distribution before reducing to the small palette. */
function getSchemaColorIndex(schema: string, paletteSize: number, identifierCaseSensitive: boolean): number {
  return hashString(schemaKey(requireSchemaName(schema), identifierCaseSensitive)) % paletteSize;
}

/** Builds a deterministic loaded-set color map keyed by normalized schema name. Collisions are spread across free palette slots before any color is reused. */
export function createSchemaColorMap(schemas: readonly string[], forceLight?: boolean, identifierCaseSensitive = false): SchemaColorMap {
  const palette = getSchemaPalette(forceLight);
  const schemaKeys = Array.from(new Set(schemas.map(s => schemaKey(requireSchemaName(s), identifierCaseSensitive)))).sort();
  const slotCount = schemaKeys.length <= SCHEMA_COLORS_LIGHT.length ? SCHEMA_COLORS_LIGHT.length : palette.length;
  const slotUse = new Array<number>(slotCount).fill(0);
  const map: SchemaColorMap = new Map();

  for (const key of schemaKeys) {
    const hash = hashString(key);
    const preferred = hash % slotCount;
    const step = [1, 7, 11, 13, 17, 19, 23, 29][(hash >>> 8) % 8];
    let selected = preferred;

    for (let attempt = 0; attempt < slotCount; attempt++) {
      const candidate = (preferred + attempt * step) % slotCount;
      if (slotUse[candidate] === 0) {
        selected = candidate;
        break;
      }
      if (slotUse[candidate] < slotUse[selected]) {
        selected = candidate;
      }
    }

    slotUse[selected]++;
    map.set(key, palette[selected]);
  }

  return map;
}

/** Resolves the display color for a schema from a precomputed color map. */
export function getSchemaColorFromMap(schema: string, colorMap: SchemaColorMap, identifierCaseSensitive = false): string {
  const key = schemaKey(requireSchemaName(schema), identifierCaseSensitive);
  const color = colorMap.get(key);
  if (!color) {
    throw new Error(`No schema color assigned for "${schema}"`);
  }
  return color;
}

/** Returns true when a schema/type aggregate represents only external objects. */
export function isExternalOnlyTypeBreakdown(typeBreakdown: Partial<Record<ObjectType, number>> | undefined): boolean {
  if (!typeBreakdown) return false;
  const externalCount = typeBreakdown.external ?? 0;
  if (externalCount <= 0) return false;
  return (Object.keys(TYPE_LABELS) as ObjectType[])
    .filter(type => type !== 'external')
    .every(type => (typeBreakdown[type] ?? 0) === 0);
}

/** Resolves the display color for a rendered schema-like node. */
export function getSchemaDisplayColor(
  schema: string,
  colorMap: SchemaColorMap,
  typeBreakdown?: Partial<Record<ObjectType, number>>,
  identifierCaseSensitive = false,
): string {
  return isExternalOnlyTypeBreakdown(typeBreakdown)
    ? getExternalNodeColor()
    : getSchemaColorFromMap(schema, colorMap, identifierCaseSensitive);
}

function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Picks black or white text for a `#rrggbb` background, whichever has the higher WCAG 2 contrast ratio against it. */
export function getReadableTextColor(background: string): '#000000' | '#ffffff' {
  const l = relativeLuminance(background);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/** Fixed color for external nodes in light theme — applies to all `type === 'external'` (catalog ET, file, cross-DB). */
const EXTERNAL_NODE_COLOR_LIGHT = '#6B7A8D';
/** Fixed color for external nodes in dark theme — applies to all `type === 'external'` (catalog ET, file, cross-DB). */
const EXTERNAL_NODE_COLOR_DARK  = '#94A3B8';

/** Returns the theme-aware fixed color for external nodes. All externals (catalog `et`, virtual `file`, virtual `db`) share this steel-gray to keep the "external system" category visually distinct from real schemas in both light and dark themes. */
export function getExternalNodeColor(): string {
  return isDarkTheme() ? EXTERNAL_NODE_COLOR_DARK : EXTERNAL_NODE_COLOR_LIGHT;
}

/** Mapping of two-letter AI color codes to CSS variables. These variables are themed automatically via --vscode-charts-* tokens. */
export const AI_COLOR_HEX: Record<string, string> = {
  bu: 'var(--ln-ai-bu)',
  gn: 'var(--ln-ai-gn)',
  rd: 'var(--ln-ai-rd)',
  ye: 'var(--ln-ai-ye)',
  or: 'var(--ln-ai-or)',
  gy: 'var(--ln-ai-gy)',
};

/** Maps semantic AI roles to their corresponding two-letter color codes. */
const AI_ROLE_TO_COLOR: Record<string, string> = {
  source: 'bu', transform: 'or', target: 'gn',
  good: 'gn', warn: 'ye', fail: 'rd',
  gy: 'gy',
};

/** Resolves a semantic AI role or a raw color code to a standard two-letter color code. */
export function resolveAiColor(role: string): string {
  return AI_ROLE_TO_COLOR[role] ?? 'gy';
}

/** Mapping of AI color codes to theme-aware glow and shadow CSS variables. Used for highlighting nodes in the graph canvas. */
export const AI_COLOR_GLOW: Record<string, { glow: string; shadow: string }> = {
  bu: { glow: 'var(--ln-ai-bu-glow)', shadow: 'var(--ln-ai-bu-shadow)' },
  gn: { glow: 'var(--ln-ai-gn-glow)', shadow: 'var(--ln-ai-gn-shadow)' },
  rd: { glow: 'var(--ln-ai-rd-glow)', shadow: 'var(--ln-ai-rd-shadow)' },
  ye: { glow: 'var(--ln-ai-ye-glow)', shadow: 'var(--ln-ai-ye-shadow)' },
  or: { glow: 'var(--ln-ai-or-glow)', shadow: 'var(--ln-ai-or-shadow)' },
  gy: { glow: 'var(--ln-ai-gy-glow)', shadow: 'var(--ln-ai-gy-shadow)' },
};

/** Detects if the VS Code environment is currently using a dark or high-contrast theme. This is determined by inspecting the `data-vscode-theme-kind` attribute on the document body. */
function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  const kind = document.body?.dataset?.vscodeThemeKind;
  return kind === 'vscode-dark' || kind === 'vscode-high-contrast';
}
