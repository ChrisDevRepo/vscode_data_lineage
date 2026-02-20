-- generated sp 189: tier=large flags=[massivecomments,deeptrycatch,nocaps]
-- expect  sources:[dbo].[transaction],[rpt].[regionmetrics],[etl].[errorlog],[dbo].[address],[dbo].[warehouse]  targets:[fin].[account],[rpt].[employeeperf],[etl].[loadlog]  exec:[dbo].[usp_processorder],[rpt].[usp_refreshsummary],[dbo].[usp_reconcilepayments],[etl].[usp_loadcustomers]

create procedure [ops].[usp_genlarge_189]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    /*
     * ─── processing block 1 ─────────────────────────────────────────────────
     * this section handles the core etl for batch 1.
     * original implementation: 2015-03-12 (developer: j.smith)
     * last modified: 2022-11-08 (developer: m.jones) — added retry logic
     *
     * legacy note: the following was removed in v3.2:
     *   -- insert into dbo.oldarchive select * from dbo.deprecated where status = 1
     *   -- update dbo.legacy set flag = 0
     *
     * do not re-enable the above — table dbo.oldarchive was dropped 2020-04-01
     */
    begin try
        begin try
            insert into fin.account ([sourceid], [sourcename], [loadedat])
            select s.[id], s.[name], getutcdate()
            from   [dbo].[transaction] as s
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
    set @rowcount = @rowcount + @@rowcount;

    /*
     * ─── processing block 2 ─────────────────────────────────────────────────
     * this section handles the core etl for batch 2.
     * original implementation: 2015-03-12 (developer: j.smith)
     * last modified: 2022-11-08 (developer: m.jones) — added retry logic
     *
     * legacy note: the following was removed in v3.2:
     *   -- insert into dbo.oldarchive select * from dbo.deprecated where status = 1
     *   -- update dbo.legacy set flag = 0
     *
     * do not re-enable the above — table dbo.oldarchive was dropped 2020-04-01
     */
    begin try
        begin try
            insert into [rpt].[employeeperf] ([sourceid], [refid], [amount], [loadedat])
            select
                a.[id]          as sourceid,
                b.[id]          as refid,
                isnull(a.[amount], 0) as amount,
                getutcdate()    as loadedat
            from   dbo.transaction as a
            join   rpt.regionmetrics as c on c.[id] = a.[id]
            join   etl.errorlog as d on d.[id] = a.[id]
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
    set @rowcount = @rowcount + @@rowcount;

    /*
     * ─── processing block 3 ─────────────────────────────────────────────────
     * this section handles the core etl for batch 3.
     * original implementation: 2015-03-12 (developer: j.smith)
     * last modified: 2022-11-08 (developer: m.jones) — added retry logic
     *
     * legacy note: the following was removed in v3.2:
     *   -- insert into dbo.oldarchive select * from dbo.deprecated where status = 1
     *   -- update dbo.legacy set flag = 0
     *
     * do not re-enable the above — table dbo.oldarchive was dropped 2020-04-01
     */
    begin try
        begin try
            insert into etl.loadlog ([sourceid], [refid], [amount], [loadedat])
            select
                a.[id]          as sourceid,
                b.[id]          as refid,
                isnull(a.[amount], 0) as amount,
                getutcdate()    as loadedat
            from   dbo.transaction as a
            join   rpt.regionmetrics as c on c.[id] = a.[id]
            join   [etl].[errorlog] as d on d.[id] = a.[id]
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
    set @rowcount = @rowcount + @@rowcount;

    /*
     * ─── processing block 4 ─────────────────────────────────────────────────
     * this section handles the core etl for batch 4.
     * original implementation: 2015-03-12 (developer: j.smith)
     * last modified: 2022-11-08 (developer: m.jones) — added retry logic
     *
     * legacy note: the following was removed in v3.2:
     *   -- insert into dbo.oldarchive select * from dbo.deprecated where status = 1
     *   -- update dbo.legacy set flag = 0
     *
     * do not re-enable the above — table dbo.oldarchive was dropped 2020-04-01
     */
    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   fin.account as t
    join   [rpt].[regionmetrics] as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    /*
     * ─── processing block 5 ─────────────────────────────────────────────────
     * this section handles the core etl for batch 5.
     * original implementation: 2015-03-12 (developer: j.smith)
     * last modified: 2022-11-08 (developer: m.jones) — added retry logic
     *
     * legacy note: the following was removed in v3.2:
     *   -- insert into dbo.oldarchive select * from dbo.deprecated where status = 1
     *   -- update dbo.legacy set flag = 0
     *
     * do not re-enable the above — table dbo.oldarchive was dropped 2020-04-01
     */
    merge into etl.loadlog as tgt
    using [dbo].[warehouse] as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec [dbo].[usp_processorder] @processdate = getdate(), @batchid = @batchid;

    exec [rpt].[usp_refreshsummary] @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_reconcilepayments @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadcustomers] @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.transaction
    select @rowcount = count(*) from [dbo].[transaction] where [isdeleted] = 0;

    -- reference read: [rpt].[regionmetrics]
    select @rowcount = count(*) from [rpt].[regionmetrics] where [isdeleted] = 0;

    -- reference read: etl.errorlog
    select @rowcount = count(*) from [etl].[errorlog] where [isdeleted] = 0;

    -- reference read: [dbo].[address]
    select @rowcount = count(*) from dbo.address where [isdeleted] = 0;

    -- reference read: dbo.warehouse
    select @rowcount = count(*) from [dbo].[warehouse] where [isdeleted] = 0;

    return @rowcount;
end
go