import { memo, useState } from 'react';
import Markdown from 'react-markdown';

interface AiDescriptionOverlayProps {
  viewName: string;
  description: string;
}

export const AiDescriptionOverlay = memo(function AiDescriptionOverlay({
  viewName,
  description,
}: AiDescriptionOverlayProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="ln-ai-description-anchor">
      {!expanded ? (
        <button
          className="ln-ai-description-bar"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          aria-label="Expand description"
        >
          <span className="ln-ai-description-bar-name">{viewName}</span>
          <span className="ln-ai-description-bar-toggle">Description ▼</span>
        </button>
      ) : (
        <div className="ln-ai-description-overlay">
          <div className="ln-ai-description-header">
            <span className="text-[10px] font-semibold ln-text-muted uppercase tracking-wide">
              {viewName}
            </span>
            <button
              className="ln-ai-description-close"
              onClick={() => setExpanded(false)}
              aria-label="Collapse description"
            >
              ▲
            </button>
          </div>
          <div className="ln-ai-description-body">
            <div className="ln-ai-description-md">
              <Markdown>{description}</Markdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
