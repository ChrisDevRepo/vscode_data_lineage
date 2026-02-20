-- MULTI-EXEC Pattern 01: Long chain of sequential EXEC calls — all captured
-- EXPECT  sources:  targets:[ops].[PipelineRun]  exec:[etl].[usp_ExtractRaw],[etl].[usp_ValidateStage],[etl].[usp_TransformCustomer],[etl].[usp_TransformOrder],[etl].[usp_TransformProduct],[etl].[usp_LoadDimCustomer],[etl].[usp_LoadDimProduct],[etl].[usp_LoadFactOrder],[etl].[usp_UpdateAggregates],[dbo].[usp_SendCompletion]

DECLARE @RunID    BIGINT;
DECLARE @RunStart DATETIME2 = SYSUTCDATETIME();

INSERT INTO [ops].[PipelineRun] ([PipelineName],[RunStart],[Status])
VALUES (N'DailyETLPipeline', @RunStart, N'RUNNING');
SET @RunID = SCOPE_IDENTITY();

-- Phase 1: Extract
EXEC [etl].[usp_ExtractRaw]        @RunID = @RunID, @IncrementalOnly = 1;

-- Phase 2: Validate
EXEC [etl].[usp_ValidateStage]     @RunID = @RunID, @ThrowOnError = 1;

-- Phase 3: Transform dimensions
EXEC [etl].[usp_TransformCustomer] @RunID = @RunID;
EXEC [etl].[usp_TransformOrder]    @RunID = @RunID;
EXEC [etl].[usp_TransformProduct]  @RunID = @RunID;

-- Phase 4: Load dimensions first, then facts
EXEC [etl].[usp_LoadDimCustomer]   @RunID = @RunID;
EXEC [etl].[usp_LoadDimProduct]    @RunID = @RunID;
EXEC [etl].[usp_LoadFactOrder]     @RunID = @RunID;

-- Phase 5: Update aggregates
EXEC [etl].[usp_UpdateAggregates]  @RunID = @RunID, @FullRecalc = 0;

UPDATE [ops].[PipelineRun]
SET    [Status] = N'COMPLETE', [RunEnd] = SYSUTCDATETIME()
WHERE  [RunID] = @RunID;

EXEC [dbo].[usp_SendCompletion]    @RunID = @RunID, @Channel = N'slack';
