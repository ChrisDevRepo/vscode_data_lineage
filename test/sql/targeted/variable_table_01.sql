-- VARIABLE TABLE Pattern: @tbl TABLE variables — must NOT be captured as deps
-- EXPECT  sources:[dbo].[Order],[dbo].[OrderLine],[dbo].[Product]  targets:[dbo].[InvoiceDraft]  exec:[dbo].[usp_ApplyDiscounts]
-- @LineItems, @Discounts, @TaxRates are @table variables — must NOT appear in results

DECLARE @LineItems TABLE (
    [OrderID]    INT,
    [ProductID]  INT,
    [Qty]        INT,
    [UnitPrice]  DECIMAL(18,2),
    [LineTotal]  DECIMAL(18,2)
);

DECLARE @Discounts TABLE (
    [ProductID]    INT,
    [DiscountPct]  DECIMAL(5,2)
);

DECLARE @TaxRates TABLE (
    [StateCode]  NVARCHAR(5),
    [Rate]       DECIMAL(5,4)
);

-- Populate @table vars from catalog tables
INSERT INTO @LineItems ([OrderID],[ProductID],[Qty],[UnitPrice],[LineTotal])
SELECT o.[OrderID], ol.[ProductID], ol.[Quantity], ol.[UnitPrice], ol.[Quantity]*ol.[UnitPrice]
FROM   [dbo].[Order]     AS o
JOIN   [dbo].[OrderLine] AS ol ON ol.[OrderID] = o.[OrderID]
WHERE  o.[Status] = N'DRAFT';

INSERT INTO @Discounts ([ProductID],[DiscountPct])
SELECT [ProductID], [DiscountPct]
FROM   [dbo].[Product]
WHERE  [HasPromotion] = 1;

-- Apply discounts (SP modifies @LineItems in-memory — no catalog dep)
EXEC [dbo].[usp_ApplyDiscounts] @Lines = @LineItems;

-- Write final invoice to catalog table
INSERT INTO [dbo].[InvoiceDraft] ([OrderID],[TotalLines],[GrossAmount],[DiscountAmount],[TaxAmount],[NetAmount],[CreatedAt])
SELECT
    li.[OrderID],
    COUNT(li.[ProductID]),
    SUM(li.[LineTotal]),
    SUM(li.[LineTotal] * ISNULL(d.[DiscountPct],0) / 100),
    0,
    SUM(li.[LineTotal] * (1 - ISNULL(d.[DiscountPct],0)/100)),
    GETUTCDATE()
FROM @LineItems AS li
LEFT JOIN @Discounts AS d ON d.[ProductID] = li.[ProductID]
GROUP BY li.[OrderID];
