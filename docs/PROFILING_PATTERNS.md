# Table profiling

Reference for DBAs: the statements sent when someone requests table statistics. Profiling works on database imports only and runs nothing until statistics are requested for one table in its details view. Settings are in [Table statistics](FEATURES.md#table-statistics).

## Connection

| Item | Value |
|---|---|
| Connection | A new connection per request, with the import's connection settings (`ReadOnly` intent; see [`DMV_QUERIES.md`](DMV_QUERIES.md#connection)); closed afterwards |
| Permission | `SELECT` on the table |
| Statements | Three `SELECT` statements, in order; no writes |
| Timeout | `dataLineageViz.tableStatistics.queryTimeout` (default 60 s) for statements 2 and 3; `dataLineageViz.dmvQueryTimeout` for statement 1 |
| Off switch | `dataLineageViz.tableStatistics.enabled` = `false`; requests are then rejected by the extension before connecting |

External tables are not offered for profiling while `dataLineageViz.tableStatistics.excludeExternalTables` is on (default).

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

Not profiled: computed columns; `binary`, `varbinary`, `image`, `text`, `ntext`, `xml`, `geography`, `geometry`, `hierarchyid`, `sql_variant`, `timestamp`/`rowversion`, `sysname` and other unlisted types; columns beyond `dataLineageViz.tableStatistics.maxColumns` (default 50). `bit` and `uniqueidentifier` get only the distinct and null counts. Standard mode is unavailable when `dataLineageViz.tableStatistics.standardModeEnabled` is `false`.

`APPROX_COUNT_DISTINCT` needs SQL Server 2019 or later; on 2016 or 2017 set `useApproxDistinct` to `false`.

## Sampling

Sampling applies when the row count exceeds `dataLineageViz.tableStatistics.sampleThreshold` (default 100,000; `0` always samples).

| Platform | Statement | Effect |
|---|---|---|
| Fabric Data Warehouse | `TOP <sampleSize>` | Does not limit an aggregate; the full table is scanned. |
| Other platforms | `TABLESAMPLE(p PERCENT)` with p = ceil(`sampleSize` / row count × 100), plus `COUNT_BIG(*)` for the rows read | Metrics describe the sample. |

`sampleSize` is `dataLineageViz.tableStatistics.sampleSize` (default 10,000). If the server rejects `TABLESAMPLE`, the statement is sent once more without it as a full scan, and the result is shown as unsampled.

Row-count headers show the catalog row count. On a `TABLESAMPLE` run, NULL %, completeness and uniqueness are computed against the rows the sample read, so they describe the sample; an empty sample falls back to the catalog row count as the denominator. On Fabric Data Warehouse the metrics are full-scan aggregates although the statistics show a sampling indicator.

## Diagnostics

In **View → Output → Data Lineage Viz** at **Debug** level, `[Stats]` and `[DB]` entries show each request and statement. Logs may contain object and column names.
