/**
 * Minimal `vscode` module stub for unit tests.
 *
 * @remarks
 * The real `vscode` module only exists inside the extension host, so vitest cannot
 * resolve `import * as vscode from 'vscode'` in source files under test. This stub
 * satisfies module resolution (wired via `resolve.alias` in `vitest.config.ts`);
 * individual tests override the members they exercise with `vi.mock('vscode', …)`
 * or by injecting dependencies explicitly. Add members here only when a test needs them.
 */
export const window = {
  showErrorMessage: (..._args: unknown[]): unknown => undefined,
  showWarningMessage: (..._args: unknown[]): unknown => undefined,
  showInformationMessage: (..._args: unknown[]): unknown => undefined,
};
