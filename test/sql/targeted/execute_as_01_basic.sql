-- EXECUTE AS Pattern 01: EXECUTE AS context declaration in SP header, followed by real EXEC
-- EXPECT  sources:[dbo].[SensitiveData]  targets:[dbo].[AuditAccess]  exec:[dbo].[usp_LogAccess]  absent:[DataOwner]

-- This simulates a SP body that starts with EXECUTE AS context switch
-- In a real dacpac, the full CREATE PROC has: WITH EXECUTE AS N'DataOwner'
-- The body seen by parser might or might not include this header

EXECUTE AS LOGIN = N'DataOwner';   -- context switch — login name must NOT be captured as exec dep

BEGIN TRY
    -- Real table read under elevated context
    INSERT INTO [dbo].[AuditAccess] ([UserRequested],[AccessTime],[DataSetName],[RowCount])
    SELECT
        ORIGINAL_LOGIN(),
        GETUTCDATE(),
        N'SensitiveData',
        COUNT(1)
    FROM [dbo].[SensitiveData]
    WHERE [ClassificationLevel] >= 3;

    EXEC [dbo].[usp_LogAccess]
        @User     = ORIGINAL_LOGIN(),
        @Resource = N'SensitiveData',
        @Success  = 1;

END TRY
BEGIN CATCH
    EXEC [dbo].[usp_LogAccess]
        @User     = ORIGINAL_LOGIN(),
        @Resource = N'SensitiveData',
        @Success  = 0,
        @Error    = ERROR_MESSAGE();
    THROW;
END CATCH;

REVERT;   -- revert context — 'REVERT' keyword, no table/proc ref
