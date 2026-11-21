# Contributing

Bug reports are welcome. The project is MIT licensed, so you can also fork it and adapt it to your needs.

## Bug reports

Open an [issue](https://github.com/ChrisDevRepo/vscode_data_lineage/issues) with the output of **Data Lineage: Copy Debug Info**. It contains server, database and schema names; remove them if needed before pasting. Leave credentials, customer SQL, `.dacpac` files and database content out of it. Security issues go through [`SECURITY.md`](SECURITY.md), not a public issue.

## Fork, build and run

You need [Git](https://git-scm.com/), [Node.js](https://nodejs.org/) 20 or newer with npm 10 or newer, and [VS Code](https://code.visualstudio.com/) 1.101 or newer.

1. Fork and clone the repository, then run `npm ci`.
2. Open the folder in VS Code and press `F5` (**Run Extension**). It builds the extension and opens the Extension Development Host.
3. In the host, run **Data Lineage: Open Demo**, or open a folder with a `.dacpac`.

No database or credentials are needed to build and run. A VS Code chat model provider such as GitHub Copilot is only needed to try `@lineage`. The full setup, project layout and commands are in [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).

## Make a change

1. Create a branch in your fork.
2. Keep the change small and focused. A parse rule or DMV query change usually needs only a YAML edit plus a test: see [Common changes](docs/DEVELOPER_GUIDE.md#common-changes).
3. Add or update a test that fails without your change. Parser changes get a case in `tests/unit/parser/`.
4. Run `npm run gate` and fix what it reports. It type-checks, lints, runs the unit tests, builds and checks the package contents.
5. Update the documentation that describes the behaviour you changed, for example [`docs/PARSE_RULES.md`](docs/PARSE_RULES.md) or [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md).
6. Open a pull request. Say what changed and why, and how you checked it. The same `npm run gate` runs in CI on pull requests.

## Coding conventions

Follow the [coding conventions](docs/DEVELOPER_GUIDE.md#coding-conventions).

---

MIT License · [Christian Wagner](https://github.com/ChrisDevRepo/vscode_data_lineage)
