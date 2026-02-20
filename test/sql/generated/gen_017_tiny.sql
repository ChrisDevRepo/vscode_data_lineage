-- GENERATED SP 17: tier=tiny flags=[allCaps]
-- EXPECT  sources:[hr].[Department]  targets:[dbo].[Employee]  EXEC:[dbo].[usp_ReconcilePayments]

CREATE PROCEDURE [dbo].[usp_GenTiny_017]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO [dbo].[Employee] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [hr].[Department] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ReconcilePayments @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: hr.Department
    SELECT @RowCount = COUNT(*) FROM [hr].[Department] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO