import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HumanMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { SubmitFindingsModelSchema } from '../../../src/ai/tools/toolSchemas';

/**
 * Regression coverage for C2: a provider that answers with a complete, schema-valid tool payload
 * fenced as prose instead of a native tool-call chunk must be promoted rather than charged a
 * synthetic `missing_required_tool_call` rejection. Fixtures below are the verbatim
 * `wire-response.text` values recorded for two of the seven UAT turns n15/n16 (minimax-m3) drew
 * that rejection against — archived at
 * test-results/archive/2026-08-17-uat-solved/trace-2026-08-17T13-27-30-205Z.ndjson.
 */

// n15, requestId 8216d38d…, seq 11 — spRefreshSegments, no column_flow (BB shape).
const N15_ACTIVE_PAYLOAD = "\n\n```json\n{\n  \"focus_node_id\": \"[ai].[sprefreshsegments]\",\n  \"verdict\": \"analyze\",\n  \"summary\": \"spRefreshSegments rebuilds ai.CustomerSegmentMap from active CustomerMaster rows, classifying each (CustomerTier, RegionCode) pair into a SegmentName via a five-branch CASE and a three-tier Priority.\",\n  \"sections\": [\n    {\n      \"angle\": \"business\",\n      \"text\": \"## Business role\\n`ai.spRefreshSegments` is a maintenance procedure that fully rebuilds the `ai.CustomerSegmentMap` lookup table from the current snapshot of active customers in `ai.CustomerMaster`. Its decision objective is to keep the `(CustomerTier, RegionCode) → SegmentName` mapping authoritative and consistent with the live customer base, so that downstream reporting — including the `CustomerSegment` enrichment on `ai.FactSalesReport` — always classifies orders against a current, deduplicated tier/region catalogue.\\n\\nThe procedure follows a truncate-and-reload pattern: it first empties the mapping table and then re-inserts a fresh, deduplicated set of rows. Because `CustomerSegmentMap` is the lookup consumed by `spBuildSalesReport Step 4`, this routine is what guarantees that every tier/region pair seen in sales has a defined segment label.\\n\\n## Segment classification rule (the core business logic)\\nThe `SegmentName` column is computed by a five-branch `CASE` that combines the customer's `CustomerTier` with their `RegionCode`:\\n\\n$$\\n\\\\text{SegmentName} = \\\\begin{cases}\\n\\\\text{'High-Value Domestic'}   & \\\\text{if } \\\\text{Tier}=\\\\text{'Premium'} \\\\land \\\\text{Region} \\\\in \\\\{\\\\text{'US'}, \\\\text{'UK'}, \\\\text{'DE'}\\\\} \\\\\\\\\\n\\\\text{'High-Value International'} & \\\\text{if } \\\\text{Tier}=\\\\text{'Premium'} \\\\\\\\\\n\\\\text{'Core Domestic'}        & \\\\text{if } \\\\text{Tier}=\\\\text{'Standard'} \\\\land \\\\text{Region} \\\\in \\\\{\\\\text{'US'}, \\\\text{'UK'}, \\\\text{'DE'}\\\\} \\\\\\\\\\n\\\\text{'Core International'}   & \\\\text{if } \\\\text{Tier}=\\\\text{'Standard'} \\\\\\\\\\n\\\\text{'Other'}                & \\\\text{otherwise}\\n\\\\end{cases}\\n$$\\n\\nIn business terms:\\n\\n1. **High-Value Domestic** — `Premium` customers in the three home/priority regions (US, UK, DE). These are the most strategically protected accounts: top spend tier in the geographies the business treats as core markets.\\n2. **High-Value International** — `Premium` customers outside US/UK/DE. Same revenue priority, different geographic classification; the business still wants them visible but distinct from the home-market premium cohort.\\n3. **Core Domestic** — `Standard` tier customers in US/UK/DE. The high-volume bread-and-butter of the core regions.\\n4. **Core International** — `Standard` tier customers outside US/UK/DE.\\n5. **Other** — the catch-all bucket. Because the predicate `cm.IsActive = 1` filters out inactive customers, every row in the mapping originates from an active record; the `Other` bucket therefore catches active customers whose tier is neither `Premium` nor `Standard`, not the inactive population.\\n\\n## Priority rule\\nA second `CASE` produces a numeric `Priority` for ordering/weighting downstream:\\n\\n$$\\n\\\\text{Priority} = \\\\begin{cases}\\n1 & \\\\text{if } \\\\text{Tier}=\\\\text{'Premium'} \\\\\\\\\\n2 & \\\\text{if } \\\\text{Tier}=\\\\text{'Standard'} \\\\\\\\\\n3 & \\\\text{otherwise}\\n\\\\end{cases}\\n$$\\n\\nLower number = higher priority. The Premium cohort is always ranked above Standard, and any tier that is not Premium/Standard receives the lowest priority (`3`). The Priority field is independent of the region split — geography does not affect ranking.\\n\\n## Deduplication and key uniqueness\\nThe `INSERT` uses `SELECT DISTINCT` over `(CustomerTier, RegionCode, SegmentName, Priority)`. The DDL only guarantees uniqueness of the *output* rows, not of the composite key alone. In practice the procedure relies on the assumption that each active customer contributes exactly one `(Tier, Region)` pair, so distinct rows collapse to one mapping entry per tier/region combination. Because of `DISTINCT`, if two customers share the same `(Tier, Region)` and the same derived `(SegmentName, Priority)`, only one row survives — which is exactly what a lookup table needs.\\n\\n## Upstream assumptions\\n- `ai.CustomerMaster` is the single source of truth for tier and region values; any new tier label introduced upstream will be classified by the `ELSE` branch as `'Other'` with `Priority = 3`, which is the safe default but means new tier values silently lose their commercial distinction in reporting.\\n- The filter `cm.IsActive = 1` means inactive customers do not contribute to the mapping at all. Sales attributed to inactive customers will not find a row in `CustomerSegmentMap` and will therefore fall through to whatever null/unclassified handling exists at the join site (in `spBuildSalesReport`), not in this procedure.\\n\\n## Downstream effects\\n- The freshly loaded `ai.CustomerSegmentMap` is the lookup consumed by `spBuildSalesReport` to label every fact row with a `CustomerSegment`.\\n- Because the table is fully truncated and rebuilt on each refresh, any prior edits to `CustomerSegmentMap` are lost — this is a single-source-of-truth refresh, not an additive merge.\\n\\n## Lifecycle / audit\\nAt the end of execution the procedure calls `ai.spLogAudit` with `@EventType = 'REFRESH'`, `@ObjectName = 'CustomerSegmentMap'`, and `@AffectedRows = @@ROWCOUNT`. This records a per-run audit entry capturing how many tier/region pairs are now in the mapping — useful as a freshness signal and as a guard against silent regressions (e.g., if a bad tier data load drops the row count).\\n\\n## ⚠️ Material risks\\n- **Silent re-labelling when tiers change.** Because the mapping is rebuilt from current `CustomerMaster` state, any retroactive change to a customer's `CustomerTier` or `RegionCode` immediately changes their segment classification in all subsequently built fact rows. There is no versioning or effective-date on `CustomerSegmentMap`, so historical segment attribution is not reproducible from this procedure alone.\\n- **The 'Unclassified' / 'Anonymous' fall-back is *not* produced here.** The DDL of `spRefreshSegments` only ever writes one of five values into `SegmentName`; the literal labels `Unclassified` and `Anonymous` are not present in this procedure. Any order that ends up labelled with those values does so because the `(CustomerTier, RegionCode)` pair could not be matched against `CustomerSegmentMap` at the consumer side (typically a LEFT JOIN in `spBuildSalesReport` with a `NULL`-handling `CASE`). The 'Unclassified' / 'Anonymous' rule therefore lives at the join site, not in this refresh routine.\\n- **`SELECT DISTINCT` masks data-quality issues.** Duplicate `(Tier, Region)` rows in `CustomerMaster` are silently collapsed; a customer appearing twice with conflicting tiers would only ever contribute one tier/region combination to the mapping, and the conflict itself is invisible in the output.\"\n    }\n  ],\n  \"route_requests\": [\n    {\n      \"nodeId\": \"[ai].[customermaster]\",\n      \"question\": \"What are the full enumerated values of CustomerTier and RegionCode in ai.CustomerMaster, and does ai.CustomerMaster itself ever store 'Unclassified' or 'Anonymous' as tier/region labels that would then propagate through spRefreshSegments and into CustomerSegmentMap? Resolves whether the 'Unclassified'/'Anonymous' fall-back observed in spBuildSalesReport originates from inactive customers, from a NULL tier/region, or from a value introduced upstream in the master.\"\n    }\n  ],\n  \"prune_neighbors\": [\"[ai].[splogaudit]\"],\n  \"badge_label\": \"Segment classifier refresh\"\n}\n```";

// n16, requestId b0cdfc74…, seq 11 — vwRawOrders, carries column_flow (CT shape).
const N16_COLUMN_FLOW_PAYLOAD = "\n\n```json\n{\n  \"focus_node_id\": \"[ai].[vwraworders]\",\n  \"verdict\": \"passthrough\",\n  \"summary\": \"ai.vwRawOrders is a SELECT * passthrough from ai.CleanedOrders with a WHERE IsValid = 1 quality filter; OrderQty flows through unchanged.\",\n  \"column_flow\": [\n    {\n      \"out_col\": \"OrderQty\",\n      \"upstream_columns\": [\n        { \"node\": \"[ai].[cleanedorders]\", \"col\": \"OrderQty\" }\n      ]\n    }\n  ],\n  \"sections\": [\n    {\n      \"angle\": \"business\",\n      \"text\": \"ai.vwRawOrders is a thin, SELECT-only passthrough view whose sole purpose is to expose only the rows of ai.CleanedOrders that have passed data-quality validation, while leaving every column value untouched. The view expresses this intent with a single row predicate:\\n\\n$$ \\\\text{rows exposed} = \\\\{\\\\, r \\\\in \\\\text{CleanedOrders} \\\\mid r.\\\\text{IsValid} = 1 \\\\,\\\\} $$\\n\\nThis is not a transformation — it is a quality gate. The clause `WHERE IsValid = 1` removes flagged/invalid orders from what downstream consumers can see, but the column values that survive the filter (including OrderQty) are passed through byte-for-byte from CleanedOrders. No arithmetic, no SUM, no COALESCE, no CASE, no rename and no aggregation is applied to OrderQty inside this view — the SQL is literally `SELECT * FROM ai.CleanedOrders WHERE IsValid = 1`, so the producing expression for OrderQty reduces to the identity mapping OrderQty ← CleanedOrders.OrderQty.\\n\\nBusiness intent — why this rule exists. The view sits in the lineage between the cleaning stage (CleanedOrders) and the staging load (spLoadSalesStaging, which truncates and reloads ai.SalesStaging from this view). It gives the loading procedure a curated, validated-only slice of orders instead of forcing the procedure to re-implement the IsValid check. Centralising the filter in the view keeps the \\\"what is a valid order?\\\" definition in one place: any consumer reading from vwRawOrders is guaranteed to only see orders where the cleaning process has set IsValid = 1.\\n\\nDownstream effect. Because spLoadSalesStaging feeds ai.SalesStaging from this view, every OrderQty that ultimately becomes a component of ai.FactSalesReport.TotalRevenue has been screened by the IsValid = 1 predicate at this hop. This means the population of OrderQty values entering the revenue chain is a strict subset of CleanedOrders.OrderQty — invalid/flagged orders are excluded from the staging table and therefore cannot contribute to TotalRevenue.\\n\\nUpstream assumption. The view assumes that CleanedOrders is the authoritative output of the cleaning step and that IsValid is the canonical validation flag. It does not, and cannot, validate the data itself — it only filters on a flag produced elsewhere. Any row in CleanedOrders with IsValid = 0 (or NULL) is invisible to vwRawOrders and to every downstream stage in the TotalRevenue chain.\\n\\nImpact on the TotalRevenue trace. OrderQty is **not** loaded as-is from a transactional orders table at this hop; it is a passthrough from CleanedOrders.OrderQty and has already been through whatever cleaning logic populates CleanedOrders. The true base table for OrderQty (e.g., whether it originates in SalesOrderDetail or another transactional source) is one hop further upstream, inside CleanedOrders — which is out of approved scope for this hop and deferred to the next hop. The current hop's finding is unambiguous: vwRawOrders applies no transform to OrderQty other than the IsValid = 1 row filter, so the hop is a structural passthrough.\"\n    }\n  ],\n  \"route_requests\": []\n}\n```";

// n15, requestId 8216d38d…, seq 14 — spLoadSalesStaging; a real evidence example of a fenced,
// otherwise well-formed payload that still fails the tool's own schema (`badge_label` at 55 chars
// against a 50-char max), so it must stay on today's unpromoted rejection path.
const N15_SCHEMA_INVALID_PAYLOAD = "\n\n```json\n{\n  \"badge_label\": \"spLoadSalesStaging — staging reload + date-key backfill\",\n  \"focus_node_id\": \"[ai].[sploadsalesstaging]\",\n  \"prune_neighbors\": [\"[ai].[splogaudit]\"],\n  \"route_requests\": [\n    {\n      \"nodeId\": \"[ai].[vwraworders]\",\n      \"question\": \"What columns does vwRawOrders actually expose, what cleaning/validation logic does it apply on top of CleanedOrders, and does it guarantee OrderAmount is pre-tax gross (the value consumed downstream as Discount BaseAmt)? Resolves whether spLoadSalesStaging inherits validated data or whether the staging layer still needs its own guards.\"\n    },\n    {\n      \"nodeId\": \"[ai].[dimcalendar]\",\n      \"question\": \"Is FullDate a unique key on DimCalendar and does the table contain every OrderDate value that vwRawOrders can emit? Resolves the INNER JOIN outcome in spLoadSalesStaging — specifically, whether every staged row receives a non-NULL OrderDateKey or whether some silently fall out of the date join.\"\n    }\n  ],\n  \"sections\": [\n    {\n      \"angle\": \"business\",\n      \"text\": \"**Domain role and decision objective.** `ai.spLoadSalesStaging` is the staging-refresh procedure that rehydrates `ai.SalesStaging` from the upstream cleaned view `ai.vwRawOrders` and decorates each row with a surrogate date key for downstream fact-table joins. The procedure exists to give the analytical layer a stable, reloadable snapshot of cleaned orders with `OrderDateKey` populated, decoupled from the raw order source.\\n\\n**Business rule 1 — full reload (TRUNCATE then INSERT).** The procedure opens with `TRUNCATE TABLE ai.SalesStaging` and then `INSERT INTO ai.SalesStaging (...) SELECT ... FROM ai.vwRawOrders v`. Business meaning: every successful execution represents the *entire* current state from `vwRawOrders`, never a delta. There is no merge, no incremental key filter, no soft-delete column. The staging table therefore carries no history beyond the most recent load — it is a point-in-time projection of the cleaned-order feed. Downstream consumers (`vwDiscountCalc`, `spBuildSalesReport`, ultimately `FactSalesReport`) read from this point-in-time snapshot.\\n\\n**Business rule 2 — explicit column contract.** Despite the surrounding comments describing this as a \\\"SELECT * passthrough\\\", the INSERT enumerates exactly seven columns: `(OrderQty, OrderAmount, RegionCode, OrderDate, CustomerID, CustomerName, IsValid)`. Business meaning: the staging schema is locked to these seven attributes; any additional columns that `vwRawOrders` may expose are silently dropped at this boundary. `OrderDateKey` is *not* in the INSERT list because it is populated by the subsequent UPDATE. `IsValid` *is* in the INSERT list — the procedure stages invalid rows alongside valid ones and does not filter on `IsValid` itself.\\n\\n**Business rule 3 — OrderDateKey derivation via DimCalendar lookup.** After the INSERT, the procedure runs:\\n\\n```sql\\nUPDATE s\\nSET s.OrderDateKey = dc.DateKey\\nFROM ai.SalesStaging s\\nINNER JOIN ai.DimCalendar dc ON s.OrderDate = dc.FullDate;\\n```\\n\\nThe transformation, expressed precisely, is:\\n\\n$$\\nOrderDateKey_i = \\\\begin{cases} dc.DateKey & \\\\text{if } \\\\exists\\\\, dc \\\\in DimCalendar \\\\text{ such that } dc.FullDate = s_i.OrderDate \\\\\\\\ NULL & \\\\text{otherwise} \\\\end{cases}\\n$$\\n\\nBusiness meaning: the procedure converts the natural date (`OrderDate`) into the surrogate integer key (`OrderDateKey`) so that `FactSalesReport` can join to the date dimension by key rather than by date value — a standard star-schema optimization. The INNER JOIN is consequential: any staged row whose `OrderDate` does not exactly match a `DimCalendar.FullDate` is left with a NULL `OrderDateKey` and, by extension, will be unable to join to date-dimension attributes downstream. The procedure does not validate `OrderDate` is non-NULL before the join.\\n\\n**Business rule 4 — audit logging of the backfill row count.** The procedure closes with `EXEC ai.spLogAudit @EventType = 'LOAD', @ObjectName = 'SalesStaging', @AffectedRows = @@ROWCOUNT`. `@@ROWCOUNT` reflects the most recent statement — the UPDATE, not the INSERT. The audit signal that reaches `spLogAudit` is therefore:\\n\\n$$\\nAuditAffectedRows = \\\\big|\\\\{ s \\\\in SalesStaging : s.OrderDate \\\\in DimCalendar.FullDate \\\\}\\\\big|\\n$$\\n\\nBusiness meaning: the logged \\\"load\\\" row count is actually the *date-key-match count*, not the inserted count. If many orders have `OrderDate` values missing from `DimCalendar`, the audit log will understate the true load volume.\\n\\n**Upstream assumptions.** `vwRawOrders` is assumed to already carry cleaned/validated data (the surrounding comments call it \\\"CleanedOrders — all columns pass through\\\"); `spLoadSalesStaging` performs no validation of its own and trusts the upstream cleaning. `DimCalendar` is assumed to be a complete calendar with `FullDate` covering every `OrderDate` value the source can emit. `IsValid` is loaded but never filtered, so invalid rows are present in the staging table alongside valid ones — any downstream filter on `IsValid` is the responsibility of the fact-build path, not this procedure.\\n\\n**Downstream effects.** `SalesStaging.OrderAmount` is the value consumed by `vwDiscountCalc.BaseAmt` (per prior hop memory), so the semantic of `OrderAmount` as emitted by `vwRawOrders` — pre-tax gross, net, or list — directly determines the discount-base assumption in the fact build. `SalesStaging.OrderDateKey` is what eventually becomes `FactSalesReport.OrderDateKey` through the fact-build pipeline, so the INNER JOIN on `OrderDate = FullDate` is the gate that admits a row into date-keyed analytical reporting.\\n\\n**Material risks.**\\n\\n- ⚠️ The INNER JOIN to `DimCalendar` silently leaves `OrderDateKey` NULL for any row whose `OrderDate` is not present in the date dimension; those rows reach `FactSalesReport` without a date key and are at risk of being dropped or NULL-keyed in any further date-key join — not established from the available SQL how the fact build handles NULL `OrderDateKey`.\\n- ⚠️ The audit `@@ROWCOUNT` reflects the UPDATE (date-key backfill), not the INSERT (load); an operations dashboard reading this audit row count as \\\"rows loaded\\\" will systematically undercount whenever date mismatches occur.\\n- ⚠️ The TRUNCATE+INSERT is not wrapped in an explicit transaction in the DDL; a mid-reload failure leaves `SalesStaging` empty rather than at its prior state — not established whether the calling orchestration supplies the transaction boundary.\"\n    }\n  ],\n  \"summary\": \"spLoadSalesStaging performs a full TRUNCATE+reload of SalesStaging from vwRawOrders with an explicit 7-column contract, then INNER JOINs DimCalendar on OrderDate=FullDate to backfill OrderDateKey (NULL for unmatched dates), and finally logs the UPDATE row count via spLogAudit.\",\n  \"verdict\": \"analyze\"\n}\n```";

// azure-foundry, test-results/e2e/arm-ed5fe880/run-T8 lm-trace generation 13 (phase=active) — the
// whole message body is the payload, with no fence at all. Verbatim `wire-response.text`.
const T8_UNFENCED_PAYLOAD = "{\"focus_node_id\":\"[ai].[vwexternalorders]\",\"verdict\":\"analyze\",\"badge_label\":\"External order union\",\"column_flow\":[{\"out_col\":\"Amount\",\"upstream_columns\":[{\"node\":\"[ai].[saporders]\",\"col\":\"Amount\"},{\"node\":\"[ai].[oracleorders]\",\"col\":\"TotalValue\"}]}],\"route_requests\":[{\"nodeId\":\"[ai].[saporders]\",\"question\":\"Does [ai].[SAPOrders] supply `Amount` directly with no change? Resolves whether the SAP branch is the base source for the Amount chain.\"},{\"nodeId\":\"[ai].[oracleorders]\",\"question\":\"Does [ai].[OracleOrders].`TotalValue` feed `Amount` only through the alias `TotalValue AS Amount`? Resolves whether the Oracle branch is a pure rename in the Amount chain.\"},{\"nodeId\":\"[ai].[spimportorders]\",\"question\":\"Does [ai].[spImportOrders] carry this view's `Amount` into `RawAmount` unchanged? Resolves the next downstream consumer in the Amount chain.\"}],\"sections\":[{\"angle\":\"business\",\"text\":\"[ai].[vwExternalOrders] is a consolidation view that exposes external orders in one shared shape so the business can treat `Amount` as a single reporting field across source systems. The view does not recalculate the value; it preserves the SAP measure directly in one branch and normalizes the Oracle measure into the same column name in the other branch.\\n\\nFor the SAP branch, the DDL shows a direct projection: `SELECT OrderID, Quantity, Amount, RegionCode, OrderDate, 'SAP' AS SourceSystem FROM ai.SAPOrders`. For the Oracle branch, the same business field is exposed by rename only: `TotalValue     AS Amount`. The value relationship can therefore be read as:\\n\\n$$\\\\text{Amount} = \\\\text{ai.SAPOrders.Amount}$$\\n\\nfor SAP-origin rows, and\\n\\n$$\\\\text{Amount} = \\\\text{ai.OracleOrders.TotalValue}$$\\n\\nfor Oracle-origin rows. The important business effect is that downstream consumers see one `Amount` column even though the underlying source terminology differs (`Amount` versus `TotalValue`).\\n\\n`UNION ALL` means the two feeds are appended rather than deduplicated, so this view preserves every incoming row from both systems. No SQL here shows cross-source reconciliation, conversion, or precedence logic, so any assumption that the SAP and Oracle values are already comparable is not established from the available SQL.\"}],\"summary\":\"[ai].[vwExternalOrders] carries `Amount` into a unified external-orders view by reading `ai.SAPOrders.Amount` directly and aliasing `ai.OracleOrders.TotalValue` as `Amount`, with both branches preserved by `UNION ALL`.\"}";

// azure-foundry, test-results/e2e/baseline-3bb5efb6/run-T7 lm-trace generation 14 (phase=active) —
// unfenced and well-formed JSON that still omits `focus_node_id`, so the tool's own schema rejects
// it and it must stay on the unpromoted rejection path. Verbatim `wire-response.text`.
const T7_UNFENCED_SCHEMA_INVALID_PAYLOAD = "{\n  \"sections\": [\n    {\n      \"angle\": \"business\",\n      \"text\": \"[ai].[spRefreshPrices] is the procedure that refreshes `PriceMaster.ListPrice` from active supplier cost rows so the stored list price stays current and reflects the active markup rule before it is written back to `PriceMaster`.\\n\\nThe current source selection is explicit: it only loads supplier rows where `sp.EffectiveTo IS NULL`, so the cost basis is the currently open supplier price, not a closed historical row. It also requires `sp.Currency = cc.Code` and `cc.IsBase = 1`, but the DDL labels `CurrencyConfig` as filter-only, so that join gates which rows are accepted without contributing any numeric value to `ListPrice`. The procedure also pairs each supplier row with `RegionLookup` via `CROSS JOIN ai.RegionLookup r`, which means the pricing refresh is region-aware before the markup is applied.\\n\\nThe actual price calculation is a single markup formula:\\n$$\\n\\\\text{ListPrice} = \\\\text{CostPrice} \\\\times \\\\bigl(1 + \\\\mathrm{COALESCE}(\\\\text{MarkupPct}, 0.15)\\\\bigr)\\n$$\\nHere, `CostPrice` comes from `ai.SupplierPrices`, `MarkupPct` comes from `ai.MarkupRules`, and the `0.15` fallback means a 15% markup is used when no active rule is found. The rule selector for markup is `m.ValidTo IS NULL`, so the procedure is using the current active markup row for the region; if no row matches, the default markup still produces a price.\\n\\nThe refreshed value is then merged into `ai.PriceMaster` using `ProductCode`, `RegionCode`, and `EffectiveFrom` as the match key. When a row already exists, the procedure updates `tgt.ListPrice`; when it does not, it inserts a new row with the computed `ListPrice`. That means the visible SQL does not show a separate alternate pricing branch or a second source-side price choice that would override the computed value. The only active adjustment in the executed logic is the markup percentage, plus the 15% fallback; the commented legacy `SalesStaging` path is not part of the current execution.\"\n    }\n  ],\n  \"summary\": \"[ai].[spRefreshPrices] rebuilds `PriceMaster.ListPrice` from active supplier costs plus active region markup, defaulting to 15% when no markup exists.\",\n  \"badge_label\": \"Refresh price calc\",\n  \"verdict\": \"analyze\",\n  \"column_flow\": [\n    {\n      \"out_col\": \"ListPrice\",\n      \"writes_to\": {\n        \"node\": \"[ai].[pricemaster]\",\n        \"col\": \"ListPrice\"\n      },\n      \"upstream_columns\": [\n        {\n          \"node\": \"[ai].[supplierprices]\",\n          \"col\": \"CostPrice\"\n        },\n        {\n          \"node\": \"[ai].[markuprules]\",\n          \"col\": \"MarkupPct\"\n        }\n      ]\n    }\n  ],\n  \"route_requests\": [\n    {\n      \"nodeId\": \"[ai].[supplierprices]\",\n      \"question\": \"Does `[ai].[SupplierPrices]` provide the active cost row selected by `sp.EffectiveTo IS NULL` for `ListPrice`, and are there any duplicate or alternate supplier cost rows for the same product/currency that would change the `CostPrice` input used by `spRefreshPrices`?\"\n    },\n    {\n      \"nodeId\": \"[ai].[markuprules]\",\n      \"question\": \"Does `[ai].[MarkupRules]` provide the active region rule selected by `m.ValidTo IS NULL` for `ListPrice`, and is `MarkupPct` the only adjustment applied beyond the `COALESCE(..., 0.15)` fallback?\"\n    }\n  ]\n}";

// local-mlx (Hermes grammar), test-results/e2e/m0-7a96609-local-mlx/run-T5/lm-trace/
// trace-2026-09-05T18-41-02-373Z.ndjson line 46 (phase=active) -- a complete, schema-valid
// call carried in the Hermes/XML <tool_call><function=...><parameter=...> envelope instead of
// fenced or unfenced JSON. Verbatim wire-response.text.
const T5_XML_ENVELOPE_PAYLOAD = "<tool_call>\n<function=lineage_submit_findings>\n<parameter=focus_node_id>\n[ai].[spimportorders]\n</parameter>\n<parameter=sections>\n[{\"angle\": \"business\", \"text\": \"**Business Role & Objective**\\n`[ai].[spImportOrders]` is the central ingestion procedure for external order data. Its purpose is to extract raw order records from external systems (SAP, Oracle), apply a series of data-quality validations, and persist the cleaned batch into the staging table `[ai].[RawOrderImport]` for downstream consumption.\\n\\n**Execution Rules & Decision Logic**\\n1. **Parameter Guardrails:** The procedure enforces strict boundaries on its configuration. `@BatchSize` must be between 100 and 1,000,000; if outside this range, it silently resets to 10,000 and logs a warning. `@LookbackDays` is capped between 1 and 365, defaulting to 90 if invalid. `@SourceFilter` restricts the import to 'SAP' or 'Oracle' (or NULL for all); an invalid filter value causes an immediate abort with an error logged to `[ai].[ErrorLog]`.\\n2. **Concurrency Control:** An advisory lock (`sp_getapplock`) prevents concurrent executions of the same procedure, ensuring data integrity and preventing resource contention.\\n3. **Data Quality & Transformation:**\\n   - **Deduplication:** The procedure identifies duplicates based on a combination of `SourceSystem` and `OrderDate` (using `ROW_NUMBER()`). It also checks against existing records in `[ai].[RawOrderImport]` to prevent re-importing data unless `@ForceReimport` is set.\\n   - **Negative Quantity Correction:** Any row with a negative quantity (`RawQty < 0`) is flagged, and the quantity is forcibly corrected to 0. This is a critical data-quality intervention to prevent negative inventory or financial impacts downstream.\\n   - **Suspicious Amount Flagging:** Amounts exceeding $10,000,000 or falling below 0 are flagged with a validation message but are not rejected, allowing for manual review of potential anomalies.\\n   - **Region Validation:** Rows with `RegionCode` not found in the active regions table are flagged as 'Unknown region'.\\n4. **Dry Run Mode:** If `@DryRun` is enabled, the procedure calculates statistics (row counts, date ranges, distinct regions/sources) without committing any data to `[ai].[RawOrderImport]`, providing a safe way to preview import outcomes.\\n\\n**Upstream Assumptions**\\nThe procedure assumes that `[ai].[vwExternalOrders]` provides a unified view of external data with columns `Quantity`, `Amount`, `RegionCode`, `OrderDate`, and `SourceSystem`. It relies on `[ai].[ActiveRegions]` to define the valid set of regions for import.\\n\\n**Downstream Effects**\\nValidated data is written to `[ai].[RawOrderImport]`, which serves as the staging area for subsequent processing steps (e.g., pricing, fact table population). The procedure also logs audit events via `[ai].[spLogAudit]` and records errors in `[ai].[ErrorLog]`.\"}, {\"angle\": \"technical\", \"text\": \"**SQL Evidence & Execution Mechanics**\\n- **Extraction:** The procedure reads from `[ai].[vwExternalOrders]` using a `SELECT` statement that maps `ext.Quantity` to `RawQty` and `ext.Amount` to `RawAmount`. It filters data using a subquery against `[ai].[ActiveRegions]` (`WHERE ext.RegionCode IN (SELECT ar.RegionCode FROM ai.ActiveRegions ar WHERE ar.IsActive = 1)`) and a date range filter (`ext.OrderDate >= DATEADD(DAY, -@LookbackDays, GETDATE())`).\\n- **Validation Logic:**\\n  - **Deduplication:** Uses `ROW_NUMBER() OVER (PARTITION BY ext.SourceSystem, ext.OrderDate ORDER BY ext.OrderID)` to assign `RowSeq`. Rows with `RowSeq > 1` are marked as duplicates and deleted.\\n  - **Negative Qty Correction:** `UPDATE #RawBatch SET RawQty = 0 WHERE RawQty < 0;`\\n  - **Suspicious Amounts:** `UPDATE #RawBatch SET ValidationMessage = ... WHERE RawAmount > 10000000 OR RawAmount < 0;`\\n- **Insertion:** Validated rows (`IsValidated = 1`) are inserted into `[ai].[RawOrderImport]` in a single batch operation.\\n- **Retry Logic:** Both the extraction (Step 1) and insertion (Step 3) steps include retry logic with a maximum of `@MaxRetries` (default 3) and a 2-second delay between retries to handle transient failures.\\n\\n**Loading Pattern**\\nThe procedure uses an **append** pattern for `[ai].[RawOrderImport]`, inserting new validated rows without updating or deleting existing records (unless `@ForceReimport` is used, which triggers a deduplication check against the target table).\\n\\n**Structural Callouts**\\n- **⚠️ Silent Value Overwrite:** The procedure overwrites `RawQty` with 0 for negative values without raising an error, which could mask data quality issues if not monitored.\\n- **⚠️ Non-Determinism:** The use of `GETDATE()` in the date filter means the result set can vary depending on when the procedure is executed, potentially leading to inconsistent imports if run multiple times within the same lookback window.\\n- **⚠️ Swallowed Errors:** The `TRY...CATCH` blocks handle transient errors by retrying, but if all retries fail, the procedure logs the error and returns, potentially leaving the batch in an incomplete state without further notification.\"}]\n</parameter>\n<parameter=summary>\nspImportOrders extracts external orders via vwExternalOrders, filters by ActiveRegions, validates data (dedup, negative qty correction, suspicious amount flagging), and appends validated rows to RawOrderImport, while logging errors to ErrorLog and audit events via spLogAudit.\n</parameter>\n<parameter=verdict>\nanalyze\n</parameter>\n<parameter=route_requests>\n[{\"nodeId\": \"[ai].[vwexternalorders]\", \"question\": \"What columns does vwExternalOrders expose, and how does it map external source data (SAP/Oracle) to the unified view consumed by spImportOrders?\"}, {\"nodeId\": \"[ai].[activeregions]\", \"question\": \"What columns and filter logic does ActiveRegions provide, and how does it determine which regions are eligible for import?\"}, {\"nodeId\": \"[ai].[raworderimport]\", \"question\": \"What is the structure of RawOrderImport, and how does it store the imported order data for downstream consumption?\"}, {\"nodeId\": \"[ai].[errorlog]\", \"question\": \"What columns does ErrorLog capture, and how does it record errors generated by spImportOrders?\"}, {\"nodeId\": \"[ai].[splogaudit]\", \"question\": \"What parameters does spLogAudit accept, and how does it record audit events for the import process?\"}]\n</parameter>\n<parameter=prune_neighbors>\n[]\n</parameter>\n<parameter=badge_label>\nspImportOrders Analysis\n</parameter>\n</function>";

const SUBMIT_FINDINGS_TOOL = {
  name: 'lineage_submit_findings',
  description: 'Submit findings for the current focus node.',
  inputSchema: SubmitFindingsModelSchema,
};

/** A hand-tracked native `vscode.lm` stream yielding text and/or native tool-call parts in order. */
function trackedStream(chunks: readonly (string | vscode.LanguageModelToolCallPart)[]): AsyncIterable<unknown> {
  let index = 0;
  const iterator = {
    async next() {
      if (index >= chunks.length) return { done: true, value: undefined };
      const chunk = chunks[index];
      index += 1;
      const value = typeof chunk === 'string' ? new vscode.LanguageModelTextPart(chunk) : chunk;
      return { done: false, value };
    },
    async return() {
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() { return this; },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

function portOver(chunks: readonly (string | vscode.LanguageModelToolCallPart)[]) {
  const sendRequest = vi.fn().mockResolvedValue({ stream: trackedStream(chunks) });
  const model = {
    id: 'publisher.exact', name: 'Exact', vendor: 'test', family: 'scripted', version: '1',
    sendRequest,
  };
  return new VscodeModelPort(model as never);
}

describe('VscodeModelPort prose tool-call promotion (C2)', () => {
  it('promotes a fenced submit_findings payload with no column_flow (UAT n15, spRefreshSegments)', async () => {
    const port = portOver([N15_ACTIVE_PAYLOAD]);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('analyze')],
      tools: [SUBMIT_FINDINGS_TOOL],
      toolChoice: 'required',
      phase: 'scoping',
    });

    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ finishReason: 'tool-calls' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ valid: true, toolName: 'lineage_submit_findings' });
    expect((result.toolCalls[0] as { input: { focus_node_id: string } }).input.focus_node_id)
      .toBe('[ai].[sprefreshsegments]');
    expect(result.text).toBe('');
  });

  it('promotes a fenced submit_findings payload carrying column_flow (UAT n16, vwRawOrders)', async () => {
    const port = portOver([N16_COLUMN_FLOW_PAYLOAD]);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('analyze')],
      tools: [SUBMIT_FINDINGS_TOOL],
      toolChoice: 'required',
      phase: 'scoping',
    });

    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ finishReason: 'tool-calls' });
    expect(result.toolCalls).toHaveLength(1);
    const call = result.toolCalls[0] as { valid: true; input: { column_flow?: unknown[] } };
    expect(call.valid).toBe(true);
    expect(call.input.column_flow).toHaveLength(1);
  });

  it('promotes an unfenced submit_findings payload that is the whole message body (T8, vwExternalOrders)', async () => {
    const port = portOver([T8_UNFENCED_PAYLOAD]);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('analyze')],
      tools: [SUBMIT_FINDINGS_TOOL],
      toolChoice: 'required',
      phase: 'scoping',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'tool-calls' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ valid: true, toolName: 'lineage_submit_findings' });
    expect((result.toolCalls[0] as { input: { focus_node_id: string } }).input.focus_node_id)
      .toBe('[ai].[vwexternalorders]');
    expect(result.text).toBe('');
  });

  it('does not promote an unfenced payload that fails the tool schema (T7, no focus_node_id)', async () => {
    const port = portOver([T7_UNFENCED_SCHEMA_INVALID_PAYLOAD]);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('analyze')],
      tools: [SUBMIT_FINDINGS_TOOL],
      toolChoice: 'required',
      phase: 'scoping',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', toolCalls: [] });
    expect(result.text).toBe(T7_UNFENCED_SCHEMA_INVALID_PAYLOAD);
  });

  it('does not promote prose with no fenced JSON block', async () => {
    const prose = 'The focus node applies a straightforward passthrough with no further logic.';
    const port = portOver([prose]);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('analyze')],
      tools: [SUBMIT_FINDINGS_TOOL],
      toolChoice: 'required',
      phase: 'scoping',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', toolCalls: [] });
    expect(result.text).toBe(prose);
  });

  it('does not promote a fenced payload that fails the tool schema (UAT n15 badge_label overflow)', async () => {
    const port = portOver([N15_SCHEMA_INVALID_PAYLOAD]);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('analyze')],
      tools: [SUBMIT_FINDINGS_TOOL],
      toolChoice: 'required',
      phase: 'scoping',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', toolCalls: [] });
    expect(result.text).toBe(N15_SCHEMA_INVALID_PAYLOAD);
  });

  it('does not promote invalid JSON inside a fence', async () => {
    const prose = '```json\n{ not: valid json }\n```';
    const port = portOver([prose]);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('analyze')],
      tools: [SUBMIT_FINDINGS_TOOL],
      toolChoice: 'required',
      phase: 'scoping',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'stop', toolCalls: [] });
    expect(result.text).toBe(prose);
  });

  it('leaves a generation that already emits a real tool call byte-identical', async () => {
    const realCall = new vscode.LanguageModelToolCallPart(
      'call-1',
      'lineage_submit_findings',
      { focus_node_id: 'x', sections: [], summary: 's', verdict: 'analyze' },
    );
    // Prose alongside the real call also happens to contain a schema-valid fenced payload; the real
    // tool-call part must still win outright and promotion must never run.
    const port = portOver(['some preamble ' + N16_COLUMN_FLOW_PAYLOAD, realCall]);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('analyze')],
      tools: [SUBMIT_FINDINGS_TOOL],
      toolChoice: 'required',
      phase: 'scoping',
    });

    expect(result).toMatchObject({ finishReason: 'tool-calls' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ valid: true, callId: 'call-1', toolName: 'lineage_submit_findings' });
    expect(result.text).toBe('some preamble ' + N16_COLUMN_FLOW_PAYLOAD);
  });

  it('promotes a Hermes/XML <function=…> envelope (m0 T5, spImportOrders)', async () => {
    const port = portOver([T5_XML_ENVELOPE_PAYLOAD]);
    const result = await port.generateToolTurn({
      messages: [new HumanMessage('analyze')],
      tools: [SUBMIT_FINDINGS_TOOL],
      toolChoice: 'required',
      phase: 'scoping',
    });

    expect(result).toMatchObject({ status: 'completed', finishReason: 'tool-calls' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ valid: true, toolName: 'lineage_submit_findings' });
    const call = result.toolCalls[0] as { input: { focus_node_id: string; sections: unknown[]; prune_neighbors: unknown[] } };
    expect(call.input.focus_node_id).toBe('[ai].[spimportorders]'); // raw scalar stayed a string
    expect(call.input.sections).toHaveLength(2); // JSON-text aggregate decoded
    expect(call.input.prune_neighbors).toEqual([]);
    expect(result.text).toBe('');
  });
});
