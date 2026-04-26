# Interface Spec: Table Profiling Patterns

This document defines the dynamic SQL generation contract for column statistics in live databases.

## 1. Aggregation Interface (Single-Pass)
The engine builds one `SELECT` statement using type-adaptive fragments. Alias convention: `[ColumnName__suffix]`.

### 1.1 Quick Mode (Always)
| SQL Fragment | Suffix | Condition |
| :--- | :--- | :--- |
| `APPROX_COUNT_DISTINCT([col])` | `__d` | `useApproxDistinct = true` |
| `COUNT(DISTINCT [col])` | `__d` | `useApproxDistinct = false` |
| `SUM(CASE WHEN [col] IS NULL THEN 1 ELSE 0 END)` | `__n` | Nullable columns only |

### 1.2 Standard Mode (Additional)
| Category | SQL Fragment | Suffix |
| :--- | :--- | :--- |
| **Numeric** | `MIN([col])`, `MAX([col])` | `__min`, `__max` |
| **Numeric** | `AVG(CAST([col] AS float))`, `STDEV(...)` | `__avg`, `__sd` |
| **Numeric** | `SUM(CASE WHEN [col] = 0 THEN 1 ELSE 0 END)` | `__z` (Nullable only) |
| **String** | `MIN(LEN([col]))`, `MAX(LEN([col]))` | `__minl`, `__maxl` |
| **String** | `SUM(CASE WHEN [col] = '' THEN 1 ELSE 0 END)` | `__e` |
| **DateTime**| `MIN([col])`, `MAX([col])` | `__min`, `__max` |

## 2. Type Classification & UDT Resolution
The extension resolves User-Defined Type (UDT) aliases to base system types via `TYPE_NAME(system_type_id)`.

| Badge | Base System Types |
| :--- | :--- |
| `INT` | `int`, `bigint`, `smallint`, `tinyint` |
| `DEC` | `decimal`, `numeric`, `float`, `real`, `money` |
| `STR` | `varchar`, `nvarchar`, `char`, `nchar` |
| `DATE` | `date`, `datetime`, `datetime2`, `offset`, `time` |
| `BIT` | `bit` |
| `UUID` | `uniqueidentifier` |

## 3. Sampling Logic (Interface)
- **Method**: `TABLESAMPLE(P PERCENT)` for SQL Server/Azure. `TOP N` for Fabric DW.
- **Formula**: `P = CEIL(sampleSize / rowCount * 100)`, capped at 100.
- **Fail-safe**: Automatic retry with full scan if `TABLESAMPLE` is rejected by the database engine.

## 4. Implementation Reference
- `src/engine/profilingEngine.ts`: The SQL generation engine.
- [Microsoft SQL Server Aggregation Functions](https://learn.microsoft.com/sql/t-sql/functions/aggregate-functions-transact-sql)
