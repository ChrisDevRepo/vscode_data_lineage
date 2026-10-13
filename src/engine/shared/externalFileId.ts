/** Legacy short key used only to resolve saved external-file references. */
export function externalFileId(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash |= 0;
  }
  return `[__ext__].[${Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8)}]`;
}
