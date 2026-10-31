#!/usr/bin/env node
/**
 * Fails when a tracked Markdown file names something that does not exist.
 *
 * Checks relative links, heading anchors, backticked repository paths, `npm run` scripts and
 * `dataLineageViz.*` settings. `CHANGELOG.md` is exempt from setting checks because it records
 * settings that were later removed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const execAsync = promisify(execFile);
const SKIP_FILES = new Set(['THIRD_PARTY_NOTICES.md']);
const SKIP_PREFIXES = ['tests/fixtures/'];

const files = (
  await execAsync('git', ['ls-files', '*.md'], {
    encoding: 'utf8',
    shell: false,
  })
).stdout
  .split('\n')
  .filter(
    (f) =>
      f && !SKIP_FILES.has(f) && !SKIP_PREFIXES.some((p) => f.startsWith(p)),
  );

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = new Set(Object.keys(pkg.scripts));
const settings = new Set();
for (const section of [].concat(pkg.contributes.configuration)) {
  for (const key of Object.keys(section.properties ?? {})) settings.add(key);
}

const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
const anchorCache = new Map();
const anchorsOf = (file) => {
  if (!anchorCache.has(file)) {
    const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
    anchorCache.set(
      file,
      new Set([...text.matchAll(/^#+\s+(.*)$/gm)].map((m) => slug(m[1]))),
    );
  }
  return anchorCache.get(file);
};

const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const [, target, anchor] of text.matchAll(
    /\]\(([^)#\s]+)(#[^)]*)?\)/g,
  )) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const resolved = join(dirname(file), target);
    if (!existsSync(resolved)) problems.push(`${file}: broken link ${target}`);
    else if (
      anchor &&
      resolved.endsWith('.md') &&
      !anchorsOf(resolved).has(anchor.slice(1))
    ) {
      problems.push(`${file}: broken anchor ${target}${anchor}`);
    }
  }
  for (const [, name] of text.matchAll(/npm run ([\w:.-]+)/g)) {
    if (!scripts.has(name))
      problems.push(`${file}: unknown npm script ${name}`);
  }
  for (const [, path] of text.matchAll(
    /`((?:src|tests|docs|assets|scripts|\.github)\/[\w./@-]+)`/g,
  )) {
    const clean = path.replace(/[.,;:]$/, '');
    if (!/[*<{]/.test(clean) && !existsSync(clean))
      problems.push(`${file}: missing path ${clean}`);
  }
  if (file !== 'CHANGELOG.md') {
    for (const [, key] of text.matchAll(/`(dataLineageViz\.[\w.]+)`/g)) {
      const known =
        settings.has(key) || [...settings].some((s) => s.startsWith(`${key}.`));
      if (!known) problems.push(`${file}: unknown setting ${key}`);
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log(
  `PASS  ${files.length} Markdown files: links, anchors, paths, npm scripts and settings resolve.`,
);
