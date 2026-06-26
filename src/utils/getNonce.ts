import * as crypto from 'crypto';

/**
 * Generates a cryptographically strong, unique hexadecimal identifier (nonce).
 *
 * This nonce is essential for enforcing strict Content Security Policies (CSP)
 * within VS Code Webviews. By applying this nonce to script tags, we ensure
 * that only trusted scripts authored by the extension can be executed.
 *
 * @returns A 32-character random hex string.
 */
export function getNonce() {
  return crypto.randomBytes(16).toString('hex');
}
