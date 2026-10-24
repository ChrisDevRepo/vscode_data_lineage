/** Object-only NDJSON decoding shared by diagnostic readers. */
export function readJsonLines(text: string): { records: Record<string, unknown>[]; skipped: number };
