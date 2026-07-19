import type { CSSProperties } from 'react';

interface SpinnerProps {
  /** Sizing/positioning utility classes appended after `animate-spin`. */
  className?: string;
  /** Inline style (e.g. `{ color: 'var(--ln-fg-muted)' }`). */
  style?: CSSProperties;
}

/**
 * Animated loading spinner.
 *
 * @returns The shared spinning-circle SVG previously copied inline across several components.
 */
export function Spinner({ className = 'w-4 h-4', style }: SpinnerProps) {
  return (
    <svg className={`animate-spin ${className}`} style={style} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
