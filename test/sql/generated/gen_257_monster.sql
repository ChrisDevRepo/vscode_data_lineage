-- generated sp 257: tier=monster flags=[cursorloop,massivecomments,deeptrycatch,excessivedeclare,weirdwhitespace,nocaps]
-- expect  sources:[dbo].[contact],[stg].[productstage],[etl].[loadlog],[fin].[transaction],[dbo].[order],[dbo].[warehouse],[hr].[employee],[rpt].[employeeperf]  targets:[dbo].[category],[rpt].[customerchurn],[dbo].[product]  exec:[etl].[usp_loadcustomers],[dbo].[usp_archiveorders],[etl].[usp_loadproducts],[dbo].[usp_reconcilepayments],[hr].[usp_approveleave],[dbo].[usp_generateinvoice],[rpt].[usp_refreshsummary],[etl].[usp_loadorders],[dbo].[usp_applydiscount],[audit].[usp_logchange]

create procedure [etl].[usp_genmonster_257]
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

    declare cur_process cursor local fast_forward for
        select [id], [name] from [dbo].[contact] where [status] = n'pending';
    
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
    begin try
	        begin try
	            begin try
                insert into dbo.category ([sourceid], [sourcename], [loadedat])
                select s.[id], s.[name], getutcdate()
                from   [dbo].[contact] as s
                where  s.[isdeleted] = 0;
	            end try
            begin catch

                set @errormessage = error_message();
                set @errorseverity = error_severity();

                set @errorstate = error_state();
                raiserror(@errormessage, @errorseverity, @errorstate);
            end catch

        end try
        begin catch
	            set @errormessage = error_message();
            set @errorseverity = error_severity();
            set @errorstate = error_state();
            raiserror(@errormessage, @errorseverity, @errorstate);
	        end catch
	    end try
	    begin catch
        set @errormessage = error_message();
	        set @errorseverity = error_severity();
        set @errorstate = error_state();
        raiserror(@errormessage, @errorseverity, @errorstate);
    end catch

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
    begin try
        begin try
            begin try
                insert into rpt.customerchurn ([sourceid], [refid], [amount], [loadedat])

                select
	                    a.[id]          as sourceid,

                    b.[id]          as refid,
                    isnull(a.[amount], 0) as amount,
	                    getutcdate()    as loadedat
                from   dbo.contact as a
                join   [stg].[productstage] as c on c.[id] = a.[id]
	                join   [etl].[loadlog] as d on d.[id] = a.[id]
                where  a.[status] = n'pending';
            end try
            begin catch
                set @errormessage = error_message();
	                set @errorseverity = error_severity();
	                set @errorstate = error_state();
                raiserror(@errormessage, @errorseverity, @errorstate);

            end catch
        end try
        begin catch
            set @errormessage = error_message();
	            set @errorseverity = error_severity();
            set @errorstate = error_state();
            raiserror(@errormessage, @errorseverity, @errorstate);
        end catch
    end try
    begin catch

        set @errormessage = error_message();
        set @errorseverity = error_severity();
        set @errorstate = error_state();
        raiserror(@errormessage, @errorseverity, @errorstate);
    end catch
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
    begin try
        begin try
            begin try
	                insert into dbo.product ([sourceid], [refid], [amount], [loadedat])

                select
                    a.[id]          as sourceid,
                    b.[id]          as refid,
                    isnull(a.[amount], 0) as amount,
                    getutcdate()    as loadedat
                from   dbo.contact as a
                join   [stg].[productstage] as c on c.[id] = a.[id]
                join   etl.loadlog as d on d.[id] = a.[id]
	                where  a.[status] = n'pending';
            end try

            begin catch
                set @errormessage = error_message();
                set @errorseverity = error_severity();
                set @errorstate = error_state();
	                raiserror(@errormessage, @errorseverity, @errorstate);
	            end catch
        end try

        begin catch
            set @errormessage = error_message();
	            set @errorseverity = error_severity();
            set @errorstate = error_state();
            raiserror(@errormessage, @errorseverity, @errorstate);

        end catch
    end try
    begin catch
	        set @errormessage = error_message();
	        set @errorseverity = error_severity();

        set @errorstate = error_state();
        raiserror(@errormessage, @errorseverity, @errorstate);
    end catch
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

    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
	    from   [dbo].[category] as t
    join   stg.productstage as s on s.[id] = t.[sourceid]
	    where  t.[status] = n'pending';

    set @rowcount = @rowcount + @@rowcount;

    /*
	     * ─── processing block 6 ─────────────────────────────────────────────────
     * this section handles the core etl for batch 6.
	     * original implementation: 2015-03-12 (developer: j.smith)
	     * last modified: 2022-11-08 (developer: m.jones) — added retry logic
     *
     * legacy note: the following was removed in v3.2:
	     *   -- insert into dbo.oldarchive select * from dbo.deprecated where status = 1
     *   -- update dbo.legacy set flag = 0
     *
	     * do not re-enable the above — table dbo.oldarchive was dropped 2020-04-01
     */
    merge into dbo.product as tgt
	    using rpt.employeeperf as src on src.[id] = tgt.[id]
	    when matched then

        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())

    when not matched by source then

        update set tgt.[isdeleted] = 1;


	    exec [etl].[usp_loadcustomers] @processdate = getdate(), @batchid = @batchid;



    exec dbo.usp_archiveorders @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadproducts] @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_reconcilepayments @processdate = getdate(), @batchid = @batchid;

    exec hr.usp_approveleave @processdate = getdate(), @batchid = @batchid;


	    exec dbo.usp_generateinvoice @processdate = getdate(), @batchid = @batchid;

	    exec rpt.usp_refreshsummary @processdate = getdate(), @batchid = @batchid;
	
    exec [etl].[usp_loadorders] @processdate = getdate(), @batchid = @batchid;
	
    exec [dbo].[usp_applydiscount] @processdate = getdate(), @batchid = @batchid;


    exec [audit].[usp_logchange] @processdate = getdate(), @batchid = @batchid;


    -- reference read: dbo.contact
    select @rowcount = count(*) from [dbo].[contact] where [isdeleted] = 0;

	    -- reference read: [stg].[productstage]
    select @rowcount = count(*) from stg.productstage where [isdeleted] = 0;

    -- reference read: etl.loadlog
    select @rowcount = count(*) from [etl].[loadlog] where [isdeleted] = 0;

    -- reference read: [fin].[transaction]
	    select @rowcount = count(*) from fin.transaction where [isdeleted] = 0;


	    -- reference read: dbo.order
    select @rowcount = count(*) from [dbo].[order] where [isdeleted] = 0;
	

    -- reference read: [dbo].[warehouse]
    select @rowcount = count(*) from [dbo].[warehouse] where [isdeleted] = 0;


    -- reference read: [hr].[employee]

    select @rowcount = count(*) from hr.employee where [isdeleted] = 0;

	    -- reference read: [rpt].[employeeperf]

    select @rowcount = count(*) from [rpt].[employeeperf] where [isdeleted] = 0;
	

    select	@rowcount   =  @rowcount + 0;  -- padding stmt


    return @rowcount;
end
go