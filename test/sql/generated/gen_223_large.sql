-- generated sp 223: tier=large flags=[transactionblocks,nestedsubqueries,nocaps]
-- expect  sources:[audit].[changelog],[fin].[transaction],[dbo].[salestarget],[dbo].[customer]  targets:[dbo].[category],[dbo].[shipper],[dbo].[warehouse]  exec:[audit].[usp_logchange],[etl].[usp_loadorders],[etl].[usp_validatestage],[dbo].[usp_updatecustomer]

create procedure [rpt].[usp_genlarge_223]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    begin transaction;
    insert into dbo.category ([id], [name])
    select x.[id], x.[name]
    from (
        select i.[id], i.[name], row_number() over (order by i.[updateddate] desc) as rn
        from (
            select [id], [name], [updateddate]
            from   audit.changelog
            where  [isdeleted] = 0
        ) as i
    ) as x
    where x.rn = 1;
    if @@error = 0
        commit transaction;
    else
        rollback transaction;
    set @rowcount = @rowcount + @@rowcount;

    insert into dbo.shipper ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   [audit].[changelog] as a
    join   [fin].[transaction] as c on c.[id] = a.[id]
    join   [dbo].[salestarget] as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    insert into [dbo].[warehouse] ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   [audit].[changelog] as a
    join   [fin].[transaction] as c on c.[id] = a.[id]
    join   dbo.salestarget as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   dbo.category as t
    join   fin.transaction as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    merge into dbo.warehouse as tgt
    using [dbo].[customer] as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec [audit].[usp_logchange] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadorders] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_validatestage] @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_updatecustomer @processdate = getdate(), @batchid = @batchid;

    -- reference read: [audit].[changelog]
    select @rowcount = count(*) from [audit].[changelog] where [isdeleted] = 0;

    -- reference read: [fin].[transaction]
    select @rowcount = count(*) from [fin].[transaction] where [isdeleted] = 0;

    -- reference read: dbo.salestarget
    select @rowcount = count(*) from dbo.salestarget where [isdeleted] = 0;

    -- reference read: [dbo].[customer]
    select @rowcount = count(*) from [dbo].[customer] where [isdeleted] = 0;

    return @rowcount;
end
go