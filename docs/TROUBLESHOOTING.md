# Troubleshooting

Common problems and how to resolve them. For feature behavior, see [`FEATURES.md`](FEATURES.md); for database-connection setup, see [`DMV_QUERIES.md`](DMV_QUERIES.md).

---

## Import and connection

### A `.dacpac` file won't load

- **File locked by another process.** Close Visual Studio / SSDT / Azure Data Studio and retry.
- **Unsupported format.** Only SSDT-style and SDK-style `.dacpac` archives are supported. Extracts that were manually edited or created by third-party tools may fail.
- **Non-SQL-Server target.** The parser supports SQL Server, Azure SQL, Fabric Data Warehouse, and Synapse Dedicated SQL Pool. Other engines are out of scope.

### Database connection fails

1. Install the official [SQL Server (mssql) extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql). `@lineage` reuses its connection profile.
2. The database account needs `db_owner` on the target database and `GRANT VIEW SERVER STATE` at the server level — DMV queries read `sys.sql_expression_dependencies` which requires it.
3. On a local SQL Server instance: TCP/IP must be enabled and Mixed Mode authentication turned on.
4. Cross-database and cross-server references resolve only when the SQL body uses **schema-qualified names**. Unqualified references (`SELECT * FROM SomeTable`) are silently excluded — this is an intentional correctness constraint, not a bug.

### "DMV query timed out"

Raise `dataLineageViz.dmvQueryTimeout` (default 60 s) if the database has tens of thousands of objects. The timeout applies per DMV; the wizard runs several.

### Custom DMV or parse rules rejected

- Validate the YAML structure against the built-in files (`assets/dmvQueries.yaml`, `assets/defaultParseRules.yaml`) — same top-level keys, same per-query column contract.
- See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md) for the full reference.
- If a custom parse rule file causes unexpected diffs, run `npm run test:snapshot` locally (see [`TESTING.md`](TESTING.md)) before relying on the output.

---

## Graph and webview

### Graph is blank or stuck

1. Open the Developer Tools on the webview: *Command Palette → Developer: Open Webview Developer Tools*. Check the console for errors.
2. Reload the window: *Command Palette → Developer: Reload Window*.
3. If the graph consistently fails on one project, delete `.cache/` under your user profile (it is rebuilt automatically) and try again.

### "Node limit reached" warnings

The extension caps rendered graphs at `dataLineageViz.maxNodes` (default 750) and the React Flow renderer at `dataLineageViz.renderLimit` (default 750). Options:

- Turn on **Schema Overview Mode** (command: *Data Lineage: Toggle Schema Overview Mode*) — auto-fires when the graph exceeds `dataLineageViz.overview.threshold` (default 150) nodes. Double-click a schema to drill in.
- Narrow the selection at import time (fewer schemas, exclusion patterns).
- Raise `dataLineageViz.maxNodes` — performance degrades past ~5000 nodes.

### Overview mode won't toggle

- Confirm `dataLineageViz.overview.enabled` is `true`.
- The toggle has no effect below the threshold (`dataLineageViz.overview.threshold`, default 150). Raise the threshold to 1 to force it on a small graph for inspection.

### Theme colors look wrong

- Reload after changing a VS Code theme (`Developer: Reload Window`). The extension listens for `onDidChangeActiveColorTheme` but some webview CSS variables are resolved at mount time.
- High-contrast themes use `--vscode-contrastBorder`; if borders are missing, the theme may have overridden that token.

---

## `@lineage` (AI chat participant)

### `@lineage` doesn't respond

1. Install and sign in to [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) — `@lineage` is a VS Code Chat Participant and delegates every LLM call to Copilot's model.
2. Open or import a lineage graph first. Without a loaded model the tools refuse to register.
3. Confirm VS Code is at **1.95 or newer**. Older releases don't expose the Chat Participant API.

### "Scope exceeds budget" error

The exploration would use more hops than `dataLineageViz.ai.maxRounds` allows (default 50). Either:

- Narrow the question (smaller origin, fewer schemas, lower depth).
- Raise `dataLineageViz.ai.maxRounds` and re-run.
- Accept the `safe_depth_hint` the engine suggests.

### "Confirm SM start" gate keeps firing

This is intentional. Sliding-memory mode asks once per exploration before burning hops. Click *Approve* to run, or *Decline* to narrow. If you expect inline mode, the scope is above the inline thresholds (`dataLineageViz.ai.inlineNodeCap`, `dataLineageViz.ai.inlineTokenBudget`) — narrow the question.

### Exploration ends with "Unanswered (out of approved scope)"

Deliberate. Sliding-memory sessions lock the approved border at confirmation time. Any route that leaves it is collected as a follow-up question. Click the *Show deferred questions* button below the report to prefill those questions back into the chat and re-run.

### Hop limit hit ("Exploration incomplete — N rounds pending")

The session drained the hop cap without completing. The partial archive is discarded by design — missing nodes can invert a lineage picture. The message lists concrete narrowing options. If you need the full picture at the current scope, raise `dataLineageViz.ai.maxRounds` and re-run.

### Tool-invocation noise in chat

Toggle `dataLineageViz.ai.showToolInvocations` off (default: on). This stops the chat surface from rendering per-tool confirmation blocks; the exploration still runs.

---

## Export

### Draw.io export looks wrong

- Node positions in `.drawio` files mirror the current webview layout. Re-layout (`L` key / layout button) before exporting if you want a cleaner diagram.
- Edge styling follows the React-Flow edge type — if you've changed `dataLineageViz.layout.edgeStyle`, the export reflects that.

### Profiling fails or returns partial results

- Confirm `dataLineageViz.tableStatistics.enabled` is `true` and the target is a connected database (profiling is live only; dacpac-only projects have no profiling).
- Large tables use sampling when row count ≥ `dataLineageViz.tableStatistics.sampleThreshold`. Fabric DW does not support `TABLESAMPLE`; the profiler falls back to `TOP N`. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

---

## Collecting diagnostics for a bug report

The fastest way to get help is:

1. Reproduce the issue.
2. *Command Palette → Data Lineage: Copy Debug Info* — copies VS Code version, extension version, loaded graph stats, and the last hop diagnostics to your clipboard.
3. Attach the copied text to the issue along with the relevant output-channel log (*View → Output → Data Lineage*).

Do not attach customer dacpacs or production DDL to public issues — redact or use the built-in demo (*Data Lineage: Open Demo*) to reproduce.
