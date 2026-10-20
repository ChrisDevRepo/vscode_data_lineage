import * as crypto from 'crypto';

/** Generates a cryptographically strong, unique hexadecimal identifier (nonce). */
export function getNonce() {
  return crypto.randomBytes(16).toString('hex');
}
