import 'katex/dist/katex.min.css';
import { useMemo, useRef } from 'react';
import { renderAiMarkdown } from './renderAiMarkdown';
import { useMarkdownLinks } from './useMarkdownLinks';
import { useSqlColorizing } from './useSqlColorizing';

/** Host markdown as every chat surface shows it: `renderAiMarkdown`, Monaco SQL colors and the shared link handling. */
export function ChatMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderAiMarkdown(text), [text]);
  const mdRef = useRef<HTMLDivElement | null>(null);
  useSqlColorizing(mdRef, html);
  const links = useMarkdownLinks();

  return (
    <div
      ref={mdRef}
      className="ln-ai-description-md ln-ai-description-font-0"
      onClick={links.onClick}
      onKeyDown={links.onKeyDown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
