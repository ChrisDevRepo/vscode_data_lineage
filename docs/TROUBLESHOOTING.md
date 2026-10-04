# Troubleshooting

Defaults and thresholds change between versions — check **Settings → Data Lineage** for current values. **Output → Data Lineage Viz** is the first place to look for unexpected behaviour.

## Import and connection

**`.dacpac` won't load.** Check that the file is a valid ZIP archive containing `model.xml` with a `DataSchemaModel/Model` element. If the error reports a file lock, close the program holding the file.

**Database connection fails.** The error includes the connection name and driver message, with credential-shaped text removed. Details appear in **Output → Data Lineage Viz**. Which fix applies depends on `dataLineageViz.database.connectionProvider`:

- `mssqlExtension` (default): install or update the [MSSQL extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql) and save a connection profile there. The wizard warns that its connection-sharing API is retiring and offers **Use Built-in Connection**.
- `builtIn`: add a connection with **Data Lineage: Add Database Connection**; no other extension is needed. The notification buttons fit the error:

| Error | Typical cause | Buttons |
|---|---|---|
| 18456 `Login failed for user` | Wrong password or user, or a database the login cannot open (SQL Server reports both the same way); Entra account without access | Update Password · Choose Database · Edit Connection (Entra: Sign in with another account) |
| 4060 / 916 `Cannot open database` | Database missing or the login has no user in it | Choose Database · Edit Connection |
| 40613 / 40197 / 40501 / 40532 | Azure database unavailable, busy or resuming | Retry |
| `ETIMEOUT`, `ESOCKET`, `ENOTFOUND`, `ECONNREFUSED` | Wrong server or port, server stopped, network blocked | Edit Connection · Retry |
| Certificate not trusted (self-signed) | Server certificate is not trusted by this machine | Trust Server Certificate (asks first; also offered when a new connection is tested) · Edit Connection |
| Sign-in cancelled | Microsoft sign-in window closed | Sign In · Sign in with another account |
| 229 / 297 / 300 | Login cannot read metadata | Copy GRANT Statement |
| anything else | — | Show Log · Edit Connection |

The built-in connection retries a connect by itself on the transient errors 4060, 10928, 10929, 40197, 40501 and 40613 up to three times, with five-second waits, before showing the error. A mistyped database name (4060) can therefore add 15 seconds of retry waits.

A `tcp:` prefix, as the Azure portal connection strings carry it, is accepted and dropped.
Firewall and IP-allow-list errors are shown as the server reports them; Data Lineage does not change firewall rules. A password is stored only in VS Code secret storage — **Data Lineage: Update Database Password** replaces it, **Remove Database Connection** deletes it with the connection.

Switching the provider keeps saved projects and their schema selection. On its next open a project reconnects through the selected provider: a saved built-in connection with the same server and user is used directly, otherwise the connection picker opens and **Add Connection…** starts from the project's server, user and database. The project then remembers the new connection.

Permissions: `VIEW DEFINITION` on the database for lineage; `SELECT` on the tables to profile for table statistics. See [`DMV_QUERIES.md`](DMV_QUERIES.md) for metadata queries. `@lineage` reads only the already-loaded model and never opens a database connection.

**Cross-database refs missing.** Fully qualified three- or four-part names can surface as virtual external nodes, but remote database internals are not imported. Unqualified names are ambiguous and may not resolve.

**DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout`. The timeout is per query — Phase 2 runs several.

**Custom YAML rejected.** Structure must match the built-in YAML. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

**"saved projects could not be read and were skipped".** A saved project has missing or invalid fields. **Output → Data Lineage Viz** lists rejected field paths without their values. Recreate the project through the wizard; unknown fields are dropped without discarding an otherwise valid project.

## Graph and webview

**Blank or stuck graph.** Open Webview Developer Tools, check the console, then reload the window.

**"Render limit reached".** The notice says to reduce filter scope or adjust VS Code settings. Narrow the filters, or raise `dataLineageViz.renderLimit` (default 750, maximum 1500). The loaded objects remain searchable and available to `@lineage`. `dataLineageViz.maxNodes` limits import separately (default 2,000, maximum 5,000): a selection above it is refused. `dataLineageViz.overview.threshold` controls the initial view, capped at `renderLimit`.

**Docking the graph or the AI report.** The graph webview is a normal VS Code editor tab: drag it to any editor group, split it, or right-click → **Move Editor into New Window**. Chat (including `@lineage`) docks the same way via its drag handle or **View: Move Chat**. Inside the graph, the dock menu in the AI report header moves that panel to the left, bottom, or right edge.

## `@lineage` chat participant

**No response.** Load a graph first, then make sure a VS Code Language Model Chat provider is installed, configured, and available to Chat. [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) is one supported provider.

**The request is redirected because the scope exceeds its budget.** Narrow the requested scope or approve the offered deep analysis. For larger discovery answers, adjust `dataLineageViz.ai.discoveryNodeCap` or `dataLineageViz.ai.discoveryTokenBudget` (the budget is further capped at one eighth of the selected model's input window); `ai.maxRounds` does not change those limits. If the chat answers "Analysis cannot start", the scope is over a limit: narrow it, or raise `dataLineageViz.ai.maxRounds` (one round per procedure, view or function). A column trace that selects more starting columns than `dataLineageViz.ai.maxTraceColumns` (default 10) is refused the same way: trace fewer columns or raise the setting. The setting applies from the next request, no reload needed.

**Deep-analysis confirmation.** The assistant asks before starting hop-by-hop analysis. This path is used by `/trace`, named-column traces, explicit deeper analysis, and discovery scopes that exceed their configured budget. A graph request uses the bounded **AI Preview** path and does not open this gate.

**The response ends when I click Change scope.** By design. VS Code keeps the chat input locked while a request is still running, so the turn finishes and the input is prefilled with `@lineage`. Type the change — for example `remove DimCalendar` — and send it; the proposal stays pending and comes back revised. **Cancel** or a slash command abandons it instead.

**Related paths beyond the approved scope.** By design — deep analysis locks the schema border at confirmation. A completed result offers **Explore related objects…** for the deferred routes.

**Deep analysis stops before the whole scope is covered.** An approved scope always fits `dataLineageViz.ai.maxRounds`, but provider failures or repeated replies without progress can stop a run early. The answer is marked *stopped early* and presents what was completed. Ask again, or exclude the named object from the scope.

**Repeated graph-preview or result retries.** The extension rejects malformed tool calls and lets the model repair them. If retries persist, stop the turn and report the rejection codes and issue paths from **Output → Data Lineage Viz** at debug level.

**Model choice.** Per-hop latency and protocol compliance differ by model. A long silence during deep analysis usually means the provider is still generating — the hop counter advances as hops complete. Use the chat **Stop** button to end a generation that appears hung.

## Export and profiling

- Draw.io export mirrors the current webview layout.
- Profiling is live-DB only (no dacpac). See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).
- On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`; `APPROX_COUNT_DISTINCT` requires SQL Server 2019 or later.

## Bug reports

Run **Data Lineage: Copy Debug Info** and include the relevant section from **Output → Data Lineage Viz**. Review and redact project, source, schema, object, filter, and model identifiers before sharing. Do not attach customer dacpacs.
