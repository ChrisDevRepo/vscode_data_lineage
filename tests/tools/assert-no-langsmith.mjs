#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const BUNDLES = ['out/extension.js', 'out/extensionRuntime.js'];
const STUB_MARKER = 'LangSmith is excluded from this build';
const FORBIDDEN = ['smith.langchain.com', 'langsmith-js', 'LangSmithFormBoundary'];

let bundle;
try {
  bundle = BUNDLES.map((path) => readFileSync(path, 'utf8')).join('\n');
} catch {
  console.error(`FAIL  extension bundle not found — run the build first (npm run build:ext).`);
  process.exit(1);
}

const problems = [];
if (!bundle.includes(STUB_MARKER)) {
  problems.push(`stub marker missing — the exclude-langsmith esbuild plugin did not apply`);
}
for (const signature of FORBIDDEN) {
  if (bundle.includes(signature)) {
    problems.push(`forbidden LangSmith client signature present: "${signature}"`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`PASS  extension bundles carry the LangSmith exclusion stub and no client signatures.`);
