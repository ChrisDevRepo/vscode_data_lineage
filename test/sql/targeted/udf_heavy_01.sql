-- UDF HEAVY Pattern 01: Multiple inline scalar UDF calls — all schema-qualified UDFs captured as sources
-- EXPECT  sources:[dbo].[Order],[dbo].[Customer],[dbo].[udf_FormatCurrency],[dbo].[udf_GetCustomerTier],[dbo].[udf_CalcTax],[dbo].[udf_FormatDate],[finance].[udf_ExchangeRate]  targets:[reporting].[InvoiceSummary]  exec:

INSERT INTO [reporting].[InvoiceSummary] (
    [InvoiceID],
    [CustomerID],
    [CustomerTier],
    [FormattedDate],
    [NetAmount],
    [TaxAmount],
    [GrossAmountUSD],
    [FormattedGross],
    [GeneratedAt]
)
SELECT
    o.[OrderID],
    c.[CustomerID],
    [dbo].[udf_GetCustomerTier](c.[CustomerID], c.[TotalSpend]),
    [dbo].[udf_FormatDate](o.[OrderDate], N'MMMM dd, yyyy'),
    o.[NetAmount],
    [dbo].[udf_CalcTax](o.[NetAmount], o.[TaxCode], o.[StateCode]),
    o.[NetAmount] * [finance].[udf_ExchangeRate](o.[CurrencyCode], N'USD', o.[OrderDate]),
    [dbo].[udf_FormatCurrency](
        o.[NetAmount] * [finance].[udf_ExchangeRate](o.[CurrencyCode], N'USD', o.[OrderDate]),
        N'USD'
    ),
    GETUTCDATE()
FROM [dbo].[Order]    AS o
JOIN [dbo].[Customer] AS c ON c.[CustomerID] = o.[CustomerID]
WHERE o.[Status] = N'POSTED'
  AND o.[OrderDate] >= DATEADD(DAY,-7,GETDATE());
