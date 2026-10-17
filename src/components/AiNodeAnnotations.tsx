import type { CSSProperties } from 'react';
import { Tooltip } from './ui/Tooltip';
import type { AiBadge } from '../engine/types';

/** Gap, in pixels, kept between the node box and the AI badge or footnote rendered outside it. */
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

/** Top-of-node AI badge, shared by object and column view node renderers. */
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

/** Bottom-of-node AI footnote, shared by object and column view node renderers. */
export function AiNoteToolbar({ text }: { text: string }) {
  return (
    <div style={noteStyle}>
      <Tooltip content={text} placement="bottom" multiline maxWidth={400} delay={300}>
        <div className="ln-ai-note-label">{text.split('\n')[0]}</div>
      </Tooltip>
    </div>
  );
}
