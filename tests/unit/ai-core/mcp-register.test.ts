/**
 * The VS Code side of the MCP server: the definition the provider offers is complete (URL and
 * bearer header, because forwarding it to Copilot may skip `resolveMcpServerDefinition`), the server
 * follows `mcp.enabled` alone, and `dataLineageViz.mcp.enable` turns the setting on and offers
 * "Show servers".
 */
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  provider: undefined as undefined | {
    onDidChangeMcpServerDefinitions: (listener: () => void) => { dispose(): void };
    provideMcpServerDefinitions: () => Array<{ label: string; uri: { toString(): string }; headers: Record<string, string> }>;
  },
  commands: new Map<string, () => unknown>(),
  settings: { enabled: true, port: 0 },
  updates: [] as Array<[string, unknown, unknown]>,
  executed: [] as string[],
  shown: [] as Array<[string, string[]]>,
  pick: undefined as string | undefined,
}));

vi.mock('vscode', async importOriginal => {
  const actual = await importOriginal<typeof import('vscode')>();
  class EventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
    fire(value: T) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners = []; }
  }
  class McpHttpServerDefinition {
    constructor(public label: string, public uri: { toString(): string }, public headers: Record<string, string> = {}) {}
  }
  return {
    ...actual,
    EventEmitter,
    McpHttpServerDefinition,
    ConfigurationTarget: { Global: 1 },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    lm: { registerMcpServerDefinitionProvider: (_id: string, provider: typeof host.provider) => { host.provider = provider; return { dispose: () => undefined }; } },
    workspace: {
      getConfiguration: () => ({
        get: (key: 'enabled' | 'port', fallback: unknown) => host.settings[key] ?? fallback,
        update: async (key: string, value: unknown, target: unknown) => { host.updates.push([key, value, target]); },
      }),
      onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    },
    commands: {
      registerCommand: (id: string, run: () => unknown) => { host.commands.set(id, run); return { dispose: () => undefined }; },
      executeCommand: async (id: string) => { host.executed.push(id); },
    },
    window: {
      showInformationMessage: async (message: string, ...items: string[]) => { host.shown.push([message, items]); return host.pick; },
      showWarningMessage: async () => undefined,
    },
    env: { clipboard: { writeText: async () => undefined } },
  };
});

import type * as VSCode from 'vscode';
import { registerMcp } from '../../../src/ai/mcp/mcpServer';
import { AiSession } from '../../../src/ai/session/session';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const subscriptions: Array<{ dispose(): unknown }> = [];

/** Registers the MCP wiring and resolves once the provider offers a definition. */
async function registered(): Promise<void> {
  host.settings.port = await freePort();
  const store = new Map<string, string>();
  const channel = { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined, trace: () => undefined };
  const context = {
    subscriptions,
    secrets: { get: async (key: string) => store.get(key), store: async (key: string, value: string) => { store.set(key, value); } },
    extension: { packageJSON: { version: '0.0.0-test' } },
  };
  registerMcp(context as unknown as VSCode.ExtensionContext, { getSession: () => new AiSession(), outputChannel: channel as never, getPanel: () => undefined });
  await vi.waitFor(() => expect(host.provider!.provideMcpServerDefinitions()).toHaveLength(1));
}

afterEach(async () => {
  await Promise.all(subscriptions.splice(0).map((d) => d.dispose()));
  host.provider = undefined;
  host.commands.clear();
  host.updates.length = 0;
  host.executed.length = 0;
  host.shown.length = 0;
  host.pick = undefined;
  host.settings.enabled = true;
});

describe('MCP registration', () => {
  it('provides a complete definition: the URL and the bearer token from SecretStorage', async () => {
    await registered();
    const [definition] = host.provider!.provideMcpServerDefinitions();
    expect(definition.label).toBe('Data Lineage');
    expect(definition.uri.toString()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(definition.headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
  });

  it('offers no definition while mcp.enabled is off', async () => {
    host.settings.enabled = false;
    registerMcp({ subscriptions, secrets: { get: async () => undefined, store: async () => undefined }, extension: { packageJSON: { version: '0' } } } as never,
      { getSession: () => new AiSession(), outputChannel: { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined, trace: () => undefined } as never, getPanel: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.provider!.provideMcpServerDefinitions()).toEqual([]);
  });

  it('dataLineageViz.mcp.enable turns the setting on and "Show servers" opens the server list', async () => {
    await registered();
    host.pick = 'Show servers';
    await host.commands.get('dataLineageViz.mcp.enable')!();
    expect(host.updates).toEqual([['enabled', true, 1]]);
    expect(host.shown[0][1]).toEqual(['Show servers']);
    expect(host.executed).toEqual(['workbench.mcp.listServer']);
  });

  it('dataLineageViz.mcp.enable without a pick only turns the setting on', async () => {
    await registered();
    await host.commands.get('dataLineageViz.mcp.enable')!();
    expect(host.updates).toEqual([['enabled', true, 1]]);
    expect(host.executed).toEqual([]);
  });
});
