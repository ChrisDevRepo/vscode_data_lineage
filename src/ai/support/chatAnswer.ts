/** Outcome of handing a preview to the result panel. */
export type PreviewDelivery = 'delivered' | 'no_panel' | 'post_failed';

/** Assembles the chat-channel answer from a presented result's authored parts and the preview's delivery outcome. */
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
