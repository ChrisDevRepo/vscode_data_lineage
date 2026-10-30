import { SECRET_ENV_KEYS } from '../tools/load-test-env.mjs';

/** Every configured harness secret plus the private host of the provider endpoint, for redaction at each sink. Not cached: the environment is read when the run starts. */
export function harnessSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = SECRET_ENV_KEYS.map((key) => env[key]);
  try {
    values.push(new URL(env.AI_TEST_ENDPOINT ?? '').hostname);
  } catch {
    /* no endpoint configured */
  }
  return values.filter((value): value is string => Boolean(value));
}
