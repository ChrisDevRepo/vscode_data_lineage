-- Copyright (c) Microsoft Corporation.  All rights reserved.

--
-- PROCEDURE InsertInstanceState
--
if exists (select * from dbo.sysobjects where id = object_id(N'[dbo].[InsertInstanceState]') and OBJECTPROPERTY(id, N'IsProcedure') = 1)
drop procedure [dbo].[InsertInstanceState]
GO
Create Procedure [dbo].[InsertInstanceState]
@uidInstanceID uniqueidentifier,
@state image,
@status int,
@unlocked int,
@blocked int,
@info ntext,
@ownerID uniqueidentifier = NULL,
@ownedUntil datetime = NULL,
@nextTimer datetime,
@result int output,
@currentOwnerID uniqueidentifier output
As
    declare @localized_string_InsertInstanceState_Failed_Ownership nvarchar(256)
    set @localized_string_InsertInstanceState_Failed_Ownership = N'Instance ownership conflict'
    set @result = 0
    set @currentOwnerID = @ownerID
    declare @now datetime
    set @now = GETUTCDATE()

    SET TRANSACTION ISOLATION LEVEL READ COMMITTED
    set nocount on

    IF @status=1 OR @status=3
    BEGIN
	DELETE FROM [dbo].[InstanceState] WHERE uidInstanceID=@uidInstanceID AND ((ownerID = @ownerID AND ownedUntil>=@now) OR (ownerID IS NULL AND @ownerID IS NULL ))
	if ( @@ROWCOUNT = 0 )
	begin
		set @currentOwnerID = NULL
    		select  @currentOwnerID=ownerID from [dbo].[InstanceState] Where uidInstanceID = @uidInstanceID
		if ( @currentOwnerID IS NOT NULL )
		begin	-- cannot delete the instance state because of an ownership conflict
			-- RAISERROR(@localized_string_InsertInstanceState_Failed_Ownership, 16, -1)				
			set @result = -2
			return
		end
	end
	else
	BEGIN
		DELETE FROM [dbo].[CompletedScope] WHERE uidInstanceID=@uidInstanceID
	end
    END
    
    ELSE BEGIN

  	    if not exists ( Select 1 from [dbo].[InstanceState] Where uidInstanceID = @uidInstanceID )
		  BEGIN
			  --Insert Operation
			  IF @unlocked = 0
			  begin
			     Insert into [dbo].[InstanceState] 
			     Values(@uidInstanceID,@state,@status,@unlocked,@blocked,@info,@now,@ownerID,@ownedUntil,@nextTimer) 
			  end
			  else
			  begin
			     Insert into [dbo].[InstanceState] 
			     Values(@uidInstanceID,@state,@status,@unlocked,@blocked,@info,@now,null,null,@nextTimer) 
			  end
		  END
		  
		  ELSE BEGIN

				IF @unlocked = 0
				begin
					Update [dbo].[InstanceState]  
					Set state = @state,
						status = @status,
						unlocked = @unlocked,
						blocked = @blocked,
						info = @info,
						modified = @now,
						ownedUntil = @ownedUntil,
						nextTimer = @nextTimer
					Where uidInstanceID = @uidInstanceID AND ((ownerID = @ownerID AND ownedUntil>=@now) OR (ownerID IS NULL AND @ownerID IS NULL ))
					if ( @@ROWCOUNT = 0 )
					BEGIN
						-- RAISERROR(@localized_string_InsertInstanceState_Failed_Ownership, 16, -1)
						select @currentOwnerID=ownerID from [dbo].[InstanceState] Where uidInstanceID = @uidInstanceID  
						set @result = -2
						return
					END
				end
				else
				begin
					Update [dbo].[InstanceState]  
					Set state = @state,
						status = @status,
						unlocked = @unlocked,
						blocked = @blocked,
						info = @info,
						modified = @now,
						ownerID = NULL,
						ownedUntil = NULL,
						nextTimer = @nextTimer
					Where uidInstanceID = @uidInstanceID AND ((ownerID = @ownerID AND ownedUntil>=@now) OR (ownerID IS NULL AND @ownerID IS NULL ))
					if ( @@ROWCOUNT = 0 )
					BEGIN
						-- RAISERROR(@localized_string_InsertInstanceState_Failed_Ownership, 16, -1)
						select @currentOwnerID=ownerID from [dbo].[InstanceState] Where uidInstanceID = @uidInstanceID  
						set @result = -2
						return
					END
				end
				
		  END


    END
		RETURN
Return
Go
GRANT EXECUTE ON [dbo].[InsertInstanceState] TO state_persistence_users
GO


--
-- PROCEDURE RetrieveAllInstanceDescriptions
-- 
if exists (select * from dbo.sysobjects where id = object_id(N'[dbo].[RetrieveAllInstanceDescriptions]') and OBJECTPROPERTY(id, N'IsProcedure') = 1)
drop procedure [dbo].[RetrieveAllInstanceDescriptions]
GO
Create Procedure [dbo].[RetrieveAllInstanceDescriptions]
As
	SELECT uidInstanceID, status, blocked, info, nextTimer
	FROM [dbo].[InstanceState]
GO

--
-- PROCEDURE UnlockInstanceState
--
if exists (select * from dbo.sysobjects where id = object_id(N'[dbo].[UnlockInstanceState]') and OBJECTPROPERTY(id, N'IsProcedure') = 1)
drop procedure [dbo].[UnlockInstanceState]
GO
Create Procedure [dbo].[UnlockInstanceState]
@uidInstanceID uniqueidentifier,
@ownerID uniqueidentifier = NULL
As

SET TRANSACTION ISOLATION LEVEL READ COMMITTED
set nocount on

		Update [dbo].[InstanceState]  
		Set ownerID = NULL,
		     unlocked = 1,
			ownedUntil = NULL
		Where uidInstanceID = @uidInstanceID AND ((ownerID = @ownerID AND ownedUntil>=GETUTCDATE()) OR (ownerID IS NULL AND @ownerID IS NULL ))
Go
GRANT EXECUTE ON [dbo].[UnlockInstanceState] TO state_persistence_users
GO


--
-- PROCEDURE RetrieveInstanceState
--
if exists (select * from dbo.sysobjects where id = object_id(N'[dbo].[RetrieveInstanceState]') and OBJECTPROPERTY(id, N'IsProcedure') = 1)
drop procedure [dbo].[RetrieveInstanceState]
GO
Create Procedure [dbo].[RetrieveInstanceState]
@uidInstanceID uniqueidentifier,
@ownerID uniqueidentifier = NULL,
@ownedUntil datetime = NULL,
@result int output,
@currentOwnerID uniqueidentifier output
As
Begin
    declare @localized_string_RetrieveInstanceState_Failed_Ownership nvarchar(256)
    set @localized_string_RetrieveInstanceState_Failed_Ownership = N'Instance ownership conflict'
    set @result = 0
    set @currentOwnerID = @ownerID

	SET TRANSACTION ISOLATION LEVEL REPEATABLE READ
	BEGIN TRANSACTION
	
    -- Possible workflow status: 0 for executing; 1 for completed; 2 for suspended; 3 for terminated; 4 for invalid

	if @ownerID IS NOT NULL	-- if id is null then just loading readonly state, so ignore the ownership check
	begin
		  Update [dbo].[InstanceState]  
		  set	ownerID = @ownerID,
				ownedUntil = @ownedUntil
		  where uidInstanceID = @uidInstanceID AND (    ownerID = @ownerID 
													 OR ownerID IS NULL 
													 OR ownedUntil<GETUTCDATE()
													)
		  if ( @@ROWCOUNT = 0 )
		  BEGIN
			-- RAISERROR(@localized_string_RetrieveInstanceState_Failed_Ownership, 16, -1)
			select @currentOwnerID=ownerID from [dbo].[InstanceState] Where uidInstanceID = @uidInstanceID 
			if (  @@ROWCOUNT = 0 )
				set @result = -1
			else
				set @result = -2
			GOTO DONE
		  END
	end
	
    Select state from [dbo].[InstanceState]  
    Where uidInstanceID = @uidInstanceID
    
	set @result = @@ROWCOUNT;
    if ( @result = 0 )
	begin
		set @result = -1
		GOTO DONE
	end
	
DONE:
	COMMIT TRANSACTION
	RETURN

End
Go
GRANT EXECUTE ON [dbo].[RetrieveInstanceState] TO state_persistence_users
GO


--
-- PROCEDURE RetrieveNonblockingInstanceStateIds
--
IF EXISTS (SELECT * FROM [dbo].[sysobjects] WHERE id = object_id(N'[dbo].[RetrieveNonblockingInstanceStateIds]') and OBJECTPROPERTY(id, N'IsProcedure') = 1)
DROP PROCEDURE [dbo].[RetrieveNonblockingInstanceStateIds]
GO
CREATE PROCEDURE [dbo].[RetrieveNonblockingInstanceStateIds]
@ownerID uniqueidentifier = NULL,
@ownedUntil datetime = NULL,
@now datetime
AS
    SELECT uidInstanceID FROM [dbo].[InstanceState] WITH (TABLOCK,UPDLOCK,HOLDLOCK)
    WHERE blocked=0 AND status<>1 AND status<>3 AND status<>2 -- not blocked and not completed and not terminated and not suspended
 		AND ( ownerID IS NULL OR ownedUntil<GETUTCDATE() )
    if ( @@ROWCOUNT > 0 )
    BEGIN
        -- lock the table entries that are returned
        Update [dbo].[InstanceState]  
        set ownerID = @ownerID,
	    ownedUntil = @ownedUntil
        WHERE blocked=0 AND status<>1 AND status<>3 AND status<>2
 		AND ( ownerID IS NULL OR ownedUntil<GETUTCDATE() )
	
    END
GO
GRANT EXECUTE ON [dbo].[RetrieveNonblockingInstanceStateIds] TO state_persistence_users
GO

--
-- PROCEDURE RetrieveANonblockingInstanceStateId
--
IF EXISTS (SELECT * FROM [dbo].[sysobjects] WHERE id = object_id(N'[dbo].[RetrieveANonblockingInstanceStateId]') and OBJECTPROPERTY(id, N'IsProcedure') = 1)
DROP PROCEDURE [dbo].[RetrieveANonblockingInstanceStateId]
GO
CREATE PROCEDURE [dbo].[RetrieveANonblockingInstanceStateId]
@ownerID uniqueidentifier = NULL,
@ownedUntil datetime = NULL,
@uidInstanceID uniqueidentifier = NULL output,
@found bit = NULL output
AS
 BEGIN
		--
		-- Guarantee that no one else grabs this record between the select and update
		SET TRANSACTION ISOLATION LEVEL REPEATABLE READ
		BEGIN TRANSACTION

SET ROWCOUNT 1
		SELECT	@uidInstanceID = uidInstanceID
		FROM	[dbo].[InstanceState] WITH (updlock) 
		WHERE	blocked=0 
		AND	status NOT IN ( 1,2,3 )
 		AND	( ownerID IS NULL OR ownedUntil<GETUTCDATE() )
SET ROWCOUNT 0

		IF @uidInstanceID IS NOT NULL
		 BEGIN
			UPDATE	[dbo].[InstanceState]  
			SET		ownerID = @ownerID,
					ownedUntil = @ownedUntil
			WHERE	uidInstanceID = @uidInstanceID

			SET @found = 1
		 END
		ELSE
		 BEGIN
			SET @found = 0
		 END

		COMMIT TRANSACTION
 END
GO
GRANT EXECUTE ON [dbo].[RetrieveANonblockingInstanceStateId] TO state_persistence_users
GO

--
-- PROCEDURE RetrieveExpiredTimerIds
--
IF EXISTS (SELECT * FROM [dbo].[sysobjects] WHERE id = object_id(N'[dbo].[RetrieveExpiredTimerIds]') and OBJECTPROPERTY(id, N'IsProcedure') = 1)
DROP PROCEDURE [dbo].[RetrieveExpiredTimerIds]
GO
CREATE PROCEDURE [dbo].[RetrieveExpiredTimerIds]
@ownerID uniqueidentifier = NULL,
@ownedUntil datetime = NULL,
@now datetime
AS
    SELECT uidInstanceID FROM [dbo].[InstanceState]
    WHERE nextTimer<@now AND status<>1 AND status<>3 AND status<>2 -- not blocked and not completed and not terminated and not suspended
        AND ((unlocked=1 AND ownerID IS NULL) OR ownedUntil<GETUTCDATE() )
GO
GRANT EXECUTE ON [dbo].[RetrieveExpiredTimerIds] TO state_persistence_users
GO

--
-- PROCEDURE InsertCompletedScope
--
IF EXISTS (SELECT * FROM [dbo].[sysobjects] WHERE id = object_id(N'[dbo].[InsertCompletedScope]') AND OBJECTPROPERTY(id, N'IsProcedure') = 1)
DROP PROCEDURE [dbo].[InsertCompletedScope]
GO
CREATE PROCEDURE [dbo].[InsertCompletedScope]
@instanceID uniqueidentifier,
@completedScopeID uniqueidentifier,
@state image
As

SET TRANSACTION ISOLATION LEVEL READ COMMITTED
SET NOCOUNT ON

		UPDATE [dbo].[CompletedScope] WITH(ROWLOCK UPDLOCK) 
		    SET state = @state,
		    modified = GETUTCDATE()
		    WHERE completedScopeID=@completedScopeID 

		IF ( @@ROWCOUNT = 0 )
		BEGIN
			--Insert Operation
			INSERT INTO [dbo].[CompletedScope] WITH(ROWLOCK)
			VALUES(@instanceID, @completedScopeID, @state, GETUTCDATE()) 
		END

		RETURN
RETURN
GO
GRANT EXECUTE ON [dbo].[InsertCompletedScope] TO state_persistence_users
GO


--
-- PROCEDURE DeleteCompletedScope
--
IF EXISTS (SELECT * FROM [dbo].[sysobjects] WHERE id = object_id(N'[dbo].[DeleteCompletedScope]') and OBJECTPROPERTY(id, N'IsProcedure') = 1)
DROP PROCEDURE [dbo].[DeleteCompletedScope]
GO
CREATE PROCEDURE [dbo].[DeleteCompletedScope]
@completedScopeID uniqueidentifier
AS
DELETE FROM [dbo].[CompletedScope] WHERE completedScopeID=@completedScopeID
Go
GRANT EXECUTE ON [dbo].[DeleteCompletedScope] TO state_persistence_users
GO

--
-- PROCEDURE RetrieveCompletedScope
--
IF EXISTS (SELECT * FROM [dbo].[sysobjects] WHERE id = object_id(N'[dbo].[RetrieveCompletedScope]') and OBJECTPROPERTY(id, N'IsProcedure') = 1)
DROP PROCEDURE [dbo].[RetrieveCompletedScope]
GO
CREATE PROCEDURE RetrieveCompletedScope
@completedScopeID uniqueidentifier,
@result int output
AS
BEGIN
    SELECT state FROM [dbo].[CompletedScope] WHERE completedScopeID=@completedScopeID
	set @result = @@ROWCOUNT;
End
GO
GRANT EXECUTE ON [dbo].[RetrieveCompletedScope] TO state_persistence_users
GO


DBCC TRACEON (1204)