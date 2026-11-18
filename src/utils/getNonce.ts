import * as crypto from 'crypto';

/**
 * Generates a cryptographically strong 32-character hex nonce for strict Content Security Policies
 * in VS Code Webviews: applied to script tags, it lets only the extension's own scripts run.
 */
export function getNonce() {
  return crypto.randomBytes(16).toString('hex');
}
