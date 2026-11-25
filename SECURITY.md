# Security Policy

## Supported Versions

Security fixes are provided for the latest version published to the Visual
Studio Marketplace. Earlier versions are unsupported; upgrade to the latest
release before reporting a vulnerability.

## Reporting a Vulnerability

**Do not** open a public GitHub issue for security vulnerabilities.

Report via [GitHub Security Advisories](https://github.com/ChrisDevRepo/vscode_data_lineage/security/advisories/new) or contact the maintainer via [LinkedIn](https://www.linkedin.com/in/christian-wagner-11aa8614b).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

## Security Notes

### Read, run and sent

- **DACPAC:** read locally, with no database connection. The SQL in it is parsed, not run.
- **Database import:** runs the catalog queries listed in [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md), only when the user starts an import. The built-in queries are read-only. A custom DMV queries file runs as written, with the permissions of the connection; use a read-only login.
- **Table statistics:** on demand. Runs a row-count query and an aggregate `SELECT` for one table, only when the user requests statistics for it, on a separate connection ([`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md)). `dataLineageViz.tableStatistics.enabled` is on by default and can be turned off. The results include real values (minimum and maximum of numbers and dates, string lengths). They are shown in the detail panel only; they are not stored, not logged (only the row count is) and not sent to an AI model.
- **AI chat panel:** sends the user's prompt, the recent chat history (user and assistant text), and the SQL or lineage metadata the lineage tools read from the loaded model to the model in use: a language model VS Code provides, or the endpoint of the `dataLineageViz.ai.models` entry, with its API key from VS Code secret storage. It cannot connect to a database, run SQL, or start an import or profiling. `dataLineageViz.ai.enabled` turns the chat panel off (reload the window).
- **Telemetry:** the extension has none and sends nothing to the author. The `langsmith` dependency is replaced by an inert local stub.
- **Writes:** the YAML scaffolding commands write fixed filenames in the first workspace folder and keep existing files. Draw.io export uses a save dialog. Saved connections and the **Trust Server Certificate** choice are written to the user `settings.json`. Trace and dump folders under `tmp/` get a `.gitignore` containing `*`. Projects, bookmarks and saved AI findings are kept in VS Code global state, which the extension does not sync or encrypt. A relative path in `parseRulesFile`, `dmvQueriesFile` or `ai.outputTemplateFile` is rewritten as an absolute path in the settings file that holds it. Nothing changes database objects or the user's source code.

### Connections

- Connections use the built-in `tedious` provider, with SQL login or Microsoft Entra ID. Windows authentication is not supported.
- Connections are encrypted by default. They declare `ApplicationIntent=ReadOnly`, a routing hint for availability-group and read scale-out setups that does not block writes; use a login with read permissions only. Sessions report the application name `Data Lineage Viz`.
- Entra sign-in uses the VS Code Microsoft account. Listing the directories of that account calls Azure Resource Manager with that account's token.
- **Trust Server Certificate** turns off certificate validation for that connection. It is set by the **Trust Server Certificate** button on a certificate error or by the `trustServerCertificate` connection property. The choice is saved with the connection in the user settings and cleared when the server or port of the connection is edited.
- Passwords are kept in VS Code secret storage, not in the saved connection settings.

### Local files and configuration

- Credential-shaped text is removed from log lines.
- AI trace logging is off by default. **Enable AI Trace Logging for This Session** writes model and tool diagnostics to `tmp/lm-trace/` in the first workspace folder until the extension host restarts. **Dump AI State Machine** writes to `tmp/sm-dumps/`. **Copy Debug Info** copies to the clipboard.
- These outputs can contain database and schema names, SQL, prompts and responses. Review them before sharing and keep them out of version control.
- Custom YAML files (parse rules, DMV queries, AI templates) are trusted local configuration. Do not load untrusted YAML. In an untrusted workspace (Restricted Mode), workspace values of `dataLineageViz.parseRulesFile`, `dmvQueriesFile`, `excludePatterns` and `ai.outputTemplateFile` are ignored until the workspace is trusted; user-level values still apply.
- The webview cannot make network requests; scripts load only from the extension.
