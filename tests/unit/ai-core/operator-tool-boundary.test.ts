import { describe, expect, it } from 'vitest';
import { redactSecret } from '../../harness/harnessSecrets';

const secret = 'synthetic-secret';

describe('operator secret boundary', () => {
  it.each([
    [
      'replaces the secret wherever it appears',
      `seen ${secret} here`,
      secret,
      'seen [redacted] here',
    ],
    [
      'leaves text unchanged when no secret is configured',
      `seen ${secret} here`,
      '',
      `seen ${secret} here`,
    ],
  ] as const)('%s', (_name, text, hidden, expected) => {
    expect(redactSecret(text, hidden)).toBe(expected);
  });
});
