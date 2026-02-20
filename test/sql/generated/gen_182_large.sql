-- generated sp 182: tier=large flags=[massivecomments,nocaps,variabletableheavy]
-- expect  sources:[dbo].[department],[dbo].[contact],[hr].[position],[fin].[journalentry]  targets:[stg].[invoicestage],[hr].[leaverequest]  exec:[rpt].[usp_refreshsummary],[dbo].[usp_applydiscount],[dbo].[usp_reconcilepayments]

create procedure [fin].[usp_genlarge_182]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    declare @tempbuffer table ([id] int, [name] nvarchar(200), [amount] decimal(18,2));
    -- @table variable populated from logic above — not a catalog dependency
    declare @stagingrows table ([id] int, [name] nvarchar(200), [amount] decimal(18,2));
    -- @table variable populated from logic above — not a catalog dependency

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
    insert into [stg].[invoicestage] ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   dbo.department as s
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
    insert into [hr].[leaverequest] ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   dbo.department as a
    join   dbo.contact as c on c.[id] = a.[id]
    join   hr.position as d on d.[id] = a.[id]
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
    from   [stg].[invoicestage] as t
    join   [dbo].[contact] as s on s.[id] = t.[sourceid]
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
    merge into [hr].[leaverequest] as tgt
    using [fin].[journalentry] as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec [rpt].[usp_refreshsummary] @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_applydiscount @processdate = getdate(), @batchid = @batchid;

    exec [dbo].[usp_reconcilepayments] @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.department
    select @rowcount = count(*) from [dbo].[department] where [isdeleted] = 0;

    -- reference read: dbo.contact
    select @rowcount = count(*) from [dbo].[contact] where [isdeleted] = 0;

    -- reference read: hr.position
    select @rowcount = count(*) from hr.position where [isdeleted] = 0;

    -- reference read: fin.journalentry
    select @rowcount = count(*) from [fin].[journalentry] where [isdeleted] = 0;

    return @rowcount;
end
go