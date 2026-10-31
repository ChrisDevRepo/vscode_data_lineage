/** Loads tests/cases/lineage-cases.yaml. Each runner loops only the rows tagged for it. */
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { load } = require('js-yaml');

const casesPath = path.join(__dirname, 'lineage-cases.yaml');

/**
 * @param {string} [runner] `scripted`, `headless`, `electron`, or `playwright`. Omit to return every row.
 * @returns {Array<{ id: string, runners?: string[], prompt?: string, command?: string, dacpac?: string, expect?: Record<string, unknown> }>}
 */
function loadCases(runner) {
  const doc = load(readFileSync(casesPath, 'utf8'));
  const cases = Array.isArray(doc?.cases) ? doc.cases : [];
  if (!runner) return cases;
  return cases.filter(row => (row.runners ?? ['scripted']).includes(runner));
}

module.exports = { loadCases };
