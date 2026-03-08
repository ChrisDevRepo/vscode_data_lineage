import type { TopValue } from '../engine/profilingEngine';

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

// ─── Top-N Micro Bar Chart ───────────────────────────────────────────────────

export function TopNChart({ values }: { values: TopValue[] }) {
  if (values.length === 0) return null;
  const maxCount = values[0].count;
  const barHeight = 14;
  const gap = 2;
  const height = values.length * (barHeight + gap);

  return (
    <svg width="100%" height={height} style={{ display: 'block' }}>
      {values.map((v, i) => {
        const barWidth = maxCount > 0 ? (v.count / maxCount) * 100 : 0;
        return (
          <g key={i} transform={`translate(0, ${i * (barHeight + gap)})`}>
            <rect
              x="0" y="0"
              width={`${barWidth}%`}
              height={barHeight} rx="2"
              fill="var(--ln-analysis-icon)" opacity="0.5"
            />
            <text
              x="4" y={barHeight - 3}
              fontSize="9" fill="var(--ln-fg)"
              style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }}
            >
              {v.value} ({v.percent.toFixed(1)}%)
            </text>
          </g>
        );
      })}
    </svg>
  );
}
