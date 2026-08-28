// Column-trace nodes carry the same ids as the object nodes they replace, in a different
// coordinate space. React Flow's `getNodes()` returns whatever is mounted, so a callback that
// persists or exports positions while the column view is on stage would write column-view
// coordinates into an object-view artifact — a bookmark restoring to scrambled positions, or a
// draw.io file whose objects sit where their column boxes were.
//
// `objectNodes()` is the accessor that resolves this: it prefers the object-space nodes captured
// for the column view and falls back to `getNodes()` in the object view. The drag path already
// guards the same hazard by routing column drags to `columnPositions` instead of `localNodes`.
//
// Mounting `GraphCanvas` to assert this behaviourally is not proportionate — it takes 107 props
// behind `ReactFlowProvider` and the webview's VS Code context — so this asserts the source
// contract instead: the persist/export callbacks read `objectNodes()`, never `getNodes()`. It
// catches the regression that matters, which is a later edit reaching for `getNodes()` again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'src', 'components', 'GraphCanvas.tsx'),
  'utf8',
);

/** The callbacks that persist or export node positions as object-view artifacts. */
const POSITION_CONSUMERS = [
  'handleSaveTraceAsBookmark',
  'handleSaveAnalysisAsBookmark',
  'handleSaveAiAsBookmark',
  'handleExportDrawio',
] as const;

/**
 * Body and dependency array of a `useCallback` declaration, from its opening line through the
 * `}, [...]);` that closes it.
 */
function callbackSource(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} is declared as a useCallback`).toBeGreaterThan(-1);
  const close = source.indexOf(']);', start);
  expect(close, `${name} has a closing dependency array`).toBeGreaterThan(start);
  return source.slice(start, close + 3);
}

describe('GraphCanvas — bookmarks and exports read object-space positions', () => {
  it('resolves object nodes from the column-view capture, falling back to the mounted nodes', () => {
    expect(source).toContain(
      'const objectNodes = useCallback(() => columnViewObjectNodesRef.current ?? getNodes(), [getNodes]);',
    );
  });

  it('captures object-space nodes only while the column view is active', () => {
    expect(source).toContain(
      'columnViewObjectNodesRef.current = columnViewActive ? localNodes : null;',
    );
  });

  for (const name of POSITION_CONSUMERS) {
    it(`${name} reads objectNodes() and not getNodes()`, () => {
      const body = callbackSource(name);
      expect(body, `${name} must read positions through objectNodes()`).toContain('objectNodes()');
      expect(body, `${name} must not read the mounted nodes directly`).not.toContain('getNodes()');
    });

    it(`${name} depends on objectNodes rather than getNodes`, () => {
      const deps = callbackSource(name).slice(callbackSource(name).lastIndexOf('}, ['));
      expect(deps, `${name} lists objectNodes as a dependency`).toContain('objectNodes');
      expect(deps, `${name} no longer lists getNodes as a dependency`).not.toContain('getNodes');
    });
  }
});
