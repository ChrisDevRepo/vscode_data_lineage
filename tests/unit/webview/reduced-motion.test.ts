/**
 * Reduced motion has one owner: the stylesheet.
 *
 * `ColumnTraceNode` used to probe `matchMedia('(prefers-reduced-motion: reduce)')` on every render
 * — a media query read per node per frame, answering a question the stylesheet already answers, and
 * answering it differently: the CSS rule keyed only on VS Code's `workbench.reduceMotion` class, so
 * the two disagreed whenever the OS preference and the editor setting differed.
 *
 * Mounting the node to assert this behaviourally would prove nothing the source cannot: the claim is
 * that no component reads the preference at all, and that the stylesheet honours both signals.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const columnTraceNode = readFileSync(
  join(process.cwd(), 'src', 'components', 'ColumnTraceNode.tsx'),
  'utf8',
);

const stylesheet = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');

describe('reduced motion is owned by the stylesheet', () => {
  it('no column-trace node probes the preference at render time', () => {
    expect(columnTraceNode).not.toContain('matchMedia');
    expect(columnTraceNode).not.toContain('reducedMotionActive');
  });

  it('the stylesheet drops transitions for the editor setting and the OS preference alike', () => {
    expect(stylesheet).toContain('body.vscode-reduce-motion *,');
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
