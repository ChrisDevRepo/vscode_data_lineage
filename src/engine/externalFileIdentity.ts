import { createHash } from 'node:crypto';

/**
 * Allocates bounded IDs from exact URL bytes, independent of other loaded files.
 * UTF-16 preserves every JavaScript code unit, including unmatched surrogates.
 * @throws If a generated ID is already owned by another URL or a catalog object.
 */
export function allocateExternalFileIds(urls: Iterable<string>, reserved: ReadonlySet<string>): Map<string, string> {
  const occupied = new Set(reserved);
  const result = new Map<string, string>();
  for (const url of new Set(urls)) {
    const id = `[__ext__].[${createHash('sha256').update(url, 'utf16le').digest('hex')}]`;
    if (occupied.has(id)) throw new Error('External-file identity conflicts with another object; model import refused.');
    occupied.add(id);
    result.set(url, id);
  }
  return result;
}
