/** Reads object records from NDJSON, counting malformed or non-object lines; blank lines are ignored. */
export function readJsonLines(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}
