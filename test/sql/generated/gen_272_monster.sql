-- generated sp 272: tier=monster flags=[nestedsubqueries,massivecomments,nocaps,printstatements,bracketedeverything,commentedoutsql]
-- expect  sources:[dbo].[employee],[dbo].[orderline],[dbo].[warehouse],[ops].[inventory]  targets:[rpt].[productrevenue],[dbo].[invoice],[etl].[batchcontrol]  exec:[dbo].[usp_updatecustomer],[dbo].[usp_processorder],[etl].[usp_loadproducts],[etl].[usp_loadorders],[dbo].[usp_applydiscount],[audit].[usp_logchange],[dbo].[usp_generateinvoice],[audit].[usp_logaccess],[etl].[usp_loadcustomers],[etl].[usp_validatestage]

create procedure [hr].[usp_genmonster_272]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    -- old code (removed 2019-06-15) — kept for reference:
    -- insert into dbo.deprecatedlog (entityid, action, logdate)
    -- select id, n'process', getdate() from dbo.oldlegacytable where status = 0
    -- update dbo.oldflag set active = 0 where processdate < '2019-01-01'
    -- exec dbo.usp_oldarchive @cutoff = '2019-01-01'

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
    insert into [rpt].[productrevenue] ([id], [name])
    select x.[id], x.[name]
    from (
        select i.[id], i.[name], row_number() over (order by i.[updateddate] desc) as rn
        from (
            select [id], [name], [updateddate]
            from   [dbo].[employee]
            where  [isdeleted] = 0
        ) as i
    ) as x
    where x.rn = 1;
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
    insert into [dbo].[invoice] ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   [dbo].[employee] as a
    join   [dbo].[orderline] as c on c.[id] = a.[id]
    join   [dbo].[warehouse] as d on d.[id] = a.[id]
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
    insert into [etl].[batchcontrol] ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   [dbo].[employee] as a
    join   [dbo].[orderline] as c on c.[id] = a.[id]
    join   [dbo].[warehouse] as d on d.[id] = a.[id]
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
    from   [rpt].[productrevenue] as t
    join   [dbo].[orderline] as s on s.[id] = t.[sourceid]
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
    merge into [etl].[batchcontrol] as tgt
    using [ops].[inventory] as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec [dbo].[usp_updatecustomer] @processdate = getdate(), @batchid = @batchid;

    exec [dbo].[usp_processorder] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadproducts] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadorders] @processdate = getdate(), @batchid = @batchid;

    exec [dbo].[usp_applydiscount] @processdate = getdate(), @batchid = @batchid;

    exec [audit].[usp_logchange] @processdate = getdate(), @batchid = @batchid;

    exec [dbo].[usp_generateinvoice] @processdate = getdate(), @batchid = @batchid;

    exec [audit].[usp_logaccess] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadcustomers] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_validatestage] @processdate = getdate(), @batchid = @batchid;

    -- reference read: [dbo].[employee]
    select @rowcount = count(*) from [dbo].[employee] where [isdeleted] = 0;

    -- reference read: [dbo].[orderline]
    select @rowcount = count(*) from [dbo].[orderline] where [isdeleted] = 0;

    -- reference read: [dbo].[warehouse]
    select @rowcount = count(*) from [dbo].[warehouse] where [isdeleted] = 0;

    -- reference read: [ops].[inventory]
    select @rowcount = count(*) from [ops].[inventory] where [isdeleted] = 0;

    return @rowcount;
end
go