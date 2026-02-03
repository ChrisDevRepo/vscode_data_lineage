# Theming Guide

## How It Works

1. **Detection**: Extension reads `vscode.window.activeColorTheme.kind` and sets `data-vscode-theme-kind` on `<body>`
2. **Live updates**: `onDidChangeActiveColorTheme` posts `themeChanged` message to webview, which updates the body attribute without reload
3. **CSS variables**: All styling flows through `--ln-*` custom properties in `index.css`, which map to `--vscode-*` tokens

## CSS Variable Layers

```
VS Code theme tokens (--vscode-*)
  └─ Extension custom properties (--ln-*) in :root
       └─ Theme-specific overrides via body[data-vscode-theme-kind="..."]
```

### Key custom properties

| Variable | Maps to |
|----------|---------|
| `--ln-bg` | `--vscode-editor-background` |
| `--ln-fg` | `--vscode-editor-foreground` |
| `--ln-border` | `--vscode-panel-border` |
| `--ln-input-bg` | `--vscode-input-background` |
| `--ln-button-bg` | `--vscode-button-background` |
| `--ln-focus-border` | `--vscode-focusBorder` |
| `--ln-hover-bg` | `--vscode-list-hoverBackground` |

### Theme-specific overrides

- **Dark**: Stronger shadows, lighter hover (`rgba(255,255,255,0.08)`)
- **High contrast**: Uses `--vscode-contrastBorder` for borders, thicker outlines

## Fixed Type Colors

Node type colors are intentionally fixed across all themes for quick recognition:

| Type | Color | Hex |
|------|-------|-----|
| Table | Blue | `#3b82f6` |
| View | Green | `#22c55e` |
| Procedure | Yellow | `#eab308` |
| Function | Orange | `#f97316` |
| External | Purple | `#9333ea` |

Schema colors use deterministic hashing (Tableau 10 palette) — never hardcode.

## Rules

1. Use `var(--ln-*)` or `var(--vscode-*)` — never hardcode colors
2. Always provide fallback values: `var(--vscode-editor-background, #ffffff)`
3. Test with Light+, Dark+, High Contrast Dark, and High Contrast Light
4. High contrast themes must have explicit `--vscode-contrastBorder` borders

## Reference

- [VS Code Theme Color Reference](https://code.visualstudio.com/api/references/theme-color)
