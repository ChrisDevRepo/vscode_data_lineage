/**
 * Unit tests for the transient-network classifier that gates the LM-call retry loop.
 *
 * The full predicate `isTransientLmError` in lineageParticipant.ts adds a
 * `vscode.LanguageModelError` gate (intentional model-side decisions: Cancelled / NoPermissions /
 * Blocked → never retried). That gate cannot be exercised under tsx because there is no `vscode`
 * runtime; the tests here cover the pure regex layer (`matchesTransientNetPattern`), which is the
 * payload-classification half of the predicate. The instanceof gate is one short conditional and
 * is covered by code review.
 */

import { assert, printSummary, resetCounters } from './helpers/testUtils';
import { matchesTransientNetPattern } from '../../src/ai/transientErrors';

console.log('Transient-network retry classifier');
console.log('='.repeat(40));
resetCounters();

console.log(`\n── Transient codes: classified true ──`);

const transientCases: Array<{ name: string; err: unknown }> = [
  { name: 'ERR_NETWORK_CHANGED via code property',                err: Object.assign(new Error('network changed mid-request'), { code: 'ERR_NETWORK_CHANGED' }) },
  { name: 'ECONNRESET via code property',                          err: Object.assign(new Error('socket hang up'),               { code: 'ECONNRESET' }) },
  { name: 'ETIMEDOUT via code property',                           err: Object.assign(new Error('connect timeout'),              { code: 'ETIMEDOUT' }) },
  { name: 'EAI_AGAIN via code property',                           err: Object.assign(new Error('getaddrinfo retry'),            { code: 'EAI_AGAIN' }) },
  { name: 'plain "fetch failed" message',                          err: new Error('fetch failed') },
  { name: 'message contains "network"',                            err: new Error('Underlying network error') },
  { name: 'message contains "timeout"',                            err: new Error('request timeout after 60s') },
  { name: 'message contains "reset"',                              err: new Error('Connection reset by peer') },
  { name: 'plain string "ERR_NETWORK_CHANGED"',                    err: 'ERR_NETWORK_CHANGED' },
];
for (const c of transientCases) {
  assert(matchesTransientNetPattern(c.err) === true, `transient: ${c.name}`);
}

console.log(`\n── Non-transient values: classified false ──`);

const nonTransientCases: Array<{ name: string; err: unknown }> = [
  { name: 'auth-style message',                                    err: new Error('User does not have permissions') },
  { name: 'quota-style message',                                   err: new Error('Quota exceeded for this model') },
  { name: 'content-blocked-style message',                         err: new Error('Response blocked by content policy') },
  { name: 'malformed-input message (no transient vocab)',          err: new Error('Invalid request: tools[0].name is required') },
  { name: 'cancellation message (engine surfaces this differently from networking)', err: new Error('cancelled') },
  { name: 'undefined',                                             err: undefined },
  { name: 'null',                                                  err: null },
  { name: 'plain string with unrelated text',                      err: 'service unavailable' /* no "network|timeout|reset|fetch" */ },
];
for (const c of nonTransientCases) {
  assert(matchesTransientNetPattern(c.err) === false, `non-transient: ${c.name}`);
}

console.log(`\n── Case-insensitivity ──`);
assert(matchesTransientNetPattern(new Error('NETWORK error')) === true, 'uppercase NETWORK matches');
assert(matchesTransientNetPattern(new Error('TIMEOUT')) === true, 'uppercase TIMEOUT matches');
assert(matchesTransientNetPattern(Object.assign(new Error('x'), { code: 'econnreset' })) === true, 'lowercase econnreset code matches');

printSummary('Transient-network retry classifier');
