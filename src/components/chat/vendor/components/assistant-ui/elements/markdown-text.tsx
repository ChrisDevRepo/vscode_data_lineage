// OWNED FILE (see ../../../SOURCE.md): replaces the registry's markdown-text.tsx, never edited from it.
// Chat text renders through the app's single markdown path (`ChatMarkdown`), the same function and CSS
// as the AI report overlay: marked + KaTeX, `alignSqlExcerpt` for SQL, DOMPurify, Monaco SQL colors.
import { memo } from 'react';
import { useMessagePartText } from '@assistant-ui/react';
import { ChatMarkdown } from '../../../../../markdown/ChatMarkdown';

/** Renders the accumulated text of the current message part; each batched delta re-renders it whole. */
export const MarkdownText = memo(function MarkdownText() {
  const { text } = useMessagePartText();
  return <ChatMarkdown text={text} />;
});
