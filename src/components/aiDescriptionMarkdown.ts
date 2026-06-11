/**
 * Pre-processes AI markdown for detail overlay rendering.
 *
 * @remarks
 * Keep this pass non-destructive. Markdown math rendering is handled by
 * `remark-math` + `rehype-katex` in `AiDescriptionOverlay`.
 *
 * @param description - Description markdown to preprocess.
 *
 * @returns The markdown unchanged (pass-through until a transform is needed).
 */
export function preprocessDescriptionMarkdown(description: string): string {
  return description;
}
