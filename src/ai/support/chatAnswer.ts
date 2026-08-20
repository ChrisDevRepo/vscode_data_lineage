/**
 * Assembles the chat-channel answer from a presented result's authored parts.
 *
 * @remarks
 * `lineage_present_result` carries model-authored `summary`, `intro`, and
 * `closing`. The preview overlay renders all three inside the assembled
 * description; chat receives the same three so a user who never opens the graph
 * still reads the whole answer instead of the one-line summary.
 *
 * Absent or blank parts are skipped, so a result carrying only `summary`
 * streams exactly what it streamed before. A leading thematic break on
 * `closing` is dropped: it separates sections inside the rendered document and
 * has nothing to separate at the end of a chat message.
 *
 * @param parts - Authored `summary`, `intro`, and `closing` from the presented result.
 * @returns The chat answer body, or null when no part carries text.
 */
export function buildChatAnswer(parts: {
  readonly summary?: string | null;
  readonly intro?: string | null;
  readonly closing?: string | null;
}): string | null {
  const closing = (parts.closing ?? '').replace(/^\s*-{3,}\s*(?:\r?\n|$)/, '');
  const body = [parts.summary, parts.intro, closing]
    .map(part => (part ?? '').trim())
    .filter(part => part.length > 0);
  return body.length > 0 ? body.join('\n\n') : null;
}
