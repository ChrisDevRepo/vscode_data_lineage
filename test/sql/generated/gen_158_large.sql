-- generated sp 158: tier=large flags=[massivecomments,nocaps,printstatements]
-- expect  sources:[dbo].[transaction],[dbo].[orderline],[stg].[productstage],[stg].[invoicestage],[dbo].[product],[fin].[account]  targets:[rpt].[monthlyorders],[dbo].[address],[fin].[costcenter]  exec:[dbo].[usp_updatecustomer],[hr].[usp_approveleave],[etl].[usp_loadorders],[audit].[usp_logaccess],[dbo].[usp_generateinvoice],[fin].[usp_postjournal]

create procedure [ops].[usp_genlarge_158]
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
    insert into [rpt].[monthlyorders] ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   dbo.transaction as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    print n'step 1: processing batch @batchid = ' + cast(@batchid as nvarchar) + n', elapsed: ' + cast(datediff(ms, @starttime, getutcdate()) as nvarchar) + n' ms';

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
    insert into [dbo].[address] ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   dbo.transaction as a
    join   [dbo].[orderline] as c on c.[id] = a.[id]
    join   [stg].[productstage] as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    print n'step 2: processing batch @batchid = ' + cast(@batchid as nvarchar) + n', elapsed: ' + cast(datediff(ms, @starttime, getutcdate()) as nvarchar) + n' ms';

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
    insert into [fin].[costcenter] ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   dbo.transaction as a
    join   [dbo].[orderline] as c on c.[id] = a.[id]
    join   [stg].[productstage] as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    print n'step 3: processing batch @batchid = ' + cast(@batchid as nvarchar) + n', elapsed: ' + cast(datediff(ms, @starttime, getutcdate()) as nvarchar) + n' ms';

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
    from   rpt.monthlyorders as t
    join   dbo.orderline as s on s.[id] = t.[sourceid]
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
    merge into fin.costcenter as tgt
    using fin.account as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec dbo.usp_updatecustomer @processdate = getdate(), @batchid = @batchid;

    exec hr.usp_approveleave @processdate = getdate(), @batchid = @batchid;

    exec etl.usp_loadorders @processdate = getdate(), @batchid = @batchid;

    exec [audit].[usp_logaccess] @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_generateinvoice @processdate = getdate(), @batchid = @batchid;

    exec fin.usp_postjournal @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.transaction
    select @rowcount = count(*) from dbo.transaction where [isdeleted] = 0;

    -- reference read: [dbo].[orderline]
    select @rowcount = count(*) from dbo.orderline where [isdeleted] = 0;

    -- reference read: stg.productstage
    select @rowcount = count(*) from [stg].[productstage] where [isdeleted] = 0;

    -- reference read: [stg].[invoicestage]
    select @rowcount = count(*) from [stg].[invoicestage] where [isdeleted] = 0;

    -- reference read: dbo.product
    select @rowcount = count(*) from dbo.product where [isdeleted] = 0;

    -- reference read: fin.account
    select @rowcount = count(*) from fin.account where [isdeleted] = 0;

    return @rowcount;
end
go