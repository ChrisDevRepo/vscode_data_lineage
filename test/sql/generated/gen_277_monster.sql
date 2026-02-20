-- generated sp 277: tier=monster flags=[temptableheavy,nestedsubqueries,massivecomments,nocaps,transactionblocks,deeptrycatch]
-- expect  sources:[dbo].[salestarget],[fin].[costcenter],[etl].[loadlog],[audit].[accesslog]  targets:[dbo].[address],[dbo].[shipper]  exec:[dbo].[usp_generateinvoice],[etl].[usp_loadorders],[audit].[usp_logchange],[dbo].[usp_updatecustomer],[fin].[usp_postjournal],[etl].[usp_validatestage]

create procedure [hr].[usp_genmonster_277]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    -- pre-stage data in temp tables
    create table #workset ([id] int, [name] nvarchar(200), [amount] decimal(18,2), [processedat] datetime);
    insert into #workset ([id], [name], [amount], [processedat])
    select [id], [name], isnull([amount], 0), getutcdate()
    from   dbo.salestarget
    where  [isdeleted] = 0;
    create table #refdata ([id] int, [name] nvarchar(200), [amount] decimal(18,2), [processedat] datetime);
    insert into #refdata ([id], [name], [amount], [processedat])
    select [id], [name], isnull([amount], 0), getutcdate()
    from   fin.costcenter
    where  [isdeleted] = 0;

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
    begin try
        begin try
            begin try
                begin transaction;
                insert into [dbo].[address] ([id], [name])
                select x.[id], x.[name]
                from (
                    select i.[id], i.[name], row_number() over (order by i.[updateddate] desc) as rn
                    from (
                        select [id], [name], [updateddate]
                        from   dbo.salestarget
                        where  [isdeleted] = 0
                    ) as i
                ) as x
                where x.rn = 1;
                if @@error = 0
                    commit transaction;
                else
                    rollback transaction;
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
                insert into [dbo].[shipper] ([sourceid], [refid], [amount], [loadedat])
                select
                    a.[id]          as sourceid,
                    b.[id]          as refid,
                    isnull(a.[amount], 0) as amount,
                    getutcdate()    as loadedat
                from   dbo.salestarget as a
                join   [fin].[costcenter] as c on c.[id] = a.[id]
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
    from   dbo.address as t
    join   [fin].[costcenter] as s on s.[id] = t.[sourceid]
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
    merge into dbo.shipper as tgt
    using audit.accesslog as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec [dbo].[usp_generateinvoice] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadorders] @processdate = getdate(), @batchid = @batchid;

    exec [audit].[usp_logchange] @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_updatecustomer @processdate = getdate(), @batchid = @batchid;

    exec [fin].[usp_postjournal] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_validatestage] @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.salestarget
    select @rowcount = count(*) from [dbo].[salestarget] where [isdeleted] = 0;

    -- reference read: fin.costcenter
    select @rowcount = count(*) from fin.costcenter where [isdeleted] = 0;

    -- reference read: etl.loadlog
    select @rowcount = count(*) from etl.loadlog where [isdeleted] = 0;

    -- reference read: [audit].[accesslog]
    select @rowcount = count(*) from [audit].[accesslog] where [isdeleted] = 0;

    return @rowcount;
end
go