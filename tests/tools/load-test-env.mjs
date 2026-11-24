import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILE = resolve('.env');

/**
 * Loads optional test environment values from `.env` into `env`.
 *
 * Existing non-empty process values take precedence over `.env`. The AI_TEST_* entry is validated
 * by its owner, `aiTestEntry` in tests/harness/cli.ts. Secrets are never returned or logged.
 */
export function loadTestEnv({ env = process.env, envFile = ENV_FILE } = {}) {
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
