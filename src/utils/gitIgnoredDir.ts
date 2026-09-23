import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Marks a tool-owned scratch directory as ignored by git with a `*` `.gitignore`, the convention
 * `.pytest_cache` uses; an existing `.gitignore` is left untouched.
 */
export async function markGitIgnored(directory: string): Promise<void> {
  try {
    await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
