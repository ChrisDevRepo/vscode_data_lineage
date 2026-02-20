-- generated sp 202: tier=large flags=[massivecomments,printstatements,nocaps]
-- expect  sources:[dbo].[department],[fin].[costcenter],[rpt].[salessummary],[stg].[invoicestage],[fin].[account]  targets:[etl].[errorlog],[etl].[extractlog],[rpt].[regionmetrics]  exec:[dbo].[usp_archiveorders],[dbo].[usp_reconcilepayments]

create procedure [fin].[usp_genlarge_202]
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
    insert into [etl].[errorlog] ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   dbo.department as s
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
    insert into [etl].[extractlog] ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   [dbo].[department] as a
    join   [fin].[costcenter] as c on c.[id] = a.[id]
    join   rpt.salessummary as d on d.[id] = a.[id]
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
    insert into rpt.regionmetrics ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   [dbo].[department] as a
    join   [fin].[costcenter] as c on c.[id] = a.[id]
    join   [rpt].[salessummary] as d on d.[id] = a.[id]
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
    from   etl.errorlog as t
    join   [fin].[costcenter] as s on s.[id] = t.[sourceid]
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
    merge into rpt.regionmetrics as tgt
    using fin.account as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec dbo.usp_archiveorders @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_reconcilepayments @processdate = getdate(), @batchid = @batchid;

    -- reference read: [dbo].[department]
    select @rowcount = count(*) from [dbo].[department] where [isdeleted] = 0;

    -- reference read: fin.costcenter
    select @rowcount = count(*) from fin.costcenter where [isdeleted] = 0;

    -- reference read: [rpt].[salessummary]
    select @rowcount = count(*) from [rpt].[salessummary] where [isdeleted] = 0;

    -- reference read: [stg].[invoicestage]
    select @rowcount = count(*) from stg.invoicestage where [isdeleted] = 0;

    -- reference read: [fin].[account]
    select @rowcount = count(*) from [fin].[account] where [isdeleted] = 0;

    return @rowcount;
end
go