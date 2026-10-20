# Building from source

A free helper extension for VS Code under the [MIT license](LICENSE), shared as-is. Clone it, build it, and adapt it. To see what it does with your data, read [`SECURITY.md`](SECURITY.md), [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md), [`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md) and [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md).

Bugs go to [issues](https://github.com/ChrisDevRepo/vscode_data_lineage/issues). Leave credentials, customer SQL, `.dacpac` files and database content out of them.

## Setup

You need [Git](https://git-scm.com/), [Node.js](https://nodejs.org/) 20+ with npm 10+, and [VS Code](https://code.visualstudio.com/) 1.101+. A chat model provider such as GitHub Copilot is optional, to try `@lineage`.

1. Clone the repository and run `npm ci`.
2. Open the folder in VS Code and press `F5` to launch the Extension Development Host.
3. Run **Data Lineage: Open Wizard** and click **Try with demo data**, or **+ Create New Project** to open a `.dacpac`.

| Command | Purpose |
|---|---|
| `npm run build` | Build the extension and webview |
| `npm run typecheck` | Type-check (there is no lint script) |
| `npm test` | Parser, lineage and AI contract tests |
| `npm run gate` | Core/runtime checks, coverage floors, build and repository checks; support tests are separate |
| `npm run package` | Create the VSIX |

None of these need a database, model provider or credentials. Test tiers are in [`docs/testing/README.md`](docs/testing/README.md); code layout is in [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).

## Changing the code

- Change behavior in the layer that owns it and add a focused test when the contract changes.
- Keep the `.md` files true for what you changed.
- Run `npm run gate` before you treat a code change as ready. It does not call a model provider.
- Entries in `package.json` `overrides` are deliberate security pins plus the `langsmith` stub in `stubs/langsmith/`.
