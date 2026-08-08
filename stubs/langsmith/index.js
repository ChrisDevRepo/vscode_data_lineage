'use strict';
// Inert replacement for every `langsmith` import specifier (root and all subpaths — the
// package.json exports map routes them all here).
//
// `@langchain/core` hard-depends on `langsmith`, so the package can never leave the npm
// dependency graph — but this project must not carry LangSmith client code anywhere: no
// telemetry integration exists, and prompts / graph state must never leave the extension
// host. The root package.json `overrides` entry pins `langsmith` to this stub, so the real
// client is never installed, bundled, or shipped. `tests/tools/assert-no-langsmith.mjs`
// (wired into `npm run gate`) asserts the marker below is present in the bundle and that
// real-client signatures are absent.
//
// Two behavior classes, chosen per call site in `@langchain/core`:
// - Probes on LangChain's normal (non-tracing) code path return inert values — they run on
//   every graph invocation and must never throw.
// - Tracing-only surfaces fail closed so an unexpected activation is loud, never a silent
//   export. The runtime guard in `agentRuntime.ts` rejects ambient tracing flags before
//   these paths could be reached.

const LANGSMITH_EXCLUDED = 'LangSmith is excluded from this build';

function failClosed(surface) {
  throw new Error(`${LANGSMITH_EXCLUDED}: ${surface} is a tracing-only path and must never be reached.`);
}

// Normal-path probe (`callbacks/manager`): nothing in this build is a traceable-wrapped function.
function isTraceableFunction(_value) {
  return false;
}

// Normal-path probe (async-local-storage context): there is never an ambient LangSmith run tree.
function getCurrentRunTree() {
  return undefined;
}

// Normal-path probe: no value is ever a LangSmith RunTree.
function isRunTree(_value) {
  return false;
}

// Tracer construction only — unreachable while the tracing guard holds.
function getDefaultProjectName() {
  return failClosed('getDefaultProjectName');
}

// Run-tree bookkeeping only — unreachable while the tracing guard holds.
function convertToDottedOrderFormat() {
  return failClosed('convertToDottedOrderFormat');
}

// LangSmith API client — construction fails closed; no client implementation exists here.
class Client {
  constructor() {
    failClosed('LangSmith Client construction');
  }
}

// Context-propagation carrier, NOT a tracing surface: LangChain's normal execution path builds
// `new RunTree({ name: '<runnable_lambda>', tracingEnabled: false })` in
// `AsyncLocalStorageProvider.runWithConfig` purely as the async-local-storage store value and
// then assigns `runTree.extra[LC_CHILD_KEY] = config`. Construction and property access must
// therefore stay inert; only the HTTP exporter methods fail closed.
class RunTree {
  constructor(fields) {
    Object.assign(this, fields ?? {});
    if (this.extra === undefined) this.extra = {};
  }
  createChild(fields) {
    return new RunTree(fields);
  }
  end() {
    // Local bookkeeping in the real client — inert here; nothing is recorded or exported.
  }
  async postRun() {
    return failClosed('RunTree.postRun');
  }
  async patchRun() {
    return failClosed('RunTree.patchRun');
  }
}

module.exports = {
  LANGSMITH_EXCLUDED,
  isTraceableFunction,
  getCurrentRunTree,
  isRunTree,
  getDefaultProjectName,
  convertToDottedOrderFormat,
  Client,
  RunTree,
};
