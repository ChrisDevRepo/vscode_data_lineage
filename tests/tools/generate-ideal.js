#!/usr/bin/env node
// tests/tools/generate-ideal.js
// Reads a dacpac (ZIP file) to extract model fingerprint from model.xml,
// calibrates targets from the latest trace file (summing all ROUND events across
// all phases), then writes tmp/lm-ideal/ideal-run.md with per-model metric targets.
//
// Usage: node tests/tools/generate-ideal.js [path/to/dacpac]
// Default dacpac: assets/demo.dacpac

'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const dacpacArg  = process.argv[2] || 'assets/demo.dacpac';
const dacpacPath = path.resolve(dacpacArg);

if (!fs.existsSync(dacpacPath)) {
  console.error(`Dacpac not found: ${dacpacPath}`);
  process.exit(1);
}

const projectRoot = path.resolve(path.join(path.dirname(dacpacPath), '..'));
const outDir  = path.join(projectRoot, 'tmp', 'lm-ideal');
const outFile = path.join(outDir, 'ideal-run.md');

// ── Extract dacpac (ZIP) to temp dir ─────────────────────────────────────────

const tmpDir = path.join(os.tmpdir(), `lm-ideal-${Date.now()}`);
console.log(`Extracting ${dacpacPath} → ${tmpDir}`);

try {
  const dp = dacpacPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const td = tmpDir.replace(/\\/g, '\\\\').replace(/'/g, "''");
  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${dp}', '${td}')"`,
    { stdio: 'inherit', timeout: 30000 }
  );
} catch (err) {
  console.error('Failed to extract dacpac:', err.message);
  process.exit(1);
}

const modelXmlPath = path.join(tmpDir, 'model.xml');
if (!fs.existsSync(modelXmlPath)) {
  console.error('model.xml not found inside dacpac — unexpected archive structure');
  process.exit(1);
}

const xml = fs.readFileSync(modelXmlPath, 'utf8');
console.log(`Read model.xml: ${xml.length.toLocaleString()} bytes`);

// ── Count model entities using exact element type names ───────────────────────
// Collect all element type → count from model.xml

const typeCountMap = {};
const typeRe = /Element Type="([^"]+)"/g;
let tm;
while ((tm = typeRe.exec(xml)) !== null) {
  typeCountMap[tm[1]] = (typeCountMap[tm[1]] || 0) + 1;
}

// Exact match (primary) + suffix-only match as fallback for versioned types (e.g. ISql130Table)
const getCount = (...names) => names.reduce((s, n) => {
  // Exact match
  if (typeCountMap[n]) return s + typeCountMap[n];
  // Suffix match: any key ending with n (handles ISql130Table → SqlTable suffix)
  return s + Object.entries(typeCountMap)
    .filter(([k]) => k.endsWith(n))
    .reduce((a, [, v]) => a + v, 0);
}, 0);

const tables    = getCount('SqlTable', 'SqlSimpleTable');
const views     = getCount('SqlView');
const procs     = getCount('SqlProcedure', 'SqlStoredProcedure');
const scalarFns = getCount('SqlScalarFunction', 'SqlScriptFunction');
const tvfs      = getCount('SqlTableValuedFunction') + getCount('SqlInlineTableValuedFunction');
const functions = scalarFns + tvfs;
const schemas   = getCount('SqlSchema');
const depEdges  = (xml.match(/<Relationship Name="BodyDependencies"/g) || []).length
                + (xml.match(/<Relationship Name="Dependencies"/g) || []).length;

const totalObjects  = tables + views + procs + functions;
const bodiedObjects = views + procs + functions;

// Log top 15 element types for diagnostics
const topTypes = Object.entries(typeCountMap).sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('Top 15 element types in model.xml:');
for (const [t, n] of topTypes) console.log(`  ${String(n).padStart(5)}  ${t}`);
console.log(`Counted: tables=${tables}  views=${views}  procs=${procs}  functions=${functions}  schemas=${schemas}  dep_edges=${depEdges}`);

// ── Calibrate from latest trace file (if available) ───────────────────────────
// Sums all ROUND events across all phases to get full session token totals.
// SESSION_END.cumInTok only covers the primary (discover) invocation and misses
// SM phases (active/synthesis/completed) that run in subsequent turns.

let traceBaseline = null;
const traceDir = path.join(projectRoot, 'tmp', 'lm-trace');
if (fs.existsSync(traceDir)) {
  const traceFiles = fs.readdirSync(traceDir)
    .filter(f => f.endsWith('.ndjson'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(traceDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (traceFiles.length > 0) {
    const latest = path.join(traceDir, traceFiles[0].name);
    console.log(`Calibrating from trace: ${traceFiles[0].name}`);
    try {
      const lines = fs.readFileSync(latest, 'utf8').trim().split('\n').filter(Boolean);

      let roundInTok = 0, roundPeak = 0, roundCount = 0;
      let sessionEnd = null;
      let toolResultTotal = 0, toolResultCount = 0;

      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev._ !== 'TX') continue;
          if (ev.ev === 'ROUND') {
            // Sum all ROUND events to capture discover + active + synthesis + completed
            roundInTok += ev.inTok || 0;
            if ((ev.inTok || 0) > roundPeak) roundPeak = ev.inTok;
            roundCount++;
          } else if (ev.ev === 'SESSION_END') {
            sessionEnd = ev;
          } else if (ev.ev === 'TOOL_RESULT' && !ev.errCode) {
            toolResultTotal += (ev.result || []).join('').length;
            toolResultCount++;
          }
        } catch {}
      }

      if (roundCount > 0 || sessionEnd) {
        traceBaseline = {
          inTok:   roundInTok   || (sessionEnd?.cumInTok  ?? 0),
          peakTok: roundPeak    || (sessionEnd?.peakTok   ?? 0),
          rounds:  roundCount   || (sessionEnd?.rounds    ?? 0),
        };
        if (toolResultCount > 0) {
          traceBaseline.avgToolResultChars = Math.round(toolResultTotal / toolResultCount);
        }
      }
    } catch {}
  }
}

// ── Derive metric targets ─────────────────────────────────────────────────────
// If trace baseline available: target is 85% of current (15% improvement).
// Otherwise: use conservative object-count-based estimates.

const IMPROVE = 0.85; // target = current * 0.85

let idealTotalIn, idealPeakTok, idealDiscoveryIn, idealToolResultAvg, idealSmRounds;
let basisNote;

if (traceBaseline) {
  idealTotalIn        = Math.round(traceBaseline.inTok     * IMPROVE);
  idealPeakTok        = Math.round(traceBaseline.peakTok   * IMPROVE);
  idealToolResultAvg  = traceBaseline.avgToolResultChars
    ? Math.round(traceBaseline.avgToolResultChars * IMPROVE)
    : 3000;
  idealSmRounds       = Math.max(3, Math.ceil(traceBaseline.rounds * IMPROVE));
  idealDiscoveryIn    = Math.round(idealTotalIn * 0.40); // discovery ~40% of total
  basisNote = `calibrated from latest trace (×${IMPROVE} improvement target)`;
} else {
  // No trace: scale by object count with conservative caps
  idealDiscoveryIn   = Math.max(5000,  Math.min(20000, totalObjects * 50));
  idealPeakTok       = Math.max(5000,  Math.min(12000, Math.max(bodiedObjects, 20) * 150));
  idealToolResultAvg = Math.max(1000,  Math.min(6000,  Math.max(bodiedObjects, 10) * 100));
  idealSmRounds      = Math.min(8,     Math.max(3,     Math.round(depEdges / Math.max(bodiedObjects, 1) * 1.5)));
  idealTotalIn       = idealDiscoveryIn + idealSmRounds * Math.round(idealPeakTok * 0.8);
  basisNote = `estimated from dacpac object counts (no trace file found)`;
}

const avgEdgesPerObj = totalObjects > 0 ? (depEdges / totalObjects).toFixed(1) : '?';

// Cleanup temp dir
try { execSync(`powershell -NoProfile -Command "Remove-Item -Recurse -Force '${tmpDir}'"`, { stdio: 'ignore' }); } catch {}

// ── Write ideal-run.md ────────────────────────────────────────────────────────

fs.mkdirSync(outDir, { recursive: true });

const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
const dacpacName = path.basename(dacpacPath);
const traceNote = traceBaseline
  ? `Calibrated from trace with all phases: in=${traceBaseline.inTok.toLocaleString()}, peak=${traceBaseline.peakTok.toLocaleString()}, rounds=${traceBaseline.rounds}`
  : 'No trace file available — targets estimated from dacpac object counts alone';

const content = `# Ideal Run Reference

Generated: ${now} | Dacpac: ${dacpacName}
Basis: ${basisNote}
${traceNote}

## Model fingerprint

| Metric | Value |
|---|---|
| Tables | ${tables} |
| Views | ${views} |
| Procedures | ${procs} |
| Functions | ${functions} |
| Schemas | ${schemas} |
| Total objects | ${totalObjects} |
| Bodied (SM-eligible) | ${bodiedObjects} |
| Dependency edges (approx) | ${depEdges} |
| Avg edges/object | ${avgEdgesPerObj} |
| model.xml size | ${xml.length.toLocaleString()} bytes |

---

## Token targets

| Metric | Ideal | Basis |
|---|---|---|
| Total session in tokens | < ${idealTotalIn.toLocaleString()} | ${basisNote} |
| Peak round in tokens | < ${idealPeakTok.toLocaleString()} | |
| Discovery phase in tokens | < ${idealDiscoveryIn.toLocaleString()} | |
| Avg tool result chars | < ${idealToolResultAvg.toLocaleString()} | |
| SM rounds (typical query) | ≤ ${idealSmRounds} | |

## Tool behavior targets

| Metric | Ideal |
|---|---|
| Rejects | 0 |
| Tool call loops | 0 |
| Cache hit rate | > 20% |
| Max single tool result | < ${Math.round(idealToolResultAvg * 2).toLocaleString()} chars |

## Context management targets

| Metric | Ideal |
|---|---|
| Wipes per session | ≤ 1 |
| Context waste % | < 20% |
| Max round-over-round growth | < 25% |

## Answer detail targets

| Metric | Ideal |
|---|---|
| Math formula violations | 0 |
| Badge label violations (>50 chars) | 0 |
| Note caption violations (>200 chars) | 0 |
| Min chat output per round | > 80 chars |
| present_result total chars | 1,500 – 8,000 |
| short_term_memory per round | < 3,000 chars |

## Expected phase order

discover → [awaiting_gate →] active → synthesis → completed

## How to update

After a run that beats these targets without regressions:
1. Run \`node tests/tools/generate-ideal.js ${dacpacArg}\` — it reads the latest trace automatically
2. Review the updated targets and commit this file

Regenerate: \`node tests/tools/generate-ideal.js ${dacpacArg}\`
`;

fs.writeFileSync(outFile, content, 'utf8');
console.log(`\nWrote ${outFile}`);
console.log('\nKey computed targets:');
console.log(`  Total in tokens  < ${idealTotalIn.toLocaleString()}`);
console.log(`  Peak round       < ${idealPeakTok.toLocaleString()}`);
console.log(`  Discovery in     < ${idealDiscoveryIn.toLocaleString()}`);
console.log(`  Avg tool result  < ${idealToolResultAvg.toLocaleString()} chars`);
console.log(`  SM rounds        ≤ ${idealSmRounds}`);
