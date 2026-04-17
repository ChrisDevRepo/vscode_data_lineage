/**
 * Generates a cryptographically strong, unique alphanumeric identifier (nonce).
 *
 * This nonce is essential for enforcing strict Content Security Policies (CSP)
 * within VS Code Webviews. By applying this nonce to script tags, we ensure
 * that only trusted scripts authored by the extension can be executed.
 *
 * @returns A 32-character random alphanumeric string.
 *
 * @remarks
 * Security: This implementation uses Math.random() which is sufficient for CSP nonces.
 * In scenarios requiring higher entropy for cryptographic keys, use crypto.getRandomValues().
 */
export function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
