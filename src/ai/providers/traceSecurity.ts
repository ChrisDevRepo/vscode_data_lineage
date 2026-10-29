const FORBIDDEN_KEY = /(?:^|_)(?:authorization|api_?key|credential|password|secret|(?:request|response)_?headers?|headers?|endpoint|base_?url|uri|access_?token|refresh_?token|auth_?token)$/i;
const SECRET_ENV_KEY = /(?:^|_)(?:api|(?:api|secret)_?key|secret|password|token|credential)$/i;
const URL_ENV_KEY = /(?:^|_)(?:endpoint|base_?url)$/i;

/** Secret shapes refused before a value can reach a trace or a retry payload. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,4096}/i,
  /\b(?:sk|key)-[A-Za-z0-9_-]{12,4096}/i,
  /https?:\/\/\S{0,4096}(?:api[_-]?key|token|secret|password|authorization)=\S{1,4096}/i,
  /\b(?:password|pwd)\s*=\s*[^;&"'\s]{4,512}/i,
  /\beyJ[A-Za-z0-9_-]{6,4096}\.[A-Za-z0-9_-]{6,4096}\.[A-Za-z0-9_-]{6,4096}/,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  /\bgh[porsu]_[A-Za-z0-9]{20,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,255}\b/,
];

/** Minimum base64 run length treated as a possible encoded secret. */
const MIN_BASE64_SECRET_CHARS = 64;

/** Maximum `/` density tolerated inside a base64 run, as one slash per N characters. */
const MAX_BASE64_SLASH_RATIO = 16;

const BASE64_RUN = new RegExp(`[A-Za-z0-9+/]{${MIN_BASE64_SECRET_CHARS},}={0,2}`, 'g');

/** Recognizes long, high-entropy base64 blobs — encoded keys, certificates, serialized credentials. */
function looksLikeBase64Secret(value: string): boolean {
  BASE64_RUN.lastIndex = 0;
  for (let match = BASE64_RUN.exec(value); match; match = BASE64_RUN.exec(value)) {
    const run = match[0];
    const slashes = run.length - run.replace(/\//g, '').length;
    if (slashes * MAX_BASE64_SLASH_RATIO > run.length) continue;
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  return false;
}

function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value)) || looksLikeBase64Secret(value);
}

function normalizedKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_');
}

let cachedSecrets: string[] | undefined;

/** Secret environment values and the bare host of each configured endpoint URL. */
export function configuredSecrets(): string[] {
  cachedSecrets ??= Object.entries(process.env).flatMap(([key, value]) => {
    const name = normalizedKey(key);
    if (typeof value !== 'string') return [];
    if (SECRET_ENV_KEY.test(name)) return [value];
    if (!URL_ENV_KEY.test(name)) return [];
    try { return [new URL(value).hostname]; } catch { return []; }
  }).filter(secret => secret.length >= 8);
  return cachedSecrets;
}

/** Returns a stable refusal reason without returning or serializing the sensitive value. */
export function sensitiveTraceReason(value: unknown): 'forbidden_key' | 'secret_value' | undefined {
  const secrets = configuredSecrets();
  const seen = new WeakSet<object>();
  const visit = (item: unknown): 'forbidden_key' | 'secret_value' | undefined => {
    if (typeof item === 'string') {
      return looksLikeSecretValue(item) || secrets.some(secret => item.includes(secret)) ? 'secret_value' : undefined;
    }
    if (!item || typeof item !== 'object' || item instanceof Error) return undefined;
    if (seen.has(item)) return undefined;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        const reason = visit(child);
        if (reason) return reason;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(normalizedKey(key))) return 'forbidden_key';
      const reason = visit(child);
      if (reason) return reason;
    }
    return undefined;
  };
  return visit(value);
}
