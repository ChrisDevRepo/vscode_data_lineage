interface CloseIconProps {
  className?: string;
  strokeWidth?: number;
}

/**
 * Close icon of dismiss controls: an X-shaped SVG sized via `className`, stroked at `strokeWidth`.
 */
export function CloseIcon({ className = 'w-4 h-4', strokeWidth = 2 }: CloseIconProps) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={strokeWidth}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
