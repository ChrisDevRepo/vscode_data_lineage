/**
 * Pre-processes AI markdown for detail overlay rendering.
 *
 * @remarks
 * Keep this pass non-destructive. Markdown math rendering is handled by
 * `remark-math` + `rehype-katex` in `AiDescriptionOverlay`.
 */
export function preprocessDescriptionMarkdown(description: string): string {
  return description;
}
