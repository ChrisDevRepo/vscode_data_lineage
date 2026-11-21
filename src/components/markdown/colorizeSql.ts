import * as monacoEditor from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/sql/register';
import { getMonacoTheme } from '../../detail/monacoTheme';

/** Attribute `renderAiMarkdown` puts on a SQL block not yet colored. */
const SQL_BLOCK_ATTRIBUTE = 'data-lang';

/**
 * Colors every SQL block under `root` that `renderAiMarkdown` marked, with the Monaco SQL tokenizer
 * the detail view uses and the current VS Code theme. A block is colored once: its mark is removed first.
 */
export async function colorizeSqlBlocks(root: ParentNode): Promise<void> {
  const theme = getMonacoTheme();
  const blocks = [...root.querySelectorAll<HTMLElement>(`code[${SQL_BLOCK_ATTRIBUTE}="sql"]`)];
  await Promise.all(blocks.map(block => {
    block.removeAttribute(SQL_BLOCK_ATTRIBUTE);
    return monacoEditor.editor.colorizeElement(block, { theme, mimeType: 'sql' });
  }));
}

/** Re-applies the current VS Code theme to colored SQL blocks after a theme change. */
export function applySqlTheme(): void {
  monacoEditor.editor.setTheme(getMonacoTheme());
}
