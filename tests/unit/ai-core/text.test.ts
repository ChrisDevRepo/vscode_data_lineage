/**
 * Regression tests for `unescapeProseNewlines` (`src/ai/support/text.ts`).
 *
 * @remarks
 * Guards the exact corruption reported against `autoFixPresentResult`/`smBase.ts`'s prior blind
 * `text.replace(/\\n/g, '\n')`: a KaTeX macro starting with a literal backslash + `n` (`\not`,
 * `\neq`, `\nabla`) was split into a real newline plus the trailing letters. The fix must keep
 * unescaping genuine double-escaped newlines in prose while leaving fenced code and `$$...$$`
 * math byte-identical.
 */

import { describe, expect, it } from 'vitest';
import {
  quoteIds,
  unescapeProseNewlines,
  sanitizeProviderErrorDiagnostic,
  isTransportProviderError,
  describeProviderErrorForUser,
} from '../../../src/ai/support/text';

describe('unescapeProseNewlines', () => {
  it('(a) unescapes a literal \\n in plain prose into a real newline', () => {
    const input = 'First line.\\n\\nSecond paragraph.';
    expect(unescapeProseNewlines(input)).toBe('First line.\n\nSecond paragraph.');
  });

  it('(b) leaves a KaTeX macro starting with \\n untouched inside a $$...$$ block', () => {
    const input = '$$ValidationMessage \\lor ValidationMessage \\not\\text{ LIKE } \\%Unknown\\ region\\%$$';
    expect(unescapeProseNewlines(input)).toBe(input);
  });

  it('(c) leaves \\n untouched inside fenced code', () => {
    const input = '```sql\nSELECT \'\\n\' AS literal_backslash_n\n```';
    expect(unescapeProseNewlines(input)).toBe(input);
  });

  it('(d) unescapes prose surrounding an untouched $$...$$ block', () => {
    const input = 'Before.\\n$$\\neq$$\\nAfter.';
    expect(unescapeProseNewlines(input)).toBe('Before.\n$$\\neq$$\nAfter.');
  });

  it('(e) Regression: the exact spImportOrders IsValidated rule from the bug report round-trips unchanged', () => {
    const input =
      '$$IsValidated := 1 \\quad \\text{when } ValidationMessage \\text{ is NULL } '
      + '\\lor ValidationMessage \\not\\text{ LIKE } \\%Unknown\\ region\\%$$';
    expect(unescapeProseNewlines(input)).toBe(input);
    expect(unescapeProseNewlines(input)).not.toMatch(/\n/);
  });

  it('(f) leaves \\n untouched inside an inline code span while unescaping the surrounding prose', () => {
    const input = 'Values separated by `\\n` characters.\\nNext line.';
    expect(unescapeProseNewlines(input)).toBe('Values separated by `\\n` characters.\nNext line.');
  });

  it('(g) protects a fence opened with four backticks by its equal-run closure', () => {
    const input = '````\ncontains \\n and ``` inside\n````';
    expect(unescapeProseNewlines(input)).toBe(input);
  });

  it('(h) treats an unclosed backtick run as prose, matching the validator that rejects it', () => {
    expect(unescapeProseNewlines('broken `span\\n')).toBe('broken `span\n');
  });
});

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

  it('recovers the message token when the error carries an empty-string code', () => {
    const diagnostic = sanitizeProviderErrorDiagnostic(
      Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: '' }),
      'active',
    );

    expect(diagnostic.code).toBe('net::ERR_CONNECTION_RESET');
    expect(isTransportProviderError(diagnostic)).toBe(true);
  });

  it('prefers the message token over a numeric Chromium errno', () => {
    const diagnostic = sanitizeProviderErrorDiagnostic(
      Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: -101 }),
      'active',
    );

    expect(diagnostic.code).toBe('net::ERR_CONNECTION_RESET');
    expect(isTransportProviderError(diagnostic)).toBe(true);
  });

  it('keeps a numeric code when the message names no transport token', () => {
    const diagnostic = sanitizeProviderErrorDiagnostic(
      Object.assign(new Error('request failed'), { code: -2 }),
      'active',
    );

    expect(diagnostic.code).toBe('-2');
    expect(isTransportProviderError(diagnostic)).toBe(false);
  });

  it('skips an unlisted wrapper token and recovers the listed one after it', () => {
    const diagnostic = sanitizeProviderErrorDiagnostic(
      new Error('net::ERR_FAILED caused by net::ERR_CONNECTION_RESET'),
      'active',
    );

    expect(diagnostic.code).toBe('net::ERR_CONNECTION_RESET');
    expect(isTransportProviderError(diagnostic)).toBe(true);
  });
});
