-- generated sp 215: tier=large flags=[massivecomments,nocaps,excessivedeclare]
-- expect  sources:[dbo].[address],[dbo].[product],[dbo].[region],[dbo].[salestarget],[dbo].[customer],[ops].[shipment]  targets:[dbo].[warehouse],[dbo].[transaction]  exec:[etl].[usp_loadcustomers],[dbo].[usp_applydiscount],[dbo].[usp_processorder]

create procedure [dbo].[usp_genlarge_215]
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
    insert into dbo.warehouse ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   dbo.address as s
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
    insert into dbo.transaction ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   [dbo].[address] as a
    join   dbo.product as c on c.[id] = a.[id]
    join   [dbo].[region] as d on d.[id] = a.[id]
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
    from   [dbo].[warehouse] as t
    join   dbo.product as s on s.[id] = t.[sourceid]
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
    merge into [dbo].[transaction] as tgt
    using ops.shipment as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec [etl].[usp_loadcustomers] @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_applydiscount @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_processorder @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.address
    select @rowcount = count(*) from [dbo].[address] where [isdeleted] = 0;

    -- reference read: dbo.product
    select @rowcount = count(*) from dbo.product where [isdeleted] = 0;

    -- reference read: [dbo].[region]
    select @rowcount = count(*) from [dbo].[region] where [isdeleted] = 0;

    -- reference read: [dbo].[salestarget]
    select @rowcount = count(*) from [dbo].[salestarget] where [isdeleted] = 0;

    -- reference read: dbo.customer
    select @rowcount = count(*) from [dbo].[customer] where [isdeleted] = 0;

    -- reference read: ops.shipment
    select @rowcount = count(*) from ops.shipment where [isdeleted] = 0;

    return @rowcount;
end
go