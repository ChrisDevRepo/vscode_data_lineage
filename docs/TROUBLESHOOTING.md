# Troubleshooting

Defaults and thresholds change between versions — check *Settings → Data Lineage* for current values rather than trusting numbers written here.

---

## Import and connection

**`.dacpac` won't load.** Close SSDT / Visual Studio / ADS (file lock). Only SSDT- and SDK-style archives are supported; SQL Server, Azure SQL, Fabric DW, and Synapse Dedicated SQL Pool targets only.

**Database connection fails.** Install the [mssql extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql); `@lineage` reuses its profile. The account needs `db_owner` on the database plus `GRANT VIEW SERVER STATE`. Local SQL Server: TCP/IP + Mixed Mode auth.

**Cross-database refs missing.** Only **schema-qualified** names resolve. Unqualified `SELECT * FROM SomeTable` is intentionally dropped — there is no safe fallback.

**DMV query timed out.** Raise `dataLineageViz.dmvQueryTimeout`. Timeout is per DMV, the wizard runs several.

**Custom YAML rejected.** Structure must match `assets/dmvQueries.yaml` / `assets/defaultParseRules.yaml`. See [`DMV_QUERIES.md`](DMV_QUERIES.md) and [`PARSE_RULES.md`](PARSE_RULES.md).

---

## Graph and webview

**Blank or stuck graph.** *Developer: Open Webview Developer Tools* → check console. *Developer: Reload Window*.

**"Node limit reached".** Enable Schema Overview Mode (auto-fires above `dataLineageViz.overview.threshold`), narrow the import, or raise `dataLineageViz.maxNodes` / `dataLineageViz.renderLimit`. Past a few thousand nodes React Flow degrades regardless.

**Theme colors wrong after theme switch.** Reload the window — some webview CSS variables are resolved at mount.

---

## `@lineage` chat participant

**No response.** Install and sign in to [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) — `@lineage` delegates every LLM call to Copilot's model. Load a lineage graph before asking.

**"Scope exceeds budget".** The exploration would exceed `dataLineageViz.ai.maxRounds`. Narrow the question, accept the `safe_depth_hint`, or raise the setting.

**"Confirm SM start" gate.** Sliding-memory mode asks once before burning hops. For inline one-shot, scope must sit under `dataLineageViz.ai.inlineNodeCap` and `dataLineageViz.ai.inlineTokenBudget`.

**"Unanswered (out of approved scope)".** By design — SM locks the border at confirmation. The *Show deferred questions* button prefills them for a new run.

**"Exploration incomplete — N rounds pending".** Hop cap drained before the agenda. The partial archive is discarded on purpose — incomplete lineage can invert the picture. Narrow or raise `maxRounds`.

**Tool-call noise in chat.** Turn off `dataLineageViz.ai.showToolInvocations`.

---

## Export and profiling

- Draw.io export mirrors the current webview layout — re-layout before exporting if positions are messy.
- Profiling is live-DB only (no dacpac). Fabric DW has no `TABLESAMPLE`; the profiler falls back to `TOP N`. See [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

---

## Bug reports

Run *Data Lineage: Copy Debug Info* and paste into the issue along with the relevant section from *Output → Data Lineage*. Do **not** attach customer dacpacs — reproduce with *Data Lineage: Open Demo* if possible.
