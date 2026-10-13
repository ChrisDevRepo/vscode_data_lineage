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

- `.dacpac` files are parsed offline. Object DDL is parsed, never executed.
- A live import runs catalog/DMV queries only when you start it. Built-in queries are read-only; custom DMV SQL is trusted local configuration and runs as written.
- Table statistics run row-count and aggregate `SELECT` queries only when you request them.
- Network access is limited to the database you configure, Microsoft Entra ID sign-in when you choose it, and the language model selected in VS Code for `@lineage`. The extension has no telemetry.
- `@lineage` sends your prompt, its chat history, and the lineage metadata or SQL its tools return to that model. It cannot connect to a database, run SQL, import or profile.
- Custom YAML (parse rules, DMV queries, AI templates) is trusted configuration; do not load files you have not reviewed. In an untrusted workspace, workspace values for these settings and `excludePatterns` are ignored.
- The webview's Content Security Policy blocks everything by default and allows only nonce-tagged scripts.
- AI trace logging is off by default. When enabled it writes prompts, responses, SQL and tool payloads to `tmp/lm-trace/` in the first workspace folder until the extension host restarts. **Dump AI State Machine** writes to `tmp/sm-dumps/`. Review these files and **Copy Debug Info** output before sharing.
- **Trust Server Certificate**, offered after a certificate error, disables certificate validation for that connection.
- Use a read-only database login for live imports.
