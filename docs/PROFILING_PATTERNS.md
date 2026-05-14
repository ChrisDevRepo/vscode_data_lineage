# Table Profiling — SQL Patterns

This file documents every SQL pattern the profiling engine ([`src/engine/profilingEngine.ts`](../src/engine/profilingEngine.ts)) generates. Profiling fires only on explicit user action and emits the full query to the **Data Lineage Viz** Output channel — there is no hidden background work.

## Prerequisites

- **Permissions**: `SELECT` on profiled tables, plus `db_datareader` (or equivalent) for row counts via `sys.partitions`.
- **Connection**: Profiling reuses or opens a separate database connection on first click; it stays alive for subsequent profiling and closes on panel dispose, extension deactivation, or query error.
- **Output channel**: `View → Output → Data Lineage Viz`. Set the channel log level to **Debug** (gear → Set Log Level → Debug) to see the profiling SQL line-by-line.

## How it works

1. User clicks **Quick** or **Standard** in the table-detail panel (database mode only).
2. The extension builds **one** `SELECT` with all column aggregations combined.
3. The query executes against the live database and returns **one row**.
4. The result is parsed into per-column statistics and rendered in the flat grid.

Nothing fires automatically. With `tableStatistics.enabled = false`, the statistics UI is not rendered and zero database interaction occurs.

### Connection lifecycle

- Opens on first profiling click (reuses stored credentials or prompts via the MSSQL extension).
- Stays alive for subsequent clicks across tables.
- Closes on panel dispose, extension deactivation, or query error.
- Every executed SQL is logged to the Output channel via the `[Stats]` and `[DB]` categories at DEBUG level.

## Display

### Grid layout (two rows per column)

- **Row 1** — Column name, type badge, Null %, distinct count + uniqueness, type-adaptive detail.
- **Row 2** — Full-width completeness bar with percentage.

### Type badges

| Badge | SQL types |
|-------|-----------|
| `INT` | `int`, `bigint`, `smallint`, `tinyint` |
| `DEC` | `decimal`, `numeric`, `float`, `real`, `money`, `smallmoney` |
| `STR` | `varchar`, `nvarchar`, `char`, `nchar` |
| `DATE` | `date`, `datetime`, `datetime2`, `smalldatetime`, `datetimeoffset`, `time` |
| `BIT` | `bit` |
| `UUID` | `uniqueidentifier` |
| *(skipped)* | `binary`, `varbinary`, `image`, `text`, `ntext`, `xml`, `geography`, `geometry`, `hierarchyid`, `sql_variant`, `timestamp`, `rowversion`, `sysname`, computed columns |

### Type-adaptive detail column (Standard mode)

| Type | Detail shown |
|------|--------------|
| Integer / Decimal | `1 … 20,777   μ10K σ6K` (+ zero-count if nullable) |
| String | `len 2–17   3 empty` |
| DateTime | `2015-04-15 … 2025-06-29` (compact: date-only when midnight) |
| Boolean / UUID | — (distinct count is sufficient) |

### Sortable headers

Click **Column**, **Null %**, or **Distinct** to sort. Useful for triage — sort by Null % descending to find sparse columns.

### Skipped columns

Non-profilable columns are grouped at the bottom under `Not profiled (N)` with dimmed styling. They are excluded from every aggregation, never appear in the SELECT, and never count against `maxColumns`.

## VS Code settings

All settings under `dataLineageViz.tableStatistics.*`. Search "dataLineageViz" in VS Code Settings (`Ctrl+,`). Defaults are taken from [`package.json`](../package.json):

These are the configured defaults. If a setting is missing at runtime, the engine falls back to:
`sampleThreshold = 500000`, `sampleSize = 1000`, `maxColumns = 100`, `queryTimeout = 60`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Show the statistics section in the table-detail panel (DB mode only). |
| `standardModeEnabled` | boolean | `true` | Allow Standard mode. When `false`, only Quick mode is available — lighter queries. |
| `excludeExternalTables` | boolean | `true` | Skip profiling for external tables (S3 / Blob / cross-DB — slow and expensive). |
| `queryTimeout` | number | `60` | Timeout (seconds) per profiling query. Range 10–600. |
| `sampleThreshold` | number | `100000` | Row count above which sampling is used instead of a full scan. `0` = always sample. |
| `sampleSize` | number | `10000` | Target sample size (rows) when sampling. Range 100–1 000 000. |
| `useApproxDistinct` | boolean | `true` | Use `APPROX_COUNT_DISTINCT` (HLL, ~2 % error). Requires SQL Server 2019+. |
| `maxColumns` | number | `50` | Max columns profiled per table. Excess columns are dropped from the SELECT. Range 1–500. |

## Row-count query

Fast row count from `sys.partitions` — no table scan:

```sql
SELECT SUM(p.rows) AS row_count
FROM sys.partitions p
WHERE p.object_id = OBJECT_ID('[schema].[table]')
  AND p.index_id IN (0, 1)
```

## Profiling query — single-pass aggregation

One `SELECT` with per-column fragments. Column-alias convention: `[ColumnName__suffix]`.

### Quick mode (always)

| Fragment | Suffix | Condition |
|----------|--------|-----------|
| `APPROX_COUNT_DISTINCT([col])` | `__d` | `useApproxDistinct = true` |
| `COUNT(DISTINCT [col])` | `__d` | `useApproxDistinct = false` |
| `SUM(CASE WHEN [col] IS NULL THEN 1 ELSE 0 END)` | `__n` | nullable columns only |

### Standard mode (adds to Quick)

| Category | Fragment | Suffix | Condition |
|----------|----------|--------|-----------|
| integer, decimal | `MIN([col])` | `__min` | |
| integer, decimal | `MAX([col])` | `__max` | |
| integer, decimal | `AVG(CAST([col] AS float))` | `__avg` | |
| integer, decimal | `STDEV(CAST([col] AS float))` | `__sd` | |
| integer, decimal | `SUM(CASE WHEN [col] = 0 THEN 1 ELSE 0 END)` | `__z` | nullable only |
| datetime | `MIN([col])` | `__min` | |
| datetime | `MAX([col])` | `__max` | |
| string | `MIN(LEN([col]))` | `__minl` | |
| string | `MAX(LEN([col]))` | `__maxl` | |
| string | `SUM(CASE WHEN [col] = '' THEN 1 ELSE 0 END)` | `__e` | |

### Computed metrics (client-side, no SQL)

- **Completeness** = `1 - (nullCount / rowCount)` — for every non-skipped column.
- **Uniqueness** = `distinctCount / rowCount` — for every non-skipped column.

## Sampling

| Platform | Method |
|----------|--------|
| SQL Server 2016+ | `TABLESAMPLE(P PERCENT)` |
| Azure SQL Database | `TABLESAMPLE(P PERCENT)` |
| Synapse Dedicated SQL Pool | `TABLESAMPLE(P PERCENT)` |
| Fabric Data Warehouse | `TOP N` (TABLESAMPLE not supported) |

- `P = CEIL(sampleSize / rowCount × 100)`, capped at 100.
- If the query fails with a `TABLESAMPLE` error, the engine retries automatically with a full scan.
- When `rowCount ≤ sampleThreshold`, no sampling is applied.

## Example — generated SQL for `[Sales].[Order]` (Standard mode)

Assuming columns `OrderID` (int, NOT NULL), `CustomerName` (nvarchar, NULL), `Total` (decimal, NULL), `OrderDate` (datetime, NULL) and a row count of 1.2 M (above default `sampleThreshold`):

```sql
SELECT
  APPROX_COUNT_DISTINCT([OrderID])                                AS [OrderID__d],
  MIN([OrderID])                                                  AS [OrderID__min],
  MAX([OrderID])                                                  AS [OrderID__max],
  AVG(CAST([OrderID] AS float))                                   AS [OrderID__avg],
  STDEV(CAST([OrderID] AS float))                                 AS [OrderID__sd],
  APPROX_COUNT_DISTINCT([CustomerName])                           AS [CustomerName__d],
  SUM(CASE WHEN [CustomerName] IS NULL THEN 1 ELSE 0 END)         AS [CustomerName__n],
  MIN(LEN([CustomerName]))                                        AS [CustomerName__minl],
  MAX(LEN([CustomerName]))                                        AS [CustomerName__maxl],
  SUM(CASE WHEN [CustomerName] = '' THEN 1 ELSE 0 END)            AS [CustomerName__e],
  APPROX_COUNT_DISTINCT([Total])                                  AS [Total__d],
  SUM(CASE WHEN [Total] IS NULL THEN 1 ELSE 0 END)                AS [Total__n],
  MIN([Total])                                                    AS [Total__min],
  MAX([Total])                                                    AS [Total__max],
  AVG(CAST([Total] AS float))                                     AS [Total__avg],
  STDEV(CAST([Total] AS float))                                   AS [Total__sd],
  SUM(CASE WHEN [Total] = 0 THEN 1 ELSE 0 END)                    AS [Total__z],
  APPROX_COUNT_DISTINCT([OrderDate])                              AS [OrderDate__d],
  SUM(CASE WHEN [OrderDate] IS NULL THEN 1 ELSE 0 END)            AS [OrderDate__n],
  MIN([OrderDate])                                                AS [OrderDate__min],
  MAX([OrderDate])                                                AS [OrderDate__max]
FROM [Sales].[Order] TABLESAMPLE(1 PERCENT)
```

`OrderID` is `NOT NULL` so it has no `__n` and no `__z`. `Total` is nullable decimal so it has both. Sample percent is `CEIL(10000 / 1200000 × 100) = 1`.

## Date formatting

DateTime min/max values are compacted in the UI:

| SQL Server returns | Displayed as |
|--------------------|--------------|
| `2015-04-15 00:00:00.000` | `2015-04-15` (midnight → date only) |
| `2025-06-29 14:30:00.000` | `2025-06-29 14:30` (non-midnight → date + HH:mm) |
| `2020-01-01` | `2020-01-01` (already date-only) |

## User-defined types (UDTs)

The columns DMV query uses `TYPE_NAME(c.system_type_id)` to resolve UDT aliases to base system types. For example, in AdventureWorks:

| UDT name | Resolves to | Badge |
|----------|-------------|-------|
| `dbo.Flag` | `bit` | BIT |
| `dbo.Name` | `nvarchar` | STR |
| `dbo.Phone` | `nvarchar` | STR |

This ensures every column with a profilable base type is correctly classified, regardless of whether the column declares a UDT alias. The dacpac path resolves to system types natively.

## Reference

- Engine: [`src/engine/profilingEngine.ts`](../src/engine/profilingEngine.ts)
- Connection / query execution: [`src/engine/connectionManager.ts`](../src/engine/connectionManager.ts)
- Microsoft aggregate-functions reference: <https://learn.microsoft.com/sql/t-sql/functions/aggregate-functions-transact-sql>
