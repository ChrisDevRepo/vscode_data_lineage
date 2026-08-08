import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const aiRoot = fileURLToPath(new URL('../../../src/ai', import.meta.url));
const bridgePath = fileURLToPath(new URL('../../../src/bridge/messageHandlers.ts', import.meta.url));

/** Every database-execution identifier that must never appear in the production AI tree. */
const DATABASE_EXECUTION_PATTERN =
  /connectionManager|dmvExtractor|profilingEngine|executeSimpleQuery|executeDmvQueries|promptForConnection|table-stats-request/;

/**
 * A token that provably exists in `src/ai/**`. The negative match below is vacuously true when the
 * scan reads nothing, so the same scan must also find this control before the absence proof counts.
 */
const SCAN_POSITIVE_CONTROL = 'NavigationEngine';

/** Floor for the number of scanned AI sources — a collapsed tree must fail, not silently pass. */
const MIN_SCANNED_AI_SOURCES = 40;

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

describe('AI/database capability boundary', () => {
  it('keeps database execution modules and calls outside the production AI tree', () => {
    const files = sourceFiles(aiRoot);
    const source = files.map(path => readFileSync(path, 'utf8')).join('\n');

    // Fail closed: an empty or truncated scan would make the absence assertion meaningless.
    expect(
      files.length,
      'the AI source scan resolved too few files — an empty scan cannot prove absence',
    ).toBeGreaterThanOrEqual(MIN_SCANNED_AI_SOURCES);
    expect(
      source,
      'the scan must actually read AI source text before its negative match proves anything',
    ).toContain(SCAN_POSITIVE_CONTROL);

    expect(source).not.toMatch(DATABASE_EXECUTION_PATTERN);
  });

  it('enforces the profiling disable switch again at the extension-host boundary', () => {
    const source = readFileSync(bridgePath, 'utf8');
    const guard = source.indexOf("cfg.get('tableStatistics.enabled', true)");
    const firstConnection = source.indexOf('connectDirect(', guard);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(firstConnection).toBeGreaterThan(guard);
  });
});
