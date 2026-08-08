/**
 * Logging normalization guard — every output-channel line must be single-line.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { logInfo, logDebug, logWarn, logRaw, logError, sanitizeForLog } from '../../../src/utils/log';

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
    logRaw(channel, 'debug', '[AI] raw\\nentry\nwith\tspacing');

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
    ['logRaw normalizes escaped+real control chars', 'debug', 2, '[AI] raw entry with spacing'],
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
