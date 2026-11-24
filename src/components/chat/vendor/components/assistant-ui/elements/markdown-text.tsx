// OWNED FILE (see ../../../SOURCE.md): replaces the registry's markdown-text.tsx, never edited from it.
// Chat text renders through the app's single markdown path, the same function and CSS as the AI
// report overlay: marked + KaTeX, `alignSqlExcerpt` for SQL, DOMPurify, Monaco SQL colors.
import 'katex/dist/katex.min.css';
import { memo, useMemo, useRef } from 'react';
import { useMessagePartText } from '@assistant-ui/react';
import { renderAiMarkdown } from '../../../../../markdown/renderAiMarkdown';
import { useMarkdownLinks } from '../../../../../markdown/useMarkdownLinks';
import { useSqlColorizing } from '../../../../../markdown/useSqlColorizing';

/** Renders the accumulated text of the current message part; each batched delta re-renders it whole. */
export const MarkdownText = memo(function MarkdownText() {
  const { text } = useMessagePartText();
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
});
