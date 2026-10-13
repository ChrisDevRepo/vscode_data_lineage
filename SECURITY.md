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

- `.dacpac` files are read locally; the SQL in them is never run.
- The extension connects only to your database and, if you use it, Microsoft Entra ID sign-in.
- Built-in database queries are read-only and run only when you start an import or profiling. Custom DMV SQL runs as you wrote it.
- `@lineage` sends your question, recent chat and the SQL or metadata it reads to the model you picked in VS Code chat. It cannot connect to a database or run SQL.
- Logs stay local. AI trace files (`tmp/lm-trace/`) and state dumps (`tmp/sm-dumps/`) are written only when you run their commands. They contain SQL; check them before sharing.
- Custom YAML files run as trusted configuration; load only files you have reviewed. Untrusted workspaces ignore them.
- **Trust Server Certificate** turns off certificate checks for that connection.
- Use a read-only database login.
