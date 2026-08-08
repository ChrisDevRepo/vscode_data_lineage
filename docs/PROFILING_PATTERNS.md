# Table Profiling

Table profiling is an opt-in, live-database feature. It does not run for DACPAC
sources and does not start until the user opens table details and requests
statistics. The current SQL generation lives in
[`src/engine/profilingEngine.ts`](../src/engine/profilingEngine.ts); this document
covers the user-visible and operational contract rather than duplicating that
implementation.

## Prerequisites and safety

- The active database connection needs `SELECT` permission on profiled tables
  and catalog visibility for row-count metadata.
- Profiling reuses or opens a separate connection on first use. The connection
  is released when the main lineage panel closes or another saved project is
  loaded; a query error does not disconnect it automatically.
- External tables can query remote systems. They are excluded by default and
  should be enabled only when their cost and latency are understood.
- Approximate distinct counts require a database version that supports
  `APPROX_COUNT_DISTINCT`. Disable
  `dataLineageViz.tableStatistics.useApproxDistinct` on older SQL Server
  versions.

Profiling issues read-only row-count and aggregate `SELECT` queries. Custom DMV
configuration does not alter profiling SQL.

## Modes and metrics

Quick mode reports row count, null count, distinct count, completeness, and
uniqueness. Standard mode adds type-appropriate detail such as numeric range,
mean and standard deviation, string length and empty-string counts, and date
range.

Completeness and uniqueness percentages are calculated in the extension from
the reported table row count and per-column aggregates. Distinct counts use the
approximate or exact function selected in settings.

Intrinsic non-profileable types and computed columns are shown as not profiled
and do not consume the column budget. Profilable columns beyond
`dataLineageViz.tableStatistics.maxColumns` are omitted from the SQL, but the
current UI can still render them with zero/default metrics; those rows are not
measurements.

## Sampling

Tables above the configured threshold use a platform-specific sampling clause:

- Fabric Data Warehouse uses a `TOP` clause.
- Other detected editions use `TABLESAMPLE`.
- A sampled query that fails with a `TABLESAMPLE` error is retried once as a
  full scan.

The target sample size is converted into the clause required by the detected
platform. Row-count headers and percentage denominators continue to use catalog
row counts, including sampled runs.

Current limitation: Fabric's generated `TOP` aggregate query limits result rows
rather than the aggregate input. Treat those metrics as full-scan aggregates
until the query is rewritten around a sampled subquery.

## Settings

The maintained defaults, ranges, and descriptions are in VS Code Settings and
the `contributes.configuration` section of [`package.json`](../package.json).
The profiling controls cover:

- enabling the feature and Standard mode;
- excluding external tables;
- per-query timeout;
- sampling threshold and target size;
- approximate versus exact distinct counts; and
- maximum profiled columns.

See [`FEATURES.md`](FEATURES.md#table-profiling) for the user-facing settings
summary.

## Diagnostics

Open **View -> Output -> Data Lineage Viz** and set the channel log level to
**Debug**. `[Stats]` entries describe profiling lifecycle and `[DB]` entries
show bounded query previews. Review logs before sharing because object and
column identifiers may be present.

## Verification

Behavior changes belong with focused tests under
`tests/unit/engine/profilingEngine.test.ts` and the relevant UI tests. Verify
SQL generation for each supported platform, full-scan and sampled paths,
failure/retry behavior, excluded types, column budgets, and displayed metric
semantics.

## Reference

- Engine: [`src/engine/profilingEngine.ts`](../src/engine/profilingEngine.ts)
- Bridge handler: [`src/bridge/messageHandlers.ts`](../src/bridge/messageHandlers.ts)
- UI: [`src/components/StatsSection.tsx`](../src/components/StatsSection.tsx)
- User-facing feature guide: [`FEATURES.md`](FEATURES.md#table-profiling)
