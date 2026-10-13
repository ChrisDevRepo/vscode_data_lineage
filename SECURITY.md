# Security policy

Which versions get security fixes, how to report a vulnerability, and what the extension reads and sends.

## Supported versions

| Version | Supported |
|---|---|
| Latest release on the Visual Studio Marketplace | Yes |
| Earlier releases | No |

Upgrade to the latest release before reporting a vulnerability.

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

- **DACPAC:** read locally; the SQL in it is never run.
- **Database import:** runs the catalog queries in [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md) when you start an import. The built-in queries are read-only; custom DMV SQL runs as written.
- **Table statistics:** runs row-count and aggregate `SELECT` queries on a table when you request them (`dataLineageViz.tableStatistics.enabled`).
- **`@lineage` (optional):** sends the question, recent chat and the SQL or metadata it reads to the chat model selected in VS Code. It cannot connect to a database or run SQL (`dataLineageViz.ai.enabled`).
- The extension connects only to your database, with SQL login or Microsoft Entra ID; Entra ID sign-in also contacts Microsoft.
- Logs are local. AI trace files (`tmp/lm-trace/`) and state dumps (`tmp/sm-dumps/`) are written only when you run their commands. They contain SQL; check them before sharing.
- Custom YAML files run as trusted configuration; load only files you have reviewed. Untrusted workspaces ignore them.
- **Trust Server Certificate** turns off certificate checks for that connection.
- Use a read-only database login.
