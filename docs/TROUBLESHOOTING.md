# Troubleshooting

Defaults and thresholds change between versions — check **Settings → Data Lineage** for current values. **Output → Data Lineage Viz** is the first place to look for unexpected behaviour.

## Import and connection

**`.dacpac` won't load.** Close SSDT / Visual Studio / Azure Data Studio (file lock). Only SSDT- and SDK-style archives are supported.

**Database connection fails.** The error shows as `<connection name>: <original driver message>` — the text is the driver's, unchanged — and the full error is written to **Output → Data Lineage Viz**. Which fix applies depends on `dataLineageViz.database.connectionProvider`:

- `mssqlExtension` (default): install or update the [MSSQL extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql) and save a connection profile there. Microsoft is retiring its connection-sharing API, so MSSQL shows a retirement notice on every connect; the wizard offers **Use Built-in Connection** to switch.
- `builtIn`: add a connection with **Data Lineage: Add Database Connection**; no other extension is needed. The notification buttons fit the error:

| Error | Typical cause | Buttons |
|---|---|---|
| 18456 `Login failed for user` | Wrong password or user; Entra account without access | Update Password · Edit Connection (Entra: Sign in with another account) |
| 4060 / 916 `Cannot open database` | Database missing or the login has no user in it | Choose Database · Edit Connection |
| 40613 / 40197 / 40501 / 40532 | Azure database unavailable, busy or resuming | Retry |
| `ETIMEOUT`, `ESOCKET`, `ENOTFOUND`, `ECONNREFUSED` | Wrong server or port, server stopped, network blocked | Edit Connection · Retry |
| Certificate not trusted (self-signed) | Local or test server without a trusted certificate | Trust Server Certificate (asks first — only for a server you control) · Edit Connection |
| Sign-in cancelled | Microsoft sign-in window closed | Sign In |
| 229 / 297 / 300 | Login cannot read metadata | Copy GRANT Statement |
| anything else | — | Show Log · Edit Connection |

The built-in connection retries a connect by itself on the transient errors 4060, 10928, 10929, 40197, 40501 and 40613 — three times, five seconds apart, as Microsoft recommends — before the error is shown. A mistyped database name (4060) therefore takes about 15 seconds to report.

**Built-in connection by platform.**

| Platform | Server name | Sign-in | Note |
|---|---|---|---|
| SQL Server (on-premises, Docker) | `host`, `host,port`, `host\instance` | SQL Login | Self-signed certificate: use Trust Server Certificate. A named instance needs the SQL Server Browser service (UDP 1434); with a port it is not used. |
| Azure SQL Database | `<server>.database.windows.net` | SQL Login or Microsoft Entra ID | A paused serverless database resumes on the first login (about a minute): the first connect can end with 40613 "not currently available" — choose Retry. |
| Azure SQL Managed Instance | `<name>.<zone>.database.windows.net` (public endpoint: `,3342`) | SQL Login or Microsoft Entra ID | — |
| Synapse dedicated SQL pool | `<workspace>.sql.azuresynapse.net` | SQL Login or Microsoft Entra ID | A paused pool must be resumed in Synapse first. |
| Synapse serverless SQL pool | `<workspace>-ondemand.sql.azuresynapse.net` | SQL Login or Microsoft Entra ID | Access is granted through Synapse RBAC roles. |
| Fabric Data Warehouse, SQL analytics endpoint | `<id>.datawarehouse.fabric.microsoft.com` | Microsoft Entra ID only | SQL Login is not supported by Fabric. Use the warehouse or lakehouse name as the database. |
| SQL database in Fabric | `<id>.database.fabric.microsoft.com` | Microsoft Entra ID only | — |

A `tcp:` prefix, as the Azure portal connection strings carry it, is accepted and dropped. When the login cannot open `master` (a contained or Microsoft Entra database user, a Fabric workspace), the wizard asks for the database name instead of listing databases.

Firewall and IP-allow-list errors are shown as the server reports them; Data Lineage does not change firewall rules. A password is stored only in VS Code secret storage — **Data Lineage: Update Database Password** replaces it, **Remove Database Connection** deletes it with the connection.

Switching the provider keeps saved projects and their schema selection. On its next open a project reconnects through the selected provider: a saved built-in connection with the same server and user is used directly, otherwise the connection picker opens and **Add Connection…** starts from the project's server, user and database. The project then remembers the new connection.

Database import needs metadata visibility such as `VIEW DEFINITION` plus permission to run the configured catalog queries; the built-in connection sends only the queries in [`DMV_QUERIES.md`](DMV_QUERIES.md). Profiling also needs `SELECT` on profiled tables and catalog visibility for `sys.partitions` row counts. `@lineage` reads only the already-loaded model and never opens a database connection.

**Cross-database refs missing.** Fully qualified three- or four-part names can surface as virtual external nodes, but remote database internals are not imported. Unqualified names are ambiguous and may not resolve.

**DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout`. The timeout is per query — Phase 2 runs several.

**Custom YAML rejected.** Structure must match the built-in YAML. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

**"saved projects could not be read and were skipped".** A stored project was missing a required field, or carried one of the wrong type, and was left out of the project list. A field this build merely does not recognise is dropped instead and never costs the project. The warning appears once per session; **Output → Data Lineage Viz** names the rejected field paths (names only, never values). A credential cannot be written to the store, and is dropped rather than replayed if an older record carries one — recreate the project instead of editing stored state.

## Graph and webview

**Blank or stuck graph.** Open Webview Developer Tools, check the console, then reload the window.

**"Render limit reached".** `dataLineageViz.renderLimit` is the hard visual ceiling after load — raise it (default 750, maximum 1500). `dataLineageViz.maxNodes` is a separate load limit: a selection over it is refused with an error instead of being loaded (range 10-5,000, default 2,000). Every admitted object is loaded, searchable and available to `@lineage`; when the count exceeds `renderLimit` nothing is drawn — a *Render limit reached* notice names the count and the limit; on the base graph it offers Schema View where available, and on a trace it offers **Reduce depth to ↑n ↓n** or **Exit trace**. `dataLineageViz.overview.threshold` only dictates whether a new load defaults to Schema View or fully-expanded Object View; a threshold above `renderLimit` is treated as `renderLimit`.

**Docking the graph or the AI report.** The graph webview is a normal VS Code editor tab: drag it to any editor group, split it, or right-click → **Move Editor into New Window**. Chat (including `@lineage`) docks the same way via its drag handle or **View: Move Chat**. Inside the graph, the dock menu in the AI report header moves that panel to the left, bottom, or right edge.

## `@lineage` chat participant

**No response.** Load a graph first, then make sure a VS Code Language Model Chat provider is installed, configured, and available to Chat. [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) is one supported provider.

**The request is redirected because the scope exceeds its budget.** Narrow the requested scope or approve the offered deep analysis. For larger discovery answers, adjust `dataLineageViz.ai.discoveryNodeCap` or `dataLineageViz.ai.discoveryTokenBudget` (the budget is further capped at one eighth of the selected model's input window); `ai.maxRounds` does not change those limits. If the chat answers "Analysis cannot start", the scope is over a limit: narrow it, or raise `dataLineageViz.ai.maxRounds` (one round per procedure, view or function). A column trace that selects more starting columns than `dataLineageViz.ai.maxTraceColumns` (default 10) is refused the same way: trace fewer columns or raise the setting. The setting applies from the next request, no reload needed.

**Deep-analysis confirmation.** The assistant asks before starting hop-by-hop analysis. This path is used by `/trace`, named-column traces, explicit deeper analysis, and discovery scopes that exceed their configured budget. A graph request uses the bounded **AI Preview** path and does not open this gate.

**The response ends when I click Change scope.** By design. VS Code keeps the chat input locked while a request is still running, so the turn finishes and the input is prefilled with `@lineage`. Type the change — for example `remove DimCalendar` — and send it; the proposal stays pending and comes back revised. **Cancel** or a slash command abandons it instead.

**Related paths beyond the approved scope.** By design — deep analysis locks the schema border at confirmation. A completed result offers **Explore related objects…** for the deferred routes.

**Deep analysis stops before the whole scope is covered.** An approved scope always fits `dataLineageViz.ai.maxRounds`, so this happens only when the model connection is lost mid-run, or when the model keeps replying without progress on one object — the chat then names that object. The answer is marked *stopped early* and presents what was completed. Ask again, or exclude the named object from the scope.

**The assistant retries a graph preview or a result more than once.** Each rejected tool call is answered with its own error result that lists every defect found in one pass — a repeated defect once, with the other places it occurs — and the expected shape. A repair resends the full call and names only the entries it changes (a section under its label, an analysis section under its angle); everything else held is kept, and `{label, remove: true}` drops a held section. The held draft is cleared only when the result is committed or the turn ends. **Output → Data Lineage Viz** at debug level shows each rejection with its code and issue paths.

**Model choice.** Per-hop latency and protocol compliance differ by model. A long silence during deep analysis usually means the provider is still generating — the hop counter advances as hops complete. The extension never times out or cuts a generation; the chat **Stop** button ends one that appears hung.

**A local reasoning model thinks for many minutes on one step.** Copilot BYOK sends a low temperature, which keeps answers stable, but some reasoning models then repeat themselves until the output limit. Set a thinking-token budget and the repetition (presence) penalty the model's card recommends in the model server. A higher temperature in the Custom Endpoint model's `modelOptions` also avoids the loop, at the cost of less repeatable answers.

## Export and profiling

- Draw.io export mirrors the current webview layout.
- Profiling is live-DB only (no dacpac). See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).
- On SQL Server 2016 or 2017, set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`; `APPROX_COUNT_DISTINCT` requires SQL Server 2019 or later.

## Bug reports

Run **Data Lineage: Copy Debug Info** and include the relevant section from **Output → Data Lineage Viz**. Review and redact project, source, schema, object, filter, and model identifiers before sharing. Do not attach customer dacpacs.
