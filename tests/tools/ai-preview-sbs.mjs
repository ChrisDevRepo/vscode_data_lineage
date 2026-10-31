// Side-by-side AI preview lane: shows each case's captured candidate and baseline results in the
// real VS Code lineage webview (.vscode-test.ai-preview.mjs, no model calls), then checks and compares
// what the webview rendered. Exit 0: no defect; 1: a defect in a rendered result; 2: incomplete.
// Usage: node tests/tools/ai-preview-sbs.mjs --cases CASES.json --out DIR [--report-only]
// CASES.json: [{ "id": "T7", "columns": { "RC": "<run artifact dir>", "MAIN": "<dir>" | null } }]
// A run artifact dir holds turn-N/present-result.json. Run `npm run pretest:integration` first.
import { spawnSync } from 'node:child_process';
import { load as loadYaml } from 'js-yaml';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './lineage-score.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const casesPath = arg('--cases');
const out = arg('--out') && resolve(arg('--out'));
if (!casesPath || !out) {
  console.error('Usage: --cases CASES.json --out DIR [--report-only]');
  process.exit(2);
}
const cases = readJson(resolve(casesPath));
const lc = (value) => String(value ?? '').toLowerCase();

/** Each turn's new present-result of one run artifact dir; a follow-up that answers in chat keeps the previous result. */
function turns(dir) {
  if (!dir || !existsSync(dir)) return [];
  let previous = null;
  return readdirSync(dir)
    .filter((name) => /^turn-\d+$/u.test(name))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((turn) => ({ turn, file: join(dir, turn, 'present-result.json') }))
    .filter(({ file }) => {
      if (!existsSync(file)) return false;
      const text = readFileSync(file, 'utf8');
      const fresh = text !== previous;
      previous = text;
      return fresh;
    });
}

// A null column (no MAIN run) is the only intended empty column; any other column without a result is incomplete input.
const emptyColumns = [];
const renders = cases.flatMap((row) =>
  Object.entries(row.columns).flatMap(([column, dir]) => {
    const found = turns(dir);
    if (dir !== null && !found.length)
      emptyColumns.push(`${row.id}__${column}: ${dir}`);
    return found.map(({ turn, file }) => ({
      key: `${row.id}__${column}__${turn}`,
      presentResult: file,
    }));
  }),
);
if (!renders.length || emptyColumns.length) {
  for (const column of emptyColumns)
    console.error(`INCOMPLETE ${column}: no present-result.json`);
  if (!renders.length) console.error('INCOMPLETE: no results to render.');
  process.exit(2);
}

if (!process.argv.includes('--report-only')) {
  for (const dir of ['renders', 'png'])
    rmSync(join(out, dir), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const manifest = join(out, 'manifest.json');
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        dacpac: join(root, 'tests/fixtures/AdventureWorks2025_AI.dacpac'),
        out,
        renders,
      },
      null,
      2,
    ),
  );
  const host = [
    'npx',
    'vscode-test',
    '--config',
    '.vscode-test.ai-preview.mjs',
  ];
  const command =
    process.platform === 'linux' && !process.env.DISPLAY
      ? ['xvfb-run', '-a', '-s', '-screen 0 1920x1200x24', ...host]
      : host;
  const run = spawnSync(command[0], command.slice(1), {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DLV_AI_PREVIEW_MANIFEST: manifest },
  });
  if (run.status !== 0) {
    console.error(`INCOMPLETE: VS Code host exited ${run.status}.`);
    process.exit(2);
  }
}

/** Column legs `obj.col->obj.col` the result's findings imply between rendered objects: a finding whose hop object is neither endpoint is drawn through it. Deliberately an independent oracle of src/engine/columnTraceView.ts, so a drawing regression there shows as a missing leg. */
function declaredLegs(artifact, rendered) {
  const legs = new Set();
  for (const e of artifact.aiMetadata?.columnAspect?.edges ?? []) {
    const [from, to, hop] = [lc(e.fromNode), lc(e.toNode), lc(e.hopNode)];
    if (!rendered.has(from) || !rendered.has(to)) continue;
    const [fromCol, toCol] = [lc(e.fromCol), lc(e.toCol)];
    if (hop && hop !== from && hop !== to && rendered.has(hop)) {
      legs.add(`${from}.${fromCol}->${hop}.${fromCol}`);
      legs.add(`${hop}.${toCol}->${to}.${toCol}`);
    } else legs.add(`${from}.${fromCol}->${to}.${toCol}`);
  }
  return legs;
}

/** Column legs the Detail view drew, read from React Flow edge ids `src::col->dst::col#n`. */
function drawnLegs(detail) {
  const legs = new Set();
  for (const id of detail?.edges ?? []) {
    const match = /^(.+?)::(.+?)->(\[.+?\]\.\[.+?\])::([^#]+)/u.exec(id ?? '');
    if (match)
      legs.add(
        `${lc(match[1])}.${lc(match[2])}->${lc(match[3])}.${lc(match[4])}`,
      );
  }
  return legs;
}

/** Section labels the output template allows, in order: the capture recipes' `sections` and the bold labels of the bodiless summary. */
const templates = loadYaml(
  readFileSync(join(root, 'assets/aiOutputTemplates.yaml'), 'utf8'),
);
const templateLabels = [
  ...new Set([
    ...templates.business_capture.sections,
    ...templates.technical_capture.sections,
    ...[
      ...templates.structural_summary.instruction.matchAll(/\*\*(.+?)\*\*/gu),
    ].map((m) => m[1]),
  ]),
];

/** Output-template deviations of one rendered result (aiOutputTemplates.yaml `general`, `structural_summary`). */
function templateFindings(preview) {
  const findings = [];
  for (const section of preview.sections) {
    if (!/^\d+\s/u.test(section.heading)) continue;
    const labels = section.labels.map((l) => l.replace(/[.:]$/u, ''));
    const unknown = labels.filter((l) => !templateLabels.includes(l));
    if (unknown.length)
      findings.push(
        `non-template labels in "${section.heading}": ${unknown.join(', ')}`,
      );
    const order = labels
      .map((l) => templateLabels.indexOf(l))
      .filter((i) => i >= 0);
    if (order.some((i, n) => n && i < order[n - 1]))
      findings.push(`labels out of template order in "${section.heading}"`);
    if (section.stepsWithoutList)
      findings.push(`Steps without a numbered list in "${section.heading}"`);
  }
  if (preview.callouts.outsideListItem)
    findings.push(
      `${preview.callouts.outsideListItem} ⚠️ callouts outside a list item`,
    );
  if (preview.callouts.merged)
    findings.push(`${preview.callouts.merged} list items merge ⚠️ callouts`);
  const bare = preview.codeLanguages.filter((l) => l === 'none').length;
  if (bare) findings.push(`${bare} code blocks without a language`);
  return findings;
}

const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();
const sectionTitle = (heading) =>
  heading.replace(/^h\d\s+(\d+\s+)?/u, '').toLowerCase();

/** Machine checks of one rendered result; `defects` are render failures or broken content. */
function checkRender(render) {
  const file = join(out, 'renders', `${render.key}.json`);
  if (!existsSync(file)) return { key: render.key, incomplete: 'not rendered' };
  const result = readJson(file);
  if (result.error) return { key: render.key, incomplete: result.error };
  const artifact = readJson(render.presentResult);
  const preview = result.preview;
  const defects = [];
  const warnings = [];
  if (!preview.text) defects.push('empty AI report');
  for (const error of preview.formulaErrors)
    defects.push(`formula not rendered: ${error}`);
  if (preview.katexErrors)
    defects.push(`${preview.katexErrors} KaTeX error elements`);
  for (const section of preview.sections.filter((s) => !s.text))
    defects.push(`empty section: ${section.heading}`);
  const rendered = new Set(preview.nodes.map(lc));
  const missingNodes = minus(new Set(artifact.nodeIds.map(lc)), rendered);
  if (missingNodes.length)
    defects.push(`objects not rendered: ${missingNodes.join(', ')}`);
  const declared = declaredLegs(artifact, rendered);
  const drawn = drawnLegs(result.detail);
  const undrawn = minus(declared, drawn);
  if (declared.size && !result.detail) defects.push('Detail view missing');
  else if (undrawn.length)
    defects.push(`column findings not drawn in Detail: ${undrawn.join(', ')}`);
  const numbered = preview.sections.filter((s) => /^\d+\s/u.test(s.heading));
  if (numbered.length !== preview.chips)
    warnings.push(
      `${numbered.length} numbered sections but ${preview.chips} section chips`,
    );
  const template = templateFindings(preview);
  if (result.consoleErrors.length)
    warnings.push(`console errors: ${result.consoleErrors.join(' | ')}`);
  return {
    key: render.key,
    defects,
    warnings,
    template,
    callouts: preview.callouts.total,
    headings: preview.headings,
    structure: preview.structure,
    objects: [...rendered].sort(),
    columnLegs: [...drawn].sort(),
    declaredLegs: declared.size,
  };
}

/** Structural differences between two rendered results of the same case and turn. */
function diff(a, b) {
  const titles = (r) => new Set(r.headings.map(sectionTitle));
  const counts = Object.fromEntries(
    Object.keys(a.structure)
      .filter((k) => a.structure[k] !== b.structure[k])
      .map((k) => [k, [a.structure[k], b.structure[k]]]),
  );
  const objects = [new Set(a.objects), new Set(b.objects)];
  const legs = [new Set(a.columnLegs), new Set(b.columnLegs)];
  return {
    headingsOnlyLeft: minus(titles(a), titles(b)),
    headingsOnlyRight: minus(titles(b), titles(a)),
    structure: counts,
    objectsOnlyLeft: minus(objects[0], objects[1]),
    objectsOnlyRight: minus(objects[1], objects[0]),
    columnLegsOnlyLeft: minus(legs[0], legs[1]),
    columnLegsOnlyRight: minus(legs[1], legs[0]),
  };
}

const checks = Object.fromEntries(
  renders.map((render) => [render.key, checkRender(render)]),
);
const summary = cases.map((row) => {
  const columns = Object.keys(row.columns);
  const keys = [...new Set(renders.map((r) => r.key))].filter((k) =>
    k.startsWith(`${row.id}__`),
  );
  const turnNames = [...new Set(keys.map((k) => k.split('__')[2]))].sort();
  return {
    id: row.id,
    columns,
    turns: turnNames.map((turn) => {
      const cells = columns.map(
        (column) => checks[`${row.id}__${column}__${turn}`] ?? null,
      );
      const complete = cells.filter((c) => c && !c.incomplete);
      return {
        turn,
        cells: cells.map((c) => c?.key ?? null),
        diff:
          complete.length === 2 && cells.length === 2
            ? diff(complete[0], complete[1])
            : null,
      };
    }),
  };
});
const all = Object.values(checks);
const incomplete = all.filter((c) => c.incomplete);
const defective = all.filter((c) => c.defects?.length);
writeFileSync(
  join(out, 'checks.json'),
  JSON.stringify({ renders: checks, cases: summary }, null, 2),
);

// The report shows the webview's own sanitized HTML with the built webview stylesheets.
const assets = join(root, 'dist', 'assets');
mkdirSync(join(out, 'assets'), { recursive: true });
for (const name of readdirSync(assets).filter((n) => /\.(css|woff2)$/u.test(n)))
  copyFileSync(join(assets, name), join(out, 'assets', name));
const escape = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
  );
const cell = (key) => {
  if (!key) return '<td><em>no result</em></td>';
  const check = checks[key];
  const file = join(out, 'renders', `${key}.json`);
  const html = existsSync(file) ? readJson(file).preview?.html : null;
  const flags = check.incomplete
    ? `<p class="bad">INCOMPLETE: ${escape(check.incomplete)}</p>`
    : [
        ...check.defects.map((d) => `<p class="bad">DEFECT: ${escape(d)}</p>`),
        ...check.warnings.map((w) => `<p class="warn">${escape(w)}</p>`),
        ...check.template.map(
          (w) => `<p class="warn">template: ${escape(w)}</p>`,
        ),
      ].join('');
  return `<td>${flags}<p><a href="png/${key}-preview.png"><img src="png/${key}-preview.png"></a><a href="png/${key}-detail.png"><img src="png/${key}-detail.png"></a></p><div class="ln-ai-description-md">${html ?? ''}</div></td>`;
};
const rows = summary
  .flatMap((row) =>
    row.turns.map(
      (t) =>
        `<tr><th colspan="${row.columns.length}" id="${escape(row.id)}">${escape(row.id)} ${t.turn}${t.diff ? `<pre>${escape(JSON.stringify(t.diff, null, 1))}</pre>` : ''}</th></tr><tr>${t.cells.map(cell).join('')}</tr>`,
    ),
  )
  .join('\n');
writeFileSync(
  join(out, 'report.html'),
  `<!doctype html><meta charset="utf-8"><title>AI preview side by side</title>
<link rel="stylesheet" href="assets/index.css"><link rel="stylesheet" href="assets/AiDescriptionOverlay.css">
<style>body{background:#1e1e1e;color:#ddd;font:13px sans-serif}table{table-layout:fixed;width:100%;border-collapse:collapse}td,th{vertical-align:top;border:1px solid #555;padding:6px;text-align:left}td img{width:48%;margin-right:1%}.bad{color:#f66;font-weight:bold}.warn{color:#fc6}pre{white-space:pre-wrap;font-size:11px}</style>
<p>${renders.length} results; ${defective.length} with defects; ${incomplete.length} incomplete.</p>
<table>${rows}</table>`,
);
console.log(
  `${renders.length} results, ${defective.length} with defects, ${incomplete.length} incomplete: ${join(out, 'report.html')}`,
);
for (const c of defective)
  console.log(`DEFECT ${c.key}: ${c.defects.join('; ')}`);
for (const c of incomplete) console.log(`INCOMPLETE ${c.key}: ${c.incomplete}`);
process.exit(incomplete.length ? 2 : defective.length ? 1 : 0);
