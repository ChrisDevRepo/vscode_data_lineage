/** Highlight/dim/glow styling shared by every node card renderer, so the color rule lives once. */
export interface NodeHighlightStyle {
  /** True when either click-selection or an AI highlight applies. */
  isHighlighted: boolean;
  /** Border/left-accent color to substitute for the node's normal border/schema color. */
  highlightColor: string;
  boxShadow: string;
  opacity: number;
  transform: string;
  zIndex: number;
}

/**
 * Resolves the highlight/dim/glow visuals every node card applies on top of its own size,
 * background, and left-accent color.
 *
 * @param highlighted - Click-selection state; `'yellow'` is the plain click highlight.
 * @param aiHighlight - AI-authored highlight color/glow, when the model marked this node.
 * @param dimmed - Whether a different node is selected and this one is out of scope.
 */
export function resolveNodeHighlightStyle(
  highlighted: boolean | 'yellow' | undefined,
  aiHighlight: { color: string; glow: string; shadow: string } | undefined,
  dimmed: boolean | undefined,
): NodeHighlightStyle {
  const isHighlighted = highlighted === true || highlighted === 'yellow';
  const isYellow = highlighted === 'yellow';
  const highlightColor = aiHighlight
    ? aiHighlight.color
    : isYellow ? 'var(--ln-highlight-yellow)' : 'var(--ln-highlight-blue)';
  // AI highlight takes the glow at any selection state except the plain yellow click-highlight,
  // which always wins its own color.
  const boxShadow = isYellow
    ? '0 0 0 4px var(--ln-highlight-yellow-glow), 0 8px 20px var(--ln-highlight-yellow-shadow)'
    : aiHighlight
      ? `0 0 0 5px ${aiHighlight.glow}, 0 8px 20px ${aiHighlight.shadow}`
      : isHighlighted
        ? '0 0 0 4px var(--ln-highlight-blue-glow), 0 8px 20px var(--ln-highlight-blue-shadow)'
        : dimmed
          ? 'var(--ln-node-shadow-dimmed)'
          : 'var(--ln-node-shadow)';
  return {
    isHighlighted,
    highlightColor,
    boxShadow,
    opacity: dimmed ? 0.25 : 1,
    transform: isHighlighted ? 'scale(1.05)' : 'scale(1)',
    zIndex: isHighlighted ? 1000 : 1,
  };
}
