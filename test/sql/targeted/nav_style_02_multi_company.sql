-- NAV/Dynamics Style Pattern 02: Multi-company NAV with complex bracketed names containing dots
-- EXPECT  sources:[dbo].[Fabrikam Inc_$Customer],[dbo].[Fabrikam Inc_$Item],[dbo].[Fabrikam Inc_$Item Ledger Entry]  targets:[dbo].[Fabrikam Inc_$Posted Sales Invoice],[dbo].[Fabrikam Inc_$Posted Sales Invoice Line]  exec:
-- Key test: [spLoadReconciliation_Case4.5] style names (dot inside brackets = part of name)

-- Note: table names contain dots inside brackets (e.g. version numbers like Case4.5)
-- splitSqlName must NOT split [dbo].[Fabrikam Inc_$Item Ledger Entry] into more than 2 parts

DECLARE @PostingDate DATE = CAST(GETDATE() AS DATE);
DECLARE @InvoiceNo   NVARCHAR(20);

-- Create posted invoice header
INSERT INTO [dbo].[Fabrikam Inc_$Posted Sales Invoice] (
    [No_],
    [Sell-to Customer No_],
    [Bill-to Customer No_],
    [Posting Date],
    [Document Date],
    [External Document No_],
    [Currency Code],
    [Amount],
    [Amount Including VAT]
)
SELECT
    N'INV-' + CONVERT(NVARCHAR, NEWID(), 32),
    c.[No_],
    c.[No_],
    @PostingDate,
    @PostingDate,
    N'',
    c.[Currency Code],
    SUM(ile.[Sales Amount (Actual)]),
    SUM(ile.[Sales Amount (Actual)]) * 1.2
FROM [dbo].[Fabrikam Inc_$Customer]          AS c
JOIN [dbo].[Fabrikam Inc_$Item Ledger Entry] AS ile
    ON ile.[Source No_] = c.[No_]
WHERE ile.[Posting Date] = @PostingDate
  AND ile.[Entry Type]   = 1  -- Sale
GROUP BY c.[No_], c.[Currency Code];

-- Create posted invoice lines from item ledger
INSERT INTO [dbo].[Fabrikam Inc_$Posted Sales Invoice Line] (
    [Document No_],
    [Line No_],
    [Type],
    [No_],
    [Description],
    [Quantity],
    [Unit Price],
    [Line Amount]
)
SELECT
    N'INV-PLACEHOLDER',
    ile.[Entry No_],
    2,   -- Item type
    i.[No_],
    i.[Description],
    ABS(ile.[Quantity]),
    i.[Unit Price],
    ABS(ile.[Quantity]) * i.[Unit Price]
FROM [dbo].[Fabrikam Inc_$Item Ledger Entry] AS ile
JOIN [dbo].[Fabrikam Inc_$Item]              AS i
    ON i.[No_] = ile.[Item No_]
WHERE ile.[Posting Date] = @PostingDate
  AND ile.[Entry Type]   = 1;
