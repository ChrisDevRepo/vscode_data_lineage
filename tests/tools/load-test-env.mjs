import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const ENV_FILE = resolve('.env');
const testTimeout = z.coerce.number().int().min(1).max(2_147_423_647);
/** @public Exported for external contract checks. */
export const REQUIRED_AI_KEYS = [
  'AI_TEST_ENDPOINT',
  'AI_TEST_API_KEY',
  'AI_TEST_MODEL',
];
/** @public Exported for external contract checks. */
export const PROVIDER_PROFILES = {
  azure: ['AZURE_URI', 'AZURE_API', 'AZURE_MODEL'],
  fireworks: ['FIREWORKS_URL', 'FIREWORKS_API', 'FIREWORKS_MODEL'],
  openrouter: ['OPENROUTER_URL', 'OPENROUTER_API', 'OPENROUTER_MODEL'],
  'openai-compatible': [
    'AI_TEST_OPENAI_COMPATIBLE_ENDPOINT',
    'AI_TEST_OPENAI_COMPATIBLE_API_KEY',
    'AI_TEST_OPENAI_COMPATIBLE_MODEL',
  ],
};
/** Env names whose values are secrets and must never reach run evidence; the harness redacts them. */
export const SECRET_ENV_KEYS = [
  'AI_TEST_API_KEY',
  'DB_TEST_PASSWORD',
  'DB_TEST_TOKEN',
  'LANGFUSE_SECRET_KEY',
];

const execFileAsync = promisify(execFile);

/** Uses the signed-in Azure CLI account without opening a login flow or persisting its token. */
async function cliDatabaseToken(env, timeoutMs, executeCli) {
  const args = [
    'account',
    'get-access-token',
    '--resource',
    'https://database.windows.net/',
    '--query',
    'accessToken',
    '--output',
    'tsv',
    '--only-show-errors',
  ];
  let commands;
  if (hasValue(env.DB_TEST_AZURE_CLI_COMMAND)) {
    commands = [
      z
        .array(z.string().min(1))
        .min(1)
        .parse(JSON.parse(env.DB_TEST_AZURE_CLI_COMMAND)),
    ];
  } else if (process.platform === 'win32') {
    commands = [[env.ComSpec || 'cmd.exe', '/d', '/c', 'az']];
  } else {
    commands = [['az']];
    if (hasValue(env.WSL_DISTRO_NAME)) {
      commands.push(['cmd.exe', '/d', '/c', 'az']);
      // WSL may omit Windows executables from PATH; discover its mounted Windows system volume.
      const mounts = readFileSync('/proc/mounts', 'utf8').split('\n');
      for (const line of mounts) {
        const [source, mount, type] = line.split(' ');
        if (!/^[A-Za-z]:/.test(source) || !['9p', 'drvfs'].includes(type))
          continue;
        const directory = mount.replace(/\\([0-7]{3})/g, (_, octal) =>
          String.fromCharCode(parseInt(octal, 8)),
        );
        const command = join(directory, 'Windows', 'System32', 'cmd.exe');
        if (existsSync(command)) commands.push([command, '/d', '/c', 'az']);
      }
    }
  }
  for (const [index, command] of commands.entries()) {
    try {
      const { stdout } = await executeCli(
        command[0],
        [...command.slice(1), ...args],
        {
          env,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
        },
      );
      return { token: stdout.trim() };
    } catch (error) {
      if (error.code !== 'ENOENT' || index === commands.length - 1) throw error;
    }
  }
  throw new Error('Azure CLI is unavailable.');
}

/** Acquires an Entra SQL token in memory: existing token, explicit password profile, then signed-in Azure CLI. */
export async function prepareDatabaseToken(
  env = process.env,
  acquireToken,
  timeoutMs = 300_000,
  executeCli = execFileAsync,
) {
  if (env.DB_TEST_AUTH_TYPE !== 'entraId' || hasValue(env.DB_TEST_TOKEN))
    return;
  if (hasValue(env.DB_TEST_CLIENT_ID)) {
    for (const key of [
      'DB_TEST_TENANT_ID',
      'DB_TEST_USER',
      'DB_TEST_PASSWORD',
    ]) {
      if (!hasValue(env[key]))
        throw new Error(
          `Set ${key} for noninteractive Entra database testing.`,
        );
    }
  }
  try {
    const acquire =
      acquireToken ??
      (async () => {
        if (!hasValue(env.DB_TEST_CLIENT_ID))
          return cliDatabaseToken(env, timeoutMs, executeCli);
        const { UsernamePasswordCredential } = await import('@azure/identity');
        const credential = new UsernamePasswordCredential(
          env.DB_TEST_TENANT_ID,
          env.DB_TEST_CLIENT_ID,
          env.DB_TEST_USER,
          env.DB_TEST_PASSWORD,
        );
        return credential.getToken('https://database.windows.net/.default', {
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
      });
    const token = await acquire();
    if (!hasValue(token?.token)) throw new Error('No access token returned.');
    env.DB_TEST_TOKEN = token.token;
  } catch {
    throw new Error(
      'Noninteractive Entra database authentication failed; use an existing signed-in Azure CLI account or the explicit test credential profile. No interactive sign-in was attempted.',
    );
  }
}

/** Loads optional test environment values and resolves a selected AI provider profile. */
export function loadTestEnv({
  env = process.env,
  envFile = ENV_FILE,
  requireAiProvider = false,
} = {}) {
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

  if (requireAiProvider) {
    env.AI_TEST_TIMEOUT_MS = timeoutSetting(
      'AI_TEST_TIMEOUT_MS',
      env.AI_TEST_TIMEOUT_MS?.trim() || 7_200_000,
    );
    env.AI_TEST_REQUEST_TIMEOUT_MS = timeoutSetting(
      'AI_TEST_REQUEST_TIMEOUT_MS',
      env.AI_TEST_REQUEST_TIMEOUT_MS?.trim() || env.AI_TEST_TIMEOUT_MS,
    );
  }
  return applyProviderProfile(env, requireAiProvider);
}

function timeoutSetting(name, value) {
  const parsed = testTimeout.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `${name} must be a whole number of milliseconds from 1 to 2147423647.`,
    );
  return String(parsed.data);
}

function parseEnv(source) {
  const parsed = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u,
    );
    if (!match) continue;
    let value = match[2];
    const quoted = value.match(/^(["'])(.*?)\1(?:\s+#.*)?$/u);
    if (quoted) {
      value = quoted[2];
    } else {
      value = value.replace(/\s+#.*$/u, '').trim();
    }
    parsed.set(match[1], value);
  }
  return parsed;
}

function interpolate(raw, parsed, env) {
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, ref) =>
    hasValue(env[ref]) ? env[ref] : (parsed.get(ref) ?? ''),
  );
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function applyProviderProfile(env, required) {
  const provider = env.AI_TEST_PROVIDER?.trim().toLowerCase();
  if (!provider) {
    if (required)
      throw new Error(
        'Set AI_TEST_PROVIDER before running npm run test:ai:smoke.',
      );
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
    if (!hasValue(env[key]) && hasValue(env[aliases[index]]))
      env[key] = env[aliases[index]].trim();
  }

  if (!required) {
    return hasValue(env.AI_TEST_MODEL)
      ? { provider, model: env.AI_TEST_MODEL.trim() }
      : undefined;
  }

  const missing = REQUIRED_AI_KEYS.filter((key) => !hasValue(env[key]));
  if (missing.length > 0) {
    throw new Error(
      `Provider profile "${provider}" is missing ${missing.join(', ')}.`,
    );
  }

  let endpoint;
  try {
    endpoint = new URL(env.AI_TEST_ENDPOINT);
  } catch {
    throw new Error(
      `AI_TEST_ENDPOINT for provider "${provider}" must be an absolute HTTP(S) URL.`,
    );
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error(
      `AI_TEST_ENDPOINT for provider "${provider}" must use HTTP or HTTPS.`,
    );
  }

  env.AI_TEST_ENDPOINT = env.AI_TEST_ENDPOINT.trim();
  env.AI_TEST_API_KEY = env.AI_TEST_API_KEY.trim();
  env.AI_TEST_MODEL = env.AI_TEST_MODEL.trim();
  return { provider, model: env.AI_TEST_MODEL };
}
