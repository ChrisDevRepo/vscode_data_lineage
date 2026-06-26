import * as vscode from 'vscode';

/** Marketplace id of the extension under test (publisher.name from package.json). */
export const EXT_ID = 'datahelper-chwagner.data-lineage-viz';

/**
 * Minimal shape of the value returned by the extension's `activate()`
 * ([extension.ts](../../../src/extension.ts)). Typed locally so the integration
 * tests do not pull `src/**` into their compile (rootDir = `tests`).
 */
export interface DlvApi {
  /** Returns the singleton AiSession (model, uiState, phase, columnStore). */
  getSession: () => DlvSession;
  /** Returns the active main webview panel, if one is open. */
  getActivePanel: () => vscode.WebviewPanel | undefined;
  /** In-memory log buffer; populated only when `VSCODE_EX_TEST` is set. */
  testLogCapture: string[];
  participant: unknown;
}

/** The subset of AiSession the integration tests assert against. */
export interface DlvSession {
  model: { nodes: unknown[]; edges: unknown[]; schemas: unknown[] } | null;
  projectName?: string | null;
  phase: { kind: string };
  [k: string]: unknown;
}

/** Activates the extension and returns its API surface. */
export async function getApi(): Promise<DlvApi> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  if (!ext) throw new Error(`Extension ${EXT_ID} not found in the dev host`);
  const api = await ext.activate();
  if (!api) throw new Error('activate() returned no API');
  return api as DlvApi;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `fn` until it returns a truthy value or the timeout elapses.
 *
 * @returns The first truthy value produced by `fn`.
 * @throws If `timeoutMs` elapses without a truthy value.
 */
export async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 30000, intervalMs = 250): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

/**
 * Triggers `copyDebugInfo` and returns the debug dump read back from the
 * clipboard — the canonical state-driven verification surface for feature tests.
 */
export async function captureDebugDump(): Promise<string> {
  await vscode.env.clipboard.writeText('__dump_cleared__');
  await vscode.commands.executeCommand('dataLineageViz.copyDebugInfo');
  for (let i = 0; i < 30; i++) {
    const t = await vscode.env.clipboard.readText();
    if (t && t.includes('Debug Info')) return t;
    await sleep(200);
  }
  throw new Error('debug dump was not captured from clipboard');
}
