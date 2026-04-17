# Contributing

Bug reports are welcome. Feature requests are not being accepted — this project is maintained for personal use. You're welcome to fork and extend it under the MIT license.

## Reporting Bugs

1. Check [existing issues](../../issues) to avoid duplicates
2. Use the **Bug Report** issue template
3. Include: VS Code version, extension version, steps to reproduce, and expected vs actual behavior

## Submitting a Fix

1. Fork the repository
2. Create a branch: `fix/short-description`
3. Make your change
4. Run tests: `npm test`
5. Build: `npm run build`
6. Open a pull request against `main`

## Development Setup

```bash
git clone https://github.com/ChrisDevRepo/vscode_data_lineage.git
cd vscode_data_lineage
npm install
npm run build
```

Press **F5** in VS Code to launch the **Extension Development Host**. For detailed architectural context, see the [Architecture Overview](docs/AI_ARCHITECTURE.md) and [Internal Developer Guide](docs-internal/DEVELOPER_GUIDE.md).

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Full build (extension + webview) |
| `npm run build:ext` | Fast build (extension host only) |
| `npm run build:webview` | Fast build (Vite webview only) |
| `npm run watch` | Continuous watch mode (extension only) |

### Testing Tiers

| Tier | Folder | Command | Description |
| :--- | :--- | :--- | :--- |
| **Logic** | `tests/unit/` | `npm run test:unit` | Fast Node.js unit tests for parsing, graph, and stores. |
| **Hooks** | `tests/unit/hooks/` | `npm run test:hooks` | React hook behavior tests via Vitest. |
| **Sanity** | `tests/` | `npm run test:sanity` | Verifies the bundled `out/extension.js` can be loaded. |
| **E2E** | `tests/e2e/` | `npm run test:vscode` | Full VS Code integration tests (launches host). |

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
