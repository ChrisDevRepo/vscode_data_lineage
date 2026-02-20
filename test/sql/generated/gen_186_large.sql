-- generated sp 186: tier=large flags=[nobrackets,nocaps,massivecomments]
-- expect  sources:[dbo].[employee],[dbo].[department],[dbo].[orderline],[stg].[paymentstage]  targets:[hr].[leaverequest],[fin].[transaction]  exec:[rpt].[usp_refreshsummary],[fin].[usp_postjournal],[dbo].[usp_reconcilepayments],[etl].[usp_loadcustomers],[hr].[usp_approveleave]

create procedure [rpt].[usp_genlarge_186]
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
    insert into hr.leaverequest ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   dbo.employee as s
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
    insert into fin.transaction ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   dbo.employee as a
    join   dbo.department as c on c.[id] = a.[id]
    join   dbo.orderline as d on d.[id] = a.[id]
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
    from   hr.leaverequest as t
    join   dbo.department as s on s.[id] = t.[sourceid]
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
    merge into fin.transaction as tgt
    using stg.paymentstage as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec rpt.usp_refreshsummary @processdate = getdate(), @batchid = @batchid;

    exec fin.usp_postjournal @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_reconcilepayments @processdate = getdate(), @batchid = @batchid;

    exec etl.usp_loadcustomers @processdate = getdate(), @batchid = @batchid;

    exec hr.usp_approveleave @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.employee
    select @rowcount = count(*) from dbo.employee where [isdeleted] = 0;

    -- reference read: dbo.department
    select @rowcount = count(*) from dbo.department where [isdeleted] = 0;

    -- reference read: dbo.orderline
    select @rowcount = count(*) from dbo.orderline where [isdeleted] = 0;

    -- reference read: stg.paymentstage
    select @rowcount = count(*) from stg.paymentstage where [isdeleted] = 0;

    return @rowcount;
end
go