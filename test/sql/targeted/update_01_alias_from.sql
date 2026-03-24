-- UPDATE alias pattern 01: UPDATE alias SET ... FROM schema.table AS alias
-- extract_update_alias_target rule (priority 17)
-- EXPECT  sources:[dbo].[RealTable]  targets:[dbo].[RealTable]

UPDATE a
SET    a.Amount = a.Amount * 1.1
FROM   [dbo].[RealTable] AS a
WHERE  a.IsActive = 1
