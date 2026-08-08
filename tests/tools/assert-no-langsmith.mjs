#!/usr/bin/env node
// Bundle gate: the shipped extension bundle must contain no LangSmith client code.
//
// `@langchain/core` hard-depends on `langsmith`, so the dependency declaration can never
// leave the npm graph; the root package.json `overrides` entry redirects every resolution
// to the inert local stub in stubs/langsmith/ instead of installing the real client. This
// check proves both directions: the stub marker IS present (the override applied), and
// real-client signatures are ABSENT (nothing bypassed it). Env-var name strings such as
// `LANGSMITH_TRACING` are expected — the runtime fail-closed guard matches on them.
import { readFileSync } from 'node:fs';

const BUNDLES = ['out/extension.js', 'out/extensionRuntime.js'];
const STUB_MARKER = 'LangSmith is excluded from this build';
// Signatures unique to the real langsmith client — endpoint, package id, multipart boundary.
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
