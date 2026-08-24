# spImportOrders Lineage — Multi-Source ERP Ingestion & Quality Staging

`[ai].[spImportOrders]` ingests and cleans enterprise order streams federated from SAP and Oracle ERP systems via `[ai].[vwExternalOrders]`.

## 1 ERP Data Sources

### Objects [SAPOrders](#focus-node:[ai].[saporders]), [OracleOrders](#focus-node:[ai].[oracleorders])

- **`[ai].[SAPOrders]`**: Provides native SAP sales transactions.
- **`[ai].[OracleOrders]`**: Supplies external Oracle transaction records using proprietary column names (`ItemCount`, `TotalValue`, `Area`, `TxDate`).

## 2 Federation & Normalization

### Objects [vwExternalOrders](#focus-node:[ai].[vwexternalorders])

- **Source Lineage Attribution**: Adds explicit source markers:
  $$ \text{SourceSystem} = \text{'SAP'} \quad \text{for SAP orders} $$
  $$ \text{SourceSystem} = \text{'Oracle'} \quad \text{for Oracle orders} $$
- **Schema Mapping**: Normalizes Oracle attributes to canonical field names:
  - `ItemCount` $\rightarrow$ `Quantity`
  - `TotalValue` $\rightarrow$ `Amount`

## 3 Import & Quality Orchestration

### Objects [spImportOrders](#focus-node:[ai].[spimportorders])

1. **Intra-Batch Deduplication**: Assigns sequence numbers per system and date partition:
   $$ \text{RowSeq} = \operatorname{ROW\_NUMBER}() \text{ OVER } (\operatorname{PARTITION BY} \text{SourceSystem}, \text{OrderDate} \operatorname{ORDER BY} \text{OrderID}) $$
   Rows where $\text{RowSeq} > 1$ are flagged as duplicates and purged.
2. **Negative Quantity Correction**: Clamps negative quantities to zero:
   $$ \text{RawQty} = 0 \quad \text{when} \quad \text{RawQty} < 0 $$
3. **Threshold Validation**: Flags transactions with amounts $< 0$ or $> 10,000,000$ as `'Suspicious amount'`.

| From | To | Business meaning |
| --- | --- | --- |
| `ItemCount` | `Quantity` | Units ordered |
| `TotalValue` | `Amount` | Gross order value |

```sql
SELECT OrderID, Quantity FROM ai.vwExternalOrders;
```

⚠️ **Silent Negative Quantity Clamping**: Coercing negative quantities directly to `0` can mask ERP reversal transactions.

---

### Downstream Recommendations
- **Negative Quantity Handling**: Replace the silent clamping logic ($\text{RawQty} = 0$) with a dedicated quarantine status.
