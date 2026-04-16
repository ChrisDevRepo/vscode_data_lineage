-- MERGE Pattern 01: Basic MERGE with UPDATE and INSERT
-- EXPECT  sources:[dbo].[CustomerStaging]  targets:[dbo].[Customer]  absent:[none]

MERGE INTO [dbo].[Customer] AS tgt
USING [dbo].[CustomerStaging] AS src
    ON tgt.[CustomerID] = src.[CustomerID]
WHEN MATCHED AND src.[IsDeleted] = 0 THEN
    UPDATE SET
        tgt.[FirstName]     = src.[FirstName],
        tgt.[LastName]      = src.[LastName],
        tgt.[Email]         = src.[Email],
        tgt.[Phone]         = src.[Phone],
        tgt.[AddressLine1]  = src.[AddressLine1],
        tgt.[AddressLine2]  = src.[AddressLine2],
        tgt.[City]          = src.[City],
        tgt.[StateCode]     = src.[StateCode],
        tgt.[ZipCode]       = src.[ZipCode],
        tgt.[CountryCode]   = src.[CountryCode],
        tgt.[ModifiedDate]  = GETUTCDATE()
WHEN MATCHED AND src.[IsDeleted] = 1 THEN
    UPDATE SET
        tgt.[IsActive]      = 0,
        tgt.[DeletedDate]   = GETUTCDATE()
WHEN NOT MATCHED BY TARGET THEN
    INSERT (
        [CustomerID], [FirstName], [LastName], [Email], [Phone],
        [AddressLine1], [AddressLine2], [City], [StateCode], [ZipCode],
        [CountryCode], [IsActive], [CreatedDate], [ModifiedDate]
    )
    VALUES (
        src.[CustomerID], src.[FirstName], src.[LastName], src.[Email], src.[Phone],
        src.[AddressLine1], src.[AddressLine2], src.[City], src.[StateCode], src.[ZipCode],
        src.[CountryCode], 1, GETUTCDATE(), GETUTCDATE()
    );
