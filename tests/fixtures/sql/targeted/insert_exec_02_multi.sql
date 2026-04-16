-- INSERT EXEC Pattern 02: Multiple INSERT EXEC in sequence
-- EXPECT  targets:[etl].[SalesSnapshot],[etl].[InventorySnapshot],[etl].[CustomerSnapshot]  exec:[dbo].[usp_ExtractSales],[dbo].[usp_ExtractInventory],[reporting].[usp_GetCustomers]

DECLARE @AsOf DATETIME2 = SYSUTCDATETIME();

-- First population: Sales
TRUNCATE TABLE [etl].[SalesSnapshot];
INSERT INTO [etl].[SalesSnapshot] ([OrderID],[LineID],[ProductID],[Qty],[Amount],[Territory],[AsOf])
EXEC [dbo].[usp_ExtractSales] @SnapshotDate = @AsOf, @IncludePending = 1;

-- Second population: Inventory
TRUNCATE TABLE [etl].[InventorySnapshot];
INSERT INTO [etl].[InventorySnapshot] ([ProductID],[LocationID],[QtyOnHand],[QtyAllocated],[QtyAvailable],[AsOf])
EXEC [dbo].[usp_ExtractInventory] @SnapshotDate = @AsOf;

-- Third population: Customer dimension
TRUNCATE TABLE [etl].[CustomerSnapshot];
INSERT INTO [etl].[CustomerSnapshot] ([CustomerID],[Name],[Tier],[Region],[ActiveSince],[AsOf])
EXEC [reporting].[usp_GetCustomers] @ActiveOnly = 1, @AsOf = @AsOf;
