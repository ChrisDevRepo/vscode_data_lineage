#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { breakingStructureChanges, structureDiff, templateStructure } from './templateStructure.mjs';

const ASSET = 'assets/aiOutputTemplates.yaml';
const TYPES = 'src/ai/session/types.ts';
const VERSION_RE = /AI_TEMPLATE_SCHEMA_VERSION\s*=\s*(\d+)/;
const YAML_VERSION_RE = /^schemaVersion:\s*(\d+)\s*$/m;

/** Line endings differ between the index (LF) and a Windows working copy (CRLF); only content matters. */
const normalize = (text) => text.replace(/\r\n/g, '\n');

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Baseline the gate compares against: the highest release tag, which is what a user actually
 * upgraded from — falling back to `origin/main` in repositories that carry no `v*` tags, so the
 * comparison still runs instead of skipping.
 *
 * Deliberately not `git describe`: releases are squash-merged, so a release tag is usually NOT an
 * ancestor of the feature branch being gated, and `describe` would find nothing and skip the check
 * on precisely the branches that need it. Sorting all `v*` tags by version is reachability-free.
 */
function baselineRef() {
  try {
    const tag = git(['tag', '--list', 'v*', '--sort=-v:refname']).split('\n')[0].trim();
    if (tag) return { ref: tag, label: tag };
  } catch {
  }
  try {
    git(['rev-parse', '--verify', '--quiet', 'origin/main']);
    return { ref: 'origin/main', label: 'origin/main' };
  } catch {
    return { ref: '', label: '' };
  }
}

function showAtTag(tag, path) {
  try {
    return normalize(git(['show', `${tag}:${path}`]));
  } catch {
    return undefined;
  }
}

const readVersion = (text, re, label) => {
  const match = text.match(re);
  if (!match) {
    console.error(`FAIL  no ${label} found — the gate cannot verify the contract version.`);
    process.exit(1);
  }
  return Number(match[1]);
};

const currentAsset = normalize(readFileSync(ASSET, 'utf8'));
const currentTypes = normalize(readFileSync(TYPES, 'utf8'));

const constantVersion = readVersion(currentTypes, VERSION_RE, 'AI_TEMPLATE_SCHEMA_VERSION');
const assetVersion = readVersion(currentAsset, YAML_VERSION_RE, `schemaVersion in ${ASSET}`);
if (constantVersion !== assetVersion) {
  console.error(
    `FAIL  version mismatch: AI_TEMPLATE_SCHEMA_VERSION is ${constantVersion} but ${ASSET} declares ` +
    `schemaVersion ${assetVersion}. The built-in templates must satisfy their own gate.`,
  );
  process.exit(1);
}

const { ref: baseline, label: baselineLabel } = baselineRef();
if (!baseline) {
  console.log('SKIP  no release tag and no origin/main — cannot compare the templates asset against a baseline.');
  process.exit(0);
}

const baselineAsset = showAtTag(baseline, ASSET);
if (baselineAsset === undefined) {
  console.log(`SKIP  ${baselineLabel} predates ${ASSET} — no comparable baseline.`);
  process.exit(0);
}

if (baselineAsset === currentAsset) {
  console.log(`PASS  ${ASSET} unchanged since ${baselineLabel}; schemaVersion ${assetVersion} still correct.`);
  process.exit(0);
}

const baselineStructure = templateStructure(baselineAsset);
const currentStructure = templateStructure(currentAsset);
const identicalStructure = JSON.stringify(baselineStructure) === JSON.stringify(currentStructure);
const changes = structureDiff(baselineStructure, currentStructure);
const breaking = breakingStructureChanges(changes);
const formattedChanges = changes.map((line) => `      ${line}`).join('\n');

const baselineTypes = showAtTag(baseline, TYPES);
if (baselineTypes === undefined) {
  console.log(`SKIP  ${baselineLabel} predates ${TYPES} — no comparable baseline for the constant.`);
  process.exit(0);
}
const baselineVersion = readVersion(baselineTypes, VERSION_RE, `AI_TEMPLATE_SCHEMA_VERSION at ${baselineLabel}`);

if (breaking.length === 0) {
  if (baselineVersion !== constantVersion) {
    console.error(
      `FAIL  ${ASSET} changed since ${baselineLabel} with no removal, rename, or retype — wording and ` +
      `additions are backward compatible — but AI_TEMPLATE_SCHEMA_VERSION moved ` +
      `${baselineVersion} → ${constantVersion} anyway:\n${formattedChanges}\n` +
      `      The bump alone forces every custom overlay to be re-scaffolded for nothing. Revert the ` +
      `constant in ${TYPES} and schemaVersion in ${ASSET} to ${baselineVersion}.`,
    );
    process.exit(1);
  }
  console.log(
    (identicalStructure
      ? `PASS  ${ASSET} wording changed since ${baselineLabel}; template structure unchanged`
      : `PASS  ${ASSET} changed additively since ${baselineLabel} — no template key or field removed, renamed, or retyped`) +
    `, so a previous overlay still fits; schemaVersion ${assetVersion} stays.`,
  );
  process.exit(0);
}

if (baselineVersion === constantVersion) {
  console.error(
    `FAIL  ${ASSET} broke structure since ${baselineLabel} but AI_TEMPLATE_SCHEMA_VERSION is still ${constantVersion}:\n` +
    `${breaking.map((line) => `      ${line}`).join('\n')}\n` +
    `      A ${baselineLabel} custom overlay will match this version, be accepted, and be read against a shape it\n` +
    `      no longer fits, with no warning and no fallback. Bump the constant in ${TYPES} and\n` +
    `      schemaVersion in ${ASSET}, then record the change in CHANGELOG.md.`,
  );
  process.exit(1);
}

console.log(
  `PASS  ${ASSET} broke structure since ${baselineLabel} and AI_TEMPLATE_SCHEMA_VERSION was bumped ` +
  `${baselineVersion} → ${constantVersion}; stale overlays fall back to built-in templates.\n${formattedChanges}`,
);
