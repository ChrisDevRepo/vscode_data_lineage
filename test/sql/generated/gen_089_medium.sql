-- generated sp 89: tier=medium flags=[massivecomments,nocaps]
-- expect  sources:[fin].[transaction],[dbo].[product],[rpt].[productrevenue],[fin].[budget]  targets:[etl].[errorlog]  exec:[dbo].[usp_updatecustomer]

create procedure [ops].[usp_genmedium_089]
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
    from   fin.transaction as s
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
    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   [etl].[errorlog] as t
    join   dbo.product as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    exec dbo.usp_updatecustomer @processdate = getdate(), @batchid = @batchid;

    -- reference read: fin.transaction
    select @rowcount = count(*) from fin.transaction where [isdeleted] = 0;

    -- reference read: [dbo].[product]
    select @rowcount = count(*) from dbo.product where [isdeleted] = 0;

    -- reference read: [rpt].[productrevenue]
    select @rowcount = count(*) from [rpt].[productrevenue] where [isdeleted] = 0;

    -- reference read: [fin].[budget]
    select @rowcount = count(*) from fin.budget where [isdeleted] = 0;

    return @rowcount;
end
go