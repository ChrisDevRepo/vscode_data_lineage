/** Host log copy shared by the opt-in VS Code provider and native chat checks. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/** Copies the current extension output log from an isolated VS Code profile when available. */
export function copyNativeHostLog(
  profile: string | undefined,
  destination: string,
): boolean {
  if (!profile || !existsSync(join(profile, 'logs'))) return false;
  const matches: Array<{ path: string; mtime: number }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.includes('Data Lineage Viz'))
        matches.push({ path, mtime: statSync(path).mtimeMs });
    }
  };
  walk(join(profile, 'logs'));
  const newest = matches.sort((left, right) => right.mtime - left.mtime)[0];
  if (!newest) return false;
  mkdirSync(destination, { recursive: true });
  copyFileSync(
    newest.path,
    join(
      destination,
      existsSync(join(destination, 'evidence-snapshot.json'))
        ? 'runner-diagnostics.log'
        : 'host.log',
    ),
  );
  return true;
}
