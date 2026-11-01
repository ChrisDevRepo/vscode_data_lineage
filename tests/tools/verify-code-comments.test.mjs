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

test('a comment line over 100 columns fails, and a URL line does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'comment-scan-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'tests'));
    mkdirSync(join(root, 'scripts'));
    const prose =
      '// this comment line is intentionally longer than one hundred characters so the column rule reports this file.';
    const url =
      '// https://example.com/this-path-is-long-enough-to-pass-one-hundred-characters-without-being-reported-here';
    const indented = `${' '.repeat(4)}//${'x'.repeat(95)}`;
    const urlCore = `// https://example.com/${'u'.repeat(74)}`;
    const indentedUrl = `${' '.repeat(4)}${urlCore}`;
    const trailing = `${'const value = 1;'.padEnd(90)}// trail-marker`;
    assert.equal(indented.length, 101);
    assert.equal(indented.trimStart().length, 97);
    assert.equal(urlCore.length, 97);
    assert.equal(indentedUrl.length, 101);
    assert.ok(trailing.length > 100);
    writeFileSync(
      join(root, 'src', 'width.ts'),
      `${prose}\nconst marker = 1;\n`,
    );
    writeFileSync(join(root, 'src', 'url.ts'), `${url}\nconst marker = 1;\n`);
    writeFileSync(
      join(root, 'src', 'indent.ts'),
      `${indented}\nconst marker = 1;\n`,
    );
    writeFileSync(
      join(root, 'src', 'url-indent.ts'),
      `${indentedUrl}\nconst marker = 1;\n`,
    );
    writeFileSync(join(root, 'src', 'trailing.ts'), `${trailing}\n`);
    const run = spawnSync(process.execPath, [scanner], {
      cwd: root,
      encoding: 'utf8',
    });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    assert.equal(run.error, undefined, output);
    assert.notEqual(run.status, 0, output);
    assert.match(output, /src\/width\.ts/);
    assert.match(output, /src\/indent\.ts/);
    assert.match(output, /max-len/);
    assert.doesNotMatch(output, /src\/url\.ts/);
    assert.doesNotMatch(output, /src\/url-indent\.ts/);
    assert.doesNotMatch(output, /src\/trailing\.ts/);
    assert.doesNotMatch(output, /example\.com/);
    assert.doesNotMatch(output, /trail-marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
