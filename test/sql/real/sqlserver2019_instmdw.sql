/**********************************************************************/
/* INSTMDW.SQL                                                        */
/*                                                                    */
/* Installs the tables and stored procedures necessary for            */
/* supporting the Management Data Warehouse in Data Collector         */
/*                                                                    */
/* MDW database is created by Setup and this script is run in the     */
/* context of the created MDW database                                */
/*                                                                    */
/* To run this script manually on a MDW database:                     */
/* "sqlcmd -d MDW -i instmdw.sql"                                     */
/*                                                                    */
/*                                                                    */
/* Copyright (c) Microsoft Corporation                                */
/* All Rights Reserved.                                               */
/*                                                                    */
/**********************************************************************/


RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('----------------------------------', 0, 1)  WITH NOWAIT;
RAISERROR('Starting execution of INSTMDW.SQL ', 0, 1)  WITH NOWAIT;
RAISERROR('----------------------------------', 0, 1)  WITH NOWAIT;
GO

SET ANSI_NULLS ON
SET ANSI_NULL_DFLT_ON ON
SET ANSI_PADDING ON
SET ANSI_WARNINGS ON
SET ARITHABORT ON
SET CONCAT_NULL_YIELDS_NULL ON
SET NUMERIC_ROUNDABORT OFF
SET QUOTED_IDENTIFIER ON
GO

-- This version of instmdw should be executed only against 10.0 servers or higher
IF (@@microsoftversion / 0x01000000) < 10
BEGIN
    RAISERROR('Management Data Warehouse database can only be installed on an instance of SQL Server 2008 or higher.', 21, 127) WITH LOG 
END
GO

-- SQL Server Express Edition and Azure SQL Edge does not support a management data warehouse.
DECLARE @retval sql_variant
SELECT @retval = (SELECT SERVERPROPERTY('EngineEdition'))
IF (@retval = 4 OR @retval = 9) -- 4: Express 9: Azure SQL Edge
BEGIN
    RAISERROR(14713, 20, -1) WITH LOG 
END
GO

-- Take the database to single mode during the installation
RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Taking database to single user mode', 0, 1)  WITH NOWAIT;

DECLARE @dbname sysname
SELECT @dbname = QUOTENAME(DB_NAME())


-- Check if someone has turned async statistics autoupdate on
DECLARE @async_auto_stat bit
SELECT @async_auto_stat = is_auto_update_stats_async_on
FROM sys.databases
WHERE database_id = DB_ID()

CREATE TABLE #tmp_auto_mode (auto_mode bit)

IF (@async_auto_stat = 1)       -- if yes, turn it off while install
BEGIN
    RAISERROR('Disabling asynchronous auto statistics while database in single user mode ...', 0, 1)  WITH NOWAIT;
    DECLARE @sql_async_autostat_off nvarchar(256)
    SET @sql_async_autostat_off = 'ALTER DATABASE ' + @dbname + 
                                            ' SET AUTO_UPDATE_STATISTICS_ASYNC OFF'

    EXEC sp_executesql @sql_async_autostat_off

    -- check for all the currently running background statistics jobs
    -- and kill them
    DECLARE @stats_job_id nvarchar(10)
    DECLARE @sql_kill_stats_job nvarchar(256)

    DECLARE stats_jobs_id_cursor CURSOR READ_ONLY FOR
    SELECT CONVERT(nvarchar(10), job_id)
    FROM sys.dm_exec_background_job_queue
    WHERE database_id = DB_ID()

    OPEN stats_jobs_id_cursor
    FETCH NEXT FROM stats_jobs_id_cursor INTO @stats_job_id
    WHILE (@@FETCH_STATUS = 0)
    BEGIN
        SET @sql_kill_stats_job = 'KILL STATS JOB ' + @stats_job_id
        EXEC sp_executesql @sql_kill_stats_job
    END

    CLOSE stats_jobs_id_cursor
    DEALLOCATE stats_jobs_id_cursor

    -- save the fact that async_auto_stats was on
    INSERT INTO #tmp_auto_mode
    VALUES(1)
END

-- Now, put the database in single user mode
DECLARE @sql_query nvarchar(256)
SET @sql_query = 'ALTER DATABASE ' + @dbname +
                 '   SET SINGLE_USER WITH ROLLBACK IMMEDIATE'
EXEC sp_executesql @sql_query;

-- Allow the use of snapshot transaction isolation level 
SET @sql_query = 'ALTER DATABASE ' + @dbname + ' SET ALLOW_SNAPSHOT_ISOLATION ON';
EXEC sp_executesql @sql_query;

-- Turn on the read_committed_snapshot database option
SET @sql_query = 'ALTER DATABASE ' + @dbname + ' SET READ_COMMITTED_SNAPSHOT ON';
EXEC sp_executesql @sql_query;
GO


-- Set the right options
-- These are needed for the correct behavior of check constraint
SET ANSI_NULLS ON
SET ANSI_PADDING ON
SET ANSI_WARNINGS ON
SET ARITHABORT ON
SET CONCAT_NULL_YIELDS_NULL ON
SET NUMERIC_ROUNDABORT OFF
SET QUOTED_IDENTIFIER ON 
GO

/**********************************************************************/
/* Add an extended database property to identify database as a data   */
/* warehouse for the data collector.                                  */
/*                                                                    */
/* If a version already exists, check that we are not down grading    */
/* to a lower version.                                                */
/**********************************************************************/

--
-- This stored procedure compares two build numbers
-- It tokenizes the numbers by '.' and compares the portions from left to right
--
IF (OBJECT_ID(N'tempdb..#sp_compare_builds', 'P') IS NOT NULL)
BEGIN
    DROP PROCEDURE [tempdb]..[#sp_compare_builds]
END
GO 

CREATE PROCEDURE #sp_compare_builds
    @old            nvarchar(100),
    @new            nvarchar(100),
    @order          int OUTPUT      -- -1 if @old<@new, 0 if @old=@new, 1 if @old>@new
AS
BEGIN
    DECLARE @retVal int
    DECLARE @old_portion nvarchar(100)
    DECLARE @new_portion nvarchar(100)
    DECLARE @old_number int
    DECLARE @new_number int
    
    SET @old = NULLIF(@old+'.', '.')
    SET @new = NULLIF(@new+'.', '.')    
    SET @order = 0
    BEGIN TRY
        SET @retVal = 0
        WHILE ((@old IS NOT NULL) AND (@new IS NOT NULL))
        BEGIN
            --SELECT @old as old, @new as new
            DECLARE @old_token_mark int
            DECLARE @new_token_mark int
            SET @old_token_mark = CHARINDEX('.', @old)
            SET @new_token_mark = CHARINDEX('.', @new)
            
            -- get the first number in the version from the left
            SET @old_portion = LEFT(@old, @old_token_mark-1)
            SET @new_portion = LEFT(@new, @new_token_mark-1)
            
            -- trim the number from the left
            SET @old = NULLIF(SUBSTRING(@old, @old_token_mark+1, LEN(@old)-@old_token_mark), '')
            SET @new = NULLIF(SUBSTRING(@new, @new_token_mark+1, LEN(@new)-@new_token_mark), '')
            
            -- compare the portions you have
            SET @old_number = CONVERT(int, @old_portion)
            SET @new_number = CONVERT(int, @new_portion)
            
            IF (@old_number = @new_number)
            BEGIN
                CONTINUE
            END
            ELSE
            BEGIN -- We have a resolution, figure out who comes first and get out
                IF (@old_number < @new_number)
                BEGIN
                    SET @order = -1
                END
                ELSE
                BEGIN
                    SET @order = 1
                END
                
                BREAK
            END
        END
        
        RETURN (0)
    END TRY
    BEGIN CATCH
        DECLARE @ErrorMessage   NVARCHAR(4000);
        DECLARE @ErrorSeverity  INT;
        DECLARE @ErrorState     INT;
        DECLARE @ErrorNumber    INT;
        DECLARE @ErrorLine      INT;
        DECLARE @ErrorProcedure NVARCHAR(200);
        SELECT @ErrorLine = ERROR_LINE(),
               @ErrorSeverity = ERROR_SEVERITY(),
               @ErrorState = ERROR_STATE(),
               @ErrorNumber = ERROR_NUMBER(),
               @ErrorMessage = ERROR_MESSAGE(),
               @ErrorProcedure = ISNULL(ERROR_PROCEDURE(), '-');

        RAISERROR (14684, @ErrorSeverity, -1 , @ErrorNumber, @ErrorSeverity, @ErrorState, @ErrorProcedure, @ErrorLine, @ErrorMessage);

        RETURN (1)
    END CATCH    
END
GO

DECLARE @prop_name sysname
DECLARE @new_value sql_variant
DECLARE @old_value sql_variant
SET @prop_name = 'Microsoft_DataCollector_MDW_Version'
SET @new_value = '17.0.1000.7'     -- This will be replaced at build time with the sql build number

SELECT @old_value = value
FROM fn_listextendedproperty(@prop_name, NULL, NULL, NULL, NULL, NULL, NULL)

IF (@old_value IS NOT NULL)
BEGIN
    DECLARE @order int
    DECLARE @old_value_char nvarchar(100)
    DECLARE @new_value_char nvarchar(100)
    SET @old_value_char = CONVERT(nvarchar(100), @old_value)
    SET @new_value_char = CONVERT(nvarchar(100), @new_value)

    -- check that we are not downgrading the database
    IF (@old_value_char <> '17.0.1000.7')   -- value only used during development
    BEGIN
        EXEC #sp_compare_builds @old_value_char, @new_value_char, @order OUTPUT
        
        IF (@order > 0) -- the old build version is older than the new, abort the script and kill the connection
        BEGIN
            -- Put the database back into multi user mode
            RAISERROR('', 0, 1)  WITH NOWAIT;
            RAISERROR('Restoring database to multi user mode before aborting the script', 0, 1)  WITH NOWAIT;
            DECLARE @dbname sysname
            SET @dbname = QUOTENAME(DB_NAME())

            DECLARE @sql_db_multi_mode nvarchar(256)
            SET @sql_db_multi_mode = 'ALTER DATABASE ' + @dbname +
                                                ' SET MULTI_USER WITH ROLLBACK IMMEDIATE'
            EXEC sp_executesql @sql_db_multi_mode

            RAISERROR(14714, 21, 1, @old_value_char, @new_value_char) WITH LOG
        END
    END
    EXEC sp_dropextendedproperty @name = @prop_name
END            

EXEC sp_addextendedproperty
        @name = @prop_name,
        @value = @new_value
GO

DROP PROCEDURE #sp_compare_builds


/*
Procedure [#create_or_alter_primary_key_or_index]

Helper proc to create/update primary key constraints and nonclustered/clustered indexes. 
Avoids the need to duplicate object definition in separate creation and upgrade sections. 
Prevents cluttering up the script with repetitive logic to repeat these tasks every time 
we need to define an index or a primary key: 
  - Check for an existing object and skip the create if appropriate
  - Compare the definition of the existing object (clustered vs. nonclustered, number and 
    order of index key columns, ignore_dup_key bit, included vs. key columns, asc/desc 
    sort direction) to the desired index or constraint definition
  - Drop the existing constraint/index if it is malformed or out-of-date 
  - Drop nonclustered indexes before dropping clustered indexes
  - Drop referencing foreign keys before dropping a primary key
 
Parameters: 
    @table_schema - e.g. "snapshots"
    @table_name - e.g. "query_stats"
    @object_type - either "PRIMARY KEY" or "INDEX"
    @constraint_or_index_name - the PK or index name
    @ignore_dup_key - 1 to enable the IGNORE_DUP_KEY index option (default 0)
    @clustered - 1 to create a clustered index/PK (default 1)

The columns in the table are passed to this proc via this temp table: 
    CREATE TABLE #index_key_columns (
        key_ordinal         int IDENTITY, 
        constraint_name     sysname COLLATE CATALOG_DEFAULT, 
        column_name         sysname COLLATE CATALOG_DEFAULT, 
        is_included_column  bit, 
        is_descending_key   bit
    );

Example usage: 
    TRUNCATE TABLE #index_key_columns;
    INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
    VALUES 
        ('IDX_performance_counter_instances1', 'object_name', 0, 0), 
        ('IDX_performance_counter_instances1', 'counter_name', 0, 0), 
        ('IDX_performance_counter_instances1', 'instance_name', 1, 0);
    GO

    EXEC #create_or_alter_primary_key_or_index
        @table_schema = 'snapshots', @table_name = 'performance_counter_instances', 
        @object_type = 'INDEX', @constraint_or_index_name = 'IDX_performance_counter_instances1', 
        @ignore_dup_key = 0, @clustered = 0;
    GO

The TRUNCATE is typically not necessary, but is a good practice just in case two 
indexes have the same name. 
*/
IF OBJECT_ID ('tempdb..#create_or_alter_primary_key_or_index') IS NOT NULL 
BEGIN
    DROP PROC #create_or_alter_primary_key_or_index 
END;
GO
CREATE PROC #create_or_alter_primary_key_or_index 
    @table_schema sysname, 
    @table_name sysname, 
    @object_type sysname, 
    @constraint_or_index_name sysname, 
    @ignore_dup_key bit = 0, 
    @clustered bit = 1
AS
BEGIN
    RAISERROR (N'Validating %s [%s] on table [%s].[%s]...', 0, 1, 
        @object_type, @constraint_or_index_name, @table_schema, @table_name) WITH NOWAIT;

    -- Get the list of key columns and included columns that are supposed to be in 
    -- this index/PK constraint
    DECLARE @column_name sysname;
    DECLARE @is_included_column bit;
    DECLARE @is_descending_key bit;
    DECLARE @key_column_list nvarchar(max);
    DECLARE @include_column_list nvarchar(max);
    DECLARE @sql nvarchar(max);
    DECLARE @expected_column_count int;
    SET @key_column_list = '';
    SET @include_column_list = '';
    SET @expected_column_count = 0;
    DECLARE cols INSENSITIVE CURSOR FOR 
    SELECT column_name, is_included_column, is_descending_key
    FROM #index_key_columns
    WHERE constraint_name = @constraint_or_index_name
    ORDER BY key_ordinal ASC;
    
    OPEN cols;
    FETCH NEXT FROM cols INTO @column_name, @is_included_column, @is_descending_key;

    WHILE (@@FETCH_STATUS = 0)
    BEGIN
        IF (@is_included_column = 1)
        BEGIN
            SET @include_column_list = @include_column_list 
                + CASE WHEN LEN (@include_column_list) > 0 THEN ', ' ELSE '' END 
                + QUOTENAME (@column_name)
            IF (@object_type = 'PRIMARY KEY')
            BEGIN
                RAISERROR ('Error in script -- INCLUDEd columns are not allowed in a primary key', 21, 1);
            END
        END
        ELSE BEGIN
            SET @key_column_list = @key_column_list 
                + CASE WHEN LEN (@key_column_list) > 0 THEN ', ' ELSE '' END 
                + QUOTENAME (@column_name)
                + CASE @is_descending_key WHEN 1 THEN ' DESC' ELSE ' ASC' END;
        END;
        SET @expected_column_count = @expected_column_count + 1;
        
        FETCH NEXT FROM cols INTO @column_name, @is_included_column, @is_descending_key;
    END;
    CLOSE cols;
    DEALLOCATE cols;

    -- Compare the object definition to the expected definition
    DECLARE @unexpected_column_count int;
    DECLARE @total_column_count int;
    DECLARE @total_included_count int;
    DECLARE @out_of_order_key_count int;
    DECLARE @wrong_sort_direction_count int;
    DECLARE @wrong_included_column_count int;
    DECLARE @key_ordinal_base int;
    DECLARE @existing_constraint_or_index_name  sysname;
    DECLARE @current_ignore_dup_key bit;
    DECLARE @current_clustered bit;
    DECLARE @table_object_id int;

    -- Get the target table's object id
    SET @table_object_id = OBJECT_ID (QUOTENAME (@table_schema) + '.' + QUOTENAME (@table_name));

    -- Get the indentity value of the first column in this constraint
    SELECT @key_ordinal_base = MIN (key_ordinal) - 1
    FROM #index_key_columns
    WHERE constraint_name = @constraint_or_index_name;

    -- Check the constraint schema against expected schema, note any differences
    SELECT 
        @total_column_count = COUNT(*), 
        @wrong_included_column_count = SUM (
            CASE 
                WHEN ic.is_included_column != ckc.is_included_column THEN 1
                ELSE 0
            END), 
        @wrong_sort_direction_count = SUM (
            CASE 
                WHEN ic.is_descending_key != ckc.is_descending_key AND ckc.is_included_column = 0 THEN 1
                ELSE 0
            END), 
        @unexpected_column_count = SUM (
            CASE
                -- [#index_key_columns].[column_name] will be NULL for any unexpected columns
                WHEN ckc.column_name IS NULL THEN 1
                ELSE 0
            END), 
        @out_of_order_key_count = SUM (
            CASE 
                WHEN ic.key_ordinal != (ckc.key_ordinal - @key_ordinal_base) AND ckc.is_included_column = 0 THEN 1
                ELSE 0
            END), 
        @existing_constraint_or_index_name = MIN (i.name), 
        @current_ignore_dup_key = MAX (CASE WHEN i.[ignore_dup_key] = 1 THEN 1 ELSE 0 END), 
        @current_clustered = MAX (CASE WHEN i.type_desc = 'CLUSTERED' THEN 1 ELSE 0 END)
    FROM sys.indexes AS i
    INNER JOIN sys.index_columns AS ic ON 
        i.[object_id] = ic.[object_id] AND i.index_id = ic.index_id
    INNER JOIN sys.columns AS c ON 
        ic.[object_id] = c.[object_id] AND c.column_id = ic.column_id
    LEFT OUTER JOIN #index_key_columns AS ckc ON 
        c.name = ckc.column_name 
    WHERE 
        i.[object_id] = @table_object_id AND 
        ckc.constraint_name = @constraint_or_index_name AND 
        -- Match index on expected name unless it's a PK, in which case we'll just look for [is_primary_key]=1
        (i.name = @constraint_or_index_name OR (@object_type = 'PRIMARY KEY' AND i.is_primary_key = 1)) AND 
        i.is_hypothetical = 0;

    -- If the constraint doesn't yet exist, or if it exists but is defined incorrectly, we 
    -- need to create it (and may need to drop some related objects before we create it). 
    IF (@total_column_count != @expected_column_count OR 
        @wrong_included_column_count > 0 OR 
        @wrong_sort_direction_count > 0 OR 
        @unexpected_column_count > 0 OR 
        @out_of_order_key_count > 0 OR 
        @current_ignore_dup_key != @ignore_dup_key OR
        @current_clustered != @clustered)
    BEGIN
        -- If this is a clustered index or clustered primary key, drop any NC indexes. 
        -- The calling script will rebuild them later, and if we don't drop them before we 
        -- drop the existing clustered PK/index, we'll end up wasting time by rebuilding 
        -- the nonclustered indexes twice (first when the clustered index is dropped, then 
        -- again when it gets recreated). 
        IF (@clustered = 1)
        BEGIN
            DECLARE @nc_index_name sysname;

            RAISERROR (N'    Dropping nonclustered indexes before dropping the clustered index...', 0, 1) WITH NOWAIT;

            DECLARE nc_indexes INSENSITIVE CURSOR FOR 
            SELECT i.name AS nc_index_name
            FROM sys.indexes AS i
            WHERE i.type_desc = 'NONCLUSTERED' AND i.is_unique_constraint = 0 AND i.is_hypothetical = 0 
                AND i.is_primary_key = 0 AND i.[object_id] = @table_object_id
            OPEN nc_indexes;
            FETCH NEXT FROM nc_indexes INTO @nc_index_name;

            WHILE (@@FETCH_STATUS = 0)
            BEGIN
                SET @sql = N'DROP INDEX ' + QUOTENAME (@table_schema) + '.' + QUOTENAME (@table_name) 
                    + '.' + QUOTENAME (@nc_index_name) + ';';
                RAISERROR (N'    Dropping nonclustered index: %s', 0, 1, @sql) WITH NOWAIT;
                EXEC (@sql);
                FETCH NEXT FROM nc_indexes INTO @nc_index_name;
            END;
            CLOSE nc_indexes;
            DEALLOCATE nc_indexes;
        END;

        -- If this is a primary key referenced by foreign keys, we have to drop the foreign keys before 
        -- we can drop the PK.  We also have to drop the foreign keys if we are about to drop a clustered 
        -- primary key to "make room" for a clustered non-PK index. 
        IF ((@object_type = 'PRIMARY KEY') OR 
            (@object_type = 'INDEX' AND @clustered = 1 AND 
                EXISTS (SELECT * FROM sys.indexes AS i WHERE i.[object_id] = @table_object_id AND i.is_primary_key = 1 AND i.type_desc = 'CLUSTERED')))
        BEGIN
            DECLARE @fk_constraint_name sysname;
            DECLARE @fk_table_schema sysname;
            DECLARE @fk_table_name sysname;

            DECLARE fk_constraints INSENSITIVE CURSOR FOR 
            SELECT 
                OBJECT_SCHEMA_NAME (fk.parent_object_id) AS fk_table_schema,  
                OBJECT_NAME (fk.parent_object_id) AS fk_table_name,
                fk.name AS fk_constraint_name
            FROM sys.foreign_keys AS fk
            WHERE referenced_object_id = @table_object_id
            OPEN fk_constraints;
            FETCH NEXT FROM fk_constraints INTO @fk_table_schema, @fk_table_name, @fk_constraint_name;

            WHILE (@@FETCH_STATUS = 0)
            BEGIN
                RAISERROR (N'    Dropping foreign key [%s].[%s].[%s] because it references table [%s]...', 0, 1, 
                    @fk_table_schema, @fk_table_name, @fk_constraint_name, @table_name) WITH NOWAIT;
                SET @sql = N'ALTER TABLE ' + QUOTENAME (@fk_table_schema) + '.' + QUOTENAME (@fk_table_name) 
                    + ' DROP CONSTRAINT ' + QUOTENAME (@fk_constraint_name) + ';';
                EXEC (@sql);
                FETCH NEXT FROM fk_constraints INTO @fk_table_schema, @fk_table_name, @fk_constraint_name;
            END;
            CLOSE fk_constraints;
            DEALLOCATE fk_constraints;
        END;

        -- Drop the incorrect constraint, if it exists. 
        IF (@total_column_count > 0)
        BEGIN
            RAISERROR (N'    Incorrect existing definition (current %d vs. expected %d key columns, %d wrong included columns, %d wrong sort direction, %d unexpected columns, %d out-of-order columns)', 0, 1, 
                @total_column_count, @expected_column_count, @wrong_included_column_count, @wrong_sort_direction_count, @unexpected_column_count, @out_of_order_key_count) WITH NOWAIT;
                                
            -- Drop the existing malformed constraint or index so that we can recreate it correctly
            IF @object_type = 'PRIMARY KEY'
            BEGIN
                SET @sql = N'ALTER TABLE ' + QUOTENAME (@table_schema) + '.' + QUOTENAME (@table_name) 
                    + ' DROP CONSTRAINT ' + QUOTENAME (@existing_constraint_or_index_name) + ';';
            END
            ELSE BEGIN
                SET @sql = N'DROP INDEX ' + QUOTENAME (@table_schema) + '.' + QUOTENAME (@table_name) 
                    + '.' + QUOTENAME (@existing_constraint_or_index_name) + ';';
            END;
            RAISERROR (N'    Dropping existing object: %s', 0, 1, @sql) WITH NOWAIT;
            EXEC (@sql);
        END;
        
        -- If we are about to create a clustered PK index but a clustered (non-PK) index exists, 
        -- we must drop the clustered index before we can create the clustered PK (or vice versa). 
        -- Example: Table has a clustered index, and we need to convert an existing non-clustered 
        -- PK into a clustered PK. 
        IF (@clustered = 1)
        BEGIN
            DECLARE @is_primary_key bit;
            SET @existing_constraint_or_index_name = NULL;
            SELECT 
                @existing_constraint_or_index_name = i.name, 
                @is_primary_key = is_primary_key
            FROM sys.indexes AS i
            WHERE i.type_desc = 'CLUSTERED' AND i.is_hypothetical = 0 AND i.[object_id] = @table_object_id
            
            IF (@existing_constraint_or_index_name IS NOT NULL)
            BEGIN
                -- Drop the existing clustered index to make way for our clustered PK 
                -- (or drop the existing clustered PK to make way for our clustered index)
                IF (@is_primary_key = 1)
                BEGIN
                    SET @sql = N'ALTER TABLE ' + QUOTENAME (@table_schema) + '.' + QUOTENAME (@table_name) 
                        + ' DROP CONSTRAINT ' + QUOTENAME (@existing_constraint_or_index_name) + ';';
                END
                ELSE BEGIN
                    SET @sql = N'DROP INDEX ' + QUOTENAME (@table_schema) + '.' + QUOTENAME (@table_name) 
                        + '.' + QUOTENAME (@existing_constraint_or_index_name) + ';';
                END;
                RAISERROR (N'    Dropping existing clustered index: %s', 0, 1, @sql) WITH NOWAIT;
                EXEC (@sql);
            END;
        END;

        -- Finally, create the PK or index
        IF @object_type = 'PRIMARY KEY'
        BEGIN
            SET @sql = N'ALTER TABLE ' + QUOTENAME (@table_schema) + '.' + QUOTENAME (@table_name) 
                + ' ADD CONSTRAINT ' + QUOTENAME (@constraint_or_index_name) + ' PRIMARY KEY ' 
                + CASE @clustered WHEN 1 THEN 'CLUSTERED' ELSE 'NONCLUSTERED' END 
                + ' (' + @key_column_list + ')'
                + CASE @ignore_dup_key WHEN 1 THEN ' WITH (IGNORE_DUP_KEY=ON)' ELSE '' END 
                + ';';
        END
        ELSE BEGIN
            SET @sql = N'CREATE ' + CASE @clustered WHEN 1 THEN 'CLUSTERED' ELSE 'NONCLUSTERED' END 
                + ' INDEX ' + QUOTENAME (@constraint_or_index_name) + ' ON ' 
                + QUOTENAME (@table_schema) + '.' + QUOTENAME (@table_name) 
                + ' (' + @key_column_list + ')'
                + CASE WHEN LEN (@include_column_list) > 0 THEN ' INCLUDE (' + @include_column_list + ') ' ELSE '' END 
                + CASE @ignore_dup_key WHEN 1 THEN ' WITH (IGNORE_DUP_KEY=ON)' ELSE '' END 
                + ';';
        END;
        RAISERROR (N'    Creating new object: %s', 0, 1, @sql) WITH NOWAIT;
        EXEC (@sql);
    END;
END;
GO

-- Create the temp table used to pass column lists to helper proc [#create_or_alter_primary_key_or_index]
IF OBJECT_ID ('tempdb..#index_key_columns') IS NOT NULL
BEGIN
    DROP TABLE #index_key_columns;
END;
GO
CREATE TABLE #index_key_columns (
    key_ordinal         int IDENTITY, 
    constraint_name     sysname COLLATE CATALOG_DEFAULT, 
    column_name         sysname COLLATE CATALOG_DEFAULT, 
    is_included_column  bit, 
    is_descending_key   bit
);
GO


-- Start a transaction
BEGIN TRANSACTION InstMdwSql
GO


/**********************************************************************/
/* UPGRADE SECTION - UPDATE EXISTING OBJECTS                          */
/**********************************************************************/

--
-- >>> CTP5 -> CTP6 Upgrade
--

-- Update notable_query_plan
IF (OBJECT_ID(N'snapshots.notable_query_plan', 'U') IS NOT NULL)
BEGIN
    RAISERROR ('Updating table [snapshots].[notable_query_plan]...', 0, 1) WITH NOWAIT;

    -- CTP6 added the [plan_generation_num] column to this table
    IF NOT EXISTS (SELECT column_id FROM sys.all_columns c WHERE c.name = N'plan_generation_num' AND c.object_id = OBJECT_ID(N'snapshots.notable_query_plan', 'U'))
    BEGIN
        ALTER TABLE [snapshots].[notable_query_plan]
            ADD [plan_generation_num] bigint DEFAULT 0 NOT NULL;
    END;
END;
GO

-- Update active_sessions_and_requests
-- Add a column
IF (OBJECT_ID(N'snapshots.active_sessions_and_requests', 'U') IS NOT NULL)
BEGIN
    RAISERROR ('Updating table [snapshots].[active_sessions_and_requests]...', 0, 1) WITH NOWAIT;

    IF NOT EXISTS (SELECT column_id FROM sys.all_columns c WHERE c.name = N'is_blocking' AND c.object_id = OBJECT_ID(N'snapshots.active_sessions_and_requests', 'U'))
    BEGIN
        ALTER TABLE [snapshots].[active_sessions_and_requests] 
            ADD [is_blocking] bit DEFAULT 0 NOT NULL
    END;

    -- Alter column length for [command] as 32; column : [command] sys.dm_exec_requests in SQL 11 is of type nvarchar(32)
    IF EXISTS (SELECT c.system_type_id FROM sys.columns c WHERE c.object_id = OBJECT_ID('snapshots.active_sessions_and_requests', 'U') AND c.name = N'command')
    BEGIN
        RAISERROR ('Updating [command] column length to 32...', 0, 1) WITH NOWAIT;
        
        ALTER TABLE  [snapshots].[active_sessions_and_requests] 
            ALTER COLUMN [command] nvarchar(32) NULL;
    END;
	
	-- Alter column length for [host_name] as 128; column : [host_name] sys.dm_exec_requests in SQL 11 is of type nvarchar(128)
    IF EXISTS (SELECT c.system_type_id FROM sys.columns c WHERE c.object_id = OBJECT_ID('snapshots.active_sessions_and_requests', 'U') 
				AND c.name = N'host_name' AND c.max_length < 128)
    BEGIN
        RAISERROR ('Updating [host_name] column length to 128...', 0, 1) WITH NOWAIT;
        
        ALTER TABLE  [snapshots].[active_sessions_and_requests] 
            ALTER COLUMN [host_name] nvarchar(128) NOT NULL;
    END;

	-- Alter column length for [program_name] as 128; column : [program_name] sys.dm_exec_requests in SQL 11 is of type nvarchar(128)
    IF EXISTS (SELECT c.system_type_id FROM sys.columns c WHERE c.object_id = OBJECT_ID('snapshots.active_sessions_and_requests', 'U') 
				AND c.name = N'program_name' AND c.max_length < 128)
    BEGIN
        RAISERROR ('Updating [program_name] column length to 128...', 0, 1) WITH NOWAIT;
        
        ALTER TABLE  [snapshots].[active_sessions_and_requests] 
            ALTER COLUMN [program_name] nvarchar(128) NOT NULL;
    END;
	
END;
GO


-- Update performance_counter_instances
-- Add Unique constraint for [path] column
-- This constraint creation generates a warning. We will deal with the warning when fix for Defect# 130259 is provided
IF (OBJECT_ID(N'snapshots.performance_counter_instances', 'U') IS NOT NULL)
BEGIN
    RAISERROR ('Updating table [snapshots].[performance_counter_instances]...', 0, 1) WITH NOWAIT;
    
    IF NOT EXISTS (SELECT index_id FROM sys.indexes WHERE object_id = OBJECT_ID('snapshots.performance_counter_instances', 'U') AND name = N'UN_performance_counter_path')
    BEGIN
        ALTER TABLE [snapshots].[performance_counter_instances] 
            ADD CONSTRAINT [UN_performance_counter_path] UNIQUE
            (
                [path]
            ) WITH (IGNORE_DUP_KEY = ON)
            ON [PRIMARY];
    END;
END;
GO

-- Update performance_counter_instances
IF (OBJECT_ID(N'snapshots.performance_counter_values', 'U') IS NOT NULL)
BEGIN
    RAISERROR ('Updating table [snapshots].[performance_counter_values]...', 0, 1) WITH NOWAIT;

    IF EXISTS (SELECT c.system_type_id FROM sys.columns c WHERE c.object_id = OBJECT_ID('snapshots.performance_counter_values', 'U') AND c.name = N'formatted_value' AND c.system_type_id = 127)
    BEGIN
        RAISERROR ('Changing [formatted_value] data type to float...', 0, 1) WITH NOWAIT;
        
        -- This index will be recreated later (after the table definition)
        IF EXISTS (SELECT * FROM sys.indexes AS i WHERE i.name = 'IDX_performance_counter_values1' AND [object_id] = OBJECT_ID ('snapshots.performance_counter_values'))
        BEGIN
            DROP INDEX [IDX_performance_counter_values1] ON [snapshots].[performance_counter_values];
        END;
       
        ALTER TABLE [snapshots].[performance_counter_values]
            ALTER COLUMN [formatted_value] float NOT NULL;
    END;
END;
GO

-- Change int log_id columns to bigint 
IF EXISTS (
    SELECT * 
    FROM sys.columns AS c
    INNER JOIN sys.types AS t ON c.system_type_id = t.system_type_id
    WHERE [object_id] = OBJECT_ID ('core.snapshots_internal')
        AND c.name = 'log_id' AND t.name = 'int'
    )
BEGIN
    RAISERROR ('Changing [core].[snapshots_internal].[log_id] column datatype from int to bigint...', 0, 1) WITH NOWAIT;
    ALTER TABLE [core].[snapshots_internal] ALTER COLUMN [log_id] bigint NOT NULL;
END;
GO
IF (OBJECT_ID ('core.snapshots') IS NOT NULL AND OBJECT_ID ('core.snapshots_internal') IS NOT NULL)
BEGIN
    -- Refresh the view to ensure that it reflects the datatype change
    EXEC sp_refreshview 'core.snapshots'
END
GO

--
-- >>> CTP6 -> CTP6 Refresh/RC0 Upgrade
--
-- Our query stats data collection query merges query stats from sys.dm_exec_query_stats (completed query stats) 
-- and sys.dm_exec_requests (in-progress query stats).  We may not have access to all query stats for any queries 
-- that were only visible as in-progress queries in dm_exec_requests.  For example, this DMV doesn't expose CLR 
-- stats. Some of the columns in our query_stats table must therefore tolerate NULLs. 
IF EXISTS (
    SELECT c.* 
    FROM INFORMATION_SCHEMA.TABLES AS t
    INNER JOIN INFORMATION_SCHEMA.COLUMNS AS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME 
    WHERE t.TABLE_SCHEMA = 'snapshots' AND t.TABLE_NAME = 'query_stats'
        AND c.COLUMN_NAME = 'snapshot_clr_time' AND c.IS_NULLABLE = 'NO'
)
BEGIN
    RAISERROR ('Making [snapshots].[query_stats] columns NULLable...', 0, 1) WITH NOWAIT;
    ALTER TABLE snapshots.query_stats ALTER COLUMN min_clr_time bigint NULL;
    ALTER TABLE snapshots.query_stats ALTER COLUMN max_clr_time bigint NULL;
    ALTER TABLE snapshots.query_stats ALTER COLUMN total_clr_time bigint NULL;
    ALTER TABLE snapshots.query_stats ALTER COLUMN snapshot_clr_time bigint NULL;
    ALTER TABLE snapshots.query_stats ALTER COLUMN min_worker_time bigint NULL;
    ALTER TABLE snapshots.query_stats ALTER COLUMN min_physical_reads bigint NULL;
    ALTER TABLE snapshots.query_stats ALTER COLUMN min_logical_writes bigint NULL;
    ALTER TABLE snapshots.query_stats ALTER COLUMN min_logical_reads bigint NULL;
    ALTER TABLE snapshots.query_stats ALTER COLUMN min_elapsed_time bigint NULL;
END;
GO

-- Add the [snapshot_execution_count] column (new to CTP6 Refresh) to [query_stats]
IF OBJECT_ID ('snapshots.query_stats', 'U') IS NOT NULL AND NOT EXISTS (
    SELECT c.* 
    FROM INFORMATION_SCHEMA.TABLES AS t
    INNER JOIN INFORMATION_SCHEMA.COLUMNS AS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME 
    WHERE t.TABLE_SCHEMA = 'snapshots' AND t.TABLE_NAME = 'query_stats'
        AND c.COLUMN_NAME = 'snapshot_execution_count'
)
BEGIN
    RAISERROR ('Adding [snapshot_execution_count] column to [snapshots].[query_stats]...', 0, 1) WITH NOWAIT;
    ALTER TABLE snapshots.query_stats ADD [snapshot_execution_count] bigint NULL;
END;
GO

/**********************************************************************/
/* CORE SCHEMA                                                        */
/**********************************************************************/
RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Create schema core...', 0, 1)  WITH NOWAIT;
GO
IF (SCHEMA_ID('core') IS NULL)
BEGIN
    DECLARE @sql nvarchar(128)
    SET @sql = 'CREATE SCHEMA core'
    EXEC sp_executesql @sql
END
GO

-- SUPPORTED_COLLECTOR_TYPES
--
RAISERROR('', 0, 1)  WITH NOWAIT;
GO
IF (OBJECT_ID(N'[core].[supported_collector_types_internal]', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [core].[supported_collector_types_internal]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [core].[supported_collector_types_internal] (
        collector_type_uid            uniqueidentifier NOT NULL,
    ) ON [PRIMARY]

END
GO

-- supported_collector_types_internal.PK_supported_collector_types_internal
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_supported_collector_types_internal', 'collector_type_uid', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'core', @table_name = 'supported_collector_types_internal', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_supported_collector_types_internal', 
    @ignore_dup_key = 0, @clustered = 1;
GO


IF (NOT OBJECT_ID(N'core.supported_collector_types', 'V') IS NULL)
BEGIN
    RAISERROR('Dropping view [core].[supported_collector_types]...', 0, 1)  WITH NOWAIT;
    DROP VIEW core.supported_collector_types
END
GO

RAISERROR('Creating view [core].[supported_collector_types]...', 0, 1)  WITH NOWAIT;
GO
CREATE VIEW core.supported_collector_types
AS 
    SELECT collector_type_uid
    FROM core.supported_collector_types_internal
GO

-- SOURCE_INFO
--
IF (OBJECT_ID(N'[core].[source_info_internal]', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [core].[source_info_internal]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [core].[source_info_internal] (
        source_id                   int IDENTITY NOT NULL,
        collection_set_uid          uniqueidentifier NOT NULL,  -- GUID of the collection set that loads the data
        instance_name               sysname COLLATE Latin1_General_CI_AI NOT NULL, -- the name of the machine the data is uploaded from
        days_until_expiration       smallint NOT NULL,          -- how many days data from this source should be kept in the warehouse. 0 indicates forever
        operator                    sysname NOT NULL,           -- login name of the principal who is uploading the data
        
        CONSTRAINT [UQ_collection_set_uid_instance_name] UNIQUE (collection_set_uid, instance_name, operator)
    ) ON [PRIMARY]
END
GO

-- source_info_internal.PK_source_info_internal
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_source_info_internal', 'source_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'core', @table_name = 'source_info_internal', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_source_info_internal', 
    @ignore_dup_key = 0, @clustered = 1;
GO


-- SNAPSHOT_TIMETABLE
--
IF (OBJECT_ID(N'[core].[snapshot_timetable_internal]', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [core].[snapshot_timetable_internal]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [core].[snapshot_timetable_internal] (
        snapshot_time_id            int IDENTITY NOT NULL,
        snapshot_time                datetimeoffset(7) NOT NULL,
            ) ON [PRIMARY]
END
GO

-- snapshot_timetable_internal.PK_snapshots_timetable_internal
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_snapshots_timetable_internal', 'snapshot_time_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'core', @table_name = 'snapshot_timetable_internal', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_snapshots_timetable_internal', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- snapshot_timetable_internal.IDX_snapshot_time
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_snapshot_time', 'snapshot_time', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'core', @table_name = 'snapshot_timetable_internal', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_snapshot_time', 
    @ignore_dup_key = 0, @clustered = 0;
GO


-- SNAPSHOTS
--
IF (OBJECT_ID(N'[core].[snapshots_internal]', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [core].[snapshots_internal]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [core].[snapshots_internal] (
        snapshot_id                    int IDENTITY NOT NULL,
        snapshot_time_id               int NOT NULL,
        source_id                      int NOT NULL,
        log_id                         bigint NOT NULL,             -- reference to the log table
    ) ON [PRIMARY]

    CREATE STATISTICS [STAT_snapshots_internal2] ON [core].[snapshots_internal](
        [snapshot_time_id], 
        [source_id]
    )

    CREATE STATISTICS [STAT_snapshots_internal3] ON [core].[snapshots_internal](
        [snapshot_time_id], [snapshot_id], [source_id])

END
GO

-- snapshots_internal.PK_snapshots_internal
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_snapshots_internal', 'snapshot_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'core', @table_name = 'snapshots_internal', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_snapshots_internal', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- snapshots_internal.IDX_snapshot_time_id
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_snapshot_time_id', 'snapshot_time_id', 0, 0), 
    ('IDX_snapshot_time_id', 'source_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'core', @table_name = 'snapshots_internal', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_snapshot_time_id', 
    @ignore_dup_key = 0, @clustered = 0;
GO

-- snapshots_internal.FK_snapshots_source_info
IF OBJECT_ID ('core.FK_snapshots_source_info', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_snapshots_source_info] on core.snapshots_internal ...', 0, 1) WITH NOWAIT;
    ALTER TABLE core.snapshots_internal
        ADD CONSTRAINT [FK_snapshots_source_info] FOREIGN KEY(source_id)
        REFERENCES core.source_info_internal (source_id)
END;
GO

-- snapshots_internal.FK_snapshots_snapshots_timetable
IF OBJECT_ID ('core.FK_snapshots_snapshots_timetable', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_snapshots_snapshots_timetable] on core.snapshots_internal ...', 0, 1) WITH NOWAIT;
    ALTER TABLE core.snapshots_internal
        ADD CONSTRAINT [FK_snapshots_snapshots_timetable] FOREIGN KEY(snapshot_time_id)
        REFERENCES core.snapshot_timetable_internal (snapshot_time_id)
END;
GO


-- SNAPSHOTS VIEW
--
IF (NOT OBJECT_ID(N'core.snapshots', 'V') IS NULL)
BEGIN
    RAISERROR('Dropping view [core].[snapshots]...', 0, 1)  WITH NOWAIT;
    DROP VIEW core.snapshots
END
GO

RAISERROR('Creating view [core].[snapshots]...', 0, 1)  WITH NOWAIT;
GO
CREATE VIEW core.snapshots
AS 
    SELECT 
        s.source_id,
        s.snapshot_id, 
        s.snapshot_time_id,
        t.snapshot_time, 
        CASE src.days_until_expiration
            WHEN 0 THEN NULL
            ELSE DATEADD(DAY, src.days_until_expiration, t.snapshot_time)
        END AS valid_through,
        src.instance_name, 
        src.collection_set_uid, 
        src.operator,
        s.log_id
    FROM core.source_info_internal src, core.snapshots_internal s, core.snapshot_timetable_internal t
    WHERE src.source_id = s.source_id AND s.snapshot_time_id = t.snapshot_time_id
GO

--
-- This stored proc creates a snapshot entry and return the id
--
IF (NOT OBJECT_ID(N'core.sp_create_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [core].[sp_create_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [core].[sp_create_snapshot]
END
GO 

RAISERROR('Creating procedure [core].[sp_create_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE core.sp_create_snapshot
    @collection_set_uid     uniqueidentifier,
    @collector_type_uid     uniqueidentifier,
    @machine_name           sysname,
    @named_instance         sysname,
    @log_id                 bigint,
    @snapshot_id            int OUTPUT
AS 
BEGIN
    SET NOCOUNT ON
    SET TRANSACTION ISOLATION LEVEL SERIALIZABLE

    -- Security check (role membership)
    IF (NOT (ISNULL(IS_MEMBER(N'mdw_writer'), 0) = 1) AND NOT (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) = 1))
    BEGIN
        RAISERROR(14677, 16, -1, 'mdw_writer')
        RETURN(1) -- Failure
    END
    
    DECLARE @operator sysname;
    SELECT @operator = SUSER_SNAME();

    DECLARE @instance_name sysname
    SET @named_instance = NULLIF(RTRIM(LTRIM(@named_instance)), N'')
    IF (@named_instance = 'MSSQLSERVER')
        SET @instance_name = @machine_name
    ELSE
        SET @instance_name = @machine_name + N'\' + @named_instance

    -- Parameters check
    -- Find the source_id that matches the requested collection set and operator
    DECLARE @source_id  int
    SET @source_id = (SELECT source_id 
                        FROM core.source_info_internal
                        WHERE collection_set_uid = @collection_set_uid 
                          AND operator = @operator
                          AND instance_name = @instance_name)

    IF(@source_id IS NULL)
    BEGIN
        DECLARE @collection_set_uid_as_char NVARCHAR(36)
        SELECT @collection_set_uid_as_char = CONVERT(NVARCHAR(36), @collection_set_uid)
        RAISERROR(14679, -1, -1, N'@collection_set_uid', @collection_set_uid_as_char)
    END

    -- Make sure the collector_type is registered in this warehouse
    IF NOT EXISTS (SELECT collector_type_uid FROM core.supported_collector_types WHERE collector_type_uid = @collector_type_uid)
    BEGIN
        DECLARE @collector_type_uid_as_char NVARCHAR(36)
        SELECT @collector_type_uid_as_char = CONVERT(NVARCHAR(36), @collector_type_uid)
        RAISERROR(14679, -1, -1, N'@collector_type_uid', @collector_type_uid_as_char)
    END

    -- Get the snapshot time
    BEGIN TRY
        BEGIN TRAN
        DECLARE @snapshot_time_id int

        IF NOT EXISTS (SELECT snapshot_time_id FROM core.snapshot_timetable_internal WITH(UPDLOCK) WHERE snapshot_time > DATEADD (minute, -1, SYSDATETIMEOFFSET()))
        BEGIN
            INSERT INTO core.snapshot_timetable_internal
            (
                snapshot_time
            )
            VALUES
            (
                SYSDATETIMEOFFSET()
            )
            SET @snapshot_time_id = SCOPE_IDENTITY()
        END
        ELSE
        BEGIN
            SET @snapshot_time_id = (SELECT MAX(snapshot_time_id) FROM core.snapshot_timetable_internal)
        END

        -- Finally insert an entry into snapshots table
        INSERT INTO core.snapshots_internal
        (
            snapshot_time_id,
            source_id,
            log_id
        )
        VALUES
        (
            @snapshot_time_id,
            @source_id,
            @log_id
        )
        SET @snapshot_id = SCOPE_IDENTITY()

        IF (@snapshot_id IS NULL)
        BEGIN
            RAISERROR(14262, -1, -1, '@snapshot_id', @snapshot_id)
            RETURN(1)
        END
        ELSE
        BEGIN
            COMMIT TRAN
        END
    END TRY
    BEGIN CATCH
        IF (@@TRANCOUNT > 0) 
            ROLLBACK TRANSACTION

        -- Rethrow the error
        DECLARE @ErrorMessage   NVARCHAR(4000);
        DECLARE @ErrorSeverity  INT;
        DECLARE @ErrorState     INT;
        DECLARE @ErrorNumber    INT;
        DECLARE @ErrorLine      INT;
        DECLARE @ErrorProcedure NVARCHAR(200);
        SELECT @ErrorLine = ERROR_LINE(),
               @ErrorSeverity = ERROR_SEVERITY(),
               @ErrorState = ERROR_STATE(),
               @ErrorNumber = ERROR_NUMBER(),
               @ErrorMessage = ERROR_MESSAGE(),
               @ErrorProcedure = ISNULL(ERROR_PROCEDURE(), '-');

        RAISERROR (14684, -1, -1 , @ErrorNumber, @ErrorSeverity, @ErrorState, @ErrorProcedure, @ErrorLine, @ErrorMessage);
    END CATCH

END
GO

--
-- This stored proc updates data in source_info table 
--
IF (NOT OBJECT_ID(N'core.sp_update_data_source', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [core].[sp_update_data_source] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [core].[sp_update_data_source]
END
GO 

RAISERROR('Creating procedure [core].[sp_update_data_source] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [core].[sp_update_data_source]
    @collection_set_uid     uniqueidentifier,
    @machine_name           sysname,
    @named_instance         sysname,
    @days_until_expiration  smallint,
    @source_id              int OUTPUT
AS
BEGIN
    SET NOCOUNT ON
    SET TRANSACTION ISOLATION LEVEL SERIALIZABLE

    -- Security check (role membership)
    IF (NOT (ISNULL(IS_MEMBER(N'mdw_writer'), 0) = 1) AND NOT (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) = 1))
    BEGIN
        RAISERROR(14677, 16, -1, 'mdw_writer')
        RETURN(1) -- Failure
    END

    -- Parameters check
    IF (@collection_set_uid IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@collection_set_uid')
        RETURN(1) -- Failure
    END

    SET @machine_name = NULLIF(RTRIM(LTRIM(@machine_name)), N'')
    IF (@machine_name IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@machine_name')
        RETURN(1) -- Failure
    END

    DECLARE @instance_name sysname
    SET @named_instance = NULLIF(RTRIM(LTRIM(@named_instance)), N'')
    IF (@named_instance = 'MSSQLSERVER')
        SET @instance_name = @machine_name
    ELSE
        SET @instance_name = @machine_name + N'\' + @named_instance

    IF (@days_until_expiration IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@days_until_expiration')
        RETURN(1) -- Failure
    END

    IF (@days_until_expiration < 0)
    BEGIN
        RAISERROR(14266, -1, -1, '@days_until_expiration', ' >= 0')
        RETURN (1) -- Failure
    END
    
    DECLARE @operator sysname
    SELECT @operator = SUSER_SNAME()

    BEGIN TRY
        BEGIN TRAN
        
        -- Insert data into the table
        -- We specify the lock hint, in order to keep the exlusive lock on the row from the moment we select it till we 
        -- update it
        SET @source_id = (SELECT source_id FROM core.source_info_internal WITH(UPDLOCK) WHERE collection_set_uid = @collection_set_uid AND instance_name = @instance_name AND operator = @operator)
        IF @source_id IS NULL
        BEGIN
            INSERT INTO core.source_info_internal
            (
                collection_set_uid,
                instance_name,
                days_until_expiration,
                operator
            )
            VALUES
            (
                @collection_set_uid,
                @instance_name,
                @days_until_expiration,
                @operator
            )
            SET @source_id = SCOPE_IDENTITY()
        END
        ELSE
        BEGIN
            UPDATE core.source_info_internal
            SET 
                days_until_expiration = @days_until_expiration
            WHERE source_id = @source_id;
        END
            
        COMMIT TRAN
        RETURN (0)
    END TRY
    BEGIN CATCH
        IF (@@TRANCOUNT > 0) 
            ROLLBACK TRANSACTION

        -- Rethrow the error
        DECLARE @ErrorMessage   NVARCHAR(4000);
        DECLARE @ErrorSeverity  INT;
        DECLARE @ErrorState     INT;
        DECLARE @ErrorNumber    INT;
        DECLARE @ErrorLine      INT;
        DECLARE @ErrorProcedure NVARCHAR(200);
        SELECT @ErrorLine = ERROR_LINE(),
               @ErrorSeverity = ERROR_SEVERITY(),
               @ErrorState = ERROR_STATE(),
               @ErrorNumber = ERROR_NUMBER(),
               @ErrorMessage = ERROR_MESSAGE(),
               @ErrorProcedure = ISNULL(ERROR_PROCEDURE(), '-');

        RAISERROR (14684, -1, -1 , @ErrorNumber, @ErrorSeverity, @ErrorState, @ErrorProcedure, @ErrorLine, @ErrorMessage);
        RETURN (1)
    END CATCH
END
GO


--
-- This stored proc adds new entry in supported_collector_types table
--
IF (NOT OBJECT_ID(N'core.sp_add_collector_type', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [core].[sp_add_collector_type] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [core].[sp_add_collector_type]
END
GO 

RAISERROR('Creating procedure [core].[sp_add_collector_type] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [core].[sp_add_collector_type]
    @collector_type_uid     uniqueidentifier
AS
BEGIN
    -- Security check (role membership)
    IF (NOT (ISNULL(IS_MEMBER(N'mdw_admin'), 0) = 1) AND NOT (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) = 1))
    BEGIN
        RAISERROR(14677, 16, -1, 'mdw_admin')
        RETURN(1) -- Failure
    END

    -- Parameters check
    IF (@collector_type_uid IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@collector_type_uid')
        RETURN(1) -- Failure
    END

    -- Insert new collector type
    IF NOT EXISTS (SELECT collector_type_uid FROM core.supported_collector_types WHERE collector_type_uid = @collector_type_uid)
    BEGIN
        INSERT INTO core.supported_collector_types
        (
            collector_type_uid
        )
        VALUES
        (
            @collector_type_uid
        )
    END
    ELSE
    BEGIN
        -- Raise an info message, but do not fail
        DECLARE @collector_type_uid_as_char NVARCHAR(36)
        SELECT @collector_type_uid_as_char = CONVERT(NVARCHAR(36), @collector_type_uid)
        RAISERROR(14261, 10, -1, '@collector_type_uid', @collector_type_uid_as_char)
    END

    RETURN (0)
END
GO

--
-- This stored proc removes and existing entry from supported_collector_types table
--
IF (NOT OBJECT_ID(N'core.sp_remove_collector_type', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [core].[sp_remove_collector_type] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [core].[sp_remove_collector_type]
END
GO 

RAISERROR('Creating procedure [core].[sp_remove_collector_type] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [core].[sp_remove_collector_type]
    @collector_type_uid     uniqueidentifier
AS
BEGIN
    -- Security check (role membership)
    IF (NOT (ISNULL(IS_MEMBER(N'mdw_admin'), 0) = 1) AND NOT (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) = 1))
    BEGIN
        RAISERROR(14677, 16, -1, 'mdw_admin')
        RETURN(1) -- Failure
    END

    -- Parameters check
    IF (@collector_type_uid IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@collector_type_uid')
        RETURN(1) -- Failure
    END

    -- Delete collector type
    IF EXISTS (SELECT collector_type_uid FROM core.supported_collector_types WHERE collector_type_uid = @collector_type_uid)
    BEGIN
        DELETE FROM core.supported_collector_types WHERE collector_type_uid = @collector_type_uid
    END
    ELSE
    BEGIN
        DECLARE @collector_type_uid_as_char NVARCHAR(36)
        SELECT @collector_type_uid_as_char = CONVERT(NVARCHAR(36), @collector_type_uid)
        RAISERROR(14262, -1, -1, '@collector_type_uid', @collector_type_uid_as_char)
        RETURN (1) -- Failure
    END

    RETURN (0)
END
GO

--
-- This table is used to determine status of current purge operation.
-- Contains records only if a sp_stop_purge operation was requested.
--
RAISERROR('', 0, 1)  WITH NOWAIT;
GO
IF (OBJECT_ID(N'[core].[purge_info_internal]', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [core].[purge_info_internal]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [core].[purge_info_internal] (
      stop_purge bit NOT NULL,
    ) ON [PRIMARY]

END
GO


--
-- This stored proc removes orphaned notable_query_plan data from the warehouse 
--
IF (NOT OBJECT_ID(N'core.sp_purge_orphaned_notable_query_plan', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [core].[sp_purge_orphaned_notable_query_plan] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [core].[sp_purge_orphaned_notable_query_plan]
END
GO 

RAISERROR('Creating procedure [core].[sp_purge_orphaned_notable_query_plan] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [core].[sp_purge_orphaned_notable_query_plan]
    @duration smallint = NULL,
    @end_time datetime = NULL,
    @delete_batch_size int = 500
AS
BEGIN
    PRINT 'Begin purging orphaned records in snapshots.notable_query_plan Current UTC Time:' + CONVERT(VARCHAR, GETUTCDATE())

    DECLARE @stop_purge int

    -- Delete orphaned rows from snapshots.notable_query_plan.  Query plans are not deleted by the generic purge 
    -- process that deletes other data (above) because query plan rows are not tied to a particular snapshot ID. 
    -- Purging query plans table  as a special case, by looking for plans that 
    -- are no longer referenced by any of the rows in the snapshots.query_stats table.  We need to delete these 
    -- rows in small chunks, since deleting many GB in a single delete statement would cause lock escalation and 
    -- an explosion in the size of the transaction log (individual query plans can be 10-50MB).  
    DECLARE @rows_affected int;
    -- set expected rows affected as delete batch size
    SET @rows_affected = @delete_batch_size;
    
    -- select set of orphaned query plans to be deleted into a temp table 
    SELECT qp.[sql_handle],
        qp.plan_handle,
        qp.plan_generation_num,
        qp.statement_start_offset,
        qp.statement_end_offset,
        qp.creation_time
    INTO #tmp_notable_query_plan
    FROM snapshots.notable_query_plan AS qp 
    WHERE NOT EXISTS (
        SELECT snapshot_id 
        FROM snapshots.query_stats AS qs
        WHERE qs.[sql_handle] = qp.[sql_handle] AND qs.plan_handle = qp.plan_handle 
            AND qs.plan_generation_num = qp.plan_generation_num 
            AND qs.statement_start_offset = qp.statement_start_offset 
            AND qs.statement_end_offset = qp.statement_end_offset 
            AND qs.creation_time = qp.creation_time)

    WHILE (@rows_affected = @delete_batch_size)
    BEGIN
        -- Deleting TOP N orphaned rows in query plan table by joining info from temp table variable
        -- This is done to speed up delete query. 
        DELETE TOP (@delete_batch_size) snapshots.notable_query_plan 
        FROM snapshots.notable_query_plan AS qp , #tmp_notable_query_plan AS tmp
        WHERE tmp.[sql_handle] = qp.[sql_handle] 
            AND tmp.plan_handle = qp.plan_handle 
            AND tmp.plan_generation_num = qp.plan_generation_num 
            AND tmp.statement_start_offset = qp.statement_start_offset 
            AND tmp.statement_end_offset = qp.statement_end_offset 
            AND tmp.creation_time = qp.creation_time
        
        SET @rows_affected = @@ROWCOUNT;
        IF(@rows_affected > 0)
        BEGIN
            RAISERROR ('Deleted %d orphaned rows from snapshots.notable_query_plan', 0, 1, @rows_affected) WITH NOWAIT;
        END

        -- Check if the execution of the stored proc exceeded the @duration specified
        IF (@duration IS NOT NULL)
        BEGIN
            IF (GETUTCDATE()>=@end_time)
            BEGIN
                PRINT 'Stopping purge. More than ' + CONVERT(VARCHAR, @duration) + ' minutes passed since the start of operation.';
                BREAK
            END
        END

        -- Check if somebody wanted to stop the purge operation
        SELECT @stop_purge = COUNT(stop_purge) FROM [core].[purge_info_internal]
        IF (@stop_purge > 0)
        BEGIN
            PRINT 'Stopping purge. Detected a user request to stop purge.';
            BREAK
        END
    END;
    
    PRINT 'End purging orphaned records in snapshots.notable_query_plan Current UTC Time:' + CONVERT(VARCHAR, GETUTCDATE())
END

GO

--
-- This stored proc removes orphaned notable_query_text data from the warehouse 
--
IF (NOT OBJECT_ID(N'core.sp_purge_orphaned_notable_query_text', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [core].[sp_purge_orphaned_notable_query_text] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [core].[sp_purge_orphaned_notable_query_text]
END
GO 

RAISERROR('Creating procedure [core].[sp_purge_orphaned_notable_query_text] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [core].[sp_purge_orphaned_notable_query_text]
    @duration smallint = NULL,
    @end_time datetime = NULL,
    @delete_batch_size int = 500
AS
BEGIN
    PRINT 'Begin purging orphaned records in snapshots.notable_query_text Current UTC Time:' + CONVERT(VARCHAR, GETUTCDATE())

    DECLARE @stop_purge int

    -- Delete orphaned rows from snapshots.notable_query_text.  Query texts are not deleted by the generic purge 
    -- process that deletes other data (above) because query text rows are not tied to a particular snapshot ID. 
    -- Purging  query text table as a special case, by looking for plans that 
    -- are no longer referenced by any of the rows in the snapshots.query_stats table.  We need to delete these 
    -- rows in small chunks, since deleting many GB in a single delete statement would cause lock escalation and 
    -- an explosion in the size of the transaction log (individual query plans can be 10-50MB).  
    DECLARE @rows_affected int;
    -- set expected rows affected as delete batch size
    SET @rows_affected = @delete_batch_size;

    SELECT qtext.[sql_handle] 
    INTO #tmp_notable_query_text
    FROM snapshots.notable_query_text AS qtext
    EXCEPT (
	SELECT qt.[sql_handle] FROM snapshots.notable_query_text AS qt 
	INNER HASH JOIN snapshots.query_stats AS qs 
	ON (qt.sql_handle = qs.sql_handle))

    WHILE (@rows_affected = @delete_batch_size)
    BEGIN
        -- Deleting TOP N orphaned rows in query text table by joining info from temp table
        -- This is done to speed up delete query. 
        DELETE TOP (@delete_batch_size) snapshots.notable_query_text 
         FROM snapshots.notable_query_text AS qt, #tmp_notable_query_text AS tmp
        WHERE tmp.[sql_handle] = qt.[sql_handle]
        
        SET @rows_affected = @@ROWCOUNT;
        IF(@rows_affected > 0)
        BEGIN
            RAISERROR ('Deleted %d orphaned rows from snapshots.notable_query_text', 0, 1, @rows_affected) WITH NOWAIT;
        END

        -- Check if the execution of the stored proc exceeded the @duration specified
        IF (@duration IS NOT NULL)
        BEGIN
            IF (GETUTCDATE()>=@end_time)
            BEGIN
                PRINT 'Stopping purge. More than ' + CONVERT(VARCHAR, @duration) + ' minutes passed since the start of operation.';
                BREAK
            END
        END

        -- Check if somebody wanted to stop the purge operation
        SELECT @stop_purge = COUNT(stop_purge) FROM [core].[purge_info_internal]
        IF (@stop_purge > 0)
        BEGIN
            PRINT 'Stopping purge. Detected a user request to stop purge.';
            BREAK
        END
    END;

    PRINT 'End purging orphaned records in snapshots.notable_query_text Current UTC Time:' + CONVERT(VARCHAR, GETUTCDATE())

END

GO

--
-- This stored proc removes data from the warehouse that reached its expiration date
--
IF (NOT OBJECT_ID(N'core.sp_purge_data', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [core].[sp_purge_data] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [core].[sp_purge_data]
END
GO 

RAISERROR('Creating procedure [core].[sp_purge_data] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [core].[sp_purge_data]
    @retention_days smallint = NULL,
    @instance_name sysname = NULL,
    @collection_set_uid uniqueidentifier = NULL,
    @duration smallint = NULL,
    @delete_batch_size int = 500
AS
BEGIN
    -- Security check (role membership)
    IF (NOT (ISNULL(IS_MEMBER(N'mdw_admin'), 0) = 1) AND NOT (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) = 1))
    BEGIN
        RAISERROR(14677, 16, -1, 'mdw_admin')
        RETURN(1) -- Failure
    END

    -- Validate parameters
    IF ((@retention_days IS NOT NULL) AND (@retention_days < 0))
    BEGIN
        RAISERROR(14200, -1, -1, '@retention_days')
        RETURN(1) -- Failure
    END

    IF ((@duration IS NOT NULL) AND (@duration < 0))
    BEGIN
        RAISERROR(14200, -1, -1, '@duration')
        RETURN(1) -- Failure
    END

    -- This table will contain a record if somebody requests purge to stop
    -- If user requested us to purge data - we reset the content of it - and proceed with purge
    -- If somebody in a different session wants purge operations to stop he adds a record
    -- that we will discover while purge in progress
    --
    -- We dont clear this flag when we exit since multiple purge operations with differnet
    -- filters may proceed, and we want all of them to stop.
    DELETE FROM [core].[purge_info_internal]

    SET @instance_name = NULLIF(LTRIM(RTRIM(@instance_name)), N'')

    -- Calculate the time when the operation should stop (NULL otherwise)
    DECLARE @end_time datetime
    IF (@duration IS NOT NULL)
    BEGIN
        SET @end_time = DATEADD(minute, @duration, GETUTCDATE())
    END

    -- Declare table that will be used to find what are the valid
    -- candidate snapshots that could be selected for purge
    DECLARE @purge_candidates table
    (
        snapshot_id int NOT NULL,
        snapshot_time datetime NOT NULL,
        instance_name sysname NOT NULL,
        collection_set_uid uniqueidentifier NOT NULL
    )

    -- Find candidates that match the retention_days criteria (if specified)
    IF (@retention_days IS NULL)
    BEGIN
        -- User did not specified a value for @retention_days, therfore we
        -- will use the default expiration day as marked in the source info
        INSERT INTO @purge_candidates
        SELECT s.snapshot_id, s.snapshot_time, s.instance_name, s.collection_set_uid
        FROM core.snapshots s
        WHERE (GETUTCDATE() >= s.valid_through)
    END
    ELSE
    BEGIN
        -- User specified a value for @retention_days, we will use this overriden value
        -- when deciding what means old enough to qualify for purge this overrides
        -- the days_until_expiration value specified in the source_info_internal table
        INSERT INTO @purge_candidates
        SELECT s.snapshot_id, s.snapshot_time, s.instance_name, s.collection_set_uid
        FROM core.snapshots s
        WHERE GETUTCDATE() >= DATEADD(DAY, @retention_days, s.snapshot_time)
    END

    -- Determine which is the oldest snapshot, from the list of candidates
    DECLARE oldest_snapshot_cursor CURSOR FORWARD_ONLY READ_ONLY FOR
    SELECT p.snapshot_id, p.instance_name, p.collection_set_uid
    FROM @purge_candidates p
    WHERE 
        ((@instance_name IS NULL) or (p.instance_name = @instance_name)) AND
        ((@collection_set_uid IS NULL) or (p.collection_set_uid = @collection_set_uid))
    ORDER BY p.snapshot_time ASC    

    OPEN oldest_snapshot_cursor

    DECLARE @stop_purge int
    DECLARE @oldest_snapshot_id int
    DECLARE @oldest_instance_name sysname
    DECLARE @oldest_collection_set_uid uniqueidentifier

    FETCH NEXT FROM oldest_snapshot_cursor
    INTO @oldest_snapshot_id, @oldest_instance_name, @oldest_collection_set_uid

    -- As long as there are snapshots that matched the time criteria
    WHILE @@FETCH_STATUS = 0
    BEGIN

        -- Filter out records that do not match the other filter crieria
        IF ((@instance_name IS NULL) or (@oldest_instance_name = @instance_name))
        BEGIN

            -- There was no filter specified for instance_name or the instance matches the filter
            IF ((@collection_set_uid IS NULL) or (@oldest_collection_set_uid = @collection_set_uid))
            BEGIN

                -- There was no filter specified for the collection_set_uid or the collection_set_uid matches the filter
                BEGIN TRANSACTION tran_sp_purge_data

                -- Purge data associated with this snapshot. Note: deleting this snapshot
                -- triggers cascade delete in all warehouse tables based on the foreign key 
                -- relationship to snapshots table

                -- Cascade cleanup of all data related referencing oldest snapshot
                DELETE core.snapshots_internal
                FROM core.snapshots_internal s
                WHERE s.snapshot_id = @oldest_snapshot_id

                COMMIT TRANSACTION tran_sp_purge_data

                PRINT 'Snapshot #' + CONVERT(VARCHAR, @oldest_snapshot_id) + ' purged.';
            END

        END

        -- Check if the execution of the stored proc exceeded the @duration specified
        IF (@duration IS NOT NULL)
        BEGIN
            IF (GETUTCDATE()>=@end_time)
            BEGIN
                PRINT 'Stopping purge. More than ' + CONVERT(VARCHAR, @duration) + ' minutes passed since the start of operation.';
                BREAK
            END
        END

        -- Check if somebody wanted to stop the purge operation
        SELECT @stop_purge = COUNT(stop_purge) FROM [core].[purge_info_internal]
        IF (@stop_purge > 0)
        BEGIN
                PRINT 'Stopping purge. Detected a user request to stop purge.';
            BREAK
        END

        -- Move to next oldest snapshot
        FETCH NEXT FROM oldest_snapshot_cursor
        INTO @oldest_snapshot_id, @oldest_instance_name, @oldest_collection_set_uid

    END

    CLOSE oldest_snapshot_cursor
    DEALLOCATE oldest_snapshot_cursor

    -- delete orphaned query plans
    EXEC [core].[sp_purge_orphaned_notable_query_plan] @duration = @duration, @end_time = @end_time, @delete_batch_size = @delete_batch_size

    -- delete orphaned query text
    EXEC [core].[sp_purge_orphaned_notable_query_text] @duration = @duration, @end_time = @end_time, @delete_batch_size = @delete_batch_size
       
END
GO


--
-- This stored procedure is used to stop all purge operations in progress
--
IF (NOT OBJECT_ID(N'core.sp_stop_purge', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [core].[sp_stop_purge] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [core].[sp_stop_purge]
END
GO 

RAISERROR('Creating procedure [core].[sp_stop_purge] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [core].[sp_stop_purge]
AS
BEGIN
    INSERT INTO [core].[purge_info_internal] (stop_purge) VALUES (1)
END
GO


--
-- This function verifies if the caller matches the operator set for the snapshot 
--
IF (OBJECT_ID(N'core.fn_check_operator', 'FN') IS NULL)
BEGIN
    RAISERROR('Creating function [core].[fn_check_operator] ...', 0, 1)  WITH NOWAIT;
    DECLARE @sql nvarchar(max)
    SET @sql = 
    'CREATE FUNCTION [core].[fn_check_operator](
        @snapshot_id int
    )
    RETURNS bit
    AS
    BEGIN
        DECLARE @retval bit;
        
        DECLARE @operator sysname;
        SELECT @operator=operator FROM core.snapshots WHERE snapshot_id = @snapshot_id;
        IF (@operator = SUSER_SNAME())
            SELECT @retval = 1;
        ELSE
            SELECT @retval = 0;
        RETURN @retval;
    END;'

    EXEC sp_executesql @sql;
END
GO

-- Table wait_categories
--
-- This table contains CPU and wait categories.
--
IF (NOT OBJECT_ID(N'core.wait_types', 'U') IS NULL)
BEGIN
    -- Must drop wait_types first since it references wait_categories via FK
    RAISERROR('Dropping table [core].[wait_types] ...', 0, 1)  WITH NOWAIT;
    DROP TABLE [core].[wait_types]
END

IF (NOT OBJECT_ID(N'core.wait_categories', 'U') IS NULL)
BEGIN
    RAISERROR('Dropping table [core].[wait_categories] ...', 0, 1)  WITH NOWAIT;
    DROP TABLE [core].[wait_categories]
END

RAISERROR('Creating table [core].[wait_categories] ...', 0, 1)  WITH NOWAIT;

CREATE TABLE [core].[wait_categories](
        [category_id] [smallint] NOT NULL,
        [category_name] [nvarchar](20) NOT NULL,
        [ignore] [bit] NOT NULL, 
     CONSTRAINT [PK_categories] PRIMARY KEY CLUSTERED ([category_id] ASC)WITH (IGNORE_DUP_KEY = OFF) ON [PRIMARY]

) ON [PRIMARY]
GO

-- Table wait_types
--
-- This table contains relation between cpu/wait events and cpu/wait categories for each version of SQL Server.
--
--
RAISERROR('Creating table [core].[wait_types] ...', 0, 1)  WITH NOWAIT;

CREATE TABLE [core].[wait_types](
        [category_id] [smallint] NOT NULL,
        [wait_type] [nvarchar](45) NOT NULL,
     CONSTRAINT [PK_events] PRIMARY KEY CLUSTERED ([wait_type] ASC) WITH (IGNORE_DUP_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]

ALTER TABLE [core].[wait_types] ADD CONSTRAINT [FK_events_categories] FOREIGN KEY([category_id])
REFERENCES [core].[wait_categories] ([category_id])
GO


IF (NOT OBJECT_ID(N'core.wait_types_categorized', 'V') IS NULL)
BEGIN
    RAISERROR('Dropping view [core].[wait_types_categorized] ...', 0, 1)  WITH NOWAIT;
    DROP VIEW [core].[wait_types_categorized];
END;
GO

RAISERROR('Creating view [core].[wait_types_categorized] ...', 0, 1)  WITH NOWAIT;
GO
CREATE VIEW [core].[wait_types_categorized]
AS
    SELECT 
        ct.category_name,
        ev.wait_type, 
        ct.category_id, 
        ct.ignore
    FROM core.wait_categories ct
    INNER JOIN core.wait_types ev ON (ev.category_id = ct.category_id)
GO

-- Insert Categories
--
SET NOCOUNT ON;
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (0, N'CPU', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (1, N'Backup', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (2, N'SQLCLR', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (3, N'Parallelism', 1);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (4, N'Latch', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (5, N'Lock', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (6, N'Network I/O', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (7, N'Buffer I/O', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (8, N'Buffer Latch', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (9, N'Memory', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (10, N'Logging', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (11, N'Compilation', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (12, N'Transaction', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (13, N'Idle', 1);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (14, N'User Waits', 1);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (15, N'Other', 0);
INSERT INTO [core].[wait_categories] ([category_id], [category_name], [ignore]) VALUES (16, N'Full Text Search', 0);

-- Insert Events
--
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (0, N'CPU');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'MISCELLANEOUS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_SCH_S');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_SCH_M');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_S');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_U');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_X');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_IS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_IU');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_IX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_SIU');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_SIX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_UIX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_BU');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_RS_S');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_RS_U');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_RIn_NL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_RIn_S');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_RIn_U');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_RIn_X');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_RX_S');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_RX_U');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (5, N'LCK_M_RX_X');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (4, N'LATCH_NL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (4, N'LATCH_KP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (4, N'LATCH_SH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (4, N'LATCH_UP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (4, N'LATCH_EX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (4, N'LATCH_DT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (8, N'PAGELATCH_NL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (8, N'PAGELATCH_KP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (8, N'PAGELATCH_SH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (8, N'PAGELATCH_UP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (8, N'PAGELATCH_EX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (8, N'PAGELATCH_DT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'PAGEIOLATCH_NL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'PAGEIOLATCH_KP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'PAGEIOLATCH_SH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'PAGEIOLATCH_UP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'PAGEIOLATCH_EX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'PAGEIOLATCH_DT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'TRAN_MARKLATCH_NL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'TRAN_MARKLATCH_KP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'TRAN_MARKLATCH_SH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'TRAN_MARKLATCH_UP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'TRAN_MARKLATCH_EX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'TRAN_MARKLATCH_DT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'LAZYWRITER_SLEEP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'IO_COMPLETION');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'ASYNC_IO_COMPLETION');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (6, N'ASYNC_NETWORK_IO');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SLEEP_BPOOL_FLUSH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'CHKPT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SLEEP_TASK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SLEEP_SYSTEMTASK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (9, N'RESOURCE_SEMAPHORE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'DTC');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (6, N'OLEDB');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'FAILPOINT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'RESOURCE_QUEUE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'ASYNC_DISKPOOL_LOCK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'THREADPOOL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DEBUG');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'REPLICA_WRITES');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'BROKER_RECEIVE_WAITFOR');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DBMIRRORING_CMD');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'WAIT_FOR_RESULTS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (0, N'SOS_SCHEDULER_YIELD');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (9, N'SOS_VIRTUALMEMORY_LOW');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (9, N'SOS_RESERVEDMEMBLOCKLIST');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOS_LOCALALLOCATORLIST');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOS_CALLBACK_REMOVAL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (9, N'LOWFAIL_MEMMGR_QUEUE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (1, N'BACKUP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (1, N'BACKUPBUFFER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (1, N'BACKUPIO');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (1, N'BACKUPTHREAD');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DBMIRROR_DBM_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DBMIRROR_DBM_EVENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (6, N'DBMIRROR_SEND');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'CURSOR_ASYNC');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'HTTP_ENUMERATION');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (16, N'SOAP_READ');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (16, N'SOAP_WRITE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DUMP_LOG_COORDINATOR');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (1, N'DISKIO_SUSPEND');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'IMPPROV_IOWAIT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QNMANAGER_ACQUIRE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DEADLOCK_TASK_SEARCH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'REPL_SCHEMA_ACCESS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'REPL_CACHE_ACCESS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SQLSORT_SORTMUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SQLSORT_NORMMUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SQLTRACE_WAIT_ENTRIES');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SQLTRACE_LOCK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SQLTRACE_BUFFER_FLUSH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SQLTRACE_SHUTDOWN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'MSQL_SYNC_PIPE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QUERY_TRACEOUT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (6, N'DTC_STATE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'FCB_REPLICA_WRITE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (7, N'FCB_REPLICA_READ');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (10, N'WRITELOG');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'HTTP_ENDPOINT_COLLCREATE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (3, N'EXCHANGE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DBTABLE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'EC');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'TEMPOBJ');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'XACTLOCKINFO');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (10, N'LOGMGR');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (9, N'CMEMTHREAD');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (9, N'CMEMPARTITIONED');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (3, N'CXPACKET');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (14, N'WAITFOR');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'CURSOR');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (3, N'EXECSYNC');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOSHOST_INTERNAL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOSHOST_SLEEP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOSHOST_WAITFORDONE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOSHOST_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOSHOST_EVENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOSHOST_SEMAPHORE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOSHOST_RWLOCK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOSHOST_TRACELOCK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'MSQL_XP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (6, N'MSQL_DQ');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (10, N'LOGBUFFER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'TRANSACTION_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (16, N'MSSEARCH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'XACTWORKSPACE_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'CLR_JOIN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'CLR_CRST');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'CLR_SEMAPHORE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'CLR_MANUAL_EVENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'CLR_AUTO_EVENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'CLR_MONITOR');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'CLR_RWLOCK_READER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'CLR_RWLOCK_WRITER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'SQLCLR_QUANTUM_PUNISHMENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'SQLCLR_APPDOMAIN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'SQLCLR_ASSEMBLY');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'KTM_ENLISTMENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'KTM_RECOVERY_RESOLUTION');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'KTM_RECOVERY_MANAGER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'SQLCLR_DEADLOCK_DETECTION');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QPJOB_WAITFOR_ABORT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QPJOB_KILL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'BAD_PAGE_PROCESS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (1, N'BACKUP_OPERATOR');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'PRINT_ROLLBACK_PROGRESS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'ENABLE_VERSIONING');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DISABLE_VERSIONING');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'REQUEST_DISPENSER_PAUSE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DROPTEMP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'FT_RESTART_CRAWL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'FT_RESUME_CRAWL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (10, N'LOGMGR_RESERVE_APPEND');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (10, N'LOGMGR_FLUSH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'XACT_OWN_TRANSACTION');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'XACT_RECLAIM_SESSION');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'DTC_WAITFOR_OUTCOME');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'DTC_RESOLVE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SEC_DROP_TEMP_KEY');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SRVPROC_SHUTDOWN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (6, N'NET_WAITFOR_PACKET');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'DTC_ABORT_REQUEST');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'DTC_TMDOWN_REQUEST');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'RECOVER_CHANGEDB');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'WORKTBL_DROP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'MIRROR_SEND_MESSAGE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SNI_HTTP_ACCEPT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SNI_HTTP_WAITFOR_0_DISCON');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (9, N'UTIL_PAGE_ALLOC');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SERVER_IDLE_CHECK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (1, N'BACKUP_CLIENTLOCK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (4, N'DEADLOCK_ENUM_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (4, N'INDEX_USAGE_STATS_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (4, N'VIEW_DEFINITION_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QUERY_NOTIFICATION_MGR_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QUERY_NOTIFICATION_TABLE_MGR_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QUERY_NOTIFICATION_SUBSCRIPTION_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QUERY_NOTIFICATION_UNITTEST_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'IMP_IMPORT_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (11, N'RESOURCE_SEMAPHORE_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'IO_AUDIT_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'BUILTIN_HASHKEY_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOS_PROCESS_AFFINITY_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'MSQL_XACT_MGR_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (12, N'MSQL_XACT_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QRY_MEM_GRANT_INFO_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOS_STACKSTORE_INIT_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOS_SYNC_TASK_ENQUEUE_EVENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOS_OBJECT_STORE_DESTROY_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'EE_PMOLOCK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (11, N'RESOURCE_SEMAPHORE_QUERY_COMPILE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (11, N'RESOURCE_SEMAPHORE_SMALL_QUERY');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'ABR');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'ASSEMBLY_LOAD');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'BROKER_CONNECTION_RECEIVE_TASK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'BROKER_ENDPOINT_STATE_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'BROKER_EVENTHANDLER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'BROKER_INIT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'BROKER_MASTERSTART');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'BROKER_REGISTERALLENDPOINTS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'BROKER_SHUTDOWN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'BROKER_TASK_STOP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'BROKER_TRANSMITTER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'CHECK_PRINT_RECORD');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'CHECKPOINT_QUEUE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'CLR_MEMORY_SPY');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'CLR_TASK_START');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'CLRHOST_STATE_ACCESS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DAC_INIT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DBCC_COLUMN_TRANSLATION_CACHE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DBMIRROR_EVENTS_QUEUE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DBMIRROR_WORKER_QUEUE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DLL_LOADING_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DUMP_LOG_COORDINATOR_QUEUE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'DUMPTRIGGER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'EE_SPECPROC_MAP_INIT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'ERROR_REPORTING_MANAGER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'EXECUTION_PIPE_EVENT_INTERNAL');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (2, N'FS_GARBAGE_COLLECTOR_SHUTDOWN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'FULLTEXT GATHERER');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'GUARDIAN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'HTTP_START');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'INTERNAL_TESTING');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'KSOURCE_WAKEUP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'LOGMGR_QUEUE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'ONDEMAND_TASK_QUEUE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'PARALLEL_BACKUP_QUEUE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QUERY_ERRHDL_SERVICE_DONE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QUERY_EXECUTION_INDEX_SORT_EVENT_OPEN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QUERY_OPTIMIZER_PRINT_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'QUERY_REMOTE_BRICKS_DONE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'REQUEST_FOR_DEADLOCK_SEARCH');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SEQUENTIAL_GUID');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SHUTDOWN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SLEEP_DBSTARTUP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SLEEP_DCOMSTARTUP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SLEEP_MSDBSTARTUP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'SLEEP_TEMPDBSTARTUP');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SNI_CRITICAL_SECTION');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SNI_LISTENER_ACCESS');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SNI_TASK_COMPLETION');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'SOS_DISPATCHER_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'TIMEPRIV_TIMEPERIOD');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'TRACEWRITE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'VIA_ACCEPT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'WAITFOR_TASKSHUTDOWN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'WAITSTAT_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'WCC');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'XE_TIMER_EVENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'XE_DISPATCHER_WAIT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (13, N'FSAGENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_TIMER_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_TIMER_TASK_DONE');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_BUFFERMGR_ALLPROCECESSED_EVENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_BUFFERMGR_FREEBUF_EVENT');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_DISPATCHER_JOIN');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_MODULEMGR_SYNC');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_OLS_LOCK');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_SERVICES_MUTEX');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_SESSION_CREATE_SYNC');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_SESSION_SYNC');
INSERT INTO [core].[wait_types] ([category_id],[wait_type]) VALUES (15, N'XE_STM_CREATE')
GO

IF (NOT OBJECT_ID(N'core.fn_query_text_from_handle', 'TF') IS NULL)
BEGIN
    RAISERROR('Dropping function [core].[fn_query_text_from_handle] ...', 0, 1)  WITH NOWAIT;
    DROP FUNCTION [core].[fn_query_text_from_handle]
END
GO 

RAISERROR('Creating function [core].[fn_query_text_from_handle] ...', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [core].[fn_query_text_from_handle](
    @handle varbinary(64), 
    @statement_start_offset int, 
    @statement_end_offset int)
RETURNS @query_text TABLE (database_id smallint, object_id int, encrypted bit, query_text nvarchar(max))
BEGIN
      IF @handle IS NOT NULL
      BEGIN
            DECLARE @start int, @end int
            DECLARE @dbid smallint, @objectid int, @encrypted bit
            DECLARE @batch nvarchar(max), @query nvarchar(max)

            -- statement_end_offset is zero prior to beginning query execution (e.g., compilation)
            SELECT 
                  @start = ISNULL(@statement_start_offset, 0), 
                  @end = CASE WHEN @statement_end_offset is null or @statement_end_offset = 0 THEN -1
                                    ELSE @statement_end_offset 
                              END
 
            SELECT @dbid = t.dbid, 
                  @objectid = t.objectid, 
                  @encrypted = t.encrypted, 
                  @batch = t.text 
            FROM sys.dm_exec_sql_text(@handle) AS t

            SELECT @query = CASE 
                        WHEN @encrypted = CAST(1 as bit) THEN N'encrypted text' 
                        ELSE LTRIM(SUBSTRING(@batch, @start / 2 + 1, ((CASE WHEN @end = -1 THEN DATALENGTH(@batch) 
                                          ELSE @end END) - @start) / 2))
                  end

            -- Found internal queries (e.g., CREATE INDEX) with end offset of original batch that is 
            -- greater than the length of the internal query and thus returns nothing if we don''t do this
            IF DATALENGTH(@query) = 0
            BEGIN
                  SELECT @query = @batch
            END

            INSERT INTO @query_text (database_id, object_id, encrypted, query_text) 
            VALUES (@dbid, @objectid, @encrypted, @query)
      END
      RETURN
END
GO


-- Table performance_counter_report_groups
--
-- This table lists the counters that are used by each report.  Referenced in [snapshots].[rpt_generic_perfmon]. 
--
IF (NOT OBJECT_ID(N'[core].[performance_counter_report_group_items]', 'U') IS NULL)
BEGIN
    -- Must drop wait_types first since it references wait_categories via FK
    RAISERROR('Dropping table [core].[performance_counter_report_group_items] ...', 0, 1)  WITH NOWAIT;
    DROP TABLE [core].[performance_counter_report_group_items]
END
GO

RAISERROR('Creating table [core].[performance_counter_report_group_items] ...', 0, 1)  WITH NOWAIT;
CREATE TABLE [core].[performance_counter_report_group_items](
        [counter_group_item_id] int IDENTITY NOT NULL PRIMARY KEY CLUSTERED, 
        [counter_group_id] nvarchar(128) NOT NULL,          -- e.g. report name
        [counter_subgroup_id] nvarchar(128) NOT NULL,       -- e.g. chart name, used by the chart to filter out its rows from the larger resultset
        [series_name] nvarchar(512) NOT NULL,               -- data series label used for output
        [object_name] nvarchar(2048) NOT NULL,              -- perfmon object name
        [object_name_wildcards] bit NOT NULL,               -- 1 if wildcard expansion is needed for the perfmon object name (e.g. '%SQL%:General Statistics'), 0 otherwise
        [counter_name] nvarchar(2048) NOT NULL,             -- perfmon counter name
        [instance_name] nvarchar(2048) NULL,                -- perfmon instance name(s) to include (evaluated with LIKE)
        [not_instance_name] nvarchar(2048) NULL,            -- perfmon instance name(s) to omit (evaluated with LIKE, use NULL to skip this criteria)
        [multiply_by] numeric(28,10) NOT NULL,              -- value to multiple the counter  by on output (for unit conversion) 
        [divide_by_cpu_count] bit NOT NULL                  -- 1 if counter should be divided by the machine's CPU count (e.g. "Process(abc)\% Processor Time", 0 otherwise
) 
GO

-- Insert perfmon counter list for each report group 
--
DECLARE @CONVERT_BYTES_TO_MB numeric(28,10)
DECLARE @CONVERT_KB_TO_MB numeric(28,10)
SET @CONVERT_BYTES_TO_MB = 1.0 / (1024*1024)
SET @CONVERT_KB_TO_MB = 1.0 / (1024);

INSERT INTO [core].[performance_counter_report_group_items] ([counter_group_id],[counter_subgroup_id],[series_name],
    [object_name],[object_name_wildcards],[counter_name],[instance_name],[not_instance_name],[multiply_by],[divide_by_cpu_count]) 
VALUES 
    ('ServerActivity', 'memoryUsage', 'System', 'Process', 0, 'Working Set', '_Total', NULL, @CONVERT_BYTES_TO_MB, 0 ), 
    ('ServerActivity', 'memoryUsage', 'SQL Server', 'Process', 0, 'Working Set', '$(TARGETPROCESS)', NULL, @CONVERT_BYTES_TO_MB, 0 ), 
    ('ServerActivity', 'IOUsage', 'System', 'Process', 0, 'IO Read Bytes/sec', '_Total', NULL, @CONVERT_BYTES_TO_MB, 0 ), 
    ('ServerActivity', 'IOUsage', 'System', 'Process', 0, 'IO Write Bytes/sec', '_Total', NULL, @CONVERT_BYTES_TO_MB, 0 ),               -- changed to fix Bug # 234905 
    ('ServerActivity', 'IOUsage', 'SQL Server', 'Process', 0, 'IO Read Bytes/sec', '$(TARGETPROCESS)', NULL, @CONVERT_BYTES_TO_MB, 0 ), 
    ('ServerActivity', 'IOUsage', 'SQL Server', 'Process', 0, 'IO Write Bytes/sec', '$(TARGETPROCESS)', NULL, @CONVERT_BYTES_TO_MB, 0 ), -- changed to fix Bug # 234905 
    ('ServerActivity', 'cpuUsage', 'System', 'Processor', 0, '% Processor Time', '_Total', NULL, 1.0, 0 ), 
    ('ServerActivity', 'cpuUsage', 'SQL Server', 'Process', 0, '% Processor Time', '$(TARGETPROCESS)', NULL, 1.0, 1 ), 
    ('ServerActivity', 'networkUsage', 'System', 'Network Interface', 0, 'Bytes Total/sec', '%', NULL, 1.0, 0 ), 
    ('ServerActivity', 'sqlActivity', 'Logins/sec', '%SQL%:General Statistics', 1, 'Logins/sec', '', NULL, 1.0, 0 ), 
    ('ServerActivity', 'sqlActivity', 'Logouts/sec', '%SQL%:General Statistics', 1, 'Logouts/sec', '', NULL, 1.0, 0 ), 
    ('ServerActivity', 'sqlActivity', 'Transactions', '%SQL%:General Statistics', 1, 'Transactions', '', NULL, 1.0, 0 ), 
    ('ServerActivity', 'sqlActivity', 'User Connections', '%SQL%:General Statistics', 1, 'User Connections', '', NULL, 1.0, 0 ), 
    ('ServerActivity', 'sqlActivity', 'Batch Requests/sec', '%SQL%:SQL Statistics', 1, 'Batch Requests/sec', '', NULL, 1.0, 0 ), 
    ('ServerActivity', 'sqlActivity', 'SQL Compilations/sec', '%SQL%:SQL Statistics', 1, 'SQL Compilations/sec', '', NULL, 1.0, 0 ), 
    ('ServerActivity', 'sqlActivity', 'SQL Re-Compilations/sec', '%SQL%:SQL Statistics', 1, 'SQL Re-Compilations/sec', '', NULL, 1.0, 0 ), 

    ('SystemDiskUsage', 'diskSpeed', '[COUNTER_INSTANCE]', 'LogicalDisk', 0, 'Avg. Disk sec/Transfer', '%', NULL, 1.0, 0 ), 
    ('SystemDiskUsage', 'diskQueues', '[COUNTER_INSTANCE]', 'LogicalDisk', 0, 'Avg. Disk Queue Length', '%', NULL, 1.0, 0 ), 
    ('SystemDiskUsage', 'diskRates', '[COUNTER_INSTANCE]', 'LogicalDisk', 0, 'Disk Bytes/sec', '%', NULL, @CONVERT_BYTES_TO_MB, 0 ), 
    ('SystemDiskUsage', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'IO Read Bytes/sec', '%', '$(TARGETPROCESS)', 1.0, 0 ), 
    ('SystemDiskUsage', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'IO Write Bytes/sec', '%', '$(TARGETPROCESS)', 1.0, 0 ), 
    ('SystemDiskUsage', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'Disk Reads/sec', '%', '$(TARGETPROCESS)', 1.0, 0 ), 
    ('SystemDiskUsage', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'Disk Writes/sec', '%', '$(TARGETPROCESS)', 1.0, 0 ), 
    ('SystemDiskUsage', 'diskSpeed', '[COUNTER_INSTANCE]', 'LogicalDisk', 0, 'Avg. Disk sec/Transfer', '%', NULL, 1.0, 0 ), 
    ('SystemDiskUsage', 'diskQueues', '[COUNTER_INSTANCE]', 'LogicalDisk', 0, 'Avg. Disk Queue Length', '%', NULL, 1.0, 0 ), 
    ('SystemDiskUsage', 'diskRates', '[COUNTER_INSTANCE]', 'LogicalDisk', 0, 'Disk Bytes/sec', '%', NULL, @CONVERT_BYTES_TO_MB, 0 ), 

    ('SystemDiskUsagePivot', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'IO Read Bytes/sec', '%', '$(TARGETPROCESS)', 1.0, 0 ), 
    ('SystemDiskUsagePivot', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'IO Write Bytes/sec', '%', '$(TARGETPROCESS)', 1.0, 0 ), 
    ('SystemDiskUsagePivot', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'Disk Reads/sec', '%', '$(TARGETPROCESS)', 1.0, 0 ), 
    ('SystemDiskUsagePivot', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'Disk Writes/sec', '%', '$(TARGETPROCESS)', 1.0, 0 ), 

    ('SqlMemoryUsage', 'memoryRates', 'Page life expectancy', '%SQL%:Buffer Manager', 1, 'Page life expectancy', '', NULL, 1.0, 0 ), 

    ('SystemMemoryUsage', 'memoryUsage', 'Total Working Set', 'Process', 0, 'Working Set', '_Total', NULL, @CONVERT_BYTES_TO_MB, 0 ), 
    ('SystemMemoryUsage', 'memoryUsage', 'Cache Bytes', 'Memory', 0, 'Cache Bytes', '', NULL, @CONVERT_BYTES_TO_MB, 0 ), 
    ('SystemMemoryUsage', 'memoryUsage', 'Pool Nonpaged Bytes', 'Memory', 0, 'Pool Nonpaged Bytes', '', NULL, @CONVERT_BYTES_TO_MB, 0 ), 
    ('SystemMemoryUsage', 'memoryRates', 'Page Reads/sec', 'Memory', 0, 'Page Reads/sec', '', NULL, 1.0, 0 ), 
    ('SystemMemoryUsage', 'memoryRates', 'Page Writes/sec', 'Memory', 0, 'Page Writes/sec', '', NULL, 1.0, 0 ), 

    ('SystemMemoryUsagePivot', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'Working Set', '%', '$(TARGETPROCESS)', @CONVERT_BYTES_TO_MB, 0 ), 
    ('SystemMemoryUsagePivot', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'Private Bytes', '%', '$(TARGETPROCESS)', @CONVERT_BYTES_TO_MB, 0 ), 

    ('SystemCpuUsage', 'cpuUsage', 'CPU [COUNTER_INSTANCE]', 'Processor', 0, '% Processor Time', '%', NULL, 1.0, 0 ), 

    ('SystemCpuUsagePivot', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, '% Processor Time', '%', '$(TARGETPROCESS)', 1.0, 1 ), 
    ('SystemCpuUsagePivot', 'processStats', '[COUNTER_INSTANCE]', 'Process', 0, 'Thread Count', '%', '$(TARGETPROCESS)', 1.0, 0 ), 

    ('SqlActivity', 'sessionsAndConnections', 'User Connections', '%SQL%:General Statistics', 1, 'User Connections', '', NULL, 1.0, 0 ), 
    ('SqlActivity', 'sessionsAndConnections', 'Active Transactions', '%SQL%:Databases', 1, 'Active Transactions', '_Total', NULL, 1.0, 0 ), 
    ('SqlActivity', 'sessionsAndConnections', 'Active requests', '%SQL%:Workload Group Stats', 1, 'Active requests', '%', NULL, 1.0, 0 ), 
    ('SqlActivity', 'requestsAndCompilations', 'Batch Requests/sec', '%SQL%:SQL Statistics', 1, 'Batch Requests/sec', '', NULL, 1.0, 0 ), 
    ('SqlActivity', 'requestsAndCompilations', 'SQL Compilations/sec', '%SQL%:SQL Statistics', 1, 'SQL Compilations/sec', '', NULL, 1.0, 0 ), 
    ('SqlActivity', 'requestsAndCompilations', 'SQL Re-Compilations/sec', '%SQL%:SQL Statistics', 1, 'SQL Re-Compilations/sec', '', NULL, 1.0, 0 ), 
    ('SqlActivity', 'planCache', '[COUNTER_INSTANCE]', '%SQL%:Plan Cache', 1, 'Cache Hit Ratio', '%', NULL, 1.0, 0 ), 
    ('SqlActivity', 'tempDb', 'Free Space in tempdb (MB)', '%SQL%:Transactions', 1, 'Free Space in tempdb (KB)', '', NULL, @CONVERT_KB_TO_MB, 0 ), 
    ('SqlActivity', 'tempDb', 'Active Temp Tables', '%SQL%:General Statistics', 1, 'Active Temp Tables', '', NULL, 1.0, 0 ), 
    ('SqlActivity', 'tempDb', 'Transactions/sec', '%SQL%:Databases', 1, 'Transactions/sec', 'tempdb', NULL, 1.0, 0 )
GO


/**********************************************************************/
/* SNAPSHOTS SCHEMA                                                   */
/**********************************************************************/
RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Create schema snapshots...', 0, 1)  WITH NOWAIT;
RAISERROR('', 0, 1)  WITH NOWAIT;
GO
IF (SCHEMA_ID('snapshots') IS NULL)
BEGIN
    -- Dynamic SQL here because we must skip the creation attempt if the schema already 
    -- exists, but we can't use a simple IF check because CREATE SCHEMA must be the first 
    -- statement in its batch. 
    DECLARE @sql nvarchar(128)
    SET @sql = 'CREATE SCHEMA snapshots'
    EXEC sp_executesql @sql
END
GO

--
-- PERFORMANCE COUNTERS COLLECTOR TYPE SUPPORT
--

-- This table holds information about instances of perf counters collected (their path and type)
IF (OBJECT_ID(N'[snapshots].[performance_counter_instances]', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[performance_counter_instances]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[performance_counter_instances](
        [performance_counter_id]            int IDENTITY NOT NULL,
        [path]                                nvarchar(2048) NOT NULL,
        [object_name]                        nvarchar(2048) NOT NULL,
        [counter_name]                        nvarchar(2048) NOT NULL,
        [instance_name]                        nvarchar(2048) NULL,
        [counter_type]                        int NOT NULL,

        -- This constraint creation generates a warning. We will deal with the warning when fix for #130259 is provided
        CONSTRAINT [UN_performance_counter_path] UNIQUE
        (
            [path]
        ) WITH (IGNORE_DUP_KEY = ON)
    )
END;
GO

-- performance_counter_instances.PK_performance_counter_instances
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_performance_counter_instances', 'performance_counter_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'performance_counter_instances', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_performance_counter_instances', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- performance_counter_instances.IDX_performance_counter_instances1
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_performance_counter_instances1', 'object_name', 0, 0), 
    ('IDX_performance_counter_instances1', 'counter_name', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'performance_counter_instances', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_performance_counter_instances1', 
    @ignore_dup_key = 0, @clustered = 0;
GO


-- This table holds information about actual values collected for perf counters (formatted, raw values, and time when counter was collected)
IF (OBJECT_ID(N'[snapshots].[performance_counter_values]', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[performance_counter_values]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[performance_counter_values](
        [performance_counter_instance_id]    int NOT NULL,
        [snapshot_id]                        int NOT NULL,                    
        [collection_time]                    datetimeoffset(7) NOT NULL,
        [formatted_value]                    float NOT NULL,
        [raw_value_first]                    bigint NOT NULL,
        [raw_value_second]                    bigint NULL,
    ) ON [PRIMARY];
    
    ALTER TABLE [snapshots].[performance_counter_values]
    ADD CONSTRAINT [CHK_performance_counter_values_check_operator] CHECK (core.fn_check_operator(snapshot_id) = 1)
END;
GO

-- performance_counter_values.PK_performance_counter_values
-- 
-- Ignore duplicate keys on primary key and not fail uploads because of that.
-- This is needed because in some cases we may have collection item that
-- collects the same counter twice, for valid reasons. To not force users
-- to provide some exclusion lists, we will ignore duplicates. 
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_performance_counter_values', 'performance_counter_instance_id', 0, 0), 
    ('PK_performance_counter_values', 'snapshot_id', 0, 0), 
    ('PK_performance_counter_values', 'collection_time', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'performance_counter_values', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_performance_counter_values', 
    @ignore_dup_key = 1, @clustered = 1;
GO

-- performance_counter_values.IDX_performance_counter_values1
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_performance_counter_values1', 'snapshot_id', 0, 0), 
    ('IDX_performance_counter_values1', 'performance_counter_instance_id', 0, 0), 
    ('IDX_performance_counter_values1', 'collection_time', 0, 0), 
    ('IDX_performance_counter_values1', 'formatted_value', 1, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'performance_counter_values', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_performance_counter_values1', 
    @ignore_dup_key = 0, @clustered = 0;
GO

-- performance_counter_values.FK_performance_counter_values_snapshot_id
IF OBJECT_ID ('snapshots.FK_performance_counter_values_snapshot_id', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_performance_counter_values_snapshot_id] on snapshots.performance_counter_values ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[performance_counter_values]
        ADD CONSTRAINT [FK_performance_counter_values_snapshot_id] FOREIGN KEY(snapshot_id)
        REFERENCES [core].[snapshots_internal] (snapshot_id) ON DELETE CASCADE
END;
GO

-- performance_counter_values.FK_performance_counter_values_instance_id
IF OBJECT_ID ('snapshots.FK_performance_counter_values_snapshot_id', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_performance_counter_values_instance_id] on snapshots.performance_counter_values ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[performance_counter_values]
        ADD CONSTRAINT [FK_performance_counter_values_instance_id] FOREIGN KEY(performance_counter_instance_id)
        REFERENCES [snapshots].[performance_counter_instances] (performance_counter_id) ON DELETE CASCADE
END;
GO


-- This view shows user friendly information about performance counters
IF (OBJECT_ID(N'[snapshots].[performance_counters]', 'V') IS NOT NULL)
BEGIN
    RAISERROR('Dropping view [snapshots].[performance_counters]...', 0, 1)  WITH NOWAIT;
    DROP VIEW [snapshots].[performance_counters]
END

RAISERROR('Creating view [snapshots].[performance_counters]...', 0, 1)  WITH NOWAIT;
GO
CREATE VIEW [snapshots].[performance_counters]
AS
SELECT     
    pci.performance_counter_id, 
    pcv.snapshot_id AS snapshot_id, 
    pcv.collection_time AS collection_time,
    pci.path AS path, 
    pci.object_name AS performance_object_name,
    pci.counter_name AS performance_counter_name,
    pci.instance_name AS performance_instance_name,
    pcv.formatted_value AS formatted_value, 
    pcv.raw_value_first, 
    pcv.raw_value_second
FROM
    snapshots.performance_counter_instances pci
    INNER JOIN snapshots.performance_counter_values pcv ON pci.performance_counter_id = pcv.performance_counter_instance_id
GO

-- Function to obtain user friendly formatted perf counters values for a given instance and time window
IF (OBJECT_ID(N'snapshots.fn_get_performance_counters', 'IF') IS NOT NULL)
BEGIN
    RAISERROR('Dropping function [snapshots].[fn_get_performance_counters] ...', 0, 1)  WITH NOWAIT;
    DROP FUNCTION [snapshots].[fn_get_performance_counters]
END
GO 

RAISERROR('Creating function [snapshots].[fn_get_performance_counters] ...', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [snapshots].[fn_get_performance_counters]  
(
    @instance_name       sysname,
    @start_time          datetimeoffset(7) = NULL,
    @end_time            datetimeoffset(7) = NULL
) 
RETURNS TABLE
AS
RETURN
(
    SELECT 
        pc.performance_counter_id AS performance_counter_id,
        pc.collection_time AS collection_time,
        pc.path AS path,
        pc.performance_object_name AS performance_object_name,
        pc.performance_counter_name AS performance_counter_name,
        pc.performance_instance_name AS performance_instance_name,
        pc.formatted_value AS formatted_value
    FROM [snapshots].[performance_counters] as pc
    JOIN [core].[snapshots] s on s.snapshot_id = pc.snapshot_id
    WHERE
        @instance_name = s.instance_name AND
        ISNULL(@start_time,CAST (0 AS DATETIME)) <= pc.collection_time AND
        ISNULL(@end_time,GETDATE()) >= pc.collection_time
)
GO

-- Function to obtain user friendly statistics about a perf counter for a given instance, counter path and time window
IF (OBJECT_ID(N'snapshots.fn_get_performance_counter_statistics', 'IF') IS NOT NULL)
BEGIN
    RAISERROR('Dropping function [snapshots].[fn_get_performance_counter_statistics] ...', 0, 1)  WITH NOWAIT;
    DROP FUNCTION [snapshots].[fn_get_performance_counter_statistics]
END
GO 

RAISERROR('Creating function [snapshots].[fn_get_performance_counter_statistics] ...', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [snapshots].[fn_get_performance_counter_statistics]  
(
    @instance_name       sysname,
    @path_pattern         nvarchar(2048),
    @start_time          datetimeoffset(7) = NULL,
    @end_time            datetimeoffset(7) = NULL
) 
RETURNS TABLE
AS
RETURN
(
    SELECT 
        pc.path                        as path,
        MIN(pc.formatted_value)        as minimum_value,
        MAX(pc.formatted_value)        as maximum_value,
        AVG(pc.formatted_value)        as average_value,
        STDEV(pc.formatted_value)    as standard_deviation,
        VAR(pc.formatted_value)        as statistical_variance
    FROM [snapshots].[performance_counters] as pc
    JOIN [core].[snapshots] s on s.snapshot_id = pc.snapshot_id
    WHERE
        s.instance_name = @instance_name AND
        pc.path LIKE @path_pattern AND
        pc.collection_time >= @start_time AND
        pc.collection_time <= @end_time
    GROUP BY pc.path
)
GO



--
-- SQLTRACE COLLECTOR TYPE SUPPORT
--

-- This table holds information about captured traces
IF (OBJECT_ID(N'[snapshots].[trace_info]', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[trace_info]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[trace_info] (
        trace_info_id                 int IDENTITY NOT NULL,
        source_id                     int NOT NULL,      -- id of source_info record corresponding to source of this data
        collection_item_id            int NOT NULL,      -- id of the trace on the target instance
        last_snapshot_id              int NULL,          -- references core.snapshots table. Identifies the most recent snapshot id that was generated for this trace
        start_time                    datetime NULL,     -- time when this trace was started on the target machine
        last_event_sequence           bigint NULL,       -- event sequence of the most recent event for this trace was captured. 
        is_running                    bit NULL,          -- 0 - trace is stopped, 1 - trace is running
        event_count                   bigint NULL,       -- total number of events captured by this trace
        dropped_event_count           int NULL,          -- total number of events dropped by this trace.
    );
END;
GO

-- trace_info.PK_trace_info
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_trace_info', 'trace_info_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'trace_info', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_trace_info', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- trace_info.FK_trace_info_last_snapshot_id
IF OBJECT_ID ('snapshots.FK_trace_info_last_snapshot_id', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_trace_info_last_snapshot_id] on snapshots.trace_info ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[trace_info]
        ADD CONSTRAINT [FK_trace_info_last_snapshot_id] FOREIGN KEY(last_snapshot_id)
        REFERENCES [core].[snapshots_internal] (snapshot_id) ON DELETE CASCADE
END;
GO

-- trace_info.FK_trace_info_last_snapshot_id
IF OBJECT_ID ('snapshots.FK_trace_info_source_id', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_trace_info_source_id] on snapshots.trace_info ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[trace_info]
        ADD CONSTRAINT [FK_trace_info_source_id] FOREIGN KEY(source_id)
        REFERENCES [core].[source_info_internal] (source_id)
END;
GO


-- This table holds all trace data 
IF (OBJECT_ID(N'[snapshots].[trace_data]', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[trace_data]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[trace_data] (
        trace_info_id                   int NOT NULL,    -- references id of the trace from trace_info table
        snapshot_id                     int NOT NULL,    -- references snapshot_id from core.snapshots
        -- Following all all trace columns that match the list from sys.trace_columns system view
        TextData                        nvarchar(max) NULL,
        BinaryData                      varbinary(max) NULL,
        DatabaseID                      int NULL,
        TransactionID                   bigint NULL,
        LineNumber                      int NULL,
        NTUserName                      nvarchar(256) NULL,
        NTDomainName                    nvarchar(256) NULL,
        HostName                        nvarchar(256) NULL,
        ClientProcessID                 int NULL,
        ApplicationName                 nvarchar(256) NULL,
        LoginName                       nvarchar(256) NULL,
        SPID                            int NULL,
        Duration                        bigint NULL,
        StartTime                       datetimeoffset(7) NULL,
        EndTime                         datetimeoffset(7) NULL,
        Reads                           bigint NULL,
        Writes                          bigint NULL,
        CPU                             int NULL,
        Permissions                     bigint NULL,
        Severity                        int NULL,
        EventSubClass                   int NULL,
        ObjectID                        int NULL,
        Success                         int NULL,
        IndexID                         int NULL,
        IntegerData                     int NULL,
        ServerName                      nvarchar(256) NULL,
        EventClass                      int NULL,
        ObjectType                      int NULL,
        NestLevel                       int NULL,
        State                           int NULL,
        Error                           int NULL,
        Mode                            int NULL,
        Handle                          int NULL,
        ObjectName                      nvarchar(256) NULL,
        DatabaseName                    nvarchar(256) NULL,
        FileName                        nvarchar(256) NULL,
        OwnerName                       nvarchar(256) NULL,
        RoleName                        nvarchar(256) NULL,
        TargetUserName                  nvarchar(256) NULL,
        DBUserName                      nvarchar(256) NULL,
        LoginSid                        varbinary(max) NULL,
        TargetLoginName                 nvarchar(256) NULL,
        TargetLoginSid                  varbinary(max) NULL,
        ColumnPermissions               int NULL,
        LinkedServerName                nvarchar(256) NULL,
        ProviderName                    nvarchar(256) NULL,
        MethodName                      nvarchar(256) NULL,
        RowCounts                       bigint NULL,
        RequestID                       int NULL,
        XactSequence                    bigint NULL,
        EventSequence                   bigint NOT NULL,
        BigintData1                     bigint NULL,
        BigintData2                     bigint NULL,
        GUID                            uniqueidentifier NULL,
        IntegerData2                    int NULL,
        ObjectID2                       bigint NULL,
        Type                            int NULL,
        OwnerID                         int NULL,
        ParentName                      nvarchar(256) NULL,
        IsSystem                        int NULL,
        Offset                          int NULL,
        SourceDatabaseID                int NULL,
        SqlHandle                       varbinary(64) NULL,
        SessionLoginName                nvarchar(256) NULL,
        PlanHandle                      varbinary(64) NULL, 
        GroupID                         int NULL

    )  ON [PRIMARY];

    ALTER TABLE [snapshots].[trace_data]
        ADD CONSTRAINT [CHK_trace_data_check_operator] CHECK (core.fn_check_operator(snapshot_id) = 1);
END;
GO

-- trace_data.IDX_trace_data_EventSequence
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_trace_data_EventSequence', 'snapshot_id', 0, 0), 
    ('IDX_trace_data_EventSequence', 'EventSequence', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'trace_data', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_trace_data_EventSequence', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- trace_data.IDX_trace_data_trace_info_id
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_trace_data_trace_info_id', 'trace_info_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'trace_data', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_trace_data_trace_info_id', 
    @ignore_dup_key = 0, @clustered = 0;
GO

-- trace_data.IDX_trace_data_EventSequence
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_trace_data_StartTime_EventClass', 'StartTime', 0, 0), 
    ('IDX_trace_data_StartTime_EventClass', 'EventClass', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'trace_data', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_trace_data_StartTime_EventClass', 
    @ignore_dup_key = 0, @clustered = 0;
GO

-- trace_data.FK_trace_data_trace_info_id
IF OBJECT_ID ('snapshots.FK_trace_data_trace_info_id', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_trace_data_trace_info_id] on snapshots.trace_data ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[trace_data]
        ADD CONSTRAINT [FK_trace_data_trace_info_id] FOREIGN KEY(trace_info_id)
        REFERENCES [snapshots].[trace_info] (trace_info_id);
END;
GO

-- trace_data.FK_trace_data_snapshot_id
IF OBJECT_ID ('snapshots.FK_trace_data_snapshot_id', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_trace_data_snapshot_id] on snapshots.trace_data ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[trace_data]
        ADD CONSTRAINT [FK_trace_data_snapshot_id] FOREIGN KEY(snapshot_id)
        REFERENCES [core].[snapshots_internal] (snapshot_id) ON DELETE CASCADE;
END;
GO


-- This stored proc inserts a new row int the snapshots.trace_info table
IF (NOT OBJECT_ID(N'snapshots.sp_trace_get_info', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[sp_trace_get_info] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[sp_trace_get_info]
END
GO 

RAISERROR('Creating procedure [snapshots].[sp_trace_get_info] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[sp_trace_get_info]
    @source_id           int,               -- references source of data from core.source_info_internal
    @collection_item_id  int,               -- idenitfies the collection item id within the source info
    @start_time          datetime,          -- time when the trace has started
    @last_event_sequence bigint OUTPUT,     -- returns the event sequence number for last trace event uploaded, or 0
    @trace_info_id       int OUTPUT         -- returns id of trace_info record
AS
BEGIN
    SET NOCOUNT ON;

    -- Security check (role membership)
    IF (NOT (ISNULL(IS_MEMBER(N'mdw_writer'), 0) = 1) AND NOT (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) = 1))
    BEGIN
        RAISERROR(14677, 16, -1, 'mdw_writer');
        RETURN(1); -- Failure
    END;

    -- Parameters check - mandatory parameters
    IF (@source_id IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@source_id')
        RETURN(1) -- Failure
    END;

    IF (@collection_item_id IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@collection_item_id')
        RETURN(1) -- Failure
    END;

    IF (@start_time IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@start_time')
        RETURN(1) -- Failure
    END;

    SELECT 
        @trace_info_id = trace_info_id,
        @last_event_sequence = last_event_sequence 
    FROM snapshots.trace_info ti
    WHERE 
        ti.source_id = @source_id
        AND ti.collection_item_id = @collection_item_id
        AND ti.is_running = 1
        AND ti.start_time = @start_time;

    IF (@trace_info_id IS NULL)
    BEGIN
        SELECT @last_event_sequence = 0;

        -- Insert new record
        INSERT INTO [snapshots].[trace_info]
        (
            source_id,
            collection_item_id,
            start_time,
            is_running,
            last_event_sequence
        )
        VALUES
        (
            @source_id,
            @collection_item_id,
            @start_time,
            1,
            @last_event_sequence
        );
        SELECT @trace_info_id = SCOPE_IDENTITY();
    END;

    RETURN (0);
END
GO


-- This stored proc updates a row in the snapshots.trace_info table
IF (NOT OBJECT_ID(N'snapshots.sp_trace_update_info', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[sp_trace_update_info] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[sp_trace_update_info]
END
GO 

RAISERROR('Creating procedure [snapshots].[sp_trace_update_info] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[sp_trace_update_info]
    @trace_info_id       int,
    @snapshot_id         int,
    @last_event_sequence bigint,
    @is_running          bit,
    @event_count         bigint,
    @dropped_event_count int
AS
BEGIN
    SET NOCOUNT ON;

    -- Security check (role membership)
    IF (NOT (ISNULL(IS_MEMBER(N'mdw_writer'), 0) = 1) AND NOT (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) = 1))
    BEGIN
        RAISERROR(14677, 16, -1, 'mdw_writer');
        RETURN(1); -- Failure
    END;

    -- Parameters check - mandatory parameters
    IF (@trace_info_id IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@trace_info_id')
        RETURN(1) -- Failure
    END;

    IF NOT EXISTS (SELECT trace_info_id from snapshots.trace_info where trace_info_id = @trace_info_id)
    BEGIN
        DECLARE @trace_info_id_as_char NVARCHAR(10)
        SELECT @trace_info_id_as_char = CONVERT(NVARCHAR(36), @trace_info_id)
        RAISERROR(14679, -1, -1, N'@trace_info_id', @trace_info_id_as_char)
        RETURN(1) -- Failure
    END;

    IF (@snapshot_id IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@snapshot_id')
        RETURN(1) -- Failure
    END;

    IF NOT EXISTS (SELECT snapshot_id from core.snapshots where snapshot_id = @snapshot_id)
    BEGIN
        DECLARE @snapshot_id_as_char NVARCHAR(36)
        SELECT @snapshot_id_as_char = CONVERT(NVARCHAR(36), @snapshot_id)
        RAISERROR(14679, -1, -1, N'@snapshot_id', @snapshot_id_as_char)
        RETURN(1) -- Failure
    END;

    IF (@last_event_sequence IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@last_event_sequence')
        RETURN(1) -- Failure
    END;

    IF (@is_running IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@is_running')
        RETURN(1) -- Failure
    END;

    IF (@event_count IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@event_count')
        RETURN(1) -- Failure
    END;

    IF (@dropped_event_count IS NULL)
    BEGIN
        RAISERROR(14200, -1, -1, '@dropped_event_count')
        RETURN(1) -- Failure
    END;

    -- Update existing record
    UPDATE [snapshots].[trace_info]
    SET
        last_snapshot_id = @snapshot_id,
        last_event_sequence = @last_event_sequence,
        is_running = @is_running,
        event_count = ISNULL(event_count,0) + @event_count,
        dropped_event_count = @dropped_event_count
    WHERE
        trace_info_id = @trace_info_id;

    RETURN(0);
END
GO


-- This function returns all data captured for the specified trace
IF (NOT OBJECT_ID(N'snapshots.fn_trace_gettable', 'IF') IS NULL)
BEGIN
    RAISERROR('Dropping function [snapshots].[fn_trace_gettable] ...', 0, 1)  WITH NOWAIT;
    DROP FUNCTION [snapshots].[fn_trace_gettable]
END
GO 

RAISERROR('Creating function [snapshots].[fn_trace_gettable] ...', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [snapshots].[fn_trace_gettable]  
(
    @trace_info_id       int,
    @start_time          datetimeoffset(7) = NULL,
    @end_time            datetimeoffset(7) = NULL
) 
RETURNS TABLE
AS
RETURN
(
    SELECT 
        TextData,
        BinaryData,
        DatabaseID,
        TransactionID,
        LineNumber,
        NTUserName,
        NTDomainName,
        HostName,
        ClientProcessID,
        ApplicationName,
        LoginName,
        SPID,
        Duration,
        StartTime,
        EndTime,
        Reads,
        Writes,
        CPU,
        Permissions,
        Severity,
        EventSubClass,
        ObjectID,
        Success,
        IndexID,
        IntegerData,
        ServerName,
        EventClass,
        ObjectType,
        NestLevel,
        State,
        Error,
        Mode,
        Handle,
        ObjectName,
        DatabaseName,
        FileName,
        OwnerName,
        RoleName,
        TargetUserName,
        DBUserName,
        LoginSid,
        TargetLoginName,
        TargetLoginSid,
        ColumnPermissions,
        LinkedServerName,
        ProviderName,
        MethodName,
        RowCounts,
        RequestID,
        XactSequence,
        EventSequence,
        BigintData1,
        BigintData2,
        GUID,
        IntegerData2,
        ObjectID2,
        Type,
        OwnerID,
        ParentName,
        IsSystem,
        Offset,
        SourceDatabaseID,
        SqlHandle,
        SessionLoginName,
        PlanHandle
    FROM snapshots.trace_data
    WHERE
        trace_info_id = @trace_info_id
        AND StartTime >= ISNULL(@start_time, '1753-01-01')
        AND StartTime <= ISNULL(@end_time, '9999-12-31')
)
GO

--
-- GENERAL TABLES FOR SYSTEM COLLECTION SETS
--

-- Association of batch text with sql_handle and object_name
--
IF (OBJECT_ID(N'snapshots.notable_query_text', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[notable_query_text]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[notable_query_text] (
        [sql_handle]        varbinary(64) NOT NULL,
        [database_id]       smallint      NULL,
        [object_id]         int           NULL,
        [object_name]       nvarchar(128) NULL,
        [sql_text]          nvarchar(max) NULL,
        [source_id]         int           NOT NULL
    ) ON [PRIMARY]
END
GO

-- notable_query_text.PK_notable_query_text
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_notable_query_text', 'source_id', 0, 0), 
    ('PK_notable_query_text', 'sql_handle', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'notable_query_text', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_notable_query_text', 
    @ignore_dup_key = 1, @clustered = 1; -- IGNORE_DUP_KEY
GO

-- notable_query_text.FK_distinct_query_to_handle_notable_query_text
IF OBJECT_ID ('snapshots.FK_notable_query_text_source_info_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_distinct_query_to_handle_notable_query_text] on snapshots.notable_query_text ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[notable_query_text] ADD CONSTRAINT [FK_notable_query_text_source_info_internal] FOREIGN KEY([source_id])
        REFERENCES [core].[source_info_internal] (source_id)
        ON DELETE CASCADE
END;


-- Association of batch plan with sql_handle and plan_handle and object_name
--
IF (OBJECT_ID(N'snapshots.notable_query_plan', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[notable_query_plan]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[notable_query_plan] (
        [sql_handle]                varbinary(64)   NOT NULL,
        [plan_handle]               varbinary(64)   NOT NULL,
        [statement_start_offset]    int             NOT NULL,
        [statement_end_offset]      int             NOT NULL,
        [plan_generation_num]       bigint          NOT NULL,
        [creation_time]             datetimeoffset(7)  NOT NULL,
        [database_id]               smallint        NULL,
        [object_id]                 int             NULL,
        [object_name]               nvarchar(128)   NULL,
        [query_plan]                nvarchar(max)   NULL,
        [source_id]                 int             NOT NULL,
    ) ON [PRIMARY]
END;

-- notable_query_plan.PK_notable_query_plan
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_notable_query_plan', 'source_id', 0, 0), 
    ('PK_notable_query_plan', 'sql_handle', 0, 0), 
    ('PK_notable_query_plan', 'plan_handle', 0, 0), 
    ('PK_notable_query_plan', 'statement_start_offset', 0, 0), 
    ('PK_notable_query_plan', 'statement_end_offset', 0, 0), 
    ('PK_notable_query_plan', 'creation_time', 0, 0), 
    ('PK_notable_query_plan', 'plan_generation_num', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'notable_query_plan', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_notable_query_plan', 
    @ignore_dup_key = 1, @clustered = 1;
GO

-- notable_query_plan.IDX_notable_query_plan_plan_handle
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_notable_query_plan_plan_handle', 'source_id', 0, 0), 
    ('IDX_notable_query_plan_plan_handle', 'plan_handle', 0, 0), 
    ('IDX_notable_query_plan_plan_handle', 'statement_start_offset', 0, 0), 
    ('IDX_notable_query_plan_plan_handle', 'statement_end_offset', 0, 0), 
    ('IDX_notable_query_plan_plan_handle', 'creation_time', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'notable_query_plan', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_notable_query_plan_plan_handle', 
    @ignore_dup_key = 0, @clustered = 0;
GO

-- notable_query_plan.FK_notable_query_plan_source_info_internal
IF OBJECT_ID ('snapshots.FK_notable_query_plan_source_info_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_notable_query_plan_source_info_internal] on snapshots.notable_query_plan ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[notable_query_plan] ADD CONSTRAINT [FK_notable_query_plan_source_info_internal] FOREIGN KEY([source_id])
        REFERENCES [core].[source_info_internal] (source_id)
        ON DELETE CASCADE;
END;
GO


IF (OBJECT_ID(N'snapshots.distinct_queries', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[distinct_queries]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[distinct_queries] (
        [distinct_query_hash]   bigint          NOT NULL,
        [distinct_sql_text]     nvarchar(512)   NOT NULL,
        [source_id]             int             NOT NULL,
    );
END;
GO

-- distinct_queries.PK_distinct_queries
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_distinct_queries', 'source_id', 0, 0), 
    ('PK_distinct_queries', 'distinct_query_hash', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'distinct_queries', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_distinct_queries', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- distinct_queries.FK_distinct_queries_source_info_internal
IF OBJECT_ID ('snapshots.FK_distinct_queries_source_info_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_distinct_queries_source_info_internal] on snapshots.distinct_queries ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[distinct_queries] ADD CONSTRAINT [FK_distinct_queries_source_info_internal] FOREIGN KEY([source_id])
        REFERENCES [core].[source_info_internal] (source_id)
        ON DELETE CASCADE
END;
GO


IF (OBJECT_ID(N'snapshots.distinct_query_to_handle', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[distinct_query_to_handle]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[distinct_query_to_handle] (
        [distinct_query_hash]   bigint          NOT NULL,
        [sql_handle]            varbinary(64)   NOT NULL,
        [source_id]             int             NOT NULL
    ) ON [PRIMARY]
END
GO

-- distinct_query_to_handle.PK_distinct_query_to_handle
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_distinct_query_to_handle', 'source_id', 0, 0), 
    ('PK_distinct_query_to_handle', 'distinct_query_hash', 0, 0), 
    ('PK_distinct_query_to_handle', 'sql_handle', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'distinct_query_to_handle', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_distinct_query_to_handle', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- distinct_query_to_handle.FK_distinct_query_to_handle_notable_query_text
IF OBJECT_ID ('snapshots.FK_distinct_query_to_handle_notable_query_text', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key snapshots.distinct_query_to_handle.FK_distinct_query_to_handle_notable_query_text...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[distinct_query_to_handle] ADD CONSTRAINT [FK_distinct_query_to_handle_notable_query_text] FOREIGN KEY([source_id], [sql_handle])
        REFERENCES [snapshots].[notable_query_text] ([source_id], [sql_handle])
END;
GO

-- distinct_query_to_handle.FK_distinct_query_to_handle_distinct_queries
IF OBJECT_ID ('snapshots.FK_distinct_query_to_handle_distinct_queries', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key snapshots.distinct_query_to_handle.FK_distinct_query_to_handle_distinct_queries...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[distinct_query_to_handle] ADD CONSTRAINT [FK_distinct_query_to_handle_distinct_queries] FOREIGN KEY([source_id], [distinct_query_hash])
        REFERENCES [snapshots].[distinct_queries] ([source_id], [distinct_query_hash])
END;
GO

-- distinct_query_to_handle.FK_distinct_query_to_handle_source_info_internal
IF OBJECT_ID ('snapshots.FK_distinct_query_to_handle_source_info_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key snapshots.distinct_query_to_handle.FK_distinct_query_to_handle_source_info_internal...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[distinct_query_to_handle] ADD CONSTRAINT [FK_distinct_query_to_handle_source_info_internal] FOREIGN KEY([source_id])
        REFERENCES [core].[source_info_internal] (source_id)
        ON DELETE CASCADE
END;
GO


-- This function returns fragment within sql query text in the specified start_offset and end_offset range (offsets are specified in bytes)
IF (NOT OBJECT_ID(N'snapshots.fn_get_query_fragment', 'FN') IS NULL)
BEGIN
    RAISERROR('Dropping function [snapshots].[fn_get_query_fragment] ...', 0, 1)  WITH NOWAIT;
    DROP FUNCTION [snapshots].[fn_get_query_fragment]
END
GO 
RAISERROR('Creating function [snapshots].[fn_get_query_fragment] ...', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [snapshots].[fn_get_query_fragment](
    @sqltext nvarchar(max),
    @start_offset int, 
    @end_offset int
)
RETURNS NVARCHAR(MAX)
BEGIN
    DECLARE @query_text NVARCHAR(MAX)
    
    DECLARE @query_text_length int
    SET @query_text_length = DATALENGTH(@sqltext) 

    -- If start_offset was set as null, default to starting byte 0
    IF (@start_offset IS NULL)
    BEGIN
        SET @start_offset = 0
    END 

    -- Validate start_offset, return this function if  offset is less than 0
    -- Validate sqltext, if input is NULL, we dont need to continue
    IF (@start_offset < 0 OR @sqltext IS NULL)
    BEGIN
        -- exceptions are not thrown here because caller calls this function on a report query where
        -- throwing exceptions would abort report rendering
        RETURN @query_text
    END

    -- ending position of the query that the row describes within the text of its batch or persisted object. 
    -- value of -1 indicates the end of the batch.
    IF (@end_offset IS NULL OR @end_offset = -1 )
    BEGIN
        SET @end_offset = @query_text_length
    END 

    -- Set the offset to closest even number. Ex: start_offset = 5, set as start_offset = 4th byte
    SET @start_offset = CEILING(@start_offset/2) *2
    SET @end_offset = CEILING(@end_offset/2) *2

    -- Validate start and end offsets
    IF (@start_offset <= @query_text_length    -- start offset should be  less than length of query string
        AND @end_offset <= @query_text_length      -- end offset should be  less than length of query string
        AND @start_offset <= @end_offset)          -- start offset should be less than end offset
    BEGIN
        -- start and end offsets are the byte's position as reported  in DMV sys.dm_exec_query_stats.
        -- sqltext has a NVARCHAR string where every character takes 2 bytes. SUBSTRING() deals with starting character's position 
        -- and length of characters from starting position. so, we are dividing by 2 to convert byte position to character position 
        SELECT @query_text = SUBSTRING(@sqltext, @start_offset/2, (@end_offset - @start_offset)/2 + 1)
    END

    RETURN @query_text
END
GO

-- This function returns text and database and object context for a query identified by a sql_handle
IF (NOT OBJECT_ID(N'snapshots.fn_get_query_text', 'TF') IS NULL)
BEGIN
    RAISERROR('Dropping function [snapshots].[fn_get_query_text] ...', 0, 1)  WITH NOWAIT;
    DROP FUNCTION [snapshots].[fn_get_query_text]
END
GO 

RAISERROR('Creating function [snapshots].[fn_get_query_text] ...', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [snapshots].[fn_get_query_text](
    @source_id int,
    @sql_handle varbinary(64), 
    @statement_start_offset int, 
    @statement_end_offset int
)
RETURNS @query_text TABLE (database_id smallint NULL, object_id int NULL, object_name sysname NULL, query_text nvarchar(max) NULL)

BEGIN
    IF @sql_handle IS NOT NULL AND 
       EXISTS (SELECT sql_handle FROM snapshots.notable_query_text WHERE sql_handle = @sql_handle AND source_id = @source_id)
    BEGIN
        INSERT INTO @query_text 
        (
            database_id, 
            object_id, 
            object_name, 
            query_text
        ) 
        SELECT 
            t.database_id,
            t.object_id,
            t.object_name,
            [snapshots].[fn_get_query_fragment](t.sql_text, @statement_start_offset, @statement_end_offset)
        FROM
            snapshots.notable_query_text t
        WHERE
            t.sql_handle = @sql_handle
            AND t.source_id = @source_id
    END

    RETURN
END
GO

-- This stored procedure returns all rows from notable_query_text table 
-- where sql_text value is NULL, meaning we did not caputure the text for that query yet.
IF (NOT OBJECT_ID(N'snapshots.sp_get_unknown_query_text', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[sp_get_unknown_query_text] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[sp_get_unknown_query_text]
END
GO 

RAISERROR('Creating procedure [snapshots].[sp_get_unknown_query_text] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[sp_get_unknown_query_text]
    @source_id  int
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        [source_id],
        [sql_handle]
    FROM
        [snapshots].[notable_query_text]
    WHERE
        [source_id] = @source_id
        AND [sql_text] IS NULL
END;
GO

-- This stored procedure returns all rows from notable_query_plan table 
-- where sql_text value is NULL, meaning we did not caputure the plan for that query yet.
IF (NOT OBJECT_ID(N'snapshots.sp_get_unknown_query_plan', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[sp_get_unknown_query_plan] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[sp_get_unknown_query_plan]
END
GO 

RAISERROR('Creating procedure [snapshots].[sp_get_unknown_query_plan] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[sp_get_unknown_query_plan]
    @source_id       int
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        [source_id],
        [sql_handle],
        [plan_handle],
        [statement_start_offset],
        [statement_end_offset],
        [plan_generation_num]
    FROM
        [snapshots].[notable_query_plan]
    WHERE
        [source_id] = @source_id
        AND [query_plan] IS NULL
END;
GO

-- Updates a single row with new text for the sql_handle
IF (NOT OBJECT_ID(N'snapshots.sp_update_query_text', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[sp_update_query_text] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[sp_update_query_text]
END
GO 

RAISERROR('Creating procedure [snapshots].[sp_update_query_text] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[sp_update_query_text]
    @source_id       int,
    @sql_handle      varbinary(64),
    @database_id     smallint     ,
    @object_id       int          ,
    @object_name     nvarchar(128),
    @sql_text        nvarchar(max)
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE [snapshots].[notable_query_text]
    SET
        database_id = @database_id,
        object_id   = @object_id,
        object_name = @object_name,
        sql_text    = @sql_text
    WHERE
        source_id = @source_id 
        AND sql_handle = @sql_handle
        
END;
GO

-- Updates a single row with new plan for the plan_handle
IF (NOT OBJECT_ID(N'snapshots.sp_update_query_plan', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[sp_update_query_plan] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[sp_update_query_plan]
END
GO 

RAISERROR('Creating procedure [snapshots].[sp_update_query_plan] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[sp_update_query_plan]
    @source_id                 int,
    @sql_handle                varbinary(64),
    @plan_handle               varbinary(64),
    @statement_start_offset    int          ,
    @statement_end_offset      int          ,
    @plan_generation_num       bigint       ,
    @database_id               smallint     ,
    @object_id                 int          ,
    @object_name               nvarchar(128),
    @query_plan                nvarchar(max)
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE [snapshots].[notable_query_plan]
    SET
        database_id     = @database_id,
        object_id       = @object_id,
        object_name     = @object_name,
        query_plan      = @query_plan
    WHERE
        source_id = @source_id
        AND sql_handle = @sql_handle
        AND plan_handle = @plan_handle
        AND statement_start_offset = @statement_start_offset
        AND statement_end_offset = @statement_end_offset
        AND plan_generation_num = @plan_generation_num

END;
GO




--
-- SERVER ACTIVITY COLLECTION SET SUPPORT
--

-- os_wait_stats table
--
IF (OBJECT_ID(N'snapshots.os_wait_stats', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[os_wait_stats]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[os_wait_stats](
        [wait_type]             nvarchar(45) NOT NULL,
        [waiting_tasks_count]   bigint NOT NULL,
        [wait_time_ms]          bigint NOT NULL,
        [signal_wait_time_ms]   bigint NOT NULL,
        [collection_time]       datetimeoffset(7) NOT NULL,
        [snapshot_id]           int NOT NULL,
    );
    
    ALTER TABLE [snapshots].[os_wait_stats]  WITH CHECK ADD  CONSTRAINT [CHK_os_wait_stats_check_operator] CHECK  (([core].[fn_check_operator]([snapshot_id])=(1)))
    
    CREATE STATISTICS [STAT_os_wait_stats1] ON [snapshots].[os_wait_stats](
        [collection_time], 
        [snapshot_id], 
        [wait_type]
    )

    CREATE STATISTICS [STAT_os_wait_stats2] ON [snapshots].[os_wait_stats](
        [collection_time], 
        [wait_type]
    )

END;
GO

-- os_wait_stats.PK_os_wait_stats
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_os_wait_stats', 'snapshot_id', 0, 0), 
    ('PK_os_wait_stats', 'collection_time', 0, 0), 
    ('PK_os_wait_stats', 'wait_type', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'os_wait_stats', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_os_wait_stats', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- os_wait_stats.IDX_os_wait_stats1
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_os_wait_stats1', 'collection_time', 0, 1), 
    ('IDX_os_wait_stats1', 'snapshot_id', 0, 0), 
    ('IDX_os_wait_stats1', 'wait_type', 1, 0), 
    ('IDX_os_wait_stats1', 'signal_wait_time_ms', 1, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'os_wait_stats', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_os_wait_stats1', 
    @ignore_dup_key = 0, @clustered = 0;
GO

-- os_wait_stats.IDX_os_wait_stats1
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_os_wait_stats2', 'snapshot_id', 0, 0), 
    ('IDX_os_wait_stats2', 'collection_time', 0, 0); 
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'os_wait_stats', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_os_wait_stats2', 
    @ignore_dup_key = 0, @clustered = 0;
GO

-- os_wait_stats.FK_os_wait_stats_snapshots_internal
IF OBJECT_ID ('snapshots.FK_os_wait_stats_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_os_wait_stats_snapshots_internal] on snapshots.os_wait_stats ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[os_wait_stats] ADD CONSTRAINT [FK_os_wait_stats_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


-- os_latch_stats table
--
IF (OBJECT_ID(N'snapshots.os_latch_stats', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[os_latch_stats]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[os_latch_stats](
        [latch_class]               nvarchar(45) NOT NULL,
        [waiting_requests_count]    bigint NOT NULL,
        [wait_time_ms]              bigint NOT NULL,
        [collection_time]           datetimeoffset(7) NOT NULL,
        [snapshot_id]               int NOT NULL,
    );
    
    ALTER TABLE [snapshots].[os_latch_stats] WITH CHECK ADD CONSTRAINT [CHK_os_latch_stats_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END;
GO

-- os_latch_stats.PK_os_latch_stats
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_os_latch_stats', 'snapshot_id', 0, 0), 
    ('PK_os_latch_stats', 'collection_time', 0, 0), 
    ('PK_os_latch_stats', 'latch_class', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'os_latch_stats', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_os_latch_stats', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- os_latch_stats.FK_os_latch_stats_snapshots_internal
IF OBJECT_ID ('snapshots.FK_os_latch_stats_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_os_latch_stats_snapshots_internal] on snapshots.os_latch_stats ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[os_latch_stats] ADD CONSTRAINT [FK_os_latch_stats_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


IF (OBJECT_ID(N'snapshots.active_sessions_and_requests', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[active_sessions_and_requests]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[active_sessions_and_requests](
        [row_id]                    int NOT NULL,
        [session_id]                smallint NOT NULL,
        [request_id]                int NOT NULL,
        [exec_context_id]           int NOT NULL,
        [blocking_session_id]       smallint NULL,
        [blocking_exec_context_id]  int NULL,
        [scheduler_id]              int NULL,
        [database_name]             nvarchar(128) NULL,
        [user_id]                   int NULL,
        [task_state]                nvarchar(10) NULL,
        [request_status]            nvarchar(15) NULL,
        [session_status]            nvarchar(15) NOT NULL,
        [executing_managed_code]    bit NULL,
        [login_time]                datetimeoffset(7) NOT NULL,
        [is_user_process]           bit NOT NULL,
        [host_name]                 nvarchar(128) NOT NULL,
        [program_name]              nvarchar(128) NOT NULL,
        [login_name]                nvarchar(30) NOT NULL,
        [wait_type]                 nvarchar(45) NOT NULL,
        [last_wait_type]            nvarchar(45) NOT NULL,
        [wait_duration_ms]          bigint NOT NULL,
        [wait_resource]             nvarchar(50) NOT NULL,
        [resource_description]      nvarchar(140) NOT NULL,
        [transaction_id]            bigint NULL,
        [open_transaction_count]    int NOT NULL,
        [transaction_isolation_level] smallint NULL,
        [request_cpu_time]          int NULL,
        [request_logical_reads]     bigint NULL,
        [request_reads]             bigint NULL,
        [request_writes]            bigint NULL,
        [request_total_elapsed_time] int NULL,
        [request_start_time]        datetimeoffset(7) NULL,
        [memory_usage]              int NOT NULL,
        [session_cpu_time]          int NOT NULL,
        [session_reads]             bigint NOT NULL,
        [session_writes]            bigint NOT NULL,
        [session_logical_reads]     bigint NOT NULL,
        [session_total_scheduled_time] int NOT NULL,
        [session_total_elapsed_time] int NOT NULL,
        [session_last_request_start_time] datetimeoffset(7) NOT NULL,
        [session_last_request_end_time] datetimeoffset(7) NULL,
        [open_resultsets]           int NULL,
        [session_row_count]         bigint NOT NULL,
        [prev_error]                int NOT NULL,
        [pending_io_count]          int NULL,
        [command]                   nvarchar(32) NULL,
        [plan_handle]               varbinary(64) NULL,
        [sql_handle]                varbinary(64) NULL,
        [statement_start_offset]    int NULL,
        [statement_end_offset]      int NULL,
        [collection_time]           datetimeoffset(7) NOT NULL,
        [snapshot_id]               int NOT NULL,
        [is_blocking]               bit NOT NULL,
    );

    ALTER TABLE [snapshots].[active_sessions_and_requests] WITH CHECK ADD CONSTRAINT [CHK_active_sessions_and_requests_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END;
GO

-- active_sessions_and_requests.PK_active_sessions_and_requests
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_active_sessions_and_requests', 'snapshot_id', 0, 0), 
    ('PK_active_sessions_and_requests', 'collection_time', 0, 0), 
    ('PK_active_sessions_and_requests', 'row_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'active_sessions_and_requests', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_active_sessions_and_requests', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- active_sessions_and_requests.IDX_blocking_session_id
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_blocking_session_id', 'blocking_session_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'active_sessions_and_requests', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_blocking_session_id', 
    @ignore_dup_key = 0, @clustered = 0;
GO

-- active_sessions_and_requests.IDX_collection_time
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('IDX_collection_time', 'collection_time', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'active_sessions_and_requests', 
    @object_type = 'INDEX', @constraint_or_index_name = 'IDX_collection_time', 
    @ignore_dup_key = 0, @clustered = 0;
GO

-- active_sessions_and_requests.FK_active_sessions_and_requests_snapshots_internal
IF OBJECT_ID ('snapshots.FK_active_sessions_and_requests_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_active_sessions_and_requests_snapshots_internal] on snapshots.active_sessions_and_requests ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[active_sessions_and_requests] ADD CONSTRAINT [FK_active_sessions_and_requests_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


IF (OBJECT_ID(N'snapshots.os_schedulers', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[os_schedulers]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[os_schedulers] (
        [parent_node_id]            int    NOT NULL,
        [scheduler_id]                int    NOT NULL,
        [cpu_id]                    int NOT NULL,
        [status]                    nvarchar(60) NOT NULL,
        [is_idle]                    bit NOT NULL,
        [preemptive_switches_count]    int NOT NULL,
        [context_switches_count]    int NOT NULL,
        [yield_count]                int NOT NULL,
        [current_tasks_count]        int NOT NULL,
        [runnable_tasks_count]        int NOT NULL,
        [work_queue_count]            bigint NOT NULL,
        [pending_disk_io_count]        int NOT NULL,
        [collection_time]           datetimeoffset(7) NOT NULL,
        [snapshot_id]               int NOT NULL,
    );

    ALTER TABLE [snapshots].[os_schedulers] WITH CHECK ADD CONSTRAINT [CHK_os_schedulers_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END;
GO

-- os_schedulers.PK_os_schedulers
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_os_schedulers', 'snapshot_id', 0, 0), 
    ('PK_os_schedulers', 'collection_time', 0, 0), 
    ('PK_os_schedulers', 'scheduler_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'os_schedulers', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_os_schedulers', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- os_schedulers.FK_os_schedulers_snapshots_internal
IF OBJECT_ID ('snapshots.FK_os_schedulers_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_os_schedulers_snapshots_internal] on snapshots.os_schedulers ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[os_schedulers] ADD CONSTRAINT [FK_os_schedulers_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


IF (OBJECT_ID(N'snapshots.os_memory_nodes', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[os_memory_nodes]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[os_memory_nodes] (
        [memory_node_id]                        smallint NOT NULL, 
        [virtual_address_space_reserved_kb]     bigint NOT NULL, 
        [virtual_address_space_committed_kb]    bigint NOT NULL, 
        [locked_page_allocations_kb]            bigint NOT NULL, 
        [single_pages_kb]                       bigint NOT NULL, 
        [multi_pages_kb]                        bigint NOT NULL, 
        [shared_memory_reserved_kb]             bigint NOT NULL, 
        [shared_memory_committed_kb]            bigint NOT NULL,
        [collection_time]                       datetimeoffset(7) NOT NULL,
        [snapshot_id]                           int NOT NULL,
    );

    ALTER TABLE [snapshots].[os_memory_nodes] WITH CHECK ADD CONSTRAINT [CHK_os_memory_nodes_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END;
GO

-- os_memory_nodes.PK_os_memory_nodes
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_os_memory_nodes', 'snapshot_id', 0, 0), 
    ('PK_os_memory_nodes', 'collection_time', 0, 0), 
    ('PK_os_memory_nodes', 'memory_node_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'os_memory_nodes', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_os_memory_nodes', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- os_memory_nodes.FK_os_memory_nodes_snapshots_internal
IF OBJECT_ID ('snapshots.FK_os_memory_nodes_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_os_memory_nodes_snapshots_internal] on snapshots.os_memory_nodes ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[os_memory_nodes] ADD CONSTRAINT [FK_os_memory_nodes_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


-- NOTE: Used by System Activity collection set up to CTP6 Refresh/RC0. Not used in RTM and later. 
IF (OBJECT_ID(N'snapshots.os_process_memory', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[os_process_memory]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[os_process_memory] (
        [physical_memory_in_use_kb]              bigint NOT NULL,
        [large_page_allocations_kb]              bigint NOT NULL, 
        [locked_page_allocations_kb]             bigint NOT NULL, 
        [total_virtual_address_space_kb]         bigint NOT NULL,
        [virtual_address_space_reserved_kb]      bigint NOT NULL,
        [virtual_address_space_committed_kb]     bigint NOT NULL,
        [virtual_address_space_available_kb]     bigint NOT NULL,
        [page_fault_count]                       bigint NOT NULL,
        [memory_utilization_percentage]          int NOT NULL,
        [available_commit_limit_kb]              bigint NOT NULL,
        [process_physical_memory_low]            bit NOT NULL,
        [process_virtual_memory_low]             bit NOT NULL,
        [collection_time]                        datetimeoffset(7) NOT NULL,
        [snapshot_id]                            int NOT NULL,
    );

    ALTER TABLE [snapshots].[os_process_memory] WITH CHECK ADD CONSTRAINT [CHK_os_process_memory_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END;
GO

-- os_process_memory.PK_os_process_memory
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_os_process_memory', 'snapshot_id', 0, 0), 
    ('PK_os_process_memory', 'collection_time', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'os_process_memory', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_os_process_memory', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- os_process_memory.FK_os_process_memory_snapshots_internal
IF OBJECT_ID ('snapshots.FK_os_process_memory_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_os_process_memory_snapshots_internal] on snapshots.os_process_memory ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[os_process_memory] ADD CONSTRAINT [FK_os_process_memory_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


IF (OBJECT_ID(N'snapshots.sql_process_and_system_memory', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[sql_process_and_system_memory]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[sql_process_and_system_memory](
        [sql_physical_memory_in_use_kb]             bigint NOT NULL,
        [sql_large_page_allocations_kb]             bigint NOT NULL,
        [sql_locked_page_allocations_kb]            bigint NOT NULL,
        [sql_total_virtual_address_space_kb]        bigint NOT NULL,
        [sql_virtual_address_space_reserved_kb]     bigint NOT NULL,
        [sql_virtual_address_space_committed_kb]    bigint NOT NULL,
        [sql_virtual_address_space_available_kb]    bigint NOT NULL,
        [sql_page_fault_count]                      bigint NOT NULL,
        [sql_memory_utilization_percentage]         int NOT NULL,
        [sql_available_commit_limit_kb]             bigint NOT NULL,
        [sql_process_physical_memory_low]           bit NOT NULL,
        [sql_process_virtual_memory_low]            bit NOT NULL,
        [system_total_physical_memory_kb]           bigint NOT NULL,
        [system_available_physical_memory_kb]       bigint NOT NULL,
        [system_total_page_file_kb]                 bigint NOT NULL,
        [system_available_page_file_kb]             bigint NOT NULL,
        [system_cache_kb]                           bigint NOT NULL,
        [system_kernel_paged_pool_kb]               bigint NOT NULL,
        [system_kernel_nonpaged_pool_kb]            bigint NOT NULL,
        [system_high_memory_signal_state]           bit NOT NULL,
        [system_low_memory_signal_state]            bit NOT NULL,
        [bpool_commit_target]                       bigint NOT NULL,
        [bpool_committed]                           bigint NOT NULL,
        [bpool_visible]                             bigint NOT NULL, 
        [collection_time]                           datetimeoffset(7) NOT NULL,
        [snapshot_id]                               int NOT NULL,
    );

    ALTER TABLE [snapshots].[sql_process_and_system_memory] WITH CHECK ADD CONSTRAINT [CHK_sql_process_and_system_memory_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)));
END;
GO

-- sql_process_and_system_memory.PK_sql_process_and_system_memory
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_sql_process_and_system_memory', 'snapshot_id', 0, 0), 
    ('PK_sql_process_and_system_memory', 'collection_time', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'sql_process_and_system_memory', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_sql_process_and_system_memory', 
    @ignore_dup_key = 0, @clustered = 1;
GO



-- sql_process_and_system_memory.FK_sql_process_and_system_memory_internal
IF OBJECT_ID ('snapshots.FK_sql_process_and_system_memory_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_sql_process_and_system_memory_internal] on snapshots.sql_process_and_system_memory ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[sql_process_and_system_memory] ADD CONSTRAINT [FK_sql_process_and_system_memory_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE;
END;
GO


IF (OBJECT_ID(N'snapshots.os_memory_clerks', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[os_memory_clerks]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[os_memory_clerks] (
        [type]                                  nvarchar(60),
        [memory_node_id]                        smallint,
        [single_pages_kb]                       bigint,
        [multi_pages_kb]                        bigint,
        [virtual_memory_reserved_kb]            bigint,
        [virtual_memory_committed_kb]           bigint,
        [awe_allocated_kb]                      bigint,
        [shared_memory_reserved_kb]             bigint,
        [shared_memory_committed_kb]            bigint,
        [collection_time]                       datetimeoffset(7) NOT NULL,
        [snapshot_id]                           int NOT NULL
    ) ON [PRIMARY]

    ALTER TABLE [snapshots].[os_memory_clerks] WITH CHECK ADD CONSTRAINT [CHK_os_memory_clerks_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END
GO

-- os_memory_clerks.CIDX_os_memory_clerks
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('CIDX_os_memory_clerks', 'snapshot_id', 0, 0), 
    ('CIDX_os_memory_clerks', 'collection_time', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'os_memory_clerks', 
    @object_type = 'INDEX', @constraint_or_index_name = 'CIDX_os_memory_clerks', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- os_memory_clerks.FK_os_memory_clerks_snapshots_internal
IF OBJECT_ID ('snapshots.FK_os_memory_clerks_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_os_memory_clerks_snapshots_internal] on snapshots.os_memory_clerks ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[os_memory_clerks] ADD CONSTRAINT [FK_os_memory_clerks_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


--
-- QUERY ACTIVITY COLLECTION SET SUPPORT
--

IF (OBJECT_ID(N'snapshots.query_stats', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[query_stats]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[query_stats] (
           [sql_handle]                varbinary(64) NOT NULL,
         [statement_start_offset]   int NOT NULL,
         [statement_end_offset]        int NOT NULL,
         [plan_generation_num]        bigint NOT NULL,
         [plan_handle]                varbinary(64) NOT NULL,
         [creation_time]            datetimeoffset(7) NOT NULL,
         [last_execution_time]        datetimeoffset(7) NOT NULL,
         [execution_count]            bigint NOT NULL,
         [snapshot_execution_count]    bigint NULL,
         [total_worker_time]        bigint NOT NULL,
         [snapshot_worker_time]        bigint NOT NULL,
         [min_worker_time]            bigint NULL,        -- NULLable b/c we can't calc min for queries that are still in-progress 
         [max_worker_time]            bigint NOT NULL,
         [total_physical_reads]        bigint NOT NULL,
         [snapshot_physical_reads]    bigint NOT NULL,
         [min_physical_reads]        bigint NULL,        -- NULLable b/c we can't calc min for queries that are still in-progress 
         [max_physical_reads]        bigint NOT NULL,
         [total_logical_writes]        bigint NOT NULL,
         [snapshot_logical_writes]    bigint NOT NULL,
         [min_logical_writes]        bigint NULL,        -- NULLable b/c we can't calc min for queries that are still in-progress 
         [max_logical_writes]        bigint NOT NULL,
         [total_logical_reads]        bigint NOT NULL,
         [snapshot_logical_reads]    bigint NOT NULL,
         [min_logical_reads]        bigint NULL,        -- NULLable b/c we can't calc min for queries that are still in-progress 
         [max_logical_reads]        bigint NOT NULL,
         [total_clr_time]            bigint NULL,        -- NULLable b/c dm_exec_requests doesn't expose this stat
         [snapshot_clr_time]        bigint NULL,        -- NULLable b/c dm_exec_requests doesn't expose this stat
         [min_clr_time]                bigint NULL,        -- NULLable b/c we can't calc min for queries that are still in-progress 
         [max_clr_time]                bigint NULL,        -- NULLable b/c dm_exec_requests doesn't expose this stat 
         [total_elapsed_time]        bigint NOT NULL,
         [snapshot_elapsed_time]    bigint NOT NULL,
         [min_elapsed_time]            bigint NULL,        -- NULLable b/c we can't calc min for queries that are still in-progress 
         [max_elapsed_time]            bigint NOT NULL,
         [collection_time]          datetimeoffset(7) NOT NULL,
         [snapshot_id]              int NOT NULL

    ) ON [PRIMARY]

    ALTER TABLE [snapshots].[query_stats] WITH CHECK ADD CONSTRAINT [CHK_query_stats_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END
GO

-- query_stats.PK_query_stats
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('CIDX_query_stats', 'snapshot_id', 0, 0), 
    ('CIDX_query_stats', 'collection_time', 0, 0), 
    ('CIDX_query_stats', 'sql_handle', 0, 0), 
    ('CIDX_query_stats', 'statement_start_offset', 0, 0), 
    ('CIDX_query_stats', 'statement_end_offset', 0, 0), 
    ('CIDX_query_stats', 'plan_handle', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'query_stats', 
    @object_type = 'INDEX', @constraint_or_index_name = 'CIDX_query_stats', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- query_stats.FK_query_stats_snapshots_internal
IF OBJECT_ID ('snapshots.FK_query_stats_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_query_stats_snapshots_internal] on snapshots.query_stats ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[query_stats] ADD CONSTRAINT [FK_query_stats_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


IF (NOT OBJECT_ID(N'snapshots.distinct_query_stats', 'V') IS NULL)
BEGIN
    RAISERROR('Dropping view [snapshots].[distinct_query_stats]...', 0, 1)  WITH NOWAIT;
    DROP VIEW [snapshots].[distinct_query_stats]
END
GO

RAISERROR('Creating view [snapshots].[distinct_query_stats]...', 0, 1)  WITH NOWAIT;
GO
CREATE VIEW [snapshots].[distinct_query_stats]
AS 
    SELECT 
        dqth.distinct_query_hash,
        SUM(qs.execution_count) AS execution_count,
        SUM(qs.total_worker_time) AS total_worker_time,
        SUM(qs.total_physical_reads) AS total_physical_reads,
        SUM(qs.total_logical_reads) AS total_logical_reads,
        SUM(qs.total_logical_writes) AS total_logical_writes,
        SUM(qs.total_clr_time) AS total_clr_time,
        SUM(qs.total_elapsed_time) AS total_elapsed_time
    FROM
        [snapshots].[query_stats] qs
        JOIN [core].[snapshots_internal] s ON (s.snapshot_id = qs.snapshot_id)
        JOIN [snapshots].[distinct_query_to_handle] dqth ON (s.source_id = dqth.source_id AND qs.sql_handle = dqth.sql_handle)
    GROUP BY
        dqth.distinct_query_hash
GO



--
-- DISK USAGE COLLECTION SET SUPPORT
--

-- disk_usage table
--
IF (OBJECT_ID(N'snapshots.disk_usage', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[disk_usage]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[disk_usage](
        [dbsize] [bigint] NULL,
        [logsize] [bigint] NULL,
        [ftsize] [bigint] NULL,
        [reservedpages] [bigint] NULL,
        [usedpages] [bigint] NULL,
        [pages] [bigint] NULL,
        [database_name] [nvarchar](128) NOT NULL,
        [collection_time] datetimeoffset(7) NOT NULL,
        [snapshot_id] [int] NOT NULL, 
    ) ON [PRIMARY]

    ALTER TABLE [snapshots].[disk_usage]  WITH CHECK ADD  CONSTRAINT [CHK_disk_usage_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END
GO

-- disk_usage.PK_disk_usage
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_disk_usage', 'snapshot_id', 0, 0), 
    ('PK_disk_usage', 'collection_time', 0, 0), 
    ('PK_disk_usage', 'database_name', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'disk_usage', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_disk_usage', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- disk_usage.FK_disk_usage_snapshots_internal
IF OBJECT_ID ('snapshots.FK_disk_usage_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_disk_usage_snapshots_internal] on snapshots.disk_usage ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[disk_usage]  WITH CHECK ADD  CONSTRAINT [FK_disk_usage_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


-- log_usage table
--
IF (OBJECT_ID(N'snapshots.log_usage', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[log_usage]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[log_usage](
        [database_name] [nvarchar](128) NOT NULL,
        [log_size_mb] [float] NULL,
        [log_space_used] [float] NULL,
        [status] [int] NULL,
        [collection_time] datetimeoffset(7) NOT NULL,
        [snapshot_id] [int] NOT NULL, 
    ) ON [PRIMARY]

    ALTER TABLE [snapshots].[log_usage] WITH CHECK ADD CONSTRAINT [CHK_log_usage_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END
GO

-- log_usage.PK_log_usage
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_log_usage', 'snapshot_id', 0, 0), 
    ('PK_log_usage', 'collection_time', 0, 0), 
    ('PK_log_usage', 'database_name', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'log_usage', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_log_usage', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- log_usage.FK_log_usage_snapshots_internal
IF OBJECT_ID ('snapshots.FK_log_usage_snapshots_internal', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_log_usage_snapshots_internal] on snapshots.log_usage ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[log_usage] WITH CHECK ADD CONSTRAINT [FK_log_usage_snapshots_internal] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO


-- io_virtual_file_stats table
--
IF (OBJECT_ID(N'snapshots.io_virtual_file_stats', 'U') IS NULL)
BEGIN
    RAISERROR('Creating table [snapshots].[io_virtual_file_stats]...', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[io_virtual_file_stats] (
        [database_name] [nvarchar](128) NOT NULL,
        [database_id] [int] NOT NULL,
        [logical_file_name] [nvarchar](128) NOT NULL,
        [file_id] [int] NOT NULL,
        [type_desc] [nvarchar](60) NULL,
        [logical_disk] [nvarchar](255) NOT NULL,
        [num_of_reads] [bigint] NULL,
        [num_of_bytes_read] [bigint] NULL,
        [io_stall_read_ms] [bigint] NULL,
        [num_of_writes] [bigint] NULL,
        [num_of_bytes_written] [bigint] NULL,
        [io_stall_write_ms] [bigint] NULL,
        [size_on_disk_bytes] [bigint] NULL,
        [collection_time] [datetimeoffset](7) NOT NULL,
        [snapshot_id] [int] NOT NULL, 
        
    ) ON [PRIMARY]

    ALTER TABLE [snapshots].[io_virtual_file_stats] WITH CHECK ADD CONSTRAINT [CHK_io_virtual_file_stats_check_operator] CHECK (([core].[fn_check_operator]([snapshot_id])=(1)))
END
GO

-- io_virtual_file_stats.PK_io_virtual_file_stats
TRUNCATE TABLE #index_key_columns;
INSERT INTO #index_key_columns (constraint_name, column_name, is_included_column, is_descending_key) 
VALUES 
    ('PK_io_virtual_file_stats', 'snapshot_id', 0, 0), 
    ('PK_io_virtual_file_stats', 'collection_time', 0, 0), 
    ('PK_io_virtual_file_stats', 'logical_disk', 0, 0), 
    ('PK_io_virtual_file_stats', 'database_name', 0, 0), 
    ('PK_io_virtual_file_stats', 'file_id', 0, 0);
EXEC #create_or_alter_primary_key_or_index
    @table_schema = 'snapshots', @table_name = 'io_virtual_file_stats', 
    @object_type = 'PRIMARY KEY', @constraint_or_index_name = 'PK_io_virtual_file_stats', 
    @ignore_dup_key = 0, @clustered = 1;
GO

-- io_virtual_file_stats.FK_io_virtual_file_stats
IF OBJECT_ID ('snapshots.FK_io_virtual_file_stats', 'F') IS NULL
BEGIN
    RAISERROR ('Creating foreign key [FK_io_virtual_file_stats] on snapshots.io_virtual_file_stats ...', 0, 1) WITH NOWAIT;
    ALTER TABLE [snapshots].[io_virtual_file_stats] WITH CHECK ADD CONSTRAINT [FK_io_virtual_file_stats] FOREIGN KEY([snapshot_id])
        REFERENCES [core].[snapshots_internal] ([snapshot_id])
        ON DELETE CASCADE
END;
GO



/**********************************************************************/
/* REPORTING STORED PROCEDURES                                       */
/**********************************************************************/

--
-- snapshots.rpt_snapshot_times
--  Returns all snapshot times for a given collection set.  
--  Used by (nearly) all reports to return data for the timeline chart that sits at the top of each report. 
--
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - End of the user-selected time window (UTC)
--    @WindowSize - Number of minutes in the time window 
--    @CollectionSetUid - GUID of the collection set with the snapshot_times that the report cares about
--
IF (NOT OBJECT_ID(N'snapshots.rpt_snapshot_times', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_snapshot_times] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_snapshot_times]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_snapshot_times] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROC [snapshots].[rpt_snapshot_times]
    @ServerName sysname, 
    @EndTime datetime, 
    @WindowSize int, 
    @CollectionSetUid uniqueidentifier
AS
BEGIN
    DECLARE @end_time_internal datetimeoffset(7)
    SET @end_time_internal = TODATETIMEOFFSET (@EndTime, '+00:00')

    -- Get the time of the earliest and latest snapshots for this collection set
    DECLARE @min_snapshot_time datetimeoffset(7)
    DECLARE @max_snapshot_time datetimeoffset(7)
    DECLARE @total_data_collection_window int
    SELECT @min_snapshot_time = MIN (snapshot_time), @max_snapshot_time = MAX (snapshot_time)
    FROM core.snapshots 
    WHERE instance_name = @ServerName
        AND collection_set_uid = @CollectionSetUid
    IF @min_snapshot_time IS NULL SET @min_snapshot_time = SYSDATETIMEOFFSET()
    IF @max_snapshot_time IS NULL SET @max_snapshot_time = SYSDATETIMEOFFSET()
    SET @total_data_collection_window = DATEDIFF (minute, @min_snapshot_time, @max_snapshot_time)

    -- First return all snapshot_time values for this collection set
    SELECT DISTINCT 
        CONVERT (datetime, SWITCHOFFSET (CAST (snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time,
        1 AS value, 
        'AllSnapshotTimes' AS series_name
    FROM core.snapshots
    WHERE instance_name = @ServerName
        AND collection_set_uid = @CollectionSetUid
    UNION ALL
     
    -- Then return the snapshot_time values that are in the selected time window, with a different series label. 
    SELECT DISTINCT 
        CONVERT (datetime, SWITCHOFFSET (CAST (snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time,
        0.8 AS value, 
        'SelectedSnapshotTimes' AS series_name
    FROM core.snapshots
    WHERE instance_name = @ServerName
        AND collection_set_uid = @CollectionSetUid
        AND snapshot_time BETWEEN DATEADD (minute, -1 * @WindowSize, @end_time_internal) AND @end_time_internal 
    UNION ALL 
    SELECT DISTINCT 
        DATEADD (millisecond, 10, CONVERT (datetime, SWITCHOFFSET (CAST (snapshot_time AS datetimeoffset(7)), '+00:00'))) AS snapshot_time,
        1.2 AS value, 
        'SelectedSnapshotTimes' AS series_name
    FROM core.snapshots
    WHERE instance_name = @ServerName
        AND collection_set_uid = @CollectionSetUid
        AND snapshot_time BETWEEN DATEADD (minute, -1 * @WindowSize, @end_time_internal) AND @end_time_internal 

    -- Return a "fake" data point (will not be plotted) so that the timeline always extends to the current time
    UNION ALL 
        SELECT GETUTCDATE() AS snapshot_time,
        -1 AS value, 
        'Formatting' AS in_selected_time_window

    -- Order is important here since points are plotted in the order in which they are returned from the query. 
    -- The "SelectedSnapshotTimes" series must be drawn on top of the "AllSnapshotTimes" series, so we return it 
    -- last. 
    ORDER BY series_name ASC, snapshot_time
END
GO


--
-- snapshots.rpt_interval_collection_times
--  Helper proc used by other procs that need to return data from N evenly-spaced intervals within a larger user-specified time window
--  Sample usage: 
--  
--      CREATE TABLE #intervals (
--          interval_time_id        int, 
--          interval_start_time     datetimeoffset(7),
--          interval_end_time       datetimeoffset(7),
--          interval_id             int, 
--          first_collection_time   datetimeoffset(7), 
--          last_collection_time    datetimeoffset(7), 
--          first_snapshot_id       int,
--          last_snapshot_id        int, 
--          -- the following columns may be ignored if @include_snapshot_detail = 0
--          source_id               int,                
--          snapshot_id             int,
--          collection_time         datetimeoffset(7),
--          collection_time_id      int
--      )
--      -- GUID 49268954-... is the Server Activity CS
--      INSERT INTO #intervals
--      EXEC [snapshots].[rpt_interval_collection_times] 
--          @ServerName, @EndTime, @WindowSize, 'snapshots.os_memory_clerks', '49268954-4FD4-4EB6-AA04-CD59D9BB5714', 40
--      
--      SELECT ... 
--      FROM snapshots.dm_os_memory_clerks AS mc 
--      JOIN #intervals AS col ON mc.collection_time = col.last_collection_time AND mc.snapshot_id = col.last_snapshot_id
--      WHERE ...
--
--
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - End of the user-selected time window (UTC)
--    @WindowSize - Number of minutes in the time window 
--    @TargetCollectionTable - Name of the table from which to harvest the collection_time values. Must have a datetimeoffset [collection_time] 
--        column and be in the [snapshots] or [custom_snapshots] schema. 
--    @CollectionSetUid - GUID of the collection set that populates @TargetCollectionTable
--    @interval_count int - Number of time intervals to divide the time window up into (default 40)
--    @include_snapshot_detail - 0 if the caller only wants 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_interval_collection_times', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_interval_collection_times] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_interval_collection_times]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_interval_collection_times] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_interval_collection_times]
    @ServerName sysname,
    @EndTime datetime = NULL,
    @WindowSize int = NULL, 
    @TargetCollectionTable sysname, 
    @CollectionSetUid varchar(64), 
    @interval_count int = 40, 
    @include_snapshot_detail bit = 0
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @start_time_internal datetimeoffset(7);
    DECLARE @end_time_internal datetimeoffset(7);
    
    -- Start time should be passed in as a UTC datetime
    IF (@EndTime IS NOT NULL)
    BEGIN
        -- Assumed time zone offset for this conversion is +00:00 (datetime must be passed in as UTC)
        SET @end_time_internal = CAST (@EndTime AS datetimeoffset(7));
    END
    ELSE BEGIN
        SELECT @end_time_internal = MAX(snapshot_time)
        FROM core.snapshots 
        WHERE instance_name = @ServerName AND collection_set_uid = @CollectionSetUid
    END
    SET @start_time_internal = DATEADD (minute, -1 * @WindowSize, @end_time_internal);
    
    -- Get the earliest and latest snapshot_id values that could contain data for the selected time interval. 
    -- This will allow a more efficient query plan. 
    DECLARE @start_snapshot_id int;
    DECLARE @end_snapshot_id int;
    
    SELECT @start_snapshot_id = MIN (t.snapshot_id)
    FROM
    (
        SELECT TOP 2 s.snapshot_id
        FROM core.snapshots AS s 
        WHERE s.instance_name = @ServerName AND s.collection_set_uid = @CollectionSetUid
            AND s.snapshot_time < @start_time_internal
        ORDER BY s.snapshot_id DESC
    ) AS t
    
    SELECT @end_snapshot_id = MAX (t.snapshot_id) 
    FROM 
    (
        SELECT TOP 2 snapshot_id
        FROM core.snapshots AS s 
        WHERE s.instance_name = @ServerName AND s.collection_set_uid = @CollectionSetUid
            AND s.snapshot_time >= @end_time_internal
        ORDER BY s.snapshot_id ASC
    ) AS t
    
    IF @start_snapshot_id IS NULL SELECT @start_snapshot_id = MIN (snapshot_id) FROM core.snapshots
    IF @end_snapshot_id IS NULL SELECT @end_snapshot_id = MAX (snapshot_id) FROM core.snapshots
    
    -- Divide the time window up into N equal intervals.  
    -- First, calculate the duration of one interval, in minutes. 
    DECLARE @group_interval_min int
    SET @group_interval_min = ROUND (DATEDIFF (second, @start_time_internal, @end_time_internal) / 60.0 / @interval_count, 0)
    IF @group_interval_min = 0 SET @group_interval_min = 1
        
    IF (ISNULL (PARSENAME (@TargetCollectionTable, 2), 'snapshots') IN ('snapshots', 'custom_snapshots'))
    BEGIN
        /*
        Some explanation of the expressions used in the query below: 
        
        DATEDIFF (minute, ''20000101'', dataTable.collection_time) / @group_interval_min AS interval_time_id
            - @group_interval_min is the length of one time interval (one Nth of the selected time window), in minutes
            - "DATEDIFF (minute, ''20000101'', dataTable.collection_time)" converts each collection time into an integer (the # of minutes since a fixed reference date)
            - This value is divided by @group_interval_min to get an integer "interval ID".  The query uses this in the GROUP BY clause to group together all collection 
              times that fall within the same time interval.

        DATEADD (minute, (<<interval_id_expression>> * @group_interval_min, ''20000101'') AS interval_start_time
            - This uses (interval number) * (minutes/interval) + (reference date) to generate the time interval's start time 
            - The next column ([interval_end_time]) is the same as the above, except the time is calculated for the following interval ID (an interval's end time is 
              also the start time for the following time interval)
        */

        -- Get the collection times that fall within the specified time window, and compute the time interval ID for each collection time
        CREATE TABLE #snapshots (
            interval_time_id int, 
            interval_start_time datetimeoffset(7), 
            interval_end_time datetimeoffset(7), 
            interval_id int, 
            collection_time datetimeoffset(7), 
            source_id int, 
            snapshot_id int
        )

        -- Dynamic SQL will re-evaluate object permissions -- the current user must have SELECT permission on the target table. 
        DECLARE @sql nvarchar(4000)
        SET @sql = '
        INSERT INTO #snapshots 
        SELECT DISTINCT 
            DATEDIFF (minute, ''20000101'', dataTable.collection_time) / @group_interval_min AS interval_time_id, 
            DATEADD (minute, (DATEDIFF (minute, ''20000101'', dataTable.collection_time) / @group_interval_min) * @group_interval_min, ''20000101'') AS interval_start_time, 
            DATEADD (minute, (DATEDIFF (minute, ''20000101'', dataTable.collection_time) / @group_interval_min + 1) * @group_interval_min, ''20000101'') AS interval_end_time, 
            DENSE_RANK() OVER (ORDER BY DATEDIFF (minute, ''20000101'', dataTable.collection_time) / @group_interval_min) AS interval_id,  
            dataTable.collection_time, s.source_id, s.snapshot_id 
        FROM ' + ISNULL (QUOTENAME (PARSENAME (@TargetCollectionTable, 2)), '[snapshots]') + '.' + QUOTENAME (PARSENAME (@TargetCollectionTable, 1)) + ' AS dataTable
        INNER JOIN core.snapshots AS s ON dataTable.snapshot_id = s.snapshot_id
        WHERE dataTable.collection_time BETWEEN @start_time_internal AND @end_time_internal
            AND s.snapshot_id BETWEEN @start_snapshot_id AND @end_snapshot_id
            AND s.instance_name = @ServerName AND s.collection_set_uid = @CollectionSetUid'
        
        EXEC sp_executesql 
            @sql, 
            N'@ServerName sysname, @CollectionSetUid nvarchar(64), @start_time_internal datetimeoffset(7), @end_time_internal datetimeoffset(7), @group_interval_min int, 
                @start_snapshot_id int, @end_snapshot_id int', 
            @ServerName = @ServerName, @CollectionSetUid = @CollectionSetUid, @start_time_internal = @start_time_internal, @end_time_internal = @end_time_internal, 
            @group_interval_min = @group_interval_min, @start_snapshot_id = @start_snapshot_id, @end_snapshot_id = @end_snapshot_id
        
        
        -- If the caller doesn't care about anything but the interval boundaries, don't bother returning the collection_time/snapshot_id values
        -- that fall in the middle of an interval. 
        IF (@include_snapshot_detail = 0)
        BEGIN
            SELECT interval_time_id, interval_start_time, interval_end_time, interval_id, 
                MIN (collection_time) AS first_collection_time, MAX (collection_time) AS last_collection_time, 
                MIN (snapshot_id) AS first_snapshot_id, MAX (snapshot_id) AS last_snapshot_id, 
                NULL AS source_id, NULL AS snapshot_id, NULL AS collection_time, NULL AS collection_time_id
            FROM #snapshots
            GROUP BY interval_time_id, interval_start_time, interval_end_time, interval_id
            ORDER BY interval_time_id
        END
        ELSE
        BEGIN
            SELECT interval_info.*, #snapshots.source_id, #snapshots.snapshot_id, #snapshots.collection_time, 
                DENSE_RANK() OVER (ORDER BY #snapshots.collection_time) AS collection_time_id
            FROM 
            (
                SELECT interval_time_id, interval_start_time, interval_end_time, interval_id, 
                    MIN (collection_time) AS first_collection_time, MAX (collection_time) AS last_collection_time, 
                    MIN (snapshot_id) AS first_snapshot_id, MAX (snapshot_id) AS last_snapshot_id
                FROM #snapshots
                GROUP BY interval_time_id, interval_start_time, interval_end_time, interval_id
            ) AS interval_info
            INNER JOIN #snapshots ON interval_info.interval_time_id = #snapshots.interval_time_id
            ORDER BY interval_info.interval_time_id, #snapshots.collection_time
        END
    END
    ELSE BEGIN
        /* Invalid parameter %s specified for %s. */
        RAISERROR (21055, 16, -1, @TargetCollectionTable, '@TargetCollectionTable')
    END
    
END;
GO


--
-- snapshots.rpt_next_and_previous_collection_times
--  Helper proc used by other procs that need to return data from N evenly-spaced intervals within a larger user-specified time window
--
--
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @CollectionTime - End of the user-selected time window (UTC)
--    @TargetCollectionTable - Name of the table from which to harvest the collection_time values. Must have a datetimeoffset [collection_time] 
--        column and be in the [snapshots] or [custom_snapshots] schema. 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_next_and_previous_collection_times', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_next_and_previous_collection_times] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_next_and_previous_collection_times]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_next_and_previous_collection_times] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROC [snapshots].[rpt_next_and_previous_collection_times]
    @ServerName sysname, 
    @CollectionTime datetime, 
    @DataGroupID nvarchar(128)
AS
BEGIN
    DECLARE @current_collection_time datetimeoffset(7)  -- current collection time
    DECLARE @current_snapshot_id int                    -- current collection time''s snapshot ID
    DECLARE @previous_collection_time datetimeoffset(7) -- next collection time
    DECLARE @next_collection_time datetimeoffset(7)     -- prior collection time
    DECLARE @snapshot_table sysname                     -- name of the snapshot table we'll be querying
    
    -- The assumed time zone offset for this conversion is +00:00 (datetime must be passed in as UTC)
    SET @current_collection_time = CAST (@CollectionTime AS datetimeoffset(7));
    -- Compensate for RS truncation of fractional seconds 
    SET @current_collection_time = DATEADD(second, 1, @CollectionTime);
    
    -- Currently, we only call this stored procedure from one place, and that code only needs next and prev collection times for 
    -- the snapshots.active_sessions_and_requests table. If, in the future, we need to call this for other tables, the three 
    -- SELECT TOP 1 queries below will need to be converted to dynamic SQL, executed via sp_executesql with OUTPUT parameters.  
    -- The correct target table name (@snapshot_table) should be determined based on the @DataGroupID parameter.  
    IF (@DataGroupID = 'SqlActiveRequests')
    BEGIN
        SET @snapshot_table = 'snapshots.active_sessions_and_requests';
    END
    ELSE BEGIN
        /* Invalid parameter %s specified for %s. */
        RAISERROR (21055, 16, -1, @DataGroupID, '@DataGroupID');
        RETURN;
    END
    
    DECLARE @sql nvarchar(max);

    -- Find our exact collection time using the approx time passed in   
    SELECT TOP 1 @current_collection_time = r.collection_time, @current_snapshot_id = r.snapshot_id
    FROM core.snapshots AS s
    INNER JOIN snapshots.active_sessions_and_requests AS r ON s.snapshot_id = r.snapshot_id
    WHERE s.instance_name = @ServerName
        AND r.collection_time <= @current_collection_time
    ORDER BY collection_time DESC;
    
    -- Find the previous collection time
    SELECT TOP 1 @previous_collection_time = r.collection_time
    FROM core.snapshots AS s
    INNER JOIN snapshots.active_sessions_and_requests AS r ON s.snapshot_id = r.snapshot_id
    WHERE s.instance_name = @ServerName
      AND r.collection_time < @current_collection_time 
    ORDER BY collection_time DESC;
    
    -- Find the next collection time
    SELECT TOP 1 @next_collection_time = r.collection_time
    FROM core.snapshots AS s
    INNER JOIN snapshots.active_sessions_and_requests AS r ON s.snapshot_id = r.snapshot_id
    WHERE s.instance_name = @ServerName
      AND r.collection_time > @current_collection_time 
    ORDER BY collection_time ASC;

    IF @previous_collection_time IS NULL SET @previous_collection_time = @current_collection_time;
    IF @next_collection_time IS NULL SET @next_collection_time = @current_collection_time;

    SELECT 
        CONVERT (datetime, SWITCHOFFSET (@current_collection_time, '+00:00')) AS current_collection_time, 
        @current_snapshot_id AS current_snapshot_id, 
        CONVERT (datetime, SWITCHOFFSET (@previous_collection_time, '+00:00')) AS previous_collection_time, 
        CONVERT (datetime, SWITCHOFFSET (@next_collection_time, '+00:00')) AS next_collection_time;
END
GO


--
-- snapshots.rpt_generic_perfmon
--  Returns perf counter data for the counters associated with a "data group id" (typically, a report name). 
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - End of selected time window end (UTC)
--    @WindowSize - Number of minutes in the time window
--    @DataGroupID - Name of the report, used to return only the necessary counters
--    @CollectionSetUid - GUID identifier for the target collection set
--    @interval_count - Number of time intervals to divide the time window into (default 40)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_generic_perfmon', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_generic_perfmon] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_generic_perfmon]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_generic_perfmon] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_generic_perfmon]
    @ServerName sysname, 
    @EndTime datetime, 
    @WindowSize int, 
    @DataGroupID nvarchar(128), 
    @CollectionSetUid nvarchar(64), 
    @interval_count int = 40
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @start_time_internal datetimeoffset(7);
    DECLARE @end_time_internal datetimeoffset(7);
    
    -- Start time should be passed in as a UTC datetime
    IF (@EndTime IS NOT NULL)
    BEGIN
        -- Assumed time zone offset for this conversion is +00:00 (datetime must be passed in as UTC)
        SET @end_time_internal = CAST (@EndTime AS datetimeoffset(7));
    END
    ELSE BEGIN
        SELECT @end_time_internal = MAX(snapshot_time)
        FROM core.snapshots 
        WHERE instance_name = @ServerName AND collection_set_uid = @CollectionSetUid
    END
    SET @start_time_internal = DATEADD (minute, -1 * @WindowSize, @end_time_internal);
    
    -- Divide the time window up into N equal intervals.  Each interval will correspond to one 
    -- point on a line chart.  Calc the duration of one interval, in seconds. 
    DECLARE @group_interval_sec int
    IF @interval_count < 1 SET @interval_count = 1
    SET @group_interval_sec = ROUND (DATEDIFF (second, @start_time_internal, @end_time_internal) / @interval_count, 0)
    IF @group_interval_sec < 10 SET @group_interval_sec = 10

    -- For counter groups that include the "Process(abc)\% Processor Time" counter (e.g. 'ServerActivity' and 'SystemCpuUsagePivot'), 
    -- we must determine the logical CPU count on the target system by querying the number of "Processor" counter instances we 
    -- captured in a perfmon sample that was captured around the same time. 
    DECLARE @cpu_count smallint
    SET @cpu_count = 1
    IF EXISTS (
        SELECT * FROM [core].[performance_counter_report_group_items] 
        WHERE counter_group_id = @DataGroupID AND [divide_by_cpu_count] = 1
    )
    BEGIN
        SELECT @cpu_count = COUNT (DISTINCT pc.performance_instance_name)
        FROM snapshots.performance_counters AS pc
        INNER JOIN core.snapshots s ON s.snapshot_id = pc.snapshot_id 
        WHERE pc.performance_object_name = 'Processor' AND pc.performance_counter_name = '% Processor Time'
            AND pc.performance_instance_name != '_Total' AND ISNUMERIC (pc.performance_instance_name) = 1
            AND s.instance_name = @ServerName AND s.collection_set_uid = @CollectionSetUid
            AND s.snapshot_id = 
                (SELECT TOP 1 s2.snapshot_id FROM core.snapshots AS s2 
                INNER JOIN snapshots.performance_counters AS pc2 ON s2.snapshot_id = pc2.snapshot_id 
                WHERE s2.snapshot_time > @start_time_internal
                    AND s2.instance_name = @ServerName AND s2.collection_set_uid = @CollectionSetUid
                    AND pc2.performance_object_name = 'Processor' AND pc2.performance_counter_name = '% Processor Time')
            AND pc.collection_time = 
                (SELECT TOP 1 collection_time FROM snapshots.performance_counter_values pcv2 WHERE pcv2.snapshot_id = s.snapshot_id)
        -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
        OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
        
        IF ISNULL (@cpu_count, 0) = 0
        BEGIN
            -- This message will never be shown on a report. It is included here only as a troubleshooting aid. 
            RAISERROR ('Unable to determine CPU count. Assuming 1 CPU for process CPU calculations', 9, 1)
            SET @cpu_count = 1
        END
    END

    -- Get the matching performance counter instances for this data group
    SELECT 
        pci.*, 
        cl.counter_group_item_id, cl.counter_group_id, cl.counter_subgroup_id, cl.series_name, 
        cl.multiply_by, cl.divide_by_cpu_count
    INTO #pci
    FROM snapshots.performance_counter_instances AS pci
    INNER JOIN [core].[performance_counter_report_group_items] AS cl 
        ON cl.counter_group_id = @DataGroupID
        AND pci.counter_name = cl.counter_name 
        AND ISNULL(pci.instance_name, N'') LIKE cl.instance_name 
        AND 
        (
            (cl.object_name_wildcards = 0 AND pci.[object_name] = cl.[object_name])
            OR (cl.object_name_wildcards = 1 AND pci.[object_name] LIKE cl.[object_name])
        )
        AND (cl.not_instance_name IS NULL OR pci.instance_name NOT LIKE cl.not_instance_name);
    
    -- Get the perfmon counter values for these counters in each time interval. 
    -- NOTE: If you change the schema of this resultset, you must also update the CREATE TABLE in [rpt_generic_perfmon_pivot]. 
    SELECT 
        #pci.counter_subgroup_id, 
        REPLACE (#pci.series_name, '[COUNTER_INSTANCE]', ISNULL(#pci.instance_name, N'')) AS series_name, 
        -- Using our time window end time (@end_time_internal) as a reference point, divide 
        -- the time window into [@interval_count] intervals of [@group_interval_sec] duration 
        -- per interval. 
        DATEDIFF (second, @end_time_internal, SWITCHOFFSET (CONVERT (datetimeoffset(7), pc.collection_time), '+00:00')) / @group_interval_sec AS interval_id, 
        -- Find the end time for the current time interval, and return as a UTC datetime
        -- Do this by converting [collection_time] into a second count, dividing and multiplying 
        -- the count by [@group_interval_sec] to discard any fraction of an interval, then 
        -- converting the second count back into a datetime.  That datetime is the end point for 
        -- the time interval that this [collection_time] value falls within. 
        CONVERT (datetime, 
            DATEADD (
                second, 
                (DATEDIFF (second, @end_time_internal, SWITCHOFFSET (CONVERT (datetimeoffset(7), pc.collection_time), '+00:00')) / @group_interval_sec) * @group_interval_sec, 
                @end_time_internal
            ) 
        ) AS interval_end_time, 
        #pci.counter_name, 
        AVG( pc.formatted_value * #pci.multiply_by / CASE WHEN #pci.divide_by_cpu_count = 1 THEN @cpu_count ELSE 1 END ) AS avg_formatted_value, 
        MAX( pc.formatted_value * #pci.multiply_by / CASE WHEN #pci.divide_by_cpu_count = 1 THEN @cpu_count ELSE 1 END ) AS max_formatted_value, 
        MIN( pc.formatted_value * #pci.multiply_by / CASE WHEN #pci.divide_by_cpu_count = 1 THEN @cpu_count ELSE 1 END ) AS min_formatted_value, 
        -- This column can be used to simulate a "_Total" instance for multi-instance counters that lack _Total -- use a "%" for #counterlist.instance_name
        -- Expression "1.0 * pc.formatted_value * cl.multiply_by / CASE WHEN cl.divide_by_cpu_count = 1 THEN @cpu_count ELSE 1 END" is the counter value. 
        -- Expression "AVG(<counter_value>) * COUNT (DISTINCT pc.performance_instance_name)" returns the simulated "_Total" instance.
        -- Only valid for multi-instance counters that don't already have a "_Total"). 
        CONVERT (bigint, AVG( 1.0 * pc.formatted_value * #pci.multiply_by / CASE WHEN #pci.divide_by_cpu_count = 1 THEN @cpu_count ELSE 1 END)) 
            * COUNT (DISTINCT #pci.instance_name) AS multi_instance_avg_formatted_value
    FROM snapshots.performance_counter_values AS pc
    INNER JOIN #pci ON #pci.performance_counter_id = pc.performance_counter_instance_id
    INNER JOIN core.snapshots s ON s.snapshot_id = pc.snapshot_id
    WHERE s.instance_name = @ServerName AND s.collection_set_uid = @CollectionSetUid
        AND pc.collection_time BETWEEN @start_time_internal AND @end_time_internal
    GROUP BY 
        DATEDIFF (second, @end_time_internal, SWITCHOFFSET (CONVERT (datetimeoffset(7), pc.collection_time), '+00:00')) / @group_interval_sec, #pci.counter_subgroup_id, 
        #pci.counter_name, 
        REPLACE (#pci.series_name, '[COUNTER_INSTANCE]', ISNULL(#pci.instance_name, N''))
    ORDER BY #pci.counter_subgroup_id, interval_end_time, 2, #pci.counter_name
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END
GO


--
-- snapshots.rpt_generic_perfmon_pivot
--  Pivots the output of [rpt_generic_perfmon] so that multiple counter values can be returned in a 
--  single row. The value of all counters with the same [series_name] will be returned as a single row. 
--  The average of all values in the time window is returned
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - End of selected time window end (UTC)
--    @WindowSize - Number of minutes in the time window
--    @DataGroupID - Name of the calling report (used to retrieve the correct counters)
--    @CollectionSetUid - GUID identifier for the target collection set
--    @interval_count - Number of time intervals to divide the time window into (default 40)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_generic_perfmon_pivot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_generic_perfmon_pivot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_generic_perfmon_pivot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_generic_perfmon_pivot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_generic_perfmon_pivot]
    @ServerName sysname, 
    @EndTime datetime, 
    @WindowSize int, 
    @DataGroupID nvarchar(128), 
    @CollectionSetUid varchar(64), 
    @interval_count int = 1
AS
BEGIN
    SET NOCOUNT ON;

    CREATE TABLE #countervalues (
        counter_subgroup_id nvarchar(512),          -- name of the data subgroup (e.g. chart or table) that requested the counter (used by a chart to filter out its rows from the larger resultset)
        series_name nvarchar(1024),                 -- chart series label 
        interval_id int,                            -- not used here
        interval_end_time datetime,                 -- not used here
        performance_counter_name nvarchar(2048),    -- perfmon counter name
        avg_formatted_value bigint,                 -- avg perfmon counter value over the time period
        max_formatted_value bigint,                 -- max perfmon counter value over the time period
        min_formatted_value bigint,                 -- min perfmon counter value over the time period
        multi_instance_avg_formatted_value bigint   -- simulated "_Total" instance value for multi-instance counters that lack _Total
    )
    
    SET @DataGroupID = @DataGroupID + 'Pivot'
    INSERT INTO #countervalues
    EXEC [snapshots].[rpt_generic_perfmon] 
        @ServerName, 
        @EndTime, 
        @WindowSize, 
        @DataGroupID, 
        @CollectionSetUid, 
        @interval_count

    IF EXISTS (SELECT * FROM #countervalues)
    BEGIN
        -- @counterlist looks like "[Counter 1], [Counter 2]"
        DECLARE @counterlist nvarchar(max)
        -- @columnlist_min_inner looks like "[Counter 1] AS [Counter 1_min], [Counter 2] AS [Counter 2_min]"
        DECLARE @columnlist_min_inner nvarchar(max)
        -- @columnlist_max_inner looks like "[Counter 1] AS [Counter 1_max], [Counter 2] AS [Counter 2_max]"
        DECLARE @columnlist_max_inner nvarchar(max)
        -- @columnlist_min_outer looks like "[Counter 1_min], [Counter 2_min]"
        DECLARE @columnlist_min_outer nvarchar(max)
        -- @columnlist_max_outer looks like "[Counter 1_max], [Counter 2_max]"
        DECLARE @columnlist_max_outer nvarchar(max)
        SET @counterlist = ''
        SET @columnlist_min_inner = ''
        SET @columnlist_min_outer = ''
        SET @columnlist_max_inner = ''
        SET @columnlist_max_outer = ''
        
        -- Build counter lists
        SELECT 
            @counterlist = @counterlist 
                -- Escape any embedded ']' chars (we can't use QUOTENAME because it can't handle strings > 128 chars)
                + ', [' + REPLACE (performance_counter_name, ']', ']]') + ']'
            , @columnlist_min_outer = @columnlist_min_outer + ', [' + REPLACE (performance_counter_name, ']', ']]') + '_min]'
            , @columnlist_min_inner = @columnlist_min_inner + ', [' + REPLACE (performance_counter_name, ']', ']]') + ']'
                + ' AS [' + REPLACE (performance_counter_name, ']', ']]') + '_min]'
            , @columnlist_max_outer = @columnlist_max_outer + ', [' + REPLACE (performance_counter_name, ']', ']]') + '_max]'
            , @columnlist_max_inner = @columnlist_max_inner + ', [' + REPLACE (performance_counter_name, ']', ']]') + ']'
                + ' AS [' + REPLACE (performance_counter_name, ']', ']]') + '_max]'
        FROM (SELECT DISTINCT performance_counter_name FROM #countervalues) AS t
        GROUP BY performance_counter_name 
        OPTION (MAXDOP 1)
        -- Remove the leading comma
        SET @counterlist = SUBSTRING (@counterlist, 3, LEN (@counterlist)-2)
        SET @columnlist_min_inner = SUBSTRING (@columnlist_min_inner, 3, LEN (@columnlist_min_inner)-2)
        SET @columnlist_min_outer = SUBSTRING (@columnlist_min_outer, 3, LEN (@columnlist_min_outer)-2)
        SET @columnlist_max_inner = SUBSTRING (@columnlist_max_inner, 3, LEN (@columnlist_max_inner)-2)
        SET @columnlist_max_outer = SUBSTRING (@columnlist_max_outer, 3, LEN (@columnlist_max_outer)-2)

        -- We have to use three PIVOTs here because SQL only allows one aggregate function 
        -- per PIVOT, and we need AVG, MIN, and MAX.  They are over a very small temp table, 
        -- though (by default just one row per counter), so the execution cost isn't 
        -- excessive. 
        DECLARE @sql nvarchar(max)
        SET @sql = '
            SELECT avg_pivot.*, ' + @columnlist_min_outer + ', ' + @columnlist_max_outer + '
            FROM 
            (
                SELECT series_name, interval_end_time, ' + @counterlist + '
                FROM 
                (
                    SELECT series_name, interval_end_time, performance_counter_name, avg_formatted_value
                    FROM #countervalues
                ) AS SourceTable
                PIVOT 
                (
                    AVG (avg_formatted_value) 
                    FOR performance_counter_name IN (' + @counterlist + ')
                ) AS PivotTable
            ) AS avg_pivot
            
            INNER JOIN 
            (
                SELECT series_name, interval_end_time, ' + @columnlist_min_inner + '
                FROM 
                (
                    SELECT series_name, interval_end_time, performance_counter_name, min_formatted_value
                    FROM #countervalues
                ) AS SourceTable
                PIVOT 
                (
                    MIN (min_formatted_value) 
                    FOR performance_counter_name IN (' + @counterlist + ')
                ) AS PivotTable
            ) AS min_pivot ON min_pivot.series_name = avg_pivot.series_name AND min_pivot.interval_end_time = avg_pivot.interval_end_time
            
            INNER JOIN 
            (
                SELECT series_name, interval_end_time, ' + @columnlist_max_inner + '
                FROM 
                (
                    SELECT series_name, interval_end_time, performance_counter_name, max_formatted_value
                    FROM #countervalues
                ) AS SourceTable
                PIVOT 
                (
                    MAX (max_formatted_value) 
                    FOR performance_counter_name IN (' + @counterlist + ')
                ) AS PivotTable
            ) AS max_pivot ON max_pivot.series_name = avg_pivot.series_name AND max_pivot.interval_end_time = avg_pivot.interval_end_time
            '
        EXEC sp_executesql @sql
    END
END;
GO


--
-- snapshots.rpt_wait_stats
--  Returns wait time per wait type over a time interval
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - End of the user-selected time window (UTC)
--    @WindowSize - Number of minutes in the time window 
--    @CategoryName - (Optional) Name of wait category to filter on (all categories if NULL)
--    @WaitType - (Optional) Name of wait type to filter on (all wait types if NULL)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_wait_stats', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_wait_stats] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_wait_stats]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_wait_stats] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_wait_stats]
    @ServerName sysname,
    @EndTime datetime = NULL,
    @WindowSize int,
    @CategoryName nvarchar(20) = NULL, 
    @WaitType nvarchar(45) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Clean string params (on drillthrough, RS may pass in empty string instead of NULL)
    IF @CategoryName = '' SET @CategoryName = NULL
    IF @WaitType = '' SET @WaitType = NULL

    -- Divide our time window up into 40 evenly-sized time intervals, and find the last collection_time within each of these intervals
    CREATE TABLE #intervals (
        interval_time_id        int, 
        interval_start_time     datetimeoffset(7),
        interval_end_time       datetimeoffset(7),
        interval_id             int, 
        first_collection_time   datetimeoffset(7), 
        last_collection_time    datetimeoffset(7), 
        first_snapshot_id       int,
        last_snapshot_id        int, 
        source_id               int,
        snapshot_id             int, 
        collection_time         datetimeoffset(7), 
        collection_time_id      int
    )
    -- GUID 49268954-... is Server Activity
    INSERT INTO #intervals
    EXEC [snapshots].[rpt_interval_collection_times] 
        @ServerName, @EndTime, @WindowSize, 'snapshots.os_wait_stats', '49268954-4FD4-4EB6-AA04-CD59D9BB5714', 40, 0

    -- Get the earliest and latest snapshot_id values that contain data for the selected time interval. 
    -- This will allow a more efficient query plan. 
    DECLARE @start_snapshot_id int;
    DECLARE @end_snapshot_id int;
    SELECT @start_snapshot_id = MIN (first_snapshot_id)
    FROM #intervals
    SELECT @end_snapshot_id = MAX (last_snapshot_id)
    FROM #intervals
    
    -- Get the wait stats for these collection times
    SELECT 
        coll.interval_time_id, coll.interval_id, 
        last_collection_time AS collection_time, 
        coll.interval_start_time, 
        coll.interval_end_time, 
        coll.last_snapshot_id, 
        wt.category_name, ws.wait_type, ws.waiting_tasks_count, 
        ISNULL (ws.signal_wait_time_ms, 0) AS signal_wait_time_ms, 
        ISNULL (ws.wait_time_ms, 0) - ISNULL (ws.signal_wait_time_ms, 0) AS wait_time_ms, 
        wait_time_ms AS raw_wait_time_ms, 
        ISNULL (ws.wait_time_ms, 0) AS wait_time_ms_cumulative 
    INTO #wait_stats
    FROM snapshots.os_wait_stats AS ws
    INNER JOIN #intervals AS coll ON coll.last_snapshot_id = ws.snapshot_id AND coll.last_collection_time = ws.collection_time 
    INNER JOIN core.wait_types_categorized AS wt ON wt.wait_type = ws.wait_type
    WHERE wt.category_name = ISNULL (@CategoryName, wt.category_name)
        AND wt.wait_type = ISNULL (@WaitType, wt.wait_type)
        AND wt.ignore != 1

    -- Get wait times by waittype for each interval (plus CPU time, modeled as a waittype)
    ---- First get resource wait stats for this interval. We must convert all datetimeoffset values 
    ---- to UTC datetime values before returning to Reporting Services
    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (w1.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w1.interval_start_time AS datetimeoffset(7)), '+00:00')) AS interval_start, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.interval_start_time AS datetimeoffset(7)), '+00:00')) AS interval_end, 
        w2.category_name, w2.wait_type, 
        -- All wait stats will be reset to zero by a service cycle, which will cause 
        -- (snapshot2waittime-snapshot1waittime) calculations to produce an incorrect 
        -- negative wait time for the interval.  Detect this and avoid calculating 
        -- negative wait time/wait count/signal time deltas. 
        CASE 
            WHEN (w2.waiting_tasks_count - w1.waiting_tasks_count) < 0 THEN w2.waiting_tasks_count 
            ELSE (w2.waiting_tasks_count - w1.waiting_tasks_count) 
        END AS waiting_tasks_count_delta, 
        CASE 
            WHEN (w2.raw_wait_time_ms - w1.raw_wait_time_ms) < 0 THEN w2.wait_time_ms
            ELSE (w2.wait_time_ms - w1.wait_time_ms)
        END AS resource_wait_time_delta, -- / CAST (DATEDIFF (second, w1.collection_time, w2.collection_time) AS decimal) 
        CASE 
            WHEN (w2.signal_wait_time_ms - w1.signal_wait_time_ms) < 0 THEN w2.signal_wait_time_ms 
            ELSE (w2.signal_wait_time_ms - w1.signal_wait_time_ms) 
        END AS resource_signal_time_delta, -- / CAST (DATEDIFF (second, w1.collection_time, w2.collection_time) AS decimal) 
        DATEDIFF (second, w1.collection_time, w2.collection_time) AS interval_sec, 
        w2.wait_time_ms_cumulative
    -- Self-join - w1 represents wait stats at the beginning of the sample interval, while w2 
    -- shows the wait stats at the end of the interval. 
    FROM #wait_stats AS w1 
    INNER JOIN #wait_stats AS w2 ON w1.wait_type = w2.wait_type AND w1.interval_id = w2.interval_id-1 

    UNION ALL 

    ---- Treat the sum of all signal waits as CPU "wait time"
    SELECT 
        MAX (CONVERT (datetime, SWITCHOFFSET (CAST (w1.collection_time AS datetimeoffset(7)), '+00:00'))) AS collection_time, 
        MIN (CONVERT (datetime, SWITCHOFFSET (CAST (w1.interval_start_time AS datetimeoffset(7)), '+00:00'))) AS interval_start, 
        MAX (CONVERT (datetime, SWITCHOFFSET (CAST (w2.interval_start_time AS datetimeoffset(7)), '+00:00'))) AS interval_end, 
        'CPU' AS category_name, 
        'CPU (Signal Wait)' AS wait_type, 
        0 AS waiting_tasks_count_delta, 
        -- Handle wait stats resets, as in the previous query
        SUM (
            CASE 
                WHEN (w2.signal_wait_time_ms - w1.signal_wait_time_ms) < 0 THEN w2.signal_wait_time_ms
                ELSE (w2.signal_wait_time_ms - w1.signal_wait_time_ms) 
            END -- / CAST (DATEDIFF (second, w1.collection_time, w2.collection_time) AS decimal)
        ) AS resource_wait_time_delta, 
        0 AS resource_signal_time_delta, 
        DATEDIFF (second, w1.collection_time, w2.collection_time) AS interval_sec, 
        NULL AS wait_time_ms_cumulative
    FROM #wait_stats AS w1
    INNER JOIN #wait_stats AS w2 ON w1.wait_type = w2.wait_type AND w1.interval_id = w2.interval_id-1
    -- Only return CPU stats if we were told to return the 'CPU' category or all categories
    WHERE (@CategoryName IS NULL OR @CategoryName = 'CPU')
    GROUP BY 
        w1.interval_start_time, w2.interval_start_time, w1.interval_end_time, w2.interval_end_time, w1.collection_time, w2.collection_time

    UNION ALL 

    -- Get actual used CPU time from perfmon data (average across the whole snapshot_time_id interval, 
    -- and use this average for each sample time in this interval).  Note that the "% Processor Time" 
    -- counter in the "Process" object can exceed 100% (for example, it can range from 0-800% on an 
    -- 8 CPU server). 
    SELECT
        CONVERT (datetime, SWITCHOFFSET (CAST (w1.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w1.interval_start_time AS datetimeoffset(7)), '+00:00')) AS interval_start, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.interval_start_time AS datetimeoffset(7)), '+00:00')) AS interval_end, 
        'CPU' AS category_name, 
        'CPU (Consumed)' AS wait_type, 
        0 AS waiting_tasks_count_delta, 
        -- Get sqlservr %CPU usage for the perfmon sample that immediately precedes each wait stats sample.  
        -- Multiply by 10 to convert "% CPU" to "ms CPU/sec". This works because (for example) on an 8 proc 
        -- server, Process(...)\% Processor Time ranges from 0 to 800, not 0 to 100.  Multiply again by 
        -- the duration of interval in seconds to get the total ms of CPU time used in the interval. 
        DATEDIFF (second, w1.collection_time, w2.collection_time) * 10 * ( 
            SELECT TOP 1 formatted_value
            FROM snapshots.performance_counters AS pc
            INNER JOIN core.snapshots s ON pc.snapshot_id = s.snapshot_id
            WHERE pc.performance_object_name = 'Process' AND pc.performance_counter_name = '% Processor Time' 
                AND pc.performance_instance_name = '$(TARGETPROCESS)'
                AND pc.collection_time <= w2.collection_time
                AND s.instance_name = @ServerName AND s.collection_set_uid = '49268954-4FD4-4EB6-AA04-CD59D9BB5714' -- Server Activity CS
                AND s.snapshot_id BETWEEN @start_snapshot_id AND @end_snapshot_id 
            ORDER BY pc.collection_time DESC
        ) AS resource_wait_time_delta, 
        0 AS resource_signal_time_delta, 
        DATEDIFF (second, w1.collection_time, w2.collection_time) AS interval_sec, 
        NULL AS wait_time_ms_cumulative
    FROM #wait_stats AS w1
    INNER JOIN #wait_stats AS w2 ON w1.wait_type = w2.wait_type AND w1.interval_id = w2.interval_id-1
    -- Only return CPU stats if we weren't passed in a specific wait category
    WHERE (@CategoryName IS NULL OR @CategoryName = 'CPU')
    GROUP BY 
        w1.interval_start_time, w2.interval_start_time, w1.interval_end_time, w2.interval_end_time, w1.collection_time, w2.collection_time

    ORDER BY category_name, collection_time, wait_type
    -- These trace flags are necessary for a good plan, due to the join on ascending core.snapshot PK
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390);
    
END
GO


--
-- snapshots.fn_hexstrtovarbin
--  Converts a hex string into a varbinary(max). Reporting Services does not support binary 
--  form parameters, so sql_handle and plan_handle values must be passed to and from RS as strings. 
--  For conversion in the opposite direction, use master.dbo.fn_varbintohexstr. 
-- Parameters: 
--    @hexStr - a string representation of a binary value (e.g. "0x123C2F")
-- Returns: the input value converted to a true varbinary
--
IF (NOT OBJECT_ID (N'[snapshots].[fn_hexstrtovarbin]', 'FN') IS NULL)
BEGIN
    RAISERROR('Dropping function [snapshots].[fn_hexstrtovarbin] ...', 0, 1)  WITH NOWAIT;
    DROP FUNCTION [snapshots].[fn_hexstrtovarbin]
END
GO 

RAISERROR('Creating function [snapshots].[fn_hexstrtovarbin] ...', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [snapshots].[fn_hexstrtovarbin]
(
    @hexStr varchar(max) 
)
RETURNS varbinary(max)
AS
BEGIN
    DECLARE @ret varbinary(max)
    DECLARE @len int

    SET @ret = 0x;
    SET @len = LEN (@hexStr)-2;

    IF (@len >= 0) AND (LEFT (@hexStr, 2) = '0x')
        SET @hexStr = SUBSTRING (@hexStr, 3, @len);
    ELSE
        RETURN NULL;

    DECLARE @leftNibbleChar char(1), @rightNibbleChar char(1), @hexCharStr varchar(2)
    DECLARE @leftNibble int, @rightNibble int
    DECLARE @i int;
    SET @i = 1;
    WHILE (@i <= @len)
    BEGIN
        SET @hexCharStr = SUBSTRING (@hexStr, @i, 2)
        IF LEN (@hexCharStr) = 1 SET @hexCharStr = '0' + @hexCharStr
        SET @leftNibbleChar = LOWER (LEFT (@hexCharStr, 1))
        SET @rightNibbleChar = LOWER (RIGHT (@hexCharStr, 1))

        IF @leftNibbleChar BETWEEN 'a' AND 'f' COLLATE Latin1_General_BIN 
           SET @leftNibble = (CONVERT (int, CONVERT (binary(1), @leftNibbleChar)) - CONVERT (int, CONVERT (binary(1), 'a')) + 10) * 16;
        ELSE IF @leftNibbleChar BETWEEN '0' AND '9' COLLATE Latin1_General_BIN 
           SET @leftNibble = (CONVERT (int, CONVERT (binary(1), @leftNibbleChar)) - CONVERT (int, CONVERT (binary(1), '0'))) * 16;
        ELSE
            RETURN NULL;

        IF @rightNibbleChar BETWEEN 'a' AND 'f' COLLATE Latin1_General_BIN 
           SET @rightNibble = (CONVERT (int, CONVERT (binary(1), @rightNibbleChar)) - CONVERT (int, CONVERT (binary(1), 'a')) + 10);
        ELSE IF @rightNibbleChar  BETWEEN '0' AND '9' COLLATE Latin1_General_BIN 
           SET @rightNibble = (CONVERT (int, CONVERT (binary(1), @rightNibbleChar)) - CONVERT (int, CONVERT (binary(1), '0')));
        ELSE
            RETURN NULL;

        SET @ret = @ret + CONVERT (binary(1), @leftNibble + @rightNibble)
        SET @i = @i + 2
    END

    RETURN @ret
END
GO


--
-- snapshots.rpt_top_query_stats
--  Returns aggregate query stats for the most expensive notable queries observed 
--  over the specified time interval.
--  Returns the top 10 most expensive plans (ranking criteria is specified via @order_by_criteria). 
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--    @order_by_criteria - (Optional) 'CPU' (default), 'Physical Reads', 'Logical Writes', 'I/O' (reads + writes), or 'Duration'
--    @database_name - Optional filter criteria: Only queries within a particular database
--
IF (NOT OBJECT_ID(N'snapshots.rpt_top_query_stats', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_top_query_stats] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_top_query_stats]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_top_query_stats] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_top_query_stats]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint = NULL,
    @time_interval_min smallint = 1, 
    @order_by_criteria varchar(30) = 'CPU', 
    @database_name nvarchar(255) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Clean string params (on drillthrough, RS may pass in an empty string instead of NULL)
    IF @database_name = '' SET @database_name = NULL

    -- @end_time should never be NULL when we are called from the Query Stats report
    -- Convert snapshot_time (datetimeoffset) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;

    DECLARE @interval_sec int;
    SET @interval_sec = DATEDIFF (s, @start_time, @end_time)

    SELECT 
        REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (
            LEFT (LTRIM (stmtsql.query_text), 100)
            , CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '), '   ', ' '), '  ', ' '), '  ', ' ') AS flat_query_text, 
        t.*, 
        master.dbo.fn_varbintohexstr (t.sql_handle) AS sql_handle_str, 
        stmtsql.*
    FROM 
    (
        SELECT TOP 10 
            stat.sql_handle, stat.statement_start_offset, stat.statement_end_offset, snap.source_id, 
            SUM (stat.snapshot_execution_count) AS execution_count, 
            SUM (stat.snapshot_execution_count) / (@interval_sec / 60) AS executions_per_min, 
            SUM (stat.snapshot_worker_time / 1000) AS total_cpu, 
            SUM (stat.snapshot_worker_time / 1000) / @interval_sec AS avg_cpu_per_sec, 
            SUM (stat.snapshot_worker_time / 1000.0) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_cpu_per_exec, 
            SUM (stat.snapshot_physical_reads) AS total_physical_reads, 
            SUM (stat.snapshot_physical_reads) / @interval_sec AS avg_physical_reads_per_sec, 
            SUM (stat.snapshot_physical_reads) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_physical_reads_per_exec, 
            SUM (stat.snapshot_logical_writes) AS total_logical_writes, 
            SUM (stat.snapshot_logical_writes) / @interval_sec AS avg_logical_writes_per_sec, 
            SUM (stat.snapshot_logical_writes) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_logical_writes_per_exec, 
            SUM (stat.snapshot_elapsed_time / 1000) AS total_elapsed_time, 
            SUM (stat.snapshot_elapsed_time / 1000) / @interval_sec AS avg_elapsed_time_per_sec, 
            SUM (stat.snapshot_elapsed_time / 1000.0) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_elapsed_time_per_exec, 
            COUNT(*) AS row_count, COUNT (DISTINCT stat.creation_time) AS plan_count, 
            SUM (CASE @order_by_criteria WHEN 'Duration' THEN charted_value / 1000 ELSE charted_value END) AS charted_value, 
            -- TODO: Make this "sql.database_name" once database name is available in notable_query_text (VSTS #121662)
            CONVERT (nvarchar(255), '') AS database_name, 
            ROW_NUMBER() OVER (ORDER BY SUM (charted_value) DESC) as query_rank
        FROM 
        (
            SELECT *, 
                CASE @order_by_criteria 
                    WHEN 'CPU' THEN (snapshot_worker_time / 1000.0) / @interval_sec
                    WHEN 'Physical Reads' THEN 1.0 * snapshot_physical_reads / @interval_sec
                    WHEN 'Logical Writes' THEN 1.0 * snapshot_logical_writes / @interval_sec
                    WHEN 'I/O' THEN 1.0 * (snapshot_physical_reads + snapshot_logical_writes) / @interval_sec
                    WHEN 'Duration' THEN snapshot_elapsed_time / 1000.0
                    ELSE (snapshot_worker_time / 1000.0) / @interval_sec
                END AS charted_value
            FROM snapshots.query_stats 
        ) AS stat
        INNER JOIN core.snapshots snap ON stat.snapshot_id = snap.snapshot_id
        -- TODO: Uncomment this and the line in the WHERE clause once database name is available in notable_query_text (VSTS #121662)
        -- LEFT OUTER JOIN snapshots.notable_query_text AS sql ON t.sql_handle = sql.sql_handle and sql.source_id = t.source_id
        WHERE
            snap.instance_name = @instance_name 
            AND snap.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
            --  AND ISNULL (sql.database_name = ISNULL (@database_name, stat.database_name)
        GROUP BY stat.sql_handle, stat.statement_start_offset, stat.statement_end_offset, snap.source_id
        ORDER BY ROW_NUMBER() OVER (ORDER BY SUM (charted_value) DESC) ASC
    ) AS t
    LEFT OUTER JOIN snapshots.notable_query_text sql ON t.sql_handle = sql.sql_handle and sql.source_id = t.source_id
    OUTER APPLY snapshots.fn_get_query_text (t.source_id, t.sql_handle, t.statement_start_offset, t.statement_end_offset) AS stmtsql
    ORDER BY query_rank ASC
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END
GO


--
-- snapshots.rpt_query_stats
--  Returns aggregate query stats for all executions of a particular query within a specified time interval
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--    @sql_handle_str - String representation of a SQL handle (e.g. "0x1F27BC...")
--    @statement_start_offset - Start offset (byte count) for the statement within the batch identified by @sql_handle_str
--    @statement_start_offset - End offset (byte count) for the statement within the batch identified by @sql_handle_str
--
IF (NOT OBJECT_ID(N'snapshots.rpt_query_stats', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_query_stats] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_query_stats]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_query_stats] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_query_stats]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint,
    @time_interval_min smallint = 1, 
    @sql_handle_str varchar(130), 
    @statement_start_offset int, 
    @statement_end_offset int
AS
BEGIN
    SET NOCOUNT ON;

    -- @end_time should never be NULL when we are called from the Query Stats report
    -- Convert snapshot_time (datetimeoffset) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;

    DECLARE @interval_sec int;
    SET @interval_sec = DATEDIFF (s, @start_time, @end_time);

    DECLARE @sql_handle varbinary(64)
    SET @sql_handle = snapshots.fn_hexstrtovarbin (@sql_handle_str)

    SELECT 
        REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (
            LEFT (LTRIM (stmtsql.query_text), 100)
            , CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '), '   ', ' '), '  ', ' '), '  ', ' ') AS flat_query_text, 
        t.*, 
        master.dbo.fn_varbintohexstr (t.sql_handle) AS sql_handle_str, 
        stmtsql.*
    FROM 
    (
        SELECT 
            stat.sql_handle, stat.statement_start_offset, stat.statement_end_offset, snap.source_id, 
            SUM (stat.snapshot_execution_count) AS execution_count, 
            SUM (stat.snapshot_execution_count) / (@interval_sec / 60) AS executions_per_min, 
            SUM (stat.snapshot_worker_time / 1000) AS total_cpu, 
            SUM (stat.snapshot_worker_time / 1000) / @interval_sec AS avg_cpu_per_sec, 
            SUM (stat.snapshot_worker_time / 1000.0) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_cpu_per_exec, 
            SUM (stat.snapshot_physical_reads) AS total_physical_reads, 
            SUM (stat.snapshot_physical_reads) / @interval_sec AS avg_physical_reads_per_sec, 
            SUM (stat.snapshot_physical_reads) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_physical_reads_per_exec, 
            SUM (stat.snapshot_logical_writes) AS total_logical_writes, 
            SUM (stat.snapshot_logical_writes) / @interval_sec AS avg_logical_writes_per_sec, 
            SUM (stat.snapshot_logical_writes) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_logical_writes_per_exec, 
            SUM (stat.snapshot_elapsed_time / 1000) AS total_elapsed_time, 
            SUM (stat.snapshot_elapsed_time / 1000) / @interval_sec AS avg_elapsed_time_per_sec, 
            SUM (stat.snapshot_elapsed_time / 1000.0) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_elapsed_time_per_exec, 
            COUNT(*) AS row_count, COUNT(DISTINCT plan_number) AS plan_count
        FROM
        (
            SELECT *, DENSE_RANK() OVER (ORDER BY plan_handle, creation_time) AS plan_number
            FROM snapshots.query_stats
        ) AS stat
        INNER JOIN core.snapshots snap ON stat.snapshot_id = snap.snapshot_id
        WHERE
            snap.instance_name = @instance_name 
            AND stat.sql_handle = @sql_handle 
            AND stat.statement_start_offset = @statement_start_offset 
            AND stat.statement_end_offset = @statement_end_offset
            AND snap.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        GROUP BY stat.sql_handle, stat.statement_start_offset, stat.statement_end_offset, snap.source_id
    ) t
    LEFT OUTER JOIN snapshots.notable_query_text sql ON t.sql_handle = sql.sql_handle and sql.source_id = t.source_id
    OUTER APPLY snapshots.fn_get_query_text (t.source_id, t.sql_handle, t.statement_start_offset, t.statement_end_offset) AS stmtsql
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END
GO


--
-- snapshots.rpt_query_plan_stats
--  Returns aggregate stats for the all plans observed for a query within a specified time interval. 
--  Returns the top 10 most expensive plans (ranking criteria is specified via @order_by_criteria). 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--    @sql_handle_str - String representation of a SQL handle (e.g. "0x1F27BC...")
--    @plan_handle_str - String representation of a plan handle (e.g. "0x1F27BC...")
--    @plan_creation_time - (Optional) Plan creation time
--    @statement_start_offset - Start offset (byte count) for the statement within the batch identified by @sql_handle_str
--    @statement_start_offset - End offset (byte count) for the statement within the batch identified by @sql_handle_str
--    @order_by_criteria - (Optional) 'CPU' (default), 'Physical Reads', 'Logical Writes', 'I/O' (reads+writes), or 'Duration'
--
IF (NOT OBJECT_ID(N'snapshots.rpt_query_plan_stats', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_query_plan_stats] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_query_plan_stats]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_query_plan_stats] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_query_plan_stats]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint,
    @time_interval_min smallint = 1, 
    @sql_handle_str varchar(130), 
    @plan_handle_str varchar(130) = NULL, 
    @plan_creation_time datetime = NULL, 
    @statement_start_offset int, 
    @statement_end_offset int, 
    @order_by_criteria varchar(30) = 'CPU'
AS
BEGIN
    SET NOCOUNT ON;

    -- @end_time should never be NULL when we are called from the Query Stats report
    -- Convert snapshot_time (datetimeoffset) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;

    DECLARE @interval_sec int;
    SET @interval_sec = DATEDIFF (s, @start_time, @end_time);

    -- SQL and plan handles are passed in as a hex-formatted string. Convert to varbinary. 
    DECLARE @sql_handle varbinary(64), @plan_handle varbinary(64)
    SET @sql_handle = snapshots.fn_hexstrtovarbin (@sql_handle_str)
    IF LEN (@plan_handle_str) > 0
    BEGIN
        SET @plan_handle = snapshots.fn_hexstrtovarbin (@plan_handle_str)
    END

    SELECT 
        t.*, 
        master.dbo.fn_varbintohexstr (t.sql_handle) AS sql_handle_str, 
        master.dbo.fn_varbintohexstr (t.plan_handle) AS plan_handle_str
    FROM 
    (
        SELECT 
            stat.sql_handle, stat.statement_start_offset, stat.statement_end_offset, stat.plan_handle, 
            CONVERT (datetime, SWITCHOFFSET (CAST (stat.creation_time AS datetimeoffset(7)), '+00:00')) AS creation_time, 
            CONVERT (varchar, CONVERT (datetime, SWITCHOFFSET (CAST (MAX (stat.creation_time) AS datetimeoffset(7)), '+00:00')), 126) AS creation_time_str, 
            CONVERT (datetime, SWITCHOFFSET (CAST (MAX (stat.last_execution_time) AS datetimeoffset(7)), '+00:00')) AS last_execution_time, 
            snap.source_id, 
            SUM (stat.snapshot_execution_count) AS execution_count, 
            SUM (stat.snapshot_execution_count) / (@interval_sec / 60) AS executions_per_min, 
            SUM (stat.snapshot_worker_time / 1000) AS total_cpu, 
            SUM (stat.snapshot_worker_time / 1000) / @interval_sec AS avg_cpu_per_sec, 
            SUM (stat.snapshot_worker_time / 1000.0) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_cpu_per_exec, 
            SUM (stat.snapshot_physical_reads) AS total_physical_reads, 
            SUM (stat.snapshot_physical_reads) / @interval_sec AS avg_physical_reads_per_sec, 
            SUM (stat.snapshot_physical_reads) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_physical_reads_per_exec, 
            SUM (stat.snapshot_logical_writes) AS total_logical_writes, 
            SUM (stat.snapshot_logical_writes) / @interval_sec AS avg_logical_writes_per_sec, 
            SUM (stat.snapshot_logical_writes) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_logical_writes_per_exec, 
            SUM (stat.snapshot_elapsed_time / 1000) AS total_elapsed_time, 
            SUM (stat.snapshot_elapsed_time / 1000) / @interval_sec AS avg_elapsed_time_per_sec, 
            SUM (stat.snapshot_elapsed_time / 1000.0) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_elapsed_time_per_exec, 
            COUNT(*) AS row_count, COUNT (DISTINCT stat.creation_time) AS plan_count, 
            SUM (charted_value) AS charted_value, 
            ROW_NUMBER() OVER (ORDER BY SUM (charted_value) DESC) as query_rank
        FROM 
        (
            SELECT *, 
                -- This is the criteria used to rank the returned rowset and determine the order within Top-N plans
                -- returned from here. It is important that this part of the query stays in sync with a similar
                -- part of the query in snapshots.rpt_query_plan_stats_timeline procedure
                CASE @order_by_criteria     
                    WHEN 'CPU' THEN ((snapshot_worker_time / 1000.0) / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    WHEN 'Physical Reads' THEN 1.0 * (snapshot_physical_reads / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    WHEN 'Logical Writes' THEN 1.0 * (snapshot_logical_writes / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    WHEN 'I/O' THEN 1.0 * ((snapshot_physical_reads + snapshot_logical_writes) / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    WHEN 'Duration' THEN ((snapshot_elapsed_time / 1000.0) / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    ELSE ((snapshot_worker_time / 1000.0) / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                END AS charted_value
            FROM snapshots.query_stats 
            WHERE 
                sql_handle = @sql_handle 
                AND (@plan_handle IS NULL OR plan_handle = @plan_handle) 
                AND (@plan_creation_time IS NULL OR creation_time = @plan_creation_time) 
                AND statement_start_offset = @statement_start_offset 
                AND statement_end_offset = @statement_end_offset
        ) stat
        INNER JOIN core.snapshots snap ON stat.snapshot_id = snap.snapshot_id
        WHERE
            snap.instance_name = @instance_name 
            AND snap.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        GROUP BY stat.sql_handle, stat.statement_start_offset, stat.statement_end_offset, stat.plan_handle, 
                stat.creation_time, snap.source_id
    ) t
    WHERE 
        (query_rank <= 10)
    ORDER BY query_rank ASC
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END
GO



--
-- snapshots.rpt_query_plan_stats_timeline
--  Returns stats for the top 10 plans observed for a query within a specified time interval. 
--  Output is intended for plotting this over a time window. 
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--    @sql_handle_str - String representation of a SQL handle (e.g. "0x1F27BC...")
--    @plan_handle_str - (Optional) String representation of a plan handle (e.g. "0x1F27BC..."). Omit to see stats for all plans
--    @plan_creation_time - (Optional) Plan creation time
--    @statement_start_offset - Start offset (byte count) for the statement within the batch identified by @sql_handle_str
--    @statement_start_offset - End offset (byte count) for the statement within the batch identified by @sql_handle_str
--    @order_by_criteria - (Optional) 'CPU' (default), 'Physical Reads', 'Logical Writes', 'I/O' (reads+writes), or 'Duration'
--
IF (NOT OBJECT_ID(N'snapshots.rpt_query_plan_stats_timeline', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_query_plan_stats_timeline] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_query_plan_stats_timeline]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_query_plan_stats_timeline] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_query_plan_stats_timeline]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint,
    @time_interval_min smallint = 1, 
    @sql_handle_str varchar(130), 
    @plan_handle_str varchar(130) = NULL, 
    @plan_creation_time datetime = NULL, 
    @statement_start_offset int, 
    @statement_end_offset int, 
    @order_by_criteria varchar(30) = 'CPU'
AS
BEGIN
    SET NOCOUNT ON;

    -- @end_time should never be NULL when we are called from the Query Stats report
    -- Convert snapshot_time (datetimeoffset) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;

    -- SQL and plan handles are passed in as a hex-formatted string. Convert to varbinary. 
    DECLARE @sql_handle varbinary(64), @plan_handle varbinary(64)
    SET @sql_handle = snapshots.fn_hexstrtovarbin (@sql_handle_str)
    IF LEN (ISNULL (@plan_handle_str, '')) > 0
    BEGIN
        SET @plan_handle = snapshots.fn_hexstrtovarbin (@plan_handle_str)
    END


    CREATE TABLE #top_plans (
        plan_handle varbinary(64), 
        creation_time datetimeoffset(7), 
        plan_rank int 
    )

    -- If we weren't told to focus on a particular plan...
    IF (@plan_handle IS NULL)
    BEGIN
        -- Get the top 10 most expensive plans for this query during the specified 
        -- time window. 
        INSERT INTO #top_plans
        SELECT * FROM
        (
            SELECT 
                plan_handle, 
                creation_time, 
                ROW_NUMBER() OVER (ORDER BY SUM (ranking_value) DESC) AS plan_rank 
            FROM 
            (
                SELECT *, 
                -- This is the criteria used to rank the returned rowset and determine the order within Top-N plans
                -- returned from here. It is important that this part of the query stays in sync with a similar
                -- part of the query in snapshots.rpt_query_plan_stats procedure
                CASE @order_by_criteria 
                    WHEN 'CPU' THEN ((snapshot_worker_time / 1000.0) / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    WHEN 'Physical Reads' THEN 1.0 * (snapshot_physical_reads / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    WHEN 'Logical Writes' THEN 1.0 * (snapshot_logical_writes / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    WHEN 'I/O' THEN 1.0 * ((snapshot_physical_reads + snapshot_logical_writes) / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    WHEN 'Duration' THEN ((snapshot_elapsed_time / 1000.0) / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                    ELSE ((snapshot_worker_time / 1000.0) / CASE snapshot_execution_count WHEN 0 THEN 1 ELSE snapshot_execution_count END)
                END AS ranking_value
            FROM snapshots.query_stats 
            WHERE 
                sql_handle = @sql_handle 
                AND statement_start_offset = @statement_start_offset 
                AND statement_end_offset = @statement_end_offset
        ) AS stat
        INNER JOIN core.snapshots snap ON stat.snapshot_id = snap.snapshot_id
        WHERE
            snap.instance_name = @instance_name 
            AND snap.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        GROUP BY plan_handle, creation_time
    ) AS t
    WHERE t.plan_rank <= 10
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390);
    END
    ELSE 
    BEGIN
        -- @plan_handle is not NULL; we have been told to focus on a particular plan. 
        INSERT INTO #top_plans 
        VALUES (@plan_handle, @plan_creation_time, 1)
    END;

    -- Get statistics for these 10 plans for each collection point in the time window
    WITH raw_stat AS 
    (
        SELECT *, 
            CASE @order_by_criteria 
                WHEN 'CPU' THEN snapshot_worker_time / 1000.0
                WHEN 'Physical Reads' THEN snapshot_physical_reads 
                WHEN 'Logical Writes' THEN snapshot_logical_writes 
                WHEN 'I/O' THEN (snapshot_logical_writes + snapshot_physical_reads)
                WHEN 'Duration' THEN snapshot_elapsed_time / 1000.0
                ELSE snapshot_worker_time / 1000.0
            END AS charted_value
        FROM snapshots.query_stats AS stat
    )
    SELECT 
        t.*, 
        master.dbo.fn_varbintohexstr (t.sql_handle) AS sql_handle_str, 
        master.dbo.fn_varbintohexstr (t.plan_handle) AS plan_handle_str
    FROM 
    (
        SELECT 
            stat.sql_handle, stat.statement_start_offset, stat.statement_end_offset, stat.plan_handle, 
            CONVERT (datetime, SWITCHOFFSET (CAST (stat.creation_time AS datetimeoffset(7)), '+00:00')) AS creation_time, 
            CONVERT (varchar, CONVERT (datetime, SWITCHOFFSET (CAST (MAX (stat.creation_time) AS datetimeoffset(7)), '+00:00')), 126) AS creation_time_str,             
            CONVERT (datetime, SWITCHOFFSET (CAST (MAX (stat.last_execution_time) AS datetimeoffset(7)), '+00:00')) AS last_execution_time, 
            CONVERT (datetime, SWITCHOFFSET (CAST (stat.collection_time_chart AS datetimeoffset(7)), '+00:00')) AS collection_time, 
            snap.source_id, 
            SUM (stat.snapshot_execution_count) AS execution_count, 
            SUM (stat.snapshot_worker_time / 1000) AS total_cpu, 
            SUM (stat.snapshot_worker_time / 1000) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_cpu_per_exec, 
            SUM (stat.snapshot_physical_reads) AS total_physical_reads, 
            SUM (stat.snapshot_physical_reads) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_physical_reads_per_exec, 
            SUM (stat.snapshot_logical_writes) AS total_logical_writes, 
            SUM (stat.snapshot_logical_writes) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_logical_writes_per_exec, 
            SUM (stat.snapshot_elapsed_time / 1000) AS total_elapsed_time, 
            SUM (stat.snapshot_elapsed_time / 1000) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS avg_elapsed_time_per_exec, 
            COUNT(*) AS row_count, COUNT (DISTINCT stat.creation_time) AS plan_count, 
            SUM (stat.charted_value) AS charted_value, 
            SUM (stat.charted_value) / CASE SUM (stat.snapshot_execution_count) WHEN 0 THEN 1 ELSE SUM (stat.snapshot_execution_count) END AS charted_value_per_exec, 
            MAX (topN.plan_rank) AS plan_rank -- same value for all rows within a group
        FROM (
            -- Work around a RS chart limitation (single data points do not plot on line charts). 
            -- Fake a second data point shortly after the first so even short-lived plans will 
            -- gets plotted. 
            SELECT *, collection_time AS collection_time_chart FROM raw_stat
            UNION ALL
            SELECT *, DATEADD (mi, 1, collection_time) AS collection_time_chart FROM raw_stat
        ) AS stat
        INNER JOIN #top_plans AS topN 
            ON topN.plan_handle = stat.plan_handle AND topN.creation_time = stat.creation_time
        INNER JOIN core.snapshots snap ON stat.snapshot_id = snap.snapshot_id
        WHERE
            stat.sql_handle = @sql_handle 
            AND statement_start_offset = @statement_start_offset 
            AND statement_end_offset = @statement_end_offset
            AND snap.instance_name = @instance_name 
            AND snap.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        GROUP BY stat.sql_handle, stat.statement_start_offset, stat.statement_end_offset, stat.plan_handle, 
                stat.creation_time, snap.source_id, stat.collection_time_chart
    ) AS t
    WHERE 
        (plan_rank <= 10)
    ORDER BY plan_rank ASC, collection_time ASC
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END
GO


--
-- snapshots.rpt_query_plan_missing_indexes
--  Returns any missing indexes recorded in a query plan, formatted as CREATE INDEX statements. 
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @plan_handle_str - String representation of a plan handle (e.g. "0x1F27BC...")
--    @statement_start_offset - Start offset (byte count) for the statement within the plan identified by @plan_handle_str
--    @statement_start_offset - End offset (byte count) for the statement within the plan identified by @plan_handle_str
--
IF (NOT OBJECT_ID(N'snapshots.rpt_query_plan_missing_indexes', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_query_plan_missing_indexes] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_query_plan_missing_indexes]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_query_plan_missing_indexes] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_query_plan_missing_indexes]
    @instance_name sysname, 
    @plan_handle_str varchar(130), 
    @statement_start_offset int, 
    @statement_end_offset int 
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @showplan nvarchar(max)
    DECLARE @plan_handle varbinary(64)
    DECLARE @element nvarchar(512), @element_start nvarchar(512), @element_end nvarchar(512)
    DECLARE @xml_fragment xml
    DECLARE @start_offset int

    -- We may be invoked with a NULL/empty string plan handle if the user has not yet drilled down into 
    -- a specific query plan on the query_stats_detail report. 
    IF ISNULL (@plan_handle_str, '') = '' 
    BEGIN
        RETURN
    END

    SET @plan_handle = snapshots.fn_hexstrtovarbin (@plan_handle_str)

    SELECT TOP 1 
        @showplan = CONVERT (nvarchar(max), qp.query_plan) 
    FROM snapshots.notable_query_plan qp
    INNER JOIN core.snapshots snap ON snap.source_id = qp.source_id 
    WHERE plan_handle = @plan_handle 
        AND statement_start_offset = @statement_start_offset AND statement_end_offset = @statement_end_offset
        AND snap.instance_name = @instance_name
        -- Get sql_handle to enable a clustered index seek on notable_query_plans
        AND qp.sql_handle = 
        (
            SELECT TOP 1 sql_handle 
            FROM snapshots.notable_query_plan AS qp
            INNER JOIN core.snapshots snap ON snap.source_id = qp.source_id 
            WHERE plan_handle = @plan_handle
                AND statement_start_offset = @statement_start_offset AND statement_end_offset = @statement_end_offset 
                AND snap.instance_name = @instance_name
        );

    SET @element = 'MissingIndexes'
    -- Use non-XML methods to extract the <MissingIndexes> fragment.  Some query plans may be too complex 
    -- to represent in the T-SQL xml data type, but the <MissingIndexes> node will always be simple enough. 
    -- Doing this ensures that we will always be able to extract any missing index information from the 
    -- plan even if the plan itself is too complex for the T-SQL xml type. 
    SET @element_start = '<' + @element + '>'
    SET @element_end = '</' + @element + '>'
    SET @start_offset = ISNULL (PATINDEX ('%' + @element_start + '%', @showplan), 0)
    IF @start_offset > 0 
    BEGIN
        SET @xml_fragment = SUBSTRING (@showplan, @start_offset, PATINDEX ('%' + @element_end + '%', @showplan) - @start_offset + LEN (@element_end)); 

        --  Sample <MissingIndexes> fragment from an XML query plan: 
        --    <MissingIndexes>
        --      <MissingIndexGroup Impact="26.4126">
        --        <MissingIndex Database="[AdventureWorks]" Schema="[Sales]" Table="[CustomerAddress]">
        --          <ColumnGroup Usage="EQUALITY">
        --            <Column Name="[AddressTypeID]" ColumnId="3"/>
        --          </ColumnGroup>
        --          <ColumnGroup Usage="INCLUDE">
        --          <Column Name="[CustomerID]" ColumnId="1"/>
        --            <Column Name="[AddressID]" ColumnId="2"/>
        --          </ColumnGroup>
        --        </MissingIndex>
        --      </MissingIndexGroup>
        --    </MissingIndexes>
        SELECT 
            'CREATE INDEX [ncidx_mdw_' 
                + LEFT (target_object_name, 20)
                -- Random component to make name conflicts less likely
                + '_' + CONVERT (varchar(30), ABS (CONVERT (binary(6), NEWID()) % 1000))
                + '] ON ' + target_object_fullname 
                + ' (' + ISNULL (equality_columns, '')
                + CASE WHEN ISNULL (equality_columns, '') != '' AND ISNULL (inequality_columns, '') != '' THEN ',' ELSE '' END + ISNULL (inequality_columns, '')
                + ')'
                + CASE WHEN ISNULL (included_columns, '') != '' THEN ' INCLUDE (' + included_columns + ')' ELSE '' END
                AS create_idx_statement, 
            *
        FROM 
        (
            SELECT 
                index_node.value('(../@Impact)[1]', 'float') as index_impact,
                REPLACE (REPLACE (index_node.value('(./@Table)[1]', 'nvarchar(512)'), '[', ''), ']', '') AS target_object_name,
                CONVERT (nvarchar(1024), index_node.query('concat(
                        string((./@Database)[1]), 
                        ".",
                        string((./@Schema)[1]),
                        ".",
                        string((./@Table)[1])
                    )')) AS target_object_fullname,
                REPLACE (CONVERT (nvarchar(max), index_node.query('for $colgroup in ./ColumnGroup,
                        $col in $colgroup/Column
                        where $colgroup/@Usage = "EQUALITY"
                        return string($col/@Name)')), '] [', '],[') AS equality_columns,
                REPLACE (CONVERT (nvarchar(max), index_node.query('for $colgroup in ./ColumnGroup,
                        $col in $colgroup/Column
                        where $colgroup/@Usage = "INEQUALITY"
                        return string($col/@Name)')), '] [', '],[') AS inequality_columns,
                REPLACE (CONVERT (nvarchar(max), index_node.query('for $colgroup in .//ColumnGroup,
                        $col in $colgroup/Column
                        where $colgroup/@Usage = "INCLUDE"
                        return string($col/@Name)')), '] [', '],[') AS included_columns
            FROM (SELECT @xml_fragment AS fragment) AS missing_indexes_fragment
            CROSS APPLY missing_indexes_fragment.fragment.nodes('/MissingIndexes/MissingIndexGroup/MissingIndex') AS missing_indexes (index_node)
        ) AS t
    END
END
GO

--
-- snapshots.rpt_query_plan_parameters
--  Returns the compile-time parameters that a query plan was optimized for
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @plan_handle_str - String representation of a plan handle (e.g. "0x1F27BC...")
--    @statement_start_offset - Start offset (byte count) for the statement within the plan identified by @plan_handle_str
--    @statement_start_offset - End offset (byte count) for the statement within the plan identified by @plan_handle_str
--
IF (NOT OBJECT_ID(N'snapshots.rpt_query_plan_parameters', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_query_plan_parameters] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].rpt_query_plan_parameters
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_query_plan_parameters] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].rpt_query_plan_parameters
    @instance_name sysname, 
    @plan_handle_str varchar(130), 
    @statement_start_offset int, 
    @statement_end_offset int 
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @showplan xml
    DECLARE @plan_handle varbinary(64)

    -- We may be invoked with a NULL/empty string plan handle if the user has not yet drilled down into 
    -- a specific query plan on the query_stats_detail report. 
    IF ISNULL (@plan_handle_str, '') = '' 
    BEGIN
        RETURN
    END

    SET @plan_handle = snapshots.fn_hexstrtovarbin (@plan_handle_str)

    BEGIN TRY
        SELECT TOP 1 
            @showplan = CONVERT (xml, qp.query_plan) 
        FROM snapshots.notable_query_plan qp
        INNER JOIN core.snapshots snap ON snap.source_id = qp.source_id 
        WHERE plan_handle = @plan_handle 
            AND statement_start_offset = @statement_start_offset AND statement_end_offset = @statement_end_offset 
            AND snap.instance_name = @instance_name
            -- Get sql_handle to enable a clustered index seek on notable_query_plans
            AND qp.sql_handle = 
            (
                SELECT TOP 1 sql_handle 
                FROM snapshots.notable_query_plan AS qp
                INNER JOIN core.snapshots snap ON snap.source_id = qp.source_id 
                WHERE plan_handle = @plan_handle
                    AND statement_start_offset = @statement_start_offset AND statement_end_offset = @statement_end_offset 
                    AND snap.instance_name = @instance_name
            );
    END TRY
    BEGIN CATCH
        -- It is expected that we may end up here even under normal circumstances.  Some plans are simply too 
        -- complex to represent using T-SQL's xml datatype. Raise a low-severity message with the error details. 
        DECLARE @ErrorMessage   NVARCHAR(4000);
        DECLARE @ErrorNumber    INT;
        DECLARE @ErrorLine      INT;
        SELECT @ErrorLine = ERROR_LINE(),
               @ErrorNumber = ERROR_NUMBER(),
               @ErrorMessage = ERROR_MESSAGE();
        -- "Unable to convert showplan to XML.  Error #%d on Line %d: %s"
        RAISERROR (14697, 0, 1, @ErrorNumber, @ErrorLine, @ErrorMessage);
    END CATCH;

    WITH XMLNAMESPACES ('http://schemas.microsoft.com/sqlserver/2004/07/showplan' AS sp)
    SELECT 
        param_list.param_node.value('(./@Column)[1]', 'nvarchar(512)') AS param_name,
        param_list.param_node.value('(./@ParameterCompiledValue)[1]', 'nvarchar(max)') AS param_compiled_value 
    FROM (SELECT @showplan AS query_plan) AS p
    CROSS APPLY p.query_plan.nodes ('/sp:ShowPlanXML/sp:BatchSequence/sp:Batch/sp:Statements/sp:StmtSimple/sp:QueryPlan[1]/sp:ParameterList[1]/sp:ColumnReference') as param_list (param_node)
END
GO


--
-- snapshots.rpt_query_plan_details
--  Returns details of a query plan (estimated cost, compile-time CPU, etc)
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @plan_handle_str - String representation of a plan handle (e.g. "0x1F27BC...")
--    @statement_start_offset - Start offset (byte count) for the statement within the plan identified by @plan_handle_str
--    @statement_start_offset - End offset (byte count) for the statement within the plan identified by @plan_handle_str
--
IF (NOT OBJECT_ID(N'snapshots.rpt_query_plan_details', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_query_plan_details] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].rpt_query_plan_details
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_query_plan_details] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].rpt_query_plan_details
    @instance_name sysname, 
    @plan_handle_str varchar(130), 
    @statement_start_offset int, 
    @statement_end_offset int 
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @showplan xml
    DECLARE @plan_handle varbinary(64)

    -- We may be invoked with a NULL/empty string plan handle if the user has not yet drilled down into 
    -- a specific query plan on the query_stats_detail report. 
    IF ISNULL (@plan_handle_str, '') = '' 
    BEGIN
        RETURN
    END

    SET @plan_handle = snapshots.fn_hexstrtovarbin (@plan_handle_str)

    BEGIN TRY
        SELECT TOP 1 
            @showplan = CONVERT (xml, qp.query_plan) 
        FROM snapshots.notable_query_plan AS qp 
        INNER JOIN core.snapshots snap ON snap.source_id = qp.source_id 
        WHERE plan_handle = @plan_handle 
            AND statement_start_offset = @statement_start_offset AND statement_end_offset = @statement_end_offset 
            AND snap.instance_name = @instance_name 
            -- Get sql_handle to enable a clustered index seek on notable_query_plans
            AND qp.sql_handle = 
            (
                SELECT TOP 1 sql_handle 
                FROM snapshots.notable_query_plan AS qp
                INNER JOIN core.snapshots snap ON snap.source_id = qp.source_id 
                WHERE plan_handle = @plan_handle
                    AND statement_start_offset = @statement_start_offset AND statement_end_offset = @statement_end_offset 
                    AND snap.instance_name = @instance_name
            );
    END TRY
    BEGIN CATCH
        -- It is expected that we may end up here even under normal circumstances.  Some plans are simply too 
        -- complex to represent using T-SQL's xml datatype. Raise a low-severity message with the error details. 
        DECLARE @ErrorMessage   NVARCHAR(4000);
        DECLARE @ErrorNumber    INT;
        DECLARE @ErrorLine      INT;
        SELECT @ErrorLine = ERROR_LINE(),
               @ErrorNumber = ERROR_NUMBER(),
               @ErrorMessage = ERROR_MESSAGE();
        -- "Unable to convert showplan to XML.  Error #%d on Line %d: %s"
        RAISERROR (14697, 0, 1, @ErrorNumber, @ErrorLine, @ErrorMessage);
        RETURN
    END CATCH;

    WITH XMLNAMESPACES ('http://schemas.microsoft.com/sqlserver/2004/07/showplan' AS sp)
    SELECT TOP 10 
        CONVERT (bigint, stmt_simple.stmt_node.value('(./@StatementEstRows)[1]', 'decimal(28,10)')) AS stmt_est_rows, 
        stmt_simple.stmt_node.value('(./@StatementOptmLevel)[1]', 'varchar(30)') AS stmt_optimization_level, 
        stmt_simple.stmt_node.value('(./@StatementOptmEarlyAbortReason)[1]', 'varchar(30)') AS stmt_optimization_early_abort_reason, 
        stmt_simple.stmt_node.value('(./@StatementSubTreeCost)[1]', 'float') AS stmt_est_subtree_cost, 
        stmt_simple.stmt_node.value('(./@StatementText)[1]', 'nvarchar(max)') AS stmt_text, 
        stmt_simple.stmt_node.value('(./@ParameterizedText)[1]', 'nvarchar(max)') AS stmt_parameterized_text, 
        stmt_simple.stmt_node.value('(./@StatementType)[1]', 'varchar(30)') AS stmt_type, 
        stmt_simple.stmt_node.value('(./@PlanGuideName)[1]', 'varchar(30)') AS plan_guide_name, 
        stmt_simple.stmt_node.value('(./sp:QueryPlan/@CachedPlanSize)[1]', 'int') AS plan_size, 
        stmt_simple.stmt_node.value('(./sp:QueryPlan/@CompileTime)[1]', 'bigint') AS plan_compile_time, 
        stmt_simple.stmt_node.value('(./sp:QueryPlan/@CompileCPU)[1]', 'bigint') AS plan_compile_cpu, 
        stmt_simple.stmt_node.value('(./sp:QueryPlan/@CompileMemory)[1]', 'int') AS plan_compile_memory 
    FROM (SELECT @showplan AS query_plan) AS p
    CROSS APPLY p.query_plan.nodes ('/sp:ShowPlanXML/sp:BatchSequence/sp:Batch/sp:Statements/sp:StmtSimple') as stmt_simple (stmt_node)
END
GO


--
-- snapshots.rpt_blocking_chains
--  Returns summary of blocking chains that existed in a specified time window
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - time window start (UTC)
--    @end_time - time window end (UTC)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_blocking_chains', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_blocking_chains] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_blocking_chains]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_blocking_chains] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_blocking_chains]
    @instance_name sysname,
    @start_time datetime = NULL, 
    @end_time datetime, 
    @WindowSize int = NULL
AS
BEGIN
SET NOCOUNT ON;

    -- Compensate for RS truncation of fractional seconds
    SET @end_time = DATEADD (second, 1, @end_time) 

    -- If @start_time is NULL, calc it using @end_time and @WindowSize
    IF @start_time IS NULL SET @start_time = DATEADD (minute, -1 * @WindowSize, @end_time)

    -- Get all collection times for the "Active Sessions and Requests" collection item
    SELECT DISTINCT r1.collection_time, r1.snapshot_id, 
        DENSE_RANK() OVER (ORDER BY r1.collection_time) AS collection_time_id
    INTO #collection_times
    FROM snapshots.active_sessions_and_requests AS r1 
    INNER JOIN core.snapshots s ON s.snapshot_id = r1.snapshot_id 
    WHERE 
        s.instance_name = @instance_name 
        AND r1.collection_time BETWEEN @start_time AND @end_time

    DECLARE @max_collection_time datetimeoffset(7)
    SELECT @max_collection_time = MAX (collection_time) FROM #collection_times

    -- Get all head blockers during the selected time window
    SELECT r1.*, times.collection_time_id
    INTO #blocking_participants 
    FROM #collection_times AS times
    LEFT OUTER JOIN snapshots.active_sessions_and_requests AS r1 
        ON r1.collection_time = times.collection_time AND r1.snapshot_id = times.snapshot_id
    WHERE r1.blocking_session_id = 0
        AND session_id IN (
            SELECT DISTINCT blocking_session_id 
            FROM snapshots.active_sessions_and_requests AS r2 
            WHERE r2.blocking_session_id != 0 AND r2.collection_time = r1.collection_time
                AND r2.snapshot_id = r1.snapshot_id
        )
    CREATE NONCLUSTERED INDEX IDX1_blocking_participants 
    ON #blocking_participants 
    (
        session_id, collection_time_id, blocking_session_id
    )

    -- List all blocking chains during this time window. 
    -- For the purposes of this overview, we define a blocking chain as a contiguous series 
    -- of samples where the same spid remains the head blocker.  Rolling blocking will be viewed 
    -- as multiple discrete chains. 
    SELECT 
        MIN (head_blockers.collection_time) AS blocking_start_time, 
        -- We know when the blocking ended within a (roughly) 10 second window. Assume it stopped approximately 
        -- at the midpoint. 
        DATEADD (second, 5, ISNULL (MAX (blocking_end_times.collection_time), @max_collection_time)) AS blocking_end_time, 
        DATEDIFF (second, MIN (head_blockers.collection_time), ISNULL (MAX (blocking_end_times.collection_time), @max_collection_time)) 
            AS blocking_duration_sec,
        head_blockers.session_id AS head_blocker_session_id, 
        MIN (head_blockers.[program_name]) AS [program_name], 
        MIN (head_blockers.[database_name]) AS [database_name], 
        COUNT(*) AS observed_sample_count,  -- Number of times we saw this blocking chain
        CASE WHEN MAX (blocking_end_times.collection_time) IS NULL THEN 1 ELSE 0 END AS still_active
    INTO #blocking_chains
    FROM 
    (
        SELECT 
            (   -- Find the end time for this blocking incident
                SELECT MIN (collection_time_id)
                FROM #collection_times AS times1
                WHERE times1.collection_time_id > blockers_start.collection_time_id 
                    AND times1.collection_time_id <= @end_time 
                    AND NOT EXISTS (
                        SELECT * FROM #blocking_participants AS blk1
                        WHERE blk1.session_id = blockers_start.session_id 
                            AND blk1.[program_name] = blockers_start.[program_name] 
                            AND blk1.login_time = blockers_start.login_time 
                            AND blk1.collection_time_id = times1.collection_time_id
                            AND blk1.blocking_session_id = 0
                    )
            ) AS blocking_end_collection_time_id, 
            *
        FROM #blocking_participants AS blockers_start 
        WHERE blockers_start.blocking_session_id = 0 
    ) AS head_blockers
    LEFT OUTER JOIN #collection_times AS blocking_end_times
        ON blocking_end_times.collection_time_id = head_blockers.blocking_end_collection_time_id - 1
    GROUP BY head_blockers.session_id, head_blockers.blocking_end_collection_time_id 
    ORDER BY MIN (head_blockers.collection_time)

    -- This proc supports two different chart elements: a table, with one row per blocking 
    -- chain, and a timeline chart, with one series per blocking chain.  The chart must 
    -- return two data points per series in order to correctly plot the blocking chain's 
    -- beginning and end times.  The chart uses the output of both of the following UNIONed 
    -- SELECT statements, while the table filters out the second resultset 
    -- ([chart_data_only]=0). Doing this avoids the need to waste time running two procs 
    -- that are almost identical.  
    SELECT 
        blocking_chain_number, 
        CONVERT (datetime, SWITCHOFFSET (CAST (blocking_start_time AS datetimeoffset(7)), '+00:00')) AS blocking_start_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (blocking_end_time AS datetimeoffset(7)), '+00:00')) AS blocking_end_time, 
        blocking_duration_sec, 
        head_blocker_session_id, 
        [program_name], 
        [database_name], 
        observed_sample_count, 
        still_active, 
        -- Represent this time as a string to avoid RS datetime truncation when the report passes it back to us on drillthrough
        CONVERT (varchar(40), SWITCHOFFSET (CAST (blocking_start_time AS datetimeoffset(7)), '+00:00'), 126) AS blocking_start_time_str, 
        CONVERT (datetime, SWITCHOFFSET (CAST (chart_time AS datetimeoffset(7)), '+00:00')) AS chart_time, 
        chart_data_only
    FROM 
    (
        SELECT TOP 10 ROW_NUMBER() OVER (ORDER BY blocking_duration_sec DESC) AS blocking_chain_number, 
            *, blocking_start_time AS chart_time, 
            0 AS chart_data_only 
        FROM #blocking_chains
        ORDER BY blocking_duration_sec DESC
        UNION ALL 
        SELECT TOP 10 ROW_NUMBER() OVER (ORDER BY blocking_duration_sec DESC) AS blocking_chain_number, 
            *, blocking_end_time AS chart_time, 
            1 AS chart_data_only 
        FROM #blocking_chains
        ORDER BY blocking_duration_sec DESC
    ) AS t
    ORDER BY blocking_chain_number, chart_data_only
END
GO


--
-- snapshots.rpt_blocking_chain_detail
--  Returns details about a blocking chain
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @blocking_time_str - a string representation of a datetimeoffset value during the 
--        period where @head_blocker_session_id was the cause of blocking (UTC)
--    @head_blocker_session_id - session ID (SPID) of the head of the blocker chain
--
IF (NOT OBJECT_ID(N'snapshots.rpt_blocking_chain_detail', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_blocking_chain_detail] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_blocking_chain_detail]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_blocking_chain_detail] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_blocking_chain_detail]
    @instance_name sysname, 
    @blocking_time_str varchar(40), 
    @head_blocker_session_id int
AS
BEGIN
SET NOCOUNT ON;
    DECLARE @blocking_start_time datetimeoffset(7)
    DECLARE @blocking_end_time datetimeoffset(7)
    DECLARE @blocking_time datetimeoffset(7)
    -- The report passed in the blocking time as a string to avoid RS date truncation. 
    -- Convert this to a datetimeoffset value in UTC time.
    SET @blocking_time = SWITCHOFFSET (CAST (@blocking_time_str AS datetimeoffset(7)), '+00:00')

    -- The time that we were passed in may have been in the middle of the blocking incident. 
    -- Find the true start time for this blocking chain. This might be 10 seconds prior, or 
    -- might be days prior.  For perf reasons, search backwards in time one hour at a time 
    -- until we find the start of the blocking incident. 
    DECLARE @blocking_end_snapshot_id int
    DECLARE @blocking_end_source_id int
    DECLARE @hour_count int
    SET @hour_count = -1
    WHILE (@blocking_start_time IS NULL)
    BEGIN
        -- Only if we have more rows left to search for the blocking end time
        IF EXISTS (
            SELECT * 
            FROM snapshots.active_sessions_and_requests AS r 
            INNER JOIN core.snapshots AS s ON s.snapshot_id = r.snapshot_id
            WHERE s.instance_name = @instance_name 
                AND r.collection_time < DATEADD (hour, @hour_count+1, @blocking_time)
        )
        BEGIN
            SELECT TOP 1 @blocking_start_time = r.collection_time 
            FROM snapshots.active_sessions_and_requests AS r 
            INNER JOIN core.snapshots AS s ON s.snapshot_id = r.snapshot_id
            WHERE s.instance_name = @instance_name
                AND r.collection_time BETWEEN DATEADD (hour, @hour_count, @blocking_time) AND @blocking_time 
                AND NOT EXISTS 
                ( 
                    SELECT * 
                    FROM snapshots.active_sessions_and_requests AS r2 
                    WHERE r.snapshot_id = r2.snapshot_id AND r.collection_time = r2.collection_time 
                        AND r2.blocking_session_id = @head_blocker_session_id 
                ) 
            ORDER BY r.collection_time DESC
        END
        ELSE
        BEGIN
            -- We've reached the beginning of the data in the warehouse, and the blocking incident was already 
            -- in-progress at that time. Use the earliest collection time as the approx blocking start time. 
            SELECT @blocking_start_time = ISNULL (DATEADD (second, -10, MIN (r.collection_time)), GETUTCDATE())
            FROM snapshots.active_sessions_and_requests AS r 
            INNER JOIN core.snapshots AS s ON s.snapshot_id = r.snapshot_id
            WHERE s.instance_name = @instance_name
        END
        SET @hour_count = @hour_count - 1
    END
    -- We've found the collection_time just before the blocking began. Get the next collection time, 
    -- which is the first collection time where this blocking incident was detected. 
    SELECT TOP 1 @blocking_start_time = r.collection_time
    FROM snapshots.active_sessions_and_requests AS r 
    INNER JOIN core.snapshots AS s ON s.snapshot_id = r.snapshot_id
    WHERE s.instance_name = @instance_name AND r.collection_time > @blocking_start_time
    ORDER BY r.collection_time ASC

    -- Now find the end of the blocking incident.  Here, again, do an optimistic search in 1-hour blocks. 
    SET @hour_count = 1
    WHILE (@blocking_end_time IS NULL)
    BEGIN
        -- Only if we have more rows left to search for the blocking end time
        IF EXISTS (
            SELECT * 
            FROM snapshots.active_sessions_and_requests AS r 
            INNER JOIN core.snapshots AS s ON s.snapshot_id = r.snapshot_id
            WHERE s.instance_name = @instance_name 
                AND r.collection_time > DATEADD (hour, @hour_count-1, @blocking_time)
        )
        BEGIN
            SELECT TOP 1 @blocking_end_time = r.collection_time 
            FROM snapshots.active_sessions_and_requests AS r 
            INNER JOIN core.snapshots AS s ON s.snapshot_id = r.snapshot_id
            WHERE s.instance_name = @instance_name
                AND r.collection_time BETWEEN DATEADD (hour, @hour_count-1, @blocking_time) AND DATEADD (hour, @hour_count, @blocking_time)
                AND NOT EXISTS 
                ( 
                    SELECT * 
                    FROM snapshots.active_sessions_and_requests AS r2 
                    WHERE r.snapshot_id = r2.snapshot_id AND r.collection_time = r2.collection_time 
                        AND r2.blocking_session_id = @head_blocker_session_id 
                ) 
            ORDER BY r.collection_time ASC
        END
        ELSE
        BEGIN
            -- We've reached the end of the data in the warehouse, and the blocking incident is still 
            -- in-progress. Use the last collection time as the approx blocking end time. 
            SELECT @blocking_end_time = ISNULL (DATEADD (second, 10, MAX (r.collection_time)), GETUTCDATE())
            FROM snapshots.active_sessions_and_requests AS r 
            INNER JOIN core.snapshots AS s ON s.snapshot_id = r.snapshot_id
            WHERE s.instance_name = @instance_name
        END
        SET @hour_count = @hour_count + 1
    END
    -- We've found the collection_time just after before the blocking ended. Get the prior collection time, 
    -- which is the last collection time where the blocking incident was detected. 
    SELECT TOP 1 @blocking_end_time = r.collection_time, @blocking_end_snapshot_id = r.snapshot_id, @blocking_end_source_id = s.source_id
    FROM snapshots.active_sessions_and_requests AS r 
    INNER JOIN core.snapshots AS s ON s.snapshot_id = r.snapshot_id
    WHERE s.instance_name = @instance_name AND r.collection_time < @blocking_end_time
    ORDER BY r.collection_time DESC

    -- DC captures a snapshot of session state every few seconds, which would mean hundreds of samples for 
    -- moderately long-lived blocking chains.  It would be too expensive to summarize the state of the blocking 
    -- chain at every one of these points.  Instead, select 10 evenly-spaced intervals during the blocking 
    -- incident to characterize the changes in the head blocker's state over the blocking period. 
    DECLARE @interval_sec int
    SET @interval_sec = DATEDIFF (second, @blocking_start_time, @blocking_end_time) / 10
    CREATE TABLE #sample_collection_times (snapshot_id int, source_id int, collection_time datetimeoffset(7))
    DECLARE @i int
    SET @i = 0
    WHILE (@i < 9)
    BEGIN
        INSERT INTO #sample_collection_times 
        SELECT TOP 1 r.snapshot_id, s.source_id, r.collection_time
        FROM snapshots.active_sessions_and_requests AS r 
        INNER JOIN core.snapshots AS s ON s.snapshot_id = r.snapshot_id
        WHERE s.instance_name = @instance_name 
            AND r.collection_time BETWEEN DATEADD (second, @interval_sec * @i, @blocking_start_time)
                AND DATEADD (second, @interval_sec * (@i+1)-1, @blocking_start_time)
            -- Only choose collection times where we have info for the head blocker
            AND r.session_id = @head_blocker_session_id 
        ORDER BY r.collection_time ASC
        SET @i = @i + 1
    END
    -- The 10th sample time is always the blocking incident's final collection time
    INSERT INTO #sample_collection_times VALUES (@blocking_end_snapshot_id, @blocking_end_source_id, @blocking_end_time);

    -- Use a recursive CTE to walk the tree of the blocking chain at each of these collection times
    -- and get the state of all the sessions that were part of the tree
    WITH blocking_hierarchy AS  
    (
        -- Head blocker at each of the selected sample times
        SELECT t.collection_time, t.snapshot_id, t.source_id, 0 AS [level], 
            r.session_id, r.request_id, r.exec_context_id, r.request_status, r.command, 
            r.blocking_session_id, r.blocking_exec_context_id, 
            r.wait_type, r.wait_duration_ms, r.wait_resource, r.resource_description, 
            r.login_name, r.login_time, r.[program_name], r.[host_name], r.database_name, 
            r.open_transaction_count, r.transaction_isolation_level, 
            r.request_cpu_time, r.request_total_elapsed_time, r.request_start_time, r.memory_usage, 
            r.session_cpu_time, r.session_total_scheduled_time, r.session_row_count, r.pending_io_count, r.prev_error, 
            r.session_last_request_start_time, r.session_last_request_end_time, r.open_resultsets, 
            r.plan_handle, r.sql_handle, r.statement_start_offset, r.statement_end_offset 
        FROM #sample_collection_times AS t
        INNER JOIN snapshots.active_sessions_and_requests AS r
            ON t.snapshot_id = r.snapshot_id AND t.collection_time = r.collection_time
        WHERE r.session_id = @head_blocker_session_id 
            AND ISNULL (r.exec_context_id, 0) IN (-1, 0) -- for the head blocker, only return the main worker's state
        UNION ALL 
        -- Tasks blocked by the head blocker at the same times
        SELECT r2.collection_time, r2.snapshot_id, parent.source_id, parent.[level] + 1 AS [level], 
            r2.session_id, r2.request_id, r2.exec_context_id, r2.request_status, r2.command, 
            r2.blocking_session_id, r2.blocking_exec_context_id, 
            r2.wait_type, r2.wait_duration_ms, r2.wait_resource, r2.resource_description, 
            r2.login_name, r2.login_time, r2.[program_name], r2.[host_name], r2.database_name, 
            r2.open_transaction_count, r2.transaction_isolation_level, 
            r2.request_cpu_time, r2.request_total_elapsed_time, r2.request_start_time, r2.memory_usage, 
            r2.session_cpu_time, r2.session_total_scheduled_time, r2.session_row_count, r2.pending_io_count, r2.prev_error, 
            r2.session_last_request_start_time, r2.session_last_request_end_time, r2.open_resultsets, 
            r2.plan_handle, r2.sql_handle, r2.statement_start_offset, r2.statement_end_offset 
        FROM snapshots.active_sessions_and_requests AS r2
        INNER JOIN blocking_hierarchy AS parent 
            ON parent.snapshot_id = r2.snapshot_id AND parent.collection_time = r2.collection_time
                AND parent.session_id = r2.blocking_session_id
    )
    SELECT * INTO #blocking_hierarchy 
    FROM blocking_hierarchy 
    
    -- Summarize the state of the head blocker at each of the sample times, along with 
    -- some aggregate stats (# of blocked sessions, etc) describing the blocked sessions
    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (@blocking_start_time AS datetimeoffset(7)), '+00:00')) AS blocking_start_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (@blocking_end_time AS datetimeoffset(7)), '+00:00')) AS blocking_end_time, 
        DATEDIFF (second, @blocking_start_time, @blocking_end_time) AS blocking_duration, 
        -- Return these dates as strings to avoid RS date truncation
        CONVERT (varchar(40), SWITCHOFFSET (CAST (@blocking_start_time AS datetimeoffset(7)), '+00:00'), 126) AS blocking_start_time_str, 
        CONVERT (varchar(40), SWITCHOFFSET (CAST (@blocking_end_time AS datetimeoffset(7)), '+00:00'), 126) AS blocking_end_time_str, 
        CONVERT (datetime, SWITCHOFFSET (CAST (blocked.chart_collection_time AS datetimeoffset(7)), '+00:00')) AS chart_collection_time, 
        blocked.chart_only, 
        CONVERT (datetime, SWITCHOFFSET (CAST (blocked.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        blocked.snapshot_id, 
        CONVERT (varchar(40), SWITCHOFFSET (CAST (blocked.collection_time AS datetimeoffset(7)), '+00:00'), 126) AS collection_time_str, 
        @head_blocker_session_id AS head_blocker_session_id, 
        COUNT(DISTINCT blocked.session_id) AS blocked_session_count, 
        SUM (blocked.wait_duration_ms) AS total_wait_time, 
        AVG (blocked.wait_duration_ms) AS avg_wait_time, 
        (
            -- Get the description of the resource owned by the head blocker that 
            -- has caused the most wait time in this blocking chain
            SELECT TOP 1 resource_description
            FROM #blocking_hierarchy bh
            WHERE bh.collection_time = blocked.collection_time AND bh.snapshot_id = blocked.snapshot_id
                AND bh.blocking_session_id = @head_blocker_session_id
            GROUP BY resource_description
            ORDER BY SUM (wait_duration_ms) DESC
        ) AS primary_wait_resource_description, 
        ISNULL (blocker.command, 'AWAITING COMMAND') AS command, blocker.request_status, 
        wt.category_name, blocker.wait_type, blocker.wait_duration_ms, blocker.wait_resource, blocker.resource_description, 
        blocker.[program_name], blocker.[host_name], blocker.login_name, 
        CONVERT (datetime, SWITCHOFFSET (CAST (blocker.login_time AS datetimeoffset(7)), '+00:00')) AS login_time, 
        blocker.database_name, 
        MAX (blocker.open_transaction_count) AS open_transaction_count, MAX (blocker.transaction_isolation_level) AS transaction_isolation_level, 
        MAX (blocker.request_cpu_time) AS request_cpu_time, MAX (blocker.request_total_elapsed_time) AS request_total_elapsed_time, 
        MIN (blocker.request_start_time) AS request_start_time, MAX (blocker.memory_usage) AS memory_usage, 
        MAX (blocker.session_cpu_time) AS session_cpu_time, MAX (blocker.session_total_scheduled_time) AS session_total_scheduled_time, 
        MAX (blocker.session_row_count) AS session_row_count, MAX (blocker.pending_io_count) AS pending_io_count, 
        MAX (blocker.prev_error) AS prev_error, 
        CONVERT (datetime, SWITCHOFFSET (CAST (MAX (blocker.session_last_request_start_time) AS datetimeoffset(7)), '+00:00')) AS session_last_request_start_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (MAX (blocker.session_last_request_end_time) AS datetimeoffset(7)), '+00:00')) AS session_last_request_end_time, 
        MAX (blocker.open_resultsets) AS open_resultsets, 
        blocker.plan_handle, blocker.sql_handle, blocker.statement_start_offset, blocker.statement_end_offset, 
        -- RS can't handle binary values as parameters -- convert plan and sql handles to string types
        master.dbo.fn_varbintohexstr (blocker.plan_handle) AS plan_handle_str, 
        master.dbo.fn_varbintohexstr (blocker.sql_handle) AS sql_handle_str, 
        sql_text.[object_id], sql_text.[object_name], sql_text.query_text, 
        REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (
            LEFT (LTRIM (sql_text.query_text), 100), 
            CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '), '   ', ' '), '  ', ' '), '  ', ' ') AS flat_query_text
    -- RS won't plot series that only have a single data point on a line graph.  Duplicate each data 
    -- point with a slight time shift, which will allow the chart to provide some visualization even if 
    -- the blocking was transient (only seen during a single sample). For performance reasons, this 
    -- same resultset feeds both a chart and a table.  The duplicate records are flagged with 
    -- chart_only=1 so that they can be filtered out in the table. 
    FROM (
        SELECT *, collection_time AS chart_collection_time, 0 AS chart_only
        FROM #blocking_hierarchy 
        WHERE blocking_session_id != 0 
        UNION ALL 
        SELECT *, DATEADD (second, 10, collection_time) AS chart_collection_time, 1 AS chart_only 
        FROM #blocking_hierarchy 
        WHERE blocking_session_id != 0 
    ) AS blocked
    INNER JOIN (
        SELECT *, collection_time AS chart_collection_time, 0 AS chart_only
        FROM #blocking_hierarchy 
        WHERE blocking_session_id = 0 
        UNION ALL 
        SELECT *, DATEADD (second, 10, collection_time) AS chart_collection_time, 1 AS chart_only
        FROM #blocking_hierarchy 
        WHERE blocking_session_id = 0 
    ) AS blocker
        ON blocked.collection_time = blocker.collection_time AND blocked.snapshot_id = blocker.snapshot_id
            AND blocked.chart_collection_time = blocker.chart_collection_time 
    OUTER APPLY [snapshots].[fn_get_query_text] (blocker.source_id, blocker.sql_handle, blocker.statement_start_offset, blocker.statement_end_offset) AS sql_text
    LEFT OUTER JOIN core.wait_types_categorized AS wt ON blocker.wait_type = wt.wait_type
    WHERE 
        blocker.blocking_session_id = 0 AND blocked.blocking_session_id != 0
    GROUP BY blocked.chart_collection_time, blocked.chart_only, blocked.collection_time, blocked.snapshot_id, 
        blocker.command, blocker.request_status, 
        wt.category_name, blocker.wait_type, blocker.wait_duration_ms, blocker.wait_resource, blocker.resource_description, 
        blocker.[program_name], blocker.[host_name], blocker.login_name, blocker.login_time, blocker.database_name, 
        blocker.plan_handle, blocker.sql_handle, blocker.statement_start_offset, blocker.statement_end_offset, 
        sql_text.[object_id], sql_text.[object_name], sql_text.query_text  
    ORDER BY blocked.collection_time ASC

END 
GO

--
-- snapshots.rpt_active_sessions_and_requests
--  Returns all the active sessions/requests at a particular moment in time
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @collection_time - a time that corresponds to a specific [collection_time] in snapshots.active_sessions_and_requests (UTC)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_active_sessions_and_requests', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_active_sessions_and_requests] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_active_sessions_and_requests]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_active_sessions_and_requests] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_active_sessions_and_requests]
    @instance_name sysname, 
    @collection_time datetime
AS
BEGIN
SET NOCOUNT ON;
    -- Find the nearest collection time on or before the user-specified time
    DECLARE @current_collection_time datetimeoffset(7)
    DECLARE @current_snapshot_id int
    DECLARE @query_stats_source_id int

    -- Compensate for RS truncation of fractional seconds 
    SET @current_collection_time = DATEADD(second, 1, @collection_time)

    SELECT TOP 1 @current_collection_time = r.collection_time, @current_snapshot_id = r.snapshot_id
    FROM core.snapshots AS s
    INNER JOIN snapshots.active_sessions_and_requests AS r ON s.snapshot_id = r.snapshot_id
    WHERE s.instance_name = @instance_name
      AND r.collection_time <= @current_collection_time
    ORDER BY collection_time DESC

    -- Get the source_id for the Query Stats collection set on this server
    SELECT @query_stats_source_id = s.source_id
    FROM core.snapshots AS s
    WHERE s.instance_name = @instance_name AND s.collection_set_uid = '2DC02BD6-E230-4C05-8516-4E8C0EF21F95'

    -- Get all active sessions/requests at that time
    SELECT 
        r.session_id, r.request_id, r.exec_context_id, ISNULL (r.blocking_session_id, 0) AS blocking_session_id, r.blocking_exec_context_id, 
        r.scheduler_id, r.database_name, r.[user_id], r.task_state, r.request_status, r.session_status, 
        r.executing_managed_code, 
        CONVERT (datetime, SWITCHOFFSET (CAST (r.login_time AS datetimeoffset(7)), '+00:00')) AS login_time, 
        r.is_user_process, r.[host_name], r.[program_name], r.login_name, r.wait_type, r.last_wait_type, 
        r.wait_duration_ms, r.wait_resource, r.resource_description, r.transaction_id, 
        r.open_transaction_count, r.transaction_isolation_level, r.request_cpu_time, 
        r.request_logical_reads, r.request_reads, r.request_writes, r.request_total_elapsed_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (r.request_start_time AS datetimeoffset(7)), '+00:00')) AS request_start_time, 
        r.memory_usage, r.session_cpu_time, r.session_reads, r.session_writes, 
        r.session_logical_reads, r.session_total_scheduled_time, r.session_total_elapsed_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (r.session_last_request_start_time AS datetimeoffset(7)), '+00:00')) AS session_last_request_start_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (r.session_last_request_end_time AS datetimeoffset(7)), '+00:00')) AS session_last_request_end_time, 
        r.open_resultsets, r.session_row_count, r.prev_error, r.pending_io_count, ISNULL (r.command, 'AWAITING COMMAND') AS command, 
        r.plan_handle, r.sql_handle, r.statement_start_offset, r.statement_end_offset, 
        CONVERT (datetime, SWITCHOFFSET (CAST (r.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        r.snapshot_id, 
        wt.category_name AS wait_category, 
        sql.*, 
        master.dbo.fn_varbintohexstr (r.sql_handle) AS sql_handle_str, 
        master.dbo.fn_varbintohexstr (r.plan_handle) AS plan_handle_str, 
        REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (
            LEFT (LTRIM (sql.query_text), 100)
            , CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '), '   ', ' '), '  ', ' '), '  ', ' ') AS flat_query_text 
    FROM snapshots.active_sessions_and_requests AS r
    LEFT OUTER JOIN core.wait_types_categorized AS wt ON r.wait_type = wt.wait_type
    OUTER APPLY snapshots.fn_get_query_text (@query_stats_source_id, r.sql_handle, r.statement_start_offset, r.statement_end_offset) AS sql
    WHERE r.snapshot_id = @current_snapshot_id AND r.collection_time = @current_collection_time
END
GO


--
-- snapshots.rpt_sql_memory_clerks
--  Returns data from os_memory_clerks table
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - End of the user-selected time window (UTC)
--    @WindowSize - Number of minutes in the time window 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sql_memory_clerks', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sql_memory_clerks] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sql_memory_clerks]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sql_memory_clerks] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sql_memory_clerks]
    @ServerName sysname,
    @EndTime datetime = NULL,
    @WindowSize smallint = NULL
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Divide our time window up into 40 evenly-sized time intervals, and find the last collection_time within each of these intervals
    CREATE TABLE #intervals (
        interval_time_id        int, 
        interval_start_time     datetimeoffset(7),
        interval_end_time       datetimeoffset(7),
        interval_id             int, 
        first_collection_time   datetimeoffset(7), 
        last_collection_time    datetimeoffset(7), 
        first_snapshot_id       int,
        last_snapshot_id        int, 
        source_id               int, 
        snapshot_id             int, 
        collection_time         datetimeoffset(7), 
        collection_time_id      int
    )
    -- GUID 49268954-... is the Server Activity CS
    INSERT INTO #intervals
    EXEC [snapshots].[rpt_interval_collection_times] 
        @ServerName, @EndTime, @WindowSize, 'snapshots.os_memory_clerks', '49268954-4FD4-4EB6-AA04-CD59D9BB5714', 40, 0
    
    -- Get memory clerk stats for these collection times
    SELECT 
        coll.interval_time_id, 
        -- Convert datetimeoffsets to UTC datetimes
        CONVERT (datetime, SWITCHOFFSET (coll.interval_start_time, '+00:00')) AS interval_start_time, 
        CONVERT (datetime, SWITCHOFFSET (coll.interval_end_time,  '+00:00')) AS interval_end_time, 
        coll.interval_id, 
        CONVERT (datetime, SWITCHOFFSET (coll.first_collection_time, '+00:00')) AS first_collection_time, 
        CONVERT (datetime, SWITCHOFFSET (coll.last_collection_time, '+00:00')) AS last_collection_time, 
        coll.first_snapshot_id, coll.last_snapshot_id, 
        mc.[type], mc.memory_node_id, mc.single_pages_kb, mc.multi_pages_kb, mc.virtual_memory_reserved_kb, 
        mc.virtual_memory_committed_kb, mc.awe_allocated_kb, mc.shared_memory_reserved_kb, mc.shared_memory_committed_kb, 
        CONVERT (datetime, SWITCHOFFSET (mc.collection_time, '+00:00')) AS collection_time, 
        CAST (mc.single_pages_kb AS bigint) 
            + mc.multi_pages_kb 
            + (CASE WHEN type <> 'MEMORYCLERK_SQLBUFFERPOOL' THEN mc.virtual_memory_committed_kb ELSE 0 END) 
            + mc.shared_memory_committed_kb AS total_kb
    INTO #memory_clerks
    FROM snapshots.os_memory_clerks AS mc
    INNER JOIN #intervals AS coll ON coll.last_snapshot_id = mc.snapshot_id AND coll.last_collection_time = mc.collection_time 

    -- Return memory stats to the caller
    SELECT 
        mc.*, 
        mc.single_pages_kb + mc.multi_pages_kb as allocated_kb,
        ta.total_kb_all_clerks, 
        mc.total_kb / CONVERT(decimal, ta.total_kb_all_clerks) AS percent_total_kb,
        -- There are many memory clerks. We'll chart any that make up 5% of SQL memory or more; less significant clerks will be lumped into an "Other" bucket
        CASE
            WHEN mc.total_kb / CONVERT(decimal, ta.total_kb_all_clerks) > 0.05 THEN mc.[type]
            ELSE N'Other'
        END AS graph_type
    FROM #memory_clerks AS mc
    -- Use a self-join to calculate the total memory allocated for each time interval
    JOIN 
    (
        SELECT 
            mc_ta.collection_time, 
            SUM (mc_ta.total_kb) AS total_kb_all_clerks
        FROM #memory_clerks AS mc_ta
        GROUP BY mc_ta.collection_time
    ) AS ta ON (mc.collection_time = ta.collection_time)
    ORDER BY collection_time
END;
GO


--
-- snapshots.rpt_sql_process_and_system_memory
--  Returns system and SQL process memory details over a time interval
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - End of the user-selected time window (UTC)
--    @WindowSize - Number of minutes in the time window 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sql_process_and_system_memory', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sql_process_and_system_memory] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sql_process_and_system_memory]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sql_process_and_system_memory] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sql_process_and_system_memory]
    @ServerName sysname,
    @EndTime datetime = NULL,
    @WindowSize int
AS
BEGIN
    SET NOCOUNT ON;

    -- Divide our time window up into 40 evenly-sized time intervals, and find the last collection_time within each of these intervals
    CREATE TABLE #intervals (
        interval_time_id        int, 
        interval_start_time     datetimeoffset(7),
        interval_end_time       datetimeoffset(7),
        interval_id             int, 
        first_collection_time   datetimeoffset(7), 
        last_collection_time    datetimeoffset(7), 
        first_snapshot_id       int,
        last_snapshot_id        int, 
        source_id               int,
        snapshot_id             int, 
        collection_time         datetimeoffset(7), 
        collection_time_id      int
    )
    -- GUID 49268954-... is Server Activity
    INSERT INTO #intervals
    EXEC [snapshots].[rpt_interval_collection_times] 
        @ServerName, @EndTime, @WindowSize, 'snapshots.sql_process_and_system_memory', '49268954-4FD4-4EB6-AA04-CD59D9BB5714', 40, 0

    -- Get the earliest and latest snapshot_id values that contain data for the selected time interval. 
    -- This will allow a more efficient query plan. 
    DECLARE @start_snapshot_id int;
    DECLARE @end_snapshot_id int;
    SELECT @start_snapshot_id = MIN (first_snapshot_id)
    FROM #intervals
    SELECT @end_snapshot_id = MAX (last_snapshot_id)
    FROM #intervals
    
    -- Get sys.dm_os_process_memory for these intervals
    SELECT 
        coll.interval_time_id, coll.interval_id, 
        CONVERT (datetime, SWITCHOFFSET (CAST (coll.last_collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (coll.interval_start_time AS datetimeoffset(7)), '+00:00')) AS interval_start_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (coll.interval_end_time AS datetimeoffset(7)), '+00:00')) AS interval_end_time, 
        coll.last_snapshot_id, 
        AVG (sql_physical_memory_in_use_kb)             AS avg_sql_physical_memory_in_use_kb, 
        MAX (sql_physical_memory_in_use_kb)             AS max_sql_physical_memory_in_use_kb, 
        MIN (sql_physical_memory_in_use_kb)             AS min_sql_physical_memory_in_use_kb, 
        AVG (sql_total_virtual_address_space_kb)        AS avg_sql_total_virtual_address_space_kb, 
        AVG (sql_virtual_address_space_reserved_kb)     AS avg_sql_virtual_address_space_reserved_kb, 
        AVG (sql_virtual_address_space_committed_kb)    AS avg_sql_virtual_address_space_committed_kb, 
        AVG (sql_virtual_address_space_available_kb)    AS avg_sql_virtual_address_space_available_kb, 
        MAX (sql_virtual_address_space_available_kb)    AS max_sql_virtual_address_space_available_kb, 
        MIN (sql_virtual_address_space_available_kb)    AS min_sql_virtual_address_space_available_kb, 
        AVG (sql_memory_utilization_percentage)         AS avg_sql_memory_utilization_percentage, 
        MIN (sql_memory_utilization_percentage)         AS min_sql_memory_utilization_percentage, 
        AVG (sql_available_commit_limit_kb)             AS avg_sql_available_commit_limit_kb, 
        MIN (sql_available_commit_limit_kb)             AS min_sql_available_commit_limit_kb, 
        AVG (sql_large_page_allocations_kb)             AS avg_sql_large_page_allocations_kb, 
        AVG (sql_locked_page_allocations_kb)            AS avg_sql_locked_page_allocations_kb, 
        SUM (CAST (sql_process_physical_memory_low AS int)) AS sql_process_physical_memory_low_count, 
        SUM (CAST (sql_process_virtual_memory_low AS int))  AS sql_process_virtual_memory_low_count, 
        MAX (sql_page_fault_count) - MIN (sql_page_fault_count) AS interval_sql_page_fault_count, 
        AVG (system_total_physical_memory_kb)           AS system_total_physical_memory_kb, 
        AVG (system_available_physical_memory_kb)       AS avg_system_available_physical_memory_kb, 
        MAX (system_available_physical_memory_kb)       AS max_system_available_physical_memory_kb, 
        MIN (system_available_physical_memory_kb)       AS min_system_available_physical_memory_kb, 
        AVG (system_total_page_file_kb)                 AS avg_system_total_page_file_kb, 
        AVG (system_available_page_file_kb)             AS avg_system_available_page_file_kb, 
        MIN (system_available_page_file_kb)             AS min_system_available_page_file_kb, 
        AVG (system_cache_kb)                           AS avg_system_cache_kb, 
        AVG (system_kernel_paged_pool_kb)               AS avg_system_kernel_paged_pool_kb, 
        AVG (system_kernel_nonpaged_pool_kb)            AS avg_system_kernel_nonpaged_pool_kb, 
        SUM (CAST (system_high_memory_signal_state AS int)) AS system_high_memory_signal_state_count, 
        SUM (CAST (system_low_memory_signal_state AS int))  AS system_low_memory_signal_state_count, 
        AVG (bpool_commit_target)                       AS avg_bpool_commit_target, 
        MAX (bpool_commit_target)                       AS max_bpool_commit_target,  
        MIN (bpool_commit_target)                       AS min_bpool_commit_target, 
        AVG (bpool_committed)                           AS avg_bpool_committed, 
        MAX (bpool_committed)                           AS max_bpool_committed,  
        MIN (bpool_committed)                           AS min_bpool_committed, 
        AVG (bpool_visible)                             AS avg_bpool_visible, 
        MAX (bpool_visible)                             AS max_bpool_visible,  
        MIN (bpool_visible)                             AS min_bpool_visible 
    FROM snapshots.sql_process_and_system_memory AS pm
    INNER JOIN #intervals AS coll ON coll.last_snapshot_id = pm.snapshot_id AND coll.last_collection_time = pm.collection_time     
    GROUP BY 
        coll.interval_start_time, coll.interval_end_time, coll.interval_time_id, coll.last_collection_time, coll.interval_id, coll.last_snapshot_id
    ORDER BY coll.last_collection_time ASC;
END
GO


--
-- snapshots.rpt_sampled_waits
--  Returns a list of the apps and queries that spent the most time waiting for the specified wait category. 
--  Note that this is based off data collected from regular samples of sys.dm_exec_requests, 
--  sys.dm_os_waiting_tasks, and related DMVs.  Because these are just samples, it is not expected that 
--  all waits will be captured; at best, a representative sampling will be returned.  
-- 
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - end of the time window (UTC)
--    @WindowSize - number of minutes in the time window
--    @CategoryName - Optional filter criteria: Name of wait category
--    @WaitType - Optional filter criteria: Name of wait type
--    @ProgramName - Optional filter criteria: Application name
--    @SqlHandleStr - Optional filter criteria: Handle to a particular query
--    @StatementStartOffset - Start offset for a particular statement within the batch/proc specified by @SqlHandleStr
--    @StatementEndOffset - End offset for a particular statement within the batch/proc specified by @SqlHandleStr
--    @SessionID - Optional filter criteria: Specific SPID
--    @Database - Optional filter criteria: Waits within a particular database
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sampled_waits', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sampled_waits] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sampled_waits]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sampled_waits] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sampled_waits]
    @ServerName sysname, 
    @EndTime datetime, 
    @WindowSize int, 
    @CategoryName nvarchar(20) = NULL, 
    @WaitType nvarchar(45) = NULL, 
    @ProgramName nvarchar(50) = NULL, 
    @SqlHandleStr varchar(130) = NULL, 
    @StatementStartOffset int = NULL, 
    @StatementEndOffset int = NULL, 
    @SessionID int = NULL, 
    @Database nvarchar(255) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @start_time_internal datetimeoffset(7);
    DECLARE @end_time_internal datetimeoffset(7);

    -- Clean string params (on drillthrough, RS may pass in an empty string instead of NULL)
    IF @CategoryName = '' SET @CategoryName = NULL
    IF @WaitType = '' SET @WaitType = NULL
    IF @ProgramName = '' SET @ProgramName = NULL
    IF @SqlHandleStr = '' SET @SqlHandleStr = NULL
    IF @Database = '' SET @Database = NULL
    -- -1 is a potentially valid offset, but anything less is invalid. RS can't represent NULL in some places, so 
    -- translate int values that are out of range to NULL. 
    IF @StatementStartOffset < -1 SET @StatementStartOffset = NULL
    IF @StatementEndOffset < -1 SET @StatementStartOffset = NULL
    IF @SessionID < -1 SET @SessionID = NULL

    -- NOTE: The logic below is duplicated in snapshots.rpt_sampled_waits_longest.  It cannot be moved to a shared 
    -- child proc because of SQL restrictions (no nested INSERT EXECs, and table params are read only).  
    -- Also update snapshots.rpt_sampled_waits_longest if a change to this section is required. 

    /*** BEGIN DUPLICATED CODE SECTION ***/
        -- Start time should be passed in as a UTC datetime
        IF (@EndTime IS NOT NULL)
        BEGIN
            -- Assumed time zone offset for this conversion is +00:00 (datetime must be passed in as UTC)
            SET @end_time_internal = CAST (@EndTime AS datetimeoffset(7));
        END
        ELSE BEGIN
            SELECT @end_time_internal = MAX(ar.collection_time)
            FROM core.snapshots AS s
            INNER JOIN snapshots.active_sessions_and_requests AS ar ON s.snapshot_id = ar.snapshot_id
            WHERE s.instance_name = @ServerName -- AND collection_set_uid = '49268954-4FD4-4EB6-AA04-CD59D9BB5714' -- Server Activity CS
        END
        SET @start_time_internal = DATEADD (minute, -1 * @WindowSize, @end_time_internal);

        DECLARE @sql_handle varbinary(64)
        IF LEN (@SqlHandleStr) > 0
        BEGIN
            SET @sql_handle = snapshots.fn_hexstrtovarbin (@SqlHandleStr)
        END
        
        -- Divide our time window up into 40 evenly-sized time intervals, and find the first and last collection_time within each of these intervals
        CREATE TABLE #intervals (
            interval_time_id        int, 
            interval_start_time     datetimeoffset(7),
            interval_end_time       datetimeoffset(7),
            interval_id             int, 
            first_collection_time   datetimeoffset(7), 
            last_collection_time    datetimeoffset(7), 
            first_snapshot_id       int,
            last_snapshot_id        int, 
            source_id               int, 
            snapshot_id             int, 
            collection_time         datetimeoffset(7), 
            collection_time_id      int
        )
        INSERT INTO #intervals
        EXEC [snapshots].[rpt_interval_collection_times] 
            @ServerName, @EndTime, @WindowSize, 'snapshots.active_sessions_and_requests', '2dc02bd6-e230-4c05-8516-4e8c0ef21f95', 40, 1

        SELECT 
            ti.interval_id, ti.interval_time_id, ti.interval_start_time, ti.interval_end_time, 
            ti.collection_time, ti.collection_time_id, r.row_id, 
            r.snapshot_id, r.session_id, r.request_id, r.exec_context_id, r.wait_duration_ms, r.wait_resource, 
            r.login_time, r.program_name, r.sql_handle, r.statement_start_offset, r.statement_end_offset, r.plan_handle, 
            r.database_name, r.task_state, ti.source_id, wt.ignore, 
            -- Model CPU as a "wait type" in the sampling results.  Any active request without a wait type is assumed to be CPU-bound. 
            CASE -- same expression here as in the GROUP BY
                WHEN r.wait_type = '' AND r.task_state IS NOT NULL THEN 'CPU'
                ELSE wt.category_name 
            END AS category_name, 
            -- "Running" tasks are actively using the CPU.  A "runnable" task is able to run, but is momentarily waiting for the active 
            -- task to yield so the next runnable task can get scheduled. Map runnable to the SOS_SCHEDULER_YIELD wait type.
            CASE 
                WHEN r.wait_type = '' AND r.task_state = 'RUNNING' THEN 'CPU (Consumed)'
                WHEN r.wait_type = '' AND r.task_state != 'RUNNING' THEN 'SOS_SCHEDULER_YIELD'
                ELSE r.wait_type
            END AS wait_type
        INTO #waiting_tasks
        FROM snapshots.active_sessions_and_requests AS r
        LEFT OUTER JOIN core.wait_types_categorized AS wt ON wt.wait_type = r.wait_type 
        INNER JOIN #intervals AS ti ON r.collection_time = ti.collection_time AND r.snapshot_id = ti.snapshot_id 
        WHERE r.collection_time BETWEEN @start_time_internal AND @end_time_internal 
            AND r.command != 'AWAITING COMMAND' AND r.request_id != -1 -- exclude idle spids (e.g. head blockers)
            AND (r.program_name = @ProgramName OR @ProgramName IS NULL)
            AND (r.sql_handle = @sql_handle OR @SqlHandleStr IS NULL)
            AND (r.database_name = @Database OR @Database IS NULL)
            AND (r.statement_start_offset = @StatementStartOffset OR @SqlHandleStr IS NULL)
            AND (r.statement_end_offset = @StatementEndOffset OR @SqlHandleStr IS NULL)
            AND (r.session_id = @SessionID OR @SessionID IS NULL)
            AND 
            ( -- ... and wait category either matches the user-specified parameter ...
                (@CategoryName = 
                    CASE -- same expression here as in the select column list
                        WHEN r.wait_type = '' AND r.task_state IS NOT NULL THEN 'CPU'
                        ELSE wt.category_name 
                    END
                ) 
                -- ... or a filter parameter for wait category was not provided (return all categories that aren't marked as ignorable). 
                OR (@CategoryName IS NULL AND ISNULL (wt.ignore, 0) = 0)
            )
            AND 
            ( -- ... and wait type either matches the user-specified parameter ...
                (@WaitType = 
                    CASE 
                        WHEN r.wait_type = '' AND r.task_state = 'RUNNING' THEN 'CPU (Consumed)'
                        WHEN r.wait_type = '' AND r.task_state != 'RUNNING' THEN 'SOS_SCHEDULER_YIELD'
                        ELSE r.wait_type
                    END 
                )
                -- ... or a filter parameter for wait category was not provided 
                OR @WaitType IS NULL
            )            
        -- Force a recompile of this statement to take into account the actual values of @start_time_internal and 
        -- @end_time_internal, which were not available at the time of proc compilation. 
        OPTION (RECOMPILE);
        
    /*** END DUPLICATED CODE SECTION ***/
    
    -- Get query text (do this here instead of in the following query so that we don't waste time retrieving the 
    -- same query's text more than once). 
    SELECT 
        r.sql_handle, r.statement_start_offset, r.statement_end_offset, 
        REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (
            LEFT (LTRIM (qt.query_text), 100)
            , CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '), '   ', ' '), '  ', ' '), '  ', ' ') AS flat_query_text
    INTO #queries
    FROM 
    (
        SELECT DISTINCT source_id, sql_handle, statement_start_offset, statement_end_offset
        FROM #waiting_tasks
        WHERE category_name IS NOT NULL 
    ) AS r
    OUTER APPLY snapshots.fn_get_query_text(r.source_id, r.sql_handle, r.statement_start_offset, r.statement_end_offset) AS qt

    -- Within each time interval, group the wait counts by waittype, app, db, and query. 
    SELECT 
        CONVERT (datetime, SWITCHOFFSET (r.interval_start_time, '+00:00')) AS interval_start_time, 
        CONVERT (datetime, SWITCHOFFSET (r.interval_end_time, '+00:00')) AS interval_end_time, 
        r.interval_id, r.interval_time_id, 
        r.source_id, r.category_name, r.wait_type, r.[program_name], r.database_name, 
        COUNT (*) AS wait_count, r.sql_handle, r.statement_start_offset, r.statement_end_offset,
        master.dbo.fn_varbintohexstr (r.sql_handle) AS sql_handle_str, 
        q.flat_query_text
    FROM #waiting_tasks AS r 
    LEFT OUTER JOIN #queries AS q ON r.sql_handle = q.sql_handle AND r.statement_start_offset = q.statement_start_offset 
        AND r.statement_end_offset = q.statement_end_offset 
    WHERE r.category_name IS NOT NULL 
    GROUP BY r.interval_start_time, r.interval_end_time, r.interval_id, r.interval_time_id,
        r.category_name, r.wait_type, r.[program_name], r.database_name, r.[sql_handle], 
        r.source_id, r.statement_start_offset, r.statement_end_offset, q.flat_query_text
    ORDER BY r.category_name, r.interval_id, COUNT(*) DESC

END 
GO


--
-- snapshots.rpt_sampled_waits_longest
--  Returns list of the N longest waits that meet user-specified filter criteria.  
--  Note that this is based off data collected from regular samples of sys.dm_exec_requests, 
--  sys.dm_os_waiting_tasks, and related DMVs.  Because these are just samples, it is not expected that 
--  all waits will be captured; at best, a representative sampling will be returned.  
-- 
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - end of the time window (UTC)
--    @WindowSize - number of minutes in the time window
--    @CategoryName - Optional filter criteria: Name of wait category
--    @WaitType - Optional filter criteria: Name of wait type
--    @ProgramName - Optional filter criteria: Application name
--    @SqlHandleStr - Optional filter criteria: Name of the query to filter on
--    @StatementStartOffset - Start offset for a particular statement within the batch/proc specified by @SqlHandleStr
--    @StatementEndOffset - End offset for a particular statement within the batch/proc specified by @SqlHandleStr
--    @SessionID - Optional filter criteria: Specific SPID
--    @Database - Optional filter criteria: Waits within a particular database
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sampled_waits_longest', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sampled_waits_longest] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sampled_waits_longest]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sampled_waits_longest] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sampled_waits_longest]
    @ServerName sysname, 
    @EndTime datetime, 
    @WindowSize int, 
    @CategoryName nvarchar(20) = NULL, 
    @WaitType nvarchar(45) = NULL, 
    @ProgramName nvarchar(50) = NULL, 
    @SqlHandleStr varchar(130) = NULL, 
    @StatementStartOffset int = NULL, 
    @StatementEndOffset int = NULL, 
    @SessionID int = NULL, 
    @Database nvarchar(255) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @start_time_internal datetimeoffset(7);
    DECLARE @end_time_internal datetimeoffset(7);

    -- Clean string params (on drillthrough, RS may pass in an empty string instead of NULL)
    IF @CategoryName = '' SET @CategoryName = NULL
    IF @WaitType = '' SET @WaitType = NULL
    IF @ProgramName = '' SET @ProgramName = NULL
    IF @SqlHandleStr = '' SET @SqlHandleStr = NULL
    IF @Database = '' SET @Database = NULL
    -- -1 is a potentially valid offset, but anything less is invalid. RS can't represent NULL in some places, so 
    -- translate int values that are out of range to NULL. 
    IF @StatementStartOffset < -1 SET @StatementStartOffset = NULL
    IF @StatementEndOffset < -1 SET @StatementStartOffset = NULL
    IF @SessionID < -1 SET @SessionID = NULL

    -- NOTE: The logic below is duplicated in snapshots.rpt_sampled_waits.  It cannot be moved to a shared 
    -- child proc because of SQL restrictions (no nested INSERT EXECs, and table params are read only).  
    -- Also update snapshots.rpt_sampled_waits if a change to this section is required. 

    /*** BEGIN DUPLICATED CODE SECTION ***/
        -- Start time should be passed in as a UTC datetime
        IF (@EndTime IS NOT NULL)
        BEGIN
            -- Assumed time zone offset for this conversion is +00:00 (datetime must be passed in as UTC)
            SET @end_time_internal = CAST (@EndTime AS datetimeoffset(7));
        END
        ELSE BEGIN
            SELECT @end_time_internal = MAX(ar.collection_time)
            FROM core.snapshots AS s
            INNER JOIN snapshots.active_sessions_and_requests AS ar ON s.snapshot_id = ar.snapshot_id
            WHERE s.instance_name = @ServerName -- AND collection_set_uid = '49268954-4FD4-4EB6-AA04-CD59D9BB5714' -- Server Activity CS
        END
        SET @start_time_internal = DATEADD (minute, -1 * @WindowSize, @end_time_internal);

        DECLARE @sql_handle varbinary(64)
        IF LEN (@SqlHandleStr) > 0
        BEGIN
            SET @sql_handle = snapshots.fn_hexstrtovarbin (@SqlHandleStr)
        END
        
        -- Divide our time window up into 40 evenly-sized time intervals, and find the first and last collection_time within each of these intervals
        CREATE TABLE #intervals (
            interval_time_id        int, 
            interval_start_time     datetimeoffset(7),
            interval_end_time       datetimeoffset(7),
            interval_id             int, 
            first_collection_time   datetimeoffset(7), 
            last_collection_time    datetimeoffset(7), 
            first_snapshot_id       int,
            last_snapshot_id        int, 
            source_id               int, 
            snapshot_id             int, 
            collection_time         datetimeoffset(7), 
            collection_time_id      int
        )
        INSERT INTO #intervals
        EXEC [snapshots].[rpt_interval_collection_times] 
            @ServerName, @EndTime, @WindowSize, 'snapshots.active_sessions_and_requests', '2dc02bd6-e230-4c05-8516-4e8c0ef21f95', 40, 1

        SELECT 
            ti.interval_id, ti.interval_time_id, ti.interval_start_time, ti.interval_end_time, 
            ti.collection_time, ti.collection_time_id, r.row_id, 
            r.snapshot_id, r.session_id, r.request_id, r.exec_context_id, r.wait_duration_ms, r.wait_resource, 
            r.login_time, r.program_name, r.sql_handle, r.statement_start_offset, r.statement_end_offset, r.plan_handle, 
            r.database_name, r.task_state, ti.source_id, wt.ignore, 
            -- Model CPU as a "wait type" in the sampling results.  Any active request without a wait type is assumed to be CPU-bound. 
            CASE -- same expression here as in the GROUP BY
                WHEN r.wait_type = '' AND r.task_state IS NOT NULL THEN 'CPU'
                ELSE wt.category_name 
            END AS category_name, 
            -- "Running" tasks are actively using the CPU.  A "runnable" task is able to run, but is momentarily waiting for the active 
            -- task to yield so the next runnable task can get scheduled. Map runnable to the SOS_SCHEDULER_YIELD wait type.
            CASE 
                WHEN r.wait_type = '' AND r.task_state = 'RUNNING' THEN 'CPU (Consumed)'
                WHEN r.wait_type = '' AND r.task_state != 'RUNNING' THEN 'SOS_SCHEDULER_YIELD'
                ELSE r.wait_type
            END AS wait_type
        INTO #waiting_tasks
        FROM snapshots.active_sessions_and_requests AS r
        LEFT OUTER JOIN core.wait_types_categorized AS wt ON wt.wait_type = r.wait_type 
        INNER JOIN #intervals AS ti ON r.collection_time = ti.collection_time AND r.snapshot_id = ti.snapshot_id 
        WHERE r.collection_time BETWEEN @start_time_internal AND @end_time_internal 
            AND r.command != 'AWAITING COMMAND' AND r.request_id != -1 -- exclude idle spids (e.g. head blockers)
            AND (r.program_name = @ProgramName OR @ProgramName IS NULL)
            AND (r.sql_handle = @sql_handle OR @SqlHandleStr IS NULL)
            AND (r.database_name = @Database OR @Database IS NULL)
            AND (r.statement_start_offset = @StatementStartOffset OR @SqlHandleStr IS NULL)
            AND (r.statement_end_offset = @StatementEndOffset OR @SqlHandleStr IS NULL)
            AND (r.session_id = @SessionID OR @SessionID IS NULL)
            AND 
            ( -- ... and wait category either matches the user-specified parameter ...
                (@CategoryName = 
                    CASE -- same expression here as in the select column list
                        WHEN r.wait_type = '' AND r.task_state IS NOT NULL THEN 'CPU'
                        ELSE wt.category_name 
                    END
                ) 
                -- ... or a filter parameter for wait category was not provided (return all categories that aren't marked as ignorable). 
                OR (@CategoryName IS NULL AND ISNULL (wt.ignore, 0) = 0)
            )
            AND 
            ( -- ... and wait type either matches the user-specified parameter ...
                (@WaitType = 
                    CASE 
                        WHEN r.wait_type = '' AND r.task_state = 'RUNNING' THEN 'CPU (Consumed)'
                        WHEN r.wait_type = '' AND r.task_state != 'RUNNING' THEN 'SOS_SCHEDULER_YIELD'
                        ELSE r.wait_type
                    END 
                )
                -- ... or a filter parameter for wait category was not provided 
                OR @WaitType IS NULL
            )
        -- Force a recompile of this statement to take into account the actual values of @start_time_internal and 
        -- @end_time_internal, which were not available at the time of proc compilation. 
        OPTION (RECOMPILE);
        
    /*** END DUPLICATED CODE SECTION ***/

    CREATE INDEX idx1 ON #waiting_tasks (collection_time_id, session_id)

    -- The same long-lived wait may be captured multiple times.  For a given wait, we only care about the max 
    -- wait time within the target time window. If we see that the immediately following sample shows the same 
    -- spid waiting with a wait time that spans both samples, we discard the preceding sample and keep only 
    -- the max wait time.  For example, in the data below, spid 54 was stuck in the same long-lived lock wait 
    -- from row 1 through row 3.  From this data, we would only keep rows #3 and #4. Rows #1 and #2 are 
    -- discarded to avoid reporting the same long wait several times. 
    -- 
    --     (row#)   collection_time     session_id  wait_type    wait_duration_ms  
    --              ------------------- ----------- ------------ -----------------
    --       1      2007-10-25 13:01:00          53 LCK_M_S                   8141
    --       2      2007-10-25 13:01:10          53 LCK_M_S                  18278
    --       3      2007-10-25 13:01:20          53 LCK_M_S                  28318
    --       4      2007-10-25 13:01:30          54 LCK_M_X                    755
    --
    -- Also, if there was one collection time where everyone was blocked momentarily, we want to avoid 
    -- reporting that collection time over and over w/only the spid # varying; that's not the most interesting 
    -- sampling.  Instead, report the longest wait in each of the top 10 collection times (top 10 times by max 
    -- wait duration at the collection time).  
    SELECT TOP 10
        CONVERT (datetime, SWITCHOFFSET (r1.collection_time, '+00:00')) AS collection_time, 
        CONVERT (varchar(30), CONVERT (datetime, SWITCHOFFSET (r1.collection_time, '+00:00')), 126) AS collection_time_str, 
        r1.snapshot_id, r1.row_id, 
        r1.session_id, r1.request_id, r1.exec_context_id, r1.wait_resource, 
        r1.source_id, r1.category_name, r1.wait_type, r1.wait_duration_ms, 
        r1.database_name, r1.[program_name], r1.[sql_handle], r1.statement_start_offset, r1.statement_end_offset, r1.plan_handle
    FROM #waiting_tasks AS r1
    -- Find the same spid in the next collection time
    LEFT OUTER JOIN #waiting_tasks AS r2 
        ON r2.collection_time_id = r1.collection_time_id + 1 AND r2.session_id = r1.session_id 
            AND r2.request_id = r1.request_id AND r2.exec_context_id = r1.exec_context_id AND r2.login_time = r1.login_time 
    WHERE 
        -- Prevent reporting the same wait spanning multiple collection times. 
        (   
            -- ... where the spid wasn't seen waiting at the next collection time
            r2.session_id IS NULL 
            -- ... or the wait at the next collection time is shorter than it would have been if the wait had spanned both collection times 
            OR r2.wait_duration_ms < (DATEDIFF (second, r1.collection_time, r2.collection_time) * 1000)
        )
        -- Exclude all but the longest wait in any given collection time
        AND NOT EXISTS 
        (
            SELECT * FROM #waiting_tasks AS r3
            WHERE r3.collection_time_id = r1.collection_time_id 
                AND r3.wait_duration_ms > r1.wait_duration_ms 
                OR (r3.wait_duration_ms = r1.wait_duration_ms AND r3.row_id > r1.row_id)
        )
    ORDER BY r1.wait_duration_ms DESC
   
END
GO


--
-- snapshots.rpt_sampled_waits_hottest_resources
--  Returns list of the N longest waits that meet user-specified filter criteria.  
--  Note that this is based off data collected from regular samples of sys.dm_exec_requests, 
--  sys.dm_os_waiting_tasks, and related DMVs.  Because these are just samples, it is not expected that 
--  all waits will be captured; at best, a representative sampling will be returned.  
-- 
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - end of the time window (UTC)
--    @WindowSize - number of minutes in the time window
--    @CategoryName - Optional filter criteria: Name of wait category
--    @WaitType - Optional filter criteria: Name of wait type
--    @ProgramName - Optional filter criteria: Application name
--    @SqlHandleStr - Optional filter criteria: Name of the query to filter on
--    @StatementStartOffset - Start offset for a particular statement within the batch/proc specified by @SqlHandleStr
--    @StatementEndOffset - End offset for a particular statement within the batch/proc specified by @SqlHandleStr
--    @SessionID - Option filter criteria: Specific SPID
--    @Database - Optional filter criteria: Waits within a particular database
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sampled_waits_hottest_resources', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sampled_waits_hottest_resources] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sampled_waits_hottest_resources]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sampled_waits_hottest_resources] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sampled_waits_hottest_resources]
    @ServerName sysname, 
    @EndTime datetime, 
    @WindowSize int, 
    @CategoryName nvarchar(20) = NULL, 
    @WaitType nvarchar(45) = NULL, 
    @ProgramName nvarchar(50) = NULL, 
    @SqlHandleStr varchar(130) = NULL, 
    @StatementStartOffset int = NULL, 
    @StatementEndOffset int = NULL, 
    @SessionID int = NULL, 
    @Database nvarchar(255) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @start_time_internal datetimeoffset(7);
    DECLARE @end_time_internal datetimeoffset(7);

    -- Clean string params (on drillthrough, RS may pass in an empty string instead of NULL)
    IF @CategoryName = '' SET @CategoryName = NULL
    IF @WaitType = '' SET @WaitType = NULL
    IF @ProgramName = '' SET @ProgramName = NULL
    IF @SqlHandleStr = '' SET @SqlHandleStr = NULL
    IF @Database = '' SET @Database = NULL
    -- -1 is a potentially valid offset, but anything less is invalid. RS can't represent NULL in some places, so 
    -- translate int values that are out of range to NULL. 
    IF @StatementStartOffset < -1 SET @StatementStartOffset = NULL
    IF @StatementEndOffset < -1 SET @StatementStartOffset = NULL
    IF @SessionID < -1 SET @SessionID = NULL

    -- Start time should be passed in as a UTC datetime
    IF (@EndTime IS NOT NULL)
    BEGIN
        -- Assumed time zone offset for this conversion is +00:00 (datetime must be passed in as UTC)
        SET @end_time_internal = CAST (@EndTime AS datetimeoffset(7));
    END
    ELSE BEGIN
        SELECT @end_time_internal = MAX(ar.collection_time)
        FROM core.snapshots AS s
        INNER JOIN snapshots.active_sessions_and_requests AS ar ON s.snapshot_id = ar.snapshot_id
        WHERE s.instance_name = @ServerName -- AND collection_set_uid = '49268954-4FD4-4EB6-AA04-CD59D9BB5714' -- Server Activity CS
    END
    SET @start_time_internal = DATEADD (minute, -1 * @WindowSize, @end_time_internal);

    DECLARE @sql_handle varbinary(64)
    IF LEN (@SqlHandleStr) > 0
    BEGIN
        SET @sql_handle = snapshots.fn_hexstrtovarbin (@SqlHandleStr)
    END
    
    SELECT TOP 10 
        wt.category_name, r.wait_type, 
        CASE 
            WHEN LEN (ISNULL (r.wait_resource, '')) = 0 THEN 
                CASE 
                    WHEN LEN (r.resource_description) > 30 THEN LEFT (r.resource_description, 27) + '...'
                    ELSE LEFT (r.resource_description, 30)
                END
            ELSE r.wait_resource
        END AS wait_resource, 
        r.resource_description, 
        CONVERT (datetime, SWITCHOFFSET (MAX (r.collection_time), '+00:00')) AS example_collection_time, 
        CONVERT (varchar(30), CONVERT (datetime, SWITCHOFFSET (MAX (r.collection_time), '+00:00')), 126) AS example_collection_time_str, 
        COUNT(*) AS wait_count
    FROM snapshots.active_sessions_and_requests AS r 
    LEFT OUTER JOIN core.wait_types_categorized AS wt ON wt.wait_type = r.wait_type 
    WHERE r.collection_time BETWEEN @start_time_internal AND @end_time_internal 
        AND r.command != 'AWAITING COMMAND' AND r.request_id != -1 -- exclude idle spids (e.g. head blockers)
        AND (r.program_name = @ProgramName OR @ProgramName IS NULL)
        AND (r.sql_handle = @sql_handle OR @SqlHandleStr IS NULL)
        AND (r.database_name = @Database OR @Database IS NULL)
        AND (r.statement_start_offset = @StatementStartOffset OR @SqlHandleStr IS NULL)
        AND (r.statement_end_offset = @StatementEndOffset OR @SqlHandleStr IS NULL)
        AND (r.session_id = @SessionID OR @SessionID IS NULL)
        AND 
        ( -- ... and wait category either matches the user-specified parameter ...
            (@CategoryName = 
                CASE -- same expression here as in the select column list
                    WHEN r.wait_type = '' AND r.task_state IS NOT NULL THEN 'CPU'
                    ELSE wt.category_name 
                END
            ) 
            -- ... or a filter parameter for wait category was not provided (return all categories that aren't marked as ignorable). 
            OR (@CategoryName IS NULL AND ISNULL (wt.ignore, 0) = 0)
        )
        AND 
        ( -- ... and wait type either matches the user-specified parameter ...
            (@WaitType = 
                CASE 
                    WHEN r.wait_type = '' AND r.task_state = 'RUNNING' THEN 'CPU (Consumed)'
                    WHEN r.wait_type = '' AND r.task_state != 'RUNNING' THEN 'SOS_SCHEDULER_YIELD'
                    ELSE r.wait_type
                END 
            )
            -- ... or a filter parameter for wait category was not provided 
            OR @WaitType IS NULL
        )
        -- Exclude rows where there is no named resource
        AND (ISNULL (r.resource_description, '') != '' OR ISNULL (r.wait_resource, '') != '')
    GROUP BY wt.category_name, r.wait_type, r.wait_resource, r.resource_description
    ORDER BY COUNT(*) DESC
    -- Force a recompile of this statement to take into account the actual values of @start_time_internal and 
    -- @end_time_internal, which were not available at the time of proc compilation. 
    OPTION (RECOMPILE);
   
END
GO


--
-- snapshots.rpt_io_virtual_file_stats
--  Returns wait time per wait type over a time interval
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - End of the user-selected time window (UTC)
--    @WindowSize - Number of minutes in the time window 
--    @CategoryName - (Optional) Name of wait category to filter on (all categories if NULL)
--    @WaitType - (Optional) Name of wait type to filter on (all wait types if NULL)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_io_virtual_file_stats', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_io_virtual_file_stats] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_io_virtual_file_stats]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_io_virtual_file_stats] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_io_virtual_file_stats]
    @ServerName sysname,
    @EndTime datetime = NULL,
    @WindowSize int,
    @LogicalDisk nvarchar(255) = NULL, 
    @Database nvarchar(255) = NULL 
AS
BEGIN
    SET NOCOUNT ON;

    -- Clean string params (on drillthrough, RS may pass in empty string instead of NULL)
    IF @LogicalDisk = '' SET @LogicalDisk = NULL
    IF @Database = '' SET @Database = NULL

    -- Divide our time window up into 40 evenly-sized time intervals, and find the last collection_time within each of these intervals
    CREATE TABLE #intervals (
        interval_time_id        int, 
        interval_start_time     datetimeoffset(7),
        interval_end_time       datetimeoffset(7),
        interval_id             int, 
        first_collection_time   datetimeoffset(7), 
        last_collection_time    datetimeoffset(7), 
        first_snapshot_id       int,
        last_snapshot_id        int, 
        source_id               int,
        snapshot_id             int, 
        collection_time         datetimeoffset(7), 
        collection_time_id      int
    )
    -- GUID 49268954-... is Server Activity
    INSERT INTO #intervals
    EXEC [snapshots].[rpt_interval_collection_times] 
        @ServerName, @EndTime, @WindowSize, 'snapshots.io_virtual_file_stats', '49268954-4FD4-4EB6-AA04-CD59D9BB5714', 40, 0

    -- Get the earliest and latest snapshot_id values that contain data for the selected time interval. 
    -- This will allow a more efficient query plan. 
    DECLARE @start_snapshot_id int;
    DECLARE @end_snapshot_id int;
    SELECT @start_snapshot_id = MIN (first_snapshot_id)
    FROM #intervals
    SELECT @end_snapshot_id = MAX (last_snapshot_id)
    FROM #intervals
    
    -- Get the file stats for these collection times
    SELECT 
        coll.interval_id, coll.interval_time_id, coll.interval_start_time, coll.interval_end_time, 
        coll.first_collection_time, coll.last_collection_time, coll.first_snapshot_id, coll.last_snapshot_id, 
        fs.*
    INTO #file_stats
    FROM snapshots.io_virtual_file_stats AS fs
    INNER JOIN #intervals AS coll ON coll.last_snapshot_id = fs.snapshot_id AND coll.last_collection_time = fs.collection_time 
    WHERE 
        fs.logical_disk = ISNULL (@LogicalDisk, fs.logical_disk)
        AND fs.database_name = ISNULL (@Database, fs.database_name)
    
    -- Get file stats deltas for each interval.  
    SELECT 
        t.*, 
        /**** Combined reads + write values ****/
        t.num_of_reads_delta + t.num_of_writes_delta                    AS num_of_transfers_delta, 
        t.num_of_reads_cumulative + t.num_of_writes_cumulative          AS num_of_transfers_cumulative,  
        t.num_of_mb_read_delta + t.num_of_mb_written_delta              AS num_of_mb_transferred_delta, 
        t.num_of_mb_read_cumulative + t.num_of_mb_written_cumulative    AS num_of_mb_transferred_cumulative, 
        /**** Calc "Disk sec/Transfer" type values ***/
        t.io_stall_read_ms_delta + t.io_stall_write_ms_delta            AS io_stall_ms_delta, 
        t.io_stall_read_ms_cumulative + t.io_stall_write_ms_cumulative  AS io_stall_ms_cumulative, 
        CASE 
            WHEN t.num_of_reads_delta = 0 THEN 0 
            ELSE t.io_stall_read_ms_delta / t.num_of_reads_delta
        END                                                             AS io_stall_ms_per_read_delta, 
        CASE 
            WHEN t.num_of_reads_cumulative = 0 THEN 0 
            ELSE t.io_stall_read_ms_cumulative / t.num_of_reads_cumulative
        END                                                             AS io_stall_ms_per_read_cumulative, 
        CASE
            WHEN t.num_of_writes_delta = 0 THEN 0
            ELSE t.io_stall_write_ms_delta / t.num_of_writes_delta
        END                                                             AS io_stall_ms_per_write_delta, 
        CASE
            WHEN t.num_of_writes_cumulative = 0 THEN 0
            ELSE t.io_stall_write_ms_cumulative / t.num_of_writes_cumulative
        END                                                             AS io_stall_ms_per_write_cumulative, 
        CASE
            WHEN (t.num_of_reads_delta + t.num_of_writes_delta) = 0 THEN 0
            ELSE (t.io_stall_read_ms_delta + t.io_stall_write_ms_delta) / (t.num_of_reads_delta + t.num_of_writes_delta)
        END                                                             AS io_stall_ms_per_transfer_delta, 
        CASE
            WHEN (t.num_of_reads_cumulative + t.num_of_writes_cumulative) = 0 THEN 0
            ELSE (t.io_stall_read_ms_cumulative + t.io_stall_write_ms_cumulative) / (t.num_of_reads_cumulative + t.num_of_writes_cumulative)
        END                                                             AS io_stall_ms_per_transfer_cumulative 
    FROM
    (
        SELECT 
            fs1.interval_id, fs1.interval_time_id, fs1.first_snapshot_id, fs1.last_snapshot_id, 
            -- Convert all datetimeoffset values to UTC datetime values before returning to Reporting Services
            CONVERT (datetime, SWITCHOFFSET (CAST (fs1.first_collection_time AS datetimeoffset(7)), '+00:00')) AS first_collection_time, 
            CONVERT (datetime, SWITCHOFFSET (CAST (fs2.first_collection_time AS datetimeoffset(7)), '+00:00')) AS last_collection_time, 
            CONVERT (datetime, SWITCHOFFSET (CAST (fs1.interval_start_time AS datetimeoffset(7)), '+00:00')) AS interval_start, 
            CONVERT (datetime, SWITCHOFFSET (CAST (fs2.interval_start_time AS datetimeoffset(7)), '+00:00')) AS interval_end, 
            fs2.database_name, fs2.database_id, fs2.logical_file_name, fs2.[file_id], fs2.type_desc, fs2.logical_disk, 
            -- All file stats will be reset to zero by a service cycle, which will cause 
            -- (snapshot2_io_time-snapshot1_io_time) calculations to produce an incorrect 
            -- negative wait time for the interval.  Detect this and avoid calculating 
            -- negative IO wait time deltas. 
            /***** READS ****/
            CASE 
                WHEN (fs2.num_of_reads - fs1.num_of_reads) < 0 THEN fs2.num_of_reads
                ELSE (fs2.num_of_reads - fs1.num_of_reads)
            END AS num_of_reads_delta,                                              -- num_of_reads_delta
            fs2.num_of_reads AS num_of_reads_cumulative,                            -- num_of_reads_cumulative
            CASE 
                WHEN (fs2.num_of_bytes_read - fs1.num_of_bytes_read) < 0 THEN fs2.num_of_bytes_read 
                ELSE (fs2.num_of_bytes_read - fs1.num_of_bytes_read)
            END / 1024 / 1024 AS num_of_mb_read_delta,                              -- num_of_mb_read_delta
            fs2.num_of_bytes_read /1024/1024 AS num_of_mb_read_cumulative,          -- num_of_mb_read_cumulative
            CASE
                WHEN (fs2.io_stall_read_ms - fs1.io_stall_read_ms) < 0 THEN fs2.io_stall_read_ms
                ELSE (fs2.io_stall_read_ms - fs1.io_stall_read_ms)
            END AS io_stall_read_ms_delta,                                          -- io_stall_read_ms_delta
            fs2.io_stall_read_ms AS io_stall_read_ms_cumulative,                    -- io_stall_read_ms_cumulative
            /**** WRITES ****/
            CASE
                WHEN (fs2.num_of_writes - fs1.num_of_writes) < 0 THEN fs2.num_of_writes
                ELSE (fs2.num_of_writes - fs1.num_of_writes)
            END AS num_of_writes_delta,                                             -- num_of_writes_delta
            fs2.num_of_writes AS num_of_writes_cumulative,                          -- num_of_writes_cumulative
            CASE
                WHEN (fs2.num_of_bytes_written - fs1.num_of_bytes_written) < 0 THEN fs2.num_of_bytes_written
                ELSE (fs2.num_of_bytes_written - fs1.num_of_bytes_written)
            END / 1024 / 1024 AS num_of_mb_written_delta,                           -- num_of_mb_written_delta
            fs2.num_of_bytes_written /1024/1024 AS num_of_mb_written_cumulative,    -- num_of_mb_written_cumulative
            CASE
                WHEN (fs2.io_stall_write_ms - fs1.io_stall_write_ms) < 0 THEN fs2.io_stall_write_ms
                ELSE (fs2.io_stall_write_ms - fs1.io_stall_write_ms)
            END AS io_stall_write_ms_delta,                                         -- io_stall_write_ms_delta
            fs2.io_stall_write_ms AS io_stall_write_ms_cumulative,                  -- io_stall_write_ms_cumulative
            fs1.size_on_disk_bytes / 1024 / 1024 AS size_on_disk_mb_interval_start, -- size_on_disk_mb_interval_start
            fs2.size_on_disk_bytes / 1024 / 1024 AS size_on_disk_mb_interval_end    -- size_on_disk_mb_interval_end
        FROM #file_stats AS fs1
        -- Self-join - fs1 represents IO stats at the beginning of the sample interval, while fs2 
        -- shows file stats at the end of the interval. 
        INNER JOIN #file_stats AS fs2 ON fs1.database_id = fs2.database_id AND fs1.[file_id] = fs2.[file_id] AND fs1.interval_id = fs2.interval_id-1 

    ) AS t
    ORDER BY t.database_name, t.logical_file_name, t.last_collection_time
END
GO


--
-- snapshots.rpt_list_all_servers
--  Shows a list of the servers that have data in this MDW database, plus information on how up-to-date 
--  the data is.  Used in the multi-server overview report. 
-- Parameters: 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_list_all_servers', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_list_all_servers] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_list_all_servers]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_list_all_servers] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_list_all_servers]
AS
BEGIN
    SET NOCOUNT ON;

    SELECT 
        instance_name, 
        query_statistics_last_upload, 
        disk_usage_last_upload, 
        server_activity_last_upload
    FROM 
    (
        SELECT 
            -- Name of the SQL Server instance
            instance_name, 
            -- Name of the collection set.  The names in the syscollector_collection_sets table can be localized. 
            -- We use well-known strings here because we want to defer selection of the appropriate localized 
            -- string to the client. 
            CASE 
                collection_set_uid
                WHEN '2DC02BD6-E230-4C05-8516-4E8C0EF21F95' THEN 'query_statistics_last_upload'
                WHEN '7B191952-8ECF-4E12-AEB2-EF646EF79FEF' THEN 'disk_usage_last_upload'
                WHEN '49268954-4FD4-4EB6-AA04-CD59D9BB5714' THEN 'server_activity_last_upload'
                ELSE NULL -- custom Collection set, not displayed on this report
            END AS top_level_report_name,
            -- Convert datetimeoffset to UTC datetime for RS 2005 compatibility 
            CONVERT (datetime, SWITCHOFFSET (MAX (snapshot_time), '+00:00')) AS latest_snapshot_time 
        FROM core.snapshots 
        -- For this report, only system collection sets matter
        WHERE collection_set_uid IN ('2DC02BD6-E230-4C05-8516-4E8C0EF21F95', '7B191952-8ECF-4E12-AEB2-EF646EF79FEF', '49268954-4FD4-4EB6-AA04-CD59D9BB5714')
        GROUP BY instance_name, collection_set_uid
    ) AS instance_report_list 
    PIVOT 
    (
        MAX (latest_snapshot_time)
        FOR top_level_report_name IN (query_statistics_last_upload, disk_usage_last_upload, server_activity_last_upload)
    ) AS pvt 
    ORDER BY instance_name;

END;
GO




/**********************************************************************/
/* CUSTOM_SNAPSHOTS SCHEMA                                            */
/**********************************************************************/
RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Create schema custom_snpshots...', 0, 1)  WITH NOWAIT;
GO
IF (SCHEMA_ID('custom_snapshots') IS NULL)
BEGIN
    DECLARE @sql nvarchar(128)
    SET @sql = 'CREATE SCHEMA custom_snapshots'
    EXEC sp_executesql @sql
END
GO




/**********************************************************************/
/* Create MDW security roles                                          */
/**********************************************************************/
RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Create mdw_admin role...', 0, 1)  WITH NOWAIT;
IF ( NOT EXISTS (SELECT * FROM sys.database_principals 
                    WHERE name = N'mdw_admin' AND type = 'R'))
BEGIN
    CREATE ROLE [mdw_admin]
END
ELSE -- if the role exists check to see if it has members
BEGIN
    IF NOT EXISTS (SELECT rm.member_principal_id
                FROM sys.database_principals dp 
                INNER JOIN sys.database_role_members rm ON rm.role_principal_id = dp.principal_id
                WHERE name = N'mdw_admin' AND type = 'R')
    BEGIN
        -- if the role has no members drop and recreate it
        DROP ROLE [mdw_admin]
        CREATE ROLE [mdw_admin]
    END
END
GO

RAISERROR('Create mdw_writer role...', 0, 1)  WITH NOWAIT;
IF ( NOT EXISTS (SELECT * FROM sys.database_principals 
                    WHERE name = N'mdw_writer' AND type = 'R'))
BEGIN
    CREATE ROLE [mdw_writer]
END
ELSE -- if the role exists check to see if it has members
BEGIN
    IF NOT EXISTS (SELECT rm.member_principal_id
                FROM sys.database_principals dp 
                INNER JOIN sys.database_role_members rm ON rm.role_principal_id = dp.principal_id
                WHERE name = N'mdw_writer' AND type = 'R')
    BEGIN
        -- if the role has no members drop and recreate it
        DROP ROLE [mdw_writer]
        CREATE ROLE [mdw_writer]
    END
END
GO

RAISERROR('Create mdw_reader role...', 0, 1)  WITH NOWAIT;
IF ( NOT EXISTS (SELECT * FROM sys.database_principals 
                    WHERE name = N'mdw_reader' AND type = 'R'))
BEGIN
    CREATE ROLE [mdw_reader]
END
ELSE -- if the role exists check to see if it has members
BEGIN
    IF NOT EXISTS (SELECT rm.member_principal_id
                FROM sys.database_principals dp 
                INNER JOIN sys.database_role_members rm ON rm.role_principal_id = dp.principal_id
                WHERE name = N'mdw_reader' AND type = 'R')
    BEGIN
        -- if the role has no members drop and recreate it
        DROP ROLE [mdw_reader]
        CREATE ROLE [mdw_reader]
    END
END
GO

-- permissions of mdw_writer and mdw_reader are inclusive to mdw_admin
EXECUTE sp_addrolemember @rolename = 'mdw_writer' , 
                   @membername = 'mdw_admin' 
GO

EXECUTE sp_addrolemember @rolename = 'mdw_reader' , 
                   @membername = 'mdw_admin' 
GO

RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Create loginless user ...', 0, 1)  WITH NOWAIT;
IF (NOT EXISTS(SELECT * FROM sys.database_principals WHERE NAME = 'mdw_check_operator_admin'))
BEGIN
    CREATE USER [mdw_check_operator_admin] WITHOUT LOGIN
END
GO

EXECUTE sp_addrolemember @rolename = 'mdw_admin', @membername = 'mdw_check_operator_admin' 
GO



/**********************************************************************/
/* Setup permissions                                                  */
/**********************************************************************/
RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Granting permissions to MDW security roles...', 0, 1)  WITH NOWAIT;

-- Database level permissions
GRANT VIEW DEFINITION                                           TO [mdw_writer]


-- Core schema permissions

-- custom_snaphots use the core.snapshots_internal.snapshot_id column as a FK, 
-- REFERENCES permission need to be granted to mdw_admin 
GRANT REFERENCES ON SCHEMA::[core]                              TO [mdw_admin] 

GRANT EXECUTE ON [core].[sp_create_snapshot]                    TO [mdw_writer]
GRANT EXECUTE ON [core].[sp_update_data_source]                 TO [mdw_writer]
GRANT EXECUTE ON [core].[sp_add_collector_type]                 TO [mdw_admin]
GRANT EXECUTE ON [core].[sp_remove_collector_type]              TO [mdw_admin]
GRANT EXECUTE ON [core].[sp_purge_data]                         TO [mdw_admin]
GRANT EXECUTE ON [core].[sp_stop_purge]                         TO [mdw_admin]

GRANT REFERENCES ON [core].[fn_check_operator]                  TO [mdw_check_operator_admin]

GRANT SELECT  ON [core].[snapshots]                             TO [mdw_admin]    
GRANT SELECT  ON [core].[snapshots]                             TO [mdw_writer]    
GRANT SELECT  ON [core].[snapshots]                             TO [mdw_reader]    

GRANT SELECT  ON [core].[supported_collector_types]             TO [mdw_admin]
GRANT SELECT  ON [core].[supported_collector_types]             TO [mdw_writer]
GRANT SELECT  ON [core].[supported_collector_types]             TO [mdw_reader]

GRANT SELECT  ON [core].[wait_categories]                       TO [mdw_reader]
GRANT SELECT  ON [core].[wait_types]                            TO [mdw_reader]
GRANT SELECT  ON [core].[wait_types_categorized]                TO [mdw_reader]

GRANT SELECT  ON [core].[snapshots_internal]                    TO [mdw_admin]
GRANT SELECT  ON [core].[source_info_internal]                  TO [mdw_admin]
GRANT SELECT  ON [core].[snapshot_timetable_internal]           TO [mdw_admin]
GRANT SELECT  ON [core].[supported_collector_types_internal]    TO [mdw_admin]
GRANT SELECT  ON [core].[fn_query_text_from_handle]             TO [mdw_reader]

GRANT SELECT  ON [core].[performance_counter_report_group_items] TO [mdw_reader]

-- Snapshot schema permissions
GRANT INSERT  ON SCHEMA :: [snapshots]                          TO [mdw_writer]
GRANT EXECUTE ON SCHEMA :: [snapshots]                          TO [mdw_writer]
GRANT DELETE  ON SCHEMA :: [snapshots]                          TO [mdw_admin]
GRANT SELECT  ON SCHEMA :: [snapshots]                          TO [mdw_reader]
-- mdw_writer needs SELECT permission to perform upload because bcp selects the table to verify its schema
GRANT SELECT  ON SCHEMA :: [snapshots]                          TO [mdw_writer]

GRANT EXECUTE ON [snapshots].[sp_get_unknown_query_plan]        TO [mdw_writer]
GRANT EXECUTE ON [snapshots].[sp_get_unknown_query_text]        TO [mdw_writer]
GRANT EXECUTE ON [snapshots].[sp_update_query_plan]             TO [mdw_writer]
GRANT EXECUTE ON [snapshots].[sp_update_query_text]             TO [mdw_writer]

-- Custom_snapshot schema permissions
GRANT CREATE TABLE                                              TO [mdw_writer]
GRANT ALTER   ON SCHEMA :: [custom_snapshots]                   TO [mdw_writer]
GRANT INSERT  ON SCHEMA :: [custom_snapshots]                   TO [mdw_writer]
GRANT DELETE  ON SCHEMA :: [custom_snapshots]                   TO [mdw_admin]
GRANT SELECT  ON SCHEMA :: [custom_snapshots]                   TO [mdw_reader]
-- mdw_writer needs SELECT permission to perform upload because bcp selects the table to verify its schema
GRANT SELECT  ON SCHEMA :: [custom_snapshots]                   TO [mdw_writer]

GRANT CREATE TABLE                                              TO [mdw_admin]
GRANT CONTROL ON SCHEMA :: [custom_snapshots]                   TO [mdw_admin]

-- Report procedures
GRANT EXECUTE ON [snapshots].[rpt_snapshot_times]                       TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_interval_collection_times]            TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_next_and_previous_collection_times]   TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_generic_perfmon]                      TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_generic_perfmon_pivot]                TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_wait_stats]                           TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[fn_hexstrtovarbin]                        TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_top_query_stats]                      TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_query_stats]                          TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_query_plan_stats]                     TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_query_plan_stats_timeline]            TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_query_plan_missing_indexes]           TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_query_plan_parameters]                TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_query_plan_details]                   TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_blocking_chains]                      TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_blocking_chain_detail]                TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_active_sessions_and_requests]         TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_sql_memory_clerks]                    TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_sql_process_and_system_memory]        TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_sampled_waits]                        TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_sampled_waits_longest]                TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_sampled_waits_hottest_resources]      TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_io_virtual_file_stats]                TO [mdw_reader]
GRANT EXECUTE ON [snapshots].[rpt_list_all_servers]                     TO [mdw_reader]

-- NOTE: In order to insert data into MDW the login used for uploading data
-- needs to have ADMINISTER BULK OPERATIONS server permission granted

GO

/**********************************************************************/
/* LEGACY OBJECTS - KEPT FOR OLDER CTPs BUT NO LONGER USED            */
/**********************************************************************/

/**********************************************************************/
/* Used by CTP5 (but not CTP6):                                       */
/**********************************************************************/

--
-- snapshots.rpt_waiting_sessions
--  Returns list of sessions waiting for specified wait type category
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - end of the time window (UTC)
--    @WindowSize - number of minutes in the time window
--    @CategoryName - Name of wait category (optional)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_waiting_sessions', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_waiting_sessions] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_waiting_sessions]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_waiting_sessions] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_waiting_sessions]
    @ServerName sysname, 
    @EndTime datetime, 
    @WindowSize int, 
    @CategoryName nvarchar(20)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @start_time_internal datetimeoffset(7);
    DECLARE @end_time_internal datetimeoffset(7);
    
    -- Start time should be passed in as a UTC datetime
    IF (@EndTime IS NOT NULL)
    BEGIN
        -- Assumed time zone offset for this conversion is +00:00 (datetime must be passed in as UTC)
        SET @end_time_internal = CAST (@EndTime AS datetimeoffset(7));
    END
    ELSE BEGIN
        SELECT @end_time_internal = MAX(ar.collection_time)
        FROM core.snapshots AS s
        INNER JOIN snapshots.active_sessions_and_requests AS ar ON s.snapshot_id = ar.snapshot_id
        WHERE s.instance_name = @ServerName -- AND collection_set_uid = '49268954-4FD4-4EB6-AA04-CD59D9BB5714' -- Server Activity CS
    END
    SET @start_time_internal = DATEADD (minute, -1 * @WindowSize, @end_time_internal);
    
    DECLARE @total_waits TABLE
    (
        wait_type nvarchar(45),
        wait_count bigint, 
        wait_duration_ms bigint
    )

    INSERT INTO @total_waits
    SELECT 
        ar.wait_type,
        COUNT(*) AS wait_count, 
        SUM (wait_duration_ms)
    FROM snapshots.active_sessions_and_requests ar
    JOIN core.snapshots s ON (s.snapshot_id = ar.snapshot_id)
    WHERE s.instance_name = @ServerName -- AND collection_set_uid = '49268954-4FD4-4EB6-AA04-CD59D9BB5714' -- Server Activity CS
        AND ar.collection_time BETWEEN @start_time_internal AND @end_time_internal
        AND ar.wait_type != ''
    GROUP BY ar.wait_type
    
    SELECT
        t.source_id,
        t.session_id,
        t.request_id,
        t.database_name,
        CONVERT (datetime, SWITCHOFFSET (CAST (t.login_time AS datetimeoffset(7)), '+00:00')) AS login_time, 
        t.login_name,
        t.[program_name],
        t.sql_handle,
        master.dbo.fn_varbintohexstr (t.sql_handle) AS sql_handle_str,
        t.statement_start_offset,
        t.statement_end_offset,
        t.plan_handle,
        master.dbo.fn_varbintohexstr (t.plan_handle) AS plan_handle_str,
        t.wait_type,
        t.wait_count,
        t.wait_total_percent,
        t.wait_type_wait_percent,
        qt.query_text, 
        REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (REPLACE (
            LEFT (LTRIM (qt.query_text), 100)
            , CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '), '   ', ' '), '  ', ' '), '  ', ' ') AS flat_query_text
    FROM
    (
        SELECT 
            s.source_id,
            ar.session_id,
            ar.request_id,
            ar.database_name,
            ar.login_time,
            ar.login_name,
            ar.program_name,
            ar.sql_handle,
            ar.statement_start_offset,
            ar.statement_end_offset,
            ar.plan_handle,
            ar.wait_type,
            COUNT(*) AS wait_count,
            (COUNT(*)) / CONVERT(decimal, (SELECT SUM(wait_count) FROM @total_waits)) AS wait_total_percent,
            (COUNT(*)) / CONVERT(decimal, (SELECT wait_count FROM @total_waits WHERE wait_type = ar.wait_type)) AS wait_type_wait_percent
        FROM snapshots.active_sessions_and_requests AS ar
        INNER JOIN core.snapshots AS s ON (s.snapshot_id = ar.snapshot_id)
        INNER JOIN core.wait_types_categorized AS wt on (wt.wait_type = ar.wait_type)
        WHERE s.instance_name = @ServerName -- AND s.collection_set_uid = '49268954-4FD4-4EB6-AA04-CD59D9BB5714' -- Server Activity CS
            AND ar.collection_time BETWEEN @start_time_internal AND @end_time_internal
            AND wt.category_name = @CategoryName
        GROUP BY s.source_id, ar.session_id, ar.request_id, ar.database_name, ar.login_time, ar.login_name, ar.program_name, 
            ar.wait_type, ar.sql_handle, ar.statement_start_offset, ar.statement_end_offset, ar.plan_handle
    ) AS t 
    OUTER APPLY snapshots.fn_get_query_text(t.source_id, t.sql_handle, t.statement_start_offset, t.statement_end_offset) AS qt

END;
GO
GRANT EXECUTE ON [snapshots].[rpt_waiting_sessions]                     TO [mdw_reader]
GO


-- This function returns a list of all the known query plans from a disctinct source 
IF (NOT OBJECT_ID(N'snapshots.fn_get_notable_query_plans', 'TF') IS NULL)
BEGIN
    RAISERROR('Dropping function [snapshots].[fn_get_notable_query_plans] ...', 0, 1)  WITH NOWAIT;
    DROP FUNCTION [snapshots].[fn_get_notable_query_plans]
END

RAISERROR('Creating function [snapshots].[fn_get_notable_query_plans]', 0, 1)  WITH NOWAIT;
Go
CREATE FUNCTION [snapshots].[fn_get_notable_query_plans](
    @source_id  int
)
RETURNS @notable_queries TABLE (sql_handle varbinary(64) , 
                                plan_handle varbinary(64), 
                                statement_start_offset int, 
                                statement_end_offset int,
                                creation_time datetime)
BEGIN
    INSERT INTO @notable_queries
    SELECT  [sql_handle], 
        [plan_handle],
        [statement_start_offset],
        [statement_end_offset],
            -- Convert datetimeoffset to datetime so that SSIS can easily join the output back 
            -- to the new sys.dm_exec_query_stats data
            CONVERT (datetime, [creation_time]) AS [creation_time]
    FROM    [snapshots].[notable_query_plan]
    WHERE   [source_id] = @source_id
    ORDER BY [sql_handle] ASC, [plan_handle], [statement_start_offset], [statement_end_offset], [creation_time] ASC

    RETURN
END
GO

GRANT SELECT  ON [snapshots].[fn_get_notable_query_plans]       TO [mdw_writer]
GO



-- This function returns a list of all the known sql_handles (i.e., query text) from a disctinct source 
IF (NOT OBJECT_ID(N'snapshots.fn_get_notable_query_text', 'TF') IS NULL)
BEGIN
    RAISERROR('Dropping function [snapshots].[fn_get_notable_query_text] ...', 0, 1)  WITH NOWAIT;
    DROP FUNCTION [snapshots].[fn_get_notable_query_text]
END

RAISERROR('Creating function [snapshots].[fn_get_notable_query_text]', 0, 1)  WITH NOWAIT;
Go
CREATE FUNCTION [snapshots].[fn_get_notable_query_text](
    @source_id int
)
RETURNS @notable_text TABLE (sql_handle varbinary(64))
BEGIN
    INSERT INTO @notable_text
    SELECT  [sql_handle]
    FROM    [snapshots].[notable_query_text]
    WHERE   [source_id] = @source_id
    ORDER BY [sql_handle] ASC

    RETURN
END
GO

GRANT SELECT  ON [snapshots].[fn_get_notable_query_text]        TO [mdw_writer]
GO


--
-- snapshots.rpt_sql_memory_counters_one_snapshot
--  Returns values for page life expectancy and other SQL Server memory counters
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sql_memory_counters_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sql_memory_counters_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sql_memory_counters_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sql_memory_counters_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sql_memory_counters_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        pc.performance_counter_name AS series,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value 
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND pc.performance_object_name LIKE '%SQL%:Buffer Manager'
        AND pc.performance_counter_name = 'Page life expectancy'
    ORDER BY 
        pc.collection_time, pc.performance_counter_name
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_sql_memory_counters_one_snapshot]     TO [mdw_reader]
GO


--
-- snapshots.rpt_sql_memory_clerks_one_snapshot
--  Returns data from os_memory_clerks table
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sql_memory_clerks_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sql_memory_clerks_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sql_memory_clerks_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sql_memory_clerks_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sql_memory_clerks_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @total_allocated TABLE (
        collection_time datetimeoffset(7),
        total_kb bigint
    );

    INSERT INTO @total_allocated 
    SELECT 
        mc.collection_time,
        SUM(mc.single_pages_kb + 
            mc.multi_pages_kb + 
            (CASE WHEN type <> N'MEMORYCLERK_SQLBUFFERPOOL' THEN mc.virtual_memory_committed_kb 
            ELSE 0 END) + 
            mc.shared_memory_committed_kb)
    FROM snapshots.os_memory_clerks mc
    JOIN core.snapshots s ON (s.snapshot_id = mc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
    GROUP BY mc.collection_time

    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (mc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        mc.type,
        mc.single_pages_kb + mc.multi_pages_kb as allocated_kb,
        mc.virtual_memory_reserved_kb as virtual_reserved_kb,
        mc.virtual_memory_committed_kb as virtual_committed_kb,
        mc.awe_allocated_kb as awe_allocated_kb,
        mc.shared_memory_reserved_kb as shared_reserved_kb,
        mc.shared_memory_committed_kb as shared_committed_kb,
        (mc.single_pages_kb + mc.multi_pages_kb + (CASE WHEN type <> 'MEMORYCLERK_SQLBUFFERPOOL' THEN mc.virtual_memory_committed_kb ELSE 0 END) + mc.shared_memory_committed_kb) as total_kb,
        (mc.single_pages_kb + mc.multi_pages_kb + (CASE WHEN type <> 'MEMORYCLERK_SQLBUFFERPOOL' THEN mc.virtual_memory_committed_kb ELSE 0 END) + mc.shared_memory_committed_kb) / CONVERT(decimal, ta.total_kb) AS percent_total_kb,
        CASE
            WHEN (mc.single_pages_kb + mc.multi_pages_kb + (CASE WHEN type <> 'MEMORYCLERK_SQLBUFFERPOOL' THEN mc.virtual_memory_committed_kb ELSE 0 END) + mc.shared_memory_committed_kb) / CONVERT(decimal, ta.total_kb) > 0.05 THEN mc.type
            ELSE N'Other'
        END AS graph_type
    FROM snapshots.os_memory_clerks mc
    JOIN @total_allocated ta ON (mc.collection_time = ta.collection_time)
    ORDER BY collection_time
    
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_sql_memory_clerks_one_snapshot]       TO [mdw_reader]
GO


--
-- snapshots.rpt_sql_process_memory_one_snapshot
--  Returns details on sql process memory usage
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sql_process_memory_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sql_process_memory_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sql_process_memory_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sql_process_memory_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sql_process_memory_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;

    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        CASE 
            WHEN series = 'virtual_address_space_reserved_kb' THEN 'Virtual Memory Reserved'
            WHEN series = 'virtual_address_space_committed_kb' THEN 'Virtual Memory Committed'
            WHEN series = 'physical_memory_in_use_kb' THEN 'Physical Memory In Use'
            WHEN series = 'process_physical_memory_low' THEN 'Physical Memory Low'
            WHEN series = 'process_virtual_memory_low' THEN 'Virtual Memory Low'
            ELSE series
        END AS series,
        [value] / 1024 AS [value] -- convert KB to MB
    FROM 
    (
        SELECT 
            pm.collection_time,
            pm.virtual_address_space_reserved_kb,
            pm.virtual_address_space_committed_kb,
            pm.physical_memory_in_use_kb,
            CONVERT (bigint, pm.process_physical_memory_low) AS process_physical_memory_low,
            CONVERT (bigint, pm.process_virtual_memory_low) AS process_virtual_memory_low
        FROM [snapshots].[os_process_memory] pm
        JOIN core.snapshots s ON (s.snapshot_id = pm.snapshot_id)
        WHERE s.instance_name = @instance_name
            AND s.snapshot_time_id = @snapshot_time_id
    ) AS pvt
    UNPIVOT
    (
        [value] for [series] in 
            (virtual_address_space_reserved_kb, virtual_address_space_committed_kb, 
            physical_memory_in_use_kb)
    ) AS unpvt
    UNION ALL 
    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        'Stolen Buffer Pool' AS [series], 
        pc.formatted_value * 8 AS [value] -- Convert from pages to KB
    FROM snapshots.performance_counters AS pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND pc.performance_object_name LIKE '%SQL%:Buffer Manager'
        AND pc.performance_counter_name = 'Stolen pages'
    ORDER BY collection_time
END
GO

GRANT EXECUTE ON [snapshots].[rpt_sql_process_memory_one_snapshot]      TO [mdw_reader]
GO

--
-- snapshots.rpt_memory_counters_one_snapshot
--  Returns values for memory usage counters
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_memory_counters_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_memory_counters_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_memory_counters_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_memory_counters_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_memory_counters_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        pc.performance_counter_name AS series,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.collection_time,
        pc.formatted_value / (1024*1024) AS formatted_value
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND 
        (
            (pc.performance_object_name = 'Memory' AND pc.performance_counter_name IN ('Cache Bytes', 'Pool Nonpaged Bytes'))
            OR (pc.performance_object_name = 'Process' AND pc.performance_counter_name = 'Working Set' AND pc.performance_instance_name = '_Total')
        )
    ORDER BY 
        pc.collection_time, series
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_memory_counters_one_snapshot]         TO [mdw_reader]
GO


--
-- snapshots.rpt_memory_rates_one_snapshot
--  Returns values for various memory ratios 
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_memory_rates_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_memory_rates_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_memory_rates_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_memory_rates_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_memory_rates_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        pc.performance_counter_name AS series,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.collection_time,
        pc.formatted_value
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND pc.performance_object_name = 'Memory' 
        AND pc.performance_counter_name IN ('Page Faults/sec', 'Page Reads/sec', 'Page Writes/sec', 'Cache Faults/sec')
    ORDER BY 
        pc.collection_time, series
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_memory_rates_one_snapshot]            TO [mdw_reader]
GO

--
-- snapshots.rpt_cpu_counters_one_snapshot
--  Returns values for CPU usage counters per processor
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_cpu_counters_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_cpu_counters_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_cpu_counters_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_cpu_counters_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_cpu_counters_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        N'CPU ' + CONVERT (nvarchar(10), ISNULL(pc.performance_instance_name, N'')) as series,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value
    FROM snapshots.performance_counters pc
    JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND pc.performance_object_name = 'Processor' AND pc.performance_counter_name = '% Processor Time' 
        AND pc.performance_instance_name != '_Total'
    ORDER BY 
        pc.collection_time, series
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_cpu_counters_one_snapshot]            TO [mdw_reader]
GO

--
-- snapshots.rpt_cpu_queues_one_snapshot
--  Returns values for queue length counter per processor 
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_cpu_queues_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_cpu_queues_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_cpu_queues_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_cpu_queues_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_cpu_queues_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        CASE pc.performance_counter_name 
            WHEN 'Processor Queue Length' THEN N'Processor Queue Length'
            ELSE N'CPU ' + CONVERT (nvarchar(10), ISNULL(pc.performance_instance_name, N'')) 
        END AS series,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value
    FROM snapshots.performance_counters pc
    JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND 
        (
            (pc.performance_object_name = 'Server Work Queues' AND pc.performance_counter_name = 'Queue Length'
                AND pc.performance_instance_name != '_Total' AND ISNUMERIC (pc.performance_instance_name) = 1)
            OR (pc.performance_object_name = 'System' AND pc.performance_counter_name = 'Processor Queue Length')
        )
    ORDER BY 
        pc.collection_time, series
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_cpu_queues_one_snapshot]              TO [mdw_reader]
GO

--
-- snapshots.rpt_cpu_usage_per_process
--  Returns min, max, avg CPU usage and avg thread count for top 10 processes
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_cpu_usage_per_process', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_cpu_usage_per_process] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_cpu_usage_per_process]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_cpu_usage_per_process] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_cpu_usage_per_process]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Determine the CPU count on the target system by querying the number of "Processor" 
    -- counter instances we captured in a perfmon sample that was captured around the same 
    -- time. 
    DECLARE @cpu_count smallint
    SELECT @cpu_count = COUNT (DISTINCT pc.performance_instance_name)
    FROM snapshots.performance_counters AS pc
    INNER JOIN core.snapshots s ON s.snapshot_id = pc.snapshot_id 
    WHERE pc.performance_object_name = 'Processor' AND pc.performance_counter_name = '% Processor Time'
        AND pc.performance_instance_name != '_Total'
        AND s.snapshot_time_id = @snapshot_time_id
        AND s.instance_name = @instance_name
        AND pc.collection_time = 
            (SELECT TOP 1 collection_time FROM snapshots.performance_counter_values pcv2 WHERE pcv2.snapshot_id = s.snapshot_id)

    SELECT TOP 10
        cpu.process_name,
        cpu.minimum_value / @cpu_count AS cpu_minimum_value,
        cpu.maximum_value / @cpu_count AS cpu_maximum_value,
        cpu.average_value / @cpu_count AS cpu_average_value,
        tc.average_value AS  tc_average_value
    FROM
    (  SELECT
            ISNULL(pc.performance_instance_name, N'') AS process_name,
            MIN(pc.formatted_value)         AS minimum_value,
            MAX(pc.formatted_value)         AS maximum_value,
            AVG(pc.formatted_value)         AS average_value
        FROM [snapshots].[performance_counters] AS pc
        INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
        WHERE
            s.snapshot_time_id = @snapshot_time_id
            AND s.instance_name = @instance_name
            AND (pc.performance_object_name = 'Process' AND pc.performance_counter_name = '% Processor Time'
                AND pc.performance_instance_name NOT IN ('_Total', 'Idle'))
        GROUP BY pc.performance_instance_name
    ) AS cpu
    INNER JOIN
    (  SELECT
            ISNULL(pc.performance_instance_name, N'') AS process_name,
            MIN(pc.formatted_value)         AS minimum_value,
            MAX(pc.formatted_value)         AS maximum_value,
            AVG(pc.formatted_value)         AS average_value
        FROM [snapshots].[performance_counters] as pc
        INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
        WHERE
            s.snapshot_time_id = @snapshot_time_id
            AND s.instance_name = @instance_name
            AND (pc.performance_object_name = 'Process' AND pc.performance_counter_name = 'Thread Count'
                AND pc.performance_instance_name NOT IN ('_Total', 'Idle'))
        GROUP BY pc.performance_instance_name
    ) AS tc ON (tc.process_name = cpu.process_name)
    ORDER BY cpu_average_value DESC

END;
GO

GRANT EXECUTE ON [snapshots].[rpt_cpu_usage_per_process]                TO [mdw_reader]
GO

--
-- snapshots.rpt_sessions_and_connections
--  Returns counts for sessions and connections within the given snapshot
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sessions_and_connections', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sessions_and_connections] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sessions_and_connections]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sessions_and_connections] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sessions_and_connections]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;


    SELECT 
        pc.performance_counter_name AS series,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND (pc.performance_object_name LIKE '%SQL%:General Statistics' OR pc.performance_object_name LIKE '%SQL%:Databases')
        AND pc.performance_counter_name IN ('User Connections', 'Active Transactions')

    UNION ALL 

    SELECT 
        N'Active sessions' AS series,
        ar.collection_time,
        COUNT(DISTINCT ar.session_id) AS formatted_value
    FROM snapshots.active_sessions_and_requests ar
    INNER JOIN core.snapshots s ON (s.snapshot_id = ar.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
    GROUP BY ar.collection_time    

    ORDER BY collection_time
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_sessions_and_connections]             TO [mdw_reader]
GO


--
-- snapshots.rpt_requests_and_compilations
--  Returns counts for number of requests/sec and related compilations counters
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_requests_and_compilations', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_requests_and_compilations] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_requests_and_compilations]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_requests_and_compilations] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_requests_and_compilations]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;

    SELECT 
        pc.performance_counter_name AS series,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND pc.performance_object_name LIKE '%SQL%:SQL Statistics'
        AND pc.performance_counter_name IN ('Batch Requests/sec', 'SQL Compilations/sec', 
            'SQL Re-Compilations/sec', 'Auto-Param Attempts/sec', 'Failed Auto-Params/sec')
    ORDER BY pc.collection_time, pc.performance_counter_name
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_requests_and_compilations]            TO [mdw_reader]
GO

--
-- snapshots.rpt_plan_cache_hit_ratio
--  Returns details on plan cache hit ratio counter
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_plan_cache_hit_ratio', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_plan_cache_hit_ratio] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_plan_cache_hit_ratio]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_plan_cache_hit_ratio] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_plan_cache_hit_ratio]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;

    SELECT 
        ISNULL(pc.performance_instance_name, N'') AS series,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND pc.performance_object_name LIKE '%SQL%:Plan Cache'
        AND pc.performance_counter_name = 'Cache Hit Ratio'
        AND pc.performance_instance_name != '_Total'
    ORDER BY pc.collection_time, ISNULL(pc.performance_instance_name, N'')
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_plan_cache_hit_ratio]                 TO [mdw_reader]
GO


--
-- snapshots.rpt_tempdb
--  Returns counters related to tempdb
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_tempdb', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_tempdb] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_tempdb]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_tempdb] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_tempdb]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;

    SELECT 
        pc.performance_counter_name AS series,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND (pc.performance_object_name LIKE '%SQL%:Transactions' OR pc.performance_object_name LIKE '%SQL%:General Statistics')
        AND pc.performance_counter_name IN ('Free Space in tempdb (KB)', 'Active Temp Tables')
    ORDER BY pc.collection_time, pc.performance_counter_name
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_tempdb]                               TO [mdw_reader]
GO

--
-- snapshots.rpt_disk_speed_one_snapshot
--  Returns values for disk usage counters
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_disk_speed_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_disk_speed_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_disk_speed_one_snapshot]
END
GO

RAISERROR('Creating procedure [snapshots].[rpt_disk_speed_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_disk_speed_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        ISNULL(pc.performance_instance_name, N'') AS disk_letter,
        pc.performance_counter_name AS counter,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value AS formatted_value
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND pc.performance_object_name = 'LogicalDisk' 
        AND pc.performance_counter_name IN ('Avg. Disk sec/Read', 'Avg. Disk sec/Write')
        AND pc.performance_instance_name != '_Total'
    ORDER BY 
        pc.collection_time, pc.performance_counter_name, ISNULL(pc.performance_instance_name, N'')
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_disk_speed_one_snapshot]              TO [mdw_reader]
GO


--
-- snapshots.rpt_disk_queues_one_snapshot
--  Returns values for disk queue counters
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_disk_queues_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_disk_queues_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_disk_queues_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_disk_queues_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_disk_queues_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        ISNULL(pc.performance_instance_name, N'') AS disk_letter,
        pc.performance_counter_name AS counter,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND pc.performance_object_name = 'LogicalDisk' 
        AND pc.performance_counter_name IN ('Current Disk Queue Length', 'Avg. Disk Read Queue Length', 'Avg. Disk Write Queue Length')
        AND pc.performance_instance_name != '_Total'
    ORDER BY 
        pc.collection_time, pc.performance_counter_name, ISNULL(pc.performance_instance_name, N'')
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_disk_queues_one_snapshot]             TO [mdw_reader]
GO


--
-- snapshots.rpt_disk_ratios_one_snapshot
--  Returns values for disk ratio counters
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_disk_ratios_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_disk_ratios_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_disk_ratios_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_disk_ratios_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_disk_ratios_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        ISNULL(pc.performance_instance_name, N'') AS disk_letter,
        pc.performance_counter_name AS counter,
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value
    FROM snapshots.performance_counters pc
    INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id = @snapshot_time_id
        AND pc.performance_object_name = 'LogicalDisk' 
        AND pc.performance_counter_name IN ('Disk Reads/sec', 'Disk Writes/sec')
        AND pc.performance_instance_name != '_Total'
    ORDER BY 
        pc.collection_time, pc.performance_counter_name, ISNULL(pc.performance_instance_name, N'')
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_disk_ratios_one_snapshot]             TO [mdw_reader]
GO


--
-- snapshots.rpt_disk_usage_per_process
--  Returns min, max, avg CPU usage and avg thread count for top 10 processes
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_disk_usage_per_process', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_disk_usage_per_process] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_disk_usage_per_process]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_disk_usage_per_process] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_disk_usage_per_process]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT TOP 10
        wb.process_name,
        wb.minimum_value AS wb_minimum_value,
        wb.maximum_value AS wb_maximum_value,
        wb.average_value AS wb_average_value,
        rb.minimum_value AS rb_minimum_value,
        rb.maximum_value AS rb_maximum_value,
        rb.average_value AS rb_average_value
    FROM
    (  SELECT
            ISNULL(pc.performance_instance_name, N'') AS process_name,
            MIN(pc.formatted_value / (1024))        as minimum_value,
            MAX(pc.formatted_value / (1024))        as maximum_value,
            AVG(pc.formatted_value / (1024))        as average_value
        FROM [snapshots].[performance_counters] as pc
        INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
        WHERE
            s.snapshot_time_id = @snapshot_time_id
            AND s.instance_name = @instance_name
            AND pc.performance_object_name = 'Process' 
            AND pc.performance_counter_name = 'IO Read Bytes/sec'
            AND pc.performance_instance_name NOT IN ('_Total', 'Idle')
        GROUP BY pc.performance_instance_name
    ) AS rb
    INNER JOIN
    (  SELECT
            ISNULL(pc.performance_instance_name, N'') AS process_name,
            MIN(pc.formatted_value / (1024))        as minimum_value,
            MAX(pc.formatted_value / (1024))        as maximum_value,
            AVG(pc.formatted_value / (1024))        as average_value
        FROM [snapshots].[performance_counters] as pc
        INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
        WHERE
            s.snapshot_time_id = @snapshot_time_id
            AND s.instance_name = @instance_name
            AND pc.performance_object_name = 'Process' 
            AND pc.performance_counter_name = 'IO Write Bytes/sec'
            AND pc.performance_instance_name NOT IN ('_Total', 'Idle')
        GROUP BY pc.performance_instance_name
    ) AS wb ON (wb.process_name = rb.process_name)
    ORDER BY wb_average_value DESC, rb_average_value DESC
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_disk_usage_per_process]               TO [mdw_reader]
GO


-- snapshots.rpt_waiting_sessions_per_snapshot
--  Returns list of sessions waiting for specified wait type category
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--    @wait_category_name - Name of wait category to filter on 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_waiting_sessions_per_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_waiting_sessions_per_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_waiting_sessions_per_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_waiting_sessions_per_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_waiting_sessions_per_snapshot]
    @instance_name sysname,
    @snapshot_time_id int,
    @wait_category_name nvarchar(20)
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @total_waits TABLE
    (
        wait_type nvarchar(45),
        wait_count bigint
    )

    INSERT INTO @total_waits
    SELECT 
        ar.wait_type,
        COUNT(ar.wait_type) 
    FROM snapshots.active_sessions_and_requests ar
    JOIN core.snapshots s ON (s.snapshot_id = ar.snapshot_id)
    WHERE s.snapshot_time_id = @snapshot_time_id
      AND s.instance_name = @instance_name
    GROUP BY ar.wait_type
    
    SELECT
        t.source_id,
        t.session_id,
        t.request_id,
        t.database_name,
        CONVERT (datetime, SWITCHOFFSET (CAST (t.login_time AS datetimeoffset(7)), '+00:00')) AS login_time, 
        t.login_name,
        t.[program_name],
        t.sql_handle,
        master.dbo.fn_varbintohexstr (t.sql_handle) AS sql_handle_str,
        t.statement_start_offset,
        t.statement_end_offset,
        t.plan_handle,
        master.dbo.fn_varbintohexstr (t.plan_handle) AS plan_handle_str,
        t.wait_type,
        t.wait_count,
        t.wait_total_precent,
        t.wait_type_wait_precent,
        qt.query_text
    FROM
    (
        SELECT 
            s.source_id,
            ar.session_id,
            ar.request_id,
            ar.database_name,
            ar.login_time,
            ar.login_name,
            ar.program_name,
            ar.sql_handle,
            ar.statement_start_offset,
            ar.statement_end_offset,
            ar.plan_handle,
            ar.wait_type,
            COUNT(ar.wait_type) AS wait_count,
            (COUNT(ar.wait_type)) / CONVERT(decimal, (SELECT SUM(wait_count) FROM @total_waits)) AS wait_total_precent,
            (COUNT(ar.wait_type)) / CONVERT(decimal, (SELECT wait_count FROM @total_waits WHERE wait_type = ar.wait_type)) AS wait_type_wait_precent
        FROM snapshots.active_sessions_and_requests ar
        JOIN core.snapshots s ON (s.snapshot_id = ar.snapshot_id)
        JOIN core.wait_types ev on (ev.wait_type = ar.wait_type)
        JOIN core.wait_categories ct on (ct.category_id = ev.category_id)
        WHERE s.snapshot_time_id = @snapshot_time_id
          AND s.instance_name = @instance_name
          AND ct.category_name = @wait_category_name
        GROUP BY s.source_id, ar.session_id, ar.request_id, ar.database_name, ar.login_time, ar.login_name, ar.program_name, ar.wait_type, ar.sql_handle, ar.statement_start_offset, ar.statement_end_offset, ar.plan_handle
    ) t 
    OUTER APPLY snapshots.fn_get_query_text(t.source_id, t.sql_handle, t.statement_start_offset, t.statement_end_offset) AS qt

END;
GO
GRANT EXECUTE ON [snapshots].[rpt_waiting_sessions_per_snapshot]        TO [mdw_reader]
GO


--
-- snapshots.rpt_memory_usage_per_process
--  Returns min, max, avg CPU usage and avg thread count for top 10 processes
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_memory_usage_per_process', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_memory_usage_per_process] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_memory_usage_per_process]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_memory_usage_per_process] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_memory_usage_per_process]
    @instance_name sysname,
    @snapshot_time_id int
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT TOP 10
        ws.process_name,
        ws.minimum_value AS ws_minimum_value,
        ws.maximum_value AS ws_maximum_value,
        ws.average_value AS ws_average_value,
        vb.minimum_value AS vb_minimum_value,
        vb.maximum_value AS vb_maximum_value,
        vb.average_value AS vb_average_value
    FROM
    (  SELECT
            ISNULL(pc.performance_instance_name, N'') as process_name,
            MIN(pc.formatted_value / (1024*1024))        as minimum_value,
            MAX(pc.formatted_value / (1024*1024))        as maximum_value,
            AVG(pc.formatted_value / (1024*1024))        as average_value
        FROM [snapshots].[performance_counters] as pc
        INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
        WHERE
            s.snapshot_time_id = @snapshot_time_id
            AND s.instance_name = @instance_name
            AND pc.performance_object_name = 'Process' AND pc.performance_counter_name = 'Working Set'
            AND pc.performance_instance_name NOT IN ('_Total', 'Idle')
        GROUP BY pc.performance_instance_name
    ) AS ws
    INNER JOIN
    (  SELECT
            ISNULL(pc.performance_instance_name, N'') as process_name,
            MIN(pc.formatted_value / (1024*1024))        as minimum_value,
            MAX(pc.formatted_value / (1024*1024))        as maximum_value,
            AVG(pc.formatted_value / (1024*1024))        as average_value
        FROM [snapshots].[performance_counters] as pc
        INNER JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
        WHERE
            s.snapshot_time_id = @snapshot_time_id
            AND s.instance_name = @instance_name
            AND pc.performance_object_name = 'Process' AND pc.performance_counter_name = 'Virtual Bytes'
            AND pc.performance_instance_name NOT IN ('_Total', 'Idle')
        GROUP BY pc.performance_instance_name
    ) AS vb ON (vb.process_name = ws.process_name)
    ORDER BY ws_average_value DESC

END;
GO

GRANT EXECUTE ON [snapshots].[rpt_memory_usage_per_process]             TO [mdw_reader]
GO


-- snapshots.rpt_wait_stats_by_category_by_snapshot
--  Returns deltas of wait stats with one snapshot interval and aggregated by category
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--    @category_name - (Optional) Name of wait category to filter on (all categories if NULL)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_wait_stats_by_category_by_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_wait_stats_by_category_by_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_wait_stats_by_category_by_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_wait_stats_by_category_by_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_wait_stats_by_category_by_snapshot]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint = NULL,
    @time_interval_min smallint = NULL, 
    @category_name nvarchar(20) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Convert snapshot_time (datetimeoffset) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset(7)) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;

    -- If the selected time window is > 1 hour, we'll chart wait times at 15 minute intervals.  If the selected 
    -- time window is < 1 hour, we'll use 5 minute intervals. 
    DECLARE @group_interval_min int
    IF DATEDIFF (minute, @start_time, @end_time) > 60
    BEGIN
        SET @group_interval_min = 15
    END 
    ELSE BEGIN
        SET @group_interval_min = 5
    END;
    -- Get wait times by waittype (plus CPU time, modeled as a waittype)
    WITH wait_times AS 
    ( 
        SELECT 
            s.snapshot_id, s.snapshot_time_id, s.snapshot_time, 
            DENSE_RANK() OVER (ORDER BY ws.collection_time) AS [rank], 
            ws.collection_time, wt.category_name, ws.wait_type, 
            ws.waiting_tasks_count, 
        ISNULL (ws.signal_wait_time_ms, 0) AS signal_wait_time_ms, 
        ISNULL (ws.wait_time_ms, 0) - ISNULL (ws.signal_wait_time_ms, 0) AS wait_time_ms, 
        ISNULL (ws.wait_time_ms, 0) AS wait_time_ms_cumulative 
    FROM snapshots.os_wait_stats AS ws
        INNER JOIN core.wait_types_categorized wt ON wt.wait_type = ws.wait_type
        INNER JOIN core.snapshots s ON ws.snapshot_id = s.snapshot_id
        WHERE s.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
            AND s.instance_name = @instance_name
            AND wt.category_name = ISNULL (@category_name, wt.category_name)
        AND wt.ignore != 1

            AND ws.collection_time IN 
            (
                SELECT MAX(collection_time) 
                FROM snapshots.os_wait_stats ws2 
                WHERE ws2.collection_time BETWEEN @start_time AND @end_time
                GROUP BY DATEDIFF (minute, '19000101', ws2.collection_time) / @group_interval_min
            )
    )

    -- Get resource wait stats for this snapshot_time_id interval
    -- We must convert all datetimeoffset values to UTC datetime values before returning to Reporting Services
    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        w2.snapshot_time_id, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w1.collection_time AS datetimeoffset(7)), '+00:00')) AS interval_start, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.collection_time AS datetimeoffset(7)), '+00:00')) AS interval_end, 
        w2.category_name, w2.wait_type, 
        -- All wait stats will be reset to zero by a service cycle, which will cause 
        -- (snapshot2waittime-snapshot1waittime) calculations to produce an incorrect 
        -- negative wait time for the interval.  Detect this and avoid calculating 
        -- negative wait time/wait count/signal time deltas. 
        CASE 
            WHEN (w2.waiting_tasks_count - w1.waiting_tasks_count) < 0 THEN w2.waiting_tasks_count 
            ELSE (w2.waiting_tasks_count - w1.waiting_tasks_count) 
        END AS waiting_tasks_count_delta, 
        CASE 
            WHEN (w2.wait_time_ms - w1.wait_time_ms) < 0 THEN w2.wait_time_ms
            ELSE (w2.wait_time_ms - w1.wait_time_ms)
        END / CAST (DATEDIFF (second, w1.collection_time, w2.collection_time) AS decimal) AS resource_wait_time_delta, 
        CASE 
            WHEN (w2.signal_wait_time_ms - w1.signal_wait_time_ms) < 0 THEN w2.signal_wait_time_ms 
            ELSE (w2.signal_wait_time_ms - w1.signal_wait_time_ms) 
        END / CAST (DATEDIFF (second, w1.collection_time, w2.collection_time) AS decimal) AS resource_signal_time_delta, 
        DATEDIFF (second, w1.collection_time, w2.collection_time) AS interval_sec, 
        w2.wait_time_ms_cumulative
    -- Self-join - w1 represents wait stats at the beginning of the sample interval, while w2 
    -- shows the wait stats at the end of the interval. 
    FROM wait_times AS w1 
    INNER JOIN wait_times AS w2 ON w1.wait_type = w2.wait_type AND w1.[rank] = w2.[rank]-1 

    UNION ALL 

    -- Treat sum of all signal waits as CPU "wait time"
    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        w2.snapshot_time_id, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w1.collection_time AS datetimeoffset(7)), '+00:00')) AS interval_start, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.collection_time AS datetimeoffset(7)), '+00:00')) AS interval_end, 
        'CPU' AS category_name, 
        'CPU (Signal Wait)' AS wait_type, 
        0 AS waiting_tasks_count_delta, 
        -- Handle wait stats resets
        CASE 
            WHEN (SUM (w2.signal_wait_time_ms) - SUM (w1.signal_wait_time_ms)) < 0 THEN SUM (w2.signal_wait_time_ms)
            ELSE (SUM (w2.signal_wait_time_ms) - SUM (w1.signal_wait_time_ms)) 
        END / CAST (DATEDIFF (second, w1.collection_time, w2.collection_time) AS decimal) AS resource_wait_time_delta, 
        0 AS resource_signal_time_delta, 
        DATEDIFF (second, w1.collection_time, w2.collection_time) AS interval_sec, 
        w2.wait_time_ms_cumulative
    FROM wait_times AS w1
    INNER JOIN wait_times AS w2 ON w1.wait_type = w2.wait_type AND w1.[rank] = w2.[rank]-1
    -- Only return CPU stats if we were told to return the 'CPU' category or all categories
    WHERE (@category_name IS NULL OR @category_name = 'CPU')
    GROUP BY w1.collection_time, w1.collection_time, w2.collection_time, w2.snapshot_time, w2.snapshot_time_id, w2.wait_time_ms_cumulative

    UNION ALL 

    -- Get actual used CPU time from perfmon data (average across the whole snapshot_time_id interval, 
    -- and use this average for each sample time in this interval).  Note that the "% Processor Time" 
    -- counter in the "Process" object can exceed 100% (for example, it can range from 0-800% on an 
    -- 8 CPU server). 
    SELECT
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        w2.snapshot_time_id, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w1.collection_time AS datetimeoffset(7)), '+00:00')) AS interval_start, 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.collection_time AS datetimeoffset(7)), '+00:00')) AS interval_end, 
        'CPU' AS category_name, 
        'CPU (Consumed)' AS wait_type, 
        0 AS waiting_tasks_count_delta, 
        -- Get sqlservr %CPU usage for the perfmon sample that immediately precedes 
        -- each wait stats sample.  Multiply by 10 to convert "% CPU" to "ms CPU/sec". 
        10 * (  
            SELECT TOP 1 formatted_value
            FROM snapshots.performance_counters AS pc
            INNER JOIN core.snapshots s ON pc.snapshot_id = s.snapshot_id
            WHERE pc.performance_object_name = 'Process' AND pc.performance_counter_name = '% Processor Time' 
                AND pc.performance_instance_name = 'sqlservr'
                AND s.snapshot_time_id <= @end_snapshot_time_id
                AND s.instance_name = @instance_name
                AND pc.snapshot_id < w2.snapshot_id
            ORDER BY pc.snapshot_id DESC
        ) AS resource_wait_time_delta, 
        0 AS resource_signal_time_delta, 
        DATEDIFF (second, w1.collection_time, w2.collection_time) AS interval_sec, 
        NULL
    FROM wait_times AS w1
    INNER JOIN wait_times AS w2 ON w1.wait_type = w2.wait_type AND w1.[rank] = w2.[rank]-1
    -- Only return CPU stats if we weren't passed in a specific wait category
    WHERE (@category_name IS NULL OR @category_name = 'CPU')
    GROUP BY w1.collection_time, w2.collection_time, w2.snapshot_time, w2.snapshot_time_id, w2.snapshot_id

    ORDER BY collection_time, category_name, wait_type
    -- These trace flags are necessary for a good plan, due to the join on ascending core.snapshot PK
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390);
END
GO

GRANT EXECUTE ON [snapshots].[rpt_wait_stats_by_category_by_snapshot]   TO [mdw_reader]
GO


--
-- snapshots.rpt_cpu_usage
--  Returns values for System CPU usage and SQL Server CPU usage collected through perf counters.
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_cpu_usage', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_cpu_usage] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_cpu_usage]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_cpu_usage] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_cpu_usage]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint = NULL,
    @time_interval_min smallint = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Convert snapshot_time (datetimeoffset(7)) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset(7)) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;

    -- Determine the CPU count on the target system by querying the number of "Processor" 
    -- counter instances we captured in a perfmon sample that was captured around the same 
    -- time. 
    DECLARE @cpu_count smallint
        SELECT @cpu_count = COUNT (DISTINCT pc.performance_instance_name)
        FROM snapshots.performance_counters AS pc
        INNER JOIN core.snapshots s ON s.snapshot_id = pc.snapshot_id 
        WHERE pc.performance_object_name = 'Processor' AND pc.performance_counter_name = '% Processor Time'
        AND pc.performance_instance_name != '_Total'
        AND s.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id 
        AND s.instance_name = @instance_name
            AND pc.collection_time = 
                (SELECT TOP 1 collection_time FROM snapshots.performance_counter_values pcv2 WHERE pcv2.snapshot_id = s.snapshot_id)
    SELECT 
        CASE pc.performance_object_name
            WHEN 'Processor' THEN 'System'
            ELSE 'SQL Server'
        END AS series,
        s.snapshot_time_id, 
        CONVERT (datetime, SWITCHOFFSET (CAST (s.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        -- Processor time on an eight proc system is 0-800% for the Process object, 
        -- but 0-100% for the Processor object
        CASE pc.performance_object_name
            WHEN 'Processor' THEN pc.formatted_value 
            ELSE pc.formatted_value / @cpu_count
        END AS formatted_value
    FROM snapshots.performance_counters pc
    JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        AND 
        (
            (pc.performance_object_name = 'Processor' AND pc.performance_counter_name = '% Processor Time' AND pc.performance_instance_name = '_Total')
            OR (pc.performance_object_name = 'Process' AND pc.performance_counter_name = '% Processor Time' AND pc.performance_instance_name = 'sqlservr')
        )
    ORDER BY pc.collection_time, series
        -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
        OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
        
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_cpu_usage]                            TO [mdw_reader]
GO


--
-- snapshots.rpt_mem_usage
--  Returns values for System memory usage and SQL Server memory usage collected through perf counters.
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_mem_usage', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_mem_usage] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_mem_usage]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_mem_usage] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_mem_usage]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint = NULL,
    @time_interval_min smallint = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Convert snapshot_time (datetimeoffset) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;

    SELECT 
        N'System' AS series,
        s.snapshot_time_id,
        CONVERT (datetime, SWITCHOFFSET (CAST (s.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        AVG(pc.formatted_value/(1024*1024)) AS formatted_value
    FROM snapshots.performance_counters pc
    JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        AND (pc.performance_object_name = 'Process' AND pc.performance_counter_name = 'Working Set' AND pc.performance_instance_name = '_Total')
             -- uncomment when defect 109313 is fixed
             --OR pc.path LIKE N'\Memory\Pool Nonpaged Bytes' 
             --OR pc.path LIKE N'\Memory\Cache Bytes')
    GROUP BY
        s.snapshot_time_id,
        s.snapshot_time
    UNION ALL 
    SELECT 
        N'SQL Server' AS series,
        s.snapshot_time_id,
        CONVERT (datetime, SWITCHOFFSET (CAST (s.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        AVG(pc.formatted_value/(1024*1024)) AS formatted_value
    FROM snapshots.performance_counters pc
    JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        AND (pc.performance_object_name = 'Process' AND pc.performance_counter_name = 'Working Set' AND pc.performance_instance_name = 'sqlservr')
    GROUP BY
        s.snapshot_time_id,
        s.snapshot_time
    ORDER BY 
        snapshot_time_id, series
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_mem_usage]                            TO [mdw_reader]
GO

--
-- snapshots.rpt_io_usage
--  Returns values for System Disk IO usage and SQL Server Disk IO usage collected through perf counters.
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_io_usage', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_io_usage] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_io_usage]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_io_usage] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_io_usage]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint = NULL,
    @time_interval_min smallint = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Convert snapshot_time (datetimeoffset) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;

    SELECT 
        N'System' AS series,
        s.snapshot_time_id,
        CONVERT (datetime, SWITCHOFFSET (CAST (s.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        AVG(pc.formatted_value/(1024)) AS formatted_value
    FROM snapshots.performance_counters pc
    JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        AND (pc.performance_object_name = 'Process' AND pc.performance_counter_name = 'IO Read Bytes/sec' AND pc.performance_instance_name = '_Total')
             -- uncomment when defect 109313 is fixed
             --OR pc.path LIKE N'\Process(!_Total)\IO Write Bytes/sec' ESCAPE N'!')
    GROUP BY
        s.snapshot_time_id,
        s.snapshot_time
    UNION ALL 
    SELECT 
        N'SQL Server' AS series,
        s.snapshot_time_id,
        CONVERT (datetime, SWITCHOFFSET (CAST (s.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        AVG(pc.formatted_value/(1024)) AS formatted_value
    FROM snapshots.performance_counters pc
    JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        AND (pc.performance_object_name = 'Process' AND pc.performance_counter_name = 'IO Read Bytes/sec' AND pc.performance_instance_name = 'sqlservr')
             -- uncomment when defect 109313 is fixed
             --OR pc.path LIKE N'\Process(sqlservr)\IO Write Bytes/sec')
    GROUP BY
        s.snapshot_time_id,
        s.snapshot_time
    ORDER BY 
        snapshot_time_id, series
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_io_usage]                             TO [mdw_reader]
GO


--
-- snapshots.rpt_network_usage
--  Returns values for System network usage and SQL Server network usage collected through perf counters.
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_network_usage', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_network_usage] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_network_usage]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_network_usage] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_network_usage]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint = NULL,
    @time_interval_min smallint = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Convert snapshot_time (datetimeoffset) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;

    SELECT 
        N'System' AS series,
        s.snapshot_time_id,
        CONVERT (datetime, SWITCHOFFSET (CAST (s.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        AVG(pc.formatted_value/(1024)) AS formatted_value
    FROM snapshots.performance_counters pc
    JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        -- all instances 
        AND (pc.performance_object_name = 'Network Interface' AND pc.performance_counter_name = 'Bytes Total/sec')
    GROUP BY
        s.snapshot_time_id,
        s.snapshot_time
    ORDER BY 
        snapshot_time_id
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_network_usage]                        TO [mdw_reader]
GO


--
-- snapshots.rpt_wait_stats_one_snapshot
--  Returns summary of wait stats grouped per wait category for one snapshot
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--    @category_name - (Optional) Name of wait category to filter on (all categories if NULL)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_wait_stats_one_snapshot', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_wait_stats_one_snapshot] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_wait_stats_one_snapshot]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_wait_stats_one_snapshot] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_wait_stats_one_snapshot]
    @instance_name sysname,
    @snapshot_time_id int, 
    @category_name nvarchar(20) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Find the snapshot_id of the last wait stats data set in the following 
    -- snapshot_time_id interval
    DECLARE @current_snapshot_id int
    SELECT TOP 1 @current_snapshot_id = s.snapshot_id
    FROM core.snapshots AS s
    INNER JOIN snapshots.os_wait_stats ws ON s.snapshot_id = ws.snapshot_id
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id > @snapshot_time_id
    ORDER BY s.snapshot_time_id ASC, s.snapshot_id ASC, ws.collection_time ASC;

    -- Find the snapshot_id of the last wait stats data set in the preceding 
    -- snapshot_time_id interval
    DECLARE @previous_snapshot_id int
    SELECT TOP 1 @previous_snapshot_id = ISNULL (s.snapshot_id, 0)
    FROM core.snapshots AS s
    INNER JOIN snapshots.os_wait_stats ws ON s.snapshot_id = ws.snapshot_id
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id < @snapshot_time_id
    ORDER BY s.snapshot_time_id DESC, s.snapshot_id DESC, ws.collection_time DESC;

    -- Get wait times by waittype (plus CPU time, modeled as a waittype)
    WITH wait_times AS 
    ( 
        SELECT 
            s.snapshot_id, s.snapshot_time_id, 
            DENSE_RANK() OVER (ORDER BY collection_time) AS [rank], 
            ws.collection_time, wt.category_name, ws.wait_type, 
            ws.waiting_tasks_count, 
            ISNULL (ws.signal_wait_time_ms, 0) AS signal_wait_time_ms, 
            ISNULL (ws.wait_time_ms - ISNULL (ws.signal_wait_time_ms, 0), 0) AS wait_time_ms, 
            ws.wait_time_ms AS wait_time_ms_cumulative
        FROM snapshots.os_wait_stats AS ws
        INNER JOIN core.wait_types_categorized wt ON wt.wait_type = ws.wait_type
        INNER JOIN core.snapshots s ON ws.snapshot_id = s.snapshot_id
        WHERE s.snapshot_id BETWEEN @previous_snapshot_id AND @current_snapshot_id
            AND s.instance_name = @instance_name
            AND (wt.category_name = ISNULL (@category_name, wt.category_name))
            AND wt.ignore != 1
    )

    -- Get resource wait stats for this snapshot_time_id interval
    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        w2.category_name, w2.wait_type, 
        -- All wait stats will be reset to zero by a service cycle, which will cause 
        -- (snapshot2waittime-snapshot1waittime) calculations to produce an incorrect 
        -- negative wait time for the interval.  Detect this and avoid calculating 
        -- negative wait time/wait count/signal time deltas. 
        CASE 
            WHEN (w2.waiting_tasks_count - w1.waiting_tasks_count) < 0 THEN w2.waiting_tasks_count 
            ELSE (w2.waiting_tasks_count - w1.waiting_tasks_count) 
        END AS waiting_tasks_count_delta, 
        CASE 
            WHEN (w2.wait_time_ms - w1.wait_time_ms) < 0 THEN w2.wait_time_ms
            ELSE (w2.wait_time_ms - w1.wait_time_ms)
        END / CAST (DATEDIFF (second, w1.collection_time, w2.collection_time) AS decimal) AS resource_wait_time_delta, 
        CASE 
            WHEN (w2.signal_wait_time_ms - w1.signal_wait_time_ms) < 0 THEN w2.signal_wait_time_ms 
            ELSE (w2.signal_wait_time_ms - w1.signal_wait_time_ms) 
        END / CAST (DATEDIFF (second, w1.collection_time, w2.collection_time) AS decimal) AS resource_signal_time_delta, 
        DATEDIFF (second, w1.collection_time, w2.collection_time) AS interval_sec, 
        w2.wait_time_ms_cumulative
    -- Self-join - w1 represents wait stats at the beginning of the sample interval, while w2 
    -- shows the wait stats at the end of the interval. 
    FROM wait_times AS w1 
    INNER JOIN wait_times AS w2 ON w1.wait_type = w2.wait_type AND w1.[rank] = w2.[rank]-1 

    UNION ALL 

    -- Treat sum of all signal waits as CPU "wait time"
    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        'CPU' AS category_name, 
        'CPU (Signal Wait)' AS wait_type, 
        0 AS waiting_tasks_count_delta, 
        -- Handle wait stats resets
        CASE 
            WHEN (SUM (w2.signal_wait_time_ms) - SUM (w1.signal_wait_time_ms)) < 0 THEN SUM (w2.signal_wait_time_ms)
            ELSE (SUM (w2.signal_wait_time_ms) - SUM (w1.signal_wait_time_ms)) 
        END / CAST (DATEDIFF (second, w1.collection_time, w2.collection_time) AS decimal) AS resource_wait_time_delta, 
        0 AS resource_signal_time_delta, 
        DATEDIFF (second, w1.collection_time, w2.collection_time) AS interval_sec, 
        w2.wait_time_ms_cumulative
    FROM wait_times AS w1
    INNER JOIN wait_times AS w2 ON w1.wait_type = w2.wait_type AND w1.[rank] = w2.[rank]-1
    -- Only return CPU stats if we weren't passed in a specific wait category
    WHERE (@category_name IS NULL OR @category_name = 'CPU')
    GROUP BY w1.collection_time, w2.collection_time, w2.wait_time_ms_cumulative

    UNION ALL 

    -- Get actual used CPU time from perfmon data (average across the whole snapshot_time_id interval, 
    -- and use this average for each sample time in this interval).  Note that the "% Processor Time" 
    -- counter in the "Process" object can exceed 100% (for example, it can range from 0-800% on an 
    -- 8 CPU server). 
    SELECT
        CONVERT (datetime, SWITCHOFFSET (CAST (w2.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        'CPU' AS category_name, 
        'CPU (Consumed)' AS wait_type, 
        0 AS waiting_tasks_count_delta, 
        -- Get sqlservr %CPU usage for the perfmon sample that immediately precedes 
        -- each wait stats sample.  Multiply by 10 to convert "% CPU" to "ms CPU/sec". 
        10 * (  
            SELECT TOP 1 formatted_value
            FROM snapshots.performance_counters AS pc
            INNER JOIN core.snapshots s ON pc.snapshot_id = s.snapshot_id
            WHERE pc.performance_object_name = 'Process' AND pc.performance_counter_name = '% Processor Time' 
                AND pc.performance_instance_name = 'sqlservr'
                AND s.snapshot_id < @current_snapshot_id
                AND s.instance_name = @instance_name
                AND pc.snapshot_id < w2.snapshot_id
            ORDER BY pc.snapshot_id DESC
        ) AS resource_wait_time_delta, 
        0 AS resource_signal_time_delta, 
        DATEDIFF (second, w1.collection_time, w2.collection_time) AS interval_sec, 
        NULL
    FROM wait_times AS w1
    INNER JOIN wait_times AS w2 ON w1.wait_type = w2.wait_type AND w1.[rank] = w2.[rank]-1
    -- Only return CPU stats if we weren't passed in a specific wait category
    WHERE (@category_name IS NULL OR @category_name = 'CPU')
    GROUP BY w1.collection_time, w2.collection_time, w2.snapshot_id

    ORDER BY collection_time, category_name, wait_type
    -- These trace flags are necessary for a good plan, due to the join on ascending core.snapshot PK
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390);

END;
GO

GRANT EXECUTE ON [snapshots].[rpt_wait_stats_one_snapshot]              TO [mdw_reader]
GO

--
-- snapshots.rpt_server_activity
--  Returns values for various perf counters indicating server's activity
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @start_time - (Optional) time window start (UTC)
--    @end_time - time window end (UTC)
--    @time_window_size - Number of intervals in the time window (provide if @start_time is NULL)
--    @time_interval_min - Number of minutes in each interval (provide if @start_time is NULL)
--
IF (NOT OBJECT_ID(N'snapshots.rpt_server_activity', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_server_activity] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_server_activity]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_server_activity] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_server_activity]
    @instance_name sysname,
    @start_time datetime = NULL,
    @end_time datetime = NULL,
    @time_window_size smallint = NULL,
    @time_interval_min smallint = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Convert snapshot_time (datetimeoffset) to a UTC datetime
    IF (@end_time IS NULL)
        SET @end_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MAX(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));

    IF (@start_time IS NULL)
    BEGIN
        -- If time_window_size and time_interval_min are set use them
        -- to determine the start time
        -- Otherwise use the earliest available snapshot_time
        IF @time_window_size IS NOT NULL AND @time_interval_min IS NOT NULL
        BEGIN
            SET @start_time = DATEADD(minute, @time_window_size * @time_interval_min * -1.0, @end_time);
        END
        ELSE
        BEGIN
            -- Convert min snapshot_time (datetimeoffset) to a UTC datetime
            SET @start_time = CONVERT (datetime, SWITCHOFFSET (CAST ((SELECT MIN(snapshot_time) FROM core.snapshots) AS datetimeoffset(7)), '+00:00'));
        END
    END

    DECLARE @end_snapshot_time_id int;
    SELECT @end_snapshot_time_id = MAX(snapshot_time_id) FROM core.snapshots WHERE snapshot_time <= @end_time;

    DECLARE @start_snapshot_time_id int;
    SELECT @start_snapshot_time_id = MIN(snapshot_time_id) FROM core.snapshots WHERE snapshot_time >= @start_time;


    SELECT 
        SUBSTRING(pc.path, CHARINDEX(N'\', pc.path, 2)+1, LEN(pc.path) - CHARINDEX(N'\', pc.path, 2)) as series,
        s.snapshot_time_id,
        CONVERT (datetime, SWITCHOFFSET (CAST (s.snapshot_time AS datetimeoffset(7)), '+00:00')) AS snapshot_time, 
        CONVERT (datetime, SWITCHOFFSET (CAST (pc.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        pc.formatted_value
    FROM snapshots.performance_counters pc
    JOIN core.snapshots s ON (s.snapshot_id = pc.snapshot_id)
    WHERE s.instance_name = @instance_name
        AND s.snapshot_time_id BETWEEN @start_snapshot_time_id AND @end_snapshot_time_id
        AND (pc.performance_object_name LIKE '%SQL%:General Statistics' OR pc.performance_object_name LIKE '%SQL%:SQL Statistics')
        AND pc.performance_counter_name IN ('Logins/sec', 'Logouts/sec', 'Batch Requests/sec', 'Transactions', 
            'User Connections', 'SQL Compilations/sec', 'SQL Re-Compilations/sec')
    ORDER BY 
        pc.collection_time, series
    -- These trace flags are necessary for a good plan, due to the join on ascending PK w/range filter
    OPTION (QUERYTRACEON 2389, QUERYTRACEON 2390)
END;
GO

GRANT EXECUTE ON [snapshots].[rpt_server_activity]                      TO [mdw_reader]
GO

--
-- snapshots.rpt_wait_stats_one_snapshot_one_category
--  Returns details of wait stats for one snapshot and one wait category
-- Parameters: 
--    @instance_name - SQL Server instance name
--    @snapshot_time_id - time window identifier (snapshot ID from core.snapshots) 
--    @category_name - Name of wait category to filter on
--
IF (NOT OBJECT_ID(N'snapshots.rpt_wait_stats_one_snapshot_one_category', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_wait_stats_one_snapshot_one_category] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_wait_stats_one_snapshot_one_category]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_wait_stats_one_snapshot_one_category] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_wait_stats_one_snapshot_one_category]
    @instance_name sysname,
    @snapshot_time_id int,
    @category_name nvarchar(20)
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Use CTE to select first all raw data that we neeed
    -- For each snapshot append a [rank] column, which later will be used to do the self-join
    WITH wait_times AS 
    (
    -- First part gets resource wait times for each wait_type,
    -- calculated as wait_time_ms - signal_wait_time_ms 
    SELECT 
        DENSE_RANK() OVER (ORDER BY ws1.collection_time) AS [rank],
        s.snapshot_time_id,
        ws1.collection_time, 
        ct.category_name,
        ev.wait_type,
        ws1.waiting_tasks_count,
        ws1.wait_time_ms - ws1.signal_wait_time_ms as resource_wait_time_ms
    FROM core.snapshots s
    JOIN snapshots.os_wait_stats ws1 on (ws1.snapshot_id = s.snapshot_id)
    JOIN core.wait_types ev on (ev.wait_type = ws1.wait_type)
    JOIN core.wait_categories ct on (ct.category_id = ev.category_id)
    WHERE ct.category_name = @category_name
      AND s.instance_name = @instance_name
      AND (s.snapshot_time_id = @snapshot_time_id OR s.snapshot_time_id = @snapshot_time_id - 1)
    )
    -- Do a self-join to calculate deltas between snapshots
    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (t1.collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        t1.wait_type,
        (t1.waiting_tasks_count - t2.waiting_tasks_count) AS waiting_tasks_count_delta,
        (t1.resource_wait_time_ms - ISNULL(t2.resource_wait_time_ms,0))/CAST(DATEDIFF(second, t2.collection_time, t1.collection_time) AS decimal) AS resource_wait_time_delta
    FROM wait_times t1
    LEFT OUTER JOIN wait_times t2 on (t2.rank = t1.rank-1 and t2.wait_type = t1.wait_type)
    WHERE t1.snapshot_time_id = @snapshot_time_id
    ORDER BY collection_time, wait_type
END;
GO
GRANT EXECUTE ON [snapshots].[rpt_wait_stats_one_snapshot_one_category]  TO [mdw_reader]
GO



--
-- snapshots.rpt_sql_process_memory
--  Returns details of the SQL process' memory usage
-- Parameters: 
--    @ServerName - SQL Server instance name
--    @EndTime - End of the user-selected time window (UTC)
--    @WindowSize - Number of minutes in the time window 
--
IF (NOT OBJECT_ID(N'snapshots.rpt_sql_process_memory', 'P') IS NULL)
BEGIN
    RAISERROR('Dropping procedure [snapshots].[rpt_sql_process_memory] ...', 0, 1)  WITH NOWAIT;
    DROP PROCEDURE [snapshots].[rpt_sql_process_memory]
END
GO 

RAISERROR('Creating procedure [snapshots].[rpt_sql_process_memory] ...', 0, 1)  WITH NOWAIT;
GO
CREATE PROCEDURE [snapshots].[rpt_sql_process_memory]
    @ServerName sysname,
    @EndTime datetime = NULL,
    @WindowSize int
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Divide our time window up into 40 evenly-sized time intervals, and find the last collection_time within each of these intervals
    CREATE TABLE #intervals (
        interval_time_id        int, 
        interval_start_time     datetimeoffset(7),
        interval_end_time       datetimeoffset(7),
        interval_id             int, 
        first_collection_time   datetimeoffset(7), 
        last_collection_time    datetimeoffset(7), 
        first_snapshot_id       int,
        last_snapshot_id        int, 
        source_id               int, 
        snapshot_id             int, 
        collection_time         datetimeoffset(7), 
        collection_time_id      int
    )
    -- GUID 49268954-... is the Server Activity CS
    INSERT INTO #intervals
    EXEC [snapshots].[rpt_interval_collection_times] 
        @ServerName, @EndTime, @WindowSize, 'snapshots.sql_process_and_system_memory', '49268954-4FD4-4EB6-AA04-CD59D9BB5714', 40, 0

    SELECT 
        CONVERT (datetime, SWITCHOFFSET (CAST (collection_time AS datetimeoffset(7)), '+00:00')) AS collection_time, 
        CASE 
            WHEN series = 'sql_virtual_address_space_reserved_kb' THEN 'Virtual Memory Reserved'
            WHEN series = 'sql_virtual_address_space_committed_kb' THEN 'Virtual Memory Committed'
            WHEN series = 'sql_physical_memory_in_use_kb' THEN 'Physical Memory In Use'
            WHEN series = 'process_physical_memory_low' THEN 'Physical Memory Low'
            WHEN series = 'process_virtual_memory_low' THEN 'Virtual Memory Low'
            ELSE series
        END AS series,
        [value] / 1024 AS [value] -- convert KB to MB
    FROM 
    (
        SELECT 
            pm.collection_time,
            pm.sql_virtual_address_space_reserved_kb,
            pm.sql_virtual_address_space_committed_kb,
            pm.sql_physical_memory_in_use_kb,
            CONVERT (bigint, pm.process_physical_memory_low) AS process_physical_memory_low,
            CONVERT (bigint, pm.process_virtual_memory_low) AS process_virtual_memory_low
        FROM [snapshots].[sql_process_and_system_memory] AS pm
        INNER JOIN #intervals AS i ON (i.last_snapshot_id = pm.snapshot_id AND i.last_collection_time = pm.collection_time)
    ) AS pvt
    UNPIVOT
    (
        [value] for [series] in 
            (sql_virtual_address_space_reserved_kb, sql_virtual_address_space_committed_kb, 
            sql_physical_memory_in_use_kb)
    ) AS unpvt
END
GO
GRANT EXECUTE ON [snapshots].[rpt_sql_process_memory]                   TO [mdw_reader]
GO



/**********************************************************************/
/* END OF LEGACY OBJECTS                                              */
/**********************************************************************/



/**********************************************************************/
/* OPERATOR CHECK                                                     */
/**********************************************************************/

-- This trigger needs to be defined after we have created all our tables,
-- otherwise it would interfere with them
IF EXISTS (SELECT object_id FROM sys.triggers WHERE name = N'add_operator_check' AND type = N'TR')
BEGIN
    RAISERROR('Dropping database trigger [add_operator_check] ...', 0, 1)  WITH NOWAIT;
    DROP TRIGGER [add_operator_check] ON DATABASE
END
GO 

RAISERROR('Creating database trigger [add_operator_check] ...', 0, 1)  WITH NOWAIT;
GO
CREATE TRIGGER [add_operator_check]
ON DATABASE
WITH EXECUTE AS 'mdw_check_operator_admin'
FOR CREATE_TABLE 
AS 
BEGIN
    DECLARE @schema_name sysname;
    DECLARE @table_name sysname;

    -- Set options required by the rest of the code in this SP.
    SET ANSI_NULLS ON
    SET ANSI_PADDING ON
    SET ANSI_WARNINGS ON
    SET ARITHABORT ON
    SET CONCAT_NULL_YIELDS_NULL ON
    SET NUMERIC_ROUNDABORT OFF
    SET QUOTED_IDENTIFIER ON 


    SELECT @schema_name = EVENTDATA().value('(/EVENT_INSTANCE/SchemaName)[1]', 'sysname')
    IF (@schema_name = N'custom_snapshots')
    BEGIN
        SELECT @table_name = EVENTDATA().value('(/EVENT_INSTANCE/ObjectName)[1]', 'sysname')

        -- Dynamically add a constraint on the newly created table
        -- Table must have the snapshot_id column
        DECLARE @check_name sysname;
        SELECT @check_name = N'CHK_check_operator_' + CONVERT(nvarchar(36), NEWID());
        DECLARE @sql nvarchar(2000);
        SELECT @sql = N'ALTER TABLE ' + QUOTENAME(@schema_name) + N'.' + QUOTENAME(@table_name) +
                      N' ADD CONSTRAINT ' + QUOTENAME(@check_name) + ' CHECK (core.fn_check_operator(snapshot_id) = 1);';

        -- We dont expect any result set returned while executing ALTER TABLE statement in Dynamic SQL
        EXEC(@sql)
        WITH RESULT SETS NONE
        
        -- Dynamically revoke the CONTROL right on the table for mdw_writer
        -- That way mdw_writer creates the table but cannot remove it or alter it
        SELECT @sql = N'DENY ALTER ON ' + QUOTENAME(@schema_name) + N'.' + QUOTENAME(@table_name) +
                      N'TO [mdw_writer]';

        -- We dont expect any result set returned while executing DENY statement in Dynamic SQL
        EXEC(@sql)
        WITH RESULT SETS NONE
    END
END;
GO



IF EXISTS (SELECT object_id FROM sys.triggers WHERE name = N'deny_drop_table' AND type = N'TR')
BEGIN
    RAISERROR('Dropping database trigger [deny_drop_table] ...', 0, 1)  WITH NOWAIT;
    DROP TRIGGER [deny_drop_table] ON DATABASE
END
GO 

RAISERROR('Creating database trigger [deny_drop_table] ...', 0, 1)  WITH NOWAIT;
GO
CREATE TRIGGER [deny_drop_table]
ON DATABASE
FOR DROP_TABLE 
AS 
BEGIN
    -- Security check (role membership)
    IF (NOT (ISNULL(IS_MEMBER(N'mdw_admin'), 0) = 1) AND NOT (ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0) = 1))
    BEGIN
        RAISERROR(14677, 16, -1, 'mdw_admin');
    END;
END;
GO

/**********************************************************************/
/* install system collector types                                     */
/**********************************************************************/
RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Adding collector types...', 0, 1)  WITH NOWAIT;
GO

-- Install TSQL Query collector type
EXEC [core].[sp_add_collector_type] @collector_type_uid = '302e93d1-3424-4be7-aa8e-84813ecf2419'
GO

-- Install SqlTrace collector type
EXEC [core].[sp_add_collector_type] @collector_type_uid = '0E218CF8-ECB5-417B-B533-D851C0251271'
GO

-- Install Performance Counters collector type
EXEC [core].[sp_add_collector_type] @collector_type_uid = '294605dd-21de-40b2-b20f-f3e170ea1ec3'

-- Install Query Activity collectory type
EXEC [core].[sp_add_collector_type] @collector_type_uid = '14AF3C12-38E6-4155-BD29-F33E7966BA23'
GO




/**********************************************************************/
/* Data Purge job                                            */
/**********************************************************************/
RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Creating purge data job...', 0, 1)  WITH NOWAIT;
GO

BEGIN TRY
    BEGIN TRANSACTION;

    DECLARE @job_owner NVARCHAR(256);
    SELECT @job_owner = SUSER_SNAME();

    DECLARE @db_name sysname
    SELECT @db_name = DB_NAME();

    DECLARE @job_name_for_purge sysname
    SELECT @job_name_for_purge = N'mdw_purge_data_' + QUOTENAME(@db_name)

    DECLARE @job_id UNIQUEIDENTIFIER; 
    SELECT @job_id = job_id FROM [msdb].[dbo].[sysjobs_view] WHERE [name] = @job_name_for_purge
    IF @job_id IS NULL
    BEGIN 
        -- Add job category if it does not exist. On Katmai server this will be already created.
        IF NOT EXISTS (SELECT name FROM msdb.dbo.syscategories WHERE name=N'Data Collector' AND category_class=1)
        BEGIN
            EXEC msdb.dbo.sp_add_category @class=N'JOB', @type=N'LOCAL', @name=N'Data Collector'
        END

        -- Add job
        EXEC msdb.dbo.sp_add_job 
                @job_name=@job_name_for_purge, 
                @enabled=1, 
                @notify_level_eventlog=0, 
                @notify_level_email=0, 
                @notify_level_netsend=0, 
                @notify_level_page=0, 
                @delete_level=0, 
                @description=N'Runs every day and removes data from Management Data Warehouse database that reached its expiration date.', 
                @category_name=N'Data Collector', 
                @owner_login_name=@job_owner,
                @job_id = @job_id OUTPUT;

        -- Add job step
        EXEC msdb.dbo.sp_add_jobstep 
                @job_id=@job_id, 
                @step_name=N'Step 1', 
                @step_id=1, 
                @cmdexec_success_code=0, 
                @on_success_action=1, 
                @on_success_step_id=0, 
                @on_fail_action=2, 
                @on_fail_step_id=0, 
                @retry_attempts=0, 
                @retry_interval=0, 
                @os_run_priority=0, 
                @subsystem=N'TSQL', 
                @command=N'exec core.sp_purge_data', 
                @database_name=@db_name, 
                @flags=4;

        -- Set the job step to start
        EXEC msdb.dbo.sp_update_job @job_id = @job_id, @start_step_id = 1;

        -- Add schedule
        EXEC msdb.dbo.sp_add_jobschedule 
                @job_id=@job_id, 
                @name=N'mdw_purge_data_schedule', 
                @enabled=1, 
                @freq_type=4, 
                @freq_interval=1, 
                @freq_subday_type=1, 
                @freq_subday_interval=0, 
                @freq_relative_interval=0, 
                @freq_recurrence_factor=0, 
                @active_start_time=20000;

        -- Set the job server
        EXEC msdb.dbo.sp_add_jobserver @job_id = @job_id, @server_name = N'(local)';
    END
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF (@@TRANCOUNT > 0) 
        ROLLBACK TRANSACTION

    -- Rethrow the error
    DECLARE @ErrorMessage   NVARCHAR(4000);
    DECLARE @ErrorSeverity  INT;
    DECLARE @ErrorState     INT;
    DECLARE @ErrorNumber    INT;
    DECLARE @ErrorLine      INT;
    DECLARE @ErrorProcedure NVARCHAR(200);
    SELECT @ErrorLine = ERROR_LINE(),
           @ErrorSeverity = ERROR_SEVERITY(),
           @ErrorState = ERROR_STATE(),
           @ErrorNumber = ERROR_NUMBER(),
           @ErrorMessage = ERROR_MESSAGE(),
           @ErrorProcedure = ISNULL(ERROR_PROCEDURE(), '-');

    RAISERROR (14684, -1, -1 , @ErrorNumber, @ErrorSeverity, @ErrorState, @ErrorProcedure, @ErrorLine, @ErrorMessage);

END CATCH
GO



SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

/**********************************************************************/
/* UTILITY SCHEMAS                                                    */
/* Utility objects (in MDW) live in one of the following schemas      */
/*   [Snapshots] - stores the "live" tables (the tables loaded by DC  */
/*                 collection items                                   */
/*   [Sysutility_ucp_staging] - contains the views, SPs, functions    */
/*                 that help to transform the "live" table data into  */
/*                 the "cache" tables (see below)                     */
/*   [sysutility_ucp_core] - contains the cleansed tables, and     */
/*                 views, SPs, and functions that represent the guts  */
/*                 of the Utility data warehouse                      */
/*   [sysutility_ucp_misc] - contains other objects that don't fit    */
/*                 the schemas above. This schema currently contains  */
/*                 only two objects (both functions), and should be   */
/*                 eliminated at some point                           */
/*                                                                    */
/* In an ideal world, the UCP tables in the [snapshots] schema would  */
/* live in the [sysutility_ucp_staging] schema instead. Current DC    */
/* limitations do not allow for that                                  */
/*                                                                    */
/* The objects in the [snapshots] and [sysutility_ucp_staging] schema */
/* should be entirely private to the MDW database. Only objects in    */
/* the [sysutility_ucp_core] schema and the [sysutility_ucp_misc]  */
/* schemas should be referenced externally - either by objects in MSDB*/
/* or by Utility object model code                                    */
/**********************************************************************/
RAISERROR('', 0, 1)  WITH NOWAIT;
BEGIN
  DECLARE @sql nvarchar(128)

  -- 
  -- Unfortunately, CREATE SCHEMA needs to be the only statement in its 
  -- batch. That's why we use dynamic sql below
  --
  
  RAISERROR('Create schema [sysutility_ucp_misc]', 0, 1)  WITH NOWAIT;
  IF (SCHEMA_ID('sysutility_ucp_misc') IS NULL)
  BEGIN
    SET @sql = 'CREATE SCHEMA [sysutility_ucp_misc]'
    EXEC sp_executesql @sql
  END
  
  RAISERROR('Create schema [sysutility_ucp_staging]', 0, 1)  WITH NOWAIT;
  IF (SCHEMA_ID('sysutility_ucp_staging') IS NULL)
  BEGIN
    SET @sql = 'CREATE SCHEMA [sysutility_ucp_staging]'
    EXEC sp_executesql @sql
  END
  
  RAISERROR('Create schema [sysutility_ucp_core]', 0, 1)  WITH NOWAIT;
  IF (SCHEMA_ID('sysutility_ucp_core') IS NULL)
  BEGIN
    SET @sql = 'CREATE SCHEMA [sysutility_ucp_core]'
    EXEC sp_executesql @sql
  END
  
END
GO



-----------------------------------------------------------------------
-- View sysutility_ucp_misc.utility_objects_internal
--   Categorizes all Utility-owned objects in the MDW database.  Used, for 
--   example, to dynamically discover which tables are cache tables in order 
--   to update stats on them, or to purge data from all tables that play a 
--   given role. 
-----------------------------------------------------------------------
IF OBJECT_ID ('sysutility_ucp_misc.utility_objects_internal') IS NOT NULL
BEGIN
   RAISERROR('Dropping view sysutility_ucp_misc.utility_objects_internal', 0, 1) WITH NOWAIT;
   DROP VIEW sysutility_ucp_misc.utility_objects_internal;
END
GO

RAISERROR('Creating view sysutility_ucp_misc.utility_objects_internal', 0, 1) WITH NOWAIT;
GO

CREATE VIEW sysutility_ucp_misc.utility_objects_internal AS 
SELECT 
   SCHEMA_NAME (obj.[schema_id]) AS [object_schema], 
   obj.name AS [object_name], 
   obj.type_desc AS sql_object_type, 
   CAST (prop.value AS varchar(60)) AS utility_object_type 
FROM sys.extended_properties AS prop
INNER JOIN sys.objects AS obj ON prop.major_id = obj.[object_id]
WHERE prop.name = 'MS_UtilityObjectType';
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'MISC', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_misc', 
   @level1type = 'VIEW', @level1name = 'utility_objects_internal';
GO


-----------------------------------------------------------------------
-- Function to get max file size using growth type = KB. Parameters include file_size, max_size, growth size (all in KB)
-- The algorithm is:
--    the max file size = (max_size - ((max_size - file_size) % growth_size))
-- 
-- max_size - file_size means the remaining available free space.
-- because we grow a fixed chunk specified by growth_size, so we need to figure out
-- what would the remainder free space after the maximum growth, and then subtract that
-- from max_size.
-----------------------------------------------------------------------
IF (OBJECT_ID(N'[sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_kb]') IS NOT NULL)
BEGIN
   RAISERROR('Dropping function [sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_kb]', 0, 1)  WITH NOWAIT;
   DROP FUNCTION [sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_kb]
END
GO

RAISERROR('Creating function [sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_kb]', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_kb](
                @file_size_kb REAL,
                @max_size_kb REAL, 
                @growth_size_kb REAL)
RETURNS REAL 
AS
BEGIN
    DECLARE @max_size_available_kb REAL;
    
    SELECT @max_size_available_kb = @file_size_kb;
    
    IF (@growth_size_kb > 0 AND @max_size_kb > @file_size_kb)
    BEGIN
        SELECT @max_size_available_kb = 
            (@max_size_kb - 
              CONVERT(REAL, CONVERT(BIGINT, @max_size_kb - @file_size_kb) % CONVERT(BIGINT, @growth_size_kb)))
    END
    
    RETURN @max_size_available_kb
END
GO

-----------------------------------------------------------------------
-- Function to get max file size using growth type = percentage. Parameters include file_size, max_size (in KB) and percentage
-- The algorithm is:
--    exp = log(  (max_size / file_size) / (1 + growth_percent / 100)  )
--    the max file size = file_size * (1 + growth_percent / 100) ^ exp
-----------------------------------------------------------------------
IF (OBJECT_ID(N'[sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_percent]') IS NOT NULL)
BEGIN
   RAISERROR('Dropping function [sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_percent]', 0, 1)  WITH NOWAIT;
   DROP FUNCTION [sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_percent]
END
GO

RAISERROR('Creating function [sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_percent]', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [sysutility_ucp_misc].[fn_get_max_size_available_by_growth_type_percent](
                @file_size_kb REAL,
                @max_size_kb REAL, 
                @growth_percent REAL)
RETURNS REAL 
AS
BEGIN
    DECLARE @max_size_available_kb REAL;
    DECLARE @one_plus_growth_percent REAL;
    DECLARE @exponent REAL;
    
    SELECT @max_size_available_kb = @file_size_kb;
    SELECT @one_plus_growth_percent = 1 + @growth_percent / 100;
    --- @file_size_kb > 0 is added to avoid the divided by zero exception. When a database is in the Emergency state, the size
    --- of its log file is zero. 
    IF (@growth_percent > 0 AND @max_size_kb > @file_size_kb AND @file_size_kb > 0)
    BEGIN
        SELECT @exponent = FLOOR(LOG10(@max_size_kb / @file_size_kb) / LOG10(@one_plus_growth_percent));
        SELECT @max_size_available_kb = @file_size_kb * POWER(@one_plus_growth_percent, @exponent);
    END
    
    RETURN @max_size_available_kb
END
GO

-----------------------------------------------------------------------
--  Function to get max size available depending on the file_size, its mx_size, growth and free_space_on_drive (everything in KB).
--  Algorithm used for calculating max size available on the drive:
--
--      if no auto grow then return the current file size, done.
--
--      assuming auto grow now:
--      if max size is configured and it's less than the (current file size + volume free space)
--          which means the max size boundary is in effect, then we use the max_size as the boundary.
--      if max size is not configured (unlimited growth) or it's already bigger than the remaining size,
--          which means the max size boundary is NOT in effect, then we use the (curent file size + volume free space)
--          as the boundary.
--
--      now we got the boundary size, we need to take a look the growth type:
--      if growth type = kb (0), then we simply try to fit as many chunks as possible (need to use % operation here)
--      if growth type = percent (1), then it's a little tricky, we need to find the max exp where
--          (current file size) * (1 + growth percent) ^ exp <= boundary size.
--      log/power operations involved. one we figure out the exp, we can compute the max available size.
-- 
--  NOTE: the return value is 
--      (the current file size      +   the max possible additional space the file can grow into)
-----------------------------------------------------------------------
IF (OBJECT_ID(N'[sysutility_ucp_misc].[fn_get_max_size_available]') IS NOT NULL)
BEGIN
   RAISERROR('Dropping function [sysutility_ucp_misc].[fn_get_max_size_available]', 0, 1)  WITH NOWAIT;
   DROP FUNCTION [sysutility_ucp_misc].[fn_get_max_size_available]
END
GO

RAISERROR('Creating function [sysutility_ucp_misc].[fn_get_max_size_available]', 0, 1)  WITH NOWAIT;
GO
CREATE FUNCTION [sysutility_ucp_misc].[fn_get_max_size_available](
                @file_size_kb REAL,
                @max_size_kb REAL, 
                @growth REAL,       --  growth is KB when type is not percentage, or a whole number percentage when percentage
                @smo_growth_type SMALLINT,  -- @smo_growth_type == 0 is KB growth, == 1 means percentage, or == 99 not supported to grow
                @free_space_on_drive_kb BIGINT)
RETURNS REAL 
AS
BEGIN
    DECLARE @max_size_available_kb REAL;
    DECLARE @projected_max_file_size_kb REAL;
    
    -- Be conservative and initialize total space to @file_size_kb (assume no autogrow)
    SELECT @max_size_available_kb  = @file_size_kb;
    
    -- Let projected size be the current file size + volume free space (assuming no one else is competing and its completely available for this file)
    SELECT @projected_max_file_size_kb = @file_size_kb + @free_space_on_drive_kb;

    -- No auto grow, return the configured file size
    IF (@smo_growth_type = 99)
    BEGIN
        SELECT @max_size_available_kb = @file_size_kb;
    END
    ELSE
    BEGIN
        IF (0 < @max_size_kb AND @max_size_kb < @projected_max_file_size_kb)
        BEGIN
            -- if maxsize is configured and it's less than the project space
            -- then we use the maxsize as the growth boundary.
            SELECT @max_size_available_kb =
                CASE
                    WHEN (@smo_growth_type = 1) -- percent growth
                    THEN sysutility_ucp_misc.fn_get_max_size_available_by_growth_type_percent(@file_size_kb, @max_size_kb, @growth)

                    WHEN (@smo_growth_type = 0) -- KB growth
                    THEN sysutility_ucp_misc.fn_get_max_size_available_by_growth_type_kb(@file_size_kb, @max_size_kb, @growth)
                    
                    ELSE @max_size_kb
                END
        END
        ELSE
        BEGIN
            -- either maxsize is not configured, in this case we use the project space
            -- or maxsize is bigger than the project space, and we suse the project space as well.
            SELECT @max_size_available_kb =
                CASE
                    WHEN (@smo_growth_type = 1) -- percent growth
                    THEN sysutility_ucp_misc.fn_get_max_size_available_by_growth_type_percent(@file_size_kb, @projected_max_file_size_kb, @growth)

                    WHEN (@smo_growth_type = 0) -- KB growth
                    THEN sysutility_ucp_misc.fn_get_max_size_available_by_growth_type_kb(@file_size_kb, @projected_max_file_size_kb, @growth)
                    
                    ELSE @projected_max_file_size_kb
                END
        END
    END

    -- VSTS 351411
    -- In SQL2008 and SQL2008 R2, unfortunately the support for file stream file
    -- in SMO and dmv aren't complete: it always return 0 for everything including 
    -- @file_size_kb, @max_size_kb, growth, thus walking through the code path above, 
    -- we'll return 0, then the our data file storage utilization property use this 
    -- value (as the denominator) to compute the percentage which would result 
    -- in divide by zero (DBZ).
    -- 
    -- So for that case, we simply return the @projected_max_file_size_kb to avoid DBZ. Of course
    -- there is a tiny chance @projected_max_file_size_kb is also 0 (due to volume free space is 0
    -- the volume is full!) so we'll simply return 1 (kb)
    --
    -- Note 1: to avoid comparing equality of double-typed variable to 0, check against 1 KB
    --         it wouldn't be any faster but readability is lower.
    IF (@max_size_available_kb < 1.0) 
    BEGIN
        SELECT @max_size_available_kb = @projected_max_file_size_kb;
        -- what if @projected_max_file_size_kb is still 0 (or near 0)? use 1 kb.
        IF (@max_size_available_kb < 1.0)
        BEGIN
            SELECT @max_size_available_kb = 1.0;
        END
    END
    
    RETURN @max_size_available_kb;
END
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'MISC', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_misc', 
   @level1type = 'FUNCTION', @level1name = 'fn_get_max_size_available';
GO


-------------------------------------------------------------------------
-- Create table: sysutility_ucp_batch_manifests_internal
-- This is the target table to store the manifest information for every batch collected 
-- The purpose of the manifest is to qualify the integrity of the data uploaded on the UCP.
-- The batch manifest primarily includes:
-- 1. server_instance_name: the server\instance name of the MI
-- 2. xx_row_count: row count for each of the table collected/uploaded by the utility T-SQL collection item query
-- 3. batch_time: the batch creation date-time stamp 
--
-- Note: the manifest info is stored in the form of name/value pair. This pattern is 
-- used is to minimize structural changes to the table in case there are collection 
-- queries added/removed in future that affects the manifest.
-------------------------------------------------------------------------
IF NOT EXISTS (SELECT name FROM sys.objects WHERE object_id = OBJECT_ID(N'[snapshots].[sysutility_ucp_batch_manifests_internal]') )
BEGIN
    RAISERROR('Creating table [snapshots].[sysutility_ucp_batch_manifests_internal]', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[sysutility_ucp_batch_manifests_internal]
    (
        [server_instance_name]  SYSNAME NOT NULL,
        [batch_time]            DATETIMEOFFSET(7) NOT NULL,  
        [parameter_name]        SYSNAME NOT NULL,           -- Name, representing the collection query uploading data to the live table
        [parameter_value]       SQL_VARIANT NULL,           -- Value, indicating the number of rows collected/uploaded by the respective query
        [collection_time]       DATETIMEOFFSET(7) NULL,
        [snapshot_id]           INT NULL
    ) ON [PRIMARY]

    ALTER TABLE [snapshots].[sysutility_ucp_batch_manifests_internal]  WITH CHECK ADD  CONSTRAINT [FK_sysutility_ucp_batch_manifests_internal] FOREIGN KEY([snapshot_id])
    REFERENCES [core].[snapshots_internal] ([snapshot_id])
    ON DELETE CASCADE
    ALTER TABLE [snapshots].[sysutility_ucp_batch_manifests_internal] CHECK CONSTRAINT [FK_sysutility_ucp_batch_manifests_internal]

    ALTER TABLE [snapshots].[sysutility_ucp_batch_manifests_internal]  WITH CHECK ADD  CONSTRAINT [CHK_check_operator_E4F8A95D-2C44-48B6-85BA-E78E47C7ACCE] CHECK  (([core].[fn_check_operator]([snapshot_id])=(1)))
    ALTER TABLE [snapshots].[sysutility_ucp_batch_manifests_internal] CHECK CONSTRAINT [CHK_check_operator_E4F8A95D-2C44-48B6-85BA-E78E47C7ACCE]

    -- This index is used by the caching job to identify the latest consistent batches 
    -- This index is also used by the DC purge job to seek against snapshot_id
    CREATE CLUSTERED INDEX CI_sysutility_ucp_batch_manifests_internal 
        ON [snapshots].[sysutility_ucp_batch_manifests_internal](snapshot_id)
    
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'LIVE', 
        @level0type = 'SCHEMA', @level0name = 'snapshots', 
        @level1type = 'TABLE', @level1name = 'sysutility_ucp_batch_manifests_internal';
END
GO


--*********************************************************************
-- Create table: consistent_batch_manifests_internal
-- This table stores the consistent batch information for the enrolled MI's.
-- The data returned by the view consistent_batch_manifests is stored 
-- in this table and is consumed by the caching job step.  
--*********************************************************************
IF (OBJECT_ID(N'[sysutility_ucp_staging].[consistent_batch_manifests_internal]', 'U') IS NULL)
BEGIN
   RAISERROR('Creating [sysutility_ucp_staging].[consistent_batch_manifests_internal] table', 0, 1)  WITH NOWAIT;
   CREATE TABLE [sysutility_ucp_staging].[consistent_batch_manifests_internal]
   (
        [server_instance_name]      SYSNAME NOT NULL,
        [batch_time]                DATETIMEOFFSET NOT NULL
        
      CONSTRAINT PK_consistent_batch_manifests_internal PRIMARY KEY CLUSTERED 
         (server_instance_name, batch_time) 
   )
   
   EXEC sp_addextendedproperty 
      @name = 'MS_UtilityObjectType', @value = 'STAGING', 
      @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_staging', 
      @level1type = 'TABLE', @level1name = 'consistent_batch_manifests_internal';
END;
GO

----------------------------------------------------------------------------
-- Table [sysutility_ucp_dac_collected_execution_statistics_internal]
--    Stores the output of sp_sysutility_instance_retrieve_dac_execution_statistics, 
--    which is executed by the Utility Data Collector collection set to retrieve DAC 
--    info, including execution statistics like the amount of CPU time being consumed 
--    by each DAC.  The execution statistics (%CPU) returned by this query are 
--    actually collected by a different SQL Agent job that runs every 15 seconds on 
--    the managed instance. 
----------------------------------------------------------------------------
IF (OBJECT_ID(N'[snapshots].[sysutility_ucp_dac_collected_execution_statistics_internal]', 'U') IS NULL)
BEGIN
   RAISERROR('Creating [snapshots].[sysutility_ucp_dac_collected_execution_statistics_internal] table', 0, 1)  WITH NOWAIT;
   CREATE TABLE [snapshots].[sysutility_ucp_dac_collected_execution_statistics_internal]
   (
      [physical_server_name] SYSNAME,
      [server_instance_name] SYSNAME,
      [dac_db] SYSNAME,
      [dac_deploy_date] DATETIME,
      [dac_description] NVARCHAR(4000) NULL,
      [dac_name] SYSNAME,
      [interval_start_time] DATETIMEOFFSET NULL,-- The first every-15-second DAC CPU collection time included in this row's time interval
      [interval_end_time] DATETIMEOFFSET NULL,  -- The last every-15-second DAC CPU collection time included in this row's time interval (typically ~15 min after interval_start_time)
      [interval_cpu_time_ms] BIGINT NULL,       -- The total amount of CPU time consumed by this DAC in the time interval
      [interval_cpu_pct] REAL NULL,             -- The average %CPU utilization for this DAC in the time interval (% is of all available CPU cycles, not just a single CPU)
      [lifetime_cpu_time_ms] BIGINT NULL,       -- The cumulative total CPU time consumed by this DAC since we started monitoring it
      [batch_time] datetimeoffset(7),           -- Start time for one execution of the Utility data collection job
      [collection_time] [datetimeoffset](7),    -- The execution time of the DC query that gathered this data from the managed instance
      [snapshot_id] [int], 
      
      -- This index is used by the caching job to copy the latest consistent batch from live to cache table
      CONSTRAINT PK_sysutility_ucp_dac_collected_execution_statistics_internal PRIMARY KEY CLUSTERED 
         (server_instance_name, batch_time, dac_name) 
   );      

    -- This index is used by the DC purge job to seek against snapshot_id
   CREATE NONCLUSTERED INDEX NCI_sysutility_ucp_dac_collected_execution_statistics_internal 
        ON [snapshots].[sysutility_ucp_dac_collected_execution_statistics_internal](snapshot_id)    

   -- Create a foreign key referencing snapshots_internal so that rows in this table will be deleted by the DC purge job
   ALTER TABLE [snapshots].[sysutility_ucp_dac_collected_execution_statistics_internal] WITH CHECK 
   ADD CONSTRAINT [fk_dac_collected_execution_statistics_internal_snapshots_internal] 
   FOREIGN KEY([snapshot_id])
   REFERENCES [core].[snapshots_internal] ([snapshot_id])
   ON DELETE CASCADE;
   
   EXEC sp_addextendedproperty 
      @name = 'MS_UtilityObjectType', @value = 'LIVE', 
      @level0type = 'SCHEMA', @level0name = 'snapshots', 
      @level1type = 'TABLE', @level1name = 'sysutility_ucp_dac_collected_execution_statistics_internal';
END;
GO

----------------------------------------------------------------------------------
-- View latest_dac_cpu_utilization
--    Gets the latest DAC-related information and CPU utilization for each DAC on a
--    managed instanced
----------------------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_staging].[latest_dac_cpu_utilization]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_staging].[latest_dac_cpu_utilization] view', 0, 1) WITH NOWAIT;
   DROP VIEW [sysutility_ucp_staging].[latest_dac_cpu_utilization]
END
GO

RAISERROR('Creating [sysutility_ucp_staging].[latest_dac_cpu_utilization] view', 0, 1) WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_staging].[latest_dac_cpu_utilization]
AS
  SELECT physical_server_name, ds.server_instance_name, dac_db, dac_deploy_date, dac_description, dac_name, 
         lifetime_cpu_time_ms, interval_cpu_pct AS latest_cpu_pct, interval_cpu_time_ms AS latest_interval_cpu_time_ms, 
         interval_start_time AS latest_interval_start_time, interval_end_time AS latest_interval_end_time, 
         ds.batch_time,
         N'Utility[@Name=''' + CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')) + N''']/DeployedDac[@Name=''' + ds.dac_name + N''' and @ServerInstanceName=''' + ds.server_instance_name + N''']' AS urn,
         N'SQLSERVER:\Utility\'+CASE WHEN 0 = CHARINDEX(N'\', CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')), 1) THEN CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')) + N'\DEFAULT' ELSE CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')) END 
        +N'\DeployedDacs\'+msdb.dbo.fn_encode_sqlname_for_powershell(ds.dac_name+'.'+ds.server_instance_name) AS powershell_path
  FROM [snapshots].[sysutility_ucp_dac_collected_execution_statistics_internal] ds
        INNER JOIN [sysutility_ucp_staging].[consistent_batch_manifests_internal] cb
        ON ds.server_instance_name = cb.server_instance_name AND ds.batch_time = cb.batch_time
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'STAGING', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_staging', 
   @level1type = 'VIEW', @level1name = 'latest_dac_cpu_utilization';
GO


----------------------------------------------------------------------------
--- MDW Table for storing SMO server collection set information.
----------------------------------------------------------------------------

IF NOT EXISTS (SELECT name FROM .[sys].[objects] WHERE object_id = OBJECT_ID(N'[snapshots].[sysutility_ucp_smo_properties_internal]'))
BEGIN
   RAISERROR('Creating [snapshots].[sysutility_ucp_smo_properties_internal] table', 0, 1) WITH NOWAIT;
   CREATE TABLE [snapshots].[sysutility_ucp_smo_properties_internal]
   (
      [physical_server_name]  SYSNAME,
      [server_instance_name]  SYSNAME,
      [object_type]           INT,
      [urn]                   NVARCHAR(4000),
      [property_name]         NVARCHAR(128),
      [property_value]        SQL_VARIANT,
      [batch_time]            DATETIMEOFFSET(7),  -- Start time for one execution of the Utility data collection job
      [collection_time]       DATETIMEOFFSET(7) NULL,
      [snapshot_id]           INT NULL,
      -- NOTE: compression is enabled on this table at runtime (during Create UCP) in sp_initialize_mdw_internal              
   )

    -- This index is used by the caching job to copy the latest consistent batch from live to cache table
   CREATE CLUSTERED INDEX CI_sysutility_ucp_smo_properties_internal 
        ON [snapshots].[sysutility_ucp_smo_properties_internal](server_instance_name, batch_time); 

    -- This index is used by the DC purge job to seek against snapshot_id
    CREATE NONCLUSTERED INDEX NCI_sysutility_ucp_smo_properties_internal 
        ON [snapshots].[sysutility_ucp_smo_properties_internal](snapshot_id)       

   -- Create a foreign key referencing snapshots_internal so that rows in this table will be deleted by the DC purge job
   ALTER TABLE [snapshots].[sysutility_ucp_smo_properties_internal] WITH CHECK 
   ADD CONSTRAINT [FK_sysutility_ucp_smo_properties_internal_snapshots_internal] 
   FOREIGN KEY([snapshot_id])
   REFERENCES [core].[snapshots_internal] ([snapshot_id])
   ON DELETE CASCADE;

    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'LIVE', 
        @level0type = 'SCHEMA', @level0name = 'snapshots', 
        @level1type = 'TABLE', @level1name = 'sysutility_ucp_smo_properties_internal'; 
END
GO

------------------------------------------------------------------------------
--  SQL Server View to read latest snapshot data for SMO properties
------------------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_staging].[latest_smo_properties]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_staging].[latest_smo_properties] view', 0, 1) WITH NOWAIT;
   DROP VIEW [sysutility_ucp_staging].[latest_smo_properties]
END
GO

RAISERROR('Creating [sysutility_ucp_staging].[latest_smo_properties] view', 0, 1) WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_staging].[latest_smo_properties]
AS
   SELECT s.physical_server_name, s.server_instance_name, s.urn, s.object_type, 
          s.property_name,s.property_value, s.snapshot_id, s.batch_time
   FROM [snapshots].[sysutility_ucp_smo_properties_internal] AS s
         INNER JOIN [sysutility_ucp_staging].[consistent_batch_manifests_internal] cb
         ON s.server_instance_name = cb.server_instance_name AND s.batch_time = cb.batch_time     
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'STAGING', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_staging', 
   @level1type = 'VIEW', @level1name = 'latest_smo_properties';
GO


-----------------------------------------------------------------------
--  Created [snapshots].[sysutility_ucp_cpu_memory_configurations_internal] and [snapshots].[sysutility_ucp_cpu_affinity_internal] tables if they are not existing.
-----------------------------------------------------------------------
IF NOT EXISTS (SELECT name FROM sys.objects WHERE object_id = OBJECT_ID(N'[snapshots].[sysutility_ucp_cpu_memory_configurations_internal]'))
BEGIN
    RAISERROR('Creating table [snapshots].[sysutility_ucp_cpu_memory_configurations_internal]', 0, 1)  WITH NOWAIT;   
    CREATE TABLE [snapshots].[sysutility_ucp_cpu_memory_configurations_internal](
      [server_instance_name]     SYSNAME NOT NULL,
      [is_clustered_server]      SMALLINT NULL,
      [virtual_server_name]      SYSNAME,
      [physical_server_name]     SYSNAME NOT NULL,
      [num_processors]           INT NULL,
      [server_processor_usage]   REAL,
      [instance_processor_usage] REAL,
      [cpu_name]                 NVARCHAR(128) NULL,
      [cpu_caption]              NVARCHAR(128) NULL,
      [cpu_family]               NVARCHAR(128) NULL,
      [cpu_architecture]         NVARCHAR(64) NULL,
      [cpu_max_clock_speed]      DECIMAL(10,0) NULL,    -- this is in MHz (Mega Hertz)
      [cpu_clock_speed]          DECIMAL(10,0) NULL,
      [l2_cache_size]            DECIMAL(10,0) NULL,
      [l3_cache_size]            DECIMAL(10,0) NULL,
      [batch_time]               [datetimeoffset](7),  -- Start time for one execution of the Utility data collection job
      [collection_time]          [datetimeoffset](7) NULL,
      [snapshot_id]              [int] NULL
      
    -- This index is used by the caching job to copy the latest consistent batch from live to cache table
    CONSTRAINT PK_sysutility_cpu_memory_related_info_internal_clustered PRIMARY KEY CLUSTERED 
        ([server_instance_name], [batch_time], [physical_server_name])

    ) ON [PRIMARY];

    -- This index is used by the DC purge job to seek against snapshot_id
    CREATE NONCLUSTERED INDEX NCI_sysutility_ucp_cpu_memory_configurations_internal 
        ON [snapshots].[sysutility_ucp_cpu_memory_configurations_internal](snapshot_id)       

    ALTER TABLE [snapshots].[sysutility_ucp_cpu_memory_configurations_internal]  WITH CHECK ADD  CONSTRAINT [FK_sysutility_cpu_memory_related_info_snapshots_internal_snapshots_internal] FOREIGN KEY([snapshot_id])
    REFERENCES [core].[snapshots_internal] ([snapshot_id])
    ON DELETE CASCADE;

    ALTER TABLE [snapshots].[sysutility_ucp_cpu_memory_configurations_internal] CHECK CONSTRAINT [FK_sysutility_cpu_memory_related_info_snapshots_internal_snapshots_internal];

    ALTER TABLE [snapshots].[sysutility_ucp_cpu_memory_configurations_internal]  WITH CHECK ADD  CONSTRAINT [CHK_check_operator_9DAA9ACC-F1E1-44F8-8B74-D081734E5F39] CHECK  (([core].[fn_check_operator]([snapshot_id])=(1)));

    ALTER TABLE [snapshots].[sysutility_ucp_cpu_memory_configurations_internal] CHECK CONSTRAINT [CHK_check_operator_9DAA9ACC-F1E1-44F8-8B74-D081734E5F39];
    
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'LIVE', 
        @level0type = 'SCHEMA', @level0name = 'snapshots', 
        @level1type = 'TABLE', @level1name = 'sysutility_ucp_cpu_memory_configurations_internal';
END
GO

-----------------------------------------------------------------------
--  Gets the latest CPU/memory configurations for each computer - along 
--  with the current CPU utilization for the computer.
-- 
-- NOTE: If there are multiple SQL instances (MIs) on a computer, each of 
--    them uploads its snapshot of information about the computer. We 
--    only want one entry for the computer - so we pick the entry that 
--    was uploaded last
-----------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_staging].[latest_computer_cpu_memory_configuration]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_staging].[latest_computer_cpu_memory_configuration] view', 0, 1) WITH NOWAIT;
   DROP VIEW [sysutility_ucp_staging].[latest_computer_cpu_memory_configuration]
END
GO

RAISERROR('Creating view [sysutility_ucp_staging].[latest_computer_cpu_memory_configuration]', 0, 1)  WITH NOWAIT;   
GO
CREATE VIEW [sysutility_ucp_staging].[latest_computer_cpu_memory_configuration]
AS
   SELECT * 
   FROM
      (
        SELECT  
           ROW_NUMBER() OVER (PARTITION BY t.physical_server_name ORDER BY t.batch_time DESC) AS Rank,
           [virtual_server_name], [is_clustered_server],[physical_server_name], 
           [num_processors], [cpu_name], [cpu_caption], [cpu_family], [cpu_architecture], [cpu_max_clock_speed], [cpu_clock_speed], 
           [l2_cache_size], [l3_cache_size], 
           [server_processor_usage],
           t.[batch_time],
           N'Utility[@Name=''' + CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')) + N''']/Computer[@Name=''' + t.physical_server_name + N''']' AS urn,
           N'SQLSERVER:\Utility\'+CASE WHEN 0 = CHARINDEX(N'\', CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')), 1) THEN CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')) + N'\DEFAULT' ELSE @@SERVERNAME END 
          +N'\Computers\'+msdb.dbo.fn_encode_sqlname_for_powershell(t.physical_server_name) AS powershell_path
        FROM [snapshots].[sysutility_ucp_cpu_memory_configurations_internal] AS t
             INNER JOIN [sysutility_ucp_staging].[consistent_batch_manifests_internal] cb
             ON t.server_instance_name = cb.server_instance_name AND t.batch_time = cb.batch_time
      ) AS S
   WHERE S.Rank = 1
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'STAGING', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_staging', 
   @level1type = 'VIEW', @level1name = 'latest_computer_cpu_memory_configuration';
GO


-----------------------------------------------------------------------

-----------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_staging].[latest_instance_cpu_utilization]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_staging].[latest_instance_cpu_utilization] view', 0, 1) WITH NOWAIT;
   DROP VIEW [sysutility_ucp_staging].[latest_instance_cpu_utilization]
END
GO
RAISERROR('Creating view [sysutility_ucp_staging].[latest_instance_cpu_utilization]', 0, 1)  WITH NOWAIT;   
GO
CREATE VIEW [sysutility_ucp_staging].[latest_instance_cpu_utilization]
AS
   SELECT t.[server_instance_name],  
          [instance_processor_usage],
          t.[batch_time]
   FROM [snapshots].[sysutility_ucp_cpu_memory_configurations_internal] AS t
        INNER JOIN [sysutility_ucp_staging].[consistent_batch_manifests_internal] cb
        ON t.server_instance_name = cb.server_instance_name AND t.batch_time = cb.batch_time
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'STAGING', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_staging', 
   @level1type = 'VIEW', @level1name = 'latest_instance_cpu_utilization';
GO


-----------------------------------------------------------------------
--  Created [snapshots].[sysutility_ucp_volumes_internal] tables to collect volume-related
--  information from the MIs
-----------------------------------------------------------------------

IF NOT EXISTS (SELECT name FROM sys.objects WHERE object_id = OBJECT_ID(N'[snapshots].[sysutility_ucp_volumes_internal]') )
BEGIN
    RAISERROR('Creating table [snapshots].[sysutility_ucp_volumes_internal]', 0, 1)  WITH NOWAIT;
    CREATE TABLE [snapshots].[sysutility_ucp_volumes_internal](
    [server_instance_name]  SYSNAME,
    [virtual_server_name]   SYSNAME,
    [physical_server_name]  SYSNAME,
    
    [volume_device_id]      SYSNAME NOT NULL,
    [volume_name]           [nvarchar](260) NOT NULL,

    [total_space_available] [real] NULL, -- in MB
    [free_space]            [real] NULL, -- in MB
    [batch_time]            datetimeoffset(7),  -- Start time for one execution of the Utility data collection job
    [collection_time]       datetimeoffset(7) NULL,
    [snapshot_id]           [int] NULL
    
    -- This index is used by the caching job to copy the latest consistent batch from live to cache table
    CONSTRAINT PK_sysutility_volumes_info_internal PRIMARY KEY CLUSTERED
        (server_instance_name, batch_time, volume_device_id)
    
    ) ON [PRIMARY]
    
    -- This index is used by the DC purge job to seek against snapshot_id
    CREATE NONCLUSTERED INDEX NCI_sysutility_ucp_volumes_internal
        ON [snapshots].[sysutility_ucp_volumes_internal](snapshot_id) 
            
    ALTER TABLE [snapshots].[sysutility_ucp_volumes_internal]  WITH CHECK ADD  CONSTRAINT [FK_volumes_info_snapshots_internal] FOREIGN KEY([snapshot_id])
    REFERENCES [core].[snapshots_internal] ([snapshot_id])
    ON DELETE CASCADE
    ALTER TABLE [snapshots].[sysutility_ucp_volumes_internal] CHECK CONSTRAINT [FK_volumes_info_snapshots_internal]

    ALTER TABLE [snapshots].[sysutility_ucp_volumes_internal]  WITH CHECK ADD  CONSTRAINT [CHK_check_operator_D79F8519-D243-4176-8291-6F3BA8EF776D] CHECK  (([core].[fn_check_operator]([snapshot_id])=(1)))
    ALTER TABLE [snapshots].[sysutility_ucp_volumes_internal] CHECK CONSTRAINT [CHK_check_operator_D79F8519-D243-4176-8291-6F3BA8EF776D] 
    
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'LIVE', 
        @level0type = 'SCHEMA', @level0name = 'snapshots', 
        @level1type = 'TABLE', @level1name = 'sysutility_ucp_volumes_internal';   
END
GO


-----------------------------------------------------------------------
--  View to get latest volumes information. 
--  NOTE: If you change the output of this view in any way, be sure to also update the 
--  corresponding "stub" object in instmsdb.sql. 
--  
--  NOTE: When you have multiple SQL instances on a machine, each of them is uploading
--     volume information (as it sees it). However, we only want one entry for each
--     volume on the computer. What we do here is to simply pick the entry from the 
--     instance that uploaded last - hence the partition-by (physical_server_name,volume_device_id)
--     The "latest_computers" view exhibits very similar behavior.
-----------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_staging].[latest_volumes]'))
BEGIN
   RAISERROR('Dropping view [sysutility_ucp_staging].[latest_volumes]', 0, 1)  WITH NOWAIT;
   DROP VIEW [sysutility_ucp_staging].[latest_volumes]
END
GO

RAISERROR('Creating view [sysutility_ucp_staging].[latest_volumes]', 0, 1)  WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_staging].[latest_volumes] AS
   SELECT [virtual_server_name],
          [physical_server_name],
          [volume_device_id],
          [volume_name],
          [total_space_available],  -- in MB
          [free_space], -- in MB
          N'SQLSERVER:\Utility\'+ CASE WHEN 0 = CHARINDEX(N'\', CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')), 1) 
                                        THEN CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')) + N'\DEFAULT' 
                                        ELSE CONVERT(SYSNAME, SERVERPROPERTY(N'ServerName')) 
                                    END 
          +N'\Computers\'+msdb.dbo.fn_encode_sqlname_for_powershell(physical_server_name) 
          +N'\Volumes\'+msdb.dbo.fn_encode_sqlname_for_powershell(volume_name) AS powershell_path,
          [batch_time],
          [snapshot_id]
      FROM
      (
      SELECT 
         [virtual_server_name],
         [physical_server_name],
         [volume_device_id],
         [volume_name],
         [total_space_available],
         [free_space],
         V.[batch_time],
         [snapshot_id], 
         ROW_NUMBER() OVER (PARTITION BY physical_server_name,volume_device_id ORDER BY V.batch_time DESC) rk
      FROM [snapshots].[sysutility_ucp_volumes_internal] AS V
           INNER JOIN [sysutility_ucp_staging].[consistent_batch_manifests_internal] cb
           ON V.server_instance_name = cb.server_instance_name AND V.batch_time = cb.batch_time
      ) AS T
      WHERE T.rk = 1
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'STAGING', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_staging', 
   @level1type = 'VIEW', @level1name = 'latest_volumes';
GO


--*********************************************************************
-- Create procedure: sp_get_consistent_batches
-- This procedure gets the consistent batch information for the enrolled MI's
-- and stores it into the consistent_batch_manifests_internal table.
-- This SP is executed by the caching job to identify the consistent batches 
-- whose data needs to be copied from the live to cache tables for every run.
--
-- A batch is marked consistent if the number of records in each table uploaded 
-- match to the respective row count in the batch manifest. The evaluation of 
-- last batch (a) and second-last batch (b) for a given MI is based on following rules: 
-- . Both a and b exists and are consistent: 
--      Most recent batch (a) is returned    
-- . Either a or b exists
--      Returns a or b only if it is consistent. Possiblity of delayed upload from MI side.
-- . Both a and b exists and are inconsistent: 
--      No batch info is returned for that MI. Possiblity of failure in collection/upload on MI side.    
-- . Both a and b does not exist
--      No batch info is not returned for that MI. Aged-out data is currently not considered, VSTS #319498
--*********************************************************************
IF OBJECT_ID ('[sysutility_ucp_staging].[sp_get_consistent_batches]') IS NOT NULL 
BEGIN
    RAISERROR ('Dropping procedure [sysutility_ucp_staging].[sp_get_consistent_batches]', 0, 1) WITH NOWAIT;
    DROP PROCEDURE [sysutility_ucp_staging].[sp_get_consistent_batches]
END;
GO

RAISERROR ('Creating procedure [sysutility_ucp_staging].[sp_get_consistent_batches]', 0, 1) WITH NOWAIT;
GO

CREATE PROCEDURE [sysutility_ucp_staging].[sp_get_consistent_batches] 
AS
BEGIN
    SET NOCOUNT ON;   

    -- Note: As we are not currently caching the aged-out data, this SP
    -- clears the existing records and inserts the new data. However, as a fix for 
    -- VSTS #319498 (display aged-out data) this behavior needs to be changed 
    -- to UPSERT for any existing or new data and delete the entries whose 
    -- data is purged (> 7 days). 

    -- Get the manifest information for the latest uploaded batches.  The "manifest" info includes 
    -- the expected number of rows that should have been uploaded into each live table for the 
    -- batch.  This query captures the manifest for most recent unprocessed batch (T) and the 
    -- immediately prior (T-1) unprocessed batch from each managed instance since the last execution 
    -- of the sp_copy_live_table_data_into_cache_tables stored proc. 
    -- 
    -- This rowset is staged in a temp table b/c the query optimizer cannot accurately predict the 
    -- number of rows that qualify for "WHERE bm.snapshot_id > sp.latest_consistent_snapshot_id". 
    -- 
    -- Note: This view may fetch the last 2 batch manifest rows for a given MI. The reason for 
    -- considering two batches is to use the latest one that is consistent. If the latest one is 
    -- missing (delayed upload) or inconsistent (failed or still-in-progress upload), we will use 
    -- the second-to-last batch, assuming that it is consistent. This makes the caching job 
    -- resilient to occasional delays in the MI upload job. 
    SELECT server_instance_name
        , batch_time
        , CONVERT(INT, dac_packages_row_count) AS dac_packages_row_count
        , CONVERT(INT, cpu_memory_configurations_row_count) AS cpu_memory_configurations_row_count
        , CONVERT(INT, volumes_row_count) AS volumes_row_count
        , CONVERT(INT, smo_properties_row_count) AS smo_properties_row_count        
    INTO #batch_manifests_latest
    FROM  (SELECT bm.server_instance_name, bm.batch_time, bm.parameter_name, bm.parameter_value 
           FROM snapshots.sysutility_ucp_batch_manifests_internal bm
              , msdb.dbo.sysutility_ucp_snapshot_partitions_internal AS sp
           WHERE bm.snapshot_id > sp.latest_consistent_snapshot_id 
             -- The [time_id] = 1 partition gives us the max snapshot_id the last time that the 
             -- sp_copy_live_table_data_into_cache_tables proc was executed (previous high water 
             -- mark).  We will consider for processing any snapshots that have been uploaded 
             -- since then. 
             AND sp.time_id = 1) AS lbm
    PIVOT (MAX(parameter_value) FOR parameter_name IN (dac_packages_row_count
                                                     , cpu_memory_configurations_row_count
                                                     , volumes_row_count
                                                     , smo_properties_row_count)) pvt;
    
    -- Truncate the table
    TRUNCATE TABLE [sysutility_ucp_staging].[consistent_batch_manifests_internal];
    
    -- Get the set of latest batches that are consistent with respect to the data uploaded to 
    -- each live table.  A check is made to verify that the number of rows uploaded matches the 
    -- expected row count in that batch's manifest. 
    -- 
    -- These rowsets are staged in temp tables b/c the query optimizer cannot accurately predict 
    -- the number of rows that qualify for "HAVING COUNT(*) = bm.cpu_memory_configurations_row_count". 

    SELECT bm.server_instance_name, bm.batch_time
    INTO #dac_statistics_consistent_batches
    FROM #batch_manifests_latest bm
    -- Note: No records in DAC table doesn't mean issue with upload -- a MI with no DACs is 
    -- perfectly valid; use an outer join so that we tolerate the no-DACs case.  
    LEFT JOIN [snapshots].[sysutility_ucp_dac_collected_execution_statistics_internal] ds 
        ON bm.server_instance_name = ds.server_instance_name AND bm.batch_time = ds.batch_time    
    GROUP BY bm.server_instance_name, bm.batch_time, bm.dac_packages_row_count, ds.batch_time    
    HAVING SUM(CASE WHEN ds.batch_time IS NULL THEN 0 ELSE 1 END) = bm.dac_packages_row_count

    SELECT bm.server_instance_name, bm.batch_time 
    INTO #cpu_memory_configurations_consistent_batches
    FROM #batch_manifests_latest bm
    INNER JOIN [snapshots].[sysutility_ucp_cpu_memory_configurations_internal] cm 
        ON bm.server_instance_name = cm.server_instance_name AND bm.batch_time = cm.batch_time   
    GROUP BY bm.server_instance_name, bm.batch_time, bm.cpu_memory_configurations_row_count
    HAVING COUNT(*) = bm.cpu_memory_configurations_row_count

    SELECT bm.server_instance_name, bm.batch_time 
    INTO #volumes_consistent_batches
    FROM #batch_manifests_latest bm
    INNER JOIN [snapshots].[sysutility_ucp_volumes_internal] vo 
        ON bm.server_instance_name = vo.server_instance_name AND bm.batch_time = vo.batch_time        
    GROUP BY bm.server_instance_name, bm.batch_time, bm.volumes_row_count
    HAVING COUNT(*) = bm.volumes_row_count

    SELECT bm.server_instance_name, bm.batch_time
    INTO #smo_properties_consistent_batches
    FROM #batch_manifests_latest bm
    INNER JOIN [snapshots].[sysutility_ucp_smo_properties_internal] sp 
        ON bm.server_instance_name = sp.server_instance_name AND bm.batch_time = sp.batch_time   
    GROUP BY bm.server_instance_name, bm.batch_time, bm.smo_properties_row_count
    HAVING COUNT(*) = bm.smo_properties_row_count


    -- Insert the new consistent batch information.  A consistent batch is a batch where all of 
    -- the live tables have the expected number of rows. 
    INSERT INTO [sysutility_ucp_staging].[consistent_batch_manifests_internal]
    SELECT bm.server_instance_name
        , bm.batch_time 
    FROM
    (
        -- Fetch the latest (order by DESC) consistent batches uploaded by the MI's
        SELECT ROW_NUMBER() OVER (PARTITION BY bm.server_instance_name ORDER BY bm.batch_time DESC) AS [rank]
            , bm.server_instance_name
            , bm.batch_time
        FROM #batch_manifests_latest AS bm
        INNER JOIN #dac_statistics_consistent_batches AS ds  
            ON bm.server_instance_name = ds.server_instance_name AND bm.batch_time = ds.batch_time    
        INNER JOIN #cpu_memory_configurations_consistent_batches AS cm  
            ON bm.server_instance_name = cm.server_instance_name AND bm.batch_time = cm.batch_time   
        INNER JOIN #volumes_consistent_batches AS vo 
            ON bm.server_instance_name = vo.server_instance_name AND bm.batch_time = vo.batch_time   
        INNER JOIN #smo_properties_consistent_batches AS sp 
            ON bm.server_instance_name = sp.server_instance_name AND bm.batch_time = sp.batch_time
    ) bm        
    WHERE bm.[rank] = 1;

END
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'STAGING', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_staging', 
   @level1type = 'PROCEDURE', @level1name = 'sp_get_consistent_batches';
GO

-- Note: There is another stored procedure in the sysutility_ucp_staging schema 
-- (sp_copy_live_table_data_into_cache_tables) that is created later in this script, 
-- because it depends on the schema of some objects in the sysutility_ucp_core schema. 



/***********************************************************************/
/* Utility SCHEMA: (sysutility_ucp_core)                               */
/* Dimension Tables and Views                                          */
/*                                                                     */
/*   We currently handle the following dimensions (and hence dimension */
/* tables).                                                            */
/*  Computers  (Table: computers_internal; view: latest_computers)     */
/*  Volumes    (Table: volumes_internal; view: latest_volumes)         */
/*  Instances  (Table: smo_servers_internal; view: latest_smo_servers) */
/*  Databases  (Table: databases_internal; view: latest_databases)     */
/*  FileGroups (Table: filegroups_internal; view: latest_filegroups)   */
/*  DataFiles  (Table: datafiles_internal; view: latest_datafiles)     */
/*  LogFiles   (Table: logfiles_internal; view: latest_logfiles)       */   
/*  Dacs       (Table: dacs_internal; view: latest_dacs)               */
/*                                                                     */
/* Every dimension table is clustered on its primary key. Each table   */
/* has processing_time as the prefix of its primary. This allows for   */
/* efficient queue-like behavior - inserts at the end, purges at the   */
/* beginning, and queries typically at the end.                        */
/*                                                                     */
/* Each of these dimension tables has a corresponding view that picks  */
/* the latest consistent information for that dimension. The latest    */
/* consistent information is determined by the value of the            */
/* "latest_processing_time" column in sysutility_ucp_processing_state   */
/* table in MSDB                                                       */
/***********************************************************************/

------------------------------------------------------------------------------------------------------------
-- Table dacs_internal
--    This is technically a dimension table for DACs. 
--      (For various logisical reasons, this also contains CPU utilization information for DACs.)
--    The key of this table is (processing_time, server_instance_name, dac_name). 
--       Machine_name is a regular column, but does not need to be part of the key (server_instance_name already
--       includes the appropriate information)
------------------------------------------------------------------------------------------------------------
IF (OBJECT_ID(N'[sysutility_ucp_core].[dacs_internal]', 'U') IS NULL)
BEGIN
   RAISERROR('Creating [sysutility_ucp_core].[dacs_internal] table', 0, 1)  WITH NOWAIT;
   CREATE TABLE [sysutility_ucp_core].[dacs_internal]
   (
      -- todo (VSTS #345036): This column will be removed
      [dac_id] INT IDENTITY,
      
      [server_instance_name] SYSNAME,  -- the server-qualified instance name
      [dac_name] SYSNAME,
      [urn] NVARCHAR(4000),
      [powershell_path] NVARCHAR(4000),

      [physical_server_name] SYSNAME,
      [dac_deploy_date] DATETIME,
      [dac_description] NVARCHAR(4000) NULL,

      -- todo (VSTS #345040)
      -- This is technically a "measure" column and should not be part of this dimension table   
      [dac_percent_total_cpu_utilization] REAL,
      
      [processing_time] DATETIMEOFFSET(7), 
      [batch_time] DATETIMEOFFSET(7),

      CONSTRAINT [PK_dacs_internal] 
        PRIMARY KEY CLUSTERED (processing_time, server_instance_name, dac_name)
   )

   EXEC sp_addextendedproperty 
      @name = 'MS_UtilityObjectType', @value = 'DIMENSION', 
      @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
      @level1type = 'TABLE', @level1name = 'dacs_internal';
END
GO

------------------------------------------------------------------------------
--  SQL Server View to read latest data for all DACs from cache table
--  NOTE: If you change the output of this view in any way, be sure to also update the 
--  corresponding "stub" object in instmsdb.sql. 
------------------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[latest_dacs]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_core].[latest_dacs] view', 0, 1)  WITH NOWAIT; 
   DROP VIEW [sysutility_ucp_core].[latest_dacs]
END
GO
RAISERROR('Creating [sysutility_ucp_core].[latest_dacs] view', 0, 1)  WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[latest_dacs]
AS
   SELECT 
      dac_id, 
      server_instance_name, 
      dac_name, 
      physical_server_name, 
      dac_deploy_date, 
      dac_description, 
      urn,
      powershell_path,
      processing_time,
      batch_time,
      dac_percent_total_cpu_utilization
      FROM [sysutility_ucp_core].[dacs_internal] S
      WHERE S.processing_time =  (SELECT latest_processing_time FROM [msdb].[dbo].[sysutility_ucp_processing_state_internal])
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'latest_dacs';
GO


-----------------------------------------------------------------------
--  
-- Dimension table: computers_internal. 
--    (For logistical reasons, also includes percent_total_cpu_consumption)
--   Key: (processing_time, physical_server_name)
--
-- NOTE: We use physical_server_name as part of the key rather than the 
--    (logical) virtual_server_name. This is to allow for scenarios with clustering
--    where we have two or more servers clustered together but with potentially
--    different configurations.
--
-----------------------------------------------------------------------
IF NOT EXISTS (SELECT name FROM sys.objects WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[computers_internal]'))
BEGIN
   RAISERROR('Creating table [sysutility_ucp_core].[computers_internal]', 0, 1)  WITH NOWAIT;
   CREATE TABLE [sysutility_ucp_core].[computers_internal]
   (
      -- todo (VSTS #345036): This column will be removed
      [id] INT IDENTITY, 
      
      virtual_server_name SYSNAME,
      physical_server_name SYSNAME,    -- differs from virtual_server_name for clustered servers
      is_clustered_server INT,
      
      num_processors INT,
      cpu_name NVARCHAR(128),
      cpu_caption NVARCHAR(128),
      cpu_family NVARCHAR(128),
      cpu_architecture NVARCHAR(64),
      cpu_max_clock_speed DECIMAL(10),
      cpu_clock_speed DECIMAL(10),
      l2_cache_size DECIMAL(10),
      l3_cache_size DECIMAL(10),
     
      -- todo (VSTS #345040)
      -- This is technically a "measure" column and should not be part of this dimension table   
      percent_total_cpu_utilization REAL,
      
      urn NVARCHAR(4000),
      powershell_path NVARCHAR(4000),
      
      processing_time DATETIMEOFFSET(7),
      batch_time DATETIMEOFFSET(7),
      
      CONSTRAINT [PK_computers_internal] 
        PRIMARY KEY CLUSTERED (processing_time, physical_server_name)
   )

   EXEC sp_addextendedproperty 
      @name = 'MS_UtilityObjectType', @value = 'DIMENSION', 
      @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
      @level1type = 'TABLE', @level1name = 'computers_internal';
END
GO

-----------------------------------------------------------------------
-- View to select latest data from [computers_internal] dimension table.
--  NOTE: If you change the shape of this view in any way, be sure to also 
--  update the corresponding "stub" object in instmsdb.sql. 
-----------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[latest_computers]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_core].[latest_computers] view', 0, 1)  WITH NOWAIT; 
   DROP VIEW [sysutility_ucp_core].[latest_computers]
END
GO
RAISERROR('Creating view [sysutility_ucp_core].[latest_computers]', 0, 1)  WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[latest_computers] AS 
  SELECT [id], 
         virtual_server_name, 
         physical_server_name, 
         is_clustered_server,
         num_processors, 
         cpu_name, 
         cpu_caption, 
         cpu_family, 
         cpu_architecture, 
         cpu_max_clock_speed, 
         cpu_clock_speed, 
         l2_cache_size, 
         l3_cache_size, 
         urn,
         powershell_path,
         processing_time,
         batch_time,
         percent_total_cpu_utilization
  FROM [sysutility_ucp_core].[computers_internal]
  WHERE processing_time = (SELECT latest_processing_time FROM [msdb].[dbo].[sysutility_ucp_processing_state_internal]);
GO 

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'latest_computers';
GO


-----------------------------------------------------------------------
-- Dimension table: volumes_internal
--   - PK (processing_time, physical_server_name, volume_name)
--   - also includes physical_server_name 
--
--   - Includes "measure" columns (total_space_available, free_space)
-- Created cache table [sysutility_ucp_core].[volumes_internal] for storage view. 
-----------------------------------------------------------------------
IF NOT EXISTS (SELECT name FROM sys.objects WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[volumes_internal]') )
BEGIN
  RAISERROR('Creating table [sysutility_ucp_core].[volumes_internal]', 0, 1)  WITH NOWAIT;
  CREATE TABLE [sysutility_ucp_core].[volumes_internal]
  (
     -- todo (VSTS #345036): This column will be removed
     [ID] INT IDENTITY, 
   
     virtual_server_name SYSNAME,
     physical_server_name SYSNAME,
   
     volume_device_id SYSNAME,
     volume_name NVARCHAR(260),

     -- todo (VSTS #345040)
     -- These are technically "measure" columns and should not be part of this dimension table
     total_space_available real,  -- in MB
     free_space  real,  -- in MB

     processing_time DATETIMEOFFSET(7),
     batch_time DATETIMEOFFSET(7),
     powershell_path NVARCHAR(4000) NULL,
   
     CONSTRAINT pk_volumes_internal 
       PRIMARY KEY CLUSTERED(processing_time, physical_server_name, volume_device_id)
  )

   EXEC sp_addextendedproperty 
      @name = 'MS_UtilityObjectType', @value = 'DIMENSION', 
      @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
      @level1type = 'TABLE', @level1name = 'volumes_internal';
END
GO

-- If we are upgrading a SQL 2008 R2 MDW database, add the powershell_path column to volumes_internal for 
-- performance reasons (this column was not in the table in SQL Server 2008 R2).  See changelists 1844247 
-- and 1797832 for background. 
IF NOT EXISTS (SELECT * FROM sys.columns WHERE name = 'powershell_path' AND object_id = OBJECT_ID('sysutility_ucp_core.volumes_internal'))
BEGIN
    RAISERROR('Adding powershell_path column to [sysutility_ucp_core].[volumes_internal]', 0, 1) WITH NOWAIT;
    ALTER TABLE sysutility_ucp_core.volumes_internal ADD powershell_path NVARCHAR(4000) NULL;
END;
GO

------------------------------------------------------------------------------
--  SQL Server View to read latest information for volumes
--  NOTE: If you change the output of this view in any way, be sure to also update the 
--  corresponding "stub" object in instmsdb.sql. 
------------------------------------------------------------------------------
IF EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[latest_volumes]'))
BEGIN
   RAISERROR('Dropping view [sysutility_ucp_core].[latest_volumes]', 0, 1)  WITH NOWAIT;
   DROP VIEW [sysutility_ucp_core].[latest_volumes]
END
GO
 
RAISERROR('Creating view [sysutility_ucp_core].[latest_volumes]', 0, 1)  WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[latest_volumes]
   AS
   SELECT [ID], 
          [virtual_server_name], 
          [physical_server_name], 
          [volume_device_id], 
          [volume_name], 
          [powershell_path],
          [processing_time],
          [batch_time], 
          [total_space_available], 
          (total_space_available - free_space) AS [total_space_utilized], 
          (CASE WHEN total_space_available = 0 THEN 0 ELSE (100 * (total_space_available - free_space))/total_space_available END) AS  [percent_total_space_utilization]
   FROM [sysutility_ucp_core].[volumes_internal]
   WHERE processing_time = (SELECT latest_processing_time FROM [msdb].[dbo].[sysutility_ucp_processing_state_internal])
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'latest_volumes';
GO

         
-- =============================================
-- Dimension Table for SQL Server Instances
-- Table: smo_servers_internal
-- Key: processing_time, server_instance_name
-- =============================================
IF(OBJECT_ID(N'[sysutility_ucp_core].[smo_servers_internal]', 'U') IS NULL)
BEGIN
    RAISERROR ('Creating table [sysutility_ucp_core].[smo_servers_internal]', 0, 1) WITH NOWAIT;
    CREATE TABLE [sysutility_ucp_core].[smo_servers_internal]
    (
        [urn] NVARCHAR(320) 
        , [powershell_path]  NVARCHAR(4000)
        , [processing_time] DATETIMEOFFSET(7)
        , [batch_time] DATETIMEOFFSET(7)

        -- SMO properties
        , [AuditLevel] SMALLINT 
        , [BackupDirectory] NVARCHAR(260) 
        , [BrowserServiceAccount] NVARCHAR(128) 
        , [BrowserStartMode] SMALLINT 
        , [BuildClrVersionString] NVARCHAR(20) 
        , [BuildNumber] INT 
        , [Collation] NVARCHAR(128) 
        , [CollationID] INT 
        , [ComparisonStyle] INT 
        , [ComputerNamePhysicalNetBIOS] NVARCHAR(128) 
        , [DefaultFile] NVARCHAR(260) 
        , [DefaultLog] NVARCHAR(260) 
        , [Edition] NVARCHAR(64) 
        , [EngineEdition] SMALLINT 
        , [ErrorLogPath] NVARCHAR(260) 
        , [FilestreamShareName] NVARCHAR(260) 
        , [InstallDataDirectory] NVARCHAR(260) 
        , [InstallSharedDirectory] NVARCHAR(260) 
        , [InstanceName] NVARCHAR(128) 
        , [IsCaseSensitive] BIT 
        , [IsClustered] BIT 
        , [IsFullTextInstalled] BIT 
        , [IsSingleUser] BIT 
        , [Language] NVARCHAR(64) 
        , [MailProfile] NVARCHAR(128) 
        , [MasterDBLogPath] NVARCHAR(260) 
        , [MasterDBPath] NVARCHAR(260) 
        , [MaxPrecision] TINYINT 
        , [Name] NVARCHAR(128)        -- This is SERVERPROPERTY('ServerName')
        , [NamedPipesEnabled] BIT 
        , [NetName] NVARCHAR(128)     -- This is SERVERPROPERTY('MachineName')
        , [NumberOfLogFiles] INT 
        , [OSVersion] NVARCHAR(32) 
        , [PerfMonMode] SMALLINT 
        , [PhysicalMemory] INT 
        , [Platform] NVARCHAR(32) 
        , [Processors] SMALLINT 
        , [ProcessorUsage] INT 
        , [Product] NVARCHAR(48) 
        , [ProductLevel] NVARCHAR(32) 
        , [ResourceVersionString] NVARCHAR(32) 
        , [RootDirectory] NVARCHAR(260) 
        , [ServerType] SMALLINT 
        , [ServiceAccount] NVARCHAR(128) 
        , [ServiceInstanceId] NVARCHAR(64) 
        , [ServiceName] NVARCHAR(64) 
        , [ServiceStartMode] SMALLINT 
        , [SqlCharSet] SMALLINT 
        , [SqlCharSetName] NVARCHAR(32) 
        , [SqlDomainGroup] NVARCHAR(260) 
        , [SqlSortOrder] SMALLINT 
        , [SqlSortOrderName] NVARCHAR(64) 
        , [Status] SMALLINT 
        , [TapeLoadWaitTime] INT 
        , [TcpEnabled] BIT 
        , [VersionMajor] INT 
        , [VersionMinor] INT 
        , [VersionString] NVARCHAR(32)
       CONSTRAINT [PK_smo_servers_internal] 
         PRIMARY KEY CLUSTERED (processing_time, [Name])
         -- NOTE: compression is enabled on this table at runtime (during Create UCP) in sp_initialize_mdw_internal
    );
    
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'DIMENSION', 
        @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
        @level1type = 'TABLE', @level1name = 'smo_servers_internal';
END
GO

-- =====================================================================
-- Dimension Table for databases in a SQL Instance
-- Table: databases_internal
-- Key: processing_time, server_instance_name, name
-- =====================================================================

IF(OBJECT_ID(N'[sysutility_ucp_core].[databases_internal]', 'U') IS NULL)
BEGIN
    RAISERROR ('Creating table [sysutility_ucp_core].[databases_internal]', 0, 1) WITH NOWAIT;
    CREATE TABLE [sysutility_ucp_core].[databases_internal]
    (
        [urn] NVARCHAR(512)
        , [powershell_path]  NVARCHAR(MAX)
        , [processing_time] DATETIMEOFFSET(7)
        , [batch_time] DATETIMEOFFSET(7)
        , [server_instance_name]    SYSNAME
        , [parent_urn] NVARCHAR(320)
        , [Collation] NVARCHAR(128)
        , [CompatibilityLevel] SMALLINT
        , [CreateDate] DATETIME
        , [EncryptionEnabled] BIT
        , [Name] SYSNAME
        , [RecoveryModel] SMALLINT
        , [Trustworthy]    BIT       
        , [state] TINYINT NULL
       CONSTRAINT [PK_databases_internal] 
          PRIMARY KEY CLUSTERED (processing_time, server_instance_name, [Name]) 
          -- Note: compression is enabled on this table at runtime (during Create UCP) in sp_initialize_mdw_internal
    );
    
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'DIMENSION', 
        @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
        @level1type = 'TABLE', @level1name = 'databases_internal';
END
GO

-- If we are upgrading a SQL 2008 R2 MDW database, add the state column to databases_internal. This column allows 
-- better handling of unavailable databases (offline, emergency mode, recovering, etc).  See changelist 1856917
-- and VSTS 624995 for background. 
IF NOT EXISTS (
    SELECT * 
    FROM sys.columns 
    WHERE name = 'state' AND object_id = OBJECT_ID('sysutility_ucp_core.databases_internal'))
BEGIN
    RAISERROR('Adding state column to [sysutility_ucp_core].[databases_internal]', 0, 1) WITH NOWAIT;
    ALTER TABLE sysutility_ucp_core.databases_internal ADD state TINYINT NULL;
END;
GO

-- Constrain the values allowed in the state column. 
IF NOT EXISTS (
    SELECT * 
    FROM sys.check_constraints 
    WHERE name = 'chk_databases_internal_state' AND parent_object_id = OBJECT_ID('sysutility_ucp_core.databases_internal'))
BEGIN
    -- Current defined states are 0 (available) and 1 (not available -- emergency mode, offline, etc)
    ALTER TABLE sysutility_ucp_core.databases_internal
    ADD CONSTRAINT chk_databases_internal_state CHECK ([state] BETWEEN 0 AND 1);
END;
GO


-- =====================================================================
-- Dimension Table for filegroups in a database (in a SQL Instance)
-- Table: filegroups_internal
-- Key: processing_time, server_instance_name, database_name, name
-- =====================================================================
IF(OBJECT_ID(N'[sysutility_ucp_core].[filegroups_internal]', 'U') IS NULL)
BEGIN
    RAISERROR ('Creating table [sysutility_ucp_core].[filegroups_internal]', 0, 1) WITH NOWAIT;
    CREATE TABLE [sysutility_ucp_core].[filegroups_internal]
    (
        [urn] NVARCHAR(780)
        , [powershell_path]  NVARCHAR(MAX)
        , [processing_time] DATETIMEOFFSET(7)
        , [batch_time] DATETIMEOFFSET(7)
        , [server_instance_name]    SYSNAME
        , [database_name] SYSNAME
        , [parent_urn] NVARCHAR(512)
                
        -- SMO Properties
        , [Name] SYSNAME
        
        , CONSTRAINT PK_filegroups_internal
            PRIMARY KEY CLUSTERED(processing_time, server_instance_name, database_name, [Name])
        -- Note: compression is enabled on this table at runtime (during Create UCP) in sp_initialize_mdw_internal
    );    
    
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'DIMENSION', 
        @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
        @level1type = 'TABLE', @level1name = 'filegroups_internal';
END
GO

-- =====================================================================
-- Dimension Table for datafiles in a database (in a SQL Instance)
-- Table: datafiles_internal
-- Key: processing_time, server_instance_name, database_name, filegroup_name, name
--
-- VSTS #345570: The key length of the clustered index may be larger than 900 bytes.
-- 
-- ===================================================================== 
IF(OBJECT_ID(N'[sysutility_ucp_core].[datafiles_internal]', 'U') IS NULL)
BEGIN
    RAISERROR ('Creating table [sysutility_ucp_core].[datafiles_internal]', 0, 1) WITH NOWAIT;
    CREATE TABLE [sysutility_ucp_core].[datafiles_internal]
    (
        [urn] NVARCHAR(1500)
        , [powershell_path]  NVARCHAR(MAX)
        , [processing_time] DATETIMEOFFSET(7)
        , [batch_time] DATETIMEOFFSET(7)
        , [server_instance_name]    SYSNAME
        , [database_name] SYSNAME
        , [filegroup_name] SYSNAME
        , [parent_urn] NVARCHAR(780)
        , [physical_server_name] SYSNAME

        , [volume_name] NVARCHAR(260)
        , [volume_device_id] SYSNAME
        
        -- SMO Properties  
        , [Growth]  REAL
        , [GrowthType] SMALLINT
        , [MaxSize]  REAL
        , [Name] SYSNAME
        , [Size] REAL
        , [UsedSpace]  REAL
        , [FileName] NVARCHAR(260)
        , [VolumeFreeSpace] BIGINT
        
        , CONSTRAINT PK_datafiles_internal
            PRIMARY KEY CLUSTERED (processing_time, server_instance_name, database_name, [filegroup_name], [Name])
        -- Note: compression is enabled on this table at runtime (during Create UCP) in sp_initialize_mdw_internal
     );
     
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'DIMENSION', 
        @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
        @level1type = 'TABLE', @level1name = 'datafiles_internal';
END
GO

-- =====================================================================
-- Dimension Table for logfiles in a database (in a SQL Instance)
-- Table: logfiles_internal
-- Key: processing_time, server_instance_name, database_name, name
-- ===================================================================== 
IF(OBJECT_ID(N'[sysutility_ucp_core].[logfiles_internal]', 'U') IS NULL)
BEGIN
    RAISERROR ('Creating table [sysutility_ucp_core].[logfiles_internal]', 0, 1) WITH NOWAIT;
    CREATE TABLE [sysutility_ucp_core].[logfiles_internal]
    (
        [urn] NVARCHAR(1500)
        , [powershell_path]  NVARCHAR(MAX)
        , [processing_time] DATETIMEOFFSET(7)
        , [batch_time] DATETIMEOFFSET(7)
        , [server_instance_name]    SYSNAME
        , [database_name]    SYSNAME
        , [parent_urn] NVARCHAR(780)
        , [physical_server_name] SYSNAME

        , [volume_name] NVARCHAR(260) 
        , [volume_device_id] SYSNAME

      -- SMO Properties
        , [Growth]  REAL
        , [GrowthType] SMALLINT
        , [MaxSize]  REAL
        , [Name] SYSNAME
        , [Size] REAL
        , [UsedSpace]  REAL
        , [FileName] NVARCHAR(260)
        , [VolumeFreeSpace] BIGINT
        
        
        , CONSTRAINT PK_logfiles_internal
            PRIMARY KEY CLUSTERED (processing_time, server_instance_name, database_name, [Name])
        -- Note: compression is enabled on this table at runtime (during Create UCP) in sp_initialize_mdw_internal
    );
    
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'DIMENSION', 
        @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
        @level1type = 'TABLE', @level1name = 'logfiles_internal';
END
GO

-----------------------------------------------------------------------------
--  The view which returns server properties
--  NOTE: If you change the output of this view in any way, be sure to also update the 
--  corresponding "stub" object in instmsdb.sql. 
-----------------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[latest_smo_servers]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_core].[latest_smo_servers] view', 0, 1) WITH NOWAIT;
   DROP VIEW [sysutility_ucp_core].[latest_smo_servers]
END
GO

RAISERROR('Creating [sysutility_ucp_core].[latest_smo_servers] view', 0, 1) WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[latest_smo_servers]
AS

SELECT urn
, [powershell_path]
, [processing_time]
, [batch_time]
, [AuditLevel]
, [BackupDirectory]
, [BrowserServiceAccount]
, [BrowserStartMode]
, [BuildClrVersionString]
, [BuildNumber]
, [Collation]
, [CollationID]
, [ComparisonStyle]
, [ComputerNamePhysicalNetBIOS]
, [DefaultFile]
, [DefaultLog]
, [Edition]
, [EngineEdition]
, [ErrorLogPath]
, [FilestreamShareName]
, [InstallDataDirectory]
, [InstallSharedDirectory]
, [InstanceName]
, [IsCaseSensitive]
, [IsClustered]
, [IsFullTextInstalled]
, [IsSingleUser]
, [Language]
, [MailProfile]
, [MasterDBLogPath]
, [MasterDBPath]
, [MaxPrecision]
, [Name]
, [NamedPipesEnabled]
, [NetName]
, [NumberOfLogFiles]
, [OSVersion]
, [PerfMonMode]
, [PhysicalMemory]
, [Platform]
, [Processors]
, [ProcessorUsage]
, [Product]
, [ProductLevel]
, [ResourceVersionString]
, [RootDirectory]
, [ServerType]
, [ServiceAccount]
, [ServiceInstanceId]
, [ServiceName]
, [ServiceStartMode]
, [SqlCharSet]
, [SqlCharSetName]
, [SqlDomainGroup]
, [SqlSortOrder]
, [SqlSortOrderName]
, [Status]
, [TapeLoadWaitTime]
, [TcpEnabled]
, [VersionMajor]
, [VersionMinor]
, [VersionString]
FROM [sysutility_ucp_core].[smo_servers_internal] AS SI
WHERE SI.processing_time =  (SELECT latest_processing_time FROM [msdb].[dbo].[sysutility_ucp_processing_state_internal])
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'latest_smo_servers';
GO


------------------------------------------------------------------------------
--  SQL Server View to read latest snapshot data for SMO Database object
--  NOTE: If you change the output of this view in any way, be sure to also update the 
--  corresponding "stub" object in instmsdb.sql. 
------------------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[latest_databases]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_core].[latest_databases] view', 0, 1) WITH NOWAIT;
   DROP VIEW [sysutility_ucp_core].[latest_databases]
END
GO

RAISERROR('Creating [sysutility_ucp_core].[latest_databases] view', 0, 1) WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[latest_databases]
AS
    SELECT [urn]
        , [powershell_path]
        , [processing_time]
        , [batch_time]
        , [server_instance_name]
        , [parent_urn]
        , [Collation]
        , [CompatibilityLevel]
        , [CreateDate]
        , [EncryptionEnabled]
        , [Name]
        , [RecoveryModel]
        , [Trustworthy]  
        , [state]
        FROM [sysutility_ucp_core].[databases_internal] AS SI
        WHERE SI.processing_time =  (SELECT latest_processing_time FROM [msdb].[dbo].[sysutility_ucp_processing_state_internal])
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'latest_databases';
GO


------------------------------------------------------------------------------
--  SQL Server View to read latest snapshot data for SMO FileGroup object
--  NOTE: If you change the output of this view in any way, be sure to also update the 
--  corresponding "stub" object in instmsdb.sql. 
------------------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[latest_filegroups]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_core].[latest_filegroups] view', 0, 1) WITH NOWAIT;
   DROP VIEW [sysutility_ucp_core].[latest_filegroups]
END
GO

RAISERROR('Creating [sysutility_ucp_core].[latest_filegroups] view', 0, 1) WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[latest_filegroups]
AS
    SELECT [urn]
        , [powershell_path]
        , [processing_time]
        , [batch_time]
        , [server_instance_name]
        , [database_name]
        , [parent_urn]
        , [Name]
        FROM [sysutility_ucp_core].[filegroups_internal] AS SI
        WHERE SI.processing_time =  (SELECT latest_processing_time FROM [msdb].[dbo].[sysutility_ucp_processing_state_internal])
            -- Suppress for "not available" databases (state=1). We lack full filegroup/file hierarchy metadata for these databases. 
            AND EXISTS (
                SELECT * FROM sysutility_ucp_core.latest_databases AS db 
                WHERE db.server_instance_name = SI.server_instance_name AND db.Name = SI.database_name AND db.state = 0)
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'latest_filegroups';
GO


------------------------------------------------------------------------------
--  SQL Server View to read latest snapshot data for SMO DataFile object
--  NOTE: If you change the output of this view in any way, be sure to also update the 
--  corresponding "stub" object in instmsdb.sql. 
------------------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[latest_datafiles]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_core].[latest_datafiles] view', 0, 1) WITH NOWAIT;
   DROP VIEW [sysutility_ucp_core].[latest_datafiles]
END
GO

RAISERROR('Creating [sysutility_ucp_core].[latest_datafiles] view', 0, 1) WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[latest_datafiles]
AS
 SELECT [urn]
        , [powershell_path]
        , [processing_time]
        , [batch_time]
        , [server_instance_name]
        , [database_name] 
        , [filegroup_name]
        , [parent_urn]
        , [physical_server_name]
        , [volume_name]
        , [volume_device_id]
        , [Growth] 
        , [GrowthType]
        , [MaxSize] 
        , [Name]
        , [Size]
        , [UsedSpace] 
        , [FileName]
        , [VolumeFreeSpace]
        , [sysutility_ucp_misc].[fn_get_max_size_available]([Size], [MaxSize], [Growth], [GrowthType], [VolumeFreeSpace]) AS [available_space]
        FROM [sysutility_ucp_core].[datafiles_internal] AS SI
        WHERE SI.processing_time =  (SELECT latest_processing_time FROM [msdb].[dbo].[sysutility_ucp_processing_state_internal])
            -- Suppress for "not available" databases (state=1). We lack full filegroup/file hierarchy metadata for these databases. 
            AND EXISTS (
                SELECT * FROM sysutility_ucp_core.latest_databases AS db 
                WHERE db.server_instance_name = SI.server_instance_name AND db.Name = SI.database_name AND db.state = 0)
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'latest_datafiles';
GO


------------------------------------------------------------------------------
--  SQL Server View to read latest snapshot data for SMO DataFile object
--  NOTE: If you change the output of this view in any way, be sure to also update the 
--  corresponding "stub" object in instmsdb.sql. 
------------------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[latest_logfiles]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_core].[latest_logfiles] view', 0, 1) WITH NOWAIT;
   DROP VIEW [sysutility_ucp_core].[latest_logfiles]
END
GO

RAISERROR('Creating [sysutility_ucp_core].[latest_logfiles] view', 0, 1) WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[latest_logfiles]
AS
 SELECT [urn]
        , [powershell_path]
        , [processing_time]
        , [batch_time]
        , [server_instance_name]
        , [database_name] 
        , [parent_urn]
        , [physical_server_name]
        , [volume_name]
        , [volume_device_id]
        , [Growth] 
        , [GrowthType]
        , [MaxSize] 
        , [Name]
        , [Size]
        , [UsedSpace] 
        , [FileName]
        , [VolumeFreeSpace]
        , [sysutility_ucp_misc].[fn_get_max_size_available]([Size], [MaxSize], [Growth], [GrowthType], [VolumeFreeSpace]) AS [available_space]
        FROM [sysutility_ucp_core].[logfiles_internal] AS SI
        WHERE SI.processing_time =  (SELECT latest_processing_time FROM [msdb].[dbo].[sysutility_ucp_processing_state_internal])
            -- Suppress for "not available" databases (state=1). We lack full filegroup/file hierarchy metadata for these databases. 
            AND EXISTS (
                SELECT * FROM sysutility_ucp_core.latest_databases AS db 
                WHERE db.server_instance_name = SI.server_instance_name AND db.Name = SI.database_name AND db.state = 0)
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'latest_logfiles';
GO


/***********************************************************************/
/* Utility SCHEMA: (sysutility_ucp_core)                               */
/* Measure Tables and Views                                            */
/*                                                                     */
/*   We currently handle the following measures (and hence measure     */
/* tables).                                                            */
/*   CPU           (Table: cpu_utilization_internal)                   */
/*   Storage Space (Table: space_utilization_internal)                 */
/*                                                                     */
/* CPU information is stored for the following dimensions              */
/*   - Computers                                                       */
/*   - Instances                                                       */
/*   - Dacs                                                            */
/*                                                                     */
/* Storage space information is stored for the following dimensions    */
/*   - Computers                                                       */
/*   - Volumes                                                         */
/*   - Instances                                                       */
/*   - Databases                                                       */
/*   - FileGroups                                                      */
/*   - DataFiles                                                       */
/*   - LogFiles                                                        */
/*                                                                     */
/* Each measure table stores information at different levels of        */
/* aggregation. Currently, we support 3 levels of aggregation          */
/*   - No aggregation (i.e.) latest "detail" information               */
/*   - Hourly                                                          */
/*   - Daily                                                           */
/* We expect to add additional aggregation levels in the future        */
/*                                                                     */
/* Information for each aggregation level is stored in a different     */
/* partition of the measure table. This allows us to leverage          */
/* partition pruning (for queries), and different maintenance operations */
/* for each partition (especially wrt purging of data.                 */
/*                                                                     */
/* Within each partition, (processing_time, object_type) */
/* is the prefix of the key. This allows for inserts at the end, and   */
/* purges at the front for new data. It also ensures that information  */
/* about each object type is collocated within a given collection time */
/*                                                                     */
/***********************************************************************/
---
-- Describes the aggregation level
-- 0 = Non-aggregated; 1 = Hourly, 2 = Daily, ...
--
IF NOT EXISTS(SELECT 0 FROM sys.types t 
              WHERE t.name = N'AggregationType' AND t.schema_id = SCHEMA_ID(N'sysutility_ucp_core'))
BEGIN
  RAISERROR ('Creating type [sysutility_ucp_core].[AggregationType]', 0, 1) WITH NOWAIT;
  CREATE TYPE [sysutility_ucp_core].[AggregationType] FROM TINYINT
END
GO

-- 0 = utility
-- 1 = computer
-- 2 = volume
-- 3 = instance
-- 4 = database (also dac)
-- 5 = filegroup
-- 6 = datafile
-- 7 = logfile
IF NOT EXISTS(SELECT 0 FROM sys.types t 
              WHERE t.name = N'ObjectType' AND t.[schema_id] = SCHEMA_ID(N'sysutility_ucp_core')) 
BEGIN
  RAISERROR ('Creating type [sysutility_ucp_core].[ObjectType]', 0, 1) WITH NOWAIT;
  CREATE TYPE [sysutility_ucp_core].[ObjectType] FROM TINYINT
END
GO


-- ============================================================================
-- Measure Table: CPU Utilization information
--   Supported dimensions: Computers, Instances, Databases (DACs)
--   Supported aggregation-levels: none, hourly, daily
--
-- The object_type field describes the dimension that the current entry (row) 
-- defines. 
-- The following conditions must hold.
--   If object_type = 1, server_instance_name = NULL and database_name = NULL and physical_server_name <> NULL
--   If object type = 3, physical_server_name = NULL, database_name = NULL, server_instance_name <> NULL
--   If object_type = 4, physical_server_name = NULL, server_instance_name <> NULL, database_name <> NULL
--   No other legal combinations
-- ============================================================================
IF(OBJECT_ID(N'[sysutility_ucp_core].[cpu_utilization_internal]', N'U') IS NULL)
BEGIN
    RAISERROR ('Creating table [sysutility_ucp_core].[cpu_utilization_internal]', 0, 1) WITH NOWAIT;
    
    CREATE TABLE [sysutility_ucp_core].[cpu_utilization_internal]
    (
       [processing_time]  DATETIMEOFFSET(7) NOT NULL,
       [aggregation_type] [sysutility_ucp_core].AggregationType NOT NULL,
       [object_type]      [sysutility_ucp_core].ObjectType NOT NULL, 
       
       -- Dimension keys
       [physical_server_name] SYSNAME DEFAULT N'',
       [server_instance_name] SYSNAME DEFAULT N'',
       [database_name]        SYSNAME DEFAULT N'',
      
       -- The actual measure columns.
       percent_total_cpu_utilization REAL,
        
       -- NOTE: This index is redefined at runtime (during Create UCP) in sp_initialize_mdw_internal              
       CONSTRAINT pk_cpu_utilization_internal 
         PRIMARY KEY CLUSTERED(aggregation_type, processing_time, object_type, 
                               physical_server_name, server_instance_name, database_name) 
    )
    
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'MEASURE', 
        @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
        @level1type = 'TABLE', @level1name = 'cpu_utilization_internal';
END
GO

---------------------------------------------------------------------------
-- View to select information from the [cpu_utilization_internal] measure
-- table.
--  NOTE: If you change the shape of this view in any way, be sure to also 
--  update the corresponding "stub" object in instmsdb.sql. 
-----------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[cpu_utilization]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_core].[cpu_utilization] view', 0, 1)  WITH NOWAIT; 
   DROP VIEW [sysutility_ucp_core].[cpu_utilization]
END
GO
RAISERROR('Creating [sysutility_ucp_core].[cpu_utilization] view', 0, 1) WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[cpu_utilization]
AS
  SELECT aggregation_type, processing_time, object_type,
         physical_server_name, server_instance_name, database_name,
         percent_total_cpu_utilization
  FROM [sysutility_ucp_core].[cpu_utilization_internal]
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'cpu_utilization';
GO


-- ============================================================================
-- Measure Table: Space Utilization information
--   Supported dimensions: Computers, Volumes, Instances, Databases, 
--                         Filegroups, DataFiles, LogFiles
--   Supported aggregation-levels: none, hourly, daily
--
-- The object_type field describes the dimension that the current entry (row) 
-- defines. 
-- The following conditions must hold.
--    Utility  (type=0), all dimension columns must be ''
--    Computer (type=1), virtual_server_name must be non-null; the rest must be ''
--    Volume   (type=2), virtual_server_name, volume_device_id must be non-null; rest ''
--    Instance (type=3), server_instance_name must be non-NULL, everything else must be ''
--    Database (type=4), server_instance_name, database_name must be non-null
--                          other keys must be ''
--    FileGroup(type=5), server_instance_name, datbase_name, filegroup_name must be non-NULL
--                          other keys must be ''
--    DataFile (type=6), server_instance_name, database_name, filegroup_name, dbfile_name 
--                       must be non-null. Other keys must be ''
--    LogFile  (type=7), server_instance_name, database_name, dbfile_name must be non-null
--                          other keys must be ''
--
-- IMPORTANT: Unlike the cpu_utilization measure table, the space_utilization measure
--   table uses virtual_server_name to represent a computer (and volume). This is
--   because storage is shared (potentially) across a failover-cluster-instance,
--   and we want to track history of the space usage regardless of the specific 
--   current "owner" of the storage
--
-- The space_utilization_internal table stores information about two distinct hierarchies.
-- The Utility->Computer->Volume hierarchy and the Instance->Database->FileGroup->File 
-- hiererachy. A row in the table is part of only one of these hierarchies.
--
-- There are 4 distinct measure columns we maintain in this table. Not all of them are
-- really need. See VSTS #345039
--   total_space_bytes    : the maximum amount of storage available
--   allocated_space_bytes: the currently allocated amount of storage. Typically, the
--                          same as total_space_bytes, except for files
--   used_space_bytes     : the current used up space
--   available_space_bytes: the amount of space that's available for further use. 
--                          Typically this is total_space_bytes - used_space_bytes. 
--                          Except for files, where this is more complicated
--  
-- We should be able to live with just two of these columns (total_space and used_space)
--
-- For the instance-database-... hierarchy, only used_space_bytes is rolled up. All
-- the other values are rolled up to NULL
-- For the Utility-computer-volume hierarchy, all values are rolled up.
--  
--                          
-- 
-- VSTS #345570: The key length of the clustered index may be larger than 900 bytes.
--
-- ============================================================================
IF(OBJECT_ID(N'[sysutility_ucp_core].[space_utilization_internal]', N'U') IS NULL)
BEGIN
    RAISERROR ('Creating table [sysutility_ucp_core].[space_utilization_internal]', 0, 1) WITH NOWAIT;
    CREATE TABLE [sysutility_ucp_core].[space_utilization_internal]
    (
       [processing_time] DATETIMEOFFSET(7) NOT NULL,
       [aggregation_type] [sysutility_ucp_core].AggregationType NOT NULL,
       [object_type]      [sysutility_ucp_core].ObjectType NOT NULL, 
          
       -- The dimension columns
       [virtual_server_name]  SYSNAME DEFAULT N'',
       [server_instance_name] SYSNAME DEFAULT N'',
       [volume_device_id]     SYSNAME DEFAULT N'',
       [database_name]        SYSNAME DEFAULT N'',
       [filegroup_name]       SYSNAME DEFAULT N'',
       [dbfile_name]          SYSNAME DEFAULT N'',
       
       -- todo (VSTS #345039)
       -- we don't need all 4 of the columns below. We only need used_space and available_space
       [used_space_bytes]        REAL,
       [allocated_space_bytes]   REAL,
       [total_space_bytes]       REAL,
       [available_space_bytes]   REAL,

       -- NOTE: This index is redefined at runtime (during Create UCP) in sp_initialize_mdw_internal              
       CONSTRAINT pk_storage_utilization 
         PRIMARY KEY CLUSTERED(
            aggregation_type,
            processing_time, 
            object_type, 
            virtual_server_name, 
            volume_device_id, 
            server_instance_name, 
            database_name, 
            [filegroup_name], 
            dbfile_name) 
    )
    
    EXEC sp_addextendedproperty 
        @name = 'MS_UtilityObjectType', @value = 'MEASURE', 
        @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
        @level1type = 'TABLE', @level1name = 'space_utilization_internal';
END
GO

---------------------------------------------------------------------------
-- View to select information from the [space_utilization_internal] measure
-- table.
--  NOTE: If you change the shape of this view in any way, be sure to also 
--  update the corresponding "stub" object in instmsdb.sql. 
-----------------------------------------------------------------------
IF  EXISTS (SELECT name FROM sys.views WHERE object_id = OBJECT_ID(N'[sysutility_ucp_core].[space_utilization]'))
BEGIN
   RAISERROR('Dropping [sysutility_ucp_core].[space_utilization] view', 0, 1)  WITH NOWAIT; 
   DROP VIEW [sysutility_ucp_core].[space_utilization]
END
GO

RAISERROR('Creating [sysutility_ucp_core].[space_utilization] view', 0, 1) WITH NOWAIT;
GO
CREATE VIEW [sysutility_ucp_core].[space_utilization]
AS
  SELECT aggregation_type, 
         processing_time, 
         object_type,
         virtual_server_name, 
         volume_device_id, 
         server_instance_name, 
         database_name, 
         [filegroup_name], 
         dbfile_name,
         total_space_bytes, 
         allocated_space_bytes, 
         used_space_bytes, 
         available_space_bytes
  FROM [sysutility_ucp_core].[space_utilization_internal]
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'VIEW', @level1name = 'space_utilization';
GO


-----------------------------------------------------------------------------------------
-- Procedure sp_copy_live_table_data_into_cache_tables
--   Copies the latest snapshot of data from the "live" tables into the "cache" tables 
-----------------------------------------------------------------------------------------
IF OBJECT_ID ('sysutility_ucp_staging.sp_copy_live_table_data_into_cache_tables') IS NOT NULL
BEGIN
   RAISERROR('Dropping procedure sysutility_ucp_staging.sp_copy_live_table_data_into_cache_tables procedure', 0, 1) WITH NOWAIT;
   DROP PROCEDURE sysutility_ucp_staging.sp_copy_live_table_data_into_cache_tables;
END
GO
RAISERROR('Creating procedure sysutility_ucp_staging.sp_copy_live_table_data_into_cache_tables', 0, 1) WITH NOWAIT;
GO
CREATE PROCEDURE sysutility_ucp_staging.sp_copy_live_table_data_into_cache_tables
AS
BEGIN
      SET NOCOUNT ON;
      -- Snapshot isolation prevents the nightly purge jobs that delete much older data from blocking us. 
      SET TRANSACTION ISOLATION LEVEL SNAPSHOT; 

      DECLARE @max_snapshot_id INT, @num_snapshots_partitions INT
      
      SELECT @max_snapshot_id = ISNULL(MAX(snapshot_id),0) FROM [core].[snapshots]
      SELECT @num_snapshots_partitions = COUNT(*) FROM [msdb].[dbo].[sysutility_ucp_snapshot_partitions_internal]
      DECLARE @task_start_time DATETIME = GETUTCDATE();
      DECLARE @task_elapsed_ms INT;
      DECLARE @row_count INT;
      
        -- Initialize the snapshot partitions to default (0)
        IF(@num_snapshots_partitions = 0)
        BEGIN
            INSERT INTO [msdb].[dbo].[sysutility_ucp_snapshot_partitions_internal] VALUES (2, 0)
            INSERT INTO [msdb].[dbo].[sysutility_ucp_snapshot_partitions_internal] VALUES (1, 0)
            INSERT INTO [msdb].[dbo].[sysutility_ucp_snapshot_partitions_internal] VALUES (0, 0)
        END   
                
        DECLARE @processing_time_current DATETIMEOFFSET(7) = SYSDATETIMEOFFSET();

         --
         -- Stage 0:
         --  Identify the batches that were recently uploaded and are consistent 
         --  Data belonging to these batches will be copied from live to cache table.	  
         EXEC [sysutility_ucp_staging].[sp_get_consistent_batches]
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('sp_get_consistent_batches: %d ms', 0, 1, @task_elapsed_ms);
         SET @task_start_time = GETUTCDATE();

         ----- 
         ----- Stage 1: Insert into all the dimension tables 
         -----          computers_internal, dacs_internal, volumes_internal,
         -----          smo_servers_internal, databases_internal, filegroups_internal, 
         -----          datafiles_internal, logfiles_internal
         -----   (Then move to Stage 2: the "measure" tables)
         -----

         -- A note about the expression used for [batch_time] in the INSERT queries, below: 
         -- 
         -- We want to expose batch_time w/a UCP-local time zone so it can be exposed as a UCP-local datetime 
         -- in the GUI (the GUI consumes directly from the enumerator).  The batch_time values in each of the 
         -- queries below have their time zone offset switched to produce a datetimeoffset with the local UCP 
         -- server's time zone offset.  
         -- 
         -- This works well except when the server's time zone offset has changed since the [batch_time] was 
         -- generated due to a Daylight Saving Time change.  (Unfortunately, there is no way in T-SQL to 
         -- determine what the server's time zone offset was at some arbitrary point in the past.)  The risk 
         -- of this is low since we generally do this processing within 15 minutes of timestamp generation.  
         -- This doesn't actually result in truly incorrect batch_times that would affect data processing 
         -- since the UTC time value that underlies every datetimeoffset is unchanged when you switch the 
         -- value's time zone offset. 
         
         --
         -- Insert into the "computers" dimension table
         --
         INSERT INTO [sysutility_ucp_core].[computers_internal] (
               virtual_server_name, 
               is_clustered_server,
               physical_server_name,
               num_processors, 
               cpu_name, cpu_caption, cpu_family, cpu_architecture, cpu_max_clock_speed, cpu_clock_speed, 
               l2_cache_size, l3_cache_size,
               percent_total_cpu_utilization,
               batch_time, processing_time,
               urn, powershell_path)
            SELECT virtual_server_name, is_clustered_server, physical_server_name, 
                   num_processors, 
                   cpu_name, cpu_caption, cpu_family, cpu_architecture, cpu_max_clock_speed, cpu_clock_speed,
                   l2_cache_size, l3_cache_size, 
                   server_processor_usage,
                   SWITCHOFFSET (batch_time, DATENAME(TZoffset, SYSDATETIMEOFFSET())) AS batch_time, 
                   @processing_time_current AS processing_time, 
                   urn, powershell_path
            FROM [sysutility_ucp_staging].[latest_computer_cpu_memory_configuration]
          SET @row_count = @@ROWCOUNT;
          SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
          RAISERROR ('Insert into [computers_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
          SET @task_start_time = GETUTCDATE();
           
          --
          -- Insert into the "dacs_internal" dimension-table
          --
          INSERT INTO [sysutility_ucp_core].[dacs_internal] (
                 server_instance_name, dac_name, 
                 physical_server_name, dac_deploy_date, dac_description,
                 dac_percent_total_cpu_utilization, 
                 batch_time, processing_time,
                 urn, powershell_path)
           SELECT server_instance_name, dac_name,
                  physical_server_name, dac_deploy_date, dac_description,
                  latest_cpu_pct, 
                  SWITCHOFFSET (batch_time, DATENAME(TZoffset, SYSDATETIMEOFFSET())) AS batch_time, 
                  @processing_time_current AS processing_time, 
                  urn, powershell_path
           FROM [sysutility_ucp_staging].[latest_dac_cpu_utilization] 
          SET @row_count = @@ROWCOUNT;
          SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
          RAISERROR ('Insert into [dacs_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
          SET @task_start_time = GETUTCDATE();
           
         --- Insert into the volumes_internal dimension table  
         INSERT INTO [sysutility_ucp_core].[volumes_internal] (
                virtual_server_name, physical_server_name, volume_device_id, volume_name,
                total_space_available, free_space, powershell_path,
                batch_time, processing_time)
           SELECT virtual_server_name, physical_server_name, volume_device_id, volume_name,
                  total_space_available, free_space, powershell_path,
                  SWITCHOFFSET (batch_time, DATENAME(TZoffset, SYSDATETIMEOFFSET())) AS batch_time, 
                  @processing_time_current AS processing_time
           FROM [sysutility_ucp_staging].[latest_volumes]
         SET @row_count = @@ROWCOUNT;
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('Insert into [volumes_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
         SET @task_start_time = GETUTCDATE();
           
         INSERT INTO [sysutility_ucp_core].[smo_servers_internal]
         (
            [urn]  
            , [powershell_path]
            , [processing_time] 
            , [batch_time]
            , [AuditLevel]  
            , [BackupDirectory]  
            , [BrowserServiceAccount]  
            , [BrowserStartMode]  
            , [BuildClrVersionString]  
            , [BuildNumber]  
            , [Collation]  
            , [CollationID]  
            , [ComparisonStyle]  
            , [ComputerNamePhysicalNetBIOS]  
            , [DefaultFile]  
            , [DefaultLog]  
            , [Edition]  
            , [EngineEdition]  
            , [ErrorLogPath]  
            , [FilestreamShareName]  
            , [InstallDataDirectory]  
            , [InstallSharedDirectory]  
            , [InstanceName]  
            , [IsCaseSensitive]  
            , [IsClustered]  
            , [IsFullTextInstalled]  
            , [IsSingleUser]  
            , [Language]  
            , [MailProfile]  
            , [MasterDBLogPath]  
            , [MasterDBPath]  
            , [MaxPrecision]  
            , [Name]  
            , [NamedPipesEnabled]  
            , [NetName]  
            , [NumberOfLogFiles]  
            , [OSVersion]  
            , [PerfMonMode]  
            , [PhysicalMemory]  
            , [Platform]  
            , [Processors]  
            , [ProcessorUsage]  
            , [Product]  
            , [ProductLevel]  
            , [ResourceVersionString]  
            , [RootDirectory]  
            , [ServerType]  
            , [ServiceAccount]  
            , [ServiceInstanceId]  
            , [ServiceName]  
            , [ServiceStartMode]  
            , [SqlCharSet]  
            , [SqlCharSetName]  
            , [SqlDomainGroup]  
            , [SqlSortOrder]  
            , [SqlSortOrderName]  
            , [Status]  
            , [TapeLoadWaitTime]  
            , [TcpEnabled]  
            , [VersionMajor]  
            , [VersionMinor]  
            , [VersionString]  
        )

        SELECT  urn
              , CONVERT(NVARCHAR(MAX), [powershell_path]) AS [powershell_path]
                , @processing_time_current AS [processing_time]  -- $FIXED: SQLBUVSTS-316258
                , SWITCHOFFSET (batch_time, DATENAME(TZoffset, SYSDATETIMEOFFSET())) AS [batch_time]  
                , CONVERT(SMALLINT,[AuditLevel]) AS [AuditLevel]
                , CONVERT(NVARCHAR(260) ,[BackupDirectory]) AS [BackupDirectory]
                , CONVERT(NVARCHAR(128) ,[BrowserServiceAccount]) AS [BrowserServiceAccount]
                , CONVERT(SMALLINT,[BrowserStartMode]) AS [BrowserStartMode]
                , CONVERT(NVARCHAR(20) ,[BuildClrVersionString]) AS [BuildClrVersionString]
                , CONVERT(INT,[BuildNumber]) AS [BuildNumber]
                , CONVERT(NVARCHAR(128),[Collation]) AS [Collation]
                , CONVERT(INT,[CollationID]) AS [CollationID]
                , CONVERT(INT,[ComparisonStyle]) AS [ComparisonStyle]
                , CONVERT(NVARCHAR(128),[ComputerNamePhysicalNetBIOS]) AS [ComputerNamePhysicalNetBIOS]
                , CONVERT(NVARCHAR(260),[DefaultFile]) AS [DefaultFile]
                , CONVERT(NVARCHAR(260),[DefaultLog]) AS [DefaultLog]
                , CONVERT(NVARCHAR(64),[Edition]) AS [Edition]
                , CONVERT(SMALLINT,[EngineEdition]) AS [EngineEdition]
                , CONVERT(NVARCHAR(260) ,[ErrorLogPath]) AS [ErrorLogPath]
                , CONVERT(NVARCHAR(260) ,[FilestreamShareName]) AS [FilestreamShareName]
                , CONVERT(NVARCHAR(260) ,[InstallDataDirectory]) AS [InstallDataDirectory]
                , CONVERT(NVARCHAR(260) ,[InstallSharedDirectory]) AS [InstallSharedDirectory]
                , CONVERT(NVARCHAR(128) ,[InstanceName]) AS [InstanceName]
                , CONVERT(BIT,[IsCaseSensitive]) AS [IsCaseSensitive]
                , CONVERT(BIT,[IsClustered]) AS [IsClustered]
                , CONVERT(BIT,[IsFullTextInstalled]) AS [IsFullTextInstalled]
                , CONVERT(BIT,[IsSingleUser]) AS [IsSingleUser]
                , CONVERT(NVARCHAR(64) ,[Language]) AS [Language]
                , CONVERT(NVARCHAR(128),[MailProfile]) AS [MailProfile]
                , CONVERT(NVARCHAR(260),[MasterDBLogPath]) AS [MasterDBLogPath]
                , CONVERT(NVARCHAR(260),[MasterDBPath]) AS [MasterDBPath]
                , CONVERT(TINYINT,[MaxPrecision]) AS [MaxPrecision]
                , CONVERT(NVARCHAR(128) ,[Name]) AS [Name]
                , CONVERT(BIT,[NamedPipesEnabled]) AS [NamedPipesEnabled]
                , CONVERT(NVARCHAR(128) ,[NetName]) AS [NetName]
                , CONVERT(INT,[NumberOfLogFiles]) AS [NumberOfLogFiles]
                , CONVERT(NVARCHAR(32) ,[OSVersion]) AS [OSVersion]
                , CONVERT(SMALLINT,[PerfMonMode]) AS [PerfMonMode]
                , CONVERT(INT,[PhysicalMemory]) AS [PhysicalMemory]
                , CONVERT(NVARCHAR(32) ,[Platform]) AS [Platform]
                , CONVERT(SMALLINT,[Processors]) AS [Processors]
                , CONVERT(INT,[ProcessorUsage]) AS [ProcessorUsage]
                , CONVERT(NVARCHAR(48) ,[Product]) AS [Product]
                , CONVERT(NVARCHAR(32) ,[ProductLevel]) AS [ProductLevel]
                , CONVERT(NVARCHAR(32) ,[ResourceVersionString]) AS [ResourceVersionString]
                , CONVERT(NVARCHAR(260) ,[RootDirectory]) AS [RootDirectory]
                , CONVERT(SMALLINT,[ServerType]) AS [ServerType]
                , CONVERT(NVARCHAR(128),[ServiceAccount]) AS [ServiceAccount]
                , CONVERT(NVARCHAR(64),[ServiceInstanceId]) AS [ServiceInstanceId]
                , CONVERT(NVARCHAR(64),[ServiceName]) AS [ServiceName]
                , CONVERT(SMALLINT,[ServiceStartMode]) AS [ServiceStartMode]
                , CONVERT(SMALLINT,[SqlCharSet]) AS [SqlCharSet]
                , CONVERT(NVARCHAR(32),[SqlCharSetName]) AS [SqlCharSetName]
                , CONVERT(NVARCHAR(128),[SqlDomainGroup]) AS [SqlDomainGroup]
                , CONVERT(SMALLINT,[SqlSortOrder]) AS [SqlSortOrder]
                , CONVERT(NVARCHAR(64),[SqlSortOrderName]) AS [SqlSortOrderName]
                , CONVERT(SMALLINT,[Status]) AS [Status]
                , CONVERT(INT,[TapeLoadWaitTime]) AS [TapeLoadWaitTime]
                , CONVERT(BIT,[TcpEnabled]) AS [TcpEnabled]
                , CONVERT(INT,[VersionMajor]) AS [VersionMajor]
                , CONVERT(INT,[VersionMinor]) AS [VersionMinor]
                , CONVERT(NVARCHAR(32),[VersionString]) AS [VersionString]
                
                FROM 
                    (SELECT urn, property_name, property_value, batch_time 
                    FROM [sysutility_ucp_staging].[latest_smo_properties]
                    WHERE object_type = 1) props     -- object_type = 1 is Server
                PIVOT
                (
                    MAX(property_value)
                    FOR property_name IN (    
                                   [powershell_path]
                                 , [AuditLevel]
                            , [BackupDirectory]
                            , [BrowserServiceAccount]
                            , [BrowserStartMode]
                            , [BuildClrVersionString]
                            , [BuildNumber]
                            , [Collation]
                            , [CollationID]
                            , [ComparisonStyle]
                            , [ComputerNamePhysicalNetBIOS]
                            , [DefaultFile]
                            , [DefaultLog]
                            , [Edition]
                            , [EngineEdition]
                            , [ErrorLogPath]
                            , [FilestreamShareName]
                            , [InstallDataDirectory]
                            , [InstallSharedDirectory]
                            , [InstanceName]
                            , [IsCaseSensitive]
                            , [IsClustered]
                            , [IsFullTextInstalled]
                            , [IsSingleUser]
                            , [Language]
                            , [MailProfile]
                            , [MasterDBLogPath]
                            , [MasterDBPath]
                            , [MaxPrecision]
                            , [Name]
                            , [NamedPipesEnabled]
                            , [NetName]
                            , [NumberOfLogFiles]
                            , [OSVersion]
                            , [PerfMonMode]
                            , [PhysicalMemory]
                            , [Platform]
                            , [Processors]
                            , [ProcessorUsage]
                            , [Product]
                            , [ProductLevel]
                            , [ResourceVersionString]
                            , [RootDirectory]
                            , [ServerType]
                            , [ServiceAccount]
                            , [ServiceInstanceId]
                            , [ServiceName]
                            , [ServiceStartMode]
                            , [SqlCharSet]
                            , [SqlCharSetName]
                            , [SqlDomainGroup]
                            , [SqlSortOrder]
                            , [SqlSortOrderName]
                            , [Status]
                            , [TapeLoadWaitTime]
                            , [TcpEnabled]
                            , [VersionMajor]
                            , [VersionMinor]
                            , [VersionString] )
                ) AS pvt         
         SET @row_count = @@ROWCOUNT;
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('Insert into [smo_servers_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
         SET @task_start_time = GETUTCDATE();
                  
         INSERT INTO [sysutility_ucp_core].[databases_internal]
                ([urn]
                , [powershell_path]
                , [processing_time]
                , [batch_time]
                , [server_instance_name]
                , [parent_urn]
                , [Collation]
                , [CompatibilityLevel]
                , [CreateDate]
                , [EncryptionEnabled]
                , [Name]
                , [RecoveryModel]
                , [Trustworthy]
                , [state])
            SELECT  [urn]
                  , CONVERT(NVARCHAR(MAX), [powershell_path]) AS [powershell_path]
                    , @processing_time_current AS processing_time  -- $FIXED: SQLBUVSTS-316258
                    , SWITCHOFFSET ([batch_time], DATENAME(TZoffset, SYSDATETIMEOFFSET())) AS [batch_time] 
                    , [server_instance_name]
                    , Left(urn, CHARINDEX('/Database[', urn, 1)-1) AS parent_urn
                    , CONVERT(NVARCHAR(128),[Collation]) AS Collation
                    , CONVERT(SMALLINT,[CompatibilityLevel]) AS CompatibilityLevel
                    -- DC (SSIS) doesn't support sql_variant, so all properties are uploaded as nvarchar(4000).  To successfully round-trip 
                    -- the property values through nvarchar, we use the same language-independent conversion style on MI and UCP. The shared 
                    -- fn_sysutility_get_culture_invariant_conversion_style_internal function gives us a consistent conversion style for each 
                    -- property data type that is language-independent and that won't cause data loss.  We also use this function on the MI 
                    -- when converting to nvarchar so that the two conversions are symmetrical.  (Ref: VSTS 361531, 359504, 12967)
                    , CONVERT(DATETIME, [CreateDate], msdb.dbo.fn_sysutility_get_culture_invariant_conversion_style_internal('datetime')) AS CreateDate
                    , CONVERT(BIT,[EncryptionEnabled]) AS EncryptionEnabled
                    , CONVERT(SYSNAME,[Name])AS [Name]
                    , CONVERT(SMALLINT,[RecoveryModel]) AS RecoveryModel
                    , CONVERT(BIT,[Trustworthy]) AS Trustworthy
                    -- Default to 0 (available) state. We'll update this to 1 (not available) for emergency/offline/etc databases later (we 
                    -- need to examine file and filegroup properties to infer whether a database should be available or not available). 
                    , 0 AS state
             FROM 
             (SELECT urn, server_instance_name, property_name, property_value, batch_time 
             FROM [sysutility_ucp_staging].[latest_smo_properties]
             WHERE object_type = 2) props -- object_type = 1 is Database
                PIVOT
                (
                    MAX(property_value)
                    FOR property_name IN ( 
                                       [powershell_path]
                                      , [ID]
                                      , [Collation]
                                            , [CompatibilityLevel]
                                            , [CreateDate]
                                            , [EncryptionEnabled]
                                            , [Name]
                                            , [RecoveryModel]
                                            , [Trustworthy] )
                ) AS pvt    
         SET @row_count = @@ROWCOUNT;
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('Insert into [databases_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
         SET @task_start_time = GETUTCDATE();
         
         
         INSERT INTO [sysutility_ucp_core].[filegroups_internal]
                ([urn]
                , [powershell_path]
                , [processing_time]
                , [batch_time]
                , [server_instance_name]
                , [database_name]
                , [parent_urn]
                , [Name])
            SELECT  [urn]
                  , CONVERT(NVARCHAR(MAX), [powershell_path]) AS [powershell_path]
                    , @processing_time_current AS processing_time  -- $FIXED: SQLBUVSTS-316258
                    , SWITCHOFFSET ([batch_time], DATENAME(TZoffset, SYSDATETIMEOFFSET())) AS [batch_time] 
                    , [server_instance_name]
                    , CONVERT(SYSNAME,[parent_name]) AS [database_name]
                    , Left(urn, CHARINDEX('/FileGroup[', urn, 1)-1) AS parent_urn
                    , CONVERT(SYSNAME,[Name]) AS Name
             FROM 
             (SELECT urn, server_instance_name, property_name, property_value, batch_time 
             FROM [sysutility_ucp_staging].[latest_smo_properties]
             WHERE object_type = 4) props -- object_type = 4 is FileGroup
                PIVOT
                (
                    MAX(property_value)
                    FOR property_name IN ( 
                                        [powershell_path]
                                      , [parent_name]
                                      , [ID]
                                            , [Name])
                ) AS pvt    
         SET @row_count = @@ROWCOUNT;
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('Insert into [filegroups_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
         SET @task_start_time = GETUTCDATE();
         
                  
         
         INSERT INTO [sysutility_ucp_core].[datafiles_internal]
                ([urn]
                , [powershell_path]
                , [processing_time]
                , [batch_time]
                , [server_instance_name]
                , [database_name]
                , [filegroup_name]
                , [parent_urn]
                , [Growth]
                , [GrowthType]
                , [MaxSize]
                , [Name]
                , [Size]
                , [UsedSpace]
                , [FileName]
                , [VolumeFreeSpace]
                , [volume_name]
                , [volume_device_id]
                , [physical_server_name])
            SELECT  [urn]
                  , CONVERT(NVARCHAR(MAX), pvt.[powershell_path]) AS [powershell_path]
                    , @processing_time_current AS processing_time  -- $FIXED: SQLBUVSTS-316258
                    , SWITCHOFFSET (pvt.[batch_time], DATENAME(TZoffset, SYSDATETIMEOFFSET())) AS [batch_time] 
                    , pvt.[server_instance_name]
                    , CONVERT(SYSNAME,[grandparent_name]) AS [database_name]
                    , CONVERT(SYSNAME,[parent_name]) AS [filegroup_name]
                    , Left(urn, CHARINDEX('/File[', urn, 1)-1) AS parent_urn
                    , CONVERT(REAL,[Growth]) AS Growth
                    , CONVERT(SMALLINT,[GrowthType]) AS GrowthType
                    , CONVERT(REAL,[MaxSize]) AS MaxSize
                    , CONVERT(SYSNAME,[Name]) AS Name
                    , CONVERT(REAL,[Size]) AS Size
                    , CONVERT(REAL,[UsedSpace]) AS UsedSpace
                    , CONVERT(NVARCHAR(260),[FileName]) AS FileName
                    , ISNULL(v.free_space, 0.0) * 1024 AS VolumeFreeSpace -- volumes_internal.free_space is MB, and VolumeFreeSpace is expected to be KB.
                    , ISNULL(v.volume_name, N'') AS volume_name
                    , v.[volume_device_id] AS [volume_device_id]
                    , pvt.[physical_server_name]
             FROM 
             (SELECT urn, physical_server_name, server_instance_name, property_name, property_value, batch_time 
             FROM [sysutility_ucp_staging].[latest_smo_properties]
             WHERE object_type = 5) props -- object_type = 5 is DataFile
                PIVOT
                (
                    MAX(property_value)
                    FOR property_name IN ( 
                                        [powershell_path]
                                      , [parent_name]
                                      , [grandparent_name]
                                      , [ID]
                                      , [Growth]
                                      , [GrowthType]
                                      , [MaxSize]
                                      , [Name]
                                      , [Size]
                                      , [UsedSpace]
                                      , [FileName] 
                                      , [volume_device_id])
                ) AS pvt
            LEFT OUTER JOIN
            [sysutility_ucp_core].[volumes_internal] v
            ON 
            v.physical_server_name = pvt.physical_server_name AND
            CONVERT(SYSNAME, pvt.[volume_device_id]) = v.volume_device_id
            WHERE v.processing_time = @processing_time_current
         SET @row_count = @@ROWCOUNT;
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('Insert into [datafiles_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
         SET @task_start_time = GETUTCDATE();
                             

         INSERT INTO [sysutility_ucp_core].[logfiles_internal]
                ([urn]
                , [powershell_path]
                , [processing_time]
                , [batch_time]
                , [server_instance_name]
                , [database_name]
                , [parent_urn]
                , [Growth]
                , [GrowthType]
                , [MaxSize]
                , [Name]
                , [Size]
                , [UsedSpace]
                , [FileName]
                , [VolumeFreeSpace]
                , [volume_name]
                , [volume_device_id]
                , [physical_server_name])
            SELECT[urn]
                  , CONVERT(NVARCHAR(MAX), pvt.[powershell_path]) AS [powershell_path]
                    , @processing_time_current AS processing_time  -- $FIXED: SQLBUVSTS-316258
                    , SWITCHOFFSET (pvt.[batch_time], DATENAME(TZoffset, SYSDATETIMEOFFSET())) AS [batch_time] 
                    , pvt.[server_instance_name]
                    , CONVERT(SYSNAME,[parent_name]) AS [database_name]
                    , Left(urn, CHARINDEX('/LogFile[', urn, 1)-1) AS parent_urn
                    , CONVERT(REAL,[Growth]) AS Growth
                    , CONVERT(SMALLINT,[GrowthType]) AS GrowthType
                    , CONVERT(REAL,[MaxSize]) AS MaxSize
                    , CONVERT(SYSNAME,[Name]) AS Name
                    , CONVERT(REAL,[Size]) AS Size
                    --- The collection data may not contain the UsedSpace property of the log file of a database in EMERGENCY state. 
                    , ISNULL(CONVERT(REAL,[UsedSpace]), 0.0) AS UsedSpace
                    , CONVERT(NVARCHAR(260),[FileName]) AS FileName
                    , ISNULL(v.free_space, 0.0) * 1024 AS VolumeFreeSpace -- volumes_internal.free_space is MB, and VolumeFreeSpace is expected to be KB.
                    , ISNULL(v.volume_name, N'') AS volume_name
                    , v.[volume_device_id] AS [volume_device_id]
                    , pvt.[physical_server_name]
             FROM 
             (SELECT urn, physical_server_name, server_instance_name, property_name, property_value, batch_time 
             FROM [sysutility_ucp_staging].[latest_smo_properties] 
             WHERE object_type = 3) props -- object_type = 3 is LogFile
                PIVOT
                (
                    MAX(property_value)
                    FOR property_name IN ( 
                                       [powershell_path]
                                      , [parent_name]
                                      , [ID]
                                      , [Growth]
                                      , [GrowthType]
                                      , [MaxSize]
                                      , [Name]
                                      , [Size]
                                      , [UsedSpace]
                                      , [FileName] 
                                      , [volume_device_id])
                ) AS pvt  
            LEFT OUTER JOIN
            [sysutility_ucp_core].[volumes_internal] v
            ON 
            v.physical_server_name = pvt.physical_server_name AND
            CONVERT(SYSNAME, pvt.[volume_device_id]) = v.volume_device_id
            WHERE v.processing_time = @processing_time_current
         SET @row_count = @@ROWCOUNT;
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('Insert into [logfiles_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
         SET @task_start_time = GETUTCDATE();
         
         -- Identify all of the databases for which we do not have all file/filegroup details because of the current 
         -- database status (db is offline, recovering, emergency mode, etc).  Update the state for these databases 
         -- to 1 ("not available"). 
         UPDATE sysutility_ucp_core.databases_internal 
         SET state = 1 
         FROM sysutility_ucp_core.databases_internal AS db
         WHERE 
             -- Case #1: Emergency mode databases are considered 'not available' -- the database is not recovered, and 
             -- we can't get correct log file metadata.  We detect this by looking for databases with a log file that 
             -- has a size of 0, which is impossible in an available database. 
            EXISTS (
                SELECT * 
                FROM sysutility_ucp_core.logfiles_internal AS lf
                WHERE lf.server_instance_name = db.server_instance_name 
                    AND lf.database_name = db.Name
                    AND lf.Size = 0
                    AND lf.processing_time = @processing_time_current)
            -- Case #2: When a database is in other "not available" states (like recovering, offline, suspect), we 
            -- cannot retrieve filegroup or file-level metadata.  We detect this case by looking for databases that seem 
            -- to have no filegroups, which is an impossible state for an online & available database. 
            OR NOT EXISTS (
                SELECT * 
                FROM sysutility_ucp_core.filegroups_internal AS fg
                WHERE fg.server_instance_name = db.server_instance_name 
                    AND fg.database_name = db.Name
                    AND fg.processing_time = @processing_time_current);
         SET @row_count = @@ROWCOUNT;
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('Discover unavailable databases: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
         SET @task_start_time = GETUTCDATE();
         
         
         ----- 
         ----- Stage 2: Insert into all the measure tables
         -----          cpu_utilization_internal (computers, instances, dacs)
         -----          space_utilization_internal (volumes, instances, databases, filegroups, datafiles, logfiles)
         ----- 
         ----- 
         INSERT INTO [sysutility_ucp_core].[cpu_utilization_internal](
              aggregation_type, object_type, processing_time,
              physical_server_name, server_instance_name, database_name,
              percent_total_cpu_utilization)
            SELECT 0,   -- No aggregation
                   1,   -- Computer Object
                   @processing_time_current,
                   physical_server_name,
                   N'', 
                   N'',
                   percent_total_cpu_utilization
            FROM [sysutility_ucp_core].[computers_internal]
            WHERE processing_time = @processing_time_current
              UNION ALL
            SELECT 0,   -- No aggregation
                   3,   -- Instance object
                   @processing_time_current, 
                   N'', 
                   server_instance_name,
                   N'',
                   instance_processor_usage
            FROM [sysutility_ucp_staging].[latest_instance_cpu_utilization]
              UNION ALL
            SELECT 0,   -- No aggregation
                   4,   -- Database/DAC object
                   @processing_time_current,
                   N'',   -- computer_name
                   server_instance_name,
                   dac_name,
                   dac_percent_total_cpu_utilization
            FROM [sysutility_ucp_core].[dacs_internal]
            WHERE processing_time = @processing_time_current
         SET @row_count = @@ROWCOUNT;
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('Insert into [cpu_utilization_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);
         SET @task_start_time = GETUTCDATE();
            
         INSERT INTO [sysutility_ucp_core].[space_utilization_internal] (
               aggregation_type, object_type, processing_time,
               virtual_server_name, volume_device_id, 
               server_instance_name, database_name, [filegroup_name], dbfile_name,
               total_space_bytes, allocated_space_bytes, used_space_bytes, available_space_bytes)
            SELECT 0 AS aggregation_type,
                   CASE WHEN group_id = 0 AND [filegroup_name] = N'' THEN 7 -- logfile
                        WHEN group_id = 0 THEN 6 -- datafile
                        WHEN group_id = 1 THEN 5 -- filegroup
                        WHEN group_id = 3 THEN 4 -- database
                        WHEN group_id = 7 THEN 3 -- instance
                        ELSE NULL -- should never get here 
                   END as [object_type], 
                   @processing_time_current AS processing_time,
                   N'' as virtual_server_name, 
                   N'' as volume_device_id, 
                   ISNULL(server_instance_name, N''), -- shouldn't ever get to be null 
                   ISNULL(database_name, N''), 
                   ISNULL([filegroup_name], N''), 
                   ISNULL([dbfile_name], N''),
                   CASE WHEN group_id = 0 THEN total_space_kb * 1024 ELSE NULL END, 
                   CASE WHEN group_id = 0 THEN allocated_space_kb * 1024 ELSE NULL END, 
                   used_space_kb * 1024, 
                   CASE WHEN group_id = 0 THEN available_space_kb * 1024 ELSE NULL END
            FROM (
                SELECT server_instance_name, database_name, [filegroup_name], dbfile_name,  
                       SUM(MaxSize) AS total_space_kb,  -- Is this right?
                       SUM([Size]) AS allocated_space_kb, 
                       SUM(UsedSpace) AS used_space_kb, 
                       SUM(available_space) AS available_space_kb,
                       GROUPING_ID(server_instance_name, database_name, [filegroup_name], dbfile_name) AS group_id
                FROM (SELECT server_instance_name, database_name, [filegroup_name], [Name] as dbfile_name, 
                             MaxSize, [Size], UsedSpace,
                             [sysutility_ucp_misc].[fn_get_max_size_available]([Size], [MaxSize], [Growth], [GrowthType], [VolumeFreeSpace]) AS available_space
                       FROM [sysutility_ucp_core].[datafiles_internal] 
                       WHERE processing_time = @processing_time_current
                     UNION ALL
                      SELECT server_instance_name, database_name, N'' AS [filegroup_name], 
                             [Name] AS dbfile_name, 
                             MaxSize, [Size], UsedSpace,
                             [sysutility_ucp_misc].[fn_get_max_size_available]([Size], [MaxSize], [Growth], [GrowthType], [VolumeFreeSpace]) AS available_space
                      FROM [sysutility_ucp_core].[logfiles_internal]
                      WHERE processing_time = @processing_time_current) as dbfiles
                GROUP BY GROUPING SETS((server_instance_name), 
                                       (server_instance_name, database_name),
                                       (server_instance_name, database_name, [filegroup_name]),
                                       (server_instance_name, database_name, [filegroup_name], [dbfile_name])
                                      )
                 ) AS instance_space_utilizations
            UNION ALL       
            SELECT 0 AS aggregation_type,
                   CASE WHEN GROUPING_ID(virtual_server_name, volume_device_id) = 3 THEN 0 -- utility 
                        WHEN GROUPING_ID(virtual_server_name, volume_device_id) = 1 THEN 1 -- computer 
                        WHEN GROUPING_ID(virtual_server_name, volume_device_id) = 0 THEN 2 -- volume
                        ELSE NULL  -- should never get here
                   END AS object_type,
                   @processing_time_current as processing_time,
                   ISNULL(virtual_server_name, N''), 
                   ISNULL(volume_device_id, N'') AS volume_device_id, 
                   N'' as server_instance_name, 
                   N'' as database_name, 
                   N'' as [filegroup_name], 
                   N'' as dbfile_name,
                   SUM(total_space_available)*1048576 AS total_space_bytes,
                   SUM(total_space_available)*1048576 AS allocated_space_bytes,
                   SUM(total_space_available - free_space)*1048576  AS used_space_bytes,
                   SUM(free_space)*1048576 AS available_space_bytes
            FROM [sysutility_ucp_core].[volumes_internal] 
            WHERE processing_time = @processing_time_current
            GROUP BY GROUPING SETS ((),
                                    (virtual_server_name),
                                    (virtual_server_name, volume_device_id)
                                   )
         SET @row_count = @@ROWCOUNT;
         SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
         RAISERROR ('Insert into [space_utilization_internal]: %d rows, %d ms', 0, 1, @row_count, @task_elapsed_ms);

        --         
        -- State changes
        --      
        UPDATE [msdb].[dbo].[sysutility_ucp_processing_state_internal] 
          SET latest_processing_time = @processing_time_current 

        -- Update the snapshot partitions table
        -- Push down the previous snapshot partition values and 
        -- store the current max snapshot in the latest (top) record           
        UPDATE [msdb].[dbo].[sysutility_ucp_snapshot_partitions_internal] SET latest_consistent_snapshot_id = (SELECT TOP 1 latest_consistent_snapshot_id FROM [msdb].[dbo].[sysutility_ucp_snapshot_partitions_internal] WHERE time_id = 1)  WHERE time_id = 2
        UPDATE [msdb].[dbo].[sysutility_ucp_snapshot_partitions_internal] SET latest_consistent_snapshot_id = (SELECT TOP 1 latest_consistent_snapshot_id FROM [msdb].[dbo].[sysutility_ucp_snapshot_partitions_internal] WHERE time_id = 0)  WHERE time_id = 1
        UPDATE [msdb].[dbo].[sysutility_ucp_snapshot_partitions_internal] SET latest_consistent_snapshot_id = @max_snapshot_id WHERE time_id = 0

        -- As we have inserted chunk of data in the cache tables, the stats on these tables
        -- get stale there by leading to performance degradation of the health state queries
        -- Force update the stats on these tables so that the QO is able to generate a more 
        -- realisitc query execution plan
        SET @task_start_time = GETUTCDATE();
        UPDATE STATISTICS [msdb].[dbo].[sysutility_ucp_processing_state_internal];

        -- Update stats on all dimension and measure cache tables
        DECLARE @schema sysname
        DECLARE @name sysname
        DECLARE @query NVARCHAR(MAX)
 
        DECLARE cache_tables CURSOR FOR
        SELECT object_schema, [object_name]
        FROM sysutility_ucp_misc.utility_objects_internal
        WHERE utility_object_type IN ('DIMENSION', 'MEASURE');
 
        OPEN cache_tables;
        FETCH NEXT FROM cache_tables INTO @schema, @name;
        WHILE (@@FETCH_STATUS <> -1)
        BEGIN
            SET @query = 'UPDATE STATISTICS ' + QUOTENAME (@schema) + '.' + QUOTENAME (@name); 
            EXEC (@query);
            FETCH NEXT FROM cache_tables INTO @schema, @name;
        END;
        CLOSE cache_tables;
        DEALLOCATE cache_tables;
 
        SET @task_elapsed_ms = DATEDIFF (ms, @task_start_time, GETUTCDATE());
        RAISERROR ('Update statistics: %d ms', 0, 1, @task_elapsed_ms);
END
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'STAGING', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_staging', 
   @level1type = 'PROCEDURE', @level1name = 'sp_copy_live_table_data_into_cache_tables';
GO


-----------------------------------------------------------------------------------------
-- Procedure sp_copy_cache_table_data_into_aggregate_tables
--   Aggregates the latest round of data from the "cache" tables into the "aggregate" tables
--   for the appropriate aggregation interval 
-----------------------------------------------------------------------------------------
IF OBJECT_ID ('sysutility_ucp_core.sp_copy_cache_table_data_into_aggregate_tables') IS NOT NULL
BEGIN
   RAISERROR('Dropping procedure sysutility_ucp_core.sp_copy_cache_table_data_into_aggregate_tables procedure', 0, 1) WITH NOWAIT;
   DROP PROCEDURE sysutility_ucp_core.sp_copy_cache_table_data_into_aggregate_tables;
END
GO
RAISERROR('Creating procedure sysutility_ucp_core.sp_copy_cache_table_data_into_aggregate_tables', 0, 1) WITH NOWAIT;
GO
CREATE PROCEDURE sysutility_ucp_core.sp_copy_cache_table_data_into_aggregate_tables
    @aggregation_type INT,
    @endTime DATETIMEOFFSET(7)
AS
BEGIN       
    DECLARE @startTime DATETIMEOFFSET(7)
    DECLARE @lowerAggregationLevel [sysutility_ucp_core].AggregationType

    SELECT @lowerAggregationLevel = 0    -- compute from detail rows
    
    IF (@aggregation_type = 1)
       SELECT @startTime = DATEADD(hour, -1, @endTime)
    ELSE IF (@aggregation_type = 2)
       SELECT @startTime = DATEADD(day, -1, @endTime)
       -- todo (VSTS #345038) 
       -- Ideally, we would be using the hourly aggregation values to compute the 
       --   daily aggregation ("SELECT @lowerAggregationLevel = 1")
       --
    ELSE BEGIN
        -- todo. Raise an error instead
        RETURN(1)
    END
    
    INSERT INTO [sysutility_ucp_core].[cpu_utilization_internal] (
         aggregation_type, object_type, processing_time,
         physical_server_name, server_instance_name, database_name,
         percent_total_cpu_utilization)
       SELECT @aggregation_type, object_type, @endTime,
              physical_server_name, server_instance_name, database_name,
              AVG(percent_total_cpu_utilization)
       FROM [sysutility_ucp_core].[cpu_utilization_internal]
       WHERE (processing_time BETWEEN @startTime and @endTime) AND
             aggregation_type = @lowerAggregationLevel 
       GROUP BY object_type, physical_server_name, server_instance_name, database_name
    
    INSERT INTO [sysutility_ucp_core].[space_utilization_internal] (
         aggregation_type, object_type, processing_time,
         virtual_server_name, volume_device_id, server_instance_name, database_name, [filegroup_name], dbfile_name, 
         total_space_bytes, allocated_space_bytes, used_space_bytes, available_space_bytes)
       SELECT @aggregation_type, object_type, @endTime,
              virtual_server_name, volume_device_id, server_instance_name, database_name, [filegroup_name], dbfile_name,
              -- Is AVG the right aggregate to use - should this instead be LAST()
              AVG(total_space_bytes), AVG(allocated_space_bytes), AVG(used_space_bytes), AVG(available_space_bytes)
       FROM [sysutility_ucp_core].[space_utilization_internal]
       WHERE (processing_time BETWEEN @startTime and @endTime) AND
             aggregation_type = @lowerAggregationLevel
       GROUP BY object_type, virtual_server_name, volume_device_id, server_instance_name, database_name, [filegroup_name], dbfile_name 
           
END
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'PROCEDURE', @level1name = 'sp_copy_cache_table_data_into_aggregate_tables';
GO

-----------------------------------------------------------------------------------------
-- Procedure sp_purge_cache_tables
--   Deletes the data in Utility's MDW cache tables according to the data retention 
--   periods specified in msdb.dbo.sysutility_ucp_configuration_internal. 
-----------------------------------------------------------------------------------------
IF OBJECT_ID ('sysutility_ucp_core.sp_purge_cache_tables') IS NOT NULL
BEGIN
   RAISERROR('Dropping procedure sysutility_ucp_core.sp_purge_cache_tables procedure', 0, 1) WITH NOWAIT;
   DROP PROCEDURE sysutility_ucp_core.sp_purge_cache_tables;
END
GO
RAISERROR('Creating procedure sysutility_ucp_core.sp_purge_cache_tables', 0, 1) WITH NOWAIT;
GO
CREATE PROCEDURE sysutility_ucp_core.sp_purge_cache_tables
AS
BEGIN
    DECLARE @rows_affected bigint;
    DECLARE @delete_batch_size varchar(30);

    SET @delete_batch_size = 500;
    SET @rows_affected = -1;

    DECLARE @days_to_retain_minute_data int;
    DECLARE @days_to_retain_hour_data int;
    DECLARE @days_to_retain_day_data int;

    SELECT @days_to_retain_minute_data = CONVERT (int,current_value) 
    FROM [msdb].[dbo].[sysutility_ucp_configuration_internal] 
    WHERE name = 'MdwRetentionLengthInDaysForMinutesHistory';

    SELECT @days_to_retain_hour_data = CONVERT (int,current_value) 
    FROM [msdb].[dbo].[sysutility_ucp_configuration_internal] 
    WHERE name = 'MdwRetentionLengthInDaysForHoursHistory';

    SELECT @days_to_retain_day_data = CONVERT (int,current_value) 
    FROM [msdb].[dbo].[sysutility_ucp_configuration_internal] 
    WHERE name = 'MdwRetentionLengthInDaysForDaysHistory';

    DECLARE @date_threshold_minute_data DATETIMEOFFSET(7) = DATEADD(day, -@days_to_retain_minute_data, SYSDATETIMEOFFSET());
    DECLARE @date_threshold_hour_data DATETIMEOFFSET(7) = DATEADD(day, -@days_to_retain_hour_data, SYSDATETIMEOFFSET());
    DECLARE @date_threshold_day_data DATETIMEOFFSET(7) = DATEADD(day, -@days_to_retain_day_data, SYSDATETIMEOFFSET());
       
    DECLARE @schema sysname
    DECLARE @name sysname
    DECLARE @query NVARCHAR(MAX)

    DECLARE dimensions_cursor CURSOR FOR
    SELECT object_schema, [object_name] 
    FROM sysutility_ucp_misc.utility_objects_internal
    WHERE utility_object_type = 'DIMENSION';

    -- Purge the dimension tables. 
    -- The number of rows that can be deleted from these tables can be very large.  If we deleted 
    -- all of these rows in a single delete statement, we would hold locks for an arbitrarily-long 
    -- time (and potentially escalate to table locks), causing long-duration blocking.  This could 
    -- also lead to transaction log growth, since log records after the oldest still-open transaction 
    -- can't be truncated.  To avoid these two problems, we delete rows in batches of 500 and loop 
    -- until we've deleted all rows that we no longer need. 
    OPEN dimensions_cursor;
    FETCH NEXT FROM dimensions_cursor INTO @schema, @name;
    WHILE (@@FETCH_STATUS <> -1)
    BEGIN
        SET @rows_affected = -1;
        WHILE (@rows_affected != 0)
        BEGIN
            -- We use dynamic SQL here because the table name is variable, but this also has the benefit of 
            -- providing the optimizer with the final value for @delete_batch_size and @date_threshold. 
            SET @query = 'DELETE TOP (' + @delete_batch_size + ') FROM ' + QUOTENAME(@schema) + '.' + QUOTENAME(@name) +
                         ' WHERE processing_time < @date_threshold';
            EXEC sp_executesql @query, N'@date_threshold datetimeoffset(7)', @date_threshold = @date_threshold_minute_data;
            SET @rows_affected = @@ROWCOUNT;
        END;

        FETCH NEXT FROM dimensions_cursor INTO @schema, @name;
    END;
    CLOSE dimensions_cursor;
    DEALLOCATE dimensions_cursor;

    DECLARE measures_cursor CURSOR FOR
    SELECT object_schema, [object_name] 
    FROM sysutility_ucp_misc.utility_objects_internal
    WHERE utility_object_type = 'MEASURE';

    -- Delete "per-minute" (15 minute) data from measure tables
    OPEN measures_cursor;
    FETCH NEXT FROM measures_cursor INTO @schema, @name;
    WHILE (@@FETCH_STATUS <> -1)
    BEGIN
        SET @rows_affected = -1;
        WHILE (@rows_affected != 0)
        BEGIN
            SET @query = 'DELETE TOP (' + @delete_batch_size + ') FROM ' + QUOTENAME(@schema) + '.' + QUOTENAME(@name) +
                         ' WHERE processing_time < @date_threshold AND aggregation_type = 0';
            EXEC sp_executesql @query, N'@date_threshold datetimeoffset(7)', @date_threshold = @date_threshold_minute_data;
            SET @rows_affected = @@ROWCOUNT;
        END;            
        
        FETCH NEXT FROM measures_cursor INTO @schema, @name;
    END;
    CLOSE measures_cursor;
    
    -- Delete "per-hour" data from our measure-tables 
    OPEN measures_cursor;
    FETCH NEXT FROM measures_cursor INTO @schema, @name;
    WHILE (@@FETCH_STATUS <> -1)
    BEGIN
        SET @rows_affected = -1;
        WHILE (@rows_affected != 0)
        BEGIN
            SET @query = 'DELETE TOP (' + @delete_batch_size + ') FROM ' + QUOTENAME(@schema) + '.' + QUOTENAME(@name) +
                         ' WHERE processing_time < @date_threshold AND aggregation_type = 1';
            EXEC sp_executesql @query, N'@date_threshold datetimeoffset(7)', @date_threshold = @date_threshold_hour_data;
            SET @rows_affected = @@ROWCOUNT;
        END;    
        
        FETCH NEXT FROM measures_cursor INTO @schema, @name;
    END;
    CLOSE measures_cursor;
    
    -- Delete "per-day" data from measure tables
    OPEN measures_cursor;
    FETCH NEXT FROM measures_cursor INTO @schema, @name;
    WHILE (@@FETCH_STATUS <> -1)
    BEGIN
        SET @rows_affected = -1;
        WHILE (@rows_affected != 0)
        BEGIN
            SET @query = 'DELETE TOP (' + @delete_batch_size + ') FROM ' + QUOTENAME(@schema) + '.' + QUOTENAME(@name) +
                         ' WHERE processing_time < @date_threshold AND aggregation_type = 2';
            EXEC sp_executesql @query, N'@date_threshold datetimeoffset(7)', @date_threshold = @date_threshold_day_data;
            SET @rows_affected = @@ROWCOUNT;
        END;
        
        FETCH NEXT FROM measures_cursor INTO @schema, @name;
    END;
    CLOSE measures_cursor;
    DEALLOCATE measures_cursor;
    
END;
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'PROCEDURE', @level1name = 'sp_purge_cache_tables';
GO


-----------------------------------------------------------------------------------------
-- Procedure sp_initialize_mdw_internal
--   Performs runtime schema modifications that must be deferred until Create UCP.  
--   Executed by sp_sysutility_ucp_initialize_mdw in msdb.  
--   
--   Note that this proc calls xp_qv, which requires that the 'Agent XPs' sp_configure 
--   value be enabled. During upgrade, this setting will need to be manually enabled, 
--   since upgrade scripts are executed while Agent is stopped. 
-----------------------------------------------------------------------------------------
IF OBJECT_ID ('sysutility_ucp_core.sp_initialize_mdw_internal') IS NOT NULL
BEGIN
   RAISERROR('Dropping procedure sysutility_ucp_core.sp_initialize_mdw_internal procedure', 0, 1) WITH NOWAIT;
   DROP PROCEDURE sysutility_ucp_core.sp_initialize_mdw_internal;
END
GO
RAISERROR('Creating procedure sysutility_ucp_core.sp_initialize_mdw_internal', 0, 1) WITH NOWAIT;
GO
CREATE PROCEDURE sysutility_ucp_core.sp_initialize_mdw_internal
AS
BEGIN
   IF (msdb.dbo.fn_sysutility_ucp_get_edition_is_ucp_capable_internal() = 1)
   BEGIN
      RAISERROR ('Instance is able to be used as a Utility Control Point.', 0, 1) WITH NOWAIT;
   END
   ELSE BEGIN
      DECLARE @edition nvarchar(128);
      SELECT @edition = CONVERT(nvarchar(128), SERVERPROPERTY('Edition'));
      RAISERROR(37004, -1, -1, @edition);
      RETURN(1);
   END;
   
   -- The Utility schema uses two Enterprise-only engine features: compression and partitioning.  
   -- Utility is an Enterprise-only feature, but we share instmdw.sql and the MDW database with other 
   -- features that are not Enterprise only.  Therefore we can't include the following things as part 
   -- of the CREATE TABLE statements because instmdw.sql would fail when run on a non-Enterprise SKU. 
   -- To work around this, we defer this part of the UCP schema creation until Create UCP is run. 
   IF (3 = CONVERT (int, SERVERPROPERTY('EngineEdition'))) -- Enterprise/Enterprise Eval/Developer/Data Center
   BEGIN
      -- Enable data compression on tables that benefit from it the most
      RAISERROR ('Enabling compression on MDW tables', 0, 1) WITH NOWAIT;
      ALTER TABLE [snapshots].[sysutility_ucp_smo_properties_internal] REBUILD WITH (DATA_COMPRESSION = PAGE);
      ALTER TABLE [sysutility_ucp_core].[smo_servers_internal] REBUILD WITH (DATA_COMPRESSION = PAGE);
      ALTER TABLE [sysutility_ucp_core].[databases_internal] REBUILD WITH (DATA_COMPRESSION = PAGE);
      ALTER TABLE [sysutility_ucp_core].[filegroups_internal] REBUILD WITH (DATA_COMPRESSION = PAGE);
      ALTER TABLE [sysutility_ucp_core].[datafiles_internal] REBUILD WITH (DATA_COMPRESSION = PAGE);
      ALTER TABLE [sysutility_ucp_core].[logfiles_internal] REBUILD WITH (DATA_COMPRESSION = PAGE);
      ALTER TABLE [sysutility_ucp_core].[cpu_utilization_internal] REBUILD WITH (DATA_COMPRESSION = PAGE);
      ALTER TABLE [sysutility_ucp_core].[space_utilization_internal] REBUILD WITH (DATA_COMPRESSION = PAGE);
     
      -- Partitioning (and compression) on measure tables

      -- Create a partitioning scheme based on aggregationType. In effect, we'd like
      -- each aggregation-level to get its own partition. Currently, we only support
      -- 3 aggregation levels.
      --
      -- FUTURE: It would be nice to support composite partitioning in the future. 
      --   1. We could further create a sub-partition for each object-type (computer etc.)
      --   2. If we could have sliding partitions, we could avoid deletes altogether, and 
      --      instead work with truncate/drop-partition style operations
      --
      IF NOT EXISTS (SELECT name FROM sys.partition_functions WHERE name = N'sysutility_ucp_aggregation_type_partition_function')
      BEGIN
         RAISERROR ('Creating partition function [sysutility_ucp_aggregation_type_partition_function]', 0, 1) WITH NOWAIT;
         -- Use dynamic SQL here (and in the next create stmt) b/c otherwise SQL will fail the creation of this 
         -- proc on Workgroup or Standard edition. 
         EXEC ('
            CREATE PARTITION FUNCTION [sysutility_ucp_aggregation_type_partition_function](TINYINT)
               AS RANGE LEFT 
               FOR VALUES(0, 1, 2)');
      END;

      IF NOT EXISTS (SELECT name FROM sys.partition_schemes WHERE name = N'sysutility_ucp_aggregation_type_partition_scheme')
      BEGIN
         RAISERROR ('Creating partition scheme [sysutility_ucp_aggregation_type_partition_scheme]', 0, 1) WITH NOWAIT;
         EXEC ('
            CREATE PARTITION SCHEME [sysutility_ucp_aggregation_type_partition_scheme] 
               AS PARTITION [sysutility_ucp_aggregation_type_partition_function] 
               ALL TO ([PRIMARY])');
      END;

      -- ALTER INDEX can't change partition scheme.  Instead we must drop and recreate the clustered PKs. 
      IF OBJECT_ID ('[sysutility_ucp_core].[pk_cpu_utilization_internal]') IS NOT NULL
      BEGIN
         RAISERROR ('Dropping primary key [sysutility_ucp_core].[cpu_utilization_internal].[pk_cpu_utilization_internal]', 0, 1) WITH NOWAIT;
         ALTER TABLE [sysutility_ucp_core].[cpu_utilization_internal] DROP CONSTRAINT [pk_cpu_utilization_internal]; 
      END;
      RAISERROR ('Creating partitioned primary key [sysutility_ucp_core].[cpu_utilization_internal].[pk_cpu_utilization_internal]', 0, 1) WITH NOWAIT;
      ALTER TABLE [sysutility_ucp_core].[cpu_utilization_internal] ADD 
         CONSTRAINT pk_cpu_utilization_internal 
            PRIMARY KEY CLUSTERED (aggregation_type, processing_time, object_type, physical_server_name, server_instance_name, database_name) 
            WITH (DATA_COMPRESSION = PAGE)
            ON [sysutility_ucp_aggregation_type_partition_scheme](aggregation_type);
      
      IF OBJECT_ID ('[sysutility_ucp_core].[pk_storage_utilization]') IS NOT NULL
      BEGIN
         RAISERROR ('Dropping primary key [sysutility_ucp_core].[space_utilization_internal].[pk_storage_utilization]', 0, 1) WITH NOWAIT;
         ALTER TABLE [sysutility_ucp_core].[space_utilization_internal] DROP CONSTRAINT [pk_storage_utilization]; 
      END;
      RAISERROR ('Creating partitioned primary key [sysutility_ucp_core].[space_utilization_internal].[pk_storage_utilization]', 0, 1) WITH NOWAIT;
      ALTER TABLE [sysutility_ucp_core].[space_utilization_internal] ADD 
         CONSTRAINT pk_storage_utilization 
            PRIMARY KEY CLUSTERED(
               aggregation_type,
               processing_time, 
               object_type, 
               virtual_server_name, 
               volume_device_id, 
               server_instance_name, 
               database_name, 
               [filegroup_name], 
               dbfile_name) 
            WITH (DATA_COMPRESSION = PAGE) 
            ON [sysutility_ucp_aggregation_type_partition_scheme](aggregation_type);
   END;
END;
GO

EXEC sp_addextendedproperty 
   @name = 'MS_UtilityObjectType', @value = 'CORE', 
   @level0type = 'SCHEMA', @level0name = 'sysutility_ucp_core', 
   @level1type = 'PROCEDURE', @level1name = 'sp_initialize_mdw_internal';
GO



BEGIN TRANSACTION

   -----------------------------------------------------------------------
   --  Remove the sysutility_get_views_data_into_cache_tables job if it is already existing.
   -----------------------------------------------------------------------
   DECLARE @job_id UNIQUEIDENTIFIER
   SELECT @job_id = job_id FROM msdb.dbo.sysjobs_view WHERE name = N'sysutility_get_views_data_into_cache_tables'
   IF  EXISTS (SELECT job_id FROM msdb.dbo.sysjobs_view WHERE name = N'sysutility_get_views_data_into_cache_tables')
      EXEC msdb.dbo.sp_delete_job @job_id=@job_id, @delete_unused_schedule=1
   
   DECLARE @ReturnCode INT

   -- Get the current logged in user name.
   DECLARE @CurrentLoggedIn nvarchar(128)
   Set @CurrentLoggedIn=SUSER_Name(0x1)

   SELECT @ReturnCode = 0
   -----------------------------------------------------------------------
   --  'sysutility_get_views_data_into_cache_tables job' has following steps:
   --  1. Insert [sysutility_ucp_core].[fn_get_cpu_utilizations](0) data into 
   --     [sysutility_ucp_core].[computer_cpu_utilizations_internal] cache table.
   --  2. Insert [snapshots].[dac_view] data into 
   --     [snapshots].[dac_table] 
   --  3. Insert storage live information into
   --     storage cache table
   --  4. Insert SMO live information into
   --     SMO cache table
   -----------------------------------------------------------------------
   IF NOT EXISTS (SELECT name FROM msdb.dbo.syscategories WHERE name=N'[Uncategorized (Local)]' AND category_class=1)
      BEGIN
         EXEC @ReturnCode = msdb.dbo.sp_add_category @class=N'JOB', @type=N'LOCAL', @name=N'[Uncategorized (Local)]'
         IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
      END

   DECLARE @mdwDBName NVARCHAR(256)
   SELECT  @mdwDBName = DB_NAME()
   DECLARE @jobId BINARY(16)
   EXEC @ReturnCode =  msdb.dbo.sp_add_job @job_name=N'sysutility_get_views_data_into_cache_tables', 
      @enabled=1, 
      @notify_level_eventlog=0, 
      @notify_level_email=0, 
      @notify_level_netsend=0, 
      @notify_level_page=0, 
      @delete_level=0, 
      @description=N'Gets all the views data into corresponding cache tables after every 15 minutes', 
      @category_name=N'[Uncategorized (Local)]', 
      @owner_login_name= @CurrentLoggedIn , @job_id = @jobId OUTPUT
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   
      EXEC @ReturnCode = msdb.dbo.sp_add_jobstep @job_id=@jobId, @step_name=N'Insert latest data from live tables into cache tables',  
      @step_id=1, 
      @cmdexec_success_code=0, 
      @on_success_action=3, 
      @on_success_step_id=0, 
      @on_fail_action=2, 
      @on_fail_step_id=0, 
      @retry_attempts=0, 
      @retry_interval=0, 
      @os_run_priority=0, @subsystem=N'TSQL', 
      @command=N'EXEC [sysutility_ucp_staging].sp_copy_live_table_data_into_cache_tables', 
      @database_name = @mdwDBName,
      @flags=0
   
    DECLARE @execute_policy_script NVARCHAR(MAX)

    -- Powershell script to evaluate utility resource health policies
    -- Note 1: The following line uses SQL Agent tokens to set the server name
    -- ESCAPE_SQUOTE(SRVR) with a $ sign in front is a special token to SQL Agent
    -- When the job is run, SQL Agent will expand the string to the server name
    -- Use single quotes so that PS considers the string a literal and will not
    -- try to expand the $ reference and the script will not fail in a test environment
    -- Note 2: the current approach filters on policy name to identify the resource health policy
    -- this might turn out to be an issue if we start localizing the resource health policies.

    SET @execute_policy_script = N'$serverName = ''$(ESCAPE_SQUOTE(SRVR))'';
                                   $path = Convert-UrnToPath "PolicyStore[@Name=`''$serverName`'']";
                                   dir $path\Policies -FORCE | where { $_.IsSystemObject -eq $true -and $_.Name -like ''Utility*'' } | Invoke-PolicyEvaluation -TargetServerName $serverName;'
    
    EXEC msdb.dbo.sp_add_jobstep @job_id=@jobId, @step_name=N'Execute resource health policy evaluation job', 
            @step_id=2, 
            @cmdexec_success_code=0, 
            @on_success_action=3, 
            @on_success_step_id=0, 
            @on_fail_action=2, 
            @on_fail_step_id=0, 
            @retry_attempts=0, 
            @retry_interval=0, 
            @os_run_priority=0, @subsystem=N'PowerShell', 
            @command=@execute_policy_script, 
            @database_name=N'msdb', 
            @flags=0
               
    EXEC msdb.dbo.sp_add_jobstep @job_id=@jobId, @step_name=N'Compute resource health states', 
            @step_id=3, 
            @cmdexec_success_code=0, 
            @on_success_action=1, 
            @on_success_step_id=0, 
            @on_fail_action=2, 
            @on_fail_step_id=0, 
            @retry_attempts=0, 
            @retry_interval=0, 
            @os_run_priority=0, @subsystem=N'TSQL', 
            @command=N'EXEC msdb.dbo.sp_sysutility_ucp_calculate_health', 
            @database_name=N'msdb', 
            @flags=0

   EXEC @ReturnCode = msdb.dbo.sp_update_job @job_id = @jobId, @start_step_id = 1
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   
   EXEC @ReturnCode = msdb.dbo.sp_add_jobschedule @job_id=@jobId, @name=N'OccursEvery15Minutes', 
      @enabled=1, 
      @freq_type=4, 
      @freq_interval=1, 
      @freq_subday_type=4, 
      @freq_subday_interval=15, 
      @freq_relative_interval=0, 
      @freq_recurrence_factor=0, 
      @schedule_uid=N'7c3e972b-6e4b-4c61-9061-715d8b9ba531'
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   
   EXEC @ReturnCode = msdb.dbo.sp_add_jobserver @job_id = @jobId, @server_name = N'(local)'
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   
   -----------------------------------------------------------------------
   --  Remove the sysutility_get_cache_tables_data_into_aggregate_tables_hourly job if it is already existing.
   -----------------------------------------------------------------------
   DECLARE @job_id1 UNIQUEIDENTIFIER
   SELECT @job_id1 = job_id 
   FROM msdb.dbo.sysjobs_view 
   WHERE name = N'sysutility_get_cache_tables_data_into_aggregate_tables_hourly'

   IF EXISTS (SELECT job_id FROM msdb.dbo.sysjobs_view WHERE name = N'sysutility_get_cache_tables_data_into_aggregate_tables_hourly')
      EXEC msdb.dbo.sp_delete_job @job_id=@job_id1, @delete_unused_schedule=1
   
   -----------------------------------------------------------------------
   --  sysutility_get_cache_tables_data_into_aggregate_tables_hourly job has following steps:
   -- 1.  Aggregate current days data from [sysutility_ucp_core].[computer_cpu_utilizations_internal] 
   --     and put it into [sysutility_ucp_core].[aggregated_computer_cpu_utilizations_internal].
   -- 2.  Aggregate current days data from [sysutility_ucp_core].[dac_execution_statistics_internal] 
   --     and put it into [sysutility_ucp_core].[aggregated_dac_cpu_utilizations_internal].
   -- 3.  Aggregate current days data storage cache table into
   --     storage aggregation table
   -----------------------------------------------------------------------
   IF NOT EXISTS (SELECT name FROM msdb.dbo.syscategories WHERE name=N'[Uncategorized (Local)]' AND category_class=1)
   BEGIN
      EXEC @ReturnCode = msdb.dbo.sp_add_category @class=N'JOB', @type=N'LOCAL', @name=N'[Uncategorized (Local)]'
      IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   END

   DECLARE @jobId1 BINARY(16)
   EXEC @ReturnCode =  msdb.dbo.sp_add_job @job_name=N'sysutility_get_cache_tables_data_into_aggregate_tables_hourly', 
         @enabled=1, 
         @notify_level_eventlog=0, 
         @notify_level_email=0, 
         @notify_level_netsend=0, 
         @notify_level_page=0, 
         @delete_level=0,
         @description=N'At every hour''s stroke, the data of the cache tables get aggregated and put into corresponding aggregate by hour tables.', 
         @category_name=N'[Uncategorized (Local)]', 
         @owner_login_name=@CurrentLoggedIn, @job_id = @jobId1 OUTPUT
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback

   EXEC @ReturnCode = msdb.dbo.sp_add_jobstep @job_id=@jobId1, @step_name=N'Aggregate current hours data from the cache tables into the server aggregation table', 
         @step_id=1, 
         @cmdexec_success_code=0, 
         @on_success_action=1, 
         @on_success_step_id=0, 
         @on_fail_action=2, 
         @on_fail_step_id=0, 
         @retry_attempts=0, 
         @retry_interval=0, 
         @os_run_priority=0, @subsystem=N'TSQL', 
         @command=N'DECLARE @now DATETIMEOFFSET(7); SELECT @now = SYSDATETIMEOFFSET(); EXEC [sysutility_ucp_core].sp_copy_cache_table_data_into_aggregate_tables @aggregation_type=1, @endTime=@now',
         @database_name = @mdwDBName,
         @flags=0
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   
   
   EXEC @ReturnCode = msdb.dbo.sp_add_jobschedule @job_id=@jobId1, @name=N'OccursEveryOneHour', 
         @enabled=1, 
         @freq_type=4, 
         @freq_interval=1, 
         @freq_subday_type=8, 
         @freq_subday_interval=1, 
         @freq_relative_interval=0, 
         @freq_recurrence_factor=0,
         @active_start_time=100
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   
   
   -----------------------------------------------------------------------
   --  Remove the sysutility_get_cache_tables_data_into_aggregate_tables_daily job if it is already existing.
   -----------------------------------------------------------------------
   SELECT @job_id1 = job_id 
   FROM msdb.dbo.sysjobs_view 
   WHERE name = N'sysutility_get_cache_tables_data_into_aggregate_tables_daily'

   IF EXISTS (SELECT job_id FROM msdb.dbo.sysjobs_view WHERE name = N'sysutility_get_cache_tables_data_into_aggregate_tables_daily')
      EXEC msdb.dbo.sp_delete_job @job_id=@job_id1, @delete_unused_schedule=1
   
   -----------------------------------------------------------------------
   --  sysutility_get_cache_tables_data_into_aggregate_tables_daily job has following steps:
   -- 1. Aggregate current days data from [sysutility_ucp_core].[computer_cpu_utilizations_internal] 
   --    and put it into [sysutility_ucp_core].[aggregated_computer_cpu_utilizations_internal].
   -- 2. Aggregate current days data from [sysutility_ucp_core].[dac_execution_statistics_internal] 
   --    and put it into [sysutility_ucp_core].[aggregated_dac_cpu_utilizations_internal].
   -- 3. Aggregate current days data from storage cache table into
   --    storage aggregation table
   -----------------------------------------------------------------------
   IF NOT EXISTS (SELECT name FROM msdb.dbo.syscategories WHERE name=N'[Uncategorized (Local)]' AND category_class=1)
   BEGIN
      EXEC @ReturnCode = msdb.dbo.sp_add_category @class=N'JOB', @type=N'LOCAL', @name=N'[Uncategorized (Local)]'
      IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   END

   DECLARE @jobId2 BINARY(16)
   EXEC @ReturnCode =  msdb.dbo.sp_add_job @job_name=N'sysutility_get_cache_tables_data_into_aggregate_tables_daily', 
         @enabled=1, 
         @notify_level_eventlog=0, 
         @notify_level_email=0, 
         @notify_level_netsend=0, 
         @notify_level_page=0, 
         @delete_level=0, 
         @description=N'At every 12:01 AM stroke, the data of the cache tables get aggregated and put into corresponding aggregate by day tables.', 
         @category_name=N'[Uncategorized (Local)]', 
         @owner_login_name=@CurrentLoggedIn, @job_id = @jobId2 OUTPUT
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback

   EXEC @ReturnCode = msdb.dbo.sp_add_jobstep @job_id=@jobId2, @step_name=N'Aggregate current days data from the cache tables into the server aggregation table', 
         @step_id=1, 
         @cmdexec_success_code=0, 
         @on_success_action=3, 
         @on_success_step_id=0, 
         @on_fail_action=2, 
         @on_fail_step_id=0, 
         @retry_attempts=0, 
         @retry_interval=0, 
         @os_run_priority=0, @subsystem=N'TSQL', 
         @command=N'DECLARE @now DATETIME; SELECT @now = GETUTCDATE(); EXEC [sysutility_ucp_core].sp_copy_cache_table_data_into_aggregate_tables @aggregation_type=2, @endTime=@now',
         @database_name = @mdwDBName,
         @flags=0
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   
   
   EXEC @ReturnCode = msdb.dbo.sp_add_jobstep @job_id=@jobId2, @step_name=N'Purge cache table history data based on retention period', 
      @step_id=2, 
      @cmdexec_success_code=0, 
      @on_success_action=3, 
      @on_success_step_id=0, 
      @on_fail_action=2, 
      @on_fail_step_id=0, 
      @retry_attempts=0, 
      @retry_interval=0, 
      @os_run_priority=0, @subsystem=N'TSQL', 
      @command=N'EXEC [sysutility_ucp_core].[sp_purge_cache_tables];', 
      @database_name = @mdwDBName,
      @flags=0
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback

   EXEC @ReturnCode = msdb.dbo.sp_add_jobstep @job_id=@jobId2, @step_name=N'Purge resource health policy evaluation history based on trailing window', 
      @step_id=3, 
      @cmdexec_success_code=0, 
      @on_success_action=1, 
      @on_success_step_id=0, 
      @on_fail_action=2, 
      @on_fail_step_id=0, 
      @retry_attempts=0, 
      @retry_interval=0, 
      @os_run_priority=0, @subsystem=N'TSQL', 
      @command=N'EXEC msdb.dbo.sp_sysutility_ucp_delete_policy_history', 
      @database_name=N'msdb', 
      @flags=0      
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback

   EXEC @ReturnCode = msdb.dbo.sp_update_job @job_id = @jobId1, @start_step_id = 1
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback

   EXEC @ReturnCode = msdb.dbo.sp_add_jobschedule @job_id=@jobId2, @name=N'OccursOnceADayAt12:01AM', 
         @enabled=1, 
         @freq_type=4, 
         @freq_interval=1, 
         @freq_subday_type=1, 
         @freq_subday_interval=0, 
         @freq_relative_interval=0, 
         @freq_recurrence_factor=0, 
         @active_start_date=20080218, 
         @active_end_date=99991231, 
         @active_start_time=100, 
         @active_end_time=235959, 
         @schedule_uid=N'acb4d2d5-d2ee-4d33-b82e-a296a41fc225'
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback

   EXEC @ReturnCode = msdb.dbo.sp_add_jobserver @job_id = @jobId1, @server_name = N'(local)'
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback
   
   EXEC @ReturnCode = msdb.dbo.sp_add_jobserver @job_id = @jobId2, @server_name = N'(local)'
   IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback


-- Commit our transaction
COMMIT TRANSACTION

GOTO EndSave
QuitWithRollback:
IF (@@TRANCOUNT > 0) ROLLBACK TRANSACTION
EndSave:
GO

-- Commit our transaction
COMMIT TRANSACTION
GO


/**********************************************************************/
/* Setup Utility object permissions                                   */
/**********************************************************************/

/**********************************************************************
   Create the UtilityMDWWriter role. This role is granted to proxy 
   accounts that run the DC upload step on each MI.  It allows these 
   accounts to insert data into the Utility "live" tables in MDW. 
***********************************************************************/
RAISERROR ('Create UtilityMDWWriter role...', 0, 1) WITH NOWAIT;
IF ( NOT EXISTS (SELECT * FROM sys.database_principals 
                    WHERE name = N'UtilityMDWWriter' AND type = 'R'))
BEGIN
    CREATE ROLE [UtilityMDWWriter]
END
ELSE -- if the role exists check to see if it has members
BEGIN
    IF NOT EXISTS (SELECT rm.member_principal_id
                FROM sys.database_principals dp 
                INNER JOIN sys.database_role_members rm ON rm.role_principal_id = dp.principal_id
                WHERE name = N'UtilityMDWWriter' AND type = 'R')
    BEGIN
        -- if the role has no members drop and recreate it
        DROP ROLE [UtilityMDWWriter]
        CREATE ROLE [UtilityMDWWriter]
    END
END
GO

-- UtilityMDWWriter is a member of the mdw_writer role; this will give it 
-- INSERT, EXEC, and SELECT permissions on anything in the [snapshots] schema. 
EXECUTE sp_addrolemember @rolename = 'mdw_writer' , 
                   @membername = 'UtilityMDWWriter' 
GO


/**********************************************************************
   Create the UtilityMDWCacheReader role. This sysutility_mdw role       
   corresponds to the UtilityCMRReader role in msdb.  A "CMRReader" 
   can select from objects in msdb that expose data in cache tables 
   in sysutility_mdw. The "CacheReader" role in sysutility_mdw secures 
   these cache tables/functions in the MDW db. A login should be a 
   member of both roles in order to run the UCP data processing job. 
***********************************************************************/
RAISERROR ('Create UtilityMDWCacheReader role...', 0, 1) WITH NOWAIT;
IF ( NOT EXISTS (SELECT * FROM sys.database_principals 
                    WHERE name = N'UtilityMDWCacheReader' AND type = 'R'))
BEGIN
    CREATE ROLE [UtilityMDWCacheReader];
END
ELSE -- if the role exists check to see if it has members
BEGIN
    IF NOT EXISTS (SELECT rm.member_principal_id
                FROM sys.database_principals dp 
                INNER JOIN sys.database_role_members rm ON rm.role_principal_id = dp.principal_id
                WHERE name = N'UtilityMDWCacheReader' AND type = 'R')
    BEGIN
        -- if the role has no members drop and recreate it
        DROP ROLE [UtilityMDWCacheReader];
        CREATE ROLE [UtilityMDWCacheReader];
    END;
END;
GO

-- Grant SELECT or EXECUTE on the cache functions/views at the boundary of msdb and 
-- sysutility_mdw.  These objects are directly referenced by objects in msdb.  
RAISERROR ('Granting permission on MDW cache objects to UtilityMDWCacheReader role', 0, 1) WITH NOWAIT;

-- Dimensions
GRANT SELECT  ON [sysutility_ucp_core].[latest_dacs]            TO [UtilityMDWCacheReader];
GRANT SELECT  ON [sysutility_ucp_core].[latest_computers]       TO [UtilityMDWCacheReader];
GRANT SELECT  ON [sysutility_ucp_core].[latest_volumes]         TO [UtilityMDWCacheReader];

GRANT SELECT  ON [sysutility_ucp_core].[latest_smo_servers]     TO [UtilityMDWCacheReader];
GRANT SELECT  ON [sysutility_ucp_core].[latest_databases]       TO [UtilityMDWCacheReader];
GRANT SELECT  ON [sysutility_ucp_core].[latest_filegroups]      TO [UtilityMDWCacheReader];
GRANT SELECT  ON [sysutility_ucp_core].[latest_datafiles]       TO [UtilityMDWCacheReader];
GRANT SELECT  ON [sysutility_ucp_core].[latest_logfiles]        TO [UtilityMDWCacheReader];

-- Measures
GRANT SELECT  ON [sysutility_ucp_core].[cpu_utilization]        TO [UtilityMDWCacheReader];
GRANT SELECT  ON [sysutility_ucp_core].[space_utilization]      TO [UtilityMDWCacheReader];

GO

-- Put the database back into multi user mode
RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('Restoring database to multi user mode', 0, 1)  WITH NOWAIT;
DECLARE @dbname sysname
SET @dbname = QUOTENAME(DB_NAME())

DECLARE @sql_db_multi_mode nvarchar(256)
SET @sql_db_multi_mode = 'ALTER DATABASE ' + @dbname +
                                    ' SET MULTI_USER WITH ROLLBACK IMMEDIATE'
EXEC sp_executesql @sql_db_multi_mode

-- check if sync auto stats was on
IF (EXISTS (SELECT * FROM #tmp_auto_mode))  -- if yes, turn it back on
BEGIN
    RAISERROR('', 0, 1)  WITH NOWAIT;
    RAISERROR('Re-enabling asynchronous auto statistics ...', 0, 1)  WITH NOWAIT;
    DECLARE @sql_async_autostat_on nvarchar(256)
    SET @sql_async_autostat_on = 'ALTER DATABASE ' + @dbname +
                                        ' SET AUTO_UPDATE_STATISTICS_ASYNC ON'
    EXEC sp_executesql @sql_async_autostat_on
END
DROP TABLE #tmp_auto_mode

RAISERROR('', 0, 1)  WITH NOWAIT;
RAISERROR('----------------------------------', 0, 1)  WITH NOWAIT;
RAISERROR('Execution of INSTMDW.SQL complete', 0, 1)  WITH NOWAIT;
RAISERROR('----------------------------------', 0, 1)  WITH NOWAIT;
GO


