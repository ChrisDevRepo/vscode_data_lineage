/**
 * Logging normalization guard — every output-channel line must be single-line.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { logInfo, logDebug, logWarn, logError, sanitizeForLog } from '../../../src/utils/log';
import { safeIdentifier } from '../../../src/ai/support/logIdentifier';

type Calls = { info: string[]; debug: string[]; warn: string[]; error: string[] };
const calls: Calls = { info: [], debug: [], warn: [], error: [] };
const channel: any = {
  info: (s: string) => calls.info.push(s),
  debug: (s: string) => calls.debug.push(s),
  warn: (s: string) => calls.warn.push(s),
  error: (s: string) => calls.error.push(s),
};

describe('Log Normalization', () => {
  beforeAll(() => {
    logInfo(channel, 'AI', 'line1\nline2\tA  B');
    logDebug(channel, 'AI', 'value:\\nnext');
    logDebug(channel, 'AI', '[AI] [Hop 13] sliding memory wipe');
    logWarn(channel, 'AI', 'warn\r\nmessage');

    const err = new Error('boom\nbreak');
    Object.defineProperty(err, 'stack', {
      value: 'Error: boom\nat line 1\nat line 2',
      configurable: true,
    });
    logError(channel, 'AI', 'unit-op', err);
  });

  it.each([
    ['logInfo normalizes to single-line', 'info', 0, '[AI] line1 line2 A B'],
    ['logDebug normalizes escaped newline', 'debug', 0, '[AI] value: next'],
    ['structured logging removes a redundant manual category prefix', 'debug', 1, '[AI] [Hop 13] sliding memory wipe'],
    ['logWarn normalizes CRLF', 'warn', 0, '[AI] warn message'],
  ] as const)('%s', (_label, level, index, expected) => {
    expect(calls[level][index]).toBe(expected);
  });

  it('logError emits single-line message + stack lines', () => {
    expect(calls.error.length >= 2, 'logError emits message + stack lines').toBe(true);
    expect(calls.error[0].includes('\n'), 'logError detail is single-line').toBe(false);
    expect(calls.error[1].includes('\n'), 'logError stack is single-line').toBe(false);
  });

  it('sanitizeForLog trims and collapses whitespace', () => {
    expect(sanitizeForLog(' a\\n b \n c\t\t d  ')).toBe('a b c d');
  });
});

describe('safeIdentifier', () => {
  const options = { replacement: '_', maxLength: 64, fallback: '(none)' };

  it('keeps the allowed set and replaces everything else', () => {
    expect(safeIdentifier('lineage get\nobject:detail-1.2', { ...options, extraChars: '.:-' }))
      .toBe('lineage_get_object:detail-1.2');
  });

  it('accepts any extraChars ordering — the class is escaped, never interpolated raw', () => {
    // Verbatim interpolation makes `'-.'` build `[^A-Za-z0-9_-.]`, where `_-.` is a code-point
    // range: `new RegExp` throws from inside a helper whose contract is to never break its caller.
    expect(() => safeIdentifier('a.b-c!', { ...options, extraChars: '-.' })).not.toThrow();
    expect(safeIdentifier('a.b-c!', { ...options, extraChars: '-.' })).toBe('a.b-c_');
    expect(safeIdentifier('a^b\\c]d', { ...options, extraChars: '^\\]' })).toBe('a^b\\c]d');
  });

  it('falls back when sanitizing empties the value', () => {
    expect(safeIdentifier('!!!', { ...options, extraChars: '.:-', replacement: '' })).toBe('(none)');
  });
});
