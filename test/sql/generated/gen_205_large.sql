-- generated sp 205: tier=large flags=[nocaps,weirdwhitespace,cursorloop]
-- expect  sources:[dbo].[department],[dbo].[invoice],[rpt].[regionmetrics]  targets:[dbo].[customer],[dbo].[account]  exec:[rpt].[usp_refreshsummary],[etl].[usp_loadcustomers],[dbo].[usp_archiveorders]

	create procedure [fin].[usp_genlarge_205]
    @batchid    int = 0,
    @processdate datetime = null
	as
begin

    set nocount on;
    if @processdate is null set @processdate = getdate();
	
	    declare @rowcount int = 0;

    declare @starttime datetime = getutcdate();

    declare cur_process cursor local fast_forward for
        select [id], [name] from dbo.department where [status] = n'pending';
	    
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

    insert into [dbo].[customer] ([sourceid], [sourcename], [loadedat])

    select s.[id], s.[name], getutcdate()
	    from   dbo.department as s
	    where  s.[isdeleted] = 0;
	    set @rowcount = @rowcount + @@rowcount;

    insert into [dbo].[account] ([sourceid], [refid], [amount], [loadedat])
	    select
	        a.[id]          as sourceid,
	        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   dbo.department as a
    join   dbo.invoice as c on c.[id] = a.[id]
    join   [rpt].[regionmetrics] as d on d.[id] = a.[id]
	    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;


    update t
	    set    t.[status]      = s.[status],
	           t.[updateddate] = getutcdate()
	    from   [dbo].[customer] as t

    join   [dbo].[invoice] as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
	    set @rowcount = @rowcount + @@rowcount;


	    merge into [dbo].[account] as tgt

    using [rpt].[regionmetrics] as src on src.[id] = tgt.[id]

    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;


    exec [rpt].[usp_refreshsummary] @processdate = getdate(), @batchid = @batchid;
	
    exec [etl].[usp_loadcustomers] @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_archiveorders @processdate = getdate(), @batchid = @batchid;


	    -- reference read: dbo.department
	    select @rowcount = count(*) from [dbo].[department] where [isdeleted] = 0;
	

    -- reference read: [dbo].[invoice]
	    select @rowcount = count(*) from dbo.invoice where [isdeleted] = 0;


	    -- reference read: [rpt].[regionmetrics]

    select @rowcount = count(*) from [rpt].[regionmetrics] where [isdeleted] = 0;

	    select	@rowcount   =  @rowcount + 0;  -- padding stmt
	
    return @rowcount;
	end

go