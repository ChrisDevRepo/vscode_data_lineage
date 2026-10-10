import { describe, expect, it, vi } from 'vitest';
import { migrateFromWorkspaceState } from '../../../src/utils/migration';

const storeKey = 'projects';
const output = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never;
const legacyDacpac = { lastSourceType: 'dacpac', lastDacpacPath: '/public/demo.dacpac', lastDacpacName: 'Demo' };
const legacyDatabase = { lastSourceType: 'database', lastDbSourceName: 'Demo', lastDbConnectionInfo: { server: 'localhost', database: 'Demo', user: 'reader', password: 'synthetic-secret', authenticationType: 'SqlLogin' } };

function state(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  return {
    values,
    get: (key: string) => values[key],
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) delete values[key];
      else values[key] = value;
    }),
  };
}

function context(legacy: Record<string, unknown>) {
  return { workspaceState: state(legacy), globalState: state() };
}

describe('legacy workspace migration preserves original data until saved', () => {
  it.each([
    { lastSourceType: 'dacpac', lastDacpacName: 'Missing path' },
    { lastSourceType: 'dacpac', lastDacpacPath: '/public/demo.dacpac' },
    { lastSourceType: 'database', lastDbSourceName: 'Missing connection' },
    { lastSourceType: 'database', lastDbSourceName: 'Invalid connection', lastDbConnectionInfo: { server: 'localhost' } },
  ])('retains incomplete/invalid legacy state: %j', async legacy => {
    const ctx = context(legacy);
    await migrateFromWorkspaceState(ctx as never, storeKey, output);
    expect(ctx.workspaceState.values).toEqual(legacy);
    expect(ctx.workspaceState.update).not.toHaveBeenCalled();
    expect(ctx.globalState.update).not.toHaveBeenCalled();
  });

  it('retains original keys when saving the migrated project fails', async () => {
    const ctx = context(legacyDacpac);
    ctx.globalState.update.mockRejectedValueOnce(new Error('synthetic storage failure'));
    await expect(migrateFromWorkspaceState(ctx as never, storeKey, output)).rejects.toThrow('synthetic storage failure');
    expect(ctx.workspaceState.values).toEqual(legacyDacpac);
    expect(ctx.workspaceState.update).not.toHaveBeenCalled();
  });

  it.each([legacyDacpac, legacyDatabase])('saves a valid project before clearing keys and does not repeat: %j', async legacy => {
    const ctx = context({ ...legacy, unrelated: 'keep' });
    await migrateFromWorkspaceState(ctx as never, storeKey, output);
    const saved = ctx.globalState.values[storeKey] as { projects: Array<{ connection: unknown }> };
    expect(saved.projects).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain('synthetic-secret');
    expect(ctx.workspaceState.values).toEqual({ unrelated: 'keep' });
    expect(ctx.globalState.update.mock.invocationCallOrder[0]).toBeLessThan(ctx.workspaceState.update.mock.invocationCallOrder[0]);
    await migrateFromWorkspaceState(ctx as never, storeKey, output);
    expect(ctx.globalState.update).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no legacy source exists', async () => {
    const ctx = context({ unrelated: 'keep' });
    await migrateFromWorkspaceState(ctx as never, storeKey, output);
    expect(ctx.workspaceState.update).not.toHaveBeenCalled();
    expect(ctx.globalState.update).not.toHaveBeenCalled();
  });
});
