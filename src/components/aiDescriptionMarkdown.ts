/**
 * Pre-processes AI markdown for detail overlay rendering.
 *
 * @remarks
 * - Keeps display math (`$$...$$`) on the KaTeX path by converting it to ```math fences.
 * - Escapes inline `$...$` snippets so currency-like text such as `$0$` stays literal text.
 */
export function preprocessDescriptionMarkdown(description: string): string {
  const withMathFences = description.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_match, p1) => {
    return `\n\`\`\`math\n${p1.trim()}\n\`\`\`\n`;
  });
  return withMathFences.replace(/(^|[^$])\$([^$\n]+)\$(?!\$)/g, (_m, pfx: string, inner: string) => {
    return `${pfx}\\$${inner}\\$`;
  });
}
