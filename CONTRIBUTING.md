# Contributing

This project is published under the MIT license and maintained for personal use. Feature requests are not being accepted. You're welcome to fork and extend it.

Bug reports are welcome.

## Reporting bugs

1. Check [existing issues](../../issues) to avoid duplicates.
2. Use the **Bug Report** issue template.
3. Include: VS Code version, extension version, steps to reproduce, expected vs. actual behavior. For AI (`@lineage`) issues, attach the relevant `Data Lineage` output-channel log.

## Building from source

```bash
git clone https://github.com/ChrisDevRepo/vscode_data_lineage.git
cd vscode_data_lineage
npm install
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host.

| Command | Description |
|---|---|
| `npm run build` | Full build (extension + webview) |
| `npm run build:ext` | Extension host only |
| `npm run build:webview` | Vite webview only |
| `npm run watch` | Continuous watch (extension only) |
| `npx @vscode/vsce package` | Build a local `.vsix` |

## Pointers

- Test strategy → [`docs/TESTING.md`](docs/TESTING.md)
- Architecture deep dive → [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md)
- Doc index → [`docs/README.md`](docs/README.md)

## License

MIT. See [`LICENSE`](LICENSE).
