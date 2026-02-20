-- generated sp 94: tier=medium flags=[cursorloop,nocaps]
-- expect  sources:[dbo].[salestarget],[etl].[loadlog]  targets:[hr].[department],[dbo].[shipper]  exec:[hr].[usp_approveleave],[dbo].[usp_updatecustomer]

create procedure [etl].[usp_genmedium_094]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    declare cur_process cursor local fast_forward for
        select [id], [name] from [dbo].[salestarget] where [status] = n'pending';
    
    declare @curid int, @curname nvarchar(200);
    open cur_process;
    fetch next from cur_process into @curid, @curname;
    while @@fetch_status = 0
    begin
        -- process each row
        set @batchid = @curid;
        print n'processing: ' + isnull(@curname, n'null');
        fetch next from cur_process into @curid, @curname;
    end
    close cur_process;
    deallocate cur_process;

    insert into hr.department ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   dbo.salestarget as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    insert into dbo.shipper ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   [dbo].[salestarget] as a
    join   etl.loadlog as c on c.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   hr.department as t
    join   etl.loadlog as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    exec hr.usp_approveleave @processdate = getdate(), @batchid = @batchid;

    exec [dbo].[usp_updatecustomer] @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.salestarget
    select @rowcount = count(*) from dbo.salestarget where [isdeleted] = 0;

    -- reference read: [etl].[loadlog]
    select @rowcount = count(*) from etl.loadlog where [isdeleted] = 0;

    return @rowcount;
end
go