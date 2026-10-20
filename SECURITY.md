# Security

A free helper extension under the MIT license, shared as-is. This page lists what it reads, runs and sends.

## What is read and sent

- **DACPAC:** read locally, with no database connection. The SQL in it is parsed, never run.
- **Database import:** runs the read-only catalog queries in [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md), and only when you start an import.
  - Custom DMV SQL is your own configuration and runs as written, with your permissions. Use a read-only login.
- **Table statistics:** runs row-count and aggregate `SELECT` queries only when you request them, on a separate connection ([`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md); `dataLineageViz.tableStatistics.enabled`).
- **`@lineage` (optional):** sends your question, recent `@lineage` chat, and the SQL or metadata it reads from the loaded model to the chat model you selected in VS Code.
  - It cannot connect to a database, run SQL, or start an import or profiling.
  - `dataLineageViz.ai.enabled: false` turns it off.
- **No telemetry:** the extension sends nothing to the author and has no external tracing.

## Connections

- SQL login or Microsoft Entra ID, with read-only application intent, encrypted by default.
- **Trust Server Certificate** turns off certificate checks.
- Passwords are kept in VS Code secret storage, never in saved connections.

## Local files

- Logs stay local, and secrets are redacted.
- These files are written to the first workspace folder, only when you run their command:
  - AI traces (`tmp/lm-trace/`) and state dumps (`tmp/sm-dumps/`);
  - **Copy Debug Info** output.
- They can contain database names, SQL and prompts. Review them before sharing, and keep them out of version control.
- Custom YAML files (parse rules, DMV queries, AI templates) are trusted configuration. In Restricted Mode, workspace values for them are ignored.
- The webview runs under a strict Content Security Policy.
