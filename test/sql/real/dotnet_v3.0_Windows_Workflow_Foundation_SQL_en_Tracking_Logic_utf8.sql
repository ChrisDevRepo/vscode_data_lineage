-- Copyright (c) Microsoft Corporation.  All rights reserved.
SET NOCOUNT ON

/*************************************************************************************************************************************


														PSS QFE Patch Table
														All QFEs should have an entry in this table


*************************************************************************************************************************************/

-- Only create table if it doesn't exist, do not drop and recreate!
IF OBJECT_ID('SqlTrackingServiceQfeLog') IS NULL
 BEGIN
	CREATE TABLE [dbo].[SqlTrackingServiceQfeLog]
	(
		[InstallDateTime]		datetime		NOT NULL default(getutcdate())
		,[KbId]					int				NULL
		,[Description]			nvarchar(256)	NULL
	)
 END
GO

-- This script will be run on top of itself and db QFEs are cummulative so check if entry alread exists before inserting
IF NOT EXISTS (SELECT 1 FROM [dbo].[SqlTrackingServiceQfeLog] WHERE KbId=925499)
	INSERT [dbo].[SqlTrackingServiceQfeLog] ([KbId], [Description]) VALUES (925499, 'Not all stored procedures use SqlTrackingService views.')


/*************************************************************************************************************************************

		
														Type Procs


*************************************************************************************************************************************/

IF OBJECT_ID('[dbo].[GetTypeId]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetTypeId]
GO

CREATE PROCEDURE [dbo].[GetTypeId]		@TypeFullName			nvarchar(128)		
										,@AssemblyFullName		nvarchar(256)	
										,@IsInstanceType		bit = 0	
										,@TypeId				int OUTPUT
		
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_GetTypeId_Failed_InsertType nvarchar(256)
	set @localized_string_GetTypeId_Failed_InsertType = N'Failed inserting TypeId'

	declare @localized_string_GetTypeId_Failed_SelectType nvarchar(256)
	set @localized_string_GetTypeId_Failed_SelectType = N'Failed selecting TypeId'

	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			int
			,@id			int

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END
	/*
		Most of the time this will return a value and we won't attempt the insert
		It's true that since the index specifies ignore dup key we could just insert
		but that acquires more locks.  Since the common case is that the row will
		exist the choice is to do a bit more work when the row doesn't exist.
	*/
	SELECT	@id = TypeId
	FROM	[dbo].[Type]
	WHERE	[TypeFullName]		= @TypeFullName
	AND		[AssemblyFullName]	= @AssemblyFullName

	IF @id IS NULL
	 BEGIN
		INSERT [dbo].[Type](
			[TypeFullName]
			,[AssemblyFullName]
			,[IsInstanceType]
		) 
		VALUES (
			@TypeFullName
			,@AssemblyFullName
			,@IsInstanceType
		)
				
		SELECT @error = @@ERROR, @id = SCOPE_IDENTITY()
		/*
			3604 -	Warning duplicate key ignored - does not raise exception to client
				This occurs when index specifies IGNORE_DUP_KEY
		*/
		IF @error = 3604 OR @id = 0 OR @id IS NULL
		 BEGIN
			SELECT	@id = TypeId
			FROM	[dbo].[Type]
			WHERE	[TypeFullName]		= @TypeFullName
			AND		[AssemblyFullName]	= @AssemblyFullName
	
			IF @@ERROR <> 0
			 BEGIN
				SELECT @error_desc = @localized_string_GetTypeId_Failed_SelectType
				GOTO FAILED
			 END
		 END
		ELSE IF @error NOT IN ( 3604, 0 )
		 BEGIN
			/*
				If we have an error (not 0) and 
				the error number is not 3604
				Then we have a fatal error situation
			*/
			SELECT @error_desc = @localized_string_GetTypeId_Failed_InsertType
			GOTO FAILED
		 END
	 END
	
	SELECT @TypeId = @id

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetTypeId] TO tracking_writer
GO

/*************************************************************************************************************************************
**
**
**														Workflow Insert Procs
**
**
*************************************************************************************************************************************/




IF OBJECT_ID('[dbo].[InsertActivities]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertActivities]
GO

CREATE PROCEDURE [dbo].[InsertActivities]			@WorkflowTypeId		int
													,@Activities		ntext
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int
			,@ActivityTypeId	int
			,@hdoc			int
			,@QId			nvarchar(128)
			,@PQId			nvarchar(128)
			,@FullName		nvarchar(128)
			,@Assembly		nvarchar(256)

	declare @localized_string_InsertActivities_Failed_GetType nvarchar(256)
	set @localized_string_InsertActivities_Failed_GetType = N'InsertActivities failed calling procedure GetTypeId'

	declare @localized_string_InsertActivities_Failed_ActivityInsert nvarchar(256)
	set @localized_string_InsertActivities_Failed_ActivityInsert = N'InsertActivities failed inserting into Activity'

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	EXEC sp_xml_preparedocument @hdoc OUTPUT, @Activities

	DECLARE activities INSENSITIVE CURSOR FOR
	SELECT 		[TypeFullName]
				,[AssemblyFullName]
				,[QualifiedName]
				,[ParentQualifiedName]
	FROM		OPENXML ( @hdoc, '/Activities/Activity',2) WITH
	            (
						[TypeFullName]			nvarchar(128)
						,[AssemblyFullName]		nvarchar(256)
						,[QualifiedName]			nvarchar(128)
						,[ParentQualifiedName]	nvarchar(128)
				)
	
	OPEN activities
	FETCH NEXT FROM activities INTO @FullName, @Assembly, @QId, @PQId

	WHILE @@FETCH_STATUS = 0
	 BEGIN
		/*
			Look up or insert the type of the Activity
		*/
		EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @FullName
										,@AssemblyFullName	= @Assembly
										,@TypeId			= @ActivityTypeId OUTPUT
		
		IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @ActivityTypeId IS NULL
		 BEGIN
			CLOSE activities
			DEALLOCATE activities
			SELECT @error_desc = @localized_string_InsertActivities_Failed_GetType
			GOTO FAILED
		 END
	
		INSERT [dbo].[Activity]	(
			[WorkflowTypeId]
			,[QualifiedName]
			,[ActivityTypeId]
			,[ParentQualifiedName]
		)
		VALUES (
			@WorkflowTypeId
			,@QId
			,@ActivityTypeId
			,@PQId
		)	

		IF @@ERROR <> 0 OR @@ROWCOUNT <> 1
		 BEGIN
			CLOSE activities
			DEALLOCATE activities
			SELECT @error_desc = @localized_string_InsertActivities_Failed_ActivityInsert
			GOTO FAILED
		 END
	
		FETCH NEXT FROM activities INTO @FullName, @Assembly, @QId, @PQId	
	 END

	CLOSE activities
	DEALLOCATE activities

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	IF @hdoc IS NOT NULL
		EXEC sp_xml_removedocument @hdoc
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertActivities] TO tracking_writer
GO




IF OBJECT_ID('[dbo].[InsertWorkflow]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertWorkflow]
GO

CREATE PROCEDURE [dbo].[InsertWorkflow]			@TypeFullName			nvarchar(128)
												,@AssemblyFullName		nvarchar(256)
												,@IsInstanceType		bit
												,@WorkflowDefinition	ntext
												,@Activities			ntext
												,@WorkflowId			int OUTPUT
												,@Exists				bit OUTPUT
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED

	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int
			,@id			int
			,@WorkflowTypeId	int

	declare @localized_string_InsertWorkflow_Failed_GetType nvarchar(256)
	set @localized_string_InsertWorkflow_Failed_GetType = N'InsertWorkflowType failed calling procedure GetTypeId'

	declare @localized_string_InsertWorkflow_Failed_WorkflowTypeInsert nvarchar(256)
	set @localized_string_InsertWorkflow_Failed_WorkflowTypeInsert = N'InsertWorkflowType failed inserting into Workflow'

	declare @localized_string_InsertWorkflow_Failed_WorkflowTypeSelect nvarchar(256)
	set @localized_string_InsertWorkflow_Failed_WorkflowTypeSelect = N'InsertWorkflowType failed selecting from Workflow'

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	/*
		Look up or insert the type of the Workflow
		Optimized for high read to insert ratio.
		We can race between the Type table insert 
		and the Workflow table insert but we fail 
		gracefully on the Workflow insert.
	*/
	EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @TypeFullName
									,@AssemblyFullName	= @AssemblyFullName
									,@IsInstanceType	= @IsInstanceType
									,@TypeId			= @WorkflowTypeId OUTPUT
	
	IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @WorkflowTypeId IS NULL
	 BEGIN
		SELECT @error_desc = @localized_string_InsertWorkflow_Failed_GetType
		GOTO FAILED
	 END
	

	IF NOT EXISTS ( SELECT	1 FROM [dbo].[Workflow] WHERE [WorkflowTypeId] = @WorkflowTypeId )
	 BEGIN
		SET @Exists = 0

		INSERT [dbo].[Workflow] (
			[WorkflowTypeId]
			,[WorkflowDefinition]
		) VALUES (
			@WorkflowTypeId
			,@WorkflowDefinition
		)

		SELECT @error = @@ERROR, @rowcount = @@ROWCOUNT
	
		/*
			3604 -	Warning duplicate key ignored - does not raise exception to client
					This occurs when index specifies IGNORE_DUP_KEY
		*/
		IF @error = 3604 OR @rowcount = 0
		 BEGIN
			/*
				No need to do another lookup as the type id for the workflow is the workflow id
			*/
			SET @Exists = 1
		 END
		ELSE IF @error NOT IN ( 3604, 0 )
		 BEGIN
			/*
				If we have an error (not 0) and 
				the error number is not 3604 or 2601
				Then we have a fatal error situation
			*/
			SELECT @error_desc = @localized_string_InsertWorkflow_Failed_WorkflowTypeInsert
			GOTO FAILED
		 END
		ELSE IF @error = 0 AND @rowcount > 0
		 BEGIN
			/*
				Insert was successful, insert activities
			*/
			EXEC @ret = [dbo].[InsertActivities] @WorkflowTypeId, @Activities
		 END
	 END
	ELSE
	 BEGIN
		SET @Exists = 1
	 END

	IF @local_tran = 1
		COMMIT TRANSACTION

	SELECT	@WorkflowId = @WorkflowTypeId
	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertWorkflow] TO tracking_writer
GO




/*************************************************************************************************************************************
**
**
**														Instance Insert Procs
**
**
*************************************************************************************************************************************/


IF OBJECT_ID('[dbo].[GetWorkflowInstanceInternalId]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetWorkflowInstanceInternalId]
GO

CREATE PROCEDURE [dbo].[GetWorkflowInstanceInternalId]		@WorkflowInstanceId					uniqueidentifier
															,@ContextGuid						uniqueidentifier
															,@WorkflowInstanceInternalId		bigint				OUTPUT
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED

	DECLARE @error			int
			,@rowcount		int
			,@id			bigint

	SELECT			@WorkflowInstanceInternalId	= [WorkflowInstanceInternalId]
	FROM			[dbo].[WorkflowInstance]
	WHERE			[WorkflowInstanceId]		= @WorkflowInstanceId
	AND				[ContextGuid]				= @ContextGuid

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0
		return -1
	ELSE
		return 0

 END
GO

GRANT EXECUTE ON [dbo].[GetWorkflowInstanceInternalId] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[GetActivityInstanceId]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetActivityInstanceId]
GO

CREATE PROCEDURE [dbo].[GetActivityInstanceId]		@WorkflowInstanceInternalId			bigint
													,@QualifiedName						nvarchar(128)	
													,@ContextGuid						uniqueidentifier
													,@ParentContextGuid					uniqueidentifier
													,@ActivityInstanceId				bigint				OUTPUT
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED

	declare @localized_string_GetActivityInstanceId_Failed_ActivityInstanceSel nvarchar(256)
	set @localized_string_GetActivityInstanceId_Failed_ActivityInstanceSel = N'Failed selecting from ActivityInstance'

	declare @localized_string_GetActivityInstanceId_Failed_ActivityInstanceInsert nvarchar(256)
	set @localized_string_GetActivityInstanceId_Failed_ActivityInstanceInsert = N'Failed inserting into ActivityInstance'

	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
			,@id			bigint


	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END


	SELECT			@ActivityInstanceId					= [ai].[ActivityInstanceId]
	FROM			[dbo].[ActivityInstance] [ai] WITH (INDEX([idx_ActivityInstance_WorkflowInstanceInternalId_QualifiedName_ContextGuid_ParentContextGuid]))
	WHERE			[ai].[WorkflowInstanceInternalId]	= @WorkflowInstanceInternalId
	AND				[ai].[QualifiedName]				= @QualifiedName
	AND				[ai].[ContextGuid]					= @ContextGuid
	AND				[ai].[ParentContextGuid]			= @ParentContextGuid

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0
		return -1

	IF @ActivityInstanceId IS NULL
	 BEGIN
		DECLARE @EventId int
		/*
			If there is a QName for this Activity in the AddedActivity table
			get the WorkflowInstanceEventId and write it to ActivityInstance.
		*/
		SELECT 		@EventId = MAX([WorkflowInstanceEventId])
		FROM		[dbo].[AddedActivity]
		WHERE		[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
		AND			[QualifiedName] = @QualifiedName
		
		INSERT [dbo].[ActivityInstance] (
				[WorkflowInstanceInternalId]
				,[QualifiedName]
				,[ContextGuid]
				,[ParentContextGuid]
				,[WorkflowInstanceEventId]
		) VALUES (
				@WorkflowInstanceInternalId
				,@QualifiedName
				,@ContextGuid
				,@ParentContextGuid
				,@EventId
		)
		
		SELECT @error = @@ERROR, @ActivityInstanceId = SCOPE_IDENTITY()

		IF @error IS NULL OR @error <> 0 OR @@ROWCOUNT <> 1 OR @ActivityInstanceId IS NULL
		 BEGIN
			SELECT @error_desc = @localized_string_GetActivityInstanceId_Failed_ActivityInstanceInsert
			GOTO FAILED
		 END
	 END
	
	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetActivityInstanceId] TO tracking_writer
GO

IF OBJECT_ID('[dbo].[InsertActivityExecutionStatusEvent]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertActivityExecutionStatusEvent]
GO



IF OBJECT_ID('[dbo].[InsertActivityExecutionStatusEventMultiple]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertActivityExecutionStatusEventMultiple]
GO

CREATE PROCEDURE [dbo].[InsertActivityExecutionStatusEventMultiple]	@WorkflowInstanceId					uniqueidentifier	= NULL
													,@WorkflowInstanceInternalId		bigint				= NULL OUTPUT /* IN/OUT */
													,@WorkflowInstanceContextGuid		uniqueidentifier
													,@ActivityInstanceId1				bigint				= NULL OUTPUT /* IN/OUT */
													,@QualifiedName1					nvarchar(128)
													,@ContextGuid1						uniqueidentifier
													,@ParentContextGuid1				uniqueidentifier
													,@ExecutionStatusId1				tinyint		
													,@EventDateTime1					datetime	
													,@EventOrder1						int
													,@ActivityExecutionStatusEventId1	bigint OUTPUT
													,@ActivityInstanceId2				bigint				= NULL OUTPUT /* IN/OUT */
													,@QualifiedName2					nvarchar(128)		= NULL
													,@ContextGuid2						uniqueidentifier	= NULL
													,@ParentContextGuid2				uniqueidentifier	= NULL
													,@ExecutionStatusId2				tinyint				= NULL
													,@EventDateTime2					datetime			= NULL
													,@EventOrder2						int					= NULL
													,@ActivityExecutionStatusEventId2	bigint				= NULL OUTPUT		
													,@ActivityInstanceId3				bigint				= NULL OUTPUT /* IN/OUT */
													,@QualifiedName3					nvarchar(128)		= NULL
													,@ContextGuid3						uniqueidentifier	= NULL
													,@ParentContextGuid3				uniqueidentifier	= NULL
													,@ExecutionStatusId3				tinyint				= NULL
													,@EventDateTime3					datetime			= NULL
													,@EventOrder3						int					= NULL
													,@ActivityExecutionStatusEventId3	bigint				= NULL OUTPUT
													,@ActivityInstanceId4				bigint				= NULL OUTPUT /* IN/OUT */
													,@QualifiedName4					nvarchar(128)		= NULL
													,@ContextGuid4						uniqueidentifier	= NULL
													,@ParentContextGuid4				uniqueidentifier	= NULL
													,@ExecutionStatusId4				tinyint				= NULL
													,@EventDateTime4					datetime			= NULL
													,@EventOrder4						int					= NULL
													,@ActivityExecutionStatusEventId4	bigint				= NULL OUTPUT
													,@ActivityInstanceId5				bigint				= NULL OUTPUT /* IN/OUT */
													,@QualifiedName5					nvarchar(128)		= NULL
													,@ContextGuid5						uniqueidentifier	= NULL
													,@ParentContextGuid5				uniqueidentifier	= NULL
													,@ExecutionStatusId5				tinyint				= NULL
													,@EventDateTime5					datetime			= NULL
													,@EventOrder5						int					= NULL
													,@ActivityExecutionStatusEventId5	bigint				= NULL OUTPUT
AS
 BEGIN
	SET NOCOUNT ON	

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED

	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint

	declare @localized_string_InsertActivityExecutionStatusEvent_Failed_GetType nvarchar(256)
	set @localized_string_InsertActivityExecutionStatusEvent_Failed_GetType = N'InsertActivityExecutionStatusEvent failed calling procedure GetTypeId'

	declare @localized_string_InsertActivityExecutionStatusEvent_Failed_InvalidParam nvarchar(256)
	set @localized_string_InsertActivityExecutionStatusEvent_Failed_InvalidParam = N'@WorkflowInstanceId and @WorkflowInstanceInternalId cannot both be null'

	declare @localized_string_InsertActivityExecutionStatusEvent_Failed_WorkflowInstanceInternalId nvarchar(256)
	set @localized_string_InsertActivityExecutionStatusEvent_Failed_WorkflowInstanceInternalId = N'Failed calling GetWorkflowInstanceInternalId'

	declare @localized_string_InsertActivityExecutionStatusEvent_Failed_ActivityStatusInsert nvarchar(256)
	set @localized_string_InsertActivityExecutionStatusEvent_Failed_ActivityStatusInsert = N'Failed inserting into ActivityExecutionStatusEvent'

	declare @localized_string_InsertActivityExecutionStatusEvent_Failed_ActivityInstanceIdSel nvarchar(256)
	set @localized_string_InsertActivityExecutionStatusEvent_Failed_ActivityInstanceIdSel = N'Failed calling GetActivityInstanceId'

	declare @localized_string_InsertActivityExecutionStatusEvent_Failed_NoEventId nvarchar(256)
	set @localized_string_InsertActivityExecutionStatusEvent_Failed_NoEventId = N'@ActivityExecutionStatusEventId is null or less than 0'


	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	IF @WorkflowInstanceId IS NULL AND @WorkflowInstanceInternalId IS NULL
	 BEGIN
		SELECT @error_desc = @localized_string_InsertActivityExecutionStatusEvent_Failed_InvalidParam
		GOTO FAILED
	 END

	DECLARE @InternalId bigint

	SELECT @InternalId = @WorkflowInstanceInternalId

	IF @InternalId IS NULL
	 BEGIN
		exec @ret = [dbo].[GetWorkflowInstanceInternalId]	@WorkflowInstanceId				= @WorkflowInstanceId
															,@ContextGuid					= @WorkflowInstanceContextGuid
															,@WorkflowInstanceInternalId	= @InternalId OUTPUT

		IF @ret IS NULL OR @ret <> 0 OR @InternalId IS NULL OR @InternalId <= 0
		 BEGIN
			SELECT @error_desc = @localized_string_InsertActivityExecutionStatusEvent_Failed_WorkflowInstanceInternalId
			GOTO FAILED
		 END
	 END
	
	DECLARE @ActivityInstanceId					bigint
			,@QualifiedName						nvarchar(128)
			,@ContextGuid						uniqueidentifier
			,@ParentContextGuid					uniqueidentifier
			,@ExecutionStatusId					tinyint		
			,@EventDateTime						datetime	
			,@EventOrder						int
			,@ActivityExecutionStatusEventId	bigint
			,@iteration							smallint

	SELECT	@ActivityInstanceId					= @ActivityInstanceId1
			,@QualifiedName						= @QualifiedName1
			,@ContextGuid						= @ContextGuid1
			,@ParentContextGuid					= @ParentContextGuid1
			,@ExecutionStatusId					= @ExecutionStatusId1		
			,@EventDateTime						= @EventDateTime1	
			,@EventOrder						= @EventOrder1
			,@iteration							= 1
	
	WHILE @QualifiedName IS NOT NULL
	 BEGIN
		-- This select->insert sequence is OK because workflows are single threaded
		-- a record isn't going to sneak in between the select and insert
		IF @ActivityInstanceId IS NULL
		 BEGIN
			EXEC @ret = [dbo].[GetActivityInstanceId]		@WorkflowInstanceInternalId			= @InternalId 
															,@QualifiedName						= @QualifiedName
															,@ContextGuid						= @ContextGuid
															,@ParentContextGuid					= @ParentContextGuid
															,@ActivityInstanceId				= @ActivityInstanceId OUTPUT
		
			SELECT @error = @@ERROR
			IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0 OR @ActivityInstanceId IS NULL OR @ActivityInstanceId <= 0
			 BEGIN
				SELECT @error_desc = @localized_string_InsertActivityExecutionStatusEvent_Failed_ActivityInstanceIdSel
				GOTO FAILED
			 END
		 END
		/*
			Insert this event in activity status
		*/
		INSERT [dbo].[ActivityExecutionStatusEvent] (
				[WorkflowInstanceInternalId]
				,[EventOrder]				
				,[ActivityInstanceId]		
				,[ExecutionStatusId]					
				,[EventDateTime]			
		) VALUES (
				@InternalId
				,@EventOrder
				,@ActivityInstanceId
				,@ExecutionStatusId
				,@EventDateTime
		)

		SELECT	@error							= @@ERROR
				,@ActivityExecutionStatusEventId= scope_identity()
				,@WorkflowInstanceInternalId	= @InternalId

		IF @error <> 0
		 BEGIN
			SELECT @error_desc = @localized_string_InsertActivityExecutionStatusEvent_Failed_ActivityStatusInsert
			GOTO FAILED
		 END

		IF @ActivityExecutionStatusEventId IS NULL OR @ActivityExecutionStatusEventId < 0
		 BEGIN
			SELECT @error_desc = @localized_string_InsertActivityExecutionStatusEvent_Failed_NoEventId
			GOTO FAILED
		 END

		IF @iteration = 1
		 BEGIN
			/*
				Set output parameters
			*/
			SELECT	@ActivityInstanceId1				= @ActivityInstanceId
					,@ActivityExecutionStatusEventId1	= @ActivityExecutionStatusEventId

			SELECT @ActivityInstanceId = NULL

			IF @ActivityInstanceId2 IS NOT NULL
			 BEGIN
				/*
					Id was cached in the tracking channel and passed in
				*/
				SELECT @ActivityInstanceId				= @ActivityInstanceId2
			 END
			ELSE
			 BEGIN
				/*
					If the IDs of the next activity match the IDs of a previous activity re-use the ActivityInstanceId value
				*/
				IF @QualifiedName2 = @QualifiedName1 AND @ContextGuid2 = @ContextGuid1 AND @ParentContextGuid2 = @ParentContextGuid1
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId1
				 END
			 END

			SELECT	@QualifiedName						= @QualifiedName2
					,@ContextGuid						= @ContextGuid2
					,@ParentContextGuid					= @ParentContextGuid2
					,@ExecutionStatusId					= @ExecutionStatusId2		
					,@EventDateTime						= @EventDateTime2
					,@EventOrder						= @EventOrder2
					,@iteration							= 2
		 END
		ELSE IF @iteration = 2
		 BEGIN
			/*
				Set output parameters
			*/
			SELECT	@ActivityInstanceId2				= @ActivityInstanceId
					,@ActivityExecutionStatusEventId2	= @ActivityExecutionStatusEventId

			SELECT @ActivityInstanceId = NULL
			IF @ActivityInstanceId3 IS NOT NULL
			 BEGIN
				/*
					Id was cached in the tracking channel and passed in
				*/
				SELECT @ActivityInstanceId				= @ActivityInstanceId3
			 END
			ELSE
			 BEGIN
				/*
					If the IDs of the next activity match the IDs of a previous activity re-use the ActivityInstanceId value
				*/
				IF @QualifiedName3 = @QualifiedName1 AND @ContextGuid3 = @ContextGuid1 AND @ParentContextGuid3 = @ParentContextGuid1
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId1
				 END
				ELSE IF @QualifiedName3 = @QualifiedName2 AND @ContextGuid3 = @ContextGuid2 AND @ParentContextGuid3 = @ParentContextGuid2
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId2
				 END	
			 END

			SELECT	@QualifiedName						= @QualifiedName3
					,@ContextGuid						= @ContextGuid3
					,@ParentContextGuid					= @ParentContextGuid3
					,@ExecutionStatusId					= @ExecutionStatusId3		
					,@EventDateTime						= @EventDateTime3
					,@EventOrder						= @EventOrder3
					,@iteration							= 3		
		 END
		ELSE IF @iteration = 3
		 BEGIN
			/*
				Set output parameters
			*/
			SELECT	@ActivityInstanceId3				= @ActivityInstanceId
					,@ActivityExecutionStatusEventId3	= @ActivityExecutionStatusEventId

			SELECT @ActivityInstanceId = NULL

			IF @ActivityInstanceId4 IS NOT NULL
			 BEGIN
				/*
					Id was cached in the tracking channel and passed in
				*/
				SELECT @ActivityInstanceId				= @ActivityInstanceId4
			 END
			ELSE
			 BEGIN
				/*
					If the IDs of the next activity match the IDs of a previous activity re-use the ActivityInstanceId value
				*/
				IF @QualifiedName4 = @QualifiedName1 AND @ContextGuid4 = @ContextGuid1 AND @ParentContextGuid4 = @ParentContextGuid1
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId1
				 END
				ELSE IF @QualifiedName4 = @QualifiedName2 AND @ContextGuid4 = @ContextGuid2 AND @ParentContextGuid4 = @ParentContextGuid2
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId2
				 END
				ELSE IF @QualifiedName4 = @QualifiedName3 AND @ContextGuid4 = @ContextGuid3 AND @ParentContextGuid4 = @ParentContextGuid3
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId3
				 END
			 END

			SELECT	@QualifiedName						= @QualifiedName4
					,@ContextGuid						= @ContextGuid4
					,@ParentContextGuid					= @ParentContextGuid4
					,@ExecutionStatusId					= @ExecutionStatusId4		
					,@EventDateTime						= @EventDateTime4
					,@EventOrder						= @EventOrder4
					,@iteration							= 4	
		 END
		ELSE IF @iteration = 4
		 BEGIN	
			/*
				Set output parameters
			*/
			SELECT	@ActivityInstanceId4				= @ActivityInstanceId
					,@ActivityExecutionStatusEventId4	= @ActivityExecutionStatusEventId

			SELECT @ActivityInstanceId = NULL

			IF @ActivityInstanceId5 IS NOT NULL
			 BEGIN
				/*
					Id was cached in the tracking channel and passed in
				*/
				SELECT @ActivityInstanceId				= @ActivityInstanceId5
			 END
			ELSE
			 BEGIN
				/*
					If the IDs of the next activity match the IDs of a previous activity re-use the ActivityInstanceId value
				*/
				IF @QualifiedName5 = @QualifiedName1 AND @ContextGuid5 = @ContextGuid1 AND @ParentContextGuid5 = @ParentContextGuid1
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId1
				 END
				ELSE IF @QualifiedName5 = @QualifiedName2 AND @ContextGuid5 = @ContextGuid2 AND @ParentContextGuid5 = @ParentContextGuid2
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId2
				 END
				ELSE IF @QualifiedName5 = @QualifiedName3 AND @ContextGuid5 = @ContextGuid3 AND @ParentContextGuid5 = @ParentContextGuid3
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId3
				 END
				ELSE IF @QualifiedName5 = @QualifiedName4 AND @ContextGuid5 = @ContextGuid4 AND @ParentContextGuid5 = @ParentContextGuid4
				 BEGIN
					SELECT @ActivityInstanceId				= @ActivityInstanceId4
				 END
			 END

			SELECT	@QualifiedName						= @QualifiedName5
					,@ContextGuid						= @ContextGuid5
					,@ParentContextGuid					= @ParentContextGuid5
					,@ExecutionStatusId					= @ExecutionStatusId5		
					,@EventDateTime						= @EventDateTime5
					,@EventOrder						= @EventOrder5
					,@iteration							= 5	
		 END
		ELSE IF @iteration = 5
		 BEGIN
			SELECT	@ActivityInstanceId5				= @ActivityInstanceId
					,@ActivityExecutionStatusEventId5	= @ActivityExecutionStatusEventId -- set the output id param for this event

			BREAK
		 END
	 END
	

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertActivityExecutionStatusEventMultiple] TO tracking_writer
GO




IF OBJECT_ID('[dbo].[InsertWorkflowInstance]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertWorkflowInstance]
GO

CREATE PROCEDURE [dbo].[InsertWorkflowInstance]		@WorkflowInstanceId					uniqueidentifier	
													,@TypeFullName						nvarchar(128)
													,@AssemblyFullName					nvarchar(256)
													,@ContextGuid						uniqueidentifier
													,@CallerInstanceId					uniqueidentifier	= NULL
													,@CallPath							nvarchar(400)		= NULL
													,@CallerContextGuid					uniqueidentifier	= NULL
													,@CallerParentContextGuid			uniqueidentifier	= NULL
													,@EventDateTime						datetime
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED

	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
			,@aid			bigint
			,@ParentId		bigint
			,@WorkflowInstanceInternalId bigint

	declare @localized_string_InsertWorkflowInstance_Failed_GetType nvarchar(256)
	set @localized_string_InsertWorkflowInstance_Failed_GetType = N'InsertWorkflowInstance failed calling procedure GetTypeId'

	declare @localized_string_InsertWorkflowInstance_Failed_InsertingWorkflowInstance nvarchar(256)
	set @localized_string_InsertWorkflowInstance_Failed_InsertingWorkflowInstance = N'InsertWorkflowInstance failed inserting into WorkflowInstance'

	declare @localized_string_InsertWorkflowInstance_Failed_InvalidStatus nvarchar(256)
	set @localized_string_InsertWorkflowInstance_Failed_InvalidStatus = N'Status is not Executing'

	declare @localized_string_InsertWorkflowInstance_Failed_SelectingParentId nvarchar(256)
	set @localized_string_InsertWorkflowInstance_Failed_SelectingParentId = N'Failed selecting parent WorkflowInstanceInternalId'

	declare @localized_string_InsertWorkflowInstance_Failed_InsertActivityExecutionStatusEvent nvarchar(256)
	set @localized_string_InsertWorkflowInstance_Failed_InsertActivityExecutionStatusEvent = N'InsertActivityExecutionStatusEvent failed'

	declare @localized_string_InsertWorkflowInstance_Failed_WorkflowInstanceInternalId nvarchar(256)
	set @localized_string_InsertWorkflowInstance_Failed_WorkflowInstanceInternalId = N'Failed calling GetExistingWorkflowInstanceInternalId'

	declare @localized_string_InsertWorkflowInstance_Failed_NoWorkflowInstanceInternalId nvarchar(256)
	set @localized_string_InsertWorkflowInstance_Failed_NoWorkflowInstanceInternalId = N'Failed - @WorkflowInstanceInternalId is null or empty at exit'


	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	DECLARE @WorkflowTypeId int
	IF @TypeFullName IS NOT NULL AND @AssemblyFullName IS NOT NULL
	 BEGIN
		/*
			Look up or insert the type of the Workflow
		*/
		EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @TypeFullName
										,@AssemblyFullName	= @AssemblyFullName
										,@TypeId			= @WorkflowTypeId OUTPUT
		
		IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @WorkflowTypeId IS NULL
		 BEGIN
			SELECT @error_desc = @localized_string_InsertWorkflowInstance_Failed_GetType
			GOTO FAILED
		 END
	 END
	/*
		Determine if we already have a record for this
		If it already exists this is a load call, just return with the internal id
	*/
	EXEC @ret = [dbo].[GetWorkflowInstanceInternalId]	@WorkflowInstanceId					= @WorkflowInstanceId
														,@ContextGuid						= @ContextGuid
														,@WorkflowInstanceInternalId		= @WorkflowInstanceInternalId OUTPUT

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_InsertWorkflowInstance_Failed_WorkflowInstanceInternalId
		GOTO FAILED
	 END

	IF @WorkflowInstanceInternalId IS NULL
	 BEGIN
		/*
			Insert into the WorkflowInstance table
		*/
		INSERT [dbo].[WorkflowInstance] (
				[WorkflowInstanceId]
				,[ContextGuid]
				,[CallerInstanceId]
				,[CallPath]
				,[CallerContextGuid]
				,[CallerParentContextGuid]
				,[WorkflowTypeId]
				,[InitializedDateTime]
		) VALUES (
				@WorkflowInstanceId
				,@ContextGuid
				,@CallerInstanceId
				,@CallPath
				,@CallerContextGuid
				,@CallerParentContextGuid
				,@WorkflowTypeId
				,@EventDateTime
		)
	
		SELECT 	@WorkflowInstanceInternalId = SCOPE_IDENTITY()
				,@error = @@ERROR
	
		IF @error IS NULL OR @error <> 0
		 BEGIN
			SELECT @error_desc = @localized_string_InsertWorkflowInstance_Failed_InsertingWorkflowInstance
			GOTO FAILED
		 END
	 END

	/*
		We should always have an internal id at this point
	*/
	IF @WorkflowInstanceInternalId IS NULL OR @WorkflowInstanceInternalId <= 0
	 BEGIN
		SELECT @error_desc = @localized_string_InsertWorkflowInstance_Failed_NoWorkflowInstanceInternalId
		GOTO FAILED
	 END

	SELECT @WorkflowInstanceInternalId as 'WorkflowInstanceInternalId'
	

	IF @local_tran = 1
		COMMIT TRANSACTION

	SELECT	@ret = 0

	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	return @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertWorkflowInstance] TO tracking_writer
GO


IF OBJECT_ID('[dbo].[InsertWorkflowInstanceEvent]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertWorkflowInstanceEvent]
GO

CREATE PROCEDURE [dbo].[InsertWorkflowInstanceEvent]	@WorkflowInstanceInternalId		bigint
														,@TrackingWorkflowEventId1		smallint
														,@EventDateTime1				datetime
														,@EventOrder1					int	
														,@EventArgTypeFullName1			nvarchar(128)=NULL
														,@EventArgAssemblyFullName1		nvarchar(256)=NULL
														,@EventArg1						image=NULL
														,@WorkflowInstanceEventId1		bigint=NULL OUTPUT
														,@TrackingWorkflowEventId2		smallint=NULL
														,@EventDateTime2				datetime=NULL
														,@EventOrder2					int=NULL
														,@EventArgTypeFullName2			nvarchar(128)=NULL
														,@EventArgAssemblyFullName2		nvarchar(256)=NULL
														,@EventArg2						image=NULL
														,@WorkflowInstanceEventId2		bigint=NULL OUTPUT
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED

	declare @localized_string_InsertWorkflowInstanceEvent_Failed_WorkflowInstanceEventInsert nvarchar(256)
	set @localized_string_InsertWorkflowInstanceEvent_Failed_WorkflowInstanceEventInsert = N'Failed inserting into WorkflowInstanceEvent'

	declare @localized_string_InsertWorkflowInstanceEvent_Failed_GetType nvarchar(256)
	set @localized_string_InsertWorkflowInstanceEvent_Failed_GetType = N'InsertWorkflowInstanceEvent failed calling procedure GetTypeId'

	declare @localized_string_InsertWorkflowInstanceEvent_Failed_InvalidType nvarchar(256)
	set @localized_string_InsertWorkflowInstanceEvent_Failed_InvalidType = N'@EventArgTypeFullName and @EventArgAssemblyFullName must be non null if @EventArg is non null'

		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
			,@rowcount		int

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END


	/*
		If we have an arg look up or insert the type
	*/
	DECLARE @EventArgTypeId smallint
	IF @EventArg1 IS NOT NULL
	 BEGIN
		/*
			Must have a valid type & assembly name
		*/
		IF @EventArgTypeFullName1 IS NULL OR LEN( LTRIM( RTRIM( @EventArgTypeFullName1 ) ) ) = 0 OR @EventArgAssemblyFullName1 IS NULL OR LEN( LTRIM( RTRIM( @EventArgAssemblyFullName1 ) ) ) = 0
		 BEGIN
			SELECT @error_desc = @localized_string_InsertWorkflowInstanceEvent_Failed_InvalidType
			GOTO FAILED
		 END
		EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @EventArgTypeFullName1
										,@AssemblyFullName	= @EventArgAssemblyFullName1
										,@TypeId			= @EventArgTypeId OUTPUT
		
		IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @EventArgTypeId IS NULL
		 BEGIN
			SELECT @error_desc = @localized_string_InsertWorkflowInstanceEvent_Failed_GetType
			GOTO FAILED
		 END
	 END


	INSERT [dbo].[WorkflowInstanceEvent] (
			[WorkflowInstanceInternalId]
			,[TrackingWorkflowEventId]
			,[EventDateTime]
			,[EventOrder]
			,[EventArgTypeId]
			,[EventArg]
	) VALUES (
			@WorkflowInstanceInternalId
			,@TrackingWorkflowEventId1
			,@EventDateTime1
			,@EventOrder1
			,@EventArgTypeId
			,@EventArg1
	)

	SELECT @error = @@ERROR, @rowcount = @@ROWCOUNT, @WorkflowInstanceEventId1 = SCOPE_IDENTITY()

	IF @error IS NULL OR @error <> 0 OR @rowcount IS NULL OR @rowcount <> 1
	 BEGIN
		SET @error_desc = @localized_string_InsertWorkflowInstanceEvent_Failed_WorkflowInstanceEventInsert
		GOTO FAILED
	 END

	IF @TrackingWorkflowEventId2 IS NOT NULL
	 BEGIN
			SET @EventArgTypeId = NULL

			IF @EventArg2 IS NOT NULL
			 BEGIN
				/*
					Must have a valid type & assembly name
				*/
				IF @EventArgTypeFullName2 IS NULL OR LEN( LTRIM( RTRIM( @EventArgTypeFullName2 ) ) ) = 0 OR @EventArgAssemblyFullName2 IS NULL OR LEN( LTRIM( RTRIM( @EventArgAssemblyFullName2 ) ) ) = 0
				 BEGIN
					SELECT @error_desc = @localized_string_InsertWorkflowInstanceEvent_Failed_InvalidType
					GOTO FAILED
				 END
				EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @EventArgTypeFullName2
												,@AssemblyFullName	= @EventArgAssemblyFullName2
												,@TypeId			= @EventArgTypeId OUTPUT
				
				IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @EventArgTypeId IS NULL
				 BEGIN
					SELECT @error_desc = @localized_string_InsertWorkflowInstanceEvent_Failed_GetType
					GOTO FAILED
				 END
			 END


			INSERT [dbo].[WorkflowInstanceEvent] (
					[WorkflowInstanceInternalId]
					,[TrackingWorkflowEventId]
					,[EventDateTime]
					,[EventOrder]
					,[EventArgTypeId]
					,[EventArg]
			) VALUES (
					@WorkflowInstanceInternalId
					,@TrackingWorkflowEventId2
					,@EventDateTime2
					,@EventOrder2
					,@EventArgTypeId
					,@EventArg2
			)

			SELECT @error = @@ERROR, @rowcount = @@ROWCOUNT, @WorkflowInstanceEventId2 = SCOPE_IDENTITY()

			IF @error IS NULL OR @error <> 0 OR @rowcount IS NULL OR @rowcount <> 1
			 BEGIN
				SET @error_desc = @localized_string_InsertWorkflowInstanceEvent_Failed_WorkflowInstanceEventInsert
				GOTO FAILED
			 END
	 END


	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	return @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertWorkflowInstanceEvent] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[InsertUserEvent]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertUserEvent]
GO

											
CREATE PROCEDURE [dbo].[InsertUserEvent]	@WorkflowInstanceInternalId			bigint
											,@EventOrder						int	
											,@ActivityInstanceId				bigint				= NULL OUTPUT /* IN/OUT */
											,@QualifiedName						nvarchar(128)		= NULL
											,@ContextGuid						uniqueidentifier	= NULL
											,@ParentContextGuid					uniqueidentifier	= NULL
											,@EventDateTime						datetime
											,@UserDataKey						nvarchar(512)		= NULL
											,@UserDataTypeFullName				nvarchar(128)		= NULL
											,@UserDataAssemblyFullName			nvarchar(256)		= NULL
											,@UserData_Str						nvarchar(512)		= NULL
											,@UserData_Blob						image				= NULL
											,@UserDataNonSerializable			bit
											,@UserEventId						bigint	OUTPUT
AS
 BEGIN
	SET NOCOUNT ON	

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED

	declare @localized_string_InsertUserEvent_Failed_InsertUserEvent nvarchar(256)
	set @localized_string_InsertUserEvent_Failed_InsertUserEvent = N'Failed inserting into UserEvent'
	
	declare @localized_string_InsertUserEvent_Failed_GetType nvarchar(256)
	set @localized_string_InsertUserEvent_Failed_GetType = N'InsertUserEvent failed calling procedure GetTypeId'

	declare @localized_string_InsertUserEvent_Failed_InvalidType nvarchar(256)
	set @localized_string_InsertUserEvent_Failed_InvalidType = N'@EventArgTypeFullName and @EventArgAssemblyFullName must be non null if @EventArg is non null'

	declare @localized_string_InsertUserEvent_Failed_ActivityInstanceIdSel nvarchar(256)
	set @localized_string_InsertUserEvent_Failed_ActivityInstanceIdSel = N'Failed calling GetActivityInstanceId'

	declare @localized_string_InsertUserEvent_Failed_NoEventId nvarchar(256)
	set @localized_string_InsertUserEvent_Failed_NoEventId = N'@UserEventId is null or less than 0'

	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
			,@rowcount		int

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	-- This select->insert sequence is OK because workflows are single threaded
	-- a record isn't going to sneak in between the select and insert
	IF @ActivityInstanceId IS NULL
	 BEGIN
		EXEC @ret = [dbo].[GetActivityInstanceId]		@WorkflowInstanceInternalId			= @WorkflowInstanceInternalId 
														,@QualifiedName						= @QualifiedName
														,@ContextGuid						= @ContextGuid
														,@ParentContextGuid					= @ParentContextGuid
														,@ActivityInstanceId				= @ActivityInstanceId OUTPUT
	
		SELECT @error = @@ERROR
		IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0 OR @ActivityInstanceId IS NULL OR @ActivityInstanceId <= 0
		 BEGIN
			SELECT @error_desc = @localized_string_InsertUserEvent_Failed_ActivityInstanceIdSel
			GOTO FAILED
		 END
	 END

	/*
		If we have an arg look up or insert the type
	*/
	DECLARE @UserDataTypeId smallint
	IF @UserData_Blob IS NOT NULL OR @UserDataNonSerializable=1
	 BEGIN
		/*
			Must have a valid type & assembly name
		*/
		IF @UserDataTypeFullName IS NULL OR LEN( LTRIM( RTRIM( @UserDataTypeFullName ) ) ) = 0 OR @UserDataAssemblyFullName IS NULL OR LEN( LTRIM( RTRIM( @UserDataAssemblyFullName ) ) ) = 0
		 BEGIN
			SELECT @error_desc = @localized_string_InsertUserEvent_Failed_InvalidType
			GOTO FAILED
		 END
		EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @UserDataTypeFullName
										,@AssemblyFullName	= @UserDataAssemblyFullName
										,@TypeId			= @UserDataTypeId OUTPUT
		
		IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @UserDataTypeId IS NULL
		 BEGIN
			SELECT @error_desc = @localized_string_InsertUserEvent_Failed_GetType
			GOTO FAILED
		 END
	 END


	INSERT [dbo].[UserEvent] (
			[WorkflowInstanceInternalId]
			,[EventOrder]
			,[ActivityInstanceId]
			,[EventDateTime]
			,[UserDataKey]
			,[UserDataTypeId]
			,[UserData_Str]
			,[UserData_Blob]
			,[UserDataNonSerializable]
	) VALUES (
			@WorkflowInstanceInternalId
			,@EventOrder
			,@ActivityInstanceId
			,@EventDateTime
			,@UserDataKey
			,@UserDataTypeId
			,@UserData_Str
			,@UserData_Blob
			,@UserDataNonSerializable
	)

	SELECT @error = @@ERROR, @rowcount = @@ROWCOUNT, @UserEventId = scope_identity()

	IF @error IS NULL OR @error <> 0 OR @rowcount IS NULL OR @rowcount <> 1
	 BEGIN
		SET @error_desc = @localized_string_InsertUserEvent_Failed_InsertUserEvent
		GOTO FAILED
	 END

	IF @UserEventId IS NULL OR @UserEventId < 0
	 BEGIN
		SET @error_desc = @localized_string_InsertUserEvent_Failed_NoEventId
		GOTO FAILED
	 END


	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	return @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertUserEvent] TO tracking_writer
GO


IF OBJECT_ID('[dbo].[InsertTrackingDataItem]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertTrackingDataItem]
GO

CREATE PROCEDURE [dbo].[InsertTrackingDataItem]		@WorkflowInstanceInternalId		bigint
													,@EventId						bigint
													,@EventTypeId					char(1)
													,@FieldName						nvarchar(256)
													,@TypeFullName					nvarchar(128)	= NULL
													,@AssemblyFullName				nvarchar(256)	= NULL
													,@Data_Str						nvarchar(512)	= NULL
													,@Data_Blob						image			= NULL
													,@DataNonSerializable			bit			
													,@TrackingDataItemId			bigint OUTPUT
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED

	declare @localized_string_InsertTrackingDataItem_Failed_Params nvarchar(256)
	set @localized_string_InsertTrackingDataItem_Failed_Params = N'@TypeFullName and @AssemblyFullName must be non null if @Data_Str or @Data_Blob is non null'

	declare @localized_string_InsertTrackingDataItem_Failed_GetType nvarchar(256)
	set @localized_string_InsertTrackingDataItem_Failed_GetType = N'GetTypeId failed'

	declare @localized_string_InsertTrackingDataItem_Failed_TrackingDataItemInsert nvarchar(256)
	set @localized_string_InsertTrackingDataItem_Failed_TrackingDataItemInsert = N'Failed inserting into TrackingDataItem'

		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
			,@TypeId		int

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	/*
		Look up or insert the type of the data
		If no type and data is not null 
	*/
	IF ( @TypeFullName IS NULL OR @AssemblyFullName IS NULL ) AND ( @Data_Str IS NOT NULL OR @Data_Blob IS NOT NULL )
	 BEGIN
			SELECT @error_desc = @localized_string_InsertTrackingDataItem_Failed_Params
			GOTO FAILED
	 END

	IF @TypeFullName IS NOT NULL AND @AssemblyFullName IS NOT NULL
	 BEGIN
		EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @TypeFullName
										,@AssemblyFullName	= @AssemblyFullName
										,@TypeId			= @TypeId OUTPUT
				
		IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TypeId IS NULL
		 BEGIN
			SELECT @error_desc = @localized_string_InsertTrackingDataItem_Failed_GetType
			GOTO FAILED
		 END
	END

	INSERT [dbo].[TrackingDataItem] (
			[WorkflowInstanceInternalId]
			,[EventId]
			,[EventTypeId]
			,[FieldName]
			,[FieldTypeId]
			,[Data_Str]
			,[Data_Blob]
			,[DataNonSerializable]
	) VALUES (
			@WorkflowInstanceInternalId
			,@EventId
			,@EventTypeId
			,@FieldName
			,@TypeId
			,@Data_Str
			,@Data_Blob
			,@DataNonSerializable
	)

	IF @@ERROR <> 0 OR @@ROWCOUNT <> 1
	 BEGIN
		SELECT @error_desc = @localized_string_InsertTrackingDataItem_Failed_TrackingDataItemInsert
		GOTO FAILED		
	 END

	SET @TrackingDataItemId = scope_identity()
	
	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	SET @ret = -1
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertTrackingDataItem] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[InsertTrackingDataItemMultiple]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertTrackingDataItemMultiple]
GO

CREATE PROCEDURE [dbo].[InsertTrackingDataItemMultiple]	@WorkflowInstanceInternalId		bigint
														,@EventTypeId					char(1)
														,@EventId1						bigint
														,@FieldName1					nvarchar(256)
														,@TypeFullName1					nvarchar(128)	= NULL
														,@AssemblyFullName1				nvarchar(256)	= NULL
														,@Data_Str1						nvarchar(512)	= NULL
														,@Data_Blob1					image			= NULL
														,@DataNonSerializable1			bit			
														,@TrackingDataItemId1			bigint OUTPUT
														,@EventId2						bigint			= NULL
														,@FieldName2					nvarchar(256)	= NULL
														,@TypeFullName2					nvarchar(128)	= NULL
														,@AssemblyFullName2				nvarchar(256)	= NULL
														,@Data_Str2						nvarchar(512)	= NULL
														,@Data_Blob2					image			= NULL
														,@DataNonSerializable2			bit				= NULL
														,@TrackingDataItemId2			bigint 			= NULL OUTPUT
														,@EventId3						bigint			= NULL
														,@FieldName3					nvarchar(256)	= NULL
														,@TypeFullName3					nvarchar(128)	= NULL
														,@AssemblyFullName3				nvarchar(256)	= NULL
														,@Data_Str3						nvarchar(512)	= NULL
														,@Data_Blob3					image			= NULL
														,@DataNonSerializable3			bit				= NULL
														,@TrackingDataItemId3			bigint			= NULL OUTPUT
														,@EventId4						bigint			= NULL
														,@FieldName4					nvarchar(256)	= NULL
														,@TypeFullName4					nvarchar(128)	= NULL
														,@AssemblyFullName4				nvarchar(256)	= NULL
														,@Data_Str4						nvarchar(512)	= NULL
														,@Data_Blob4					image			= NULL
														,@DataNonSerializable4			bit				= NULL
														,@TrackingDataItemId4			bigint			= NULL OUTPUT
														,@EventId5						bigint			= NULL
														,@FieldName5					nvarchar(256)	= NULL
														,@TypeFullName5					nvarchar(128)	= NULL
														,@AssemblyFullName5				nvarchar(256)	= NULL
														,@Data_Str5						nvarchar(512)	= NULL
														,@Data_Blob5					image			= NULL
														,@DataNonSerializable5			bit				= NULL
														,@TrackingDataItemId5			bigint			= NULL OUTPUT
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
			,@TypeId		int

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	DECLARE	@TrackingDataItemId		bigint

	IF @FieldName1 IS NOT NULL
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItem]	@WorkflowInstanceInternalId		= @WorkflowInstanceInternalId
													,@EventId						= @EventId1
													,@EventTypeId					= @EventTypeId
													,@FieldName						= @FieldName1
													,@TypeFullName					= @TypeFullName1
													,@AssemblyFullName				= @AssemblyFullName1
													,@Data_Str						= @Data_Str1
													,@Data_Blob						= @Data_Blob1
													,@DataNonSerializable			= @DataNonSerializable1
													,@TrackingDataItemId			= @TrackingDataItemId1 OUTPUT

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TrackingDataItemId1 IS NULL OR @TrackingDataItemId1 <= 0
			GOTO FAILED
	 END


	IF @FieldName2 IS NOT NULL
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItem]	@WorkflowInstanceInternalId		= @WorkflowInstanceInternalId
													,@EventId						= @EventId2
													,@EventTypeId					= @EventTypeId
													,@FieldName						= @FieldName2
													,@TypeFullName					= @TypeFullName2
													,@AssemblyFullName				= @AssemblyFullName2
													,@Data_Str						= @Data_Str2
													,@Data_Blob						= @Data_Blob2
													,@DataNonSerializable			= @DataNonSerializable2
													,@TrackingDataItemId			= @TrackingDataItemId2 OUTPUT

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TrackingDataItemId2 IS NULL OR @TrackingDataItemId2 <= 0
			GOTO FAILED
	 END

	IF @FieldName3 IS NOT NULL
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItem]	@WorkflowInstanceInternalId		= @WorkflowInstanceInternalId
													,@EventId						= @EventId3
													,@EventTypeId					= @EventTypeId
													,@FieldName						= @FieldName3
													,@TypeFullName					= @TypeFullName3
													,@AssemblyFullName				= @AssemblyFullName3
													,@Data_Str						= @Data_Str3
													,@Data_Blob						= @Data_Blob3
													,@DataNonSerializable			= @DataNonSerializable3
													,@TrackingDataItemId			= @TrackingDataItemId3 OUTPUT

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TrackingDataItemId3 IS NULL OR @TrackingDataItemId3 <= 0
			GOTO FAILED
	 END

	IF @FieldName4 IS NOT NULL
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItem]	@WorkflowInstanceInternalId		= @WorkflowInstanceInternalId
													,@EventId						= @EventId4
													,@EventTypeId					= @EventTypeId
													,@FieldName						= @FieldName4
													,@TypeFullName					= @TypeFullName4
													,@AssemblyFullName				= @AssemblyFullName4
													,@Data_Str						= @Data_Str4
													,@Data_Blob						= @Data_Blob4
													,@DataNonSerializable			= @DataNonSerializable4
													,@TrackingDataItemId			= @TrackingDataItemId4 OUTPUT

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TrackingDataItemId4 IS NULL OR @TrackingDataItemId4 <= 0
			GOTO FAILED
	 END

	IF @FieldName5 IS NOT NULL
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItem]	@WorkflowInstanceInternalId		= @WorkflowInstanceInternalId
													,@EventId						= @EventId5
													,@EventTypeId					= @EventTypeId
													,@FieldName						= @FieldName5
													,@TypeFullName					= @TypeFullName5
													,@AssemblyFullName				= @AssemblyFullName5
													,@Data_Str						= @Data_Str5
													,@Data_Blob						= @Data_Blob5
													,@DataNonSerializable			= @DataNonSerializable5
													,@TrackingDataItemId			= @TrackingDataItemId5 OUTPUT

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TrackingDataItemId5 IS NULL OR @TrackingDataItemId5 <= 0
			GOTO FAILED
	 END
	
	
	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 1
	GOTO DONE

FAILED:
	SET @ret = 0

	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertTrackingDataItemMultiple] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[InsertTrackingDataItemAnnotation]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertTrackingDataItemAnnotation]
GO

CREATE PROCEDURE [dbo].[InsertTrackingDataItemAnnotation]	@TrackingDataItemId				bigint
															,@WorkflowInstanceInternalId	bigint
													,@Annotation				nvarchar(1024)
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_InsertTrackingDataItemAnnotation_Failed_TrackingDataItemAnnotationInsert nvarchar(256)
	set @localized_string_InsertTrackingDataItemAnnotation_Failed_TrackingDataItemAnnotationInsert = N'Failed inserting into TrackingDataItemAnnotation'

		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END


	INSERT [dbo].[TrackingDataItemAnnotation] (
			[TrackingDataItemId]
			,[WorkflowInstanceInternalId]
			,[Annotation]
	) VALUES (
			@TrackingDataItemId
			,@WorkflowInstanceInternalId
			,@Annotation
	)

	IF @@ERROR <> 0 OR @@ROWCOUNT <> 1
	 BEGIN
		SELECT @error_desc = @localized_string_InsertTrackingDataItemAnnotation_Failed_TrackingDataItemAnnotationInsert
		GOTO FAILED		
	 END

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	SET @ret = -1

	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	GOTO DONE

DONE:
	RETURN @ret

 END
GO


GRANT EXECUTE ON [dbo].[InsertTrackingDataItemAnnotation] TO tracking_writer
GO




IF OBJECT_ID('[dbo].[InsertTrackingDataItemAnnotationMultiple]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertTrackingDataItemAnnotationMultiple]
GO

CREATE PROCEDURE [dbo].[InsertTrackingDataItemAnnotationMultiple]	@WorkflowInstanceInternalId		bigint																	
																	,@HasData1						bit
																	,@TrackingDataItemId1			bigint
																	,@Annotation1					nvarchar(1024)	= NULL
																	,@HasData2						bit				= NULL
																	,@TrackingDataItemId2			bigint			= NULL
																	,@Annotation2					nvarchar(1024)	= NULL
																	,@HasData3						bit				= NULL
																	,@TrackingDataItemId3			bigint			= NULL
																	,@Annotation3					nvarchar(1024)	= NULL
																	,@HasData4						bit				= NULL
																	,@TrackingDataItemId4			bigint			= NULL
																	,@Annotation4					nvarchar(1024)	= NULL
																	,@HasData5						bit				= NULL
																	,@TrackingDataItemId5			bigint			= NULL
																	,@Annotation5					nvarchar(1024)	= NULL
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	IF @HasData1 IS NOT NULL AND @HasData1 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItemAnnotation]	@TrackingDataItemId				= @TrackingDataItemId1
																,@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
																,@Annotation					= @Annotation1

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END

	IF @HasData2 IS NOT NULL AND @HasData2 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItemAnnotation]	@TrackingDataItemId				= @TrackingDataItemId2
																,@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
																,@Annotation					= @Annotation2

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END

	IF @HasData3 IS NOT NULL AND @HasData3 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItemAnnotation]	@TrackingDataItemId				= @TrackingDataItemId3
																,@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
																,@Annotation					= @Annotation3

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END

	IF @HasData4 IS NOT NULL AND @HasData4 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItemAnnotation]	@TrackingDataItemId				= @TrackingDataItemId4
																,@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
																,@Annotation					= @Annotation4

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END

	IF @HasData5 IS NOT NULL AND @HasData5 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertTrackingDataItemAnnotation]	@TrackingDataItemId				= @TrackingDataItemId5
																,@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
																,@Annotation					= @Annotation5

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END



	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	SET @ret = -1

	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	GOTO DONE

DONE:
	RETURN @ret

 END
GO


GRANT EXECUTE ON [dbo].[InsertTrackingDataItemAnnotationMultiple] TO tracking_writer
GO




IF OBJECT_ID('[dbo].[InsertEventAnnotation]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertEventAnnotation]
GO

CREATE PROCEDURE [dbo].[InsertEventAnnotation]		@WorkflowInstanceInternalId	bigint
													,@EventId					bigint
													,@EventTypeId				char(1)
													,@Annotation				nvarchar(1024) = NULL
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_InsertEventAnnotation_Failed_InsertEventAnnotation nvarchar(256)
	set @localized_string_InsertEventAnnotation_Failed_InsertEventAnnotation = N'Failed inserting into EventAnnotation'

		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END


	INSERT [dbo].[EventAnnotation] (
			[WorkflowInstanceInternalId]
			,[EventId]
			,[EventTypeId]
			,[Annotation]
	) VALUES (
			@WorkflowInstanceInternalId
			,@EventId
			,@EventTypeId
			,@Annotation
	)

	IF @@ERROR <> 0 OR @@ROWCOUNT <> 1
	 BEGIN
		SELECT @error_desc = @localized_string_InsertEventAnnotation_Failed_InsertEventAnnotation
		GOTO FAILED		
	 END

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION
	
	SET @ret = -1
	RAISERROR( @error_desc, 16, -1 )

	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertEventAnnotation] TO tracking_writer
GO





IF OBJECT_ID('[dbo].[InsertEventAnnotationMultiple]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertEventAnnotationMultiple]
GO

CREATE PROCEDURE [dbo].[InsertEventAnnotationMultiple]		@WorkflowInstanceInternalId	bigint
															,@EventTypeId				char(1)
															,@HasData1					bit
															,@EventId1					bigint
															,@Annotation1				nvarchar(1024)	= NULL
															,@HasData2					bit				= NULL
															,@EventId2					bigint			= NULL
															,@Annotation2				nvarchar(1024)	= NULL
															,@HasData3					bit				= NULL
															,@EventId3					bigint			= NULL
															,@Annotation3				nvarchar(1024)	= NULL
															,@HasData4					bit				= NULL
															,@EventId4					bigint			= NULL
															,@Annotation4				nvarchar(1024)	= NULL
															,@HasData5					bit				= NULL
															,@EventId5					bigint			= NULL
															,@Annotation5				nvarchar(1024)	= NULL
AS
 BEGIN
	SET NOCOUNT ON
		
	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	IF @HasData1 IS NOT NULL AND @HasData1 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertEventAnnotation]	@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
													,@EventId					= @EventId1
													,@EventTypeId				= @EventTypeId
													,@Annotation				= @Annotation1

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END

	IF @HasData2 IS NOT NULL AND @HasData2 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertEventAnnotation]	@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
													,@EventId					= @EventId2
													,@EventTypeId				= @EventTypeId
													,@Annotation				= @Annotation2

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END

	IF @HasData3 IS NOT NULL AND @HasData3 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertEventAnnotation]	@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
													,@EventId					= @EventId3
													,@EventTypeId				= @EventTypeId
													,@Annotation				= @Annotation3

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END

	IF @HasData4 IS NOT NULL AND @HasData4 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertEventAnnotation]	@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
													,@EventId					= @EventId4
													,@EventTypeId				= @EventTypeId
													,@Annotation				= @Annotation4

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END

	IF @HasData5 IS NOT NULL AND @HasData5 = 1
	 BEGIN
		EXEC @ret = [dbo].[InsertEventAnnotation]	@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
													,@EventId					= @EventId5
													,@EventTypeId				= @EventTypeId
													,@Annotation				= @Annotation5

		IF @@ERROR IS NULL OR @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
			GOTO FAILED	
	 END


	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	SET @ret = -1
	IF @local_tran = 1
		ROLLBACK TRANSACTION
	
	RAISERROR( @error_desc, 16, -1 )

	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertEventAnnotationMultiple] TO tracking_writer
GO





IF OBJECT_ID('[dbo].[InsertAddedActivity]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertAddedActivity]
GO

CREATE PROCEDURE [dbo].[InsertAddedActivity]	@WorkflowInstanceInternalId	bigint
												,@WorkflowInstanceEventId	bigint
												,@QualifiedName				nvarchar(128)
												,@TypeFullName				nvarchar(128)
												,@AssemblyFullName			nvarchar(256)
												,@ParentQualifiedName		nvarchar(128) 	= NULL
												,@AddedActivityAction		nvarchar(2000)	= NULL
												,@Order						int				= NULL
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			int
			,@id			int
			,@TypeId		int
			,@rowcount		int
			,@ParentWorkflowActivityId bigint

	declare @localized_string_InsertAddedActivity_Failed_GetType nvarchar(256)
	set @localized_string_InsertAddedActivity_Failed_GetType = N'InsertAddedActivity failed calling procedure GetTypeId'

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END


	/*
		Look up or insert the type of the Activity
	*/
	EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @TypeFullName
									,@AssemblyFullName	= @AssemblyFullName
									,@TypeId			= @TypeId OUTPUT
	
	IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TypeId IS NULL
	 BEGIN
		SELECT @error_desc = @localized_string_InsertAddedActivity_Failed_GetType
		GOTO FAILED
	 END

	INSERT	[dbo].[AddedActivity] (
		[WorkflowInstanceInternalId]
		,[WorkflowInstanceEventId]
		,[QualifiedName]
		,[ActivityTypeId]
		,[ParentQualifiedName]
		,[AddedActivityAction]
		,[Order]
	) VALUES (
		@WorkflowInstanceInternalId
		,@WorkflowInstanceEventId
		,@QualifiedName
		,@TypeId
		,@ParentQualifiedName
		,@AddedActivityAction
		,@Order
	)

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertAddedActivity] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[InsertRemovedActivity]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertRemovedActivity]
GO

CREATE PROCEDURE [dbo].[InsertRemovedActivity]	@WorkflowInstanceInternalId		bigint
												,@WorkflowInstanceEventId		bigint
												,@QualifiedName					nvarchar(128)
												,@ParentQualifiedName			nvarchar(128) 	= NULL
												,@RemovedActivityAction			nvarchar(2000)	= NULL
												,@Order							int				= NULL
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @error			int
			,@error_desc	nvarchar(256)
			,@ret			int
			,@rowcount		int

	declare @localized_string_InsertRemovedActivity_Failed_RemovedInsert nvarchar(256)
	set @localized_string_InsertRemovedActivity_Failed_RemovedInsert = N'InsertRemovedActivity failed inserting in RemovedActivity'

	INSERT	[dbo].[RemovedActivity] (
		[WorkflowInstanceInternalId]
		,[WorkflowInstanceEventId]
		,[QualifiedName]
		,[ParentQualifiedName]
		,[RemovedActivityAction]
		,[Order]
	) VALUES (
		@WorkflowInstanceInternalId
		,@WorkflowInstanceEventId
		,@QualifiedName
		,@ParentQualifiedName
		,@RemovedActivityAction
		,@Order
	)

	SELECT @error = @@ERROR, @rowcount = @@ROWCOUNT

	IF @error IS NULL OR @error <> 0 OR @rowcount IS NULL OR @rowcount <> 1
	 BEGIN
		SELECT @error_desc = @localized_string_InsertRemovedActivity_Failed_RemovedInsert
		GOTO FAILED
	 END



	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertRemovedActivity] TO tracking_writer
GO


/*************************************************************************************************************************************

		
														Partition Procs


*************************************************************************************************************************************/


IF OBJECT_ID('[dbo].[SetPartitionInterval]') IS NOT NULL
	DROP PROCEDURE [dbo].[SetPartitionInterval]
GO

CREATE PROCEDURE [dbo].[SetPartitionInterval]	@Interval char(1)
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			int

	declare @localized_string_SetPartitionInterval_Failed nvarchar(256)
	set @localized_string_SetPartitionInterval_Failed = N'CreatePartition failed setting the partition interval'
 
	declare @localized_string_SetPartitionInterval_Failed_InvalidInterval nvarchar(256)
	set @localized_string_SetPartitionInterval_Failed_InvalidInterval = N'CreatePartition failed - @Interval must be ''h'' (hourly), ''d'' (daily), ''w'' (weekly), ''m'' (monthly), ''y'' (yearly), ''u'' (user defined - partitions manually created using TrackingPartition_CreateUserDefinedPartition)'
 
	SELECT @Interval = lower(@Interval)

	IF @Interval NOT IN ( 'd', 'w', 'm', 'y' )
	 BEGIN
		SET @error_desc = @localized_string_SetPartitionInterval_Failed_InvalidInterval
		GOTO DONE
	 END

	IF EXISTS ( SELECT 1 FROM [dbo].[TrackingPartitionInterval] )
	 BEGIN
		UPDATE [dbo].[TrackingPartitionInterval] SET [Interval] = @Interval

		SELECT @error = @@ERROR

		IF @error IS NULL OR @error <> 0
		 BEGIN
			SET @error_desc = @localized_string_SetPartitionInterval_Failed_InvalidInterval
			GOTO DONE
		 END
	 END
	ELSE
	 BEGIN
		INSERT [dbo].[TrackingPartitionInterval] VALUES ( @Interval )

		SELECT @error = @@ERROR

		IF @error IS NULL OR @error <> 0
		 BEGIN
			SET @error_desc = @localized_string_SetPartitionInterval_Failed_InvalidInterval
			GOTO DONE
		 END
	 END

	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO
	
GRANT EXECUTE ON [dbo].[SetPartitionInterval] TO tracking_writer
GO


IF OBJECT_ID('[dbo].[TrackingPartition_DropPartitionViews]') IS NOT NULL
	DROP PROCEDURE [dbo].[TrackingPartition_DropPartitionViews]
GO

CREATE PROCEDURE [dbo].[TrackingPartition_DropPartitionViews]
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int

	declare @localized_string_TrackingPartition_DropPartitionViews_Failed nvarchar(256)
	set @localized_string_TrackingPartition_DropPartitionViews_Failed = N'RebuildPartitionViews failed'
		
	IF OBJECT_ID('[dbo].[vw_AddedActivity]') IS NOT NULL
		DROP VIEW [dbo].[vw_AddedActivity]
	
	IF OBJECT_ID('[dbo].[vw_RemovedActivity]') IS NOT NULL
		DROP VIEW [dbo].[vw_RemovedActivity]
	
	IF OBJECT_ID('[dbo].[vw_TrackingDataItemAnnotation]') IS NOT NULL
		DROP VIEW [dbo].[vw_TrackingDataItemAnnotation]
	
	IF OBJECT_ID('[dbo].[vw_EventAnnotation]') IS NOT NULL
		DROP VIEW [dbo].[vw_EventAnnotation]
	
	IF OBJECT_ID('[dbo].[vw_TrackingDataItem]') IS NOT NULL
		DROP VIEW [dbo].[vw_TrackingDataItem]
	
	IF OBJECT_ID('[dbo].[vw_ActivityExecutionStatusEvent]') IS NOT NULL
		DROP VIEW [dbo].[vw_ActivityExecutionStatusEvent]
	
	IF OBJECT_ID('[dbo].[vw_UserEvent]') IS NOT NULL
		DROP VIEW [dbo].[vw_UserEvent]
	
	IF OBJECT_ID('[dbo].[vw_ActivityInstance]') IS NOT NULL
		DROP VIEW [dbo].[vw_ActivityInstance]
	
	IF OBJECT_ID('[dbo].[vw_WorkflowInstanceEvent]') IS NOT NULL
		DROP VIEW [dbo].[vw_WorkflowInstanceEvent]
	
	IF OBJECT_ID('[dbo].[vw_WorkflowInstance]') IS NOT NULL
		DROP VIEW [dbo].[vw_WorkflowInstance]
	

	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO
	
GRANT EXECUTE ON [dbo].[TrackingPartition_DropPartitionViews] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[RebuildPartitionViews]') IS NOT NULL
	DROP PROCEDURE [dbo].[RebuildPartitionViews]
GO

CREATE PROCEDURE [dbo].[RebuildPartitionViews]
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int

	declare @localized_string_RebuildPartitionViews_Failed nvarchar(256)
	set @localized_string_RebuildPartitionViews_Failed = N'RebuildPartitionViews failed'
	
	declare @localized_string_RebuildPartitionViews_Failed_Drop nvarchar(256)
	set @localized_string_RebuildPartitionViews_Failed_Drop = N'RebuildPartitionViews failed calling TrackingPartition_DropPartitionViews'
	
	declare	@WorkflowInstance 		varchar(8000)
			,@ActivityInstance		varchar(8000)
			,@ActivityExecutionStatusEvent	varchar(8000)
			,@WorkflowInstanceEvent	varchar(8000)
			,@UserEvent				varchar(8000)
			,@TrackingDataItem				varchar(8000)
			,@TrackingDataItemAnnotation	varchar(8000)
			,@EventAnnotation		varchar(8000)
			,@AddedActivity			varchar(8000)
			,@RemovedActivity		varchar(8000)
			,@Name					varchar(32)

	
	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END
	
	-- Drop the views
	EXEC @ret = [dbo].[TrackingPartition_DropPartitionViews]

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @error <> 0
	 BEGIN
		SET @error_desc = @localized_string_RebuildPartitionViews_Failed_Drop
		GOTO FAILED
	 END

	-- Define each view with its corresponding base table
	SELECT @WorkflowInstance = '
		CREATE VIEW [dbo].[vw_WorkflowInstance]
		AS
		SELECT		[WorkflowInstanceInternalId]
					,[WorkflowInstanceId]
					,[ContextGuid]
					,[CallerInstanceId]
					,[CallPath]
					,[CallerContextGuid]
					,[CallerParentContextGuid]
					,[WorkflowTypeId]
					,[InitializedDateTime]
					,[DbInitializedDateTime]
					,[EndDateTime]
					,[DbEndDateTime]
		FROM		[dbo].[WorkflowInstance] '

	SELECT @ActivityInstance = '
		CREATE VIEW [dbo].[vw_ActivityInstance]
		AS
		SELECT		[WorkflowInstanceInternalId]
					,[ActivityInstanceId]
					,[QualifiedName]
					,[ContextGuid]
					,[ParentContextGuid]
					,[WorkflowInstanceEventId]
		FROM		[dbo].[ActivityInstance] '

	SELECT @ActivityExecutionStatusEvent = '	
		CREATE VIEW [dbo].[vw_ActivityExecutionStatusEvent]
		AS
		SELECT		[ActivityExecutionStatusEventId]
					,[WorkflowInstanceInternalId]
					,[EventOrder]				
					,[ActivityInstanceId]		
					,[ExecutionStatusId]					
					,[EventDateTime]
					,[DbEventDateTime]
		FROM		[dbo].[ActivityExecutionStatusEvent] '

	SELECT @WorkflowInstanceEvent = '
		CREATE VIEW [dbo].[vw_WorkflowInstanceEvent]
		AS
		SELECT		[WorkflowInstanceEventId]	
					,[WorkflowInstanceInternalId]
					,[TrackingWorkflowEventId]
					,[EventDateTime]	
					,[EventOrder]		
					,[EventArgTypeId]		
					,[EventArg]
					,[DbEventDateTime]
		FROM		[dbo].[WorkflowInstanceEvent] '

	SELECT @UserEvent = '	
		CREATE VIEW [dbo].[vw_UserEvent]
		AS
		SELECT		[UserEventId]
					,[WorkflowInstanceInternalId]
					,[EventOrder]
					,[ActivityInstanceId]
					,[EventDateTime]
					,[UserDataKey]
					,[UserDataTypeId]
					,[UserData_Str]
					,[UserData_Blob]
					,[UserDataNonSerializable]
					,[DbEventDateTime]
		FROM		[dbo].[UserEvent] '

	SELECT @TrackingDataItem = '		
		CREATE VIEW [dbo].[vw_TrackingDataItem]
		AS
		SELECT		[TrackingDataItemId]
					,[WorkflowInstanceInternalId]
					,[EventId]
					,[EventTypeId]
					,[FieldName]
					,[FieldTypeId]
					,[Data_Str]
					,[Data_Blob]
					,[DataNonSerializable]
		FROM		[dbo].[TrackingDataItem] '

	SELECT @TrackingDataItemAnnotation = '
		CREATE VIEW [dbo].[vw_TrackingDataItemAnnotation]
		AS
		SELECT		[TrackingDataItemId]
					,[WorkflowInstanceInternalId]
					,[Annotation]
		FROM		[dbo].[TrackingDataItemAnnotation] '

	SELECT @EventAnnotation = '	
		CREATE VIEW [dbo].[vw_EventAnnotation]
		AS
		SELECT		[WorkflowInstanceInternalId]
					,[EventId]
					,[EventTypeId]
					,[Annotation]
		FROM 		[dbo].[EventAnnotation] '

	SELECT @AddedActivity = '
		CREATE VIEW [dbo].[vw_AddedActivity]
		AS
		SELECT		[WorkflowInstanceInternalId]
					,[WorkflowInstanceEventId]
					,[QualifiedName]
					,[ActivityTypeId]
					,[ParentQualifiedName]
					,[AddedActivityAction]
					,[Order]
		FROM		[dbo].[AddedActivity] '

	SELECT @RemovedActivity = '	
		CREATE VIEW [dbo].[vw_RemovedActivity]
		AS
		SELECT		[WorkflowInstanceInternalId]
					,[WorkflowInstanceEventId]
					,[QualifiedName]
					,[ParentQualifiedName]
					,[RemovedActivityAction]
					,[Order]
		FROM		[dbo].[RemovedActivity] '

	declare partition_cursor CURSOR FOR
	SELECT	[Name]
	FROM	[dbo].[TrackingPartitionSetName]

	OPEN partition_cursor

	FETCH NEXT FROM partition_cursor INTO @Name

	-- For each partition add a UNION ALL clause for it to each view
	WHILE @@FETCH_STATUS = 0
	 BEGIN
		SELECT @WorkflowInstance = @WorkflowInstance + '
		UNION ALL
		SELECT		[WorkflowInstanceInternalId]
					,[WorkflowInstanceId]
					,[ContextGuid]
					,[CallerInstanceId]
					,[CallPath]
					,[CallerContextGuid]
					,[CallerParentContextGuid]
					,[WorkflowTypeId]
					,[InitializedDateTime]
					,[DbInitializedDateTime]
					,[EndDateTime]
					,[DbEndDateTime]
		FROM		[dbo].[WorkflowInstance_' + @Name +'] '

		SELECT @ActivityInstance = @ActivityInstance + '
		UNION ALL 
		SELECT		[WorkflowInstanceInternalId]
					,[ActivityInstanceId]
					,[QualifiedName]
					,[ContextGuid]
					,[ParentContextGuid]
					,[WorkflowInstanceEventId]
		FROM		[dbo].[ActivityInstance_' + @Name + '] '
		
		SELECT @ActivityExecutionStatusEvent = @ActivityExecutionStatusEvent + '	
		UNION ALL
		SELECT		[ActivityExecutionStatusEventId]
					,[WorkflowInstanceInternalId]
					,[EventOrder]				
					,[ActivityInstanceId]		
					,[ExecutionStatusId]					
					,[EventDateTime]
					,[DbEventDateTime]
		FROM		[dbo].[ActivityExecutionStatusEvent_' + @Name + '] '
		
		SELECT @WorkflowInstanceEvent = @WorkflowInstanceEvent + '
		UNION ALL
		SELECT		[WorkflowInstanceEventId]	
					,[WorkflowInstanceInternalId]
					,[TrackingWorkflowEventId]
					,[EventDateTime]	
					,[EventOrder]		
					,[EventArgTypeId]		
					,[EventArg]
					,[DbEventDateTime]
		FROM		[dbo].[WorkflowInstanceEvent_' + @Name + '] '

		SELECT @UserEvent = @UserEvent + '	
		UNION ALL
		SELECT		[UserEventId]
					,[WorkflowInstanceInternalId]
					,[EventOrder]
					,[ActivityInstanceId]
					,[EventDateTime]
					,[UserDataKey]
					,[UserDataTypeId]
					,[UserData_Str]
					,[UserData_Blob]
					,[UserDataNonSerializable]
					,[DbEventDateTime]
		FROM		[dbo].[UserEvent_' + @Name + '] '
		
		SELECT @TrackingDataItem = @TrackingDataItem + '		
		UNION ALL
		SELECT		[TrackingDataItemId]
					,[WorkflowInstanceInternalId]
					,[EventId]
					,[EventTypeId]
					,[FieldName]
					,[FieldTypeId]
					,[Data_Str]
					,[Data_Blob]
					,[DataNonSerializable]
		FROM		[dbo].[TrackingDataItem_' + @Name + '] '
		
		SELECT @TrackingDataItemAnnotation = @TrackingDataItemAnnotation + '
		UNION ALL
		SELECT		[TrackingDataItemId]
					,[WorkflowInstanceInternalId]					
					,[Annotation]
		FROM		[dbo].[TrackingDataItemAnnotation_' + @Name + '] '

		SELECT @EventAnnotation = @EventAnnotation + '	
		UNION ALL
		SELECT		[WorkflowInstanceInternalId]
					,[EventId]
					,[EventTypeId]
					,[Annotation]
		FROM 		[dbo].[EventAnnotation_' + @Name + '] '

		SELECT @AddedActivity = @AddedActivity + '
		UNION ALL
		SELECT		[WorkflowInstanceInternalId]
					,[WorkflowInstanceEventId]
					,[QualifiedName]
					,[ActivityTypeId]
					,[ParentQualifiedName]
					,[AddedActivityAction]
					,[Order]
		FROM		[dbo].[AddedActivity_' + @Name + '] '

		SELECT @RemovedActivity = @RemovedActivity + '	
		UNION ALL
		SELECT		[WorkflowInstanceInternalId]
					,[WorkflowInstanceEventId]
					,[QualifiedName]
					,[ParentQualifiedName]
					,[RemovedActivityAction]
					,[Order]
		FROM		[dbo].[RemovedActivity_' + @Name + '] '

		FETCH NEXT FROM partition_cursor INTO @Name
	 END -- cursor loop

	CLOSE partition_cursor
	DEALLOCATE partition_cursor

	-- Execute all of the CREATE statements

	EXEC( @WorkflowInstance )

	EXEC( @ActivityInstance )

	EXEC( @ActivityExecutionStatusEvent )

	EXEC( @UserEvent )

	EXEC( @WorkflowInstanceEvent )

	EXEC( @TrackingDataItem )

	EXEC( @TrackingDataItemAnnotation )

	EXEC( @EventAnnotation )

	EXEC( @AddedActivity )
	
	EXEC( @RemovedActivity )


	-- Grant select for each of the rebuilt views
	GRANT SELECT ON [dbo].[vw_WorkflowInstance] TO tracking_reader 
	GRANT SELECT ON [dbo].[vw_ActivityInstance] TO tracking_reader 
	GRANT SELECT ON [dbo].[vw_ActivityExecutionStatusEvent] TO tracking_reader 
	GRANT SELECT ON [dbo].[vw_UserEvent] TO tracking_reader 
	GRANT SELECT ON [dbo].[vw_WorkflowInstanceEvent] TO tracking_reader 
	GRANT SELECT ON [dbo].[vw_TrackingDataItem] TO tracking_reader 
	GRANT SELECT ON [dbo].[vw_TrackingDataItemAnnotation] TO tracking_reader 
	GRANT SELECT ON [dbo].[vw_EventAnnotation] TO tracking_reader 
	GRANT SELECT ON [dbo].[vw_AddedActivity] TO tracking_reader 
	GRANT SELECT ON [dbo].[vw_RemovedActivity] TO tracking_reader

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[RebuildPartitionViews] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[DetachPartition]') IS NOT NULL
	DROP PROCEDURE [dbo].[DetachPartition]
GO

CREATE PROCEDURE [dbo].[DetachPartition] @PartitionName varchar(32) = NULL OUT, @PartitionId int = NULL
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_DetachPartition_Failed nvarchar(256)
	set @localized_string_DetachPartition_Failed = N'DetachPartition failed.'

	declare @localized_string_DetachPartition_Failed_NullArgs nvarchar(256)
	set @localized_string_DetachPartition_Failed_NullArgs = N'DetachPartition failed - either @PartitionName or @PartitionId must be non null.'

	declare @localized_string_DetachPartition_Failed_InvalidName nvarchar(256)
	set @localized_string_DetachPartition_Failed_InvalidName = N'DetachPartition failed - @PartitionName does not exist.'

	declare @localized_string_DetachPartition_Failed_InvalidId nvarchar(256)
	set @localized_string_DetachPartition_Failed_InvalidId = N'DetachPartition failed - @PartitionId does not exist.'

	declare @localized_string_DetachPartition_Failed_IdNameMismatch nvarchar(256)
	set @localized_string_DetachPartition_Failed_IdNameMismatch = N'DetachPartition failed - @PartitionName does not match @PartitionId.'

	declare @localized_string_DetachPartition_Failed_IntervalCreated nvarchar(256)
	set @localized_string_DetachPartition_Failed_IntervalCreated = N'DetachPartition failed selecting the partition record.'

	declare @localized_string_DetachPartition_Failed_Rebuild nvarchar(256)
	set @localized_string_DetachPartition_Failed_Rebuild = N'DetachPartition failed calling RebuildPartitionViews.'

	declare @localized_string_DetachPartition_Failed_DropViews nvarchar(256)
	set @localized_string_DetachPartition_Failed_DropViews = N'DetachPartition failed calling TrackingPartition_DropPartitionViews.'

	declare @localized_string_DetachPartition_Failed_DeleteSet nvarchar(256)
	set @localized_string_DetachPartition_Failed_DeleteSet = N'DetachPartition failed deleting the partition set record.'

	declare @localized_string_DetachPartition_Failed_Active nvarchar(256)
	set @localized_string_DetachPartition_Failed_Active = N'DetachPartition failed - the partition is currently active or is in the rollover period.'

	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int
	
	SELECT @local_tran = 0

	IF @PartitionName IS NULL AND @PartitionId IS NULL
	 BEGIN
		SET @error_desc = @localized_string_DetachPartition_Failed_NullArgs
		GOTO FAILED
	 END

	DECLARE @interval char(1), @created datetime, @end datetime
	-- Validate name or get name from id
	IF @PartitionName IS NOT NULL AND @PartitionId IS NOT NULL
	 BEGIN
		IF NOT EXISTS (	SELECT 1 FROM [dbo].[TrackingPartitionSetName] WHERE [Name] = @PartitionName AND [PartitionId] = @PartitionId )
		 BEGIN
			SELECT @error_desc = @localized_string_DetachPartition_Failed_IdNameMismatch
			GOTO FAILED
		 END

		SELECT 	@interval 	= [PartitionInterval]
				,@created 	= [CreatedDateTime]
				,@end		= [EndDateTime]
		FROM	[dbo].[TrackingPartitionSetName]
		WHERE	[PartitionId] = @PartitionId
		
		IF @created IS NULL OR @interval IS NULL
		 BEGIN
				SELECT @error_desc = @localized_string_DetachPartition_Failed_IntervalCreated
				GOTO FAILED
		 END
	 END
	ELSE IF @PartitionName IS NOT NULL
	 BEGIN
		SELECT	@PartitionId= [PartitionId]
				,@interval 	= [PartitionInterval]
				,@created 	= [CreatedDateTime]
				,@end		= [EndDateTime]
		FROM 	[dbo].[TrackingPartitionSetName] 
		WHERE 	[Name] = @PartitionName

		IF @PartitionId IS NULL
		 BEGIN
				SELECT @error_desc = @localized_string_DetachPartition_Failed_InvalidName
				GOTO FAILED
		 END
	 END
	ELSE
	 BEGIN
		SELECT 	@PartitionName = [Name]
				,@interval 	= [PartitionInterval]
				,@created 	= [CreatedDateTime]
				,@end		= [EndDateTime]
		FROM	[dbo].[TrackingPartitionSetName]
		WHERE	[PartitionId] = @PartitionId

		IF @PartitionName IS NULL
		 BEGIN
			SELECT @error_desc = @localized_string_DetachPartition_Failed_InvalidId
			GOTO FAILED
		 END
	 END

	-- Make sure this isn't the active partition or in the rollover period
	DECLARE @dt datetime
	SELECT @dt = getutcdate()
	IF @end IS NULL OR dateadd( hour, 1, @end ) > @dt
	 BEGIN
		SELECT @error_desc = @localized_string_DetachPartition_Failed_Active
		GOTO FAILED
	 END

	-- @PartitionName is valid
	IF @@TRANCOUNT = 0
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	DELETE [dbo].[TrackingPartitionSetName] WHERE [Name] = @PartitionName
	
	SELECT @error = @@ERROR, @rowcount = @@ROWCOUNT

	IF @error IS NULL OR @error <> 0 OR @rowcount IS NULL OR @rowcount <> 1
	 BEGIN
		SELECT @error_desc = @localized_string_DetachPartition_Failed_DeleteSet
		GOTO FAILED
	 END
	
	EXEC @ret = [dbo].[RebuildPartitionViews]

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_DetachPartition_Failed_Rebuild
		GOTO FAILED
	 END
	

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO
	
GRANT EXECUTE ON [dbo].[DetachPartition] TO tracking_writer
GO


IF OBJECT_ID('[dbo].[DropPartition]') IS NOT NULL
	DROP PROCEDURE [dbo].[DropPartition]
GO

CREATE PROCEDURE [dbo].[DropPartition] @PartitionName varchar(32) = NULL, @PartitionId int = NULL
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_DropPartition_Failed nvarchar(256)
	set @localized_string_DropPartition_Failed = N'TrackingPartition_RebuildPartition failed.'
		
	declare @localized_string_DropPartition_Failed_DetachPartition nvarchar(256)
	set @localized_string_DropPartition_Failed_DetachPartition = N'TrackingPartition_RebuildPartition failed calling DetachPartition.'
		
	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int
	
	IF @@TRANCOUNT = 0
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END
	ELSE
	 BEGIN		
		SELECT @local_tran = 0
	 END

	-- Detach the partition and rebuild the views
	EXEC @ret = [dbo].[DetachPartition] @PartitionId = @PartitionId, @PartitionName = @PartitionName OUT

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_DropPartition_Failed_DetachPartition
		GOTO FAILED
	 END

	-- Tables are no longer part of the views, drop them
	EXEC( '
	IF OBJECT_ID(''[dbo].[AddedActivity_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[AddedActivity_' + @PartitionName +']' )
	
	EXEC( '
	IF OBJECT_ID(''[dbo].[RemovedActivity_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[RemovedActivity_' + @PartitionName +']' )
	
	EXEC( '	
	IF OBJECT_ID(''[dbo].[TrackingDataItemAnnotation_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[TrackingDataItemAnnotation_' + @PartitionName +']' )
	
	EXEC( '
	IF OBJECT_ID(''[dbo].[EventAnnotation_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[EventAnnotation_' + @PartitionName +']' )
	
	EXEC( '
	IF OBJECT_ID(''[dbo].[TrackingDataItem_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[TrackingDataItem_' + @PartitionName +']' )

	EXEC( '	
	IF OBJECT_ID(''[dbo].[ActivityExecutionStatusEvent_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[ActivityExecutionStatusEvent_' + @PartitionName +']' )
	
	EXEC( '
	IF OBJECT_ID(''[dbo].[UserEvent_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[UserEvent_' + @PartitionName +']' )
	
	EXEC( '
	IF OBJECT_ID(''[dbo].[ActivityInstance_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[ActivityInstance_' + @PartitionName +']' )
	
	EXEC( '
	IF OBJECT_ID(''[dbo].[WorkflowInstanceEvent_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[WorkflowInstanceEvent_' + @PartitionName +']' )
	
	EXEC( '
	IF OBJECT_ID(''[dbo].[WorkflowInstance_' + @PartitionName +']'') IS NOT NULL
		DROP TABLE [dbo].[WorkflowInstance_' + @PartitionName +']' )



	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO
	
GRANT EXECUTE ON [dbo].[DropPartition] TO tracking_writer
GO


IF OBJECT_ID('[dbo].[CreatePartition]') IS NOT NULL
	DROP PROCEDURE [dbo].[CreatePartition]
GO

CREATE PROCEDURE [dbo].[CreatePartition]	@PartitionSetName varchar(32), @PartitionInterval char(1)
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int

	declare @localized_string_CreatePartition_Failed nvarchar(256)
	set @localized_string_CreatePartition_Failed = N'CreatePartition failed'

	declare @localized_string_CreatePartition_Failed_CreatingTables nvarchar(256)
	set @localized_string_CreatePartition_Failed_CreatingTables = N'CreatePartition failed creating the tables for the new partition.'

	declare @localized_string_CreatePartition_Failed_InsertingPartitionName nvarchar(256)
	set @localized_string_CreatePartition_Failed_InsertingPartitionName = N'CreatePartition failed inserting into TrackingPartitionSetName.'

	declare @localized_string_CreatePartition_Failed_UpdatingPartitionEnd nvarchar(256)
	set @localized_string_CreatePartition_Failed_UpdatingPartitionEnd = N'CreatePartition failed updating the end time for the previous partition.'

	declare @localized_string_CreatePartition_Failed_RebuildPartitionViews nvarchar(256)
	set @localized_string_CreatePartition_Failed_RebuildPartitionViews = N'CreatePartition failed rebuilding the partitioned views.'

	DECLARE	@stmt1 varchar(8000), @stmt2 varchar(8000)
	SELECT	@stmt1 = 			
			'	
			CREATE TABLE [dbo].[WorkflowInstance_' + @PartitionSetName + ']
			(
				[WorkflowInstanceInternalId] bigint				NOT NULL	CONSTRAINT [pk_WorkflowInstance_' + @PartitionSetName + '_WorkflowInstanceInternalId] PRIMARY KEY CLUSTERED
				,[WorkflowInstanceId]		uniqueidentifier	NOT NULL
				,[ContextGuid]				uniqueidentifier	NOT NULL
				,[CallerInstanceId]			uniqueidentifier	NULL
				,[CallPath]					nvarchar(400)		NULL
				,[CallerContextGuid]		uniqueidentifier	NULL
				,[CallerParentContextGuid]	uniqueidentifier	NULL
				,[WorkflowTypeId]			int					NOT NULL
				,[InitializedDateTime]		datetime			NOT NULL
				,[DbInitializedDateTime]	datetime			NOT NULL
				,[EndDateTime]				datetime			NOT NULL -- Not null because only inactive instance should be in partition tables
				,[DbEndDateTime]			datetime			NOT NULL -- Not null because only inactive instance should be in partition tables
			)			
			CREATE NONCLUSTERED INDEX [idx_WorkflowInstance_' + @PartitionSetName + '_WorkflowInstanceId_ContextGuid] ON [dbo].[WorkflowInstance_' + @PartitionSetName + ']([WorkflowInstanceId],[ContextGuid])
			CREATE TABLE [dbo].[ActivityInstance_' + @PartitionSetName + ']
			(
				[WorkflowInstanceInternalId]	bigint				NOT NULL
				,[ActivityInstanceId]			bigint				NOT NULL	CONSTRAINT [pk_ActivityInstance_' + @PartitionSetName + '_ActivityInstanceId] PRIMARY KEY CLUSTERED
				,[QualifiedName]				nvarchar(128)		NOT NULL	
				,[ContextGuid]					uniqueidentifier	NOT NULL
				,[ParentContextGuid]			uniqueidentifier	NULL
				,[WorkflowInstanceEventId]		bigint				NULL
			)			
			CREATE NONCLUSTERED INDEX [idx_ActivityInstance_' + @PartitionSetName + '_WorkflowInstanceInternalId_QualifiedName_ContextGuid_ParentContextGuid] ON [dbo].[ActivityInstance_' + @PartitionSetName + ']([WorkflowInstanceInternalId],[QualifiedName],[ContextGuid],[ParentContextGuid])			
			CREATE TABLE [dbo].[ActivityExecutionStatusEvent_' + @PartitionSetName + ']
			(
				[ActivityExecutionStatusEventId] bigint				NOT NULL
				,[WorkflowInstanceInternalId]	bigint				NOT NULL	
				,[EventOrder]					int					NOT NULL
				,[ActivityInstanceId]			bigint				NOT NULL	
				,[ExecutionStatusId]			tinyint				NOT NULL
				,[EventDateTime]				datetime			NOT NULL
				,[DbEventDateTime]				datetime			NOT NULL
			)			
			CREATE NONCLUSTERED INDEX [idx_ActivityExecutionStatusEvent_' + @PartitionSetName + '_ActivityInstanceId_EventOrder] ON [dbo].[ActivityExecutionStatusEvent_' + @PartitionSetName + ']( [ActivityInstanceId], [EventOrder] )			
			CREATE TABLE [dbo].[UserEvent_' + @PartitionSetName + ']
			(
				[UserEventId]					bigint			NOT NULL
				,[WorkflowInstanceInternalId]	bigint			NOT NULL	
				,[EventOrder]					int				NOT NULL
				,[ActivityInstanceId]			bigint			NOT NULL
				,[EventDateTime]				datetime		NOT NULL
				,[UserDataKey]					nvarchar(512)	NULL
				,[UserDataTypeId]				int				NULL
				,[UserData_Str]					nvarchar(512)	NULL
				,[UserData_Blob]				image			NULL
				,[UserDataNonSerializable]		bit				NOT NULL
				,[DbEventDateTime]				datetime		NOT NULL
			)
			CREATE TABLE [dbo].[WorkflowInstanceEvent_' + @PartitionSetName + ']
			(
				[WorkflowInstanceEventId]		bigint			NOT NULL		CONSTRAINT [pk_WorkflowInstanceEvent_' + @PartitionSetName + '_WorkflowInstanceEventId] PRIMARY KEY CLUSTERED
				,[WorkflowInstanceInternalId]	bigint			NOT NULL
				,[TrackingWorkflowEventId]				tinyint			NOT NULL
				,[EventDateTime]				datetime		NOT NULL
				,[EventOrder]					int				NOT NULL
				,[EventArgTypeId]					int				NULL
				,[EventArg]							image			NULL
				,[DbEventDateTime]				datetime			NOT NULL
			)'
	SELECT @stmt2 = 
			'
			CREATE TABLE [dbo].[TrackingDataItem_' + @PartitionSetName + ']
			(
				[TrackingDataItemId]					bigint			NOT NULL	CONSTRAINT [pk_TrackingDataItem_' + @PartitionSetName + '_TrackingDataItemId] PRIMARY KEY CLUSTERED 
				,[WorkflowInstanceInternalId]	bigint			NOT NULL
				,[EventId]					bigint				NOT NULL
				,[EventTypeId]				char(1)				NOT NULL
				,[FieldName]						nvarchar(256)	NOT NULL
				,[FieldTypeId]						int				NULL
				,[Data_Str]						nvarchar(512)	NULL
				,[Data_Blob]					image			NULL
				,[DataNonSerializable]			bit				NOT NULL
			)			
			CREATE NONCLUSTERED INDEX [idx_TrackingDataItem_' + @PartitionSetName + '_WorkflowInstanceInternalId_EventId_EventTypeId] ON [dbo].[TrackingDataItem_' + @PartitionSetName + ']( [WorkflowInstanceInternalId], [EventId], [EventTypeId] )			
			CREATE TABLE [dbo].[TrackingDataItemAnnotation_' + @PartitionSetName + ']
			(
				[TrackingDataItemId]					bigint			NOT NULL
				,[WorkflowInstanceInternalId]	bigint			NOT NULL
				,[Annotation]					nvarchar(1024)	NOT NULL		
			)			
			CREATE CLUSTERED INDEX [idx_TrackingDataItemAnnotation_' + @PartitionSetName + '_TrackingDataItemId] ON [dbo].[TrackingDataItemAnnotation_' + @PartitionSetName + ']( [TrackingDataItemId] )			
			CREATE TABLE [dbo].[EventAnnotation_' + @PartitionSetName + ']
			(
				[WorkflowInstanceInternalId]	bigint			NOT NULL
				,[EventId]						bigint			NOT NULL
				,[EventTypeId]					char(1)			NOT NULL
				,[Annotation]					nvarchar(1024)	NULL		
			)			
			CREATE CLUSTERED INDEX [idx_EventAnnotation_' + @PartitionSetName + '_WorkflowInstanceInternalId] ON [dbo].[EventAnnotation_' + @PartitionSetName + ']( [WorkflowInstanceInternalId] )			
			CREATE NONCLUSTERED INDEX [idx_EventAnnotation_' + @PartitionSetName + '_EventId_EventTypeId] ON [dbo].[EventAnnotation_' + @PartitionSetName + ']( [EventId], [EventTypeId] )			
	
			CREATE TABLE [dbo].[AddedActivity_' + @PartitionSetName + ']
			(
				[WorkflowInstanceInternalId]	bigint				NOT NULL
				,[WorkflowInstanceEventId]		bigint				NOT NULL
				,[QualifiedName]				nvarchar(128)		NOT NULL
				,[ActivityTypeId]				int					NOT NULL
				,[ParentQualifiedName]			nvarchar(128)		NULL	
				,[AddedActivityAction]			nvarchar(2000)		NULL
				,[Order]						int					NULL
			)			
			CREATE TABLE [dbo].[RemovedActivity_' + @PartitionSetName + ']
			(
				[WorkflowInstanceInternalId]	bigint				NOT NULL
				,[WorkflowInstanceEventId]		bigint				NOT NULL
				,[QualifiedName]				nvarchar(128)		NOT NULL
				,[ParentQualifiedName]			nvarchar(128)		NULL
				,[RemovedActivityAction]		nvarchar(2000)		NULL
				,[Order]						int					NULL
			)
	' 

	-- Build the new tables
	EXEC ( @stmt1 + @stmt2 )

	IF @@ERROR <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_CreatePartition_Failed_CreatingTables
		GOTO FAILED
	 END

	-- Update the end date of the previous partition
	UPDATE [dbo].[TrackingPartitionSetName] SET [EndDateTime] = getutcdate() WHERE [EndDateTime] IS NULL

	SELECT @error = @@ERROR, @rowcount = @@ROWCOUNT

	IF @error IS NULL OR @error <> 0 OR @rowcount IS NULL OR @rowcount > 1
	 BEGIN
		SELECT @error_desc = @localized_string_CreatePartition_Failed_UpdatingPartitionEnd
		GOTO FAILED
	 END
	
	-- Insert a record for the new partition
	DECLARE	@pId int
	INSERT [dbo].[TrackingPartitionSetName] ( [Name], [PartitionInterval] )  VALUES ( @PartitionSetName, @PartitionInterval )

	SELECT @pId = @@IDENTITY, @error = @@ERROR

	IF @pId IS NULL OR @error IS NULL OR @error <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_CreatePartition_Failed_InsertingPartitionName
		GOTO FAILED
	 END
	
	-- Rebuild the views
	EXEC @ret = [dbo].[RebuildPartitionViews]

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_CreatePartition_Failed_RebuildPartitionViews
		GOTO FAILED
	 END
	 
	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[CreatePartition] TO tracking_writer
GO


IF OBJECT_ID('[dbo].[GetPartitionSetNameForWorkflowInstance]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetPartitionSetNameForWorkflowInstance]
GO

CREATE PROCEDURE [dbo].[GetPartitionSetNameForWorkflowInstance] @WorkflowInstanceInternalId bigint, @PartitionSetName nvarchar(32) OUTPUT
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed = N'GetPartitionSetNameForWorkflowInstance failed'

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_Interval_Sel nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_Interval_Sel = N'GetPartitionSetNameForWorkflowInstance failed selecting the partition interval.'

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_Invalid_Interval nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_Invalid_Interval = N'GetPartitionSetNameForWorkflowInstance failed - invalid partition interval.'

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_BuildPartitionSet nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_BuildPartitionSet = N'GetPartitionSetNameForWorkflowInstance failed calling CreatePartition.'

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_InvalidPartitionSet nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_InvalidPartitionSet = N'GetPartitionSetNameForWorkflowInstance failed - partition is not active and rollover period has ended.'

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_InvalidInternalId nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_InvalidInternalId = N'GetPartitionSetNameForWorkflowInstance failed - @WorkflowInstanceInternalId %s is not valid or EndDateTime is null.'

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_EndDateReset nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_EndDateReset = N'GetPartitionSetNameForWorkflowInstance failed resetting the partition''s end date.'

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_MultipleActive nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_MultipleActive = N'GetPartitionSetNameForWorkflowInstance failed - there are multiple partitions with a null end date.'

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_No_Trans nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_No_Trans = N'GetPartitionSetNameForWorkflowInstance failed - a transaction is required.'

	declare @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_PreviousPartition nvarchar(256)
	set @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_PreviousPartition = N'GetPartitionSetNameForWorkflowInstance failed - the partition cannot be created because a more recent partition exists for the specified interval.'

	IF @@TRANCOUNT = 0
	 BEGIN
		SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_No_Trans
		GOTO FAILED
	 END

	DECLARE @interval char

	-- Get the current interval and don't let anyone change it while we're doing work
	SELECT 	@interval = [Interval]
	FROM	[dbo].[TrackingPartitionInterval]

	SELECT 	@error = @@ERROR
			,@rowcount = @@ROWCOUNT

	IF @error <> 0 OR @rowcount <> 1 OR @interval IS NULL
	 BEGIN
		SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_Interval_Sel
		GOTO FAILED
	 END

	DECLARE @Date datetime

	SELECT @Date = [EndDateTime] FROM [dbo].[WorkflowInstance] WHERE [WorkflowInstanceInternalId] = @WorkflowInstanceInternalId

	IF @Date IS NULL
	 BEGIN
		SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_InvalidInternalId
		GOTO FAILED
	 END

	-- Get the suffix for the current partition set
	IF @interval in ( 'd' ) -- daily
		SELECT @PartitionSetName = cast( datepart( yyyy, @Date ) as varchar ) + '_' + cast( datepart( mm, @Date ) as varchar ) + '_' + cast( datepart( ww, @Date ) as varchar ) + '_' + cast( datepart( dd, @Date ) as varchar )
	ELSE IF @interval in ( 'w' ) -- weekly
		SELECT @PartitionSetName = cast( datepart( yyyy, @Date ) as varchar ) + '_' + cast( datepart( mm, @Date ) as varchar ) + '_' + cast( datepart( ww, @Date ) as varchar )
	ELSE IF @interval in ( 'm' ) -- monthly
		SELECT @PartitionSetName = cast( datepart( yyyy, @Date ) as varchar ) + '_' + cast( datepart( mm, @Date ) as varchar )
	ELSE IF @interval in ( 'y' ) -- yearly
		SELECT @PartitionSetName = cast( datepart( yyyy, @Date ) as varchar )
	ELSE
	 BEGIN
		SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_Invalid_Interval
		GOTO FAILED
	 END

	-- If we touch the TrackPartitionSetName table in the following section this flag is set
	-- If it is set we perform an assert to ensure that the table is in a valid state before we exit.
	DECLARE @validate bit
	SELECT @validate = 0

	-- Check if this partition exists.
	-- Just use a normal read lock as the common case is that the partition will exist.
	-- The read lock will be blocked by the xlock below if we're in the middle of adding a partition.
	IF NOT EXISTS ( SELECT	1 
					FROM 	[dbo].[TrackingPartitionSetName] 
					WHERE 	[Name] = @PartitionSetName 
					AND 	[PartitionInterval] = @interval )
	 BEGIN
		SELECT @validate = 1
		-- Check again with an xlock on the table held through the end of the tx
		IF NOT EXISTS ( SELECT	1 
						FROM 	[dbo].[TrackingPartitionSetName] 
						WITH 	( XLOCK, TABLOCKX, HOLDLOCK ) 
						WHERE 	[Name] = @PartitionSetName 
						AND 	[PartitionInterval] = @interval )
		 BEGIN
			-- Make sure we're not creating a previous partition - this isn't valid
			IF EXISTS ( SELECT 	1 
						FROM 	[dbo].[TrackingPartitionSetName]
						WHERE	[PartitionInterval] = @interval
						AND		[CreatedDateTime] > @Date )
			 BEGIN
				SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_PreviousPartition
				GOTO FAILED
			 END
			-- Build the tables for this partition and rebuild the partition views
			EXEC @ret = [dbo].[CreatePartition] @PartitionSetName, @interval
	
			IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 
			 BEGIN
				SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_BuildPartitionSet
				GOTO FAILED
		 	 END
		 END
	 END
	ELSE
	 BEGIN
		-- Partition exists, validate it
		DECLARE @created datetime, @end datetime
		SELECT 	@created = [CreatedDateTime]
				,@end = [EndDateTime]
		FROM 	[dbo].[TrackingPartitionSetName] 
		WHERE 	[Name] = @PartitionSetName
		-- If EndDateTime for this partition is null (common case) we're valid
		IF @end IS NOT NULL 
		 BEGIN 
			-- There can only be one active partition and this isn't it (EndDateTime has been set)
			-- Two conditions where this is valid:
			-- 1. There is a race between the create new partition branch and this branch wherein
			-- we can create a new partition and deactivate the current while trying to insert into the current.
			-- No corruption will result, the only issue is trying to insert into a logically read-only table.
			-- Instead of adding another layer of locking we allow a rollover time buffer
			-- during which it is OK to continue inserting into the active-1 partition.
			-- 2. It's possible that if the interval is changed (w->m->w) we might end up writing into 
			-- a partition that was previously inactive.  This is valid but we need to reset the end date.
			SELECT 	@rowcount = count(1) 
			FROM 	[dbo].[TrackingPartitionSetName] 
			WHERE 	[PartitionInterval] = @interval
			AND		[CreatedDateTime] > @created

			IF @rowcount <> 0
			 BEGIN 
				-- Case 1
				-- We have a partition with the same interval value ahead of the one we are trying to insert into.
				-- We can insert only if this is the active-1 partition and if we are within the rollover time period.
				DECLARE @dt datetime
				SELECT @dt = getutcdate()

				IF @rowcount > 1 OR dateadd( hour, 1, @end ) < @dt
				 BEGIN
					SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_InvalidPartitionSet
					GOTO FAILED
				 END
			 END
			ELSE
			 BEGIN
				SELECT @validate = 1
				UPDATE [dbo].[TrackingPartitionSetName] SET [EndDateTime] = NULL WHERE [Name] = @PartitionSetName 
	
				IF @@ERROR <> 0
				 BEGIN
					SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_EndDateReset
					GOTO FAILED
				 END
	
				-- Also set the end date for the previously current partition
				UPDATE [dbo].[TrackingPartitionSetName] SET [EndDateTime] = getutcdate() WHERE [EndDateTime] IS NULL
	
				IF @@ERROR <> 0
				 BEGIN
					SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_EndDateReset
					GOTO FAILED
				 END
			 END
		 END -- @end null check
	 END -- Partitions exists branch

	-- If we created a partition or messed with end dates assert that there is still only one active partition
	IF @validate = 1
	 BEGIN
		SELECT @rowcount = count(1) FROM [dbo].[TrackingPartitionSetName] WHERE [EndDateTime] IS NULL
		
		IF @rowcount > 1
		 BEGIN
			SET @error_desc = @localized_string_GetPartitionSetNameForWorkflowInstance_Failed_MultipleActive
			GOTO FAILED
		 END
	 END

	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetPartitionSetNameForWorkflowInstance] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[CopyWorkflowInstanceToPartition]') IS NOT NULL
	DROP PROCEDURE [dbo].[CopyWorkflowInstanceToPartition]
GO

CREATE PROCEDURE [dbo].[CopyWorkflowInstanceToPartition]	@WorkflowInstanceInternalId	bigint
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			int

	declare @localized_string_CopyWorkflowInstanceToPartition_Failed nvarchar(256)
	set @localized_string_CopyWorkflowInstanceToPartition_Failed = N'CopyWorkflowInstanceToPartition failed'

	declare @localized_string_CopyWorkflowInstanceToPartition_Failed_No_Trans nvarchar(256)
	set @localized_string_CopyWorkflowInstanceToPartition_Failed_No_Trans = N'CopyWorkflowInstanceToPartition failed - a transaction is required.'

	declare @localized_string_CopyWorkflowInstanceToPartition_Failed_GetPartitionSet nvarchar(256)
	set @localized_string_CopyWorkflowInstanceToPartition_Failed_GetPartitionSet = N'CopyWorkflowInstanceToPartition failed calling GetPartitionSetNameForWorkflowInstance.'

	declare @localized_string_CopyWorkflowInstanceToPartition_Failed_Insert nvarchar(256)
	set @localized_string_CopyWorkflowInstanceToPartition_Failed_Insert = N'CopyWorkflowInstanceToPartition failed inserting workflow records into partition tables.'

	IF @@TRANCOUNT = 0
	 BEGIN
		SET @error_desc = @localized_string_CopyWorkflowInstanceToPartition_Failed_No_Trans
		GOTO FAILED
	 END


	DECLARE @PartitionSetName sysname

	EXEC @ret = [dbo].[GetPartitionSetNameForWorkflowInstance] @WorkflowInstanceInternalId = @WorkflowInstanceInternalId, @PartitionSetName = @PartitionSetName OUTPUT

	IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_CopyWorkflowInstanceToPartition_Failed_GetPartitionSet
		GOTO FAILED
	 END

	DECLARE		@string_id varchar(32)
	SELECT 		@string_id = cast( @WorkflowInstanceInternalId as varchar(32) ) 
	EXEC( 
	--print
	'
	DECLARE 	@WorkflowInstanceInternalId bigint
	SELECT		@WorkflowInstanceInternalId = ' + @string_id + '

	INSERT		WorkflowInstance_' + @PartitionSetName + '
	SELECT		[WorkflowInstanceInternalId]
				,[WorkflowInstanceId]
				,[ContextGuid]
				,[CallerInstanceId]
				,[CallPath]
				,[CallerContextGuid]
				,[CallerParentContextGuid]
				,[WorkflowTypeId]
				,[InitializedDateTime]
				,[DbInitializedDateTime]
				,[EndDateTime]
				,[DbEndDateTime]
	FROM		WorkflowInstance
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	INSERT		WorkflowInstanceEvent_' + @PartitionSetName + '
	SELECT		* 
	FROM		WorkflowInstanceEvent
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	-- In several cases the chance of having records is low
	-- The select check is faster if there are no record
	-- so the extra cost when there are records is a better overall balance
	IF EXISTS ( SELECT 1 FROM [dbo].[WorkflowInstanceEvent] WHERE [WorkflowInstanceInternalId] = @WorkflowInstanceInternalId AND TrackingWorkflowEventId=11 /* Changed */ )
	 BEGIN
		INSERT		AddedActivity_' + @PartitionSetName + '
		SELECT		* 
		FROM		AddedActivity
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	
		INSERT		RemovedActivity_' + @PartitionSetName + '
		SELECT		* 
		FROM		RemovedActivity
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	 END

	IF EXISTS ( SELECT 1 FROM [dbo].[UserEvent] WHERE [WorkflowInstanceInternalId] = @WorkflowInstanceInternalId )
	 BEGIN
		INSERT		UserEvent_' + @PartitionSetName + '
		SELECT		* 
		FROM		UserEvent
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	 END

	INSERT		ActivityInstance_' + @PartitionSetName + '
	SELECT		* 
	FROM		ActivityInstance
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	INSERT		ActivityExecutionStatusEvent_' + @PartitionSetName + '
	SELECT		* 
	FROM		ActivityExecutionStatusEvent
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	IF EXISTS ( SELECT 1 FROM [dbo].[TrackingDataItem] WHERE [WorkflowInstanceInternalId] = @WorkflowInstanceInternalId )
	 BEGIN
		INSERT		TrackingDataItem_' + @PartitionSetName + '
		SELECT		* 
		FROM		TrackingDataItem
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	
		INSERT 		TrackingDataItemAnnotation_' + @PartitionSetName + '
		SELECT		* 
		FROM		TrackingDataItemAnnotation 
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	 END

	INSERT		EventAnnotation_' + @PartitionSetName + '
	SELECT		*
	FROM		EventAnnotation
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	')

	IF @@ERROR <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_CopyWorkflowInstanceToPartition_Failed_Insert
		GOTO FAILED
	 END

	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[CopyWorkflowInstanceToPartition] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[DeleteWorkflowInstance]') IS NOT NULL
	DROP PROCEDURE [dbo].[DeleteWorkflowInstance]
GO

CREATE PROCEDURE [dbo].[DeleteWorkflowInstance]	@WorkflowInstanceInternalId	bigint
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			int

	declare @localized_string_DeleteWorkflowInstance_Failed nvarchar(256)
	set @localized_string_DeleteWorkflowInstance_Failed = N'DeleteWorkflowInstance failed'

	declare @localized_string_DeleteWorkflowInstance_Failed_No_Trans nvarchar(256)
	set @localized_string_DeleteWorkflowInstance_Failed_No_Trans = N'DeleteWorkflowInstance failed - a transaction is required.'

	IF @@TRANCOUNT = 0
	 BEGIN
		SET @error_desc = @localized_string_DeleteWorkflowInstance_Failed
		GOTO FAILED
	 END


	IF EXISTS ( SELECT 1 FROM [dbo].[TrackingDataItem] WHERE [WorkflowInstanceInternalId] = @WorkflowInstanceInternalId )
	 BEGIN
		DELETE 		TrackingDataItemAnnotation
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	
		DELETE		TrackingDataItem
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	 END

	DELETE		EventAnnotation
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	DELETE		ActivityExecutionStatusEvent
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	DELETE		ActivityInstance
	FROM		ActivityInstance WITH (INDEX([idx_ActivityInstance_WorkflowInstanceInternalId]))
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	IF EXISTS ( SELECT 1 FROM [dbo].[UserEvent] WHERE [WorkflowInstanceInternalId] = @WorkflowInstanceInternalId )
	 BEGIN
		DELETE		UserEvent
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	 END


	IF EXISTS ( SELECT 1 FROM [dbo].[WorkflowInstanceEvent] WHERE [WorkflowInstanceInternalId] = @WorkflowInstanceInternalId AND TrackingWorkflowEventId=11 /* Changed */)
	 BEGIN
		DELETE		AddedActivity
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	
		DELETE		RemovedActivity
		WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
	 END

	DELETE		WorkflowInstanceEvent
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	DELETE		WorkflowInstance
	WHERE		WorkflowInstanceInternalId = @WorkflowInstanceInternalId
		
	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[DeleteWorkflowInstance] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[SetWorkflowInstanceEndDateTime]') IS NOT NULL
	DROP PROCEDURE [dbo].[SetWorkflowInstanceEndDateTime]
GO

CREATE PROCEDURE [dbo].[SetWorkflowInstanceEndDateTime]	@WorkflowInstanceInternalId	bigint, @EndDateTime datetime
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int

	declare @localized_string_SetWorkflowInstanceEndDateTime_Failed nvarchar(256)
	set @localized_string_SetWorkflowInstanceEndDateTime_Failed = N'SetWorkflowInstanceEndDateTime failed'

	-- Use a server timestamp to avoid races between hosts on machines with out of sync local times
	-- This would race and end up trying to copy records into a read-only partition
	UPDATE	[dbo].[WorkflowInstance] SET [EndDateTime] = @EndDateTime, [DbEndDateTime] = getutcdate() WHERE [WorkflowInstanceInternalId] = @WorkflowInstanceInternalId

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_SetWorkflowInstanceEndDateTime_Failed
		GOTO FAILED
	 END

	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[SetWorkflowInstanceEndDateTime] TO tracking_writer
GO



IF OBJECT_ID('[dbo].[PartitionWorkflowInstance]') IS NOT NULL
	DROP PROCEDURE [dbo].[PartitionWorkflowInstance]
GO

CREATE PROCEDURE [dbo].[PartitionWorkflowInstance]	@WorkflowInstanceInternalId	bigint
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int

	declare @localized_string_PartitionWorkflowInstance_Failed nvarchar(256)
	set @localized_string_PartitionWorkflowInstance_Failed = N'PartitionWorkflowInstance failed'

	declare @localized_string_PartitionWorkflowInstance_Failed_Copy nvarchar(256)
	set @localized_string_PartitionWorkflowInstance_Failed_Copy = N'PartitionWorkflowInstance failed calling CopyWorkflowInstanceToPartition'

	declare @localized_string_PartitionWorkflowInstance_Failed_Delete nvarchar(256)
	set @localized_string_PartitionWorkflowInstance_Failed_Delete = N'PartitionWorkflowInstance failed calling DeleteWorkflowInstance'

	declare @localized_string_PartitionWorkflowInstance_Failed_Invalid nvarchar(256)
	set @localized_string_PartitionWorkflowInstance_Failed_Invalid = N'PartitionWorkflowInstance failed - @WorkflowInstanceInternalId is not an active workflow'

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	-- Check if the instance exists, if it does we own it until the tx is done
	IF NOT EXISTS ( SELECT 1 FROM [dbo].[WorkflowInstance] WITH ( XLOCK, HOLDLOCK ) WHERE [WorkflowInstanceInternalId] = @WorkflowInstanceInternalId ) 
	 BEGIN
		SET @error_desc = @localized_string_PartitionWorkflowInstance_Failed_Invalid
		GOTO FAILED
	 END

	EXEC @ret = [dbo].[CopyWorkflowInstanceToPartition] @WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_PartitionWorkflowInstance_Failed_Copy
		GOTO FAILED
	 END

	EXEC @ret = [dbo].[DeleteWorkflowInstance] @WorkflowInstanceInternalId = @WorkflowInstanceInternalId

	IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_PartitionWorkflowInstance_Failed_Delete
		GOTO FAILED
	 END

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[PartitionWorkflowInstance] TO tracking_writer
GO


IF OBJECT_ID('[dbo].[PartitionCompletedWorkflowInstances]') IS NOT NULL
	DROP PROCEDURE [dbo].[PartitionCompletedWorkflowInstances]
GO

CREATE PROCEDURE [dbo].[PartitionCompletedWorkflowInstances]
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	DECLARE @local_tran		bit
			,@error			int
			,@rowcount		int
			,@error_desc	nvarchar(256)
			,@ret			int
			,@IID			bigint
			,@failed		bit

	declare @localized_string_PartitionCompletedWorkflowInstances_Failed nvarchar(256)
	set @localized_string_PartitionCompletedWorkflowInstances_Failed = N'PartitionCompletedWorkflowInstances failed'

	declare @localized_string_PartitionCompletedWorkflowInstances_Failed_OpenCursor nvarchar(256)
	set @localized_string_PartitionCompletedWorkflowInstances_Failed_OpenCursor = N'PartitionCompletedWorkflowInstances failed opening cursor'

	declare @localized_string_PartitionCompletedWorkflowInstances_Failed_Partition nvarchar(256)
	set @localized_string_PartitionCompletedWorkflowInstances_Failed_Partition = N'PartitionCompletedWorkflowInstances failed moving some workflow instances.'

	SELECT @failed = 0

	-- Get the instance that are ready to be moved to a completed partition
	-- It is important that this cursor is ordered oldest to most recent
	-- as the list may span multiple partitions.  Despite the fact that this is a batched
	-- activity we want to always maintain only one active partition to copy to.  
	-- All partitions that are not the most recent must be read-only.  
	-- The ordering of the cursor perserves this semantic.
	DECLARE iid_cursor INSENSITIVE CURSOR FOR
	SELECT 	[WorkflowInstanceInternalId]
	FROM	[dbo].[WorkflowInstance]
	WHERE	[EndDateTime] IS NOT NULL
	ORDER BY [EndDateTime] asc

	OPEN iid_cursor

	IF @@ERROR <> 0
	 BEGIN
		SET @error_desc = @localized_string_PartitionCompletedWorkflowInstances_Failed_OpenCursor
		GOTO FAILED
	 END

	FETCH NEXT FROM iid_cursor INTO @IID

	WHILE @@FETCH_STATUS = 0
	 BEGIN
		-- Each Workflow instance "batch" gets its own transaction
		BEGIN TRANSACTION

		EXEC @ret  = PartitionWorkflowInstance @WorkflowInstanceInternalId = @IID

		SELECT @error = @@ERROR

		IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
		 BEGIN
			ROLLBACK TRANSACTION
			SELECT @failed = 1
		 END
		ELSE
		 BEGIN
			COMMIT TRANSACTION
		 END

		FETCH NEXT FROM iid_cursor INTO @IID
	 END

	CLOSE iid_cursor
	DEALLOCATE iid_cursor

	IF @failed = 1
	 BEGIN
		SET @error_desc = @localized_string_PartitionCompletedWorkflowInstances_Failed_Partition
		GOTO FAILED
	 END
	ELSE
	 BEGIN
		SET @ret = 0
		GOTO DONE
	 END

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[PartitionCompletedWorkflowInstances] TO tracking_writer
GO

/*************************************************************************************************************************************

		
														Default Profile Procs


*************************************************************************************************************************************/

IF OBJECT_ID('[dbo].[GetCurrentDefaultTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetCurrentDefaultTrackingProfile]
GO

CREATE PROCEDURE [dbo].[GetCurrentDefaultTrackingProfile]
AS
 BEGIN
	SET NOCOUNT ON

	SELECT		TOP 1 [Version]
				,[TrackingProfileXml]
	FROM		[dbo].[DefaultTrackingProfile]
	ORDER BY	[InsertDateTime] desc

 END
GO

GRANT EXECUTE ON [dbo].[GetCurrentDefaultTrackingProfile] TO tracking_profilereaderwriter
GO


IF OBJECT_ID('[dbo].[GetDefaultTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetDefaultTrackingProfile]
GO

CREATE PROCEDURE [dbo].[GetDefaultTrackingProfile] @Version varchar(32)
AS
 BEGIN
	SET NOCOUNT ON

	SELECT		[TrackingProfileXml]
	FROM		[DefaultTrackingProfile]
	WHERE		[Version]  = @Version

 END
GO

GRANT EXECUTE ON [dbo].[GetDefaultTrackingProfile] TO tracking_profilereaderwriter
GO


IF OBJECT_ID('[dbo].[UpdateDefaultTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[UpdateDefaultTrackingProfile]
GO

CREATE PROCEDURE [dbo].[UpdateDefaultTrackingProfile] @Version varchar(32), @TrackingProfileXml ntext
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	INSERT		[dbo].[DefaultTrackingProfile] (
					[Version]
					,[TrackingProfileXml]
	)
	VALUES ( 
					@Version
					,@TrackingProfileXml
	)

	IF @@ERROR <> 0
		RETURN -1
	ELSE
		RETURN 0
 END
GO


GRANT EXECUTE ON [dbo].[UpdateDefaultTrackingProfile] TO tracking_profilereaderwriter
GO


IF OBJECT_ID('[dbo].[InsertDefaultTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[InsertDefaultTrackingProfile]
GO

CREATE PROCEDURE [dbo].[InsertDefaultTrackingProfile]	@TypeFullName			nvarchar(128)	-- Type of the Workflow's companion type
														,@AssemblyFullName		nvarchar(256)	-- Assembly of the Workflow's companion type
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_InsertDefaultTrackingProfile_Failed_GetType nvarchar(256)
	set @localized_string_InsertDefaultTrackingProfile_Failed_GetType = N'GetTypeId failed'

	declare @localized_string_InsertDefaultTrackingProfile_InsertFailed nvarchar(256)
	set @localized_string_InsertDefaultTrackingProfile_InsertFailed = N'Failed inserting into TrackingProfile'


	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint


	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	DECLARE @TypeId int
	/*
		Look up or insert the type of the Workflow
	*/
	EXEC @ret = [GetTypeId]	@TypeFullName		= @TypeFullName
								,@AssemblyFullName	= @AssemblyFullName
								,@TypeId			= @TypeId OUTPUT
	
	IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TypeId IS NULL
	 BEGIN
		SELECT @error_desc = @localized_string_InsertDefaultTrackingProfile_Failed_GetType
		GOTO FAILED
	 END

	/*
		NULL is inserted so that we don't hold multiple copies of the same profile and needlessly chew up disk space
		Basically this record is just a pointer to the version of the default profile to use

		pk has ignore duplicate key to ignore to handle client races on this insert without holding locks
	*/
	INSERT		[dbo].[TrackingProfile] (
					[Version]
					,[WorkflowTypeId]
					,[TrackingProfileXml]
	)
	SELECT TOP 1	[Version]
					,@TypeId
					,null
	FROM			[dbo].[DefaultTrackingProfile]
	ORDER BY		[InsertDateTime] desc

	IF @@ERROR NOT IN ( 3604 /* ignore dup key */, 0 )
	 BEGIN
		SELECT @error_desc = @localized_string_InsertDefaultTrackingProfile_InsertFailed
		GOTO FAILED
	 END

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[InsertDefaultTrackingProfile] TO tracking_profilereaderwriter
GO


/*************************************************************************************************************************************

		
														Profile Procs


*************************************************************************************************************************************/


IF OBJECT_ID('[dbo].[GetUpdatedTrackingProfiles]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetUpdatedTrackingProfiles]
GO

CREATE PROCEDURE [dbo].[GetUpdatedTrackingProfiles] @LastCheckDateTime datetime, @MaxCheckDateTime datetime OUTPUT
AS
 BEGIN
	SET NOCOUNT ON
	/*
		If the profile has been deleted (signified by Version=-1
		then the TrackingProfile column will be null in the resultset

		@MaxCheckDateTime will become @LastCheckDateTime in the next call
	*/
	SELECT @MaxCheckDateTime = getutcdate()

	SELECT			t.[TypeFullName]
					,t.[AssemblyFullName]
					,'TrackingProfile' = 
					CASE 
						WHEN tp.[TrackingProfileXml] IS NULL THEN dtp.[TrackingProfileXml]
						ELSE tp.[TrackingProfileXml]
					END
					,tp.[InsertDateTime]
	FROM			[dbo].[TrackingProfile] tp
	INNER JOIN		[dbo].[Type] t
	ON				tp.[WorkflowTypeId] = t.TypeId
	LEFT OUTER JOIN	[dbo].[DefaultTrackingProfile] dtp
	ON				tp.[Version] = dtp.[Version]
	WHERE			tp.[InsertDateTime] >= @LastCheckDateTime AND tp.[InsertDateTime] < @MaxCheckDateTime
	AND				tp.[TrackingProfileId] IN (	SELECT		max( [TrackingProfileId] )
												FROM		[dbo].[TrackingProfile]
												GROUP BY	[WorkflowTypeId] )

	RETURN 0

 END
GO
GRANT EXECUTE ON [dbo].[GetUpdatedTrackingProfiles] TO tracking_profilereaderwriter
GRANT EXECUTE ON [dbo].[GetUpdatedTrackingProfiles] TO tracking_writer
GO
	

IF OBJECT_ID('[dbo].[GetTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetTrackingProfile]
GO

CREATE PROCEDURE [dbo].[GetTrackingProfile]	@TypeFullName				nvarchar(128)	-- Type of the Workflow's companion type
												,@AssemblyFullName		nvarchar(256)	-- Assembly of the Workflow's companion type
												,@Version				varchar(32) = NULL		-- Optional Version
												,@CreateDefault			bit	= 1			-- If a profile doesn't exist for this type insert the default and use it going forward
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED


	declare @localized_string_GetTrackingProfile_Failed_GetType nvarchar(256)
	set @localized_string_GetTrackingProfile_Failed_GetType = N'GetTypeId failed'



	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint


	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END
	
	/*
		Can't select an ntext into a local var so using a somewhat inefficient repeated select
	*/
	IF NOT EXISTS (	SELECT		1 
					FROM		[dbo].[TrackingProfile] tp
					INNER JOIN	[dbo].[Type] t
					ON			tp.[WorkflowTypeId] = t.[TypeId]
					WHERE		t.[TypeFullName] = @TypeFullName
					AND			t.[AssemblyFullName] = @AssemblyFullName ) AND @CreateDefault = cast( 1 as bit )
	 BEGIN
		EXEC @ret = [dbo].[InsertDefaultTrackingProfile] @TypeFullName = @TypeFullName, @AssemblyFullName = @AssemblyFullName

		IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0
		 BEGIN
			RAISERROR( @localized_string_GetTrackingProfile_Failed_GetType, 16, -1 )
			RETURN -1
		 END
	 END

	/*
		If the profile is null in the tracking table it means that the default tracking profile
		should be used.  Join on Version to get the correct version.
	*/
	SELECT	TOP 1	'TrackingProfile' = 
					CASE 
						WHEN tp.[TrackingProfileXml] IS NULL THEN dtp.[TrackingProfileXml]
						ELSE tp.[TrackingProfileXml]
					END
					,tp.[Version]
	FROM			[dbo].[TrackingProfile] tp
	INNER JOIN		[dbo].[Type] t
	ON				tp.[WorkflowTypeId] = t.[TypeId]
	LEFT OUTER JOIN	[dbo].[DefaultTrackingProfile] dtp
	ON				tp.[Version] = dtp.[Version]
	WHERE			t.[TypeFullName] = @TypeFullName
	AND				t.[AssemblyFullName] = @AssemblyFullName
	AND				tp.[Version] != '-1' -- Deleted indicator
	AND				( tp.[Version] = @Version OR @Version IS NULL ) /* Inefficient - won't use index - but simple */
	ORDER BY		tp.[InsertDateTime] desc

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetTrackingProfile] TO tracking_profilereaderwriter
GRANT EXECUTE ON [dbo].[GetTrackingProfile] TO tracking_writer
GO


IF OBJECT_ID('[dbo].[UpdateTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[UpdateTrackingProfile]
GO

CREATE PROCEDURE [dbo].[UpdateTrackingProfile]	@TypeFullName			nvarchar(128)
												,@AssemblyFullName		nvarchar(256)
												,@Version				varchar(32)
												,@TrackingProfileXml	ntext
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_UpdateTrackingProfile_Failed_GetType nvarchar(256)
	set @localized_string_UpdateTrackingProfile_Failed_GetType = N'GetTypeId failed'

	declare @localized_string_UpdateTrackingProfile_Failed_BadVersion nvarchar(256)
	set @localized_string_UpdateTrackingProfile_Failed_BadVersion = N'A version already exists that is greater than or equal to the new version'

	declare @localized_string_UpdateTrackingProfile_Failed_ProfileInsert nvarchar(256)
	set @localized_string_UpdateTrackingProfile_Failed_ProfileInsert = N'Failed inserting into TrackingProfile'


	
	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
			

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END

	DECLARE @TypeId int
	/*
		Look up or insert the type of the Workflow
	*/
	EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @TypeFullName
									,@AssemblyFullName	= @AssemblyFullName
									,@TypeId			= @TypeId OUTPUT
	
	IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TypeId IS NULL
	 BEGIN
		SELECT @error_desc = @localized_string_UpdateTrackingProfile_Failed_GetType
		GOTO FAILED
	 END
	/*
			Check that this version doesn't already exist and is higher than all other versions for this type
	*/
	IF EXISTS ( SELECT 1 FROM [dbo].[TrackingProfile] WHERE [WorkflowTypeId] = @TypeId AND [Version] >= @Version )
	 BEGIN
		SELECT @error_desc = @localized_string_UpdateTrackingProfile_Failed_BadVersion
		GOTO FAILED
	 END

	INSERT		[dbo].[TrackingProfile] (
					[Version]
					,[WorkflowTypeId]
					,[TrackingProfileXml]
	)
	VALUES( 
					@Version
					,@TypeId
					,@TrackingProfileXml
	)

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_UpdateTrackingProfile_Failed_ProfileInsert
		GOTO FAILED		
	 END

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[UpdateTrackingProfile] TO tracking_profilereaderwriter
GO


IF OBJECT_ID('[dbo].[DeleteTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[DeleteTrackingProfile]
GO

CREATE PROCEDURE [dbo].[DeleteTrackingProfile]	@TypeFullName			nvarchar(128)	-- Type of the Workflow's companion type
												,@AssemblyFullName		nvarchar(256)	-- Assembly of the Workflow's companion type
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_DeleteTrackingProfile_Failed_GetType nvarchar(256)
	set @localized_string_DeleteTrackingProfile_Failed_GetType = N'GetTypeId failed'

	declare @localized_string_DeleteTrackingProfile_Failed_ProfileInsert nvarchar(256)
	set @localized_string_DeleteTrackingProfile_Failed_ProfileInsert = N'Failed inserting delete record into TrackingProfile'



	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
	

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END


	DECLARE @TypeId int
	/*
		Look up or insert the type of the Workflow
	*/
	EXEC @ret = [dbo].[GetTypeId]	@TypeFullName		= @TypeFullName
								,@AssemblyFullName	= @AssemblyFullName
								,@TypeId			= @TypeId OUTPUT
	
	IF @@ERROR <> 0 OR @ret IS NULL OR @ret <> 0 OR @TypeId IS NULL
	 BEGIN
		SELECT @error_desc = @localized_string_DeleteTrackingProfile_Failed_GetType
		GOTO FAILED
	 END

	INSERT [dbo].[TrackingProfile] (
			[Version]
			,[WorkflowTypeId]
			,[TrackingProfileXml]
	) VALUES (
			-1
			,@TypeId
			,NULL
	)

	IF @@ERROR <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_DeleteTrackingProfile_Failed_ProfileInsert
		GOTO FAILED
	 END

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[DeleteTrackingProfile] TO tracking_profilereaderwriter
GO


/*************************************************************************************************************************************

		
														Instance Profile Procs


*************************************************************************************************************************************/


IF OBJECT_ID('[dbo].[SetInstanceTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[SetInstanceTrackingProfile]
GO

CREATE PROCEDURE [dbo].[SetInstanceTrackingProfile]	@InstanceId			uniqueidentifier
														,@TrackingProfileXml	ntext = NULL
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_SetInstanceTrackingProfile_Failed_ProfileUpdate nvarchar(256)
	set @localized_string_SetInstanceTrackingProfile_Failed_ProfileUpdate = N'Failed updating TrackingProfileInstance'

	declare @localized_string_SetInstanceTrackingProfile_Failed_ProfileInsert nvarchar(256)
	set @localized_string_SetInstanceTrackingProfile_Failed_ProfileInsert = N'Failed inserting into TrackingProfileInstance'


	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
			,@rowcount		int
	

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END
	/*
		Update first, if we get a hit, great, we're done
	*/
	UPDATE	[dbo].[TrackingProfileInstance]
	SET		[TrackingProfileXml] = @TrackingProfileXml
			,[UpdatedDateTime]= getutcdate()
	WHERE	[InstanceId] = @InstanceId

	SELECT @error = @@ERROR, @rowcount = @@ROWCOUNT

	IF @error <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_SetInstanceTrackingProfile_Failed_ProfileUpdate
		GOTO FAILED
	 END
	/*
		Check if the update hit a row, if not insert
	*/
	IF @rowcount = 0 
	 BEGIN
		INSERT [dbo].[TrackingProfileInstance] (
			[InstanceId]
			,[TrackingProfileXml]
		) VALUES (
			@InstanceId
			,@TrackingProfileXml
		)
		
		IF @error <> 0
		 BEGIN
			SELECT @error_desc = @localized_string_SetInstanceTrackingProfile_Failed_ProfileInsert
			GOTO FAILED
		 END
	 END

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[SetInstanceTrackingProfile] TO tracking_profilereaderwriter
GO


IF OBJECT_ID('[dbo].[DeleteInstanceTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[DeleteInstanceTrackingProfile]
GO

CREATE PROCEDURE [dbo].[DeleteInstanceTrackingProfile]	@InstanceId			uniqueidentifier
AS
 BEGIN
	SET NOCOUNT ON

	SET TRANSACTION ISOLATION LEVEL READ COMMITTED
		
	declare @localized_string_DeleteInstanceTrackingProfile_Failed_ProfileUpdate nvarchar(256)
	set @localized_string_DeleteInstanceTrackingProfile_Failed_ProfileUpdate = N'Failed updating TrackingProfileInstance'

	declare @localized_string_DeleteInstanceTrackingProfile_Failed_ProfileInsert nvarchar(256)
	set @localized_string_DeleteInstanceTrackingProfile_Failed_ProfileInsert = N'Failed inserting into TrackingProfileInstance'


	DECLARE @local_tran		bit
			,@error			int
			,@error_desc	nvarchar(256)
			,@ret			smallint
			,@rowcount		int
	

	IF @@TRANCOUNT > 0
		SET @local_tran = 0
	ELSE
	 BEGIN
		BEGIN TRANSACTION
		SET @local_tran = 1		
	 END
	/*
		Update first, if we get a hit, great, we're done
	*/
	UPDATE	[dbo].[TrackingProfileInstance]
	SET		[TrackingProfileXml] = NULL
			,[UpdatedDateTime]= getutcdate()
	WHERE	[InstanceId] = @InstanceId

	SELECT @error = @@ERROR, @rowcount = @@ROWCOUNT

	IF @error <> 0
	 BEGIN
		SELECT @error_desc = @localized_string_DeleteInstanceTrackingProfile_Failed_ProfileUpdate
		GOTO FAILED
	 END
	/*
		Check if the update hit a row, if not insert
	*/
	IF @rowcount = 0 
	 BEGIN
		INSERT [dbo].[TrackingProfileInstance] (
			[InstanceId]
			,[TrackingProfileXml]
		) VALUES (
			@InstanceId
			,NULL
		)
		
		IF @error <> 0
		 BEGIN
			SELECT @error_desc = @localized_string_DeleteInstanceTrackingProfile_Failed_ProfileInsert
			GOTO FAILED
		 END
	 END

	IF @local_tran = 1
		COMMIT TRANSACTION

	SET @ret = 0
	GOTO DONE

FAILED:
	IF @local_tran = 1
		ROLLBACK TRANSACTION

	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[DeleteInstanceTrackingProfile] TO tracking_profilereaderwriter
GO


IF OBJECT_ID('[dbo].[GetInstanceTrackingProfile]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetInstanceTrackingProfile]
GO

CREATE PROCEDURE [dbo].[GetInstanceTrackingProfile]	@InstanceId			uniqueidentifier
AS
 BEGIN
	SET NOCOUNT ON

	SELECT	[TrackingProfileXml]
	FROM	[dbo].[TrackingProfileInstance]
	WHERE	[InstanceId] = @InstanceId


 END
GO

GRANT EXECUTE ON [dbo].[GetInstanceTrackingProfile] TO tracking_profilereaderwriter
GRANT EXECUTE ON [dbo].[GetInstanceTrackingProfile] TO tracking_writer
GO


/*************************************************************************************************************************************

		
														Query Procs


*************************************************************************************************************************************/



IF OBJECT_ID('[dbo].[LookupTypeId]') IS NOT NULL
	DROP PROCEDURE [dbo].[LookupTypeId]
GO

CREATE PROCEDURE [dbo].[LookupTypeId]	@TypeFullName				nvarchar(128)
										,@AssemblyFullName			nvarchar(256)
										,@TypeId					int OUTPUT
AS
 BEGIN
	SET NOCOUNT ON

	SELECT 	@TypeId = [TypeId]
	FROM	[dbo].[Type]
	WHERE	[TypeFullName] = @TypeFullName
	AND		[AssemblyFullName] = @AssemblyFullName

 END
GO

GRANT EXECUTE ON [dbo].[LookupTypeId] TO tracking_reader
GO


IF OBJECT_ID('[dbo].[GetWorkflows]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetWorkflows]
GO

CREATE PROCEDURE [dbo].[GetWorkflows]	@WorkflowInstanceId			uniqueidentifier = NULL
										,@TypeFullName				nvarchar(128) = NULL
										,@AssemblyFullName			nvarchar(256) = NULL
										,@WorkflowStatusId			tinyint = NULL
										,@StatusMinDateTime			datetime = NULL
										,@StatusMaxDateTime			datetime = NULL
										,@TrackingDataItems					ntext = NULL
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetWorkflows_Failed_InvalidStatus nvarchar(256)
	set @localized_string_GetWorkflows_Failed_InvalidStatus = N'@WorkflowStatusId must be 0, 1, 2 or 3.'

	declare @localized_string_GetWorkflows_Failed_FailedXml nvarchar(256)
	set @localized_string_GetWorkflows_Failed_FailedXml = N'Failed calling sp_xml_preparedocument.'

	declare @localized_string_GetWorkflows_Failed_InvalidDateTime nvarchar(256)
	set @localized_string_GetWorkflows_Failed_InvalidDateTime = N'@StatusMaxDateTime and @StatusMinDateTime must both be non null.'

	declare @localized_string_GetWorkflows_Failed_InvalidType nvarchar(256)
	set @localized_string_GetWorkflows_Failed_InvalidType = N'@TypeFullName and @AssemblyFullName must both be non null.'


	DECLARE @idoc int, @typeId int, @ret int, @error_desc nvarchar(256)

	IF ( ( @StatusMinDateTime IS NOT NULL AND @StatusMaxDateTime IS NULL ) OR ( @StatusMaxDateTime IS NOT NULL AND @StatusMinDateTime IS NULL ) )
	 BEGIN
			SET @error_desc = @localized_string_GetWorkflows_Failed_InvalidDateTime
			GOTO FAILED
	 END

	IF ( ( @TypeFullName IS NOT NULL AND @AssemblyFullName IS NULL ) OR ( @AssemblyFullName IS NOT NULL AND @TypeFullName IS NULL ) )
	 BEGIN
			SET @error_desc = @localized_string_GetWorkflows_Failed_InvalidType
			GOTO FAILED
	 END


	IF @TrackingDataItems IS NOT NULL AND datalength( @TrackingDataItems ) > 0
	 BEGIN
		EXEC @ret = sp_xml_preparedocument @idoc OUTPUT, @TrackingDataItems

		IF @@ERROR <> 0 OR @ret <> 0
		 BEGIN
			SET @error_desc = @localized_string_GetWorkflows_Failed_FailedXml
			GOTO FAILED
		 END
	 END

	IF @AssemblyFullName IS NOT NULL AND @TypeFullName IS NOT NULl
	 BEGIN
		EXEC LookupTypeId @TypeFullName=@TypeFullName, @AssemblyFullName = @AssemblyFullName, @TypeId = @typeId OUTPUT
		-- If we didn't find anything we don't have to run the query
		IF @typeId IS NULL
		 BEGIN
			SET @ret = 0
			GOTO DONE
		 END
	 END

	IF @TrackingDataItems IS NOT NULL
	 BEGIN

		IF OBJECT_ID('[tempdb].[dbo].[#TrackingDataItems]') IS NOT NULL
		 BEGIN
			DROP TABLE [#TrackingDataItems]
		 END		

		CREATE TABLE [#TrackingDataItems] (	
				[QualifiedName] 	nvarchar(128) COLLATE database_default,
				[FieldName] 		nvarchar(256) COLLATE database_default,
				[DataValue]			nvarchar(512) COLLATE database_default NULL
		)

		INSERT		[#TrackingDataItems]
		SELECT 		[QualifiedName]
					,[FieldName]
					,[DataValue]
		FROM		OPENXML ( @idoc, '/TrackingDataItems/TrackingDataItem',2) WITH
		            (
							[QualifiedName] nvarchar(128),
		                  	[FieldName] 	nvarchar(256),
							[DataValue]	nvarchar(512)
					)

		CREATE NONCLUSTERED INDEX [idx_TrackingDataItems_QualifiedName] ON [#TrackingDataItems]([QualifiedName])
		CREATE NONCLUSTERED INDEX [idx_TrackingDataItems_FieldName] ON [#TrackingDataItems]([FieldName])
		CREATE NONCLUSTERED INDEX [idx_TrackingDataItems_DataValue] ON [#TrackingDataItems]([DataValue])
	 END

	DECLARE @query nvarchar(4000)

	SELECT @query = '
	SELECT 			''CurrentEventTimeStamp'' = GetUTCDate()
					,[wi].[WorkflowInstanceId]
					,[wi].[WorkflowInstanceInternalId]
					,[wi].[InitializedDateTime]
					,[wi].[CallerInstanceId]
					,''WorkflowStatus'' = 
					CASE
						WHEN [wie].[TrackingWorkflowEventId] IS NULL	THEN cast(4 as int) /* No events tracked - all we know is that it was created */
						WHEN [wie].[TrackingWorkflowEventId] = 0 		THEN cast(4 as int) /* Created */
						WHEN [wie].[TrackingWorkflowEventId] = 1 		THEN cast(1 as int) /* Completed */
						WHEN [wie].[TrackingWorkflowEventId] = 3 		THEN cast(2 as int) /* Suspended */
						WHEN [wie].[TrackingWorkflowEventId] = 9 		THEN cast(3 as int) /* Terminated */
						ELSE cast(0 as int) /* Running */
					END
					,CASE
						WHEN [t].[IsInstanceType] = 0 THEN [t].[TypeFullName]
						ELSE NULL
					END
					,CASE
						WHEN [t].[IsInstanceType] = 0 THEN [t].[AssemblyFullName]
						ELSE NULL
					END
	FROM			[vw_WorkflowInstance] [wi]
	INNER JOIN		[dbo].[vw_Type] [t]
	ON				[wi].[WorkflowTypeId] = [t].[TypeId]
	LEFT OUTER JOIN	[dbo].[vw_WorkflowInstanceEvent] [wie]
	ON				[wi].[WorkflowInstanceInternalId] = [wie].[WorkflowInstanceInternalId] 
	WHERE			( [wie].[WorkflowInstanceEventId] = 
						( 
							SELECT  max([WorkflowInstanceEventId])
				            FROM  	[dbo].[vw_WorkflowInstanceEvent] [wie2]
				            WHERE  	[wie2].[WorkflowInstanceInternalId] = [wie].[WorkflowInstanceInternalId]
							AND		[wie2].[TrackingWorkflowEventId] NOT IN ( 5, 6, 7 ) -- Persisted, Unloaded, Loaded
						)
					OR [wie].[EventOrder] IS NULL ) -- Profile might not track instance events '

	IF @WorkflowInstanceId IS NOT NULL
	 BEGIN
		SELECT @query = @query + '
	AND				[wi].[WorkflowInstanceId] = ''' + cast( @WorkflowInstanceId as char(36) ) + ''''
	 END

	IF @typeId IS NOT NULL
	 BEGIN
		SELECT @query = @query + '
	AND				[wi].[WorkflowTypeId] = ' + cast( @typeId as varchar ) + ' '
	 END

	IF @WorkflowStatusId IS NOT NULL
	 BEGIN
		SELECT @query = @query + '
	AND				( [wie].[TrackingWorkflowEventId] in ( '
		IF @WorkflowStatusId = 0 /* Running */
			SELECT @query = @query + cast( 2 as char(1) ) + ', ' + cast( 4 as char(1) ) + ', ' + cast( 8 as char(1) ) + ', ' + cast( 10 as char(2) ) + ', ' + cast( 11 as char(2) ) + ', ' + cast( 12 as char(2) ) + ' ) '
		ELSE IF @WorkflowStatusId = 1 /* Completed */
			SELECT @query = @query + cast( 1 as char(1) ) + ' ) '
		ELSE IF @WorkflowStatusId = 2 /* Suspended */
			SELECT @query = @query + cast( 3 as char(1) ) + ' ) '
		ELSE IF @WorkflowStatusId = 3 /* Terminated */
			SELECT @query = @query + cast( 9 as char(1) ) + ' ) '
		ELSE IF @WorkflowStatusId = 4 /* Created */
			SELECT @query = @query + cast( 0 as char(1) ) + ' )  OR [wie].[TrackingWorkflowEventId] IS NULL ' -- Not tracking workflow events
		ELSE
		 BEGIN
			SET @error_desc = @localized_string_GetWorkflows_Failed_InvalidStatus
			GOTO FAILED
		 END
		
		SELECT @query = @query + ' ) '
		IF @StatusMinDateTime IS NOT NULL
		 BEGIN
			--
			-- Don't use the db date time in this case
			-- It would be weird to the client to request 12:00-11:59 
			-- and get 11:59 from the previous day because time of the event
			-- and the time the batch was written split their query start or end datetime			
			SELECT @query = @query + '
	AND				[wie].[EventDateTime] BETWEEN convert(datetime,''' + convert( nvarchar(32), @StatusMinDateTime, 121 ) + ''',121) AND convert(datetime,''' + convert( nvarchar(32), @StatusMaxDateTime, 121 ) + ''',121) '
		 END
	 END

	IF @TrackingDataItems IS NOT NULL
	 BEGIN
		SELECT @query = @query + '
		AND			[wi].[WorkflowInstanceInternalId] IN
					(
						SELECT		[wi2].[WorkflowInstanceInternalId]
						FROM		[vw_WorkflowInstance] [wi2]
						INNER JOIN	[dbo].[vw_ActivityInstance] [ai]
						ON			[wi2].[WorkflowInstanceInternalId] = [ai].[WorkflowInstanceInternalId]
						INNER JOIN	[dbo].[vw_ActivityExecutionStatusEvent] [ase]
						ON			[ai].[ActivityInstanceId] = [ase].[ActivityInstanceId]
						INNER JOIN	[dbo].[vw_TrackingDataItem] [a]
						ON			[ase].[WorkflowInstanceInternalId] = [a].[WorkflowInstanceInternalId]
						AND			[ase].[ActivityExecutionStatusEventId] = [a].[EventId]
						AND			[a].[EventTypeId] = ''a''
						INNER JOIN	[#TrackingDataItems] [art]
						ON			[a].[FieldName] = [art].[FieldName]
						AND			[ai].[QualifiedName] = [art].[QualifiedName]
						AND			( [a].[Data_Str] = [art].[DataValue] '

		-- The null comparison is expensive as the OR IS NULL clause will prevent index use
		-- Only add it if we are given null as a search value
		IF EXISTS ( SELECT 1 FROM [#TrackingDataItems] WHERE [DataValue] IS NULL )
		 BEGIN
			SELECT @query = @query + '
									OR 
									( [a].[Data_Str] IS NULL AND [art].[DataValue] IS NULL )
			 '
		 END

		SELECT @query = @query + '
		 ) )'
	 END


	--print @query
	EXEC( @query )

	SET @ret = 0
	GOTO DONE	

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	IF @TrackingDataItems IS NOT NULL AND datalength( @TrackingDataItems ) > 0 AND @idoc IS NOT NULL
	 BEGIN
		EXEC sp_xml_removedocument @idoc
	 END

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetWorkflows] TO tracking_reader
GO





IF OBJECT_ID('[dbo].[GetWorkflowInstanceEvents]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetWorkflowInstanceEvents]
GO

CREATE PROCEDURE [dbo].[GetWorkflowInstanceEvents]	@WorkflowInstanceInternalId		bigint
													,@BeginDateTime					datetime
													,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetWorkflowInstanceEvents_Failed nvarchar(256)
	set @localized_string_GetWorkflowInstanceEvents_Failed = N'GetWorkflowInstanceEvents failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 		cast([TrackingWorkflowEventId]as int)
				,[EventDateTime]
				,[EventOrder]
				,[EventArg]
				,[WorkflowInstanceEventId]
				,[DbEventDateTime]
	FROM		[dbo].[vw_WorkflowInstanceEvent]
	WHERE		[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND			[DbEventDateTime] > @BeginDateTime
	AND			[DbEventDateTime] <= @EndDateTime
	ORDER BY	[WorkflowInstanceEventId]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE	

FAILED:
	RAISERROR( @localized_string_GetWorkflowInstanceEvents_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetWorkflowInstanceEvents] TO tracking_reader
GO




IF OBJECT_ID('[dbo].[GetActivityEvents]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetActivityEvents]
GO

CREATE PROCEDURE [dbo].[GetActivityEvents]		@WorkflowInstanceInternalId		bigint
												,@BeginDateTime					datetime
												,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetActivityEvents_Failed nvarchar(256)
	set @localized_string_GetActivityEvents_Failed = N'GetActivityEvents failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 			[ai].[QualifiedName]
					,[ase].[ExecutionStatusId]
					,[ase].[EventDateTime]
					,[ai].[ContextGuid]
					,[ai].[ParentContextGuid]
					,[ase].[EventOrder]
					,'TypeFullName' = 
					CASE
						WHEN [t1].[TypeFullName] IS NULL THEN [t2].[TypeFullName]
						ELSE [t1].[TypeFullName]
					END
					,'AssemblyFullName' = 
					CASE
						WHEN [t1].[AssemblyFullName] IS NULL THEN [t2].[AssemblyFullName]
						ELSE [t1].[AssemblyFullName]
					END
					,[ase].[ActivityExecutionStatusEventId]
					,[ase].[DbEventDateTime]
	FROM			[dbo].[vw_ActivityExecutionStatusEvent] [ase]
	INNER JOIN		[dbo].[vw_ActivityInstance] [ai]
	ON				[ase].[ActivityInstanceId] = [ai].[ActivityInstanceId]
	INNER JOIN		[dbo].[vw_WorkflowInstance] [wi]
	ON				[ai].[WorkflowInstanceInternalId] = [wi].[WorkflowInstanceInternalId]
	LEFT OUTER JOIN	[dbo].[vw_Activity] [a]
	ON				[wi].[WorkflowTypeId] = [a].[WorkflowTypeId]
	AND				[ai].[QualifiedName] = [a].[QualifiedName]
	LEFT OUTER JOIN	[dbo].[vw_Type] [t1]
	ON				[a].[ActivityTypeId] = [t1].[TypeId]
	LEFT OUTER JOIN	[dbo].[vw_AddedActivity] [aa]
	ON				[aa].[WorkflowInstanceEventId] = [ai].[WorkflowInstanceEventId]
	AND				[ai].[QualifiedName] = [aa].[QualifiedName]
	LEFT OUTER JOIN	[dbo].[vw_Type] [t2]
	ON				[aa].[ActivityTypeId] = [t2].[TypeId]
	WHERE			[ase].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND				[ase].[DbEventDateTime] > @BeginDateTime
	AND				[ase].[DbEventDateTime] <= @EndDateTime
	ORDER BY		[ase].[DbEventDateTime], [ase].[EventOrder]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE	

FAILED:
	RAISERROR( @localized_string_GetActivityEvents_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetActivityEvents] TO tracking_reader
GO






IF OBJECT_ID('[dbo].[GetUserEvents]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetUserEvents]
GO

CREATE PROCEDURE [dbo].[GetUserEvents]		@WorkflowInstanceInternalId		bigint
											,@BeginDateTime					datetime
											,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetUserEvents_Failed nvarchar(256)
	set @localized_string_GetUserEvents_Failed = N'GetUserEvents failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 			[ai].[QualifiedName]
					,[ue].[EventDateTime]
					,[ai].[ContextGuid]
					,[ai].[ParentContextGuid]
					,[ue].[EventOrder]
					,[ue].[UserDataKey]
					,[ue].[UserData_Str]
					,[ue].[UserData_Blob]
					,'TypeFullName' = 
					CASE
						WHEN [t1].[TypeFullName] IS NULL THEN [t2].[TypeFullName]
						ELSE [t1].[TypeFullName]
					END
					,'AssemblyFullName' = 
					CASE
						WHEN [t1].[AssemblyFullName] IS NULL THEN [t2].[AssemblyFullName]
						ELSE [t1].[AssemblyFullName]
					END
					,[ue].[UserEventId]
					,[ue].[DbEventDateTime]
	FROM			[dbo].[vw_UserEvent] [ue]
	INNER JOIN		[dbo].[vw_ActivityInstance] [ai]
	ON				[ue].[ActivityInstanceId] = [ai].[ActivityInstanceId]
	INNER JOIN		[dbo].[vw_WorkflowInstance] [wi]
	ON				[ai].[WorkflowInstanceInternalId] = [wi].[WorkflowInstanceInternalId]
	LEFT OUTER JOIN	[dbo].[vw_Activity] [a]
	ON				[wi].[WorkflowTypeId] = [a].[WorkflowTypeId]
	AND				[ai].[QualifiedName] = [a].[QualifiedName]
	LEFT OUTER JOIN	[dbo].[vw_Type] [t1]
	ON				[a].[ActivityTypeId] = [t1].[TypeId]
	LEFT OUTER JOIN	[dbo].[vw_AddedActivity] [aa]
	ON				[aa].[WorkflowInstanceEventId] = [ai].[WorkflowInstanceEventId]
	AND				[ai].[QualifiedName] = [aa].[QualifiedName]
	LEFT OUTER JOIN	[dbo].[vw_Type] [t2]
	ON				[aa].[ActivityTypeId] = [t2].[TypeId]
	WHERE			[ue].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND				[ue].[DbEventDateTime] > @BeginDateTime
	AND				[ue].[DbEventDateTime] <= @EndDateTime
	ORDER BY		[ue].[DbEventDateTime], [ue].[EventOrder]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE	

FAILED:
	RAISERROR( @localized_string_GetUserEvents_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetUserEvents] TO tracking_reader
GO






IF OBJECT_ID('[dbo].[GetActivityTrackingDataItems]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetActivityTrackingDataItems]
GO

CREATE PROCEDURE [dbo].[GetActivityTrackingDataItems]		@WorkflowInstanceInternalId		bigint
															,@BeginDateTime					datetime
															,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetActivityTrackingDataItems_Failed nvarchar(256)
	set @localized_string_GetActivityTrackingDataItems_Failed = N'GetActivityTrackingDataItems failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 		[a].[EventId]
				,[a].[TrackingDataItemId]
				,[a].[FieldName]
				,[a].[Data_Str]
				,[a].[Data_Blob]
				,[ase].[DbEventDateTime]
	FROM		[dbo].[vw_TrackingDataItem] [a]
	INNER JOIN	[dbo].[vw_ActivityExecutionStatusEvent] [ase]
	ON			[a].[WorkflowInstanceInternalId] = [ase].[WorkflowInstanceInternalId]
	AND			[a].[EventId] = [ase].[ActivityExecutionStatusEventId]
	WHERE		[a].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND			[a].[EventTypeId] = 'a'
	AND			[ase].[DbEventDateTime] > @BeginDateTime
	AND			[ase].[DbEventDateTime] <= @EndDateTime
	ORDER BY	[ase].[DbEventDateTime], [ase].[EventOrder]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE	

FAILED:
	RAISERROR( @localized_string_GetActivityTrackingDataItems_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetActivityTrackingDataItems] TO tracking_reader
GO






IF OBJECT_ID('[dbo].[GetActivityTrackingDataItemAnnotations]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetActivityTrackingDataItemAnnotations]
GO

CREATE PROCEDURE [dbo].[GetActivityTrackingDataItemAnnotations]		@WorkflowInstanceInternalId		bigint
															,@BeginDateTime					datetime
															,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetActivityTrackingDataItemAnnotations_Failed nvarchar(256)
	set @localized_string_GetActivityTrackingDataItemAnnotations_Failed = N'GetActivityTrackingDataItemAnnotations failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 		[aa].[TrackingDataItemId]
				,[aa].[Annotation]
				,[ase].[DbEventDateTime]
	FROM		[dbo].[vw_TrackingDataItemAnnotation] [aa]
	INNER JOIN	[dbo].[vw_TrackingDataItem] [a]
	ON			[aa].[TrackingDataItemId] = [a].[TrackingDataItemId]
	INNER JOIN	[dbo].[vw_ActivityExecutionStatusEvent] [ase]
	ON			[a].[WorkflowInstanceInternalId] = [ase].[WorkflowInstanceInternalId]
	AND			[a].[EventId] = [ase].[ActivityExecutionStatusEventId]
	WHERE		[a].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND			[a].[EventTypeId] = 'a'
	AND			[ase].[DbEventDateTime] > @BeginDateTime
	AND			[ase].[DbEventDateTime] <= @EndDateTime
	ORDER BY	[ase].[DbEventDateTime], [ase].[EventOrder]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE	

FAILED:
	RAISERROR( @localized_string_GetActivityTrackingDataItemAnnotations_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetActivityTrackingDataItemAnnotations] TO tracking_reader
GO





IF OBJECT_ID('[dbo].[GetUserTrackingDataItems]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetUserTrackingDataItems]
GO

CREATE PROCEDURE [dbo].[GetUserTrackingDataItems]		@WorkflowInstanceInternalId		bigint
													,@BeginDateTime					datetime
													,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetUserTrackingDataItems_Failed nvarchar(256)
	set @localized_string_GetUserTrackingDataItems_Failed = N'GetUserTrackingDataItems failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 		[a].[EventId]
				,[a].[TrackingDataItemId]
				,[a].[FieldName]
				,[a].[Data_Str]
				,[a].[Data_Blob]
				,[ue].[DbEventDateTime]
	FROM		[dbo].[vw_TrackingDataItem] [a]
	INNER JOIN	[dbo].[vw_UserEvent] [ue]
	ON			[a].[WorkflowInstanceInternalId] = [ue].[WorkflowInstanceInternalId]
	AND			[a].[EventId] = [ue].[UserEventId]
	WHERE		[a].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND			[a].[EventTypeId]='u'
	AND			[ue].[DbEventDateTime] > @BeginDateTime
	AND			[ue].[DbEventDateTime] <= @EndDateTime
	ORDER BY	[ue].[DbEventDateTime], [ue].[EventOrder]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE	

FAILED:
	RAISERROR( @localized_string_GetUserTrackingDataItems_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetUserTrackingDataItems] TO tracking_reader
GO




IF OBJECT_ID('[dbo].[GetUserTrackingDataItemAnnotations]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetUserTrackingDataItemAnnotations]
GO

CREATE PROCEDURE [dbo].[GetUserTrackingDataItemAnnotations]		@WorkflowInstanceInternalId		bigint
														,@BeginDateTime					datetime
														,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetUserTrackingDataItemAnnotations_Failed nvarchar(256)
	set @localized_string_GetUserTrackingDataItemAnnotations_Failed = N'GetUserTrackingDataItemAnnotations failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 		[aa].[TrackingDataItemId]
				,[aa].[Annotation]
				,[ue].[DbEventDateTime]
	FROM		[dbo].[vw_TrackingDataItemAnnotation] [aa]
	INNER JOIN	[dbo].[vw_TrackingDataItem] [a]
	ON			[aa].[TrackingDataItemId] = [a].[TrackingDataItemId]
	INNER JOIN	[dbo].[vw_UserEvent] [ue]
	ON			[a].[WorkflowInstanceInternalId] = [ue].[WorkflowInstanceInternalId]
	AND			[a].[EventId] = [ue].[UserEventId]
	WHERE		[a].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND			[a].[EventTypeId] = 'u'
	AND			[ue].[DbEventDateTime] > @BeginDateTime
	AND			[ue].[DbEventDateTime] <= @EndDateTime
	ORDER BY	[ue].[DbEventDateTime], [ue].[EventOrder]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE	

FAILED:
	RAISERROR( @localized_string_GetUserTrackingDataItemAnnotations_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetUserTrackingDataItemAnnotations] TO tracking_reader
GO





IF OBJECT_ID('[dbo].[GetActivityEventAnnotations]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetActivityEventAnnotations]
GO

CREATE PROCEDURE [dbo].[GetActivityEventAnnotations]		@WorkflowInstanceInternalId		bigint
															,@BeginDateTime					datetime
															,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetActivityEventAnnotations_Failed nvarchar(256)
	set @localized_string_GetActivityEventAnnotations_Failed = N'GetAcctivityEventAnnotations failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 		[ea].[EventId]
				,[ea].[Annotation]
				,[ase].[DbEventDateTime]
	FROM		[dbo].[vw_EventAnnotation] [ea]
	INNER JOIN	[dbo].[vw_ActivityExecutionStatusEvent] [ase]
	ON			[ea].[WorkflowInstanceInternalId] = [ase].[WorkflowInstanceInternalId]
	AND			[ea].[EventId] = [ase].[ActivityExecutionStatusEventId]
	WHERE		[ea].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND			[ea].[EventTypeId] = 'a'
	AND			[ase].[DbEventDateTime] > @BeginDateTime
	AND			[ase].[DbEventDateTime] <= @EndDateTime
	ORDER BY	[ase].[DbEventDateTime], [ase].[EventOrder]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @localized_string_GetActivityEventAnnotations_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetActivityEventAnnotations] TO tracking_reader
GO





IF OBJECT_ID('[dbo].[GetUserEventAnnotations]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetUserEventAnnotations]
GO

CREATE PROCEDURE [dbo].[GetUserEventAnnotations]			@WorkflowInstanceInternalId		bigint
															,@BeginDateTime					datetime
															,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetUserEventAnnotations_Failed nvarchar(256)
	set @localized_string_GetUserEventAnnotations_Failed = N'GetUserEventAnnotations failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 		[ea].[EventId]
				,[ea].[Annotation]
				,[ue].[DbEventDateTime]
	FROM		[dbo].[vw_EventAnnotation] [ea]
	INNER JOIN	[dbo].[vw_UserEvent] [ue]
	ON			[ea].[WorkflowInstanceInternalId] = [ue].[WorkflowInstanceInternalId]
	AND			[ea].[EventId] = [ue].[UserEventId]
	WHERE		[ea].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND			[ea].[EventTypeId] = 'u'
	AND			[ue].[DbEventDateTime] > @BeginDateTime
	AND			[ue].[DbEventDateTime] <= @EndDateTime
	ORDER BY	[ue].[DbEventDateTime], [ue].[EventOrder]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @localized_string_GetUserEventAnnotations_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetUserEventAnnotations] TO tracking_reader
GO





IF OBJECT_ID('[dbo].[GetWorkflowInsertEventAnnotations]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetWorkflowInsertEventAnnotations]
GO

CREATE PROCEDURE [dbo].[GetWorkflowInsertEventAnnotations]		@WorkflowInstanceInternalId		bigint
															,@BeginDateTime					datetime
															,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetWorkflowInsertEventAnnotations_Failed nvarchar(256)
	set @localized_string_GetWorkflowInsertEventAnnotations_Failed = N'GetWorkflowInsertEventAnnotations failed.'

	DECLARE @ret int
	--
	-- Use server datetime in case host machines have out of sync datetimes
	SELECT 		[ea].[EventId]
				,[ea].[Annotation]
				,[we].[DbEventDateTime]
	FROM		[dbo].[vw_EventAnnotation] [ea]
	INNER JOIN	[dbo].[vw_WorkflowInstanceEvent] [we]
	ON			[ea].[WorkflowInstanceInternalId] = [we].[WorkflowInstanceInternalId]
	AND			[ea].[EventId] = [we].[WorkflowInstanceEventId]
	WHERE		[ea].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND			[ea].[EventTypeId] = 'w'
	AND			[we].[DbEventDateTime] > @BeginDateTime
	AND			[we].[DbEventDateTime] <= @EndDateTime
	ORDER BY	[we].[DbEventDateTime], [we].[EventOrder]

	IF @@ERROR <> 0
		GOTO FAILED

	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @localized_string_GetWorkflowInsertEventAnnotations_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetWorkflowInsertEventAnnotations] TO tracking_reader
GO




IF OBJECT_ID('[dbo].[GetActivityEventsWithDetails]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetActivityEventsWithDetails]
GO

CREATE PROCEDURE [dbo].[GetActivityEventsWithDetails]		@WorkflowInstanceInternalId		bigint
															,@BeginDateTime					datetime
															,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetActivityEventsWithDetails_Failed_GetActivityEvents nvarchar(256)
	set @localized_string_GetActivityEventsWithDetails_Failed_GetActivityEvents = N'GetActivityEventsWithDetails failed calling GetActivityEvents.'

	declare @localized_string_GetActivityEventsWithDetails_Failed_GetActivityEventAnnotations nvarchar(256)
	set @localized_string_GetActivityEventsWithDetails_Failed_GetActivityEventAnnotations = N'GetActivityEventsWithDetails failed calling GetActivityEventAnnotations.'

	declare @localized_string_GetActivityEventsWithDetails_Failed_GetActivityTrackingDataItems nvarchar(256)
	set @localized_string_GetActivityEventsWithDetails_Failed_GetActivityTrackingDataItems = N'GetActivityEventsWithDetails failed calling GetTrackingDataItems.'

	declare @localized_string_GetActivityEventsWithDetails_Failed_GetActivityTrackingDataItemAnnotations nvarchar(256)
	set @localized_string_GetActivityEventsWithDetails_Failed_GetActivityTrackingDataItemAnnotations = N'GetActivityEventsWithDetails failed calling GetActivityTrackingDataItemAnnotations.'


	DECLARE @ret int, @error_desc nvarchar(256), @error int

	EXEC @ret = [dbo].[GetActivityEvents] 		@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
												,@BeginDateTime = @BeginDateTime
												,@EndDateTime = @EndDateTime

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetActivityEventsWithDetails_Failed_GetActivityEvents
		GOTO FAILED
	 END

	EXEC @ret = [dbo].[GetActivityEventAnnotations] 		@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
															,@BeginDateTime = @BeginDateTime
															,@EndDateTime = @EndDateTime

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetActivityEventsWithDetails_Failed_GetActivityEventAnnotations
		GOTO FAILED
	 END
		

	EXEC @ret = [dbo].[GetActivityTrackingDataItems]			@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
														,@BeginDateTime = @BeginDateTime
														,@EndDateTime = @EndDateTime

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetActivityEventsWithDetails_Failed_GetActivityTrackingDataItems
		GOTO FAILED
	 END
	
	EXEC @ret = [dbo].[GetActivityTrackingDataItemAnnotations]	@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
														,@BeginDateTime = @BeginDateTime
														,@EndDateTime = @EndDateTime

	
	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetActivityEventsWithDetails_Failed_GetActivityTrackingDataItemAnnotations
		GOTO FAILED
	 END
	
	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetActivityEventsWithDetails] TO tracking_reader
GO





IF OBJECT_ID('[dbo].[GetUserEventsWithDetails]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetUserEventsWithDetails]
GO

CREATE PROCEDURE [dbo].[GetUserEventsWithDetails]		@WorkflowInstanceInternalId		bigint
														,@BeginDateTime					datetime
														,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetUserEventsWithDetails_Failed_GetUserEvents nvarchar(256)
	set @localized_string_GetUserEventsWithDetails_Failed_GetUserEvents = N'GetUserEventsWithDetails failed calling GetUserEvents.'

	declare @localized_string_GetUserEventsWithDetails_Failed_GetUserEventAnnotations nvarchar(256)
	set @localized_string_GetUserEventsWithDetails_Failed_GetUserEventAnnotations = N'GetUserEventsWithDetails failed calling GetUserEventAnnotations.'

	declare @localized_string_GetUserEventsWithDetails_Failed_GetUserTrackingDataItems nvarchar(256)
	set @localized_string_GetUserEventsWithDetails_Failed_GetUserTrackingDataItems = N'GetUserEventsWithDetails failed calling GetUserTrackingDataItems.'

	declare @localized_string_GetUserEventsWithDetails_Failed_GetUserTrackingDataItemAnnotations nvarchar(256)
	set @localized_string_GetUserEventsWithDetails_Failed_GetUserTrackingDataItemAnnotations = N'GetUserEventsWithDetails failed calling GetUserTrackingDataItemAnnotations.'


	DECLARE @ret int, @error_desc nvarchar(256), @error int

	EXEC @ret = [dbo].[GetUserEvents] 				@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
													,@BeginDateTime = @BeginDateTime
													,@EndDateTime = @EndDateTime

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetUserEventsWithDetails_Failed_GetUserEvents
		GOTO FAILED
	 END
	

	EXEC @ret = [dbo].[GetUserEventAnnotations] 	@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
													,@BeginDateTime = @BeginDateTime
													,@EndDateTime = @EndDateTime

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetUserEventsWithDetails_Failed_GetUserEventAnnotations
		GOTO FAILED
	 END
		

	EXEC @ret = [dbo].[GetUserTrackingDataItems]			@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
													,@BeginDateTime = @BeginDateTime
													,@EndDateTime = @EndDateTime

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetUserEventsWithDetails_Failed_GetUserTrackingDataItems
		GOTO FAILED
	 END
	
	EXEC @ret = [dbo].[GetUserTrackingDataItemAnnotations]	@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
													,@BeginDateTime = @BeginDateTime
													,@EndDateTime = @EndDateTime

	
	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetUserEventsWithDetails_Failed_GetUserTrackingDataItemAnnotations
		GOTO FAILED
	 END
	
	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetUserEventsWithDetails] TO tracking_reader
GO





IF OBJECT_ID('[dbo].[GetWorkflowInstanceEventsWithDetails]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetWorkflowInstanceEventsWithDetails]
GO

CREATE PROCEDURE [dbo].[GetWorkflowInstanceEventsWithDetails]		@WorkflowInstanceInternalId		bigint
														,@BeginDateTime					datetime
														,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetWorkflowInstanceEventsWithDetails_Failed_GetWorkflowInstanceEvents nvarchar(256)
	set @localized_string_GetWorkflowInstanceEventsWithDetails_Failed_GetWorkflowInstanceEvents = N'GetWorkflowInstanceEventsWithDetails failed calling GetWorkflowInstanceEvents.'

	declare @localized_string_GetWorkflowInstanceEventsWithDetails_Failed_GetWorkflowInsertEventAnnotations nvarchar(256)
	set @localized_string_GetWorkflowInstanceEventsWithDetails_Failed_GetWorkflowInsertEventAnnotations = N'GetWorkflowInstanceEventsWithDetails failed calling GetWorkflowInsertEventAnnotations.'


	DECLARE @ret int, @error_desc nvarchar(256), @error int

	EXEC @ret = [dbo].[GetWorkflowInstanceEvents] 		@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
														,@BeginDateTime = @BeginDateTime
														,@EndDateTime = @EndDateTime

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetWorkflowInstanceEventsWithDetails_Failed_GetWorkflowInstanceEvents
		GOTO FAILED
	 END
	

	EXEC @ret = [dbo].[GetWorkflowInsertEventAnnotations] 	@WorkflowInstanceInternalId = @WorkflowInstanceInternalId
														,@BeginDateTime = @BeginDateTime
														,@EndDateTime = @EndDateTime

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetWorkflowInstanceEventsWithDetails_Failed_GetWorkflowInsertEventAnnotations
		GOTO FAILED
	 END

	
	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetWorkflowInstanceEventsWithDetails] TO tracking_reader
GO





IF OBJECT_ID('[dbo].[GetWorkflowDefinition]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetWorkflowDefinition]
GO

CREATE PROCEDURE [dbo].[GetWorkflowDefinition]		@WorkflowInstanceInternalId		bigint
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetWorkflowDefinition_Failed nvarchar(256)
	set @localized_string_GetWorkflowDefinition_Failed = N'GetWorkflowDefinition failed.'

	DECLARE @error int, @ret int, @textsize int

	SELECT @textsize = @@TEXTSIZE

	SET TEXTSIZE 2147483647

	SELECT		[w].[WorkflowDefinition]
	FROM		[dbo].[vw_Workflow] [w]
	INNER JOIN	[dbo].[vw_WorkflowInstance] [wi]
	ON			[w].[WorkflowTypeId] = [wi].[WorkflowTypeId]
	WHERE		[wi].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0
	 BEGIN
		GOTO FAILED
	 END	
	
	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @localized_string_GetWorkflowDefinition_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	IF @textsize < 0
		SET TEXTSIZE 0
	ELSE
	 BEGIN
		DECLARE @str varchar(64)
		SELECT @str = 'SET TEXTSIZE ' + cast( @textsize as varchar(32) )
		EXEC( @str )
	 END

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetWorkflowDefinition] TO tracking_reader
GO



IF OBJECT_ID('[dbo].[GetWorkflowChanges]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetWorkflowChanges]
GO

CREATE PROCEDURE [dbo].[GetWorkflowChanges]		@WorkflowInstanceInternalId		bigint
												,@BeginDateTime					datetime
												,@EndDateTime					datetime
												,@MaxEventOrder					int = NULL
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetWorkflowChanges_Failed nvarchar(256)
	set @localized_string_GetWorkflowChanges_Failed = N'GetWorkflowChanges failed.'

	DECLARE @error int, @ret int, @rowcount int

	SELECT	TOP 1	([wie].[DbEventDateTime])
	FROM			[dbo].[vw_WorkflowInstanceEvent] [wie]
	WHERE			[wie].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND				[wie].[TrackingWorkflowEventId] = 11 --Changed
	AND				[wie].[DbEventDateTime] > @BeginDateTime
	AND				[wie].[DbEventDateTime] <= @EndDateTime
	ORDER BY		[wie].[DbEventDateTime] desc, [wie].[EventOrder]

	SELECT @rowcount = @@ROWCOUNT

	IF @rowcount = 0
		GOTO DONE

	-- Use a temp table to avoid sending unneeded columns back to the client 
	-- (union requires ordering items to be in the select list)
	IF OBJECT_ID('tempdb..#Changes') IS NOT NULL
		DROP TABLE #Changes	

	CREATE TABLE #Changes
	(
		[ActivityAction]			nvarchar(2000)	COLLATE database_default NOT NULL
		,[Order]					int				NOT NULL
		,[DbEventDateTime]			datetime		NOT NULL
		,[EventOrder]				int				NOT NULL
	)

	IF @MaxEventOrder IS NULL
	 BEGIN
		INSERT		#Changes
		SELECT 		[aa].[AddedActivityAction], [aa].[Order], [wie].[DbEventDateTime], [wie].[EventOrder]
		FROM		[dbo].[vw_AddedActivity] [aa]
		INNER JOIN	[dbo].[vw_WorkflowInstanceEvent] [wie]
		ON			[aa].[WorkflowInstanceEventId] = [wie].[WorkflowInstanceEventId]
		WHERE		[wie].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
		AND			[wie].[TrackingWorkflowEventId] = 11 --Changed
		AND			[wie].[DbEventDateTime] > @BeginDateTime
		AND			[wie].[DbEventDateTime] <= @EndDateTime
		AND			[aa].[AddedActivityAction] IS NOT NULL

		SELECT @error = @@ERROR

		IF @error IS NULL OR @error <> 0
		 BEGIN
			GOTO FAILED
		 END
	 END
	ELSE
	 BEGIN
		INSERT		#Changes
		SELECT 		[aa].[AddedActivityAction], [aa].[Order], [wie].[DbEventDateTime], [wie].[EventOrder]
		FROM		[dbo].[vw_AddedActivity] [aa]
		INNER JOIN	[dbo].[vw_WorkflowInstanceEvent] [wie]
		ON			[aa].[WorkflowInstanceEventId] = [wie].[WorkflowInstanceEventId]
		WHERE		[wie].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
		AND			[wie].[TrackingWorkflowEventId] = 11 --Changed
		AND			[wie].[DbEventDateTime] > @BeginDateTime
		AND			[wie].[DbEventDateTime] <= @EndDateTime
		AND			[wie].[EventOrder] <= @MaxEventOrder
		AND			[aa].[AddedActivityAction] IS NOT NULL

		SELECT @error = @@ERROR

		IF @error IS NULL OR @error <> 0
		 BEGIN
			GOTO FAILED
		 END
	 END

	IF @MaxEventOrder IS NULL
	 BEGIN
		INSERT		#Changes
		SELECT 		[ra].[RemovedActivityAction], [ra].[Order], [wie].[DbEventDateTime], [wie].[EventOrder]
		FROM		[dbo].[vw_RemovedActivity] [ra]
		INNER JOIN	[dbo].[vw_WorkflowInstanceEvent] [wie]
		ON			[ra].[WorkflowInstanceEventId] = [wie].[WorkflowInstanceEventId]
		WHERE		[wie].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
		AND			[wie].[TrackingWorkflowEventId] = 11 --Changed
		AND			[wie].[DbEventDateTime] > @BeginDateTime
		AND			[wie].[DbEventDateTime] <= @EndDateTime
		AND			[ra].[RemovedActivityAction] IS NOT NULL
		
		SELECT @error = @@ERROR

		IF @error IS NULL OR @error <> 0
		 BEGIN
			GOTO FAILED
		 END
	 END
	ELSE
	 BEGIN
		INSERT		#Changes
		SELECT 		[ra].[RemovedActivityAction], [ra].[Order], [wie].[DbEventDateTime], [wie].[EventOrder]
		FROM		[dbo].[vw_RemovedActivity] [ra]
		INNER JOIN	[dbo].[vw_WorkflowInstanceEvent] [wie]
		ON			[ra].[WorkflowInstanceEventId] = [wie].[WorkflowInstanceEventId]
		WHERE		[wie].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
		AND			[wie].[TrackingWorkflowEventId] = 11 --Changed
		AND			[wie].[DbEventDateTime] > @BeginDateTime
		AND			[wie].[DbEventDateTime] <= @EndDateTime
		AND			[wie].[EventOrder] <= @MaxEventOrder
		AND			[ra].[RemovedActivityAction] IS NOT NULL
		
		SELECT @error = @@ERROR

		IF @error IS NULL OR @error <> 0
		 BEGIN
			GOTO FAILED
		 END
	 END

	SELECT		[ActivityAction], [DbEventDateTime], [EventOrder], [Order]
	FROM		#Changes
	ORDER BY	[DbEventDateTime] asc, [EventOrder] asc, [Order] asc

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0
	 BEGIN
		GOTO FAILED
	 END
	
	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @localized_string_GetWorkflowChanges_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	IF OBJECT_ID('tempdb..#Changes') IS NOT NULL
		DROP TABLE #Changes	

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetWorkflowChanges] TO tracking_reader
GO




IF OBJECT_ID('[dbo].[GetWorkflowChangeEventArgs]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetWorkflowChangeEventArgs]
GO

CREATE PROCEDURE [dbo].[GetWorkflowChangeEventArgs]		@WorkflowInstanceInternalId		bigint
														,@BeginDateTime					datetime
														,@WorkflowInstanceEventId		bigint
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetWorkflowChangeEventArgs_Failed nvarchar(256)
	set @localized_string_GetWorkflowChangeEventArgs_Failed = N'GetWorkflowChangeEventArgs failed.'

	declare @localized_string_GetWorkflowChangeEventArgs_Failed_GetDef nvarchar(256)
	set @localized_string_GetWorkflowChangeEventArgs_Failed_GetDef = N'GetWorkflowChangeEventArgs failed calling stored proceedure GetWorkflowDefinition.'

	declare @localized_string_GetWorkflowChangeEventArgs_Failed_GetChanges nvarchar(256)
	set @localized_string_GetWorkflowChangeEventArgs_Failed_GetChanges = N'GetWorkflowChangeEventArgs failed calling stored proceedure GetWorkflowChanges.'

	DECLARE @ret int, @error_desc nvarchar(256), @error int, @EventOrder int, @DbEventDateTime datetime
	--
	-- Get the base definition
	EXEC @ret = [dbo].[GetWorkflowDefinition]	@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetWorkflowChangeEventArgs_Failed_GetDef
		GOTO FAILED
	 END
	--
	-- Get changes
	SELECT		@EventOrder = [EventOrder]
				,@DbEventDateTime = [DbEventDateTime]
	FROM		[dbo].[vw_WorkflowInstanceEvent] [wie]
	WHERE		[wie].[WorkflowInstanceInternalId] = @WorkflowInstanceInternalId
	AND			[wie].[WorkflowInstanceEventId] = @WorkflowInstanceEventId

	SELECT @error = @@ERROR 

	IF @error IS NULL OR @error <> 0 OR @EventOrder IS NULL OR @DbEventDateTime IS NULL
	 BEGIN
		SET @error_desc = @localized_string_GetWorkflowChangeEventArgs_Failed
		GOTO DONE
	 END
	

	EXEC @ret = [dbo].[GetWorkflowChanges]	@WorkflowInstanceInternalId	= @WorkflowInstanceInternalId
											,@BeginDateTime				= @BeginDateTime
											,@EndDateTime				= @DbEventDateTime
											,@MaxEventOrder				= @EventOrder

	SELECT @error = @@ERROR

	IF @error IS NULL OR @error <> 0 OR @ret IS NULL OR @ret <> 0
	 BEGIN
		SET @error_desc = @localized_string_GetWorkflowChangeEventArgs_Failed_GetChanges
		GOTO FAILED
	 END
	
	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @error_desc, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	IF OBJECT_ID('tempdb..#Changes') IS NOT NULL
		DROP TABLE #Changes	

	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetWorkflowChangeEventArgs] TO tracking_reader
GO




IF OBJECT_ID('[dbo].[GetInvokedWorkflows]') IS NOT NULL
	DROP PROCEDURE [dbo].[GetInvokedWorkflows]
GO

CREATE PROCEDURE [dbo].[GetInvokedWorkflows]		@WorkflowInstanceId				uniqueidentifier
													,@BeginDateTime					datetime
													,@EndDateTime					datetime
AS
 BEGIN
	SET NOCOUNT ON

	declare @localized_string_GetInvokedWorkflows_Failed nvarchar(256)
	set @localized_string_GetInvokedWorkflows_Failed = N'GetInvokedWorkflows failed.'

	DECLARE @error int, @ret int

	SELECT 			'CurrentEventTimeStamp' = GetUTCDate()
					,[wi].[WorkflowInstanceId]
					,[wi].[WorkflowInstanceInternalId]
					,[wi].[InitializedDateTime]
					,[wi].[CallerInstanceId]
					,'WorkflowStatus' = 
					CASE
						WHEN [wie].[TrackingWorkflowEventId] = 2 	THEN cast(1 as int) /* Completed */
						WHEN [wie].[TrackingWorkflowEventId] = 4 	THEN cast(2 as int) /* Suspended */
						WHEN [wie].[TrackingWorkflowEventId] = 10 	THEN cast(3 as int) /* Terminated */
						ELSE cast(0 as int) /* Running */
					END
					,[t].[TypeFullName]
					,[t].[AssemblyFullName]
	FROM			[vw_WorkflowInstance] [wi]
	INNER JOIN		[dbo].[vw_Type] [t]
	ON				[wi].[WorkflowTypeId] = [t].[TypeId]
	LEFT OUTER JOIN	[dbo].[vw_WorkflowInstanceEvent] [wie]
	ON				[wi].[WorkflowInstanceInternalId] = [wie].[WorkflowInstanceInternalId] 
	WHERE			( [wie].[EventOrder] = 
						( 
							SELECT  max([EventOrder])
				            FROM  	[dbo].[vw_WorkflowInstanceEvent] [wie2]
				            WHERE  	[wie2].[WorkflowInstanceInternalId] = [wie].[WorkflowInstanceInternalId]
							AND		[wie2].[TrackingWorkflowEventId] != 6
						)
					OR [wie].[EventOrder] IS NULL ) -- Profile might not track instance events 
	AND				[wi].[CallerInstanceId] = @WorkflowInstanceId
	AND				[wi].[InitializedDateTime] > @BeginDateTime
	AND				[wi].[InitializedDateTime] <= @EndDateTime


	SET @ret = 0
	GOTO DONE

FAILED:
	RAISERROR( @localized_string_GetInvokedWorkflows_Failed, 16, -1 )

	SET @ret = -1
	GOTO DONE

DONE:
	RETURN @ret

 END
GO

GRANT EXECUTE ON [dbo].[GetInvokedWorkflows] TO tracking_reader
GO
