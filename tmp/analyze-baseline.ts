import { readFileSync } from 'fs';

const tsv = readFileSync('tmp/rl-baseline.tsv', 'utf-8')
  .split('\n')
  .slice(1)
  .filter(l => l.match(/^(classic|sdk-style|customer)/));

let hasDeps = 0, noDeps = 0, srcOnly = 0, tgtOnly = 0, bothSrcTgt = 0, hasExec = 0;
let classDeps = 0, classNone = 0, sdkDeps = 0, sdkNone = 0, custDeps = 0, custNone = 0;

tsv.forEach(line => {
  const [dacpac,, src, tgt, ex] = line.split('\t');
  const hasSrc = src && src !== '-';
  const hasTgt = tgt && tgt !== '-';
  const hasEx = ex && ex !== '-';
  const any = hasSrc || hasTgt || hasEx;
  if (any) hasDeps++; else noDeps++;
  if (hasSrc && !hasTgt) srcOnly++;
  if (!hasSrc && hasTgt) tgtOnly++;
  if (hasSrc && hasTgt) bothSrcTgt++;
  if (hasEx) hasExec++;
  if (dacpac === 'classic') { if (any) classDeps++; else classNone++; }
  if (dacpac === 'sdk-style') { if (any) sdkDeps++; else sdkNone++; }
  if (dacpac === 'customer') { if (any) custDeps++; else custNone++; }
});

const total = hasDeps + noDeps;
console.log(`Total SPs: ${total}`);
console.log(`  Classic:   ${classDeps + classNone} (${classDeps} with deps, ${classNone} no deps)`);
console.log(`  SDK-style: ${sdkDeps + sdkNone} (${sdkDeps} with deps, ${sdkNone} no deps)`);
console.log(`  Customer:  ${custDeps + custNone} (${custDeps} with deps, ${custNone} no deps)`);
console.log();
console.log(`SPs with at least one dep: ${hasDeps} (${Math.round(hasDeps/total*100)}%)`);
console.log(`SPs with no deps found:    ${noDeps} (${Math.round(noDeps/total*100)}%)`);
console.log();
console.log(`Source-only SPs:  ${srcOnly}`);
console.log(`Target-only SPs:  ${tgtOnly}`);
console.log(`Both src+tgt SPs: ${bothSrcTgt}`);
console.log(`Has exec calls:   ${hasExec}`);
