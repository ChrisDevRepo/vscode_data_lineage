import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scanner = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts/verify-code-comments.mjs',
);

test('comment rules apply under tests and scripts, not only src', () => {
  const root = mkdtempSync(join(tmpdir(), 'comment-scan-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'tests'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(
      join(root, 'src', 'clean.ts'),
      '/** Marker kept inside the existing comment rules. */\nexport const marker = 1;\n',
    );
    writeFileSync(
      join(root, 'tests', 'chatty.test.ts'),
      '// we left a pronoun here\nconst marker = 1;\n',
    );
    writeFileSync(
      join(root, 'scripts', 'chatty.mjs'),
      '// TODO: remove this marker\nconst marker = 1;\n',
    );
    const run = spawnSync(process.execPath, [scanner], {
      cwd: root,
      encoding: 'utf8',
    });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    assert.equal(run.error, undefined, output);
    assert.notEqual(run.status, 0, output);
    assert.match(output, /tests\/chatty\.test\.ts/);
    assert.match(output, /scripts\/chatty\.mjs/);
    assert.doesNotMatch(output, /src\/clean\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
