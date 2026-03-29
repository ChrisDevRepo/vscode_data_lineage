import { memo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

interface AiDescriptionOverlayProps {
  viewName: string;
  description: string;
  /** Start expanded (e.g. text-only AI response with no graph nodes). */
  defaultExpanded?: boolean;
}

export const AiDescriptionOverlay = memo(function AiDescriptionOverlay({
  viewName,
  description,
  defaultExpanded = false,
}: AiDescriptionOverlayProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

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
          <span className="ln-ai-description-bar-toggle">Description &#x25BC;</span>
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
              &#x25B2;
            </button>
          </div>
          <div className="ln-ai-description-body">
            <div className="ln-ai-description-md">
              <Markdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
              >{description}</Markdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
