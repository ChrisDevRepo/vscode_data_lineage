-- GP Style Pattern 01: Microsoft Dynamics GP (Great Plains) cryptic table naming
-- EXPECT  sources:[dbo].[IV00101],[dbo].[IV00105],[dbo].[RM00101]  targets:[dbo].[IV30300],[dbo].[RM30101]  exec:[dbo].[taUpdateSalesOrder]
-- GP uses 2-letter module prefix + 5-digit table number as table names

-- GP table name legend:
--   IV00101 = Item Master
--   IV00105 = Item Site Master
--   RM00101 = Customer Master
--   IV30300 = Inventory Transaction History
--   RM30101 = RM Posted Transaction History

DECLARE @DEX_ROW_ID INT;
DECLARE @Time       DATETIME = GETDATE();
DECLARE @UserID     NVARCHAR(20) = SUSER_SNAME();

-- Write inventory transaction history (IV30300)
INSERT INTO [dbo].[IV30300] (
    [ITEMNMBR],
    [DOCNUMBR],
    [DOCTYPE],
    [DOCDATE],
    [TRXQTY],
    [UNITCOST],
    [EXTDCOST],
    [LOCNCODE],
    [TRXLOCTN],
    [DEX_ROW_ID]
)
SELECT
    iv.[ITEMNMBR],
    N'IVADJ' + CONVERT(NVARCHAR,NEWID(),32),
    3,   -- Inventory Adjustment
    @Time,
    iv.[QTYONHND] - ivs.[QTYONHND],
    iv.[STNDCOST],
    (iv.[QTYONHND] - ivs.[QTYONHND]) * iv.[STNDCOST],
    ivs.[LOCNCODE],
    ivs.[LOCNCODE],
    NEXT VALUE FOR [dbo].[DEX_ROW_SEQ]
FROM [dbo].[IV00101] AS iv    -- Item Master
JOIN [dbo].[IV00105] AS ivs   -- Item Site Master
    ON ivs.[ITEMNMBR] = iv.[ITEMNMBR]
WHERE ABS(iv.[QTYONHND] - ivs.[QTYONHND]) > 0.001;

-- Write AR transaction history (RM30101)
INSERT INTO [dbo].[RM30101] (
    [CUSTNMBR],
    [RMDTYPAL],
    [DOCNUMBR],
    [DOCDATE],
    [DOCAMNT],
    [CURTRXAM],
    [DEX_ROW_ID]
)
SELECT
    rm.[CUSTNMBR],
    7,   -- Posted Payment
    N'PMT' + CONVERT(NVARCHAR,NEWID(),32),
    @Time,
    rm.[CUSTCLAS],
    rm.[CUSTCLAS],
    NEXT VALUE FOR [dbo].[DEX_ROW_SEQ]
FROM [dbo].[RM00101] AS rm    -- Customer Master
WHERE rm.[INACTIVE] = 0;

EXEC [dbo].[taUpdateSalesOrder] @UserID = @UserID, @Timestamp = @Time;
