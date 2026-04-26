# Interface Spec: Custom DMV Queries

This document defines the SQL interface contract for live database metadata ingestion. All custom queries must return the exact column names specified below (case-insensitive).

## 1. Execution Phases
Ingestion occurs in two phases to optimize performance and wizard responsiveness.

| Phase | Queries | Responsibility |
| :--- | :--- | :--- |
| **Phase 1: Catalog** | `schema-preview`, `all-objects`, `platform-info` | Populates the selection wizard and global object catalog. |
| **Phase 2: Deep-Dive** | `nodes`, `columns`, `dependencies`, `constraints` | Loads DDL, columns, and constraints for selected schemas only. |

## 2. Column Contracts (Interface)

### Phase 1: Catalog Ingestion
- **`schema-preview`**: Returns counts for the selection wizard.
    - `schema_name`, `type_code`, `object_count`
- **`all-objects`**: Returns the full catalog for cross-schema mapping.
    - `schema_name`, `object_name`, `type_code`
- **`platform-info`**: Identifies the platform family via `engine_edition`.
    - `engine_edition`, `major_version`, `edition`

| Engine Edition | Platform |
| :--- | :--- |
| 5 | Azure SQL Database |
| 6 | Synapse Dedicated Pool |
| 11 | Fabric Data Warehouse |
| 1-4 | On-Prem SQL Server (resolved via `major_version`) |

### Phase 2: Object Detail Ingestion
- **`nodes`**: Returns the DDL body.
    - `schema_name`, `object_name`, `type_code`, `body_script` (string | null).
- **`columns`**: Returns column metadata for table design views.
    - `schema_name`, `table_name`, `column_name`, `ordinal`, `type_name`, `is_nullable`, `is_identity`, `is_computed`, `pk_ordinal` (1-based or null).
- **`dependencies`**: Returns references from `sys.sql_expression_dependencies`.
    - `referencing_schema`, `referencing_name`, `referenced_schema`, `referenced_name`, `referenced_database`.
- **`constraints`**: Returns `FK`, `UQ`, and `CK` metadata.
    - `schema_name`, `table_name`, `constraint_type`, `constraint_name`, `column_name`, `ref_schema`, `ref_table`, `ref_column`.

## 3. Implementation Reference
- `src/engine/dmvExtractor.ts`: The ingestion engine.
- `assets/dmvQueries.yaml`: The built-in query set.
- [Microsoft SQL Server DMV Reference](https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/system-dynamic-management-views)
