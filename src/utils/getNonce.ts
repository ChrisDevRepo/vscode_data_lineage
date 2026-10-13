import * as crypto from 'crypto';

/**
 * Generates a cryptographically strong, unique hexadecimal identifier (nonce).
 *
 * This nonce is essential for enforcing strict Content Security Policies (CSP)
 * within VS Code Webviews. Applying this nonce to script tags ensures
 * that only trusted scripts provided by the extension are executed.
 *
 * @returns A 32-character random hex string.
 */
export function getNonce() {
  return crypto.randomBytes(16).toString('hex');
}
