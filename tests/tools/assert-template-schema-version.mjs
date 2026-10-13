#!/usr/bin/env node
import { runCommand } from './command.mjs';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCi, SKIP_EXIT_CODE } from './gate-status.mjs';
import { breakingStructureChanges, structureDiff, templateStructure } from './templateStructure.mjs';

const ASSET = 'assets/aiOutputTemplates.yaml';
const TYPES = 'src/ai/session/types.ts';
const VERSION_RE = /AI_TEMPLATE_SCHEMA_VERSION\s*=\s*(\d+)/;
const YAML_VERSION_RE = /^schemaVersion:\s*(\d+)\s*$/m;

/** Line endings differ between the index (LF) and a Windows working copy (CRLF); only content matters. */
const normalize = (text) => text.replace(/\r\n/g, '\n');

const git = async (args, cwd, env) => (await runCommand('git', args, { cwd, env })).stdout;

/**
 * Baseline the gate compares against: the highest release tag, which is what a user actually
 * upgraded from — falling back to `origin/main` in repositories that carry no `v*` tags, so the
 * comparison still runs instead of skipping.
 *
 * Deliberately not `git describe`: releases are squash-merged, so a release tag is usually NOT an
 * ancestor of the feature branch being gated, and `describe` would find nothing and skip the check
 * on precisely the branches that need it. Sorting all `v*` tags by version is reachability-free.
 */
async function baselineRef(cwd, env) {
  const tag = (await git(['tag', '--list', 'v*', '--sort=-v:refname'], cwd, env)).split('\n')[0].trim();
  if (tag) return { ref: tag, label: tag };
  try {
    await git(['rev-parse', '--verify', '--quiet', 'origin/main'], cwd, env);
    return { ref: 'origin/main', label: 'origin/main' };
  } catch (error) {
    if (error.code !== 1) throw error;
    return { ref: '', label: '' };
  }
}

async function showAtTag(tag, path, cwd, env) {
  const entries = await git(['ls-tree', '--name-only', '-z', tag, '--', path], cwd, env);
  if (!entries) return undefined;
  return normalize(await git(['show', `${tag}:${path}`], cwd, env));
}

const readVersion = (text, re, label) => {
  const match = text.match(re);
  if (!match) {
    throw new Error(`FAIL  no ${label} found — the gate cannot verify the contract version.`);
  }
  return Number(match[1]);
};

/** Compares the working tree with its Git baseline and returns the gate status with its diagnostics. */
export async function checkTemplateSchema({ cwd = process.cwd(), env = process.env, stdout = console.log, stderr = console.error } = {}) {
  const currentAsset = normalize(readFileSync(join(cwd, ASSET), 'utf8'));
  const currentTypes = normalize(readFileSync(join(cwd, TYPES), 'utf8'));

  const constantVersion = readVersion(currentTypes, VERSION_RE, 'AI_TEMPLATE_SCHEMA_VERSION');
  const assetVersion = readVersion(currentAsset, YAML_VERSION_RE, `schemaVersion in ${ASSET}`);
  if (constantVersion !== assetVersion) {
    stderr(
      `FAIL  version mismatch: AI_TEMPLATE_SCHEMA_VERSION is ${constantVersion} but ${ASSET} declares ` +
      `schemaVersion ${assetVersion}. The built-in templates must satisfy their own gate.`,
    );
    return 1;
  }

  /** Reports a comparison that cannot run; the gate shows it as SKIP, not PASS. */
  const skip = (message) => {
    stdout(`SKIP  ${message}`);
    return SKIP_EXIT_CODE;
  };

  const { ref: baseline, label: baselineLabel } = await baselineRef(cwd, env);
  if (!baseline) {
    if (isCi(env)) {
      stderr(
        'FAIL  no release tag and no origin/main in this CI checkout — fetch tags or origin/main ' +
        '(actions/checkout `fetch-depth: 0`) so the templates asset is compared against a baseline.',
      );
      return 1;
    }
    return skip('no release tag and no origin/main — cannot compare the templates asset against a baseline.');
  }

  const baselineAsset = await showAtTag(baseline, ASSET, cwd, env);
  if (baselineAsset === undefined) {
    return skip(`${baselineLabel} predates ${ASSET} — no comparable baseline.`);
  }

  if (baselineAsset === currentAsset) {
    stdout(`PASS  ${ASSET} unchanged since ${baselineLabel}; schemaVersion ${assetVersion} still correct.`);
    return 0;
  }

  const baselineStructure = templateStructure(baselineAsset);
  const currentStructure = templateStructure(currentAsset);
  const identicalStructure = JSON.stringify(baselineStructure) === JSON.stringify(currentStructure);
  const changes = structureDiff(baselineStructure, currentStructure);
  const breaking = breakingStructureChanges(changes);
  const formattedChanges = changes.map((line) => `      ${line}`).join('\n');

  const baselineTypes = await showAtTag(baseline, TYPES, cwd, env);
  if (baselineTypes === undefined) {
    return skip(`${baselineLabel} predates ${TYPES} — no comparable baseline for the constant.`);
  }
  const baselineVersion = readVersion(baselineTypes, VERSION_RE, `AI_TEMPLATE_SCHEMA_VERSION at ${baselineLabel}`);

  if (breaking.length === 0) {
    if (baselineVersion !== constantVersion) {
      stderr(
        `FAIL  ${ASSET} changed since ${baselineLabel} with no removal, rename, or retype — wording and ` +
        `additions are backward compatible — but AI_TEMPLATE_SCHEMA_VERSION moved ` +
        `${baselineVersion} → ${constantVersion} anyway:\n${formattedChanges}\n` +
        `      The bump alone forces every custom overlay to be re-scaffolded for nothing. Revert the ` +
        `constant in ${TYPES} and schemaVersion in ${ASSET} to ${baselineVersion}.`,
      );
      return 1;
    }
    stdout(
      (identicalStructure
        ? `PASS  ${ASSET} wording changed since ${baselineLabel}; template structure unchanged`
        : `PASS  ${ASSET} changed additively since ${baselineLabel} — no template key or field removed, renamed, or retyped`) +
      `, so a previous overlay still fits; schemaVersion ${assetVersion} stays.`,
    );
    return 0;
  }

  if (baselineVersion === constantVersion) {
    stderr(
      `FAIL  ${ASSET} broke structure since ${baselineLabel} but AI_TEMPLATE_SCHEMA_VERSION is still ${constantVersion}:\n` +
      `${breaking.map((line) => `      ${line}`).join('\n')}\n` +
      `      A ${baselineLabel} custom overlay will match this version, be accepted, and be read against a shape it\n` +
      `      no longer fits, with no warning and no fallback. Bump the constant in ${TYPES} and\n` +
      `      schemaVersion in ${ASSET}, then record the change in CHANGELOG.md.`,
    );
    return 1;
  }

  stdout(
    `PASS  ${ASSET} broke structure since ${baselineLabel} and AI_TEMPLATE_SCHEMA_VERSION was bumped ` +
    `${baselineVersion} → ${constantVersion}; stale overlays fall back to built-in templates.\n${formattedChanges}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await checkTemplateSchema();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
