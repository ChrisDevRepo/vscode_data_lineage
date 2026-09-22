/**
 * Unit tests for the prose helpers in `src/ai/support/text.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  quoteIds,
  sanitizeDescriptionForChat,
  sanitizeProviderErrorDiagnostic,
  isTransportProviderError,
  describeProviderErrorForUser,
} from '../../../src/ai/support/text';

describe('quoteIds', () => {
  it('backticks each id and caps with a trailing ellipsis marker', () => {
    expect(quoteIds(['a', 'b'])).toBe('`a`, `b`');
    expect(quoteIds(['a', 'b', 'c', 'd'], 3)).toBe('`a`, `b`, `c` ...');
  });

  it('makes an invisible offender visible as a delimited empty span', () => {
    expect(quoteIds([' '])).toBe('` `');
  });
});

/**
 * Regression tests for transport-error classification (`src/ai/support/text.ts`).
 *
 * @remarks
 * Inside the extension host a dropped connection arrives from Electron's network stack as
 * `net::ERR_*` **in the message, with no `code` property** (or with a numeric errno).
 * Classification is code-based by design, so without message-token recovery those failures
 * classify as provider verdicts and end the turn outright instead of retrying.
 */
describe('provider transport-error classification', () => {
  it('recovers a Chromium network token as the code so a dropped connection is transport', () => {
    const diagnostic = sanitizeProviderErrorDiagnostic(
      new Error('Please check your firewall rules and network connection then try again. Error Code: net::ERR_CONNECTION_TIMED_OUT.'),
      'sm_entry',
    );

    expect(diagnostic.code, 'the token survives token-sanitisation intact').toBe('net::ERR_CONNECTION_TIMED_OUT');
    expect(isTransportProviderError(diagnostic)).toBe(true);
    expect(describeProviderErrorForUser(diagnostic)).toContain('temporary network or service issue');
  });

  // The host attaches the same network-layer advice to unrelated failure modes, so relaying it
  // inside our own "temporary, please try again" line gave two contradictory remedies for one event.
  // The prose stays in the diagnostic — only the user-facing line drops it.
  it('keeps the host network prose out of the user-facing transport line', () => {
    const diagnostic = sanitizeProviderErrorDiagnostic(
      new Error('Please check your firewall rules and network connection then try again. Error Code: net::ERR_CONNECTION_TIMED_OUT.'),
      'sm_entry',
    );

    const line = describeProviderErrorForUser(diagnostic);
    expect(line, 'the host remedy is not repeated to the user').not.toMatch(/firewall/i);
    expect(line, 'the token still names what happened').toContain('net::ERR_CONNECTION_TIMED_OUT');
    expect(diagnostic.message, 'the full message survives for the log and the trace').toContain('firewall');
  });

  it('classifies an HTTP/2 protocol failure as transport', () => {
    const diagnostic = sanitizeProviderErrorDiagnostic(
      new Error('Error Code: net::ERR_HTTP2_PROTOCOL_ERROR.'),
      'discover',
    );

    expect(isTransportProviderError(diagnostic)).toBe(true);
    // The same boilerplate arrives with a different failure mode, which is why the branch above
    // classifies on the code and reports the code.
    expect(describeProviderErrorForUser(diagnostic)).toContain('net::ERR_HTTP2_PROTOCOL_ERROR');
  });

  it('leaves a provider verdict a provider verdict', () => {
    // Listed explicitly rather than matched by `net::ERR_` prefix: a refusal is the provider
    // answering, and retrying it would burn the physical-call budget on a settled decision.
    const diagnostic = sanitizeProviderErrorDiagnostic(
      new Error('Error Code: net::ERR_BLOCKED_BY_CLIENT.'),
      'discover',
    );

    expect(isTransportProviderError(diagnostic)).toBe(false);
    expect(describeProviderErrorForUser(diagnostic)).toContain('reported an error');
  });

  it('still classifies a plain Node connection code', () => {
    const diagnostic = sanitizeProviderErrorDiagnostic(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      'active',
    );

    expect(isTransportProviderError(diagnostic)).toBe(true);
  });

  it.each([
    ['an empty-string code', 'net::ERR_CONNECTION_RESET', '' as unknown, 'net::ERR_CONNECTION_RESET', true],
    ['a numeric Chromium errno', 'net::ERR_CONNECTION_RESET', -101, 'net::ERR_CONNECTION_RESET', true],
    ['no transport token in the message', 'request failed', -2, '-2', false],
    ['no code property, an unlisted wrapper token first', 'net::ERR_FAILED caused by net::ERR_CONNECTION_RESET', undefined, 'net::ERR_CONNECTION_RESET', true],
  ])('recovers the right code with %s', (_title, message, code, expectedCode, transport) => {
    const err = code === undefined ? new Error(message) : Object.assign(new Error(message), { code });
    const diagnostic = sanitizeProviderErrorDiagnostic(err, 'active');
    expect(diagnostic.code).toBe(expectedCode);
    expect(isTransportProviderError(diagnostic)).toBe(transport);
  });
});

/**
 * Regression tests for the chat-replay sanitizer (`src/ai/support/text.ts`).
 *
 * @remarks
 * A cached AI description reaches chat only through this transform: `#focus-node:` links resolve
 * solely inside the graph webview, and the engine's `### Objects` transport line is a footnote in
 * the webview renderer but would render as a heading-scale object list in chat.
 */
describe('sanitizeDescriptionForChat', () => {
  it('reduces every focus-node link to its label, inside and outside the Objects line', () => {
    const out = sanitizeDescriptionForChat(
      'Body mentions [vwX](#focus-node:%5Bai%5D.%5Bvwx%5D) inline.\n\n### Objects [vwX](#focus-node:%5Bai%5D.%5Bvwx%5D), [spY](#focus-node:%5Bai%5D.%5Bspy%5D)',
    );
    expect(out).not.toContain('#focus-node:');
    expect(out).toContain('Body mentions vwX inline.');
  });

  it('demotes the Objects line to a small italic footnote', () => {
    const out = sanitizeDescriptionForChat('### Objects [vwX](#focus-node:%5Bai%5D.%5Bvwx%5D), [spY](#focus-node:%5Bai%5D.%5Bspy%5D)');
    expect(out).toBe('*Objects: vwX, spY*');
  });

  it('leaves ordinary prose markdown untouched', () => {
    const md = '## 1 Result\n\nText with `code` and [a real link](https://example.com).\n\n---\n\nClosing.';
    expect(sanitizeDescriptionForChat(md)).toBe(md);
  });
});
