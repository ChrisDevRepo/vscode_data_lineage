import React from 'react';

/**
 * Highlights the first case-insensitive occurrence of `query` in `text` with a `<mark>` tag, for
 * search results. A query under 2 characters, or no match, returns the original text.
 *
 * @returns A {@link React.ReactNode} with the match highlighted, or the original text.
 */
export function highlightText(text: string, query: string | undefined): React.ReactNode {
  if (!query || query.length < 2) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="ln-mark">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}
