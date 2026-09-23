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
  it('resolves object nodes from the hoisted column-view state, falling back to the mounted nodes', () => {
    expect(source).toContain(
      'const objectNodes = useCallback(() => (columnViewActive ? localNodes : getNodes()), [columnViewActive, localNodes, getNodes]);',
    );
  });

  it('derives the column-view flag from state rather than writing a ref during render', () => {
    expect(source).toContain('const columnViewActive = columnView && !!columnTraceView;');
    expect(source, 'the object-node ref is gone').not.toContain('columnViewObjectNodesRef');
    expect(source, 'the object-edge ref is gone').not.toContain('columnViewEdgesRef');
    expect(
      callbackSource('handleExportDrawio'),
      'the export reads object-level edges while the column view is on stage',
    ).toContain('const exportEdges = columnViewActive ? localEdges : getEdges();');
  });

  it('clears the graph error boundary when the view mode changes', () => {
    expect(source).toContain(
      'resetKey={`${graphErrorResetKey ?? \'\'}|col:${columnViewActive}`}',
    );
  });

  it('drops the pinned/hovered column thread along with hand-placed positions when the relation set changes', () => {
    const anchor = source.indexOf('const columnRelations = activeAiMetadata?.columnAspect;');
    expect(anchor, 'the relation set is declared once').toBeGreaterThan(-1);
    const end = source.indexOf('}, [columnRelations]);', anchor);
    expect(end, 'the relation-set effect closes over columnRelations').toBeGreaterThan(anchor);
    const effect = source.slice(anchor, end);
    for (const reset of ['setColumnPositions({});', 'setHoveredColumn(null);', 'setPinnedColumn(null);']) {
      expect(effect, `${reset} runs in the relation-set effect`).toContain(reset);
    }
  });

  for (const name of POSITION_CONSUMERS) {
    it(`${name} reads and depends on objectNodes(), never getNodes()`, () => {
      const body = callbackSource(name);
      expect(body, `${name} must read positions through objectNodes()`).toContain('objectNodes()');
      expect(body, `${name} must not read the mounted nodes directly`).not.toContain('getNodes()');
      const deps = body.slice(body.lastIndexOf('}, ['));
      expect(deps, `${name} lists objectNodes as a dependency`).toContain('objectNodes');
      expect(deps, `${name} no longer lists getNodes as a dependency`).not.toContain('getNodes');
    });
  }
});
