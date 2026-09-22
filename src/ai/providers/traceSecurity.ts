const FORBIDDEN_KEY = /(?:^|_)(?:authorization|api_?key|credential|password|secret|(?:request|response)_?headers?|headers?|endpoint|base_?url|uri|access_?token|refresh_?token|auth_?token)$/i;
const SECRET_ENV_KEY = /(?:^|_)(?:api|api_?key|secret|password|token|credential)$/i;

/**
 * Secret shapes refused before a value can reach a trace or a retry payload.
 *
 * @remarks
 * Precision is chosen over recall deliberately: a false positive omits legitimate lineage evidence
 * from the model's next attempt (see `toolAttempt`), so each pattern anchors on a vendor prefix or
 * an explicit credential assignment rather than on entropy alone. Every quantifier is bounded and
 * none is nested, so matching stays linear even on adversarial input. Patterns are case-sensitive
 * wherever the real credential format is.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,4096}/i,
  /\b(?:sk|key)-[A-Za-z0-9_-]{12,4096}/i,
  /https?:\/\/\S{0,4096}(?:api[_-]?key|token|secret|password|authorization)=\S{1,4096}/i,
  // Connection-string credentials. ADO.NET, ODBC and JDBC all spell it `Password=` or `pwd=` and
  // none of them quote the value, so the secret runs to the next delimiter.
  /\b(?:password|pwd)\s*=\s*[^;&"'\s]{4,512}/i,
  // JSON Web Tokens: three dot-separated base64url runs whose header decodes from `{"` — `eyJ`.
  /\beyJ[A-Za-z0-9_-]{6,4096}\.[A-Za-z0-9_-]{6,4096}\.[A-Za-z0-9_-]{6,4096}/,
  // AWS access key identifiers — a fixed 20-character uppercase shape, so never case-folded.
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  // GitHub personal-access, OAuth, user, server and refresh tokens.
  /\bgh[porsu]_[A-Za-z0-9]{20,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/,
  // Slack bot, user, app-level, refresh and legacy tokens.
  /\bxox[abeprs]-[A-Za-z0-9-]{10,255}\b/,
];

/**
 * Minimum base64 run length treated as a possible encoded secret.
 *
 * @remarks
 * 64 characters is 48 decoded bytes — longer than any object name, column name, or schema-qualified
 * identifier the lineage traces actually carry, so the bound separates encoded key material from
 * ordinary catalog text without inspecting either.
 */
const MIN_BASE64_SECRET_CHARS = 64;

/**
 * Maximum `/` density tolerated inside a base64 run, as one slash per N characters.
 *
 * @remarks
 * Random base64 is about 1.6% slashes; a POSIX path or URL is an order of magnitude denser. 1-in-16
 * (6.25%) sits between the two, so long paths are not mistaken for encoded key material.
 */
const MAX_BASE64_SLASH_RATIO = 16;

const BASE64_RUN = new RegExp(`[A-Za-z0-9+/]{${MIN_BASE64_SECRET_CHARS},}={0,2}`, 'g');

/**
 * Recognizes long, high-entropy base64 blobs — encoded keys, certificates, serialized credentials.
 *
 * @remarks
 * Such a blob carries no vendor prefix to anchor on, so the test is narrowed three ways instead: a
 * length floor, all three character classes present (which excludes single-case hex digests), and a
 * slash-density ceiling (which excludes paths and URLs). The classes are checked in code rather than
 * with lookahead so the scan stays a single linear pass over each run.
 */
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

// Env is process-static for our purposes (secrets land before any trace runs); caching avoids
// re-scanning all of process.env on every evidence item of every traced call.
let cachedSecrets: string[] | undefined;

function configuredSecrets(): string[] {
  cachedSecrets ??= Object.entries(process.env)
    .filter(([key, value]) => SECRET_ENV_KEY.test(normalizedKey(key)) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string);
  return cachedSecrets;
}

/** Returns a stable refusal reason without returning or serializing the sensitive value. */
export function sensitiveTraceReason(value: unknown): 'forbidden_key' | 'secret_value' | undefined {
  const secrets = configuredSecrets();
  const seen = new WeakSet();
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
