
------------ Current Stock -------------

DECLARE @Current_Stock TABLE
(
[Item No_] varchar(500),
--[Lot No_]  varchar(500)(50), 
--[Expiration Date]  date,
Stock_Quantity  decimal(10,2)
)
insert into @Current_Stock
select 
[Item No_] , 
--[Lot No_], max([Expiration Date]) ,  [Location Code],
cast(sum([Quantity]) as decimal(10,2))
from [Promar Trading$Item Ledger Entry]	IL
where 
IL.[Location Code] not in ('DISCARDED', 'DAMAGED','SAMPLES', 'LAF_DISCAR')
and IL.[Lot No_] <> 'DUMMY'
group by [Item No_]
order by [Item No_]
--select * from @Current_Stock where Stock_Quantity <> 0

-------------

------------ Sales Date  -------------

DECLARE @Sales_Date TABLE
(
[Item No_] varchar(500),
[Sales Date]  date,
[Days on Sale] int
)
insert into @Sales_Date
select
VE.[Item No_],
CONVERT(date,(min(VE.[Posting Date]))) as 'First Sales Date',
(datediff(day, CONVERT(date,(min(VE.[Posting Date]))), CONVERT(date, getdate())))
from [Promar Trading$Value Entry]	VE
where 
VE.[Location Code] not in ('DISCARDED', 'DAMAGED','SAMPLES', 'LAF_DISCAR')
--and VE.[Lot No_] <> 'DUMMY'
and VE.[Source Code] = 'SALES'
and VE.[Source Type] = 1 
and VE.[Invoiced Quantity] <> 0 
group by [Item No_]
order by [Item No_]
--select * from @Sales_Date 
-------------


------------ Incoming POs  -------------

DECLARE @Incoming_POs TABLE
(
[Item No_] varchar(500),
[Document No_] varchar(500), 
[Expected Receipt Date]  varchar(500),
Quantity varchar(500), 
[Qty_ Rcd_ Not Invoiced] varchar(500), 
[Outstanding Quantity] varchar(500)
)
insert into @Incoming_POs
select
PL.No_, --PL.[Expected Receipt Date], PL.[Document No_],

 STUFF((SELECT '   |   ' + PL2.[Document No_] FROM [Promar Trading$Purchase Line] PL2,  [Promar Trading$Purchase Header] PH2
Where PL2.No_=PL.No_ and  
PL2.[Document Type] = 1
and PL2.[Document No_] = PH2.No_
and PL2.[Short Closed] = 0
and PL2.[Outstanding Quantity] <> 0
and PL2.Type = 2
and PH2.[Expected Receipt Date] >= Dateadd(DAY, -14, CONVERT(date, getdate()))
--and PL2.[Document No_] = PH.No_
--and PH.Status = 1
FOR XML PATH('')),1,1,'') As 'Doc Nb',

 STUFF((SELECT '   |   ' + CONVERT(varchar(500),PH2.[Expected Receipt Date],103) FROM [Promar Trading$Purchase Line] PL2,  [Promar Trading$Purchase Header] PH2
Where PL2.No_=PL.No_ 
and PL2.[Document Type] = 1
and PL2.[Document No_] = PH2.No_
and PL2.[Short Closed] = 0
and PL2.[Outstanding Quantity] <> 0
and PL2.Type = 2
and PH2.[Expected Receipt Date] >= Dateadd(DAY, -14, CONVERT(date, getdate()))
--and PL2.[Document No_] = PH.No_
--and PH.Status = 1
FOR XML PATH('')),1,1,'') As 'Receipt Date',

 STUFF((SELECT '   |   ' + convert(varchar(500),cast(PL2.Quantity as money)) FROM [Promar Trading$Purchase Line] PL2,  [Promar Trading$Purchase Header] PH2
Where PL2.No_=PL.No_ 
and PL2.[Document Type] = 1
and PL2.[Document No_] = PH2.No_
and PL2.[Short Closed] = 0
and PL2.[Outstanding Quantity] <> 0
and PL2.Type = 2
and PH2.[Expected Receipt Date] >= Dateadd(DAY, -14, CONVERT(date, getdate()))
--and PL2.[Document No_] = PH.No_
--and PH.Status = 1
FOR XML PATH('')),1,1,'') As 'Quantity',

 STUFF((SELECT '      ' + convert(varchar(500),cast(PL2.[Qty_ Rcd_ Not Invoiced] as money)) FROM [Promar Trading$Purchase Line] PL2,  [Promar Trading$Purchase Header] PH2
Where PL2.No_=PL.No_ 
and PL2.[Document Type] = 1
and PL2.[Document No_] = PH2.No_
and PL2.[Short Closed] = 0
and PL2.[Outstanding Quantity] <> 0
and PL2.Type = 2
and PH2.[Expected Receipt Date] >= Dateadd(DAY, -14, CONVERT(date, getdate()))
--and PL2.[Document No_] = PH.No_
--and PH.Status = 1
FOR XML PATH('')),1,1,'') As 'Qty_ Rcd_ Not Invoiced',

 STUFF((SELECT '   |   ' + convert(varchar(500),cast(PL2.[Outstanding Quantity] as money)) FROM [Promar Trading$Purchase Line] PL2,  [Promar Trading$Purchase Header] PH2
Where PL2.No_=PL.No_ 
and PL2.[Document Type] = 1
and PL2.[Document No_] = PH2.No_
and PL2.[Short Closed] = 0
and PL2.[Outstanding Quantity] <> 0
and PL2.Type = 2
and PH2.[Expected Receipt Date] >= Dateadd(DAY, -14, CONVERT(date, getdate()))
--and PL2.[Document No_] = PH.No_
--and PH.Status = 1
FOR XML PATH('')),1,1,'') As 'Outstanding Quantity'

from [Promar Trading$Purchase Line] PL, [Promar Trading$Purchase Header] PH
where PL.[Document Type] = 1
and PH.No_ = PL.[Document No_]
and PL.[Short Closed] = 0
and PL.[Outstanding Quantity] <> 0
and PL.Type = 2
--and PL.No_ = 'ITM-1476'
and PH.[Expected Receipt Date] >= Dateadd(DAY, -14, CONVERT(date, getdate()))
--and PH.Status = 1
group by PL.No_
order by PL.No_

--select * from @Incoming_POs 

-------------

select 
VE.[Item No_] , 
left(IT.[Description 2],3) as 'Brand Code', 
sum(-cast(([Invoiced Quantity]) as decimal(10,2))) as 'Sales Qty',
month(VE.[Posting Date]) as 'Month', year(VE.[Posting Date]) as 'Year',
IT.[Description 2], 
IT.[Base Unit of Measure], 
case  
	WHEN CHARINDEX('D',replace(replace(replace(IT.[Shelf Life],CHAR(2),'D'),CHAR(7),'Y'), char(5), 'M')) > 0  THEN replace(IT.[Shelf Life],CHAR(2),'D') 
	WHEN CHARINDEX('Y',replace(replace(replace(IT.[Shelf Life],CHAR(2),'D'),CHAR(7),'Y'), char(5), 'M')) > 0  THEN replace(IT.[Shelf Life],CHAR(7),'Y') 
	WHEN CHARINDEX('M',replace(replace(replace(IT.[Shelf Life],CHAR(2),'D'),CHAR(7),'Y'), char(5), 'M')) > 0  THEN replace(IT.[Shelf Life],CHAR(5),'M') 
  END as 'Shelf Life in Days (int)',
VN.Name as 'Vendor Name', VN.[Purchaser Code], VN.No_,

case when VN.[Lead Time Calculation] = '' then 35 else
cast(replace(VN.[Lead Time Calculation],CHAR(2),'') as decimal)
end as 'Lead Days',

--case  
--	WHEN CHARINDEX('D',replace(replace(replace(IT.[Lead Time Calculation],CHAR(2),'D'),CHAR(7),'Y'), char(5), 'M')) > 0  THEN cast(replace(IT.[Lead Time Calculation],CHAR(2),'') as int) 
--	WHEN CHARINDEX('Y',replace(replace(replace(IT.[Lead Time Calculation],CHAR(2),'D'),CHAR(7),'Y'), char(5), 'M')) > 0  THEN cast(replace(IT.[Lead Time Calculation],CHAR(7),'') as int) *365 
--	WHEN CHARINDEX('M',replace(replace(replace(IT.[Lead Time Calculation],CHAR(2),'D'),CHAR(7),'Y'), char(5), 'M')) > 0  THEN cast(replace(IT.[Lead Time Calculation],CHAR(5),'') as int) *30 
-- END as 'Item Lead Days',

CS.Stock_Quantity,
case when SD.[Days on Sale] <= 0 then 1 else SD.[Days on Sale] end as [Days on Sale],

sum(-cast(([Invoiced Quantity]) as decimal(10,2)))/(case when SD.[Days on Sale] <= 0 then 1 else SD.[Days on Sale] end)/0.87 as 'Daily Sales',   -- 0.87 to account for 26 business days
 

case when month(VE.[Posting Date]) = month(CONVERT(date, getdate())) - 1 then
sum(-cast(([Invoiced Quantity]) as decimal(10,2))) / 26
* (case when VN.[Lead Time Calculation] = '' then 35 else
cast(replace(VN.[Lead Time Calculation],CHAR(2),'') as decimal) 
end) * 1.10
else 0 end
as 'Min Level Last Mo',  



sum(-cast(([Invoiced Quantity]) as decimal(10,2)))/(case when SD.[Days on Sale] <= 0 then 1 else SD.[Days on Sale] end)/0.87  * (case when VN.[Lead Time Calculation] = '' then 35 else
cast(replace(VN.[Lead Time Calculation],CHAR(2),'') as decimal) 
end) * 1.10 as 'Minimum Stock Level',  -- 1.10 for safety stock 

IP.[Document No_], IP.[Expected Receipt Date], IP.[Outstanding Quantity]

from [Promar Trading$Value Entry]	VE
left outer join [Promar Trading$Item] IT 
on VE.[Item No_] = IT.No_
left outer join [Promar Trading$Vendor] VN
on IT.[Vendor No_] = VN.No_

left outer join @Current_Stock CS
on CS.[Item No_] = VE.[Item No_]

left outer join @Sales_Date SD
on SD.[Item No_] = VE.[Item No_]

left outer join @Incoming_POs IP
on IP.[Item No_] = VE.[Item No_]

where 
VE.[Location Code] not in ('DISCARDED', 'DAMAGED','SAMPLES', 'LAF_DISCAR')
and IT.Blocked = 0
and IT.[Reordering Policy] <> 3
and year(VE.[Posting Date]) >= '2015'

and VE.[Source Code] = 'SALES'
and VE.[Source Type] = 1 
and VE.[Invoiced Quantity] <> 0 
--and IT.[Description 2] like 'NIE%'
--and IT.No_ = 'ITM-1993'
--and  CS.Stock_Quantity <> 0
--and VE.[Item No_] in ('ITM-0008','ITM-0009','ITM-0010','ITM-0011')
group by	VE.[Item No_], month(VE.[Posting Date]), year(VE.[Posting Date]),IT.[Description 2], 
			VN.Name, VN.[Lead Time Calculation], CS.Stock_Quantity,SD.[Days on Sale], VN.[Purchaser Code],
			IP.[Document No_], IP.[Expected Receipt Date], IP.[Outstanding Quantity],
			VN.No_, IT.[Base Unit of Measure], IT.[Shelf Life]
			--, IT.[Lead Time Calculation]
order by IT.[Description 2], year(VE.[Posting Date]), month(VE.[Posting Date])