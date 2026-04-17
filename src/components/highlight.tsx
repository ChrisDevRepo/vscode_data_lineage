import React from 'react';

/**
 * Highlights a single case-insensitive substring match within a given text string.
 *
 * @remarks
 * This utility function is primarily used for search result highlighting in the UI.
 * It wraps the first occurrence of the query string (case-insensitive) in a `<mark>` tag.
 * If the query is less than 2 characters long, or no match is found, the original text is returned.
 *
 * @param text - The full text string to process.
 * @param query - The substring to search for and highlight.
 * @returns A {@link React.ReactNode} containing the text with the match highlighted, or the original text string.
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
