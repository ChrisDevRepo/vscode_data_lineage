import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILE = resolve('.env');
const REQUIRED_AI_KEYS = ['AI_TEST_ENDPOINT', 'AI_TEST_API_KEY', 'AI_TEST_MODEL'];
const PROVIDER_PROFILES = {
  azure: ['AZURE_URI', 'AZURE_API', 'AZURE_MODEL'],
  fireworks: ['FIREWORKS_URL', 'FIREWORKS_API', 'FIREWORKS_MODEL'],
  openrouter: ['OPENROUTER_URL', 'OPENROUTER_API', 'OPENROUTER_MODEL'],
  'openai-compatible': [
    'AI_TEST_OPENAI_COMPATIBLE_ENDPOINT',
    'AI_TEST_OPENAI_COMPATIBLE_API_KEY',
    'AI_TEST_OPENAI_COMPATIBLE_MODEL',
  ],
};

/**
 * Loads optional test environment values and resolves a selected AI provider profile.
 *
 * Existing non-empty process values take precedence over `.env`; provider-specific aliases fill
 * only missing canonical `AI_TEST_*` values. Secrets are never returned or logged.
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

  return applyProviderProfile(env, requireAiProvider);
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

function applyProviderProfile(env, required) {
  const provider = env.AI_TEST_PROVIDER?.trim().toLowerCase();
  if (!provider) {
    if (required) throw new Error('Set AI_TEST_PROVIDER before running npm run test:ai:smoke.');
    return undefined;
  }

  const aliases = PROVIDER_PROFILES[provider];
  if (!aliases) {
    if (!required) return undefined;
    throw new Error(
      `Unsupported AI_TEST_PROVIDER "${provider}". Use ${Object.keys(PROVIDER_PROFILES).join(', ')}.`,
    );
  }

  env.AI_TEST_PROVIDER = provider;
  for (const [index, key] of REQUIRED_AI_KEYS.entries()) {
    if (!hasValue(env[key]) && hasValue(env[aliases[index]])) env[key] = env[aliases[index]].trim();
  }

  if (!required) {
    return hasValue(env.AI_TEST_MODEL) ? { provider, model: env.AI_TEST_MODEL.trim() } : undefined;
  }

  const missing = REQUIRED_AI_KEYS.filter((key) => !hasValue(env[key]));
  if (missing.length > 0) {
    throw new Error(`Provider profile "${provider}" is missing ${missing.join(', ')}.`);
  }

  let endpoint;
  try {
    endpoint = new URL(env.AI_TEST_ENDPOINT);
  } catch {
    throw new Error(`AI_TEST_ENDPOINT for provider "${provider}" must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error(`AI_TEST_ENDPOINT for provider "${provider}" must use HTTP or HTTPS.`);
  }

  env.AI_TEST_ENDPOINT = env.AI_TEST_ENDPOINT.trim();
  env.AI_TEST_API_KEY = env.AI_TEST_API_KEY.trim();
  env.AI_TEST_MODEL = env.AI_TEST_MODEL.trim();
  return { provider, model: env.AI_TEST_MODEL };
}
