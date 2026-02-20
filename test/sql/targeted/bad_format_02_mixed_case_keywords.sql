-- BAD FORMAT Pattern 02: Mixed case SQL keywords — sElEcT, InSeRt, FrOm etc.
-- EXPECT  sources:[dbo].[Inventory],[dbo].[Warehouse]  targets:[dbo].[StockAlert]  exec:

DeCLarE @threshold INT = 10;
DeCLarE @now DATETIME2 = SysuTcDateTiMe();

InSeRt InTo [dbo].[StockAlert] (
    [ProductID],
    [WarehouseID],
    [QtyOnHand],
    [ReorderLevel],
    [AlertDate],
    [Severity]
)
SeLeCt
    inv.[ProductID],
    wh.[WarehouseID],
    inv.[QtyOnHand],
    inv.[ReorderLevel],
    @now,
    CaSe
        WhEn inv.[QtyOnHand] = 0             ThEn N'OUT_OF_STOCK'
        WhEn inv.[QtyOnHand] < @threshold     ThEn N'CRITICAL'
        WhEn inv.[QtyOnHand] < inv.[ReorderLevel] ThEn N'LOW'
        eLsE N'OK'
    eNd
FrOm [dbo].[Inventory] AS inv
JoIn [dbo].[Warehouse]  AS wh ON wh.[WarehouseID] = inv.[WarehouseID]
WhErE inv.[QtyOnHand] <= inv.[ReorderLevel];
