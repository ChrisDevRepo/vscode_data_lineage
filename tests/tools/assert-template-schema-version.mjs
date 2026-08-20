#!/usr/bin/env node
// Release gate: `assets/aiOutputTemplates.yaml` may not change without bumping
// AI_TEMPLATE_SCHEMA_VERSION.
//
// A user's custom overlay (dataLineageViz.ai.outputTemplateFile) is applied only when its
// schemaVersion equals the constant. That gate is what produces the Output-channel warning and the
// fallback to built-in templates on upgrade — but it only fires if someone remembers to bump the
// number. Editing the shipped instructions while leaving the version alone means a previous
// release's overlay still matches, is accepted, and keeps instructing the model against the current
// validator. Nothing about that failure is visible at runtime, so it is caught here instead.
//
// Content is the trigger, not just structure: an instruction that changes a rule
// `validatePresentResult` enforces breaks an old overlay exactly as a renamed key would.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ASSET = 'assets/aiOutputTemplates.yaml';
const TYPES = 'src/ai/session/types.ts';
const VERSION_RE = /AI_TEMPLATE_SCHEMA_VERSION\s*=\s*(\d+)/;
const YAML_VERSION_RE = /^schemaVersion:\s*(\d+)\s*$/m;

/** Line endings differ between the index (LF) and a Windows working copy (CRLF); only content matters. */
const normalize = (text) => text.replace(/\r\n/g, '\n');

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Baseline is the highest release tag, which is what a user actually upgraded from.
 *
 * Deliberately not `git describe`: releases are squash-merged, so a release tag is usually NOT an
 * ancestor of the feature branch being gated, and `describe` would find nothing and skip the check
 * on precisely the branches that need it. Sorting all `v*` tags by version is reachability-free.
 */
function lastReleaseTag() {
  try {
    return git(['tag', '--list', 'v*', '--sort=-v:refname']).split('\n')[0].trim();
  } catch {
    return '';
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

// Bumping one of the two and not the other leaves the built-in YAML unable to match its own
// constant, which rejects every overlay including correctly updated ones. Checked before the
// history comparison because it is wrong regardless of what the last release shipped.
const constantVersion = readVersion(currentTypes, VERSION_RE, 'AI_TEMPLATE_SCHEMA_VERSION');
const assetVersion = readVersion(currentAsset, YAML_VERSION_RE, `schemaVersion in ${ASSET}`);
if (constantVersion !== assetVersion) {
  console.error(
    `FAIL  version mismatch: AI_TEMPLATE_SCHEMA_VERSION is ${constantVersion} but ${ASSET} declares ` +
    `schemaVersion ${assetVersion}. The built-in templates must satisfy their own gate.`,
  );
  process.exit(1);
}

const tag = lastReleaseTag();
if (!tag) {
  // A shallow or tagless clone is a legitimate state, not a defect to fail the whole gate over.
  console.log('SKIP  no release tag found — cannot compare the templates asset against a baseline.');
  process.exit(0);
}

const baselineAsset = showAtTag(tag, ASSET);
if (baselineAsset === undefined) {
  console.log(`SKIP  ${tag} predates ${ASSET} — no comparable baseline.`);
  process.exit(0);
}

if (baselineAsset === currentAsset) {
  console.log(`PASS  ${ASSET} unchanged since ${tag}; schemaVersion ${assetVersion} still correct.`);
  process.exit(0);
}

// Only the changed path needs the baseline constant, and it is the rare path. Reading it above
// would spawn a `git show` on every gate run that leaves the templates asset alone — which is most.
const baselineTypes = showAtTag(tag, TYPES);
if (baselineTypes === undefined) {
  console.log(`SKIP  ${tag} predates ${TYPES} — no comparable baseline for the constant.`);
  process.exit(0);
}

const baselineVersion = readVersion(baselineTypes, VERSION_RE, `AI_TEMPLATE_SCHEMA_VERSION at ${tag}`);
if (baselineVersion === constantVersion) {
  console.error(
    `FAIL  ${ASSET} changed since ${tag} but AI_TEMPLATE_SCHEMA_VERSION is still ${constantVersion}.\n` +
    `      A ${tag} custom overlay will match this version, be accepted, and apply stale instructions\n` +
    `      with no warning and no fallback. Bump the constant in ${TYPES} and schemaVersion in ${ASSET},\n` +
    `      then record the change in CHANGELOG.md.`,
  );
  process.exit(1);
}

console.log(
  `PASS  ${ASSET} changed since ${tag} and AI_TEMPLATE_SCHEMA_VERSION was bumped ` +
  `${baselineVersion} → ${constantVersion}; stale overlays fall back to built-in templates.`,
);
