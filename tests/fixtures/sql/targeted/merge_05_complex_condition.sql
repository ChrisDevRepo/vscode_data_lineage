-- MERGE Pattern 05: MERGE with complex conditional logic and multiple schemas
-- EXPECT  sources:[stg].[Product],[ref].[Category],[ref].[Supplier]  targets:[prd].[Product],[prd].[ProductHistory]

BEGIN TRANSACTION;

BEGIN TRY
    -- Step 1: Merge core product data
    MERGE INTO [prd].[Product] AS tgt
    USING (
        SELECT
            sp.[ProductCode],
            sp.[ProductName],
            sp.[Description],
            sp.[ListPrice],
            sp.[StandardCost],
            sp.[Weight],
            sp.[Color],
            sp.[Size],
            sp.[UnitsInStock],
            sp.[ReorderLevel],
            sp.[Discontinued],
            c.[CategoryID],
            c.[CategoryName],
            s.[SupplierID],
            s.[SupplierName]
        FROM      [stg].[Product]  AS sp
        JOIN      [ref].[Category] AS c  ON c.[CategoryCode] = sp.[CategoryCode]
        LEFT JOIN [ref].[Supplier] AS s  ON s.[SupplierCode] = sp.[SupplierCode]
        WHERE sp.[IsValid] = 1
          AND sp.[LoadDate] = CAST(GETUTCDATE() AS DATE)
    ) AS src ON tgt.[ProductCode] = src.[ProductCode]
    WHEN MATCHED AND (
        tgt.[ListPrice]    <> src.[ListPrice]
     OR tgt.[StandardCost] <> src.[StandardCost]
     OR tgt.[Discontinued] <> src.[Discontinued]
    ) THEN
        UPDATE SET
            tgt.[ProductName]  = src.[ProductName],
            tgt.[Description]  = src.[Description],
            tgt.[ListPrice]    = src.[ListPrice],
            tgt.[StandardCost] = src.[StandardCost],
            tgt.[Weight]       = src.[Weight],
            tgt.[Color]        = src.[Color],
            tgt.[Size]         = src.[Size],
            tgt.[UnitsInStock] = src.[UnitsInStock],
            tgt.[ReorderLevel] = src.[ReorderLevel],
            tgt.[Discontinued] = src.[Discontinued],
            tgt.[CategoryID]   = src.[CategoryID],
            tgt.[SupplierID]   = src.[SupplierID],
            tgt.[ModifiedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ProductCode],[ProductName],[Description],[ListPrice],[StandardCost],
                [Weight],[Color],[Size],[UnitsInStock],[ReorderLevel],[Discontinued],
                [CategoryID],[SupplierID],[IsActive],[CreatedDate])
        VALUES (src.[ProductCode],src.[ProductName],src.[Description],src.[ListPrice],src.[StandardCost],
                src.[Weight],src.[Color],src.[Size],src.[UnitsInStock],src.[ReorderLevel],src.[Discontinued],
                src.[CategoryID],src.[SupplierID],1,GETUTCDATE());

    -- Step 2: Archive changed product history
    INSERT INTO [prd].[ProductHistory]
        ([ProductCode],[SnapshotDate],[ListPrice],[StandardCost],[CategoryID],[SupplierID])
    SELECT
        p.[ProductCode],
        CAST(GETUTCDATE() AS DATE),
        p.[ListPrice],
        p.[StandardCost],
        p.[CategoryID],
        p.[SupplierID]
    FROM [prd].[Product] AS p
    WHERE p.[ModifiedDate] >= DATEADD(MINUTE, -5, GETUTCDATE());

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
