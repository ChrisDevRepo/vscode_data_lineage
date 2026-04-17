import { memo } from 'react';
import { ModeBanner } from './ModeBanner';

/**
 * Props for the `AiViewBanner` component.
 */
interface AiViewBannerProps {
  /** The name or title of the AI-generated view. */
  name: string;
  /** Total number of objects currently visible in the AI preview. */
  nodeCount: number;
  /** Callback triggered when the user chooses to discard the AI preview. */
  onDiscard: () => void;
  /** 
   * Callback triggered when the user chooses to save the current AI view as a permanent bookmark.
   * @param name - The name for the new bookmark.
   * @param withPositions - Whether to save the current visual positions of nodes.
   */
  onSaveAsBookmark?: (name: string, withPositions: boolean) => void;
}

/** SVG path for the AI/Sparkle icon. */
const AI_ICON = 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z';

/**
 * A specialized banner displayed when the user is viewing an AI-curated graph state.
 * 
 * @remarks
 * This component acts as a wrapper for the generic `ModeBanner`, pre-configuring
 * it with AI-specific iconography and formatting for the view name and node count.
 * 
 * @param props - The component props.
 */
export const AiViewBanner = memo(function AiViewBanner({
  name,
  nodeCount,
  onDiscard,
  onSaveAsBookmark,
}: AiViewBannerProps) {
  return (
    <ModeBanner
      variant="ai"
      icon={AI_ICON}
      title="AI Preview"
      subtitle={
        <>
          <span className="font-bold">{nodeCount} objects</span>
          {' — '}
          <span className="font-mono font-semibold">"{name}"</span>
        </>
      }
      onClose={onDiscard}
      onSaveAsBookmark={onSaveAsBookmark}
    />
  );
});
