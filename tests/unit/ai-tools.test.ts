/**
 * Validates that all required lineage tools are registered and available
 * to the chat participant.
 */

import { readFileSync } from 'fs';
import { assert, resetCounters, printSummary, rootPath } from './helpers/testUtils';

console.log('AI Tool Registration');
console.log('='.repeat(40));
resetCounters();

// 1. Invariant check: package.json matches toolProvider.ts
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

assert(registeredTools.length === manifestTools.length, 'registration count matches manifest count');

const missing = manifestTools.filter(t => !registeredTools.includes(t));
assert(missing.length === 0, `no tools declared in manifest are unregistered (missing: ${missing.join(', ') || '—'})`);

// 2. Specific tool rename verification
assert(registeredTools.includes('lineage_present_result'), 'lineage_present_result is registered');
assert(!registeredTools.includes('lineage_enrich_view'), 'legacy lineage_enrich_view is GONE');

console.log('\n── Required Core Tools ──');
const required = ['lineage_get_context', 'lineage_search_objects', 'lineage_get_neighborhood', 'lineage_detect_graph_patterns', 'lineage_start_exploration', 'lineage_submit_findings', 'lineage_present_result'];
for (const name of required) {
  assert(registeredTools.includes(name), `"${name}" is registered`);
}

printSummary('AI Tool Registration');
