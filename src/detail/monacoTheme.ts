/** Maps the VS Code theme kind of the webview body to a built-in Monaco theme. */
export function getMonacoTheme(): string {
  const kind = document.body.getAttribute('data-vscode-theme-kind');
  if (kind === 'vscode-high-contrast') return 'hc-black';
  if (kind === 'vscode-high-contrast-light') return 'hc-light';
  if (kind === 'vscode-dark') return 'vs-dark';
  return 'vs';
}
