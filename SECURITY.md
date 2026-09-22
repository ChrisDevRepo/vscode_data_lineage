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

- The extension parses SQL object definitions but does not execute object DDL
- `.dacpac` parsing is fully offline
- Live database import runs configured catalog / DMV queries through the MSSQL
  extension connection API only when the user starts an import. Built-in
  queries are read-only; custom DMV SQL is trusted local configuration and is
  executed as configured (with `{{SCHEMAS}}` expansion for Phase 2)
- Table profiling runs row-count and aggregate `SELECT` queries only after an explicit profiling click
- YAML scaffolding commands write fixed filenames in the first workspace root
  and preserve existing files. Draw.io export uses a save dialog. Import does
  not modify database objects or user source code
- Strict Content Security Policy on the webview
- Custom YAML DMV queries, AI templates, and parse-rule regexes are trusted local configuration; avoid loading untrusted YAML files
- `@lineage` uses the model selected in VS Code. When invoked, the selected
  model receives the user's prompt, native `@lineage` chat history, and lineage
  metadata or DDL returned by local snapshot tools. The AI runtime cannot
  connect to a database, execute SQL, start an import, or start profiling
- AI trace logging is disabled by default. Enabling it for a session requires an
  open workspace folder and writes full model and tool diagnostics to
  `tmp/lm-trace/` inside the first workspace folder; the writer is disabled again
  when the extension host restarts. These files can contain database identifiers,
  SQL, prompts, responses, and tool payloads; keep them out of version control and
  review them before sharing
- **Copy Debug Info** can include project/source/schema names, filter state, GUI
  state, database-model metadata, and AI session metadata. Review and redact
  identifiers before sharing it
