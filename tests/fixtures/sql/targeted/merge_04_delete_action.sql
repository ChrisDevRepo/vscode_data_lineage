-- MERGE Pattern 04: MERGE with all three actions including WHEN NOT MATCHED BY SOURCE (delete)
-- EXPECT  sources:[dbo].[EmployeeImport],[hr].[Department]  targets:[hr].[Employee]  exec:[dbo].[usp_LogMergeActivity]

DECLARE @RunID   UNIQUEIDENTIFIER = NEWID();
DECLARE @RunDate DATETIME2        = SYSUTCDATETIME();

MERGE INTO [hr].[Employee] WITH (HOLDLOCK) AS tgt
USING (
    SELECT
        ei.[EmployeeNumber],
        ei.[FirstName],
        ei.[LastName],
        ei.[Email],
        ei.[HireDate],
        ei.[TerminationDate],
        ei.[JobTitle],
        ei.[DepartmentCode],
        d.[DepartmentID]
    FROM  [dbo].[EmployeeImport] AS ei
    JOIN  [hr].[Department]      AS d  ON d.[DepartmentCode] = ei.[DepartmentCode]
    WHERE ei.[ImportBatchID] = @RunID
       OR ei.[ImportBatchID] IS NULL    -- allow null-batch full refresh
) AS src ON tgt.[EmployeeNumber] = src.[EmployeeNumber]
WHEN MATCHED AND (
        tgt.[FirstName]   <> src.[FirstName]
     OR tgt.[LastName]    <> src.[LastName]
     OR tgt.[Email]       <> src.[Email]
     OR tgt.[DepartmentID]<> src.[DepartmentID]
     OR tgt.[JobTitle]    <> src.[JobTitle]
) THEN
    UPDATE SET
        tgt.[FirstName]        = src.[FirstName],
        tgt.[LastName]         = src.[LastName],
        tgt.[Email]            = src.[Email],
        tgt.[DepartmentID]     = src.[DepartmentID],
        tgt.[JobTitle]         = src.[JobTitle],
        tgt.[ModifiedDate]     = @RunDate,
        tgt.[ModifiedByRunID]  = @RunID
WHEN NOT MATCHED BY TARGET THEN
    INSERT ([EmployeeNumber],[FirstName],[LastName],[Email],[HireDate],[JobTitle],[DepartmentID],[IsActive],[CreatedDate])
    VALUES (src.[EmployeeNumber],src.[FirstName],src.[LastName],src.[Email],src.[HireDate],src.[JobTitle],src.[DepartmentID],1,@RunDate)
WHEN NOT MATCHED BY SOURCE AND tgt.[IsActive] = 1 THEN
    UPDATE SET
        tgt.[IsActive]        = 0,
        tgt.[TerminationDate] = @RunDate;

EXEC [dbo].[usp_LogMergeActivity]
    @TableName  = N'hr.Employee',
    @RunID      = @RunID,
    @RunDate    = @RunDate;
