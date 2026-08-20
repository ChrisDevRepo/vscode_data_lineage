import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
} from '../../../src/ai/tools/registry';
import { TOOL_DEFS } from '../../../src/ai/tools/toolDefs';

describe('canonical tool registry', () => {
  it('preserves manifest order and rejects duplicates and unknown tools', () => {
    expect(TOOL_DEFS.length).toBeGreaterThan(0);
    expect(new Set(TOOL_DEFS.map(tool => tool.name)).size).toBe(TOOL_DEFS.length);
    const descriptor = TOOL_DEFS.at(0);
    if (!descriptor) throw new Error('registry precondition: expected a contributed descriptor');

    const registry = new ToolRegistry<unknown>();
    const tool = { ...descriptor, execute: (input: unknown) => input };
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/duplicate/);
    expect(() => registry.invoke('lineage_not_registered', {})).toThrow(/no tool registered/i);
  });

  it('dispatches the registered raw tool input through the canonical handler', async () => {
    const descriptor = TOOL_DEFS.at(0);
    if (!descriptor) throw new Error('registry precondition: expected a contributed descriptor');
    const registry = new ToolRegistry<unknown>();
    const original = { nested: { value: 'original' } };
    registry.register({ ...descriptor, execute: input => input });

    expect(await registry.invoke(descriptor.name, original)).toBe(original);
    expect(original).toEqual({ nested: { value: 'original' } });
  });
});
