# Vendored assistant-ui registry source

Everything in this directory except this file and `components/assistant-ui/elements/markdown-text.tsx`
is registry source exactly as the shadcn CLI wrote it. Do not edit those files; change the owned file,
the chat theme region of `src/index.css` or the ChatPane instead, and re-pull to update.

| | |
|---|---|
| Registry | `https://r.assistant-ui.com/<item>.json` (live registry) |
| Items requested | `thread`, `markdown-text`, `model-selector`, `follow-up-suggestions`, `reasoning`, `tool-fallback`, `tool-group`, `tooltip-icon-button`, `utils` (the CLI adds their registry dependencies: attachment, file, image, surfaces, href, collapsible-root, media-player, and the shadcn `button`, `skeleton`, `textarea`, `tooltip`, `dialog`, `avatar`, `command`, `popover`) |
| Fetched | 2026-11-24 |
| CLI | `shadcn@4.23.0` (npm, published 2026-10-27), pinned in the command below |
| Runtime version | `@assistant-ui/react` 0.15.38 (the registry's `dependencies` asks `^0.15.38`) |
| Config | `components.json` at the repository root; `@/*` maps to this directory through `tsconfig.json` `paths` (Vite and Vitest read it with `resolve.tsconfigPaths`) |

## Files

The vendored files, all written by the CLI unless named under "Owned and removed files":

- `components/assistant-ui/elements/attachment-state.ts`
- `components/assistant-ui/elements/attachment.aui.tsx`
- `components/assistant-ui/elements/collapsible-root.tsx`
- `components/assistant-ui/elements/file.tsx`
- `components/assistant-ui/elements/follow-up-suggestions.aui.tsx`
- `components/assistant-ui/elements/image.tsx`
- `components/assistant-ui/elements/markdown-text.tsx`
- `components/assistant-ui/elements/media-player.tsx`
- `components/assistant-ui/elements/model-selector.aui.tsx`
- `components/assistant-ui/elements/model-selector.tsx`
- `components/assistant-ui/elements/reasoning.aui.tsx`
- `components/assistant-ui/elements/reasoning.tsx`
- `components/assistant-ui/elements/surfaces.tsx`
- `components/assistant-ui/elements/thread.aui.tsx`
- `components/assistant-ui/elements/tool-fallback.aui.tsx`
- `components/assistant-ui/elements/tool-group.aui.tsx`
- `components/assistant-ui/elements/tooltip-icon-button.tsx`
- `components/assistant-ui/utils/href.ts`
- `components/assistant-ui/utils/model-selection.ts`
- `components/assistant-ui/utils/useIsomorphicLayoutEffect.ts`
- `components/ui/avatar.tsx`
- `components/ui/button.tsx`
- `components/ui/command.tsx`
- `components/ui/dialog.tsx`
- `components/ui/popover.tsx`
- `components/ui/skeleton.tsx`
- `components/ui/textarea.tsx`
- `components/ui/tooltip.tsx`
- `hooks/use-attachment-src.ts`
- `lib/utils.ts`

## Owned and removed files

The app has one markdown and KaTeX rendering path (`src/components/markdown/renderAiMarkdown.ts`, as the AI report overlay uses), so:

- **Owned: `components/assistant-ui/elements/markdown-text.tsx`.** Replaced, not edited. The registry's version renders through `react-markdown`, `remark-gfm` and `@assistant-ui/react-markdown`, none of which is installed. Ours renders the part text with `renderAiMarkdown` (marked, `markedKatexExtension`, `alignSqlExcerpt`, DOMPurify), colors SQL blocks as the overlay does, and reuses the `.ln-ai-description-md` CSS. The Thread imports it at the same path and name (`MarkdownText`).
- **Not vendored:** the `syntax-highlighter` item and `hooks/use-copy-to-clipboard.ts`. The first is not imported by anything else; the second was imported only by the registry's markdown-text. Both are deleted after the pull.
- **Moved:** the CLI writes the `utils` item (`lib/utils.ts`, which re-exports `cn` from the `cn` package) to `src/lib/utils.ts`, because the item carries `target: "lib/utils.ts"`. It is moved to `vendor/lib/utils.ts`, where the `@/lib/utils` import resolves.
- **Not installed:** `tw-shimmer`. The items declare `@import "tw-shimmer"`, a CSS-only package whose effect hard-codes colours; the chat theme in `src/index.css` leaves it out, so the library's `shimmer` class is a no-op.

## Re-pull

1. Create an empty scratch directory outside the repository with a `package.json` (any name, `react` and `tailwindcss` dependencies), the repository's `components.json`, and a `tsconfig.json` with `"paths": { "@/*": ["./src/components/chat/vendor/*"] }` plus an empty `src/index.css` containing `@import "tailwindcss";`.
2. `npm_config_ignore_scripts=true npx --yes shadcn@4.23.0 add -y https://r.assistant-ui.com/{thread,markdown-text,model-selector,follow-up-suggestions,reasoning,tool-fallback,tool-group,tooltip-icon-button,utils}.json` (use the new pinned CLI version when updating it, and record it above).
3. Copy the scratch `src/components/chat/vendor/` over this directory; move the scratch `src/lib/utils.ts` to `lib/utils.ts`. Delete `components/assistant-ui/elements/syntax-highlighter.tsx` and `hooks/use-copy-to-clipboard.ts`. Restore the owned `markdown-text.tsx` (`git checkout` it).
4. `git diff` now shows upstream changes only. Update `@assistant-ui/react` and the other dependencies the new files import to the exact versions in `package.json` (no `--before` pin; latest stable), and the version rows above.
5. `npm run build`, `npm run typecheck`, `npm run lint`, `npm run knip`, `npm run deps:audit`; run `node scripts/generate-third-party-notices.mjs`.

## Dependencies the vendored files import

`@assistant-ui/react`, `class-variance-authority`, `cmdk`, `cn`, `lucide-react`, `radix-ui` (1.8.1) and `zustand` (5.1.0, imported by `hooks/use-attachment-src.ts` without being a declared dependency of the item), all exact in `package.json`. `tw-animate-css` (dev) supplies the `animate-in`/`animate-out` utilities (imported in `src/index.css`).
