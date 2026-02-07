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

Press **F5** in VS Code to launch the Extension Development Host.

| Command | Description |
|---------|-------------|
| `npm run build` | Build extension + webview |
| `npm run watch` | Watch mode (extension only) |
| `npm test` | Run engine tests |

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
