-- generated sp 270: tier=monster flags=[bracketedeverything,deeptrycatch,nocaps,excessivedeclare,variabletableheavy,nobrackets]
-- expect  sources:[rpt].[productrevenue],[dbo].[warehouse],[etl].[extractlog],[hr].[position]  targets:[etl].[errorlog],[dbo].[product],[dbo].[address]  exec:[dbo].[usp_generateinvoice],[etl].[usp_loadorders],[rpt].[usp_refreshsummary],[etl].[usp_loadproducts],[audit].[usp_logchange],[etl].[usp_validatestage],[etl].[usp_loadcustomers]

create procedure [etl].[usp_genmonster_270]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @batchid int = 0;
    declare @processdate datetime = getdate();
    declare @rowcount int;
    declare @errormessage nvarchar(4000);
    declare @errorseverity int;
    declare @errorstate int;
    declare @retrycount int = 0;
    declare @maxretries int = 3;
    declare @starttime datetime = getutcdate();
    declare @endtime datetime;
    declare @debugmode bit = 0;
    declare @schemaversion nvarchar(20) = n'1.0';
    declare @procname nvarchar(128) = object_name(@@procid);
    declare @appname nvarchar(128) = app_name();
    declare @hostname nvarchar(128) = host_name();
    declare @username nvarchar(128) = suser_sname();
    declare @dbname nvarchar(128) = db_name();
    declare @servername nvarchar(128) = @@servername;
    declare @spid int = @@spid;
    declare @nestlevel int = @@nestlevel;

    declare @tempbuffer table ([id] int, [name] nvarchar(200), [amount] decimal(18,2));
    -- @table variable populated from logic above — not a catalog dependency
    declare @stagingrows table ([id] int, [name] nvarchar(200), [amount] decimal(18,2));
    -- @table variable populated from logic above — not a catalog dependency

    begin try
        begin try
            begin try
                insert into [etl].[errorlog] ([sourceid], [sourcename], [loadedat])
                select s.[id], s.[name], getutcdate()
                from   [rpt].[productrevenue] as s
                where  s.[isdeleted] = 0;
            end try
            begin catch
                set @errormessage = error_message();
                set @errorseverity = error_severity();
                set @errorstate = error_state();
                raiserror(@errormessage, @errorseverity, @errorstate);
            end catch
        end try
        begin catch
            set @errormessage = error_message();
            set @errorseverity = error_severity();
            set @errorstate = error_state();
            raiserror(@errormessage, @errorseverity, @errorstate);
        end catch
    end try
    begin catch
        set @errormessage = error_message();
        set @errorseverity = error_severity();
        set @errorstate = error_state();
        raiserror(@errormessage, @errorseverity, @errorstate);
    end catch
    set @rowcount = @rowcount + @@rowcount;

    begin try
        begin try
            begin try
                insert into [dbo].[product] ([sourceid], [refid], [amount], [loadedat])
                select
                    a.[id]          as sourceid,
                    b.[id]          as refid,
                    isnull(a.[amount], 0) as amount,
                    getutcdate()    as loadedat
                from   [rpt].[productrevenue] as a
                join   [dbo].[warehouse] as c on c.[id] = a.[id]
                join   [etl].[extractlog] as d on d.[id] = a.[id]
                where  a.[status] = n'pending';
            end try
            begin catch
                set @errormessage = error_message();
                set @errorseverity = error_severity();
                set @errorstate = error_state();
                raiserror(@errormessage, @errorseverity, @errorstate);
            end catch
        end try
        begin catch
            set @errormessage = error_message();
            set @errorseverity = error_severity();
            set @errorstate = error_state();
            raiserror(@errormessage, @errorseverity, @errorstate);
        end catch
    end try
    begin catch
        set @errormessage = error_message();
        set @errorseverity = error_severity();
        set @errorstate = error_state();
        raiserror(@errormessage, @errorseverity, @errorstate);
    end catch
    set @rowcount = @rowcount + @@rowcount;

    begin try
        begin try
            begin try
                insert into [dbo].[address] ([sourceid], [refid], [amount], [loadedat])
                select
                    a.[id]          as sourceid,
                    b.[id]          as refid,
                    isnull(a.[amount], 0) as amount,
                    getutcdate()    as loadedat
                from   [rpt].[productrevenue] as a
                join   [dbo].[warehouse] as c on c.[id] = a.[id]
                join   [etl].[extractlog] as d on d.[id] = a.[id]
                where  a.[status] = n'pending';
            end try
            begin catch
                set @errormessage = error_message();
                set @errorseverity = error_severity();
                set @errorstate = error_state();
                raiserror(@errormessage, @errorseverity, @errorstate);
            end catch
        end try
        begin catch
            set @errormessage = error_message();
            set @errorseverity = error_severity();
            set @errorstate = error_state();
            raiserror(@errormessage, @errorseverity, @errorstate);
        end catch
    end try
    begin catch
        set @errormessage = error_message();
        set @errorseverity = error_severity();
        set @errorstate = error_state();
        raiserror(@errormessage, @errorseverity, @errorstate);
    end catch
    set @rowcount = @rowcount + @@rowcount;

    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   [etl].[errorlog] as t
    join   [dbo].[warehouse] as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    merge into [dbo].[address] as tgt
    using [hr].[position] as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec [dbo].[usp_generateinvoice] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadorders] @processdate = getdate(), @batchid = @batchid;

    exec [rpt].[usp_refreshsummary] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadproducts] @processdate = getdate(), @batchid = @batchid;

    exec [audit].[usp_logchange] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_validatestage] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadcustomers] @processdate = getdate(), @batchid = @batchid;

    -- reference read: [rpt].[productrevenue]
    select @rowcount = count(*) from [rpt].[productrevenue] where [isdeleted] = 0;

    -- reference read: [dbo].[warehouse]
    select @rowcount = count(*) from [dbo].[warehouse] where [isdeleted] = 0;

    -- reference read: [etl].[extractlog]
    select @rowcount = count(*) from [etl].[extractlog] where [isdeleted] = 0;

    -- reference read: [hr].[position]
    select @rowcount = count(*) from [hr].[position] where [isdeleted] = 0;

    return @rowcount;
end
go