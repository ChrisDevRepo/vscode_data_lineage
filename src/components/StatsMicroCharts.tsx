import { typeBadgeLabel } from '../engine/profilingEngine';

// ─── Type Badge ──────────────────────────────────────────────────────────────

const BADGE_COLORS: Record<string, string> = {
  INT: 'var(--ln-analysis-icon)',      // blue
  DEC: 'var(--ln-analysis-icon)',      // blue
  STR: '#22c55e',                       // green
  DATE: '#a78bfa',                      // purple
  TIME: '#a78bfa',                      // purple
  BIT: 'var(--ln-fg-muted)',           // gray
  UUID: '#2dd4bf',                      // teal
  XML: 'var(--ln-fg-dim)',             // dim
  BIN: 'var(--ln-fg-dim)',             // dim
  TXT: 'var(--ln-fg-dim)',             // dim
};

export function TypeBadge({ typeStr }: { typeStr: string }) {
  const label = typeBadgeLabel(typeStr);
  const color = BADGE_COLORS[label] ?? 'var(--ln-fg-muted)';
  return (
    <span
      className="font-mono text-xs"
      style={{
        color,
        fontWeight: 600,
        fontSize: '0.65rem',
        letterSpacing: '0.03em',
      }}
      title={typeStr}
    >
      {label}
    </span>
  );
}

// ─── Completeness Bar ─────────────────────────────────────────────────────────

function qualityColor(value: number): string {
  if (value >= 0.95) return 'var(--ln-analysis-icon)';
  if (value >= 0.80) return 'var(--ln-warning-fg)';
  return 'var(--ln-validation-error-border)';
}

export function CompletenessBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <svg width="100%" height="4" style={{ display: 'block' }}>
      <rect x="0" y="0" width="100%" height="4" rx="2" fill="var(--ln-border-light)" />
      <rect x="0" y="0" width={`${pct}%`} height="4" rx="2" fill={qualityColor(value)} />
    </svg>
  );
}

// ─── Uniqueness Indicator ─────────────────────────────────────────────────────

export function UniquenessIndicator({ value, distinctCount }: { value: number; distinctCount: number }) {
  let label: string;
  let color: string;

  if (distinctCount <= 1) {
    label = 'Const';
    color = 'var(--ln-validation-error-border)';
  } else if (value > 0.9) {
    label = 'High';
    color = 'var(--ln-analysis-icon)';
  } else if (value >= 0.1) {
    label = 'Med';
    color = 'var(--ln-fg-muted)';
  } else {
    label = 'Low';
    color = 'var(--ln-warning-fg)';
  }

  return (
    <span className="text-xs ml-1" style={{ color, fontWeight: 500 }}>
      {label}
    </span>
  );
}
