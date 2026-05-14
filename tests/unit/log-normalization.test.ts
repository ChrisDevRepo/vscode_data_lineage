/**
 * Logging normalization guard — every output-channel line must be single-line.
 */

import { assert, assertEq, resetCounters, printSummary } from './helpers/testUtils';
import { logInfo, logDebug, logWarn, logRaw, logError, sanitizeForLog } from '../../src/utils/log';

console.log('Log Normalization');
console.log('='.repeat(40));
resetCounters();

type Calls = { info: string[]; debug: string[]; warn: string[]; error: string[] };
const calls: Calls = { info: [], debug: [], warn: [], error: [] };
const channel: any = {
  info: (s: string) => calls.info.push(s),
  debug: (s: string) => calls.debug.push(s),
  warn: (s: string) => calls.warn.push(s),
  error: (s: string) => calls.error.push(s),
};

logInfo(channel, 'AI', 'line1\nline2\tA  B');
assertEq(calls.info[0], '[AI] line1 line2 A B', 'logInfo normalizes to single-line');

logDebug(channel, 'AI', 'value:\\nnext');
assertEq(calls.debug[0], '[AI] value: next', 'logDebug normalizes escaped newline');

logWarn(channel, 'AI', 'warn\r\nmessage');
assertEq(calls.warn[0], '[AI] warn message', 'logWarn normalizes CRLF');

logRaw(channel, 'debug', '[AI] raw\\nentry\nwith\tspacing');
assertEq(calls.debug[1], '[AI] raw entry with spacing', 'logRaw normalizes escaped+real control chars');

const err = new Error('boom\nbreak');
Object.defineProperty(err, 'stack', {
  value: 'Error: boom\nat line 1\nat line 2',
  configurable: true,
});
logError(channel, 'AI', 'unit-op', err);
assert(calls.error.length >= 2, 'logError emits message + stack lines');
assert(!calls.error[0].includes('\n'), 'logError detail is single-line');
assert(!calls.error[1].includes('\n'), 'logError stack is single-line');

assertEq(sanitizeForLog(' a\\n b \n c\t\t d  '), 'a b c d', 'sanitizeForLog trims and collapses whitespace');

printSummary('Log Normalization');
