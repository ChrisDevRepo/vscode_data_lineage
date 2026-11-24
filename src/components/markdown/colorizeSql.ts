import * as monacoEditor from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/sql/register';
import { getMonacoTheme } from '../../detail/monacoTheme';

/**
 * The colour a token role has in the chat's SQL theme: a placeholder that only names the role.
 * The webview's stylesheet (`index.css`, "SQL token roles") paints each role from the app's theme
 * tokens, so no colour of Monaco's bundled themes reaches the screen. Each is distinct, so Monaco
 * gives each role its own `mtkN` class.
 */
const ROLE_COLOURS = {
  text: '#010101',
  keyword: '#020202',
  operator: '#030303',
  function: '#040404',
  string: '#050505',
  number: '#060606',
  comment: '#070707',
} as const;

/** The built-in Monaco theme each VS Code theme kind starts from, mapped to its SQL theme. */
const SQL_THEMES = {
  vs: 'ln-sql-vs',
  'vs-dark': 'ln-sql-vs-dark',
  'hc-black': 'ln-sql-hc-black',
  'hc-light': 'ln-sql-hc-light',
} as const;

let defined = false;

/** The SQL theme of the current VS Code theme kind, defined with Monaco on first use. */
function sqlTheme(): string {
  if (!defined) {
    defined = true;
    for (const [base, name] of Object.entries(SQL_THEMES) as [keyof typeof SQL_THEMES, string][]) {
      monacoEditor.editor.defineTheme(name, {
        base, inherit: false, colors: {},
        rules: [
          { token: '', foreground: ROLE_COLOURS.text },
          { token: 'keyword', foreground: ROLE_COLOURS.keyword },
          { token: 'operator', foreground: ROLE_COLOURS.operator },
          { token: 'predefined', foreground: ROLE_COLOURS.function },
          { token: 'string', foreground: ROLE_COLOURS.string },
          { token: 'number', foreground: ROLE_COLOURS.number },
          { token: 'comment', foreground: ROLE_COLOURS.comment, fontStyle: 'italic' },
        ],
      });
    }
  }
  return SQL_THEMES[getMonacoTheme() as keyof typeof SQL_THEMES];
}

/** Attribute `renderAiMarkdown` puts on a SQL block not yet colored. */
const SQL_BLOCK_ATTRIBUTE = 'data-lang';

/**
 * Colors every SQL block under `root` that `renderAiMarkdown` marked, with the Monaco SQL tokenizer
 * the detail view uses and the current VS Code theme. A block is colored once: its mark is removed first.
 */
export async function colorizeSqlBlocks(root: ParentNode): Promise<void> {
  const theme = sqlTheme();
  const blocks = [...root.querySelectorAll<HTMLElement>(`code[${SQL_BLOCK_ATTRIBUTE}="sql"]`)];
  await Promise.all(blocks.map(block => {
    block.removeAttribute(SQL_BLOCK_ATTRIBUTE);
    return monacoEditor.editor.colorizeElement(block, { theme, mimeType: 'sql' });
  }));
}

/** Re-applies the current VS Code theme to colored SQL blocks after a theme change. */
export function applySqlTheme(): void {
  monacoEditor.editor.setTheme(sqlTheme());
}
