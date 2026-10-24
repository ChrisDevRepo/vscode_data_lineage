/** Returns a thrown value's message: `Error.message` for an `Error`, otherwise `String(value)`. It has no imports, so every layer can use it. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
