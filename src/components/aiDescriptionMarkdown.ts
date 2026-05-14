/**
 * Pre-processes AI markdown for detail overlay rendering.
 *
 * @remarks
 * - Keeps display math (`$$...$$`) on the KaTeX path by converting it to ```math fences.
 * - Must remain non-destructive: never drop or rewrite business content.
 */
export function preprocessDescriptionMarkdown(description: string): string {
  return description.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_match, p1) => {
    return `\n\`\`\`math\n${p1.trim()}\n\`\`\`\n`;
  });
}
