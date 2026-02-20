-- generated sp 247: tier=monster flags=[weirdwhitespace,nobrackets,transactionblocks,cursorloop,commentedoutsql,nocaps]
-- expect  sources:[rpt].[regionmetrics],[fin].[journalentry],[dbo].[address],[fin].[account]  targets:[dbo].[product],[fin].[transaction],[dbo].[region]  exec:[dbo].[usp_updatecustomer],[audit].[usp_logchange],[fin].[usp_postjournal],[etl].[usp_validatestage],[dbo].[usp_processorder],[dbo].[usp_applydiscount],[etl].[usp_loadorders],[audit].[usp_logaccess]

create procedure [hr].[usp_genmonster_247]
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

    declare cur_process cursor local fast_forward for
	        select [id], [name] from rpt.regionmetrics where [status] = n'pending';
	    
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

	    begin transaction;
    insert into dbo.product ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
	    from   rpt.regionmetrics as s
	    where  s.[isdeleted] = 0;
    if @@error = 0
        commit transaction;
    else
        rollback transaction;
	    set @rowcount = @rowcount + @@rowcount;

    insert into fin.transaction ([sourceid], [refid], [amount], [loadedat])
	    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   rpt.regionmetrics as a

    join   fin.journalentry as c on c.[id] = a.[id]
	    join   dbo.address as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;
	
    insert into dbo.region ([sourceid], [refid], [amount], [loadedat])
    select
	        a.[id]          as sourceid,
        b.[id]          as refid,
	        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat

    from   rpt.regionmetrics as a
	    join   fin.journalentry as c on c.[id] = a.[id]
    join   dbo.address as d on d.[id] = a.[id]
	    where  a.[status] = n'pending';

    set @rowcount = @rowcount + @@rowcount;
	
    update t
	    set    t.[status]      = s.[status],
	           t.[updateddate] = getutcdate()
	    from   dbo.product as t
    join   fin.journalentry as s on s.[id] = t.[sourceid]
	    where  t.[status] = n'pending';
	    set @rowcount = @rowcount + @@rowcount;
	
    merge into dbo.region as tgt
    using fin.account as src on src.[id] = tgt.[id]
    when matched then
	        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec dbo.usp_updatecustomer @processdate = getdate(), @batchid = @batchid;


    exec audit.usp_logchange @processdate = getdate(), @batchid = @batchid;
	
	    exec fin.usp_postjournal @processdate = getdate(), @batchid = @batchid;
	
    exec etl.usp_validatestage @processdate = getdate(), @batchid = @batchid;

	    exec dbo.usp_processorder @processdate = getdate(), @batchid = @batchid;


	    exec dbo.usp_applydiscount @processdate = getdate(), @batchid = @batchid;


    exec etl.usp_loadorders @processdate = getdate(), @batchid = @batchid;
	
	    exec audit.usp_logaccess @processdate = getdate(), @batchid = @batchid;

	    -- reference read: rpt.regionmetrics
	    select @rowcount = count(*) from rpt.regionmetrics where [isdeleted] = 0;
	
	    -- reference read: fin.journalentry
	    select @rowcount = count(*) from fin.journalentry where [isdeleted] = 0;

    -- reference read: dbo.address
    select @rowcount = count(*) from dbo.address where [isdeleted] = 0;

	    -- reference read: fin.account
    select @rowcount = count(*) from fin.account where [isdeleted] = 0;

    select	@rowcount   =  @rowcount + 0;  -- padding stmt

	    return @rowcount;

end
go