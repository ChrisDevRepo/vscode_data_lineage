import type { CSSProperties } from 'react';
import { Tooltip } from './ui/Tooltip';
import type { AiBadge } from '../engine/types';

/**
 * Gap, in pixels, kept between the node box and the AI badge or footnote rendered outside it.
 *
 * @remarks
 * `AI_BADGE_BAND` / `AI_NOTE_BAND` in `src/engine/graphBuilder.ts` reserve the layout space this
 * offset draws into, so a change here needs a matching change there. The caller renders the badge
 * or footnote as a child of the node's own `position: relative` box (not a React Flow `NodeToolbar`
 * portal) so this gap is a CSS pixel value inside the same transformed, zoom-scaled coordinate
 * space as the node itself, instead of a screen-space value that only matches the flow-unit
 * reservation at zoom 1.
 */
export const AI_ANNOTATION_NODE_GAP = 6;

const badgeStyle: CSSProperties = {
  position: 'absolute',
  bottom: `calc(100% + ${AI_ANNOTATION_NODE_GAP}px)`,
  left: '50%',
  transform: 'translateX(-50%)',
};

const noteStyle: CSSProperties = {
  position: 'absolute',
  top: `calc(100% + ${AI_ANNOTATION_NODE_GAP}px)`,
  left: '50%',
  transform: 'translateX(-50%)',
};

/**
 * Top-of-node AI badge, shared by object and column view node renderers.
 *
 * @remarks
 * `emphasis` carries the report's section focus: the focused section's labels read lit and the rest
 * step back, so navigating the report answers on the labels without touching how the nodes
 * themselves are drawn. Rendered as a child of the node's own positioned box, so it scales and pans
 * with the node instead of staying screen-sized like a `NodeToolbar` portal.
 */
export function AiBadgeToolbar({ text, emphasis }: AiBadge) {
  const className = `ln-ai-badge${emphasis ? ` ln-ai-badge-${emphasis}` : ''}`;
  return (
    <div style={badgeStyle}>
      <Tooltip content={text} placement="top">
        <div className={className}>{text}</div>
      </Tooltip>
    </div>
  );
}

/**
 * Bottom-of-node AI footnote, shared by object and column view node renderers.
 *
 * @remarks
 * Rendered as a child of the node's own positioned box; see {@link AiBadgeToolbar}.
 */
export function AiNoteToolbar({ text }: { text: string }) {
  return (
    <div style={noteStyle}>
      <Tooltip content={text} placement="bottom" multiline maxWidth={400} delay={300}>
        <div className="ln-ai-note-label">{text.split('\n')[0]}</div>
      </Tooltip>
    </div>
  );
}
