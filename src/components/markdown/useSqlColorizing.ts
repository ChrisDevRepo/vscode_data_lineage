import { useEffect, type RefObject } from 'react';

/**
 * Colors the SQL blocks `renderAiMarkdown` marked inside `ref`'s element. The Monaco tokenizer the
 * detail view already bundles is loaded only when a block exists, and a theme change re-applies
 * the theme. Re-runs when `html` changes (a new description, or one more streamed chat delta) or
 * `active` turns on, since a collapsed body is not mounted.
 */
export function useSqlColorizing(ref: RefObject<HTMLElement | null>, html: string, active = true): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root?.querySelector('code[data-lang="sql"]')) return;
    let observer: MutationObserver | undefined;
    let disposed = false;
    void import('./colorizeSql').then(({ colorizeSqlBlocks, applySqlTheme }) => {
      if (disposed) return;
      void colorizeSqlBlocks(root);
      observer = new MutationObserver(applySqlTheme);
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
    });
    return () => { disposed = true; observer?.disconnect(); };
  }, [ref, html, active]);
}
