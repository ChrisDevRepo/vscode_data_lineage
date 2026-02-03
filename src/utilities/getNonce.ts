/**
 * A helper function that returns a unique alphanumeric identifier called a nonce.
 *
 * @remarks This function is primarily used to create a nonce for Content Security Policy
 * for scripts in a webview.
 *
 * @returns A nonce string
 */
export function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
