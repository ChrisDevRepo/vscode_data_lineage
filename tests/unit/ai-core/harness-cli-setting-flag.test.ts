/**
 * Regression tests for `--setting` parsing in `tests/harness/cli.ts`.
 *
 * @remarks
 * Pins the repeatable `--setting <key>=<value>` flag: absent by default, accumulates into a Map
 * across repeats, keeps a value containing `=` intact (split on the first `=` only), and rejects a
 * malformed `--setting` with no `=`.
 */
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../harness/cli';

const BASE_ARGS = ['--lane', 'azure-foundry'];

describe('cli --setting parsing', () => {
  it('defaults to an empty settings map when --setting is never passed', () => {
    const parsed = parseArgs(BASE_ARGS);
    if (parsed.ok !== true) throw new Error('expected ok: true');
    expect(parsed.settings.size).toBe(0);
  });

  it('parses one --setting key=value pair', () => {
    const parsed = parseArgs([...BASE_ARGS, '--setting', 'dataLineageViz.ai.outputTemplateFile=c:/overlay.yaml']);
    if (parsed.ok !== true) throw new Error('expected ok: true');
    expect(parsed.settings.get('dataLineageViz.ai.outputTemplateFile')).toBe('c:/overlay.yaml');
  });

  it('accumulates repeated --setting flags into the same map', () => {
    const parsed = parseArgs([
      ...BASE_ARGS,
      '--setting', 'dataLineageViz.ai.outputTemplateFile=c:/overlay.yaml',
      '--setting', 'dataLineageViz.dmvQueryTimeout=30',
    ]);
    if (parsed.ok !== true) throw new Error('expected ok: true');
    expect(parsed.settings.size).toBe(2);
    expect(parsed.settings.get('dataLineageViz.dmvQueryTimeout')).toBe('30');
  });

  it('splits on the first = only, keeping a value containing = intact', () => {
    const parsed = parseArgs([...BASE_ARGS, '--setting', 'dataLineageViz.ai.outputTemplateFile=c:/path?query=1']);
    if (parsed.ok !== true) throw new Error('expected ok: true');
    expect(parsed.settings.get('dataLineageViz.ai.outputTemplateFile')).toBe('c:/path?query=1');
  });

  it('rejects a --setting value with no =', () => {
    const parsed = parseArgs([...BASE_ARGS, '--setting', 'dataLineageViz.ai.outputTemplateFile']);
    expect(parsed.ok).toBe(false);
  });
});
