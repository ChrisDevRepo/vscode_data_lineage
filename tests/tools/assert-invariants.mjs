#!/usr/bin/env node
import { execFile } from 'node:child_process';
import ts from 'typescript';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, PackageManager } from '@vscode/vsce';
import { classifyUnitTests, laneScriptProblems, unitTestFiles } from './unit-lanes.mjs';
import { breakingStructureChanges, structureDiff, templateStructure } from './templateStructure.mjs';

const execAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = async (args) => (await execAsync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false })).stdout;

// ── 1. Output Truncation Invariants ──────────────────────────────────────────

const SRC_ROOT = 'src';
const DEFAULT_BASELINE = path.join(repoRoot, 'tests/tools/output-truncation-baseline.json');
const ELLIPSIS = /…|\\u2026|\.\.\.['"`]/;
const CUT_MARKERS = /truncated to|\[truncated|…\[\+|\\u2026 ?\[\+/;
const CUT_HELPERS = /^(?:capRejectionText|capUtf8Text|capPreviewProse|trunc|truncAtWordBoundary)$/;
const LOG_CALL = /(?:^|\.)(?:debug|info|warn|error|trace|log|debugLog|onDebugLog|debugLogger)$/;

export const ALLOWLIST = [
  { file: 'src/ai/prompting/scopeSummaryRenderer.ts', symbol: 'CARD_OBJECT_TYPE_LIMIT', reason: 'card-summary-view: visible "…" line, full list in the full view' },
  { file: 'src/ai/agent/graph.ts', symbol: "const display = truncAtWordBoundary(committedFinding.value.summary.replace(/\\s+/g, ' ').trim(), 135);", reason: 'chat-preview-display-exception' },
  { file: 'src/ai/support/text.ts', symbol: 'PROVIDER_ERROR_MAX', reason: 'provider error shown with visible "…"' },
  { file: 'src/ai/support/text.ts', symbol: 'slice(0, max - 1)', reason: 'trunc definition' },
  { file: 'src/ai/support/text.ts', symbol: 'slice(0, max - 3)', reason: 'hop-thinking-trim' },
  { file: 'src/ai/agent/graph.ts', symbol: 'rejectReason=${trunc(', reason: 'log-only' },
  { file: 'src/ai/model/vscodeModelPort.ts', symbol: 'tool-input-keys-dropped', reason: 'log-only' },
  { file: 'src/ai/model/vscodeModelPort.ts', symbol: 'tool-input-decoded', reason: 'log-only' },
  { file: 'src/ai/session/session.ts', symbol: 'const toolName = observation.toolName ? trunc(', reason: 'log-only' },
  { file: 'src/ai/session/session.ts', symbol: 'oldest evidence observation evicted', reason: 'log-only' },
  { file: 'src/ai/sm/smBase.ts', symbol: 'const excludeNodeIdsLine', reason: 'log-only' },
  { file: 'src/ai/tools/handlers/presentResult.ts', symbol: 'const expanded = expand(sec.text', reason: 'log-only' },
  { file: 'src/ai/tools/handlers/presentResult.ts', symbol: '[Presentation] Output assembled', reason: 'log-only' },
  { file: 'src/ai/tools/toolProvider.ts', symbol: 'const preview = trunc(', reason: 'log-only' },
  { file: 'src/ai/tools/toolProvider.ts', symbol: 'const inputJson = trunc(', reason: 'log-only' },
  { file: 'src/ai/tools/toolProvider.ts', symbol: 'const hintPart = rejection.hint', reason: 'log-only' },
  { file: 'src/bridge/debugDumpScreenState.ts', symbol: 'return trunc([...ids], cap);', reason: 'log-only' },
  { file: 'src/bridge/messageHandlers.ts', symbol: 'trunc(sanitizeForLog(msg.componentStack)', reason: 'log-only' },
  { file: 'src/bridge/messageHandlers.ts', symbol: 'trunc(redactSecrets(sanitizeForLog(msg.stack))', reason: 'log-only' },
  { file: 'src/bridge/messageHandlers.ts', symbol: 'trunc(redactSecrets(JSON.stringify(e.context))', reason: 'log-only' },
  { file: 'src/bridge/messageHandlers.ts', symbol: 'trunc(redactSecrets(text), SETTING_VALUE_CAP)', reason: 'log-only' },
  { file: 'src/engine/modelBuilder.ts', symbol: 'const sqlPreview = trunc(', reason: 'log-only' },
  { file: 'src/utils/notifications.ts', symbol: 'return trunc(value.map(', reason: 'log-only' },
  { file: 'src/utils/notifications.ts', symbol: 'value instanceof Error) return trunc(', reason: 'log-only' },
  { file: 'src/utils/notifications.ts', symbol: 'return trunc(sanitizeForLog(String(value))', reason: 'log-only' },
  { file: 'src/utils/notifications.ts', symbol: '${trunc(parts.join(', reason: 'log-only' },
  { file: 'src/utils/log.ts', symbol: '', reason: 'log helper' },
];

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full.split(path.sep).join('/'));
  }
  return out;
}

/** Finds truncation expressions by syntax so line wrapping cannot turn a log into output. */
export function findSites(file, text) {
  if (file.startsWith('src/components/')) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const contexts = new Map();
  const statementOf = node => ts.findAncestor(node, ts.isStatement) ?? node;
  const ownerOf = node => ts.findAncestor(node, candidate => ts.isVariableDeclaration(candidate) || ts.isStatement(candidate)) ?? node;
  const callName = node => ts.isIdentifier(node.expression) ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
  const inLog = node => !!ts.findAncestor(node, parent => ts.isCallExpression(parent)
    && LOG_CALL.test(parent.expression.getText(source)));
  // Scanner tokens preserve literal contents and identifier boundaries while discarding layout trivia.
  const tokens = value => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, value);
    const trailingCallCommas = new Set();
    const syntax = ts.createSourceFile('allowlist.ts', value, ts.ScriptTarget.Latest, true);
    const collect = node => {
      if (ts.isCallExpression(node) && node.arguments.hasTrailingComma && value[node.arguments.end - 1] === ',') trailingCallCommas.add(node.arguments.end - 1);
      ts.forEachChild(node, collect);
    };
    collect(syntax);
    const parts = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      if (!trailingCallCommas.has(scanner.getTokenPos())) parts.push(scanner.getTokenText());
    }
    return parts.join('\0');
  };
  const visit = node => {
    const context = statementOf(node);
    let hit = false;
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      hit = CUT_HELPERS.test(name) || (['slice', 'substring', 'substr'].includes(name)
        && node.arguments[0]?.getText(source) === '0' && ELLIPSIS.test(context.getText(source)));
    } else if (ts.isIdentifier(node) && /^(?:capRejectionText|capUtf8Text|capPreviewProse)$/.test(node.text)) {
      hit = !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node);
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateSpan(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) hit = CUT_MARKERS.test(node.getText(source));
    if (hit && !inLog(node)) {
      const owner = ownerOf(node);
      const hits = contexts.get(owner) ?? [];
      hits.push(node); contexts.set(owner, hits);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...contexts].flatMap(([node, hits]) => {
    const declaration = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) ? node.parent : null;
    const keyword = declaration ? (declaration.flags & ts.NodeFlags.Const ? 'const' : declaration.flags & ts.NodeFlags.Let ? 'let' : 'var') : '';
    const raw = declaration ? `${keyword} ${node.getText(source)};` : node.getText(source);
    const branch = ts.isIfStatement(node.parent) && node.parent.thenStatement === node ? node.parent.getText(source) : raw;
    const allowed = hit => ALLOWLIST.some(entry => {
      if (entry.file !== file) return false;
      const helper = ts.isIdentifier(hit) ? hit.text : ts.isCallExpression(hit) ? callName(hit) : '';
      const local = ts.isIterationStatement(node, false) || ts.isIfStatement(node) || ts.isSwitchStatement(node)
        ? hit.getText(source) : branch;
      // A helper prohibition cannot inherit an exception for a different expression.
      if (/^(?:capRejectionText|capUtf8Text|capPreviewProse)$/.test(helper) && entry.symbol && !entry.symbol.includes(helper)) return false;
      return local.includes(entry.symbol) || tokens(local).includes(tokens(entry.symbol));
    });
    if (hits.every(allowed)) return [];
    return [{ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: raw }];
  });
}

export function compare(sites, baseline) {
  const key = (e) => `${e.file}\u0000${e.text}`;
  const known = new Set(baseline.map(key));
  const seen = new Set(sites.map(key));
  return { fresh: sites.filter((s) => !known.has(key(s))), stale: baseline.filter((b) => !seen.has(key(b))) };
}

export function scanTree() {
  return listTsFiles(path.join(repoRoot, SRC_ROOT)).flatMap((f) => findSites(path.relative(repoRoot, f).split(path.sep).join('/'), readFileSync(f, 'utf8')));
}

function checkNoOutputTruncation() {
  const sites = scanTree();
  const { fresh, stale } = compare(sites, JSON.parse(readFileSync(DEFAULT_BASELINE, 'utf8')));
  for (const s of fresh) console.error(`FAIL  ${s.file}:${s.line}  new output truncation: ${s.text}`);
  for (const s of stale) console.error(`FAIL  ${s.file}  stale baseline entry: ${s.text}`);
  if (fresh.length > 0 || stale.length > 0) throw new Error('Output truncation invariant failed.');
  console.log(`PASS  no new output truncation (${sites.length} baseline sites).`);
}

// ── 2. Layer Direction Invariant ─────────────────────────────────────────────

function checkLayerDirection() {
  const engineDir = path.join(repoRoot, 'src', 'engine');
  const importRe = /(?:import|export)(?:[^'";]*?\bfrom\s*)?\s*['"]([^'"]+)['"]/g;
  const offenders = [];
  for (const file of listTsFiles(engineDir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      importRe.lastIndex = 0;
      let m;
      while ((m = importRe.exec(line))) {
        if (!m[1].startsWith('.')) continue;
        const resolved = path.normalize(path.join(path.dirname(file), m[1])).split(path.sep).join('/');
        if (resolved.includes('src/components')) offenders.push(`${file}:${idx + 1}  import '${m[1]}'`);
      }
    });
  }
  if (offenders.length > 0) {
    for (const off of offenders) console.error(`FAIL  ${off}`);
    throw new Error('src/engine/** must never import from src/components/**.');
  }
  console.log('PASS  src/engine/** never imports from src/components/**.');
}

// ── 3. No Tracked Scratch Files ──────────────────────────────────────────────

async function checkNoTrackedScratch() {
  const stdout = await git(['ls-files', '-ci', '--exclude-standard', '-z']);
  const tracked = stdout.split('\0').filter(Boolean);
  if (tracked.length > 0) {
    for (const f of tracked) console.error(`FAIL  tracked scratch file: ${f}`);
    throw new Error('Local-only scratch files must not be tracked in Git.');
  }
  console.log('PASS  no tracked local scratch or generated review reports.');
}

// ── 4. Unit Project Partition Coverage ───────────────────────────────────────

function checkUnitProjectsCoverAll() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const problems = laneScriptProblems(pkg.scripts);
  const allFiles = unitTestFiles().sort();
  if (allFiles.length === 0) throw new Error('No unit test files found.');
  const classified = classifyUnitTests(allFiles);
  problems.push(...classified.problems);
  if (classified.support.length === 0) problems.push('support lane is empty.');
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL  ${p}`);
    throw new Error('Unit lanes do not partition the test suite.');
  }
  console.log(`PASS  ${allFiles.length} unit test files partitioned (${classified.core.length} core, ${classified.runtime.length} runtime, ${classified.support.length} support).`);
}

// ── 5. Template Schema Version ───────────────────────────────────────────────

/** An unrun comparison is unverified: exit 77 so the gate reports SKIP, not PASS. */
function skip(message) {
  console.log(`SKIP  ${message}`);
  process.exitCode = 77;
}

async function checkTemplateSchemaVersion() {
  const assetPath = path.join(repoRoot, 'assets/aiOutputTemplates.yaml');
  const typesPath = path.join(repoRoot, 'src/ai/session/types.ts');
  const currentAsset = readFileSync(assetPath, 'utf8').replace(/\r\n/g, '\n');
  const currentTypes = readFileSync(typesPath, 'utf8').replace(/\r\n/g, '\n');

  const constMatch = currentTypes.match(/AI_TEMPLATE_SCHEMA_VERSION\s*=\s*(\d+)/);
  const assetMatch = currentAsset.match(/^schemaVersion:\s*(\d+)\s*$/m);
  if (!constMatch || !assetMatch) throw new Error('Missing schema version constant or YAML field.');
  const constVer = Number(constMatch[1]);
  const assetVer = Number(assetMatch[1]);
  if (constVer !== assetVer) {
    throw new Error(`AI_TEMPLATE_SCHEMA_VERSION (${constVer}) !== schemaVersion (${assetVer})`);
  }

  let baseline = '';
  try {
    const tag = (await git(['tag', '--list', 'v*', '--sort=-v:refname'])).split('\n')[0].trim();
    baseline = tag || 'origin/main';
    await git(['rev-parse', '--verify', '--quiet', baseline]);
  } catch {
    const ci = (process.env.CI ?? '').trim().toLowerCase();
    if (ci && ci !== 'false' && ci !== '0') throw new Error('No v* tag or origin/main in this CI checkout; fetch them (actions/checkout fetch-depth: 0).');
    return skip('no git baseline tag or origin/main for template diff.');
  }

  let baselineAsset;
  try {
    baselineAsset = (await git(['show', `${baseline}:assets/aiOutputTemplates.yaml`])).replace(/\r\n/g, '\n');
  } catch {
    return skip(`${baseline} lacks templates asset.`);
  }

  if (baselineAsset === currentAsset) {
    console.log(`PASS  aiOutputTemplates.yaml matches ${baseline} (schemaVersion ${assetVer}).`);
    return;
  }

  const changes = structureDiff(templateStructure(baselineAsset), templateStructure(currentAsset));
  const breaking = breakingStructureChanges(changes);
  let baselineTypes;
  try {
    baselineTypes = (await git(['show', `${baseline}:src/ai/session/types.ts`])).replace(/\r\n/g, '\n');
  } catch {
    return skip(`${baseline} lacks types.ts.`);
  }
  const baseVerMatch = baselineTypes.match(/AI_TEMPLATE_SCHEMA_VERSION\s*=\s*(\d+)/);
  const baseVer = baseVerMatch ? Number(baseVerMatch[1]) : assetVer;

  if (breaking.length === 0 && baseVer !== constVer) {
    throw new Error(`Template change is non-breaking but version was bumped (${baseVer} -> ${constVer}).`);
  }
  if (breaking.length > 0 && baseVer === constVer) {
    throw new Error(`Template change broke structure but version is still ${constVer}. Bump required.`);
  }
  console.log(`PASS  template structure changes verified against ${baseline}.`);
}

// ── 6. No LangSmith In Bundle ────────────────────────────────────────────────

function checkNoLangsmith() {
  const bundles = ['out/extension.js', 'out/extensionRuntime.js'].map((p) => path.join(repoRoot, p));
  let bundle;
  try {
    bundle = bundles.map((b) => readFileSync(b, 'utf8')).join('\n');
  } catch {
    throw new Error('Extension bundles not found — run npm run build first.');
  }
  if (!bundle.includes('LangSmith is excluded from this build')) {
    throw new Error('Stub marker missing — exclude-langsmith esbuild plugin failed.');
  }
  for (const sig of ['smith.langchain.com', 'langsmith-js', 'LangSmithFormBoundary']) {
    if (bundle.includes(sig)) throw new Error(`Forbidden LangSmith signature present: "${sig}"`);
  }
  console.log('PASS  extension bundles carry LangSmith exclusion stub and no signatures.');
}

// ── 7. Package Contents ──────────────────────────────────────────────────────

async function checkPackageContents() {
  let files;
  try {
    files = (await listFiles({ cwd: repoRoot, packageManager: PackageManager.None })).map((f) => f.replaceAll('\\', '/'));
  } catch (err) {
    throw new Error(`Could not list VSIX files: ${err.message}`);
  }
  const required = [
    'package.json', 'out/extension.js', 'out/extensionRuntime.js', 'out/regexSearch.worker.js',
    'dist/index.html', 'dist/assets/index.js', 'assets/defaultParseRules.yaml',
    'assets/dmvQueries.yaml', 'assets/aiOutputTemplates.yaml', 'THIRD_PARTY_NOTICES.md',
  ];
  const forbidden = [
    { pattern: /(?:^|\/)(?:\.audit|\.reviews|reviews?|audits?)\//iu, label: 'local review/audit directory' },
    { pattern: /(?:^|\/)(?:[^/]*[-_.])?(?:review|audit)[^/]*\.md$/iu, label: 'local review/audit report' },
    { pattern: /^(?:src|test|tests|test-results|tmp|tooling|scripts|ai)\//u, label: 'source/test/tmp/tooling directory' },
    { pattern: /^out\/test(?:\/|-)/u, label: 'compiled test/harness output' },
    { pattern: /\.vsix$/iu, label: 'packaged .vsix artifact' },
    { pattern: /\.log$/iu, label: 'log file' },
  ];
  const missing = required.filter((r) => !files.includes(r));
  const leaked = files.map((f) => {
    const hit = forbidden.find((p) => p.pattern.test(f));
    return hit ? `${f} [${hit.label}]` : null;
  }).filter(Boolean);

  if (missing.length > 0 || leaked.length > 0) {
    if (missing.length > 0) console.error(`Missing required VSIX files: ${missing.join(', ')}`);
    if (leaked.length > 0) console.error(`Forbidden VSIX files: ${leaked.join(', ')}`);
    throw new Error('Package contents check failed.');
  }
  console.log(`PASS  VSIX contents valid (${files.length} packaged files).`);
}

// ── CLI Dispatcher ───────────────────────────────────────────────────────────

const stage = process.argv[2] || 'all';

async function main() {
  if (stage === 'source' || stage === 'all') {
    checkLayerDirection();
    await checkNoTrackedScratch();
    checkUnitProjectsCoverAll();
    await checkTemplateSchemaVersion();
    checkNoOutputTruncation();
  }
  if (stage === 'build' || stage === 'all') {
    checkNoLangsmith();
    await checkPackageContents();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  });
}
