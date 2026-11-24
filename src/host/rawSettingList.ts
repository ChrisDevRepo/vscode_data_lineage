/** Read and rewrite a list setting as the user's settings.json holds it, one rewrite at a time. */

import * as vscode from 'vscode';

/** A copy of the raw list value of `section.key`; empty when the setting holds no array. */
export function readRawList(section: string, key: string): unknown[] {
  const raw = vscode.workspace.getConfiguration(section).get<unknown>(key);
  return Array.isArray(raw) ? [...raw] : [];
}

/** The `id` of a raw list entry, whatever else it holds; `undefined` for a non-object entry. */
export function rawId(entry: unknown): unknown {
  return entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined;
}

/** Tail of the rewrites per setting; each read-modify-write starts after the last one settles. */
const rewriteTails = new Map<string, Promise<unknown>>();

/**
 * Rewrites the list `section.key` in the user (global) settings, one rewrite at a time per setting;
 * the setting is application-scoped, so a workspace can neither hold nor override it. `change`
 * reads the list only after every earlier rewrite has landed, so concurrent saves never drop each
 * other's entries; a failed rewrite rejects its own caller and does not block the next.
 */
export function rewriteRawList(section: string, key: string, change: (entries: unknown[]) => unknown[]): Promise<void> {
  const run = async (): Promise<void> => {
    await vscode.workspace.getConfiguration(section)
      .update(key, change(readRawList(section, key)), vscode.ConfigurationTarget.Global);
  };
  const name = `${section}.${key}`;
  const result = (rewriteTails.get(name) ?? Promise.resolve()).then(run, run);
  rewriteTails.set(name, result.catch(() => undefined));
  return result;
}
