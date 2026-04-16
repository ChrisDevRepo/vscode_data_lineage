-- COPY INTO Pattern 01: Fabric/Synapse COPY INTO bulk load from external storage
-- EXPECT  sources:  targets:[dbo].[SalesDataRaw]  exec:
-- COPY INTO loads data from Azure Blob/ADLS into the target table — no SQL source table

COPY INTO [dbo].[SalesDataRaw] (
    [OrderID],
    [CustomerID],
    [ProductID],
    [OrderDate],
    [Quantity],
    [UnitPrice],
    [LineTotal],
    [CurrencyCode],
    [TerritoryID],
    [SalesPersonID]
)
FROM 'https://mystorageaccount.blob.core.windows.net/salesdata/2024/01/*.parquet'
WITH (
    FILE_TYPE          = 'PARQUET',
    CREDENTIAL         = (IDENTITY = 'Managed Identity'),
    AUTO_CREATE_TABLE  = 'OFF',
    MAX_ERRORS         = 0,
    ERRORFILE_LOCATION = 'https://mystorageaccount.blob.core.windows.net/errors/'
);
