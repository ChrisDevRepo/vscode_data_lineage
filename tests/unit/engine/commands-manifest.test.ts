/**
 * Verifies contributed VS Code commands against their runtime registrations.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { rootPath } from '../helpers/testUtils';

type Command = { command: string };

/**
 * Commands registered at runtime but deliberately absent from `contributes.commands`,
 * so neither reaches the Command Palette.
 *
 * - `openExternalProject` is the integration-test entry point for forcing a dacpac load.
 * - `aiResumeNativeGate` is invoked from chat gate links, never typed by a user.
 */
const INTENTIONALLY_UNCONTRIBUTED = [
  'dataLineageViz.aiResumeNativeGate',
  'dataLineageViz.openExternalProject',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

function registeredCommandIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of sourceFiles(rootPath('src'))) {
    const source = readFileSync(file, 'utf-8');
    // Literal id at the call site, or the module constant a call site passes instead.
    for (const [, id] of source.matchAll(/registerCommand\(\s*'([^']+)'/g)) ids.add(id);
    for (const [, id] of source.matchAll(/^const\s+\w*COMMAND\w*\s*=\s*'(dataLineageViz\.[^']+)'/gm)) ids.add(id);
  }
  return ids;
}

function contributedCommandIds(): string[] {
  const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf-8')) as {
    contributes?: { commands?: Command[] };
  };
  return (pkg.contributes?.commands ?? []).map((entry) => entry.command);
}

describe('VS Code commands manifest consistency', () => {
  it('every contributed command has a runtime registration', () => {
    const registered = registeredCommandIds();
    const missing = contributedCommandIds().filter((id) => !registered.has(id));
    expect(missing, 'palette commands with no registerCommand call').toEqual([]);
  });

  it('every registered command is contributed or explicitly exempt', () => {
    const contributed = new Set(contributedCommandIds());
    const undeclared = [...registeredCommandIds()]
      .filter((id) => id.startsWith('dataLineageViz.'))
      .filter((id) => !contributed.has(id) && !INTENTIONALLY_UNCONTRIBUTED.includes(id))
      .sort();
    expect(undeclared, 'commands registered but not reachable from the palette').toEqual([]);
  });
});
