# Security policy

Which versions get security fixes, how to report a vulnerability, and what the extension reads and sends.

## Supported versions

| Version | Supported |
|---|---|
| Latest release on the Visual Studio Marketplace | Yes |
| Earlier releases | No |

Security fixes are provided for the latest Marketplace release only. Upgrade to it before reporting a vulnerability.

## Report a vulnerability

**Do not** open a public GitHub issue for a vulnerability.

Report privately via [GitHub Security Advisories](https://github.com/ChrisDevRepo/vscode_data_lineage/security/advisories/new) or contact the maintainer via [LinkedIn](https://www.linkedin.com/in/christian-wagner-11aa8614b).

Include:

- Affected extension and VS Code versions
- Description of the vulnerability
- Steps to reproduce
- Potential impact

Do not include credentials or customer database content in the report.
Allow time for a fix to be released before disclosing the issue publicly.

## Security notes

### What is read and sent

- **DACPAC:** read locally; no connection is made. The SQL in it is parsed, never run.
- **Database import:** runs the catalog queries in [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md) only when you start an import. The built-in queries are read-only. Custom DMV SQL is trusted local configuration and runs as written, with `{{SCHEMAS}}` expanded in Phase 2 queries.
- **Table statistics:** runs row-count and aggregate `SELECT` queries on a table only when you request them, on a separate connection (`dataLineageViz.tableStatistics.enabled`). The generated SQL is in [`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md).
- **`@lineage` (optional):** sends the question, recent `@lineage` chat and the SQL or metadata it reads from the loaded model to the chat model selected in VS Code. It cannot connect to a database, run SQL, start an import or start profiling (`dataLineageViz.ai.enabled`).

The extension never executes object DDL and does not modify database objects or your source code.

### Connections

- Database connections use SQL login or Microsoft Entra ID.
- Connections declare read-only application intent and are encrypted by default. Entra ID connections cannot turn encryption off.
- **Trust Server Certificate** turns off certificate checks for that connection.
- Saved connections store no passwords; SQL login passwords are kept in VS Code secret storage.
- Use a read-only database login.

### Local files and logs

- Logs are local. Output-channel logs redact secrets.
- AI trace files (`tmp/lm-trace/`) and state dumps (`tmp/sm-dumps/`) are written to the first workspace folder only when you run their commands. AI trace logging lasts until the extension host restarts. Both contain database identifiers, SQL, prompts, responses and tool payloads; keep them out of version control and review them before sharing.
- **Copy Debug Info** can include project, source and schema names, filter and GUI state, database-model metadata and AI session metadata. Review and redact identifiers before sharing it.
- **Create Parse Rules**, **Create DMV Queries** and **Create AI Output Templates** write a fixed file name in the first workspace folder and open an existing file instead of overwriting it. Draw.io export writes only to the file you choose in the save dialog.

### Configuration and webview

- Custom YAML files (parse rules, DMV queries, AI output templates) and exclusion patterns are trusted local configuration; load only files you have reviewed.
- In an untrusted workspace (Restricted Mode), workspace values for `dataLineageViz.parseRulesFile`, `dataLineageViz.dmvQueriesFile`, `dataLineageViz.excludePatterns` and `dataLineageViz.ai.outputTemplateFile` are ignored until the workspace is trusted; user-level values still apply.
- The webview runs under a strict Content Security Policy.
