# Table Profiling

Table profiling runs on demand against a live database. It does not run for DACPAC
sources and does not start until the user opens table details and requests
statistics. This document describes the SQL a request sends and what it costs.

## Prerequisites and safety

- The active database connection needs `SELECT` permission on profiled tables
  and catalog visibility for row-count metadata.
- A connection is opened for each profiling request and closed when it
  finishes. See [Connections](../SECURITY.md#connections).
- External tables can query remote systems. They are excluded by default and
  should be enabled only when their cost and latency are understood. The
  exclusion hides the statistics section for external tables in the detail
  panel, and a request for one is refused.
- Approximate distinct counts require a database version that supports
  `APPROX_COUNT_DISTINCT`. Disable
  `dataLineageViz.tableStatistics.useApproxDistinct` on older SQL Server
  versions.

Profiling issues read-only row-count and aggregate `SELECT` queries. Before
them, every request runs the `platform-info` query from the DMV queries YAML
(the custom file, if configured). Its `engine_edition` decides between `TOP` and
`TABLESAMPLE` sampling, so `platform-info` is required for table statistics. See
[`DMV_QUERIES.md`](DMV_QUERIES.md). The row-count and aggregate SQL is built
into the extension and is not in the YAML.

## Modes and metrics

Quick mode reports row count, null count, distinct count, completeness, and
uniqueness. Standard mode adds type-appropriate detail such as numeric range,
mean and standard deviation, string length and empty-string counts, and date
range. Completeness and uniqueness are calculated in the extension from the row
count and the per-column aggregates.

Non-profileable types and computed columns are shown as not profiled and do not
count towards the column limit. Profileable columns beyond
`dataLineageViz.tableStatistics.maxColumns` are left out of the SQL and also
shown as not profiled.

## Query shapes

Row count, from the catalog (`index_id` 0 is a heap, 1 the clustered index):

```sql
SELECT SUM(p.rows) AS row_count
FROM sys.partitions p
WHERE p.object_id = OBJECT_ID(N'[schema].[table]')
  AND p.index_id IN (0, 1)
```

Aggregates, one row from a single `SELECT` over the table. Each profiled column
adds the fragments for its type:

| Mode | Fragments per column |
|------|----------------------|
| Quick | distinct count (`APPROX_COUNT_DISTINCT` or `COUNT(DISTINCT)`); null count when the column is nullable |
| Standard, numeric | Quick, plus `MIN`, `MAX`, `AVG`, `STDEV`; zero count when nullable |
| Standard, date and time | Quick, plus `MIN`, `MAX` |
| Standard, string | Quick, plus `MIN` and `MAX` of `LEN`; empty-string count |

```sql
SELECT [TOP n] [COUNT_BIG(*) AS __rows,]
  APPROX_COUNT_DISTINCT([col]) AS c0_d,
  SUM(CASE WHEN [col] IS NULL THEN 1 ELSE 0 END) AS c0_n
  -- more fragments per column
FROM [schema].[table] [TABLESAMPLE(n PERCENT)]
```


## Sampling

Tables above the configured threshold use a platform-specific sampling clause:

- Fabric Data Warehouse uses a `TOP` clause, which in practice scans the whole
  table (see the limitation below).
- Other detected editions use `TABLESAMPLE`.
- A sampled query that fails with a `TABLESAMPLE` error is retried once as a
  full scan.

With `TABLESAMPLE`, the target sample size is converted to a whole percent of
the table: `ceil(sampleSize / rowCount * 100)`, at least 1 and at most 100. The
sample is therefore approximate and can read more rows than `sampleSize`.
On a `TABLESAMPLE` run the query also returns the number of rows it read, and
NULL %, completeness and uniqueness are computed against that number.

Limitation: on Fabric the `TOP` clause limits result rows rather than the
aggregate input, so the query scans the full table.

## Settings

Defaults and ranges are listed in
[`FEATURES.md`](FEATURES.md#table-statistics). The profiling controls cover:

- enabling the feature and Standard mode;
- excluding external tables;
- per-query timeout;
- sampling threshold and target size;
- approximate or full distinct counts; and
- maximum profiled columns.

## Diagnostics

Open **View -> Output -> Data Lineage Viz** and set the channel log level to
**Debug**. `[Stats]` entries describe the profiling lifecycle and `[DB]` entries
show the first 300 characters of each query. Object and column identifiers may
appear in the log.

## Reference

- User-facing feature guide: [`FEATURES.md`](FEATURES.md#table-profiling)
