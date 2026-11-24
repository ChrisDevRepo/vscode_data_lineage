/**
 * The tool registry refuses a duplicate name, rejects an unregistered or filtered-out name, and
 * dispatches the raw input to the tool unchanged.
 */
import { describe, expect, it } from 'vitest';
import { filterRegistry, ToolRegistry } from '../../../src/ai/tools/registry';
import { TOOL_DEFS } from '../../../src/ai/tools/toolDefs';

describe('ToolRegistry', () => {
  it('guards the registry names it serves and dispatches the raw input unchanged', async () => {
    const registry = new ToolRegistry();
    const tool = { ...TOOL_DEFS[0], execute: (input: unknown) => input };
    registry.register(tool);
    expect(() => { registry.register(tool); }).toThrow(/duplicate/);
    expect(() => registry.invoke('lineage_not_registered', {})).toThrow(/no tool registered/i);
    expect(() => filterRegistry(registry, new Set()).invoke(tool.name, {})).toThrow(/no tool registered/i);
    const original = { nested: { value: 'original' } };
    expect(await registry.invoke(tool.name, original)).toBe(original);
  });
});
