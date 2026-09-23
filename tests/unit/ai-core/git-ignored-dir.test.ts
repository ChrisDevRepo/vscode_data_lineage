/**
 * Pins `markGitIgnored`: an output directory gets an ignore-everything `.gitignore` once, and an
 * existing one is never overwritten.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { markGitIgnored } from '../../../src/utils/gitIgnoredDir';

describe('markGitIgnored', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('writes an ignore-everything .gitignore once and never overwrites an existing one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'git-ignored-'));
    await markGitIgnored(dir);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*\n');

    await writeFile(join(dir, '.gitignore'), 'custom\n');
    await markGitIgnored(dir);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('custom\n');
  });
});
