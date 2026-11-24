/**
 * Two overlapping rewrites of one list setting both land: the second reads the list only after the
 * first has been written, and a failed rewrite rejects its own caller without blocking the next.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ values: new Map<string, unknown>(), failNext: false }));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string) => store.values.get(`${section}.${key}`),
      update: async (key: string, value: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (store.failNext) { store.failNext = false; throw new Error('write refused'); }
        store.values.set(`${section}.${key}`, value);
      },
    }),
  },
}));

import { rawId, readRawList, rewriteRawList } from '../../../src/host/rawSettingList';

beforeEach(() => { store.values.clear(); store.failNext = false; });

describe('rewriteRawList', () => {
  it('serializes overlapping rewrites of one setting so neither drops the other', async () => {
    store.values.set('dataLineageViz.ai.models', [{ id: 'a' }]);
    await Promise.all([
      rewriteRawList('dataLineageViz.ai', 'models', (entries) => [...entries, { id: 'b' }]),
      rewriteRawList('dataLineageViz.ai', 'models', (entries) => entries.filter((entry) => rawId(entry) !== 'a')),
    ]);
    expect(readRawList('dataLineageViz.ai', 'models')).toEqual([{ id: 'b' }]);
  });

  it('rejects a failed rewrite for its own caller only', async () => {
    store.failNext = true;
    const failed = rewriteRawList('s', 'k', () => [{ id: 'x' }]);
    const next = rewriteRawList('s', 'k', () => [{ id: 'y' }]);
    await expect(failed).rejects.toThrow('write refused');
    await next;
    expect(readRawList('s', 'k')).toEqual([{ id: 'y' }]);
  });

  it('reads a setting that is not a list as empty', () => {
    store.values.set('s.k', 'text');
    expect(readRawList('s', 'k')).toEqual([]);
    expect(rawId('text')).toBeUndefined();
  });
});
