# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.9.x   | :white_check_mark: |

## Reporting a Vulnerability

**Do not** open a public GitHub issue for security vulnerabilities.

Report via [GitHub Security Advisories](../../security/advisories/new) or contact the maintainer via [LinkedIn](https://www.linkedin.com/in/christian-wagner-11aa8614b).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

## Security Notes

- The extension parses SQL but does not execute it
- Only reads .dacpac and .sql files — no write operations to user code
- No network access — operates entirely offline
- Strict Content Security Policy on the webview
- Custom YAML parse rules execute regex patterns — avoid loading untrusted rule files
