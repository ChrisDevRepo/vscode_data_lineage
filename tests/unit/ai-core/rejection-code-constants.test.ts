/**
 * A rejection code emitted on more than one surface has exactly one home.
 *
 * @remarks
 * `REJECTION_CODES` (`src/ai/support/rejectionCodes.ts`) owns any code a second site emits, so a
 * rename cannot drift between the emitting guard, the prompt that teaches the recovery, and the
 * schema that types the envelope. These five each had three or more hand-typed literals (P1-131
 * added `invalid_regex`, emitted at four sites in `tools.ts` and named in `toolDefs.ts` prose).
 * The scan reads the shipped source rather than the module graph: a literal reintroduced in a file
 * this suite never imports is exactly the drift the rule exists to catch.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rootPath } from '../helpers/testUtils';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';

/** Codes with more than one emission site; every site must interpolate the constant. */
const MULTI_SITE_CODES = [
  REJECTION_CODES.staleTurn,
  REJECTION_CODES.invalidInput,
  REJECTION_CODES.notFound,
  REJECTION_CODES.supplementRequiresCompleteEngine,
  REJECTION_CODES.invalidRegex,
] as const;

const AI_ROOT = rootPath('src', 'ai');
const OWNER = join(AI_ROOT, 'support', 'rejectionCodes.ts');

/** Every `.ts` file under `src/ai`, minus the constants module that legitimately holds the literals. */
function aiSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...aiSourceFiles(full));
    else if (entry.name.endsWith('.ts') && full !== OWNER) files.push(full);
  }
  return files;
}

describe('rejection codes — one home per multi-site code', () => {
  it('leaves no hand-typed literal for a multi-site code anywhere in src/ai', () => {
    const offenders: string[] = [];
    for (const file of aiSourceFiles(AI_ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const code of MULTI_SITE_CODES) {
          if (line.includes(`error: '${code}'`) || line.includes(`error: "${code}"`)) {
            offenders.push(`${file.slice(AI_ROOT.length + 1)}:${index + 1} ${code}`);
          }
        }
      });
    }
    expect(offenders, 'every emission site interpolates REJECTION_CODES').toEqual([]);
  });

  it('keeps the four codes exported with their wire values unchanged', () => {
    expect(MULTI_SITE_CODES).toEqual([
      'stale_turn',
      'invalid_input',
      'not_found',
      'supplement_requires_complete_engine',
      'invalid_regex',
    ]);
  });
});
