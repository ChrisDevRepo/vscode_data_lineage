/** Protects VS Code request-token cancellation of externally registered native-regexp searches. */
import { expect, it, vi } from 'vitest';
import type * as VSCode from 'vscode';

const bindings = vi.hoisted(() => new Map<string, VSCode.LanguageModelTool<unknown>>());
vi.mock('vscode', async importOriginal => {
  const actual = await importOriginal<typeof import('vscode')>();
  return { ...actual, lm: { registerTool: (name: string, tool: VSCode.LanguageModelTool<unknown>) => { bindings.set(name, tool); return { dispose() {} }; } } };
});

import * as vscode from 'vscode';
import { createExternalToolSource, registerAiTools } from '../../../src/ai/tools/toolProvider';
import { AiSession } from '../../../src/ai/session/session';
import type { DatabaseModel } from '../../../src/engine/types';

it('stops a registered search on its VS Code token without recording a model rejection', async () => {
  const session = new AiSession();
  session.model = { nodes: [{ id: 'dbo.v', name: 'v', schema: 'dbo', type: 'view', bodyScript: 'a'.repeat(50_000) }], edges: [] } as unknown as DatabaseModel;
  const error = vi.fn();
  const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error } as unknown as VSCode.LogOutputChannel;
  const disposables = registerAiTools(createExternalToolSource(() => session, channel, () => undefined));
  const token = new vscode.CancellationTokenSource();
  const invocation = bindings.get('lineage_search_ddl')!.invoke!({ input: { query: '(a+)+x' }, toolInvocationToken: undefined }, token.token);
  const timer = setTimeout(() => token.cancel(), 100);
  try { await expect(invocation).rejects.toMatchObject({ name: 'AbortError' }); }
  finally { clearTimeout(timer); token.dispose(); disposables.forEach(item => item.dispose()); }
  expect(session.hopLog).toHaveLength(0);
  expect(error).not.toHaveBeenCalled();
});
