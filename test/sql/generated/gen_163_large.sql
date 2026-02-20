-- generated sp 163: tier=large flags=[nobrackets,nocaps,massivecomments]
-- expect  sources:[dbo].[invoice],[dbo].[region],[ops].[inventory],[dbo].[address],[stg].[productstage]  targets:[dbo].[contact],[rpt].[employeeperf]  exec:[dbo].[usp_archiveorders],[etl].[usp_loadcustomers],[dbo].[usp_generateinvoice]

create procedure [etl].[usp_genlarge_163]
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
    insert into dbo.contact ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   dbo.invoice as s
    where  s.[isdeleted] = 0;
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
    insert into rpt.employeeperf ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   dbo.invoice as a
    join   dbo.region as c on c.[id] = a.[id]
    join   ops.inventory as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
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
    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   dbo.contact as t
    join   dbo.region as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
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
    merge into rpt.employeeperf as tgt
    using stg.productstage as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec dbo.usp_archiveorders @processdate = getdate(), @batchid = @batchid;

    exec etl.usp_loadcustomers @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_generateinvoice @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.invoice
    select @rowcount = count(*) from dbo.invoice where [isdeleted] = 0;

    -- reference read: dbo.region
    select @rowcount = count(*) from dbo.region where [isdeleted] = 0;

    -- reference read: ops.inventory
    select @rowcount = count(*) from ops.inventory where [isdeleted] = 0;

    -- reference read: dbo.address
    select @rowcount = count(*) from dbo.address where [isdeleted] = 0;

    -- reference read: stg.productstage
    select @rowcount = count(*) from stg.productstage where [isdeleted] = 0;

    return @rowcount;
end
go