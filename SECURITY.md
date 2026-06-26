# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.2   | :white_check_mark: |
| < 1.0.2 | :x:                |

## Reporting a Vulnerability

**Do not** open a public GitHub issue for security vulnerabilities.

Report via [GitHub Security Advisories](https://github.com/ChrisDevRepo/vscode_data_lineage/security/advisories/new) or contact the maintainer via [LinkedIn](https://www.linkedin.com/in/christian-wagner-11aa8614b).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

## Security Notes

- The extension parses SQL object definitions but does not execute object DDL
- `.dacpac` parsing is fully offline
- Live database import runs configured catalog / DMV read queries through the MSSQL extension connection API only when the user starts an import
- Table profiling runs row-count and aggregate `SELECT` queries only after an explicit profiling click
- Scaffolding and export commands write only user-selected local files; import does not modify database objects or user source code
- Strict Content Security Policy on the webview
- Custom YAML DMV queries, AI templates, and parse-rule regexes are trusted local configuration; avoid loading untrusted YAML files
