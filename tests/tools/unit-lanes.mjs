/** Unit-test lanes. The gate runs `core` and `runtime` only. */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** Fixed aggregate recipes: filters or disabling flags would silently narrow a gate lane. */
const laneScriptCommands = {
  test: 'node tests/tools/run-lane.mjs gate',
  'test:parser': 'node tests/tools/run-vitest.mjs run tests/unit/parser',
  'test:core': 'node tests/tools/run-lane.mjs core',
  'test:lineage': 'node tests/tools/run-lane.mjs lineage',
  'test:runtime': 'node tests/tools/run-lane.mjs runtime',
  'coverage:core': 'node tests/tools/run-lane.mjs core --coverage',
};

/** Checks aggregate npm recipes; callers can still pass options to the lane runner explicitly. */
export function laneScriptProblems(scripts = {}) {
  return Object.entries(laneScriptCommands).flatMap(([script, expected]) => {
    const command = scripts[script];
    if (!command) return [`package.json has no "${script}" script.`];
    if (
      typeof command !== 'string' ||
      command
        .trim()
        .split(/[ \t]+/u)
        .join(' ') !== expected
    ) {
      return [`"${script}" must run ${expected}. It is: ${command}`];
    }
    return [];
  });
}

/** Repo-relative POSIX path.
 * @public
 */
export const rel = (absolute) =>
  path.relative(repoRoot, absolute).replaceAll('\\', '/');

/** Lineage and graph facts. Distinct expected graphs stay here. */
const lineageEngineTests = [
  'tests/unit/webview/applyTraceToFlow.test.ts',
  'tests/unit/engine/external-file-stability.test.ts',
  'tests/unit/engine/columnTraceView.test.ts',
  'tests/unit/engine/directed-removal-policy.test.ts',
  'tests/unit/engine/exclusionFilters.test.ts',
  'tests/unit/engine/graphAnalysis.test.ts',
  'tests/unit/engine/graphBuilder-api.test.ts',
  'tests/unit/engine/graphBuilder.test.ts',
  'tests/unit/engine/graphDisplayMode.test.ts',
  'tests/unit/engine/isolationFilter.test.ts',
  'tests/unit/engine/modelBuilder-externalRefs.test.ts',
  'tests/unit/engine/modelBuilder-unreadable.test.ts',
  'tests/unit/engine/modelSearch.test.ts',
  'tests/unit/engine/node-id-resolution.test.ts',
  'tests/unit/engine/nodeVerdicts.test.ts',
  'tests/unit/engine/objectLimit.test.ts',
  'tests/unit/engine/schemaViews.test.ts',
  'tests/unit/engine/sqlIdentifiers.test.ts',
  'tests/unit/engine/sqlSpans.test.ts',
  'tests/unit/engine/traceScope.test.ts',
  'tests/unit/engine/traceTree.test.ts',
  'tests/unit/engine/traversal-edge-cases.test.ts',
];

/** Deterministic contracts that stay on the gate: backend graph structure, malformed input, schema repair, secret redaction, cancellation, tool registration/dispatch, identifier boundaries, template structure, escaping, and the operator-runner secret boundary. Every other unit test file fails classification. */
export const runtimeContractTests = [
  'tests/unit/engine/settings-manifest.test.ts',
  'tests/unit/engine/logging-redaction.test.ts',
  'tests/unit/engine/bridge-contract.test.ts',
  'tests/unit/engine/projectStore.test.ts',
  'tests/unit/ai-core/webview-security-boundary.test.ts',
  'tests/unit/ai-core/agent-runtime-no-langsmith.test.ts',
  'tests/unit/ai-core/dispatcher-matrix.test.ts',
  'tests/unit/ai-core/identifier-presentation-paths.test.ts',
  'tests/unit/ai-core/operator-tool-boundary.test.ts',
  'tests/unit/ai-core/normalize-model-input.test.ts',
  'tests/unit/ai-core/output-template-sections.test.ts',
  'tests/unit/ai-core/present-result-schema.test.ts',
  'tests/unit/ai-core/present-result-repair.test.ts',
  'tests/unit/ai-core/present-result-coverage.test.ts',
  'tests/unit/ai-core/present-result-functional.test.ts',
  'tests/unit/ai-core/present-result-sql-fence-boundary.test.ts',
  'tests/unit/ai-core/prompt-task-slot-escaping.test.ts',
  'tests/unit/ai-core/synthesis-envelope-escape.test.ts',
  'tests/unit/ai-core/trace-security.test.ts',
  'tests/unit/ai-core/ai-tool-registration.test.ts',
  'tests/unit/backend/bb-lineage-shapes.test.ts',
  'tests/unit/backend/lineage-cases-contract.test.ts',
  'tests/unit/backend/lineage-cases-functional.test.ts',
  'tests/unit/backend/task-ledger.test.ts',
  'tests/unit/ai-core/submit-findings-schema.test.ts',
  'tests/unit/backend/function-column-contracts.test.ts',
  'tests/unit/ai-core/tool-boundary-precedence.test.ts',
  'tests/unit/ai-core/tool-error-envelope.test.ts',
  'tests/unit/ai-core/problem-escalation.test.ts',
  'tests/unit/ai-core/zod-issue-matrix.test.ts',
  'tests/unit/ai-core/config-core.test.ts',
];

/** Paths passed to Vitest for the coverage-floored core. */
export const corePaths = ['tests/unit/parser', ...lineageEngineTests];

/** Every `*.test.ts` under `tests/unit`. */
export function unitTestFiles(
  dir = path.join(repoRoot, 'tests', 'unit'),
  found = [],
) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) unitTestFiles(full, found);
    else if (entry.name.endsWith('.test.ts')) found.push(rel(full));
  }
  return found;
}

/** Expands a file path or a directory of unit tests. Returns null when the path is missing. */
function expandPath(entry, allFiles) {
  const absolute = path.join(repoRoot, entry);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return null;
  }
  if (stats.isFile()) return [entry.replaceAll('\\', '/')];
  const prefix = `${entry.replace(/\/+$/u, '').replaceAll('\\', '/')}/`;
  return allFiles.filter((file) => file.startsWith(prefix));
}

/** Classifies every unit test file. */
export function classifyUnitTests(allFiles = unitTestFiles().sort()) {
  const problems = [];
  const claim = (file, lane, claimed) => {
    const previous = claimed.get(file);
    if (previous)
      problems.push(
        `${file} is claimed more than once (${previous}, ${lane}).`,
      );
    claimed.set(file, lane);
  };
  const claimed = new Map();
  for (const entry of corePaths) {
    const selected = expandPath(entry, allFiles);
    if (selected === null)
      problems.push(`core lane names ${entry}, which does not exist.`);
    else if (selected.length === 0)
      problems.push(`core lane names ${entry}, which selects no test file.`);
    else for (const file of selected) claim(file, 'core', claimed);
  }
  for (const file of runtimeContractTests) {
    if (!allFiles.includes(file))
      problems.push(
        `runtime lane names ${file}, which is not a unit test file.`,
      );
    else claim(file, 'runtime', claimed);
  }
  for (const file of allFiles) {
    if (!claimed.has(file)) {
      problems.push(
        `${file} is not in a lane. Add a parser file under tests/unit/parser, a lineage file to ` +
          'lineageEngineTests or a gate contract to runtimeContractTests in tests/tools/unit-lanes.mjs.',
      );
    }
  }
  const filesIn = (lane) =>
    allFiles.filter((file) => claimed.get(file) === lane);
  return {
    problems,
    core: filesIn('core'),
    runtime: filesIn('runtime'),
  };
}
