/**
 * Outcome of handing a preview to the result panel.
 *
 * @remarks
 * `delivered` — the webview accepted the message; the user sees the graph and its description.
 * `no_panel` — no panel is open, so delivery is deferred to the "Show in Graph" button; not a failure.
 * `post_failed` — a panel exists but the send was refused (schema failure or transport); a failure.
 */
export type PreviewDelivery = 'delivered' | 'no_panel' | 'post_failed';

/**
 * Assembles the chat-channel answer from a presented result's authored parts and the preview's
 * delivery outcome.
 *
 * @remarks
 * `lineage_present_result` carries model-authored `summary`, `intro`, `closing` and, when it has
 * sections, the assembled `description` (intro, numbered sections, closing). What chat receives
 * depends on whether the user can read the preview:
 * - `delivered` — the graph and its description are on screen; chat carries the summary only.
 * - `post_failed` — the preview never reached the user; chat carries the summary followed by the
 *   whole assembled description, unaltered. Without a description (a result with no sections) it
 *   falls back to the summary, intro and closing.
 * - `no_panel` — delivery is deferred to the "Show in Graph" button; chat carries the summary,
 *   intro and closing.
 *
 * Absent or blank parts are skipped and the answer is never empty while any authored part has text,
 * so a `delivered` result with a blank summary falls back to the intro and closing. A leading
 * thematic break on `closing` is dropped: it separates sections inside the rendered document and
 * has nothing to separate at the end of a chat message.
 *
 * @param parts - Authored `summary`, `intro`, `closing` and assembled `description` of the presented result.
 * @param delivery - Whether the preview was delivered, deferred for lack of a panel, or failed to post.
 * @returns The chat answer body, or null when no part carries text.
 */
export function buildChatAnswer(parts: {
  readonly summary?: string | null;
  readonly intro?: string | null;
  readonly closing?: string | null;
  readonly description?: string | null;
}, delivery: PreviewDelivery): string | null {
  const text = (part?: string | null): string => (part ?? '').trim();
  const summary = text(parts.summary);
  if (delivery === 'delivered' && summary) return summary;
  const description = text(parts.description);
  if (delivery === 'post_failed' && description) return [summary, description].filter(Boolean).join('\n\n');
  const closing = (parts.closing ?? '').replace(/^\s*-{3,}\s*(?:\r?\n|$)/, '');
  const body = [summary, text(parts.intro), text(closing)].filter(part => part.length > 0);
  return body.length > 0 ? body.join('\n\n') : null;
}
