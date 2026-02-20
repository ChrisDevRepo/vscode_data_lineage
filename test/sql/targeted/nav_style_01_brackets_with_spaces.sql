-- NAV/Dynamics Style Pattern 01: Identifiers with spaces and $ inside bracket quotes
-- EXPECT  sources:[dbo].[CRONUS International Ltd_$Customer],[dbo].[CRONUS International Ltd_$Sales Header]  targets:[dbo].[CRONUS International Ltd_$Sales Line]  exec:[dbo].[CRONUS International Ltd_$Check Credit Limit]
-- Tests bracket-aware splitting: dots inside [...] are NOT separators

-- In Microsoft Dynamics NAV / Business Central, all objects are prefixed
-- with the company name: [Company Name$Table Name]
-- This exercises splitSqlName() which must preserve dots inside brackets

INSERT INTO [dbo].[CRONUS International Ltd_$Sales Line] (
    [Document Type],
    [Document No_],
    [Line No_],
    [Sell-to Customer No_],
    [Type],
    [No_],
    [Description],
    [Quantity],
    [Unit Price],
    [Line Amount]
)
SELECT
    sl.[Document Type],
    sl.[Document No_],
    sl.[Line No_],
    c.[No_],
    sl.[Type],
    sl.[No_],
    sl.[Description],
    sl.[Quantity],
    sl.[Unit Price],
    sl.[Quantity] * sl.[Unit Price]
FROM [dbo].[CRONUS International Ltd_$Sales Header] AS sl
JOIN [dbo].[CRONUS International Ltd_$Customer]    AS c
    ON c.[No_] = sl.[Sell-to Customer No_]
WHERE sl.[Status] = 1  -- Released
  AND sl.[Posting Date] = CAST(GETDATE() AS DATE);

EXEC [dbo].[CRONUS International Ltd_$Check Credit Limit]
    @CustomerNo  = N'10000',
    @DocType     = 1,
    @Amount      = 5000.00;
