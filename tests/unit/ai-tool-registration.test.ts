/**
 * Tool registration guard test.
 *
 * Enforces invariant: every tool declared in package.json's
 * contributes.languageModelTools manifest MUST have a matching
 * `vscode.lm.registerTool('<name>', ...)` call in src/ai/toolProvider.ts.
 *
 * Fails loudly when they drift so the regression in commit bf51fa9 (4 tools
 * declared but never registered) cannot recur silently.
 */

import { readFileSync } from 'fs';
import { printSummary, resetCounters, assert, assertEq, rootPath } from './helpers/testUtils';

console.log('Tool Registration Guard');
console.log('='.repeat(40));
resetCounters();

const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf-8')) as {
  contributes: { languageModelTools?: Array<{ name: string }> };
};
const manifestTools = (pkg.contributes.languageModelTools ?? []).map(t => t.name).sort();

const providerSrc = readFileSync(rootPath('src', 'ai', 'toolProvider.ts'), 'utf-8');
const registrationPattern = /vscode\.lm\.registerTool\(\s*['"]([^'"]+)['"]/g;
const registeredTools: string[] = [];
let match: RegExpExecArray | null;
while ((match = registrationPattern.exec(providerSrc)) !== null) {
  registeredTools.push(match[1]);
}
registeredTools.sort();

console.log(`\n── Manifest vs Registration ──`);
console.log(`   manifest:    ${manifestTools.length} tools`);
console.log(`   registered:  ${registeredTools.length} tools`);

assertEq(registeredTools.length, manifestTools.length, 'registration count matches manifest count');

const missing = manifestTools.filter(t => !registeredTools.includes(t));
const extra = registeredTools.filter(t => !manifestTools.includes(t));

assert(missing.length === 0, `no tools declared in manifest are unregistered (missing: ${missing.join(', ') || '—'})`);
assert(extra.length === 0, `no tools registered that aren't in manifest (extra: ${extra.join(', ') || '—'})`);

console.log(`\n── Every tool name matches exactly ──`);
for (const name of manifestTools) {
  assert(registeredTools.includes(name), `"${name}" is registered`);
}

printSummary('Tool Registration Guard');
