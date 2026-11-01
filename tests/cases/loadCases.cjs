/** Loads tests/cases/lineage-cases.yaml. Each runner loops only the rows tagged for it. */
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { load } = require('js-yaml');

const casesPath = path.join(__dirname, 'lineage-cases.yaml');

/**
 * @param [runner] `scripted` or `headless`. Omit to return every row.
 * @returns Every case row, or only the rows tagged for the named runner.
 */
function loadCases(runner) {
  const doc = load(readFileSync(casesPath, 'utf8'));
  const cases = Array.isArray(doc?.cases) ? doc.cases : [];
  if (!runner) return cases;
  return cases.filter((row) => (row.runners ?? ['scripted']).includes(runner));
}

module.exports = { loadCases };
