import { NodeToolbar, Position } from '@xyflow/react';
import { Tooltip } from './ui/Tooltip';

/** Top-of-node AI badge, shared by object and column view node renderers. */
export function AiBadgeToolbar({ text }: { text: string }) {
  return (
    <NodeToolbar position={Position.Top} align="center" offset={2} isVisible>
      <Tooltip content={text} placement="top">
        <div className="ln-ai-badge">{text}</div>
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
