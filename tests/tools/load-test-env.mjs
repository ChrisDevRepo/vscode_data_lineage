import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILE = resolve('.env');
const REQUIRED_AI_KEYS = [
  'AI_TEST_ENDPOINT', 'AI_TEST_API_KEY', 'AI_TEST_MODEL', 'AI_TEST_API_TYPE', 'AI_TEST_MAX_INPUT_TOKENS', 'AI_TEST_MAX_OUTPUT_TOKENS',
];

/**
 * Loads optional test environment values and, when `requireAiProvider` is set, checks the AI model entry.
 *
 * Existing non-empty process values take precedence over `.env`. The entry is the AI_TEST_* variables of
 * tests/harness/cli.ts (aiTestEntry); the key comes from the environment only. Secrets are never returned or logged.
 */
export function loadTestEnv({ env = process.env, envFile = ENV_FILE, requireAiProvider = false } = {}) {
  let source;
  try {
    source = readFileSync(envFile, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (source !== undefined) {
    const parsed = parseEnv(source);
    for (const [key, raw] of parsed) {
      if (hasValue(env[key])) continue;
      env[key] = interpolate(raw, parsed, env);
    }
  }

  return checkAiEntry(env, requireAiProvider);
}

function parseEnv(source) {
  const parsed = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, '').trim();
    }
    parsed.set(match[1], value);
  }
  return parsed;
}

function interpolate(raw, parsed, env) {
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, ref) =>
    hasValue(env[ref]) ? env[ref] : (parsed.get(ref) ?? ''));
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkAiEntry(env, required) {
  if (!required) return hasValue(env.AI_TEST_MODEL) ? { model: env.AI_TEST_MODEL.trim() } : undefined;

  const missing = REQUIRED_AI_KEYS.filter((key) => !hasValue(env[key]));
  if (missing.length > 0) throw new Error(`The AI test entry is missing ${missing.join(', ')}.`);

  let endpoint;
  try {
    endpoint = new URL(env.AI_TEST_ENDPOINT);
  } catch {
    throw new Error('AI_TEST_ENDPOINT must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('AI_TEST_ENDPOINT must use HTTP or HTTPS.');

  for (const key of REQUIRED_AI_KEYS) env[key] = env[key].trim();
  return { model: env.AI_TEST_MODEL };
}
