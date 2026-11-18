# Security Policy

A free helper extension under the [MIT license](LICENSE), shared as-is. This page covers how to report a vulnerability, and what the extension reads, runs and sends.

## Supported Versions

Security fixes are provided for the latest version published to the Visual Studio Marketplace. Earlier versions are unsupported; upgrade to the latest release before reporting a vulnerability.

## Reporting a Vulnerability

**Do not** open a public GitHub issue for security vulnerabilities.

Report via [GitHub Security Advisories](https://github.com/ChrisDevRepo/vscode_data_lineage/security/advisories/new) or contact the maintainer via [LinkedIn](https://www.linkedin.com/in/christian-wagner-11aa8614b).

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact

## What is read and sent

- **DACPAC:** read locally with no database connection. The SQL in it is parsed, never run.
- **Database import:** runs the read-only catalog queries in [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md), only when you start an import. Custom DMV SQL is your own configuration and runs as written, with your permissions; use a read-only login.
- **Table statistics:** runs row-count and aggregate `SELECT` queries only when you request them for a table, on a separate connection ([`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md); `dataLineageViz.tableStatistics.enabled`).
- **`@lineage` (optional):** sends your question, recent `@lineage` chat, and the SQL or metadata its tools read from the loaded model to the chat model you selected in VS Code. It cannot connect to a database, run SQL, or start an import or profiling. `dataLineageViz.ai.enabled: false` turns it off.
- **No telemetry:** the extension sends nothing to the author and has no external tracing; LangSmith is replaced by an inert local stub.
- The YAML scaffolding commands write fixed filenames in the first workspace folder and keep existing files. Draw.io export uses a save dialog. Nothing modifies database objects or your source code.

## Connections

- SQL login or Microsoft Entra ID, with read-only application intent, encrypted by default.
- **Trust Server Certificate** turns off certificate checks for that connection. Only your own choice sets it: the button on a certificate error, or the setting. Editing the connection's server or port turns it off again.
- Passwords are kept in VS Code secret storage, never in saved connections.

## Local files

- Logs stay local. Credentials are removed from every log line and notification; info, warning and error lines omit file paths and object names, which appear at debug level.
- AI trace logging is off by default. **Enable AI Trace Logging for This Session** writes full model and tool diagnostics to `tmp/lm-trace/` in the first workspace folder until the extension host restarts. **Dump AI State Machine** writes `tmp/sm-dumps/`. **Copy Debug Info** goes to the clipboard.
- Those outputs can contain database and schema names, SQL, prompts and responses. Review them before sharing and keep them out of version control.
- Custom YAML files (parse rules, DMV queries, AI templates) are trusted configuration; avoid loading untrusted YAML. In an untrusted workspace (Restricted Mode), workspace values for `dataLineageViz.parseRulesFile`, `dmvQueriesFile`, `excludePatterns` and `ai.outputTemplateFile` are ignored until the workspace is trusted; user-level values still apply.
- The webview runs under a strict Content Security Policy.
