# Table profiling

Reference for DBAs: the statements sent when someone requests table statistics. Profiling works on database imports only and runs nothing until statistics are requested for one table in its details view. Settings are in [Table statistics](FEATURES.md#table-statistics).

## Connection

| Item | Value |
|---|---|
| Connection | A new connection per request, with the import's connection settings (`ReadOnly` intent; see [`DMV_QUERIES.md`](DMV_QUERIES.md#connection)); closed afterwards |
| Permission | `SELECT` on the table, and catalog visibility of the table (`VIEW DEFINITION`) for the row count |
| Statements | Three `SELECT` statements, in order; no writes |
| Timeout | `dataLineageViz.tableStatistics.queryTimeout` (default 60 s) for statements 2 and 3; `dataLineageViz.dmvQueryTimeout` for statement 1 |
| Off switch | `dataLineageViz.tableStatistics.enabled` = `false`; requests are then rejected by the extension before connecting |

External tables can query remote systems (object storage, other databases), so they are not offered for profiling while `dataLineageViz.tableStatistics.excludeExternalTables` is on (default). Turn it off only when their cost and latency are understood.

A custom DMV queries file changes only statement 1; statements 2 and 3 are fixed.

## Modes and metrics

| Mode | Metrics per column |
|---|---|
| Quick | Null count and NULL %, distinct count, completeness, uniqueness |
| Standard | Quick, plus by type: numeric min, max, mean, standard deviation and zero count; string length range and empty count; date and time range |

The table header shows the row count. Completeness is 1 − nulls / rows; uniqueness is distinct / rows, capped at 100 %. Distinct counts are approximate or exact as set by `dataLineageViz.tableStatistics.useApproxDistinct`.

## Statements

### 1. Platform

The [`platform-info`](DMV_QUERIES.md#platform-info) query from the active DMV queries. `engine_edition` selects the sampling method. If the query is missing or fails, the request fails.

### 2. Row count

```sql
SELECT SUM(p.rows) AS row_count
FROM sys.partitions p
WHERE p.object_id = OBJECT_ID(N'[schema].[table]')
  AND p.index_id IN (0, 1)
```

Reads partition metadata only. The result is the reported row count and decides whether to sample.

### 3. Column aggregates

One statement over the table:

```sql
SELECT [TOP n] [COUNT_BIG(*) AS [__rows],] <column fragments>
FROM [schema].[table] [TABLESAMPLE(p PERCENT)]
```

Per profiled column `[c]`:

| Mode | Column type | Fragments |
|---|---|---|
| Quick and Standard | All profiled | `APPROX_COUNT_DISTINCT([c])`, or `COUNT(DISTINCT [c])` when `dataLineageViz.tableStatistics.useApproxDistinct` is `false` |
| Quick and Standard | Nullable | `SUM(CASE WHEN [c] IS NULL THEN 1 ELSE 0 END)` |
| Standard | Integer, decimal, float, money | `MIN([c])`, `MAX([c])`, `AVG(CAST([c] AS float))`, `STDEV(CAST([c] AS float))`; nullable columns also `SUM(CASE WHEN [c] = 0 THEN 1 ELSE 0 END)` |
| Standard | Date and time | `MIN([c])`, `MAX([c])` |
| Standard | `char`, `nchar`, `varchar`, `nvarchar` | `MIN(LEN([c]))`, `MAX(LEN([c]))`, and an empty count: `DATALENGTH([c]) = 0` for `varchar`/`nvarchar`, `[c] = ''` for `char`/`nchar` |

Completeness and uniqueness are computed by the extension from these counts and the row count; no further statement is sent.

For `float` columns, `AVG` and `STDEV` are wrapped in a `CASE` that returns NULL when `MAX(ABS([c]))` exceeds the float range.

Not profiled, and shown as not profiled: computed columns; `binary`, `varbinary`, `image`, `text`, `ntext`, `xml`, `geography`, `geometry`, `hierarchyid`, `sql_variant`, `timestamp`/`rowversion`, `sysname` and other unlisted types; columns beyond `dataLineageViz.tableStatistics.maxColumns` (default 50). Types that are never profiled and computed columns do not count towards that limit. If no column is left, no aggregate statement is sent and the request reports that there are no profileable columns. `bit` and `uniqueidentifier` get only the distinct and null counts. Standard mode is unavailable when `dataLineageViz.tableStatistics.standardModeEnabled` is `false`.

`APPROX_COUNT_DISTINCT` needs SQL Server 2019 or later; on 2016 or 2017 set `useApproxDistinct` to `false`.

## Sampling

Sampling applies when the row count exceeds `dataLineageViz.tableStatistics.sampleThreshold` (default 100,000; `0` always samples).

| Platform | Statement | Effect |
|---|---|---|
| Fabric Data Warehouse | `TOP <sampleSize>` | Does not limit an aggregate; the full table is scanned. |
| Other platforms | `TABLESAMPLE(p PERCENT)` with p = ceil(`sampleSize` / row count × 100), plus `COUNT_BIG(*)` for the rows read | Metrics describe the sample. |

`sampleSize` is `dataLineageViz.tableStatistics.sampleSize` (default 10,000). If the server rejects `TABLESAMPLE`, the statement is sent once more without it as a full scan, and the result is shown as unsampled.

Row-count headers show the catalog row count. On a `TABLESAMPLE` run, NULL %, completeness and uniqueness are computed against the rows the sample read, so they describe the sample; an empty sample falls back to the catalog row count as the denominator. On Fabric Data Warehouse the metrics are full-scan aggregates although the statistics show a sampling indicator.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `dataLineageViz.tableStatistics.enabled` | `true` | Allows table statistics at all |
| `dataLineageViz.tableStatistics.standardModeEnabled` | `true` | Allows Standard mode; when `false` only Quick mode is offered |
| `dataLineageViz.tableStatistics.excludeExternalTables` | `true` | Hides profiling for external tables |
| `dataLineageViz.tableStatistics.queryTimeout` | `60` (10–600 s) | Timeout of statements 2 and 3 |
| `dataLineageViz.tableStatistics.sampleThreshold` | `100000` | Row count above which sampling applies; `0` always samples |
| `dataLineageViz.tableStatistics.sampleSize` | `10000` (100–1,000,000) | Target rows per sample |
| `dataLineageViz.tableStatistics.useApproxDistinct` | `true` | `APPROX_COUNT_DISTINCT` instead of `COUNT(DISTINCT)` |
| `dataLineageViz.tableStatistics.maxColumns` | `50` (1–500) | Maximum profiled columns per request |

## Diagnostics

In **View → Output → Data Lineage Viz** at **Debug** level, `[Stats]` and `[DB]` entries show each request and statement. `[DB]` entries show the first 300 characters of each statement. Logs may contain object and column names; review them before sharing.
