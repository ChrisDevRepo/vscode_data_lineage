import { describe, expect, it } from 'vitest';
import { databaseConfig } from '../../harness/cli';
import { redactSecret } from '../../harness/harnessSecrets';
import { OpenAiCompatiblePort } from '../../harness/openAiCompatiblePort';
import { modelUserMessage } from '../../../src/ai/model/modelPort';

const secret = 'synthetic-secret';

describe('operator secret boundary', () => {
  it('does not put the database password on the connection object', () => {
    const config = databaseConfig({
      DB_TEST_SERVER: 'localhost',
      DB_TEST_DATABASE: 'synthetic',
      DB_TEST_USER: 'reader',
      DB_TEST_PASSWORD: 'synthetic-password',
    });
    expect(config).not.toHaveProperty('password');
    expect(JSON.stringify(config)).not.toContain('synthetic-password');
  });

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

  it('does not return the API key from an HTTP rejection', async () => {
    const port = new OpenAiCompatiblePort(
      {
        baseUrl: 'https://provider.example/v1',
        apiKey: secret,
        model: 'synthetic-model',
      },
      {
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => secret,
          headers: { get: () => null },
        }),
      },
    );
    const outcome = await port.generateToolTurn({
      messages: [modelUserMessage('synthetic input')],
      tools: [],
      toolChoice: 'auto',
      phase: 'discovery',
    });
    expect(outcome.status).toBe('error');
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
});
