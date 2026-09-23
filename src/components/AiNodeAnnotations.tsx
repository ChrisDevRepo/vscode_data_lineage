import { NodeToolbar, Position } from '@xyflow/react';
import { Tooltip } from './ui/Tooltip';
import type { AiBadge } from '../engine/types';

/**
 * Top-of-node AI badge, shared by object and column view node renderers.
 *
 * @remarks
 * `emphasis` carries the report's section focus: the focused section's labels read lit and the rest
 * step back, so navigating the report answers on the labels without touching how the nodes
 * themselves are drawn.
 */
export function AiBadgeToolbar({ text, emphasis }: AiBadge) {
  const className = `ln-ai-badge${emphasis ? ` ln-ai-badge-${emphasis}` : ''}`;
  return (
    <NodeToolbar position={Position.Top} align="center" offset={2} isVisible>
      <Tooltip content={text} placement="top">
        <div className={className}>{text}</div>
      </Tooltip>
    </NodeToolbar>
  );
}

/** Bottom-of-node AI footnote, shared by object and column view node renderers. */
export function AiNoteToolbar({ text }: { text: string }) {
  return (
    <NodeToolbar position={Position.Bottom} align="center" offset={2} isVisible>
      <Tooltip content={text} placement="bottom" multiline maxWidth={400} delay={300}>
        <div className="ln-ai-note-label">{text.split('\n')[0]}</div>
      </Tooltip>
    </NodeToolbar>
  );
}
