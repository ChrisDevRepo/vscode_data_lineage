-- generated sp 112: tier=medium flags=[deeptrycatch,nocaps]
-- expect  sources:[hr].[department],[dbo].[contact],[rpt].[productrevenue]  targets:[rpt].[monthlyorders],[dbo].[payment]  exec:[fin].[usp_postjournal],[dbo].[usp_generateinvoice],[etl].[usp_loadproducts]

create procedure [hr].[usp_genmedium_112]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    begin try
        begin try
            insert into rpt.monthlyorders ([sourceid], [sourcename], [loadedat])
            select s.[id], s.[name], getutcdate()
            from   [hr].[department] as s
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
    set @rowcount = @rowcount + @@rowcount;

    begin try
        begin try
            insert into [dbo].[payment] ([sourceid], [refid], [amount], [loadedat])
            select
                a.[id]          as sourceid,
                b.[id]          as refid,
                isnull(a.[amount], 0) as amount,
                getutcdate()    as loadedat
            from   [hr].[department] as a
            join   dbo.contact as c on c.[id] = a.[id]
            join   rpt.productrevenue as d on d.[id] = a.[id]
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
    set @rowcount = @rowcount + @@rowcount;

    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   [rpt].[monthlyorders] as t
    join   [dbo].[contact] as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    exec [fin].[usp_postjournal] @processdate = getdate(), @batchid = @batchid;

    exec dbo.usp_generateinvoice @processdate = getdate(), @batchid = @batchid;

    exec etl.usp_loadproducts @processdate = getdate(), @batchid = @batchid;

    -- reference read: [hr].[department]
    select @rowcount = count(*) from [hr].[department] where [isdeleted] = 0;

    -- reference read: dbo.contact
    select @rowcount = count(*) from [dbo].[contact] where [isdeleted] = 0;

    -- reference read: rpt.productrevenue
    select @rowcount = count(*) from rpt.productrevenue where [isdeleted] = 0;

    return @rowcount;
end
go