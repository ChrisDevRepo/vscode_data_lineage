-- UPDATE ALIAS Pattern 02: UPDATE with multi-table JOIN, alias is not the first table in FROM
-- EXPECT  sources:[dbo].[OrderLine],[dbo].[Product],[dbo].[PriceHistory]  targets:[dbo].[OrderLine]
-- OrderLine is both source (read for join) and target (written)

UPDATE ol
SET
    ol.[UnitPrice]      = ph.[NewPrice],
    ol.[DiscountAmount] = ol.[Quantity] * (ph.[NewPrice] - ph.[OldPrice]) * 0.1,
    ol.[LineTotal]      = ol.[Quantity] * ph.[NewPrice],
    ol.[PriceAdjusted]  = 1,
    ol.[AdjustedDate]   = GETUTCDATE()
FROM        [dbo].[OrderLine]   AS ol
JOIN        [dbo].[Product]     AS p   ON p.[ProductID]  = ol.[ProductID]
JOIN        [dbo].[PriceHistory] AS ph ON ph.[ProductID] = p.[ProductID]
                                       AND ph.[EffectiveDate] = CAST(GETUTCDATE() AS DATE)
WHERE ol.[PriceAdjusted] = 0
  AND ol.[OrderDate]     >= ph.[EffectiveDate];
