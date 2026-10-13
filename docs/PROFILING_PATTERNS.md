# Table profiling

Profiling works on live database sources only. It is on by default (`dataLineageViz.tableStatistics.enabled`) but runs nothing until you request statistics in a table's details. Settings are in [Table statistics](FEATURES.md#table-statistics).

## What runs on the server

Each request opens its own connection, runs these read-only queries, then closes it:

1. The `platform-info` query from the active DMV queries (see [`DMV_QUERIES.md`](DMV_QUERIES.md#setup)). If it is missing or fails, the request fails.
2. A row count from `sys.partitions`.
3. One aggregate `SELECT` over the table, sampled above the threshold.

The login needs `SELECT` on the table. External tables are skipped by default. `APPROX_COUNT_DISTINCT` needs SQL Server 2019 or later; on 2016 or 2017 set `dataLineageViz.tableStatistics.useApproxDistinct` to `false`.

## Modes

Quick mode reports row, null and distinct counts, completeness and uniqueness. Standard mode adds numeric range, mean and standard deviation, string length, empty strings and date range. Unsupported types, computed columns and columns beyond `dataLineageViz.tableStatistics.maxColumns` are listed under **Not profiled**.

## Sampling

Fabric Data Warehouse always scans the full table. Other editions use `TABLESAMPLE`, so metrics describe the sample.

## Diagnostics

In **View → Output → Data Lineage Viz** at **Debug** level, `[Stats]` and `[DB]` entries show the requests. Logs may contain object and column names.
