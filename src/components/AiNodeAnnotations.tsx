import type { CSSProperties } from 'react';
import { Tooltip } from './ui/Tooltip';
import type { AiBadge } from '../engine/types';

/**
 * Gap in pixels between the node box and the AI badge or footnote outside it. `AI_BADGE_BAND` /
 * `AI_NOTE_BAND` in `src/engine/graphBuilder.ts` reserve the layout space this offset draws into,
 * so a change needs a matching change there. The badge or footnote is a child of the node's own
 * `position: relative` box (not a `NodeToolbar` portal), so the gap is a CSS pixel value in the
 * node's zoom-scaled space, not a screen value that matches the reservation only at zoom 1.
 * @internal
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
 * Top-of-node AI badge shared by object and column view renderers. `emphasis` carries the report's
 * section focus: the focused section's labels read lit and the rest step back, without touching how
 * nodes are drawn. A child of the node's positioned box, so it scales and pans with the node.
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
 * Bottom-of-node AI footnote shared by object and column view renderers; rendered as a child of the
 * node's positioned box, see {@link AiBadgeToolbar}.
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
