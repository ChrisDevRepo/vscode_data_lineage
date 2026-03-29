import { memo, useState, useCallback, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

interface AiDescriptionOverlayProps {
  viewName: string;
  description: string;
  /** Set of node IDs in the current graph — used to detect clickable references. */
  nodeIds?: Set<string>;
  /** Callback when a node reference is clicked in the description text. */
  onNodeClick?: (nodeId: string) => void;
}

export const AiDescriptionOverlay = memo(function AiDescriptionOverlay({
  viewName,
  description,
  nodeIds,
  onNodeClick,
}: AiDescriptionOverlayProps) {
  const [expanded, setExpanded] = useState(false);

  // Build a display-name → node-id lookup for matching inline code references
  const nameToId = useMemo(() => {
    if (!nodeIds) return null;
    const m = new Map<string, string>();
    for (const id of nodeIds) m.set(id, id);
    return m;
  }, [nodeIds]);

  const codeRenderer = useCallback(({ children, ...props }: React.ComponentProps<'code'> & { inline?: boolean }) => {
    const text = String(children).trim();
    // Only match inline code (not code blocks) against node IDs
    const isBlock = 'className' in props && typeof props.className === 'string' && props.className.startsWith('language-');
    if (!isBlock && nameToId && onNodeClick) {
      const id = nameToId.get(text) ?? nameToId.get(text.toLowerCase());
      if (id) {
        return (
          <span
            className="ln-ai-node-link"
            onClick={() => onNodeClick(id)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && onNodeClick(id)}
          >
            {children}
          </span>
        );
      }
    }
    return <code {...props}>{children}</code>;
  }, [nameToId, onNodeClick]);

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
              <Markdown
                remarkPlugins={[remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{ code: codeRenderer }}
              >{description}</Markdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
