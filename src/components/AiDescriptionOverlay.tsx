import { memo, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/** Convert ```math fenced blocks to $$ delimiters that remark-math understands.
 *  Resilient: nested opens get closed, unclosed blocks get closed at EOF,
 *  empty blocks are dropped. Broken LaTeX inside $$ is handled by
 *  rehype-katex throwOnError:false (renders as raw text). */
function mathFenceToDelimiters(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];
  let insideMath = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!insideMath && trimmed === '```math') {
      insideMath = true;
      result.push('$$');
    } else if (insideMath && trimmed === '```math') {
      // Nested ```math — close current block first, open new one
      result.push('$$');
      result.push('');
      result.push('$$');
    } else if (insideMath && trimmed === '```') {
      insideMath = false;
      result.push('$$');
    } else if (!insideMath && trimmed.startsWith('```') && trimmed !== '```math') {
      // Non-math fence (```sql, ```text, plain ```) — pass through as-is
      result.push(line);
    } else {
      result.push(line);
    }
  }

  // Unclosed math block at EOF — close it so it doesn't eat remaining text
  if (insideMath) {
    result.push('$$');
  }

  // Safety net: odd $$ count means an unclosed display math block will cascade.
  // Close it to prevent all subsequent content from being eaten.
  const dollarCount = result.filter(l => l.trim() === '$$').length;
  if (dollarCount % 2 !== 0) {
    result.push('$$');
  }

  return result.join('\n');
}

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
  const [rawMode, setRawMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const sanitized = useMemo(() => mathFenceToDelimiters(description), [description]);

  function handleCopy() {
    navigator.clipboard.writeText(description).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(err => window.vscode?.postMessage({ type: 'error', error: `Clipboard write failed: ${err instanceof Error ? err.message : String(err)}` }));
  }

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
              className="ln-ai-description-action"
              onClick={handleCopy}
              title={copied ? 'Copied!' : 'Copy markdown'}
              aria-label="Copy markdown"
            >
              {copied ? (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
              )}
            </button>
            <button
              className="ln-ai-description-action"
              onClick={() => setRawMode(v => !v)}
              title={rawMode ? 'Show rendered' : 'Show raw markdown'}
              aria-label="Toggle raw markdown"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h3.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-3.245a2.232 2.232 0 0 0-1.722.81.75.75 0 0 1-1.118-.042A2.23 2.23 0 0 0 6.5 13H.75a.75.75 0 0 1-.75-.75Zm7.251 9.674.001.001L7.25 12h-.001l.002-.575ZM6.5 11.5c.156 0 .31.01.462.03a3.75 3.75 0 0 1-.462-.03Zm1-.001.007.001h-.007ZM7.5 3.5A2.25 2.25 0 0 0 5.253 2.5H1.5v8h5.25c.125 0 .248.01.37.026A2.253 2.253 0 0 1 7.5 9V3.5Zm1.5 5.5a2.25 2.25 0 0 1 .38-1.266A.752.752 0 0 0 9.5 7.5V3.5A2.25 2.25 0 0 1 11.753 2.5H14.5v8h-3.244A2.242 2.242 0 0 0 9 10.5Z"/></svg>
            </button>
            <button
              className="ln-ai-description-close"
              onClick={() => setExpanded(false)}
              aria-label="Collapse description"
            >
              &#x25B2;
            </button>
          </div>
          <div className="ln-ai-description-body">
            {rawMode ? (
              <pre className="ln-ai-description-raw">{description}</pre>
            ) : (
              <div className="ln-ai-description-md">
                <Markdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
                >{sanitized}</Markdown>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
