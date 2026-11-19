# Contributing

A free helper extension under the [MIT license](LICENSE), shared as-is. The repository is a clone-and-adapt project, not an active coding community, but bug reports and focused pull requests are welcome. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

- **Bugs:** open an [issue](https://github.com/ChrisDevRepo/vscode_data_lineage/issues) with the output of **Data Lineage: Copy Debug Info**. Leave credentials, customer SQL, `.dacpac` files and database content out of it.
- **Vulnerabilities:** follow [`SECURITY.md`](SECURITY.md); do not open a public issue.
- **Changes:** open an issue first for anything larger than a fix, then a pull request that passes `npm run gate`.

## Set up and build

You need [Git](https://git-scm.com/), [Node.js](https://nodejs.org/) 20+ with npm 10+ (`engines` in `package.json`), and [VS Code](https://code.visualstudio.com/) 1.101+. A VS Code chat model provider such as GitHub Copilot is optional, to try `@lineage`.

1. Clone the repository and run `npm ci` (not `npm install`, which can rewrite `package-lock.json`).
2. Open the folder in VS Code and press `F5` (**Run Extension**). It builds the extension and webview and opens the Extension Development Host.
3. In the host, run **Data Lineage: Open Demo**, or open a folder with a `.dacpac`.

No database, model provider or credentials are needed to build, run or pass `npm run gate`. Layout, packaging and diagnostics are in [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).

## Test

`npm run gate` is the complete pre-push check; it needs no database, model provider or display. The Gate workflow runs it on pull requests and on `testing*` pushes, so run it locally first. Test tiers, optional live checks and machine requirements: [`docs/testing/README.md`](docs/testing/README.md).

Parser changes (regexes in `assets/defaultParseRules.yaml`): run `npm run test:parser`, add a focused regression case, and review the resulting dependency edges against the affected SQL.

## Propose a change

- Change behavior in the layer that owns it ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#code-map)) and add a focused test, including failure and malformed-input paths.
- Strict TypeScript, ESM imports. Validate IPC and tool-call input with Zod. Log through `src/utils/log.ts` with a category tag. Document exported contracts with TSDoc that explains the why, not the types; comments carry no history or author markers.
- Keep the `.md` files true for what you changed, and list user-visible changes under `[Unreleased]` in `CHANGELOG.md`.
- Leave `package.json` and lockfile versions unchanged unless the change needs them. Every `overrides` entry in `package.json` is deliberate: `langsmith` points at the inert stub in `stubs/langsmith/` and stays; the others lift transitive packages past known advisories and go when their dependents do. Vendored source is registered in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

---

MIT License · [Christian Wagner](https://github.com/ChrisDevRepo/vscode_data_lineage)
