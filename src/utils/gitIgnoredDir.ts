import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Marks a tool-owned scratch directory as git-ignored with a `*` `.gitignore` (the `.pytest_cache`
 * convention); an existing `.gitignore` is left untouched.
 */
export async function markGitIgnored(directory: string): Promise<void> {
  try {
    await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
