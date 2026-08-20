/**
 * Regression tests for the setting-injection hook on `tests/harness/vscodeHostShim.ts`.
 *
 * @remarks
 * Pins the contract stated in the shim's module doc comment: with nothing injected,
 * `getConfiguration(...).get(key, default)` returns the caller's own default verbatim, and an
 * injected key wins only on an exact dotted `section.key` match — every other key on the same
 * section is unaffected.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getConfiguration, setShimSettings } from '../../harness/vscodeHostShim';

/** Typed view of the shim's `get`, whose declared return type is `Record<string, unknown>`. */
function configGet(section: string, key: string, defaultValue?: unknown): unknown {
  const get = getConfiguration(section).get as (k: string, d?: unknown) => unknown;
  return get(key, defaultValue);
}

describe('vscodeHostShim setting injection', () => {
  beforeEach(() => {
    setShimSettings(new Map());
  });

  it('returns the caller default verbatim when nothing is injected', () => {
    expect(configGet('dataLineageViz.ai', 'outputTemplateFile', 'built-in-default')).toBe('built-in-default');
  });

  it('returns undefined when nothing is injected and no default is passed', () => {
    expect(configGet('dataLineageViz.ai', 'outputTemplateFile')).toBeUndefined();
  });

  it('an injected key wins over the caller default on an exact dotted match', () => {
    setShimSettings(new Map([['dataLineageViz.ai.outputTemplateFile', 'c:/overlay.yaml']]));
    expect(configGet('dataLineageViz.ai', 'outputTemplateFile', 'built-in-default')).toBe('c:/overlay.yaml');
  });

  it('an injected key leaves other keys on the same section untouched', () => {
    setShimSettings(new Map([['dataLineageViz.ai.outputTemplateFile', 'c:/overlay.yaml']]));
    expect(configGet('dataLineageViz.ai', 'dmvQueryTimeout', 120)).toBe(120);
  });

  it('an injected key on a different section does not leak across sections', () => {
    setShimSettings(new Map([['dataLineageViz.ai.outputTemplateFile', 'c:/overlay.yaml']]));
    expect(configGet('dataLineageViz', 'outputTemplateFile', 'built-in-default')).toBe('built-in-default');
  });

  it('clearing the injected map (empty Map) restores byte-identical default passthrough', () => {
    setShimSettings(new Map([['dataLineageViz.ai.outputTemplateFile', 'c:/overlay.yaml']]));
    setShimSettings(new Map());
    expect(configGet('dataLineageViz.ai', 'outputTemplateFile', 'built-in-default')).toBe('built-in-default');
  });
});
