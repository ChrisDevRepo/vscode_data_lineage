import { typeBadgeLabel } from '../engine/profilingEngine';
import { Tooltip } from './ui/Tooltip';

/** Mapping of simplified data type labels to their respective theme-aware colors. Used by {@link TypeBadge} for visual categorization of column types. */
const BADGE_COLORS: Record<string, string> = {
  INT: 'var(--ln-analysis-icon)',
  DEC: 'var(--ln-analysis-icon)',
  STR: 'var(--ln-ai-gn)',
  DATE: 'var(--vscode-charts-purple, #a78bfa)',
  TIME: 'var(--vscode-charts-purple, #a78bfa)',
  BIT: 'var(--ln-fg-muted)',
  UUID: 'var(--vscode-charts-green, #2dd4bf)',
  XML: 'var(--ln-fg-dim)',
  BIN: 'var(--ln-fg-dim)',
  TXT: 'var(--ln-fg-dim)',
};

/** Renders the compact {@link typeBadgeLabel} with the full SQL type in a tooltip. */
export function TypeBadge({ typeStr }: { typeStr: string }) {
  const label = typeBadgeLabel(typeStr);
  const color = BADGE_COLORS[label] ?? 'var(--ln-fg-muted)';
  return (
    <Tooltip content={typeStr}>
      <span
        className="font-mono text-xs"
        style={{
          color,
          fontWeight: 600,
          fontSize: '0.65rem',
          letterSpacing: '0.03em',
        }}
      >
        {label}
      </span>
    </Tooltip>
  );
}

/** Determines a semantic color based on a quality/completeness ratio. */
function qualityColor(value: number): string {
  if (value >= 0.95) return 'var(--ln-analysis-icon)';
  if (value >= 0.8) return 'var(--ln-warning-fg)';
  return 'var(--ln-validation-error-border)';
}

/** Renders a color-coded completeness ratio as an SVG progress bar. */
export function CompletenessBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <svg width="100%" height="4" style={{ display: 'block' }}>
      <rect
        x="0"
        y="0"
        width="100%"
        height="4"
        rx="2"
        fill="var(--ln-border-light)"
      />
      <rect
        x="0"
        y="0"
        width={`${pct}%`}
        height="4"
        rx="2"
        fill={qualityColor(value)}
      />
    </svg>
  );
}

/** Classifies a uniqueness ratio as constant, high, medium, or low. */
export function UniquenessIndicator({
  value,
  distinctCount,
}: {
  value: number;
  distinctCount: number;
}) {
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
