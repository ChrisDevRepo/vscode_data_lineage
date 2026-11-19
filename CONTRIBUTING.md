# Contributing

Bug reports are welcome. The project is MIT licensed, so you can also fork it and adapt it to your needs.

## Bug reports

Open an [issue](https://github.com/ChrisDevRepo/vscode_data_lineage/issues) with the output of **Data Lineage: Copy Debug Info**. It contains server, database and schema names; remove them if needed before pasting. Leave credentials, customer SQL, `.dacpac` files and database content out of it. Security issues go through [`SECURITY.md`](SECURITY.md), not a public issue.

## Fork, build and run

You need [Git](https://git-scm.com/), [Node.js](https://nodejs.org/) 20 or newer with npm 10 or newer, and [VS Code](https://code.visualstudio.com/) 1.101 or newer.

1. Fork and clone the repository, then run `npm ci`.
2. Open the folder in VS Code and press `F5` (**Run Extension**). It builds the extension and opens the Extension Development Host.
3. In the host, run **Data Lineage: Open Demo**, or open a folder with a `.dacpac`.

No database or credentials are needed to build and run. A VS Code chat model provider such as GitHub Copilot is only needed to try `@lineage`. Build and packaging are described in [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).

---

MIT License · [Christian Wagner](https://github.com/ChrisDevRepo/vscode_data_lineage)
