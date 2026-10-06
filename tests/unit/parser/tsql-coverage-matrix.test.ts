/**
 * T-SQL construct coverage matrix for the SQL-body parser.
 *
 * @remarks
 * Each row states what a DBA expects one construct to contribute to lineage — reads, writes
 * and procedure calls — and compares the parser's output exactly, so a missing edge and an
 * invented one both fail. DELETE and TRUNCATE are deliberately absent from `t`: the parser
 * excludes them and model building classifies delete-only writes from catalog metadata.
 * Unqualified, temp (`#`), variable (`@`) and CTE names never become references.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

/** Expected references as `schema.object`; cross-database ones as `db.schema.object`. */
type Expect = { s?: string[]; t?: string[]; x?: string[]; xs?: string[]; xt?: string[] };

/** Splits at the first dot only, so a dotted object name such as `[a.b]` stays one part. */
const key = (name: string) => `[${name.toLowerCase().replace('.', '].[')}]`;
const sorted = (list: string[]) => [...list].sort();

function expectParsed(sql: string, want: Expect): void {
  const parsed = parseSqlBody(sql);
  expect({
    s: sorted(parsed.sources), t: sorted(parsed.targets), x: sorted(parsed.execCalls),
    xs: sorted(parsed.crossDbSources), xt: sorted(parsed.crossDbTargets),
  }).toEqual({
    s: sorted((want.s ?? []).map(key)), t: sorted((want.t ?? []).map(key)), x: sorted((want.x ?? []).map(key)),
    xs: sorted((want.xs ?? []).map(n => n.toLowerCase())), xt: sorted((want.xt ?? []).map(n => n.toLowerCase())),
  });
}

const MATRIX: Record<string, Array<[string, string, Expect]>> = {
  'joins, subqueries and set operators': [
    ['INNER/LEFT/RIGHT/FULL/CROSS joins', 'SELECT * FROM dbo.A a INNER JOIN dbo.B b ON 1=1 LEFT OUTER JOIN dbo.C c ON 1=1 RIGHT JOIN dbo.D d ON 1=1 FULL JOIN dbo.E e ON 1=1 CROSS JOIN dbo.F', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E', 'dbo.F'] }],
    ['join hints', 'SELECT * FROM dbo.A a INNER HASH JOIN dbo.B b ON 1=1 LEFT LOOP JOIN dbo.C c ON 1=1', { s: ['dbo.A', 'dbo.B', 'dbo.C'] }],
    ['parenthesised joined tables', 'SELECT * FROM (dbo.A a JOIN dbo.B b ON a.id=b.id); SELECT * FROM ((dbo.C c JOIN dbo.D d ON 1=1) LEFT JOIN dbo.E e ON 1=1); SELECT * FROM dbo.F f JOIN (dbo.G g JOIN dbo.H h ON 1=1) ON 1=1; SELECT * FROM(dbo.I i CROSS JOIN dbo.J j)', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E', 'dbo.F', 'dbo.G', 'dbo.H', 'dbo.I', 'dbo.J'] }],
    ['a parenthesised derived table or VALUES list is not a table name', 'SELECT * FROM (SELECT x FROM dbo.A) d JOIN (VALUES (1)) v(x) ON 1=1 JOIN ((SELECT y FROM dbo.B)) e ON 1=1', { s: ['dbo.A', 'dbo.B'] }],
    ['CROSS/OUTER APPLY of a TVF and a subquery', 'SELECT * FROM dbo.A a CROSS APPLY dbo.fnRows(a.id) f OUTER APPLY (SELECT TOP 1 * FROM dbo.B b WHERE b.id=a.id) x', { s: ['dbo.A', 'dbo.fnRows', 'dbo.B'] }],
    ['IN, EXISTS and scalar subqueries', 'SELECT (SELECT MAX(x) FROM dbo.C) m FROM dbo.A WHERE id IN (SELECT id FROM dbo.B) AND EXISTS (SELECT 1 FROM dbo.D)', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D'] }],
    ['nested derived tables', 'SELECT * FROM (SELECT * FROM dbo.A) d JOIN (SELECT * FROM (SELECT * FROM dbo.B) i) e ON 1=1', { s: ['dbo.A', 'dbo.B'] }],
    ['UNION/EXCEPT/INTERSECT', 'SELECT a FROM dbo.A UNION SELECT a FROM dbo.B EXCEPT SELECT a FROM dbo.C INTERSECT SELECT a FROM dbo.D', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D'] }],
    ['ANSI-89 comma list', 'SELECT * FROM dbo.A a, dbo.B b, dbo.C c WHERE a.id=b.id', { s: ['dbo.A', 'dbo.B', 'dbo.C'] }],
    ['ANSI-89 comma list with a derived table as middle member', 'SELECT * FROM dbo.A a, (SELECT x FROM dbo.B) d, dbo.C c WHERE a.id=c.id', { s: ['dbo.A', 'dbo.B', 'dbo.C'] }],
    ['ANSI-89 comma list with a table-valued function as middle member', 'SELECT * FROM dbo.A a, dbo.fnRows(1, 2) f, dbo.C c', { s: ['dbo.A', 'dbo.fnRows', 'dbo.C'] }],
    ['ANSI-89 comma list with OPENROWSET as middle member', "SELECT * FROM dbo.A a, OPENROWSET(BULK 'f.csv', SINGLE_CLOB) r, dbo.C c", { s: ['dbo.A', 'dbo.C'] }],
    ['ANSI-89 comma list with a WITH (NOLOCK) hint on a member', 'SELECT * FROM dbo.A a WITH (NOLOCK), dbo.B b WITH (NOLOCK, INDEX(ix1)), dbo.C c', { s: ['dbo.A', 'dbo.B', 'dbo.C'] }],
    ['ANSI-89 comma list keeps WINDOW and OUTPUT as alias or schema', 'SELECT * FROM dbo.A AS window, dbo.B b; SELECT * FROM output.T o, dbo.C c', { s: ['dbo.A', 'dbo.B', 'output.T', 'dbo.C'] }],
    ['ANSI-89 comma list ends at its clause; commas of later clauses and nested calls are no members', 'SELECT * FROM dbo.A a, dbo.B b WHERE a.id IN (SELECT id FROM dbo.C c, dbo.D d) GROUP BY a.x, b.y ORDER BY a.x, COALESCE(a.y, 0)', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D'] }],
    ['a deleted-row OUTPUT list is no comma list of tables', 'DELETE FROM dbo.T OUTPUT deleted.a, deleted.b INTO dbo.L', { s: ['dbo.T'], t: ['dbo.L'] }],
    ['PIVOT and UNPIVOT','SELECT * FROM (SELECT k, v FROM dbo.A) s PIVOT (SUM(v) FOR k IN ([x],[y])) p; SELECT * FROM dbo.B UNPIVOT (v FOR k IN (c1, c2)) u', { s: ['dbo.A', 'dbo.B'] }],
    ['TOP and window functions', 'SELECT TOP (10) PERCENT a, ROW_NUMBER() OVER (PARTITION BY b ORDER BY c) rn FROM dbo.A', { s: ['dbo.A'] }],
    ['table hints, OPTION, TABLESAMPLE and temporal FOR SYSTEM_TIME', "SELECT * FROM dbo.A WITH (NOLOCK) JOIN dbo.B b (NOLOCK) ON 1=1 JOIN dbo.C WITH (INDEX(ix1), FORCESEEK) ON 1=1 OPTION (RECOMPILE, LABEL = 'x'); SELECT * FROM dbo.D TABLESAMPLE (10 PERCENT); SELECT * FROM dbo.E FOR SYSTEM_TIME AS OF '2020-01-01'", { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E'] }],
    ['nested, bracketed and three-part parenthesised joined tables, also inside INSERT ... SELECT', 'SELECT * FROM (((dbo.A a JOIN dbo.B b ON 1=1))); SELECT * FROM ( dbo.C c LEFT JOIN ( dbo.D d JOIN dbo.E e ON 1=1 ) ON 1=1 ); SELECT * FROM ([dbo].[F] f JOIN [dbo].[G] g ON 1=1); SELECT * FROM (OtherDb.dbo.H h JOIN dbo.I i ON 1=1); INSERT INTO dbo.T SELECT * FROM (dbo.J j JOIN dbo.K k ON 1=1)', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E', 'dbo.F', 'dbo.G', 'dbo.I', 'dbo.J', 'dbo.K'], t: ['dbo.T'], xs: ['otherdb.dbo.h'] }],
    ['VALUES constructor, OPENJSON, STRING_SPLIT and XML nodes are not catalog objects', "SELECT * FROM (VALUES (1)) v(x) JOIN dbo.A a ON 1=1 CROSS APPLY OPENJSON(a.js) WITH (x int) j CROSS APPLY STRING_SPLIT(@s, ',') s CROSS APPLY a.doc.nodes('/r') t(n)", { s: ['dbo.A'] }],
    ['the FROM of IS [NOT] DISTINCT FROM and of TRIM names no table', "SELECT * FROM dbo.T t WHERE t.a IS DISTINCT FROM (t.b) AND t.c IS NOT DISTINCT FROM t.d; SELECT TRIM('x' FROM (u.name)), TRIM(LEADING u.pad FROM u.name), TRIM(BOTH CHAR(9) FROM u.code) FROM dbo.U u", { s: ['dbo.T', 'dbo.U'] }],
    ['a variable named @distinct before FROM leaves the FROM clause intact', 'SELECT o.id, @distinct FROM dbo.Orders o JOIN dbo.Lines l ON l.id = o.id; SELECT @trim, x FROM dbo.M', { s: ['dbo.Orders', 'dbo.Lines', 'dbo.M'] }],
    ['ANSI-89 comma list continues after a PIVOT or UNPIVOT clause', 'SELECT * FROM dbo.A a PIVOT (SUM(a.v) FOR a.k IN ([x],[y])) p, dbo.B b; SELECT * FROM dbo.C UNPIVOT (v FOR k IN (c1, c2)) u, dbo.D d, dbo.E', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E'] }],
    ['a JOIN or CROSS APPLY after a PIVOT clause keeps both reads', 'SELECT * FROM dbo.A PIVOT (SUM(v) FOR k IN ([x])) AS p JOIN dbo.C c ON 1=1; SELECT * FROM dbo.F PIVOT (SUM(v) FOR k IN ([x])) q CROSS APPLY dbo.fn(q.x) f', { s: ['dbo.A', 'dbo.C', 'dbo.F', 'dbo.fn'] }],
    ['GRANT, DENY and REVOKE on an object, with or without a column list, move no data', 'GRANT SELECT ON dbo.T (c1, c2) TO u1; GRANT SELECT ON dbo.T(c1) TO u1, u2; GRANT SELECT, UPDATE (c3) ON dbo.U (c1) TO u1; DENY UPDATE ON dbo.V (c1) TO u1; REVOKE SELECT ON OBJECT::dbo.W (c1) FROM u1; GRANT EXECUTE ON dbo.usp_X TO u1;', {}],
    ['UPDATE through a CTE that joins writes no target; both tables are read', ';WITH c AS (SELECT i.Qty, s.Delta FROM dbo.Inventory i JOIN dbo.Shipments s ON s.ItemID = i.ItemID) UPDATE c SET Qty = Qty + Delta;', { s: ['dbo.Inventory', 'dbo.Shipments'] }],
    ['UPDATE through a single-table CTE writes that table; DELETE through it only reads', ';WITH c AS (SELECT * FROM dbo.Inventory WHERE x=1) UPDATE c SET Qty = 0; ;WITH d AS (SELECT * FROM dbo.Old) DELETE FROM d; ;WITH e AS (SELECT * FROM dbo.Gone) DELETE e;', { s: ['dbo.Inventory', 'dbo.Old', 'dbo.Gone'], t: ['dbo.Inventory'] }],
    ['a REVOKE/DENY principal list is no comma list of tables', 'REVOKE SELECT ON dbo.T FROM u1, u2; DENY SELECT ON dbo.T TO u1; REVOKE EXECUTE FROM u1, u2;', {}],
    ['ANSI-89 comma lists after DISTINCT FROM, TRIM(... FROM) and DATEDIFF in the select list', "SELECT IIF(a.x IS DISTINCT FROM b.y, 1, 0), c.z FROM dbo.A a, dbo.B b, dbo.C c; SELECT TRIM(' ' FROM a.n), DATEDIFF(day, a.d, b.d) FROM dbo.D a, dbo.E b", { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E'] }],
    ['ANSI-89 comma list with a hinted member and an aliased member with a nested INDEX hint', 'SELECT * FROM dbo.A a WITH (NOLOCK), dbo.B AS b WITH (INDEX(ix1), NOLOCK), dbo.C', { s: ['dbo.A', 'dbo.B', 'dbo.C'] }],
    ['ANSI-89 comma list with a derived table whose own FROM is a comma list', 'SELECT * FROM dbo.A a, (SELECT id FROM dbo.B, dbo.C) d, dbo.D', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D'] }],
    ['UPDATE alias target with an ANSI-89 comma list in FROM', 'UPDATE a SET a.x = b.x FROM dbo.A a, dbo.B b WHERE a.id = b.id', { s: ['dbo.A', 'dbo.B'], t: ['dbo.A'] }],
    ['a [ inside a string, a line comment or a block comment opens no bracket name', "SELECT '[' + a.n FROM dbo.A a, dbo.B b; -- see [dbo.X\nSELECT * FROM dbo.C; /* see [dbo.Y */\nSELECT * FROM dbo.D", { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D'] }],
    ['an unterminated [ after a valid statement keeps that statement\'s source', 'SELECT * FROM dbo.A; SELECT [oops FROM dbo.B', { s: ['dbo.A'] }],
    ['glued UPDATE[dbo].[T]SET with FROM[dbo].[S][s]', 'UPDATE[dbo].[T]SET x=1 FROM[dbo].[S][s]', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['OPENQUERY and OPENROWSET invent no edge', "SELECT * FROM OPENQUERY(LinkSrv, 'SELECT * FROM dbo.Remote') q JOIN OPENROWSET(BULK 'https://h/f.parquet', FORMAT='PARQUET') r ON 1=1 JOIN dbo.A a ON 1=1", { s: ['dbo.A'] }],
  ],
  'CTEs': [
    ['multiple CTEs feeding an INSERT', 'WITH c1 AS (SELECT * FROM dbo.A), c2 AS (SELECT * FROM c1 JOIN dbo.B ON 1=1) INSERT INTO dbo.T SELECT * FROM c2', { s: ['dbo.A', 'dbo.B'], t: ['dbo.T'] }],
    ['recursive CTE into SELECT INTO', 'WITH r AS (SELECT id FROM dbo.A UNION ALL SELECT a.id FROM dbo.A a JOIN r ON r.id=a.pid) SELECT * INTO dbo.T FROM r', { s: ['dbo.A'], t: ['dbo.T'] }],
    ['CTE name shadowing a real table', 'WITH Orders AS (SELECT * FROM dbo.Orders) SELECT * FROM Orders', { s: ['dbo.Orders'] }],
    ['UPDATE through a CTE writes its base table', 'WITH c AS (SELECT * FROM dbo.T WHERE x=1) UPDATE c SET x=2', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['UPDATE through a CTE joined to a source', 'WITH c AS (SELECT * FROM dbo.T) UPDATE c SET x=s.x FROM c JOIN dbo.S s ON s.id=c.id', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['a CTE joined into the UPDATE under an alias writes its base table', 'WITH c AS (SELECT * FROM dbo.T) UPDATE x SET v=s.v FROM dbo.S s JOIN c x ON x.id=s.id', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['UPDATE through a CTE with a table hint writes its base table', 'WITH c AS (SELECT * FROM dbo.T) UPDATE c WITH (ROWLOCK) SET x=1', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['WITH XMLNAMESPACES before the CTE list', "WITH XMLNAMESPACES ('u' AS ns), c AS (SELECT * FROM dbo.T) UPDATE c SET x=1", { s: ['dbo.T'], t: ['dbo.T'] }],
    ['chained CTEs and a bracketed CTE name resolve to the base table', 'WITH a AS (SELECT * FROM dbo.T), b AS (SELECT * FROM a WHERE x=1) UPDATE b SET x=2; WITH [c] AS (SELECT * FROM [dbo].[U]) UPDATE [c] SET x=1', { s: ['dbo.T', 'dbo.U'], t: ['dbo.T', 'dbo.U'] }],
    ['UPDATE of an alias bound to a CTE in FROM', 'WITH c AS (SELECT * FROM dbo.T) UPDATE x SET v=1 FROM c x', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['CTE with TOP ... ORDER BY, a window function and table hints', 'WITH c AS (SELECT TOP (10) * FROM dbo.T ORDER BY id) UPDATE c SET x=1; WITH d AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) rn FROM dbo.U WITH (UPDLOCK, READPAST)) UPDATE d SET x=rn WHERE rn=1', { s: ['dbo.T', 'dbo.U'], t: ['dbo.T', 'dbo.U'] }],
    ['an unqualified or temp table in a CTE writes nothing', 'WITH c AS (SELECT * FROM T) UPDATE c SET x=1; WITH d AS (SELECT * FROM #t) UPDATE d SET x=1', {}],
    ['a three-part name in a CTE is a cross-database read and write', 'WITH c AS (SELECT * FROM OtherDb.dbo.T) UPDATE c SET x=1', { xs: ['otherdb.dbo.t'], xt: ['otherdb.dbo.t'] }],
    ['self-referencing and mutually recursive CTEs terminate and write nothing', 'WITH c AS (SELECT * FROM c) UPDATE c SET x=1; WITH a AS (SELECT * FROM b), b AS (SELECT * FROM a) UPDATE b SET x=1', {}],
    ['DELETE through a CTE reads its base table and marks no write (known boundary)', 'WITH c AS (SELECT * FROM dbo.T) DELETE FROM c WHERE x=1', { s: ['dbo.T'] }],
    ['INSERT through a CTE resolves no write target (known boundary)', 'WITH c AS (SELECT a FROM dbo.T) INSERT INTO c (a) SELECT a FROM dbo.S', { s: ['dbo.T', 'dbo.S'] }],
    ['MERGE into a CTE resolves no write target (known boundary)', 'WITH c AS (SELECT * FROM dbo.T WHERE p=1) MERGE c AS t USING dbo.S s ON t.id=s.id WHEN MATCHED THEN DELETE;', { s: ['dbo.T', 'dbo.S'] }],
    ['CTE as MERGE source', 'WITH s AS (SELECT * FROM dbo.S) MERGE dbo.T t USING s ON t.id=s.id WHEN MATCHED THEN DELETE;', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['a later INSERT into a table named like an earlier CTE writes no CTE source', 'WITH Stage AS (SELECT * FROM dbo.Src) SELECT * FROM Stage; INSERT INTO Stage SELECT * FROM dbo.X', { s: ['dbo.Src', 'dbo.X'] }],
    ['a later MERGE into a table named like an earlier CTE writes no CTE source', 'WITH Stage AS (SELECT * FROM dbo.Src) SELECT * FROM Stage; MERGE Stage AS t USING dbo.X s ON t.id=s.id WHEN MATCHED THEN DELETE;', { s: ['dbo.Src', 'dbo.X'] }],
    ['MERGE into a joining CTE writes no single table', 'WITH c AS (SELECT * FROM dbo.A a JOIN dbo.B b ON a.id=b.id) MERGE c AS t USING dbo.S s ON t.id=s.id WHEN MATCHED THEN DELETE;', { s: ['dbo.A', 'dbo.B', 'dbo.S'] }],
    ['UPDATE through a CTE over a derived table writes its base table', 'WITH c AS (SELECT * FROM (SELECT * FROM dbo.T) d) UPDATE c SET x=1', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['UPDATE through a CTE filtered by a subquery writes the CTE base table', 'WITH c AS (SELECT * FROM dbo.T WHERE id IN (SELECT id FROM dbo.S)) UPDATE c SET x=1', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['UPDATE through a CTE filtered by IS DISTINCT FROM writes its base table', 'WITH c AS (SELECT x FROM dbo.T WHERE a IS DISTINCT FROM b) UPDATE c SET x=1', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['UPDATE through a CTE with a column list writes its base table', 'WITH c (a) AS (SELECT a FROM dbo.T) UPDATE c SET a=1', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['UPDATE through a CTE with a select-list subquery writes the outer table', 'WITH c AS (SELECT x, (SELECT MAX(v) FROM dbo.Y) m FROM dbo.X) UPDATE c SET x=1', { s: ['dbo.X', 'dbo.Y'], t: ['dbo.X'] }],
    ['UPDATE through a joining CTE writes no single table', 'WITH c AS (SELECT a.x, b.y FROM dbo.A a JOIN dbo.B b ON a.id=b.id) UPDATE c SET y=1', { s: ['dbo.A', 'dbo.B'] }],
    ['UPDATE through a CTE joining one table to a GROUP BY derived table writes that table', 'WITH c AS (SELECT t.x, g.n FROM dbo.T t LEFT JOIN (SELECT id, COUNT(*) n FROM dbo.S GROUP BY id) g ON g.id=t.id) UPDATE c SET x=n', { s: ['dbo.S', 'dbo.T'], t: ['dbo.T'] }],
    ['UPDATE through a CTE joining a DISTINCT derived table to one table writes that table', 'WITH c AS (SELECT t.x FROM (SELECT DISTINCT id FROM dbo.S) d JOIN dbo.T t ON t.id=d.id) UPDATE c SET x=1', { s: ['dbo.S', 'dbo.T'], t: ['dbo.T'] }],
    ['UPDATE through a CTE joining one table to a UNION derived table writes that table', 'WITH c AS (SELECT t.x FROM dbo.T t JOIN (SELECT id FROM dbo.S UNION ALL SELECT id FROM dbo.R) d ON d.id=t.id) UPDATE c SET x=1', { s: ['dbo.R', 'dbo.S', 'dbo.T'], t: ['dbo.T'] }],
    ['UPDATE through a CTE joining one table to a writable derived table writes no single table', 'WITH c AS (SELECT t.x, d.y FROM dbo.T t JOIN (SELECT id, y FROM dbo.S) d ON d.id=t.id) UPDATE c SET y=1', { s: ['dbo.S', 'dbo.T'] }],
    ['UPDATE through a CTE joining one table to a TOP derived table writes no single table', 'WITH c AS (SELECT t.x, d.y FROM dbo.T t JOIN (SELECT TOP 1 id, y FROM dbo.S ORDER BY id) d ON d.id=t.id) UPDATE c SET y=2', { s: ['dbo.S', 'dbo.T'] }],
    ['UPDATE through a CTE joining a table function to a GROUP BY derived table writes no single table', 'WITH c AS (SELECT f.x FROM dbo.F(1) f JOIN (SELECT id FROM dbo.S GROUP BY id) g ON g.id=f.id) UPDATE c SET x=1', { s: ['dbo.F', 'dbo.S'] }],
    ['UPDATE through a CTE whose derived member is aliased window, joined to two tables, writes no single table', 'WITH c AS (SELECT t.x, u.z FROM dbo.T t JOIN (SELECT DISTINCT id FROM dbo.S) AS window ON window.id=t.id JOIN dbo.U u ON u.id=t.id) UPDATE c SET z=99', { s: ['dbo.S', 'dbo.T', 'dbo.U'] }],
    ['UPDATE through a CTE joining a table aliased window to a second table writes no single table', 'WITH c AS (SELECT u.z FROM dbo.T AS window JOIN dbo.U u ON u.id=window.id) UPDATE c SET z=1', { s: ['dbo.T', 'dbo.U'] }],
    ['UPDATE through a CTE with a WINDOW clause over one table writes that table', 'WITH c AS (SELECT t.x, SUM(t.x) OVER w AS total FROM dbo.T t WINDOW w AS (PARTITION BY t.id)) UPDATE c SET x=1', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['UPDATE through a CTE listing one table and a DISTINCT derived table with a comma writes that table', 'WITH c AS (SELECT t.x FROM dbo.T t, (SELECT DISTINCT id FROM dbo.S) d WHERE d.id=t.id) UPDATE c SET x=1', { s: ['dbo.S', 'dbo.T'], t: ['dbo.T'] }],
    ['UPDATE through a comma-joining CTE writes no single table', 'WITH c AS (SELECT a.x, b.y FROM dbo.A a, dbo.B b WHERE a.id=b.id) UPDATE c SET y=1', { s: ['dbo.A', 'dbo.B'] }],
    ['UPDATE through a UNION CTE writes no single table', 'WITH c AS (SELECT * FROM dbo.A UNION ALL SELECT * FROM dbo.B) UPDATE c SET x=1', { s: ['dbo.A', 'dbo.B'] }],
    ['a later CTE of the same name does not retarget an earlier UPDATE', 'WITH c AS (SELECT * FROM dbo.A) UPDATE c SET x=1; WITH c AS (SELECT * FROM dbo.B) SELECT * FROM c', { s: ['dbo.A', 'dbo.B'], t: ['dbo.A'] }],
    ['a later UPDATE named like an earlier CTE writes no CTE source', 'WITH c AS (SELECT * FROM dbo.A) SELECT * FROM c; UPDATE c SET x=1', { s: ['dbo.A'] }],
    ['UPDATE TOP (n) through a CTE writes its base table', 'WITH c AS (SELECT * FROM dbo.T) UPDATE TOP (5) c SET x=1; WITH d AS (SELECT * FROM dbo.U) UPDATE TOP (@n) PERCENT d SET x=1', { s: ['dbo.T', 'dbo.U'], t: ['dbo.T', 'dbo.U'] }],
    ['UPDATE TOP with a nested expression through a CTE writes its base table', 'WITH c AS (SELECT * FROM dbo.T) UPDATE TOP (ABS(@n)) c SET x=1', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['UPDATE TOP (n) through a joining CTE writes no single table', 'WITH c AS (SELECT * FROM dbo.A a JOIN dbo.B b ON a.id=b.id) UPDATE TOP (5) c SET x=1', { s: ['dbo.A', 'dbo.B'] }],
    ['a later UPDATE ... FROM a table named like an earlier CTE writes no CTE source', 'WITH c AS (SELECT * FROM dbo.A) SELECT * FROM c; UPDATE t SET x=1 FROM c t', { s: ['dbo.A'] }],
  ],
  'INSERT and SELECT INTO': [
    ['INSERT INTO ... SELECT', 'INSERT INTO dbo.T (a, b) SELECT a, b FROM dbo.S', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['INSERT without INTO and with a column list', 'INSERT dbo.T(a) SELECT a FROM dbo.S', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['INSERT ... VALUES and DEFAULT VALUES', 'INSERT INTO dbo.T (a) VALUES (1), (2); INSERT INTO dbo.U DEFAULT VALUES', { t: ['dbo.T', 'dbo.U'] }],
    ['INSERT ... EXEC with a return code', 'INSERT INTO dbo.T EXEC @rc = dbo.uspGet @p = 1', { t: ['dbo.T'], x: ['dbo.uspGet'] }],
    ['INSERT ... WITH (TABLOCK)', 'INSERT INTO dbo.T WITH (TABLOCK) (a) SELECT a FROM dbo.S', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['INSERT TOP (n) INTO', 'INSERT TOP (10) INTO dbo.T SELECT * FROM dbo.S', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['INSERT TOP (n) without INTO', 'INSERT TOP (10) dbo.T SELECT * FROM dbo.S', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['INSERT TOP with a subquery or a nested expression', 'INSERT TOP (SELECT COUNT(*) FROM dbo.C) INTO dbo.T SELECT * FROM dbo.S; INSERT TOP ((SELECT COUNT(*) FROM dbo.D)) dbo.U SELECT * FROM dbo.S; INSERT TOP (dbo.fnN(1)) PERCENT INTO dbo.V SELECT * FROM dbo.S', { s: ['dbo.C', 'dbo.D', 'dbo.S', 'dbo.fnN'], t: ['dbo.T', 'dbo.U', 'dbo.V'] }],
    ['INSERT TOP (n) PERCENT, with a hint and column list, and fed by EXEC', 'INSERT TOP (10) PERCENT INTO dbo.T SELECT * FROM dbo.S; INSERT TOP (5) INTO dbo.U WITH (TABLOCK) (a) SELECT a FROM dbo.S; INSERT TOP (5) INTO dbo.V EXEC dbo.uspGet', { s: ['dbo.S'], t: ['dbo.T', 'dbo.U', 'dbo.V'], x: ['dbo.uspGet'] }],
    ['SELECT ... INTO', 'SELECT a, b INTO dbo.T FROM dbo.S WHERE 1=0', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['SELECT ... INTO ... ON filegroup', 'SELECT a INTO dbo.T ON [fg1] FROM dbo.S; SELECT a INTO dbo.U ON fg2 FROM dbo.S', { s: ['dbo.S'], t: ['dbo.T', 'dbo.U'] }],
    ['SELECT ... INTO without FROM', 'SELECT 1 AS a INTO dbo.T; SELECT 1 AS a INTO dbo.U WHERE 1=0; SELECT 1 AS a INTO dbo.V UNION ALL SELECT 2; SELECT 1 AS a INTO dbo.W ON [PRIMARY]', { t: ['dbo.T', 'dbo.U', 'dbo.V', 'dbo.W'] }],
    ['SELECT ... INTO without FROM and without a statement terminator', 'BEGIN SELECT 1 AS a INTO dbo.T END\nIF 1=1 SELECT 1 AS a INTO dbo.U ELSE SELECT 2 AS a INTO dbo.V\nSELECT 1 AS a INTO dbo.W\nSELECT 1\nSELECT 1 AS a INTO dbo.X ON fg1\nSELECT 1', { t: ['dbo.T', 'dbo.U', 'dbo.V', 'dbo.W', 'dbo.X'] }],
    ['RECEIVE INTO a table variable and SELECT @variable = write no table', 'RECEIVE TOP (1) * FROM dbo.Q INTO @t; SELECT @x = a FROM dbo.S', { s: ['dbo.Q', 'dbo.S'] }],
    ['INSERT INTO, MERGE INTO and OUTPUT INTO name exactly their own targets', 'INSERT INTO dbo.T (a) OUTPUT inserted.a INTO dbo.H (a) SELECT a FROM dbo.S; MERGE INTO dbo.M AS m USING dbo.S s ON m.id=s.id WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id) OUTPUT inserted.id INTO @ids;', { s: ['dbo.S'], t: ['dbo.T', 'dbo.H', 'dbo.M'] }],
    ['SELECT ... INTO ... ON filegroup FROM a join, into a three-part name, and with OPTION', 'SELECT a INTO dbo.T ON [PRIMARY] FROM dbo.S s JOIN dbo.U u ON u.id=s.id; SELECT a INTO OtherDb.dbo.V FROM dbo.S; SELECT a INTO dbo.W FROM dbo.S OPTION (MAXDOP 1)', { s: ['dbo.S', 'dbo.U'], t: ['dbo.T', 'dbo.W'], xt: ['otherdb.dbo.v'] }],
    ['FETCH INTO variables and SELECT INTO a temp table write no table', 'FETCH NEXT FROM cur INTO @a, @b; SELECT 1 AS a INTO #t; INSERT INTO dbo.T SELECT * FROM #t', { t: ['dbo.T'] }],
    ['temp tables and table variables are not nodes', 'SELECT a INTO #t FROM dbo.S; INSERT INTO ##g SELECT * FROM #t; INSERT INTO @v SELECT 1; INSERT INTO dbo.T SELECT * FROM @v JOIN #t ON 1=1', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['a schema-qualified temp table is not a node', 'SELECT a INTO dbo.#t FROM dbo.S; SELECT * FROM dbo.#t; INSERT INTO dbo.#t SELECT 1; INSERT INTO dbo.##g SELECT * FROM dbo.##g; UPDATE dbo.#t SET a=1; UPDATE x SET a=1 FROM dbo.#t x JOIN dbo.U u ON u.id=x.id', { s: ['dbo.S', 'dbo.U'] }],
    ['a schema-qualified temp table with a database part or delimiters is not a node', 'SELECT * FROM tempdb.dbo.#t JOIN [db].[dbo].[#u] ON 1=1; SELECT a INTO tempdb.dbo.##g FROM dbo.S; SELECT * FROM [db].[#v]; INSERT INTO [dbo].[#w] SELECT * FROM dbo.S; UPDATE tempdb.dbo.#t SET a=1; UPDATE x SET a=1 FROM [dbo].[#t] x', { s: ['dbo.S'] }],
    ['NEXT VALUE FOR a sequence', 'INSERT INTO dbo.T (id) VALUES (NEXT VALUE FOR dbo.SeqT)', { t: ['dbo.T'] }],
  ],
  'UPDATE': [
    ['aliased target in FROM/JOIN', 'UPDATE t SET t.x=s.x FROM dbo.T t JOIN dbo.S s ON s.id=t.id', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['unaliased target repeated in FROM', 'UPDATE dbo.T SET x=s.x FROM dbo.T JOIN dbo.S s ON s.id=T.id', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['target named only in FROM', 'UPDATE T SET x=1 FROM dbo.T WHERE x=0', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['plain target with a SET subquery', 'UPDATE dbo.T SET x=(SELECT MAX(y) FROM dbo.S)', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['table hint on the target', 'UPDATE dbo.T WITH (ROWLOCK) SET x=1', { t: ['dbo.T'] }],
    ['bracketed alias with AS', 'UPDATE [t] SET x=1 FROM [dbo].[T] AS [t] INNER JOIN dbo.S s ON s.id=[t].id', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['keyword-like aliases target and source', 'UPDATE target SET x=1 FROM dbo.T target JOIN dbo.S source ON source.id=target.id', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['OUTPUT ... INTO a history table', 'UPDATE t SET x=1 OUTPUT inserted.x INTO dbo.Hist FROM dbo.T t', { s: ['dbo.T'], t: ['dbo.T', 'dbo.Hist'] }],
    ['UPDATE TOP (n) of a qualified table', 'UPDATE TOP (5) dbo.T SET x=1; UPDATE TOP (@n) PERCENT dbo.U SET x=1', { t: ['dbo.T', 'dbo.U'] }],
    ['UPDATE TOP (n) of an alias', 'UPDATE TOP (5) t SET x=1 FROM dbo.T t JOIN dbo.S s ON s.id=t.id', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['UPDATE TOP with a nested expression', 'UPDATE TOP (ABS(@n)) dbo.T SET x=1; UPDATE TOP (CAST(@n AS int)) u SET x=1 FROM dbo.U u; UPDATE TOP ((SELECT n FROM dbo.N)) v SET x=1 FROM dbo.V v', { s: ['dbo.U', 'dbo.N', 'dbo.V'], t: ['dbo.T', 'dbo.U', 'dbo.V'] }],
    ['UPDATE TOP(n) without a space, with a table hint, and with OUTPUT INTO', 'UPDATE TOP(5) dbo.T SET x=1; UPDATE TOP (5) dbo.U WITH (ROWLOCK) SET x=1; UPDATE TOP (10) dbo.V SET x=1 OUTPUT deleted.x INTO dbo.Hist', { t: ['dbo.T', 'dbo.U', 'dbo.V', 'dbo.Hist'] }],
    ['unaliased target followed by FULL OUTER JOIN, OUTER APPLY, OPTION or TABLESAMPLE', 'UPDATE A SET c=1 FROM dbo.A FULL OUTER JOIN dbo.O o ON o.id=A.id; UPDATE B SET c=1 FROM dbo.B OUTER APPLY (SELECT TOP 1 * FROM dbo.P p) x; UPDATE C SET c=1 FROM dbo.C OPTION (RECOMPILE); UPDATE D SET c=1 FROM dbo.D TABLESAMPLE (10 PERCENT)', { s: ['dbo.A', 'dbo.O', 'dbo.B', 'dbo.P', 'dbo.C', 'dbo.D'], t: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D'] }],
    ['aliased target with a scalar subquery in SET', 'UPDATE t SET x=(SELECT MAX(y) FROM dbo.S s WHERE s.id=t.id) FROM dbo.T t', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['aliased target with EXISTS in SET', 'UPDATE t SET x=CASE WHEN EXISTS (SELECT 1 FROM dbo.S) THEN 1 END FROM dbo.T t', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['aliased target joined after a derived table', 'UPDATE t SET x=d.x FROM (SELECT id, x FROM dbo.S) d JOIN dbo.T t ON t.id=d.id', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['unterminated unqualified UPDATE before an aliased UPDATE', 'UPDATE a SET x=1 WHERE y=2\nUPDATE b SET z=1 FROM dbo.T b', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['unaliased target followed by a transaction or control-flow statement', "BEGIN TRAN\nUPDATE A SET c=1 FROM dbo.A\nCOMMIT TRAN\nUPDATE B SET c=1 FROM dbo.B\nROLLBACK TRAN\nUPDATE C SET c=1 FROM dbo.C\nPRINT 'x'\nUPDATE D SET c=1 FROM dbo.D\nIF @@ROWCOUNT = 0 RETURN\nUPDATE E SET c=1 FROM dbo.E\nWHILE @i < 3 BEGIN UPDATE F SET c=1 FROM dbo.F\nBREAK END\nUPDATE G SET c=1 FROM dbo.G\nGOTO done\nUPDATE H SET c=1 FROM dbo.H\nRAISERROR('x', 16, 1)\nUPDATE I SET c=1 FROM dbo.I\nWAITFOR DELAY '00:00:01'", { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E', 'dbo.F', 'dbo.G', 'dbo.H', 'dbo.I'], t: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E', 'dbo.F', 'dbo.G', 'dbo.H', 'dbo.I'] }],
    ['unaliased target followed by a block end, cursor or session statement', 'IF @a = 1 BEGIN UPDATE A SET c=1 FROM dbo.A\nEND ELSE UPDATE B SET c=1 FROM dbo.B\nELSE UPDATE C SET c=1 FROM dbo.C\nRETURN\nUPDATE D SET c=1 FROM dbo.D\nDECLARE @x int\nUPDATE E SET c=1 FROM dbo.E\nSET @x = 1\nUPDATE F SET c=1 FROM dbo.F\nEXEC dbo.uspA\nUPDATE G SET c=1 FROM dbo.G\nOPEN cur\nUPDATE H SET c=1 FROM dbo.H\nFETCH NEXT FROM cur INTO @x\nUPDATE I SET c=1 FROM dbo.I\nCLOSE cur\nUPDATE J SET c=1 FROM dbo.J\nDEALLOCATE cur', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E', 'dbo.F', 'dbo.G', 'dbo.H', 'dbo.I', 'dbo.J'], t: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E', 'dbo.F', 'dbo.G', 'dbo.H', 'dbo.I', 'dbo.J'], x: ['dbo.uspA'] }],
    ['words the SQL Server parser accepts as identifiers are aliases and CTE names', 'UPDATE label SET qty = 1 FROM dbo.ShippingLabel AS label WHERE label.id = @id; WITH within AS (SELECT * FROM dbo.W) UPDATE within SET x = 1; UPDATE load SET a = 1 FROM (SELECT * FROM dbo.L) load; UPDATE precision SET a = 1 FROM dbo.P precision; UPDATE disk SET a = 1 FROM dbo.D disk; UPDATE dump SET a = 1 FROM dbo.U dump; UPDATE securityaudit SET a = 1 FROM dbo.A securityaudit', { s: ['dbo.ShippingLabel', 'dbo.W', 'dbo.L', 'dbo.P', 'dbo.D', 'dbo.U', 'dbo.A'], t: ['dbo.ShippingLabel', 'dbo.W', 'dbo.L', 'dbo.P', 'dbo.D', 'dbo.U', 'dbo.A'] }],
    ['a word that is not reserved is the alias of the table before it, as SQL Server reads it', 'UPDATE T SET c=1 FROM dbo.T\nTHROW', { s: ['dbo.T'] }],
    ['a SET list of any length keeps the aliased write', `UPDATE t SET x=1${', y=1'.repeat(1000)} FROM dbo.T t`, { s: ['dbo.T'], t: ['dbo.T'] }],
    ['alias of a derived table writes its single base table', 'UPDATE d SET x=1 FROM (SELECT * FROM dbo.T WHERE y=1) d', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['alias of a joined derived table with AS and a column list', 'UPDATE d SET x=s.x FROM dbo.S s JOIN (SELECT id, x FROM dbo.T) AS d (id, x) ON d.id=s.id', { s: ['dbo.T', 'dbo.S'], t: ['dbo.T'] }],
    ['UPDATE TOP (n) of a derived-table alias', 'UPDATE TOP (5) d SET x=1 FROM (SELECT * FROM dbo.T) d', { s: ['dbo.T'], t: ['dbo.T'] }],
    ['derived-table alias after LEFT JOIN and CROSS JOIN, nested, and with TOP ... ORDER BY', 'UPDATE d SET x=1 FROM dbo.S s LEFT JOIN (SELECT * FROM dbo.T) d ON d.id=s.id; UPDATE e SET x=1 FROM dbo.S s CROSS JOIN (SELECT * FROM dbo.U) e; UPDATE f SET x=1 FROM (SELECT * FROM (SELECT * FROM dbo.V) i) f; UPDATE g SET x=1 FROM (SELECT TOP (5) * FROM dbo.W ORDER BY id) AS g', { s: ['dbo.S', 'dbo.T', 'dbo.U', 'dbo.V', 'dbo.W'], t: ['dbo.T', 'dbo.U', 'dbo.V', 'dbo.W'] }],
    ['an alias of a VALUES constructor or of an APPLY subquery writes nothing', 'UPDATE v SET x=1 FROM (VALUES (1)) v(x); UPDATE d SET x=1 FROM dbo.S s CROSS APPLY (SELECT * FROM dbo.T t WHERE t.id=s.id) d', { s: ['dbo.S', 'dbo.T'] }],
    ['alias of a derived table over an inline table-valued function names the function as written', 'UPDATE d SET x=1 FROM (SELECT * FROM dbo.fnRows(1)) d', { s: ['dbo.fnRows'], t: ['dbo.fnRows'] }],
    ['alias of a joining derived table writes no single table', 'UPDATE d SET x=1 FROM (SELECT a.x FROM dbo.A a JOIN dbo.B b ON a.id=b.id) d', { s: ['dbo.A', 'dbo.B'] }],
    ['alias of a UNION derived table writes no single table', 'UPDATE d SET x=1 FROM (SELECT x FROM dbo.A UNION ALL SELECT x FROM dbo.B) d', { s: ['dbo.A', 'dbo.B'] }],
    ['an alias bound to no table writes nothing', 'UPDATE x SET v=1 FROM (SELECT * FROM dbo.T) d', { s: ['dbo.T'] }],
    ['an alias bound twice writes nothing', 'UPDATE d SET v=1 FROM (SELECT * FROM dbo.T) d JOIN dbo.U d ON 1=1', { s: ['dbo.T', 'dbo.U'] }],
    ['two-part target compared in WHERE', 'UPDATE dbo.T SET x=s.x FROM dbo.S s WHERE s.id=dbo.T.id', { s: ['dbo.S'], t: ['dbo.T'] }],
  ],
  'DELETE, TRUNCATE and MERGE': [
    ['DELETE alias FROM ... JOIN reads the joined table', 'DELETE t FROM dbo.T t JOIN dbo.S s ON s.id=t.id', { s: ['dbo.T', 'dbo.S'] }],
    ['DELETE without FROM keyword', 'DELETE dbo.T WHERE x=1', {}],
    ['DELETE ... OUTPUT INTO writes the archive', 'DELETE FROM dbo.T OUTPUT deleted.* INTO dbo.Hist WHERE x=1', { s: ['dbo.T'], t: ['dbo.Hist'] }],
    ['TRUNCATE TABLE', 'TRUNCATE TABLE dbo.T', {}],
    ['MERGE target, USING table and OUTPUT INTO', 'MERGE dbo.T AS tgt USING dbo.S AS src ON tgt.id=src.id WHEN MATCHED THEN UPDATE SET x=src.x WHEN NOT MATCHED THEN INSERT (id) VALUES (src.id) OUTPUT $action INTO dbo.Audit (a);', { s: ['dbo.S'], t: ['dbo.T', 'dbo.Audit'] }],
    ['MERGE INTO with a USING subquery', 'MERGE INTO dbo.T t USING (SELECT * FROM dbo.S JOIN dbo.S2 ON 1=1) s ON t.id=s.id WHEN MATCHED THEN DELETE;', { s: ['dbo.S', 'dbo.S2'], t: ['dbo.T'] }],
    ['MERGE with a parenthesised joined table as USING source', 'MERGE dbo.T t USING (dbo.A a JOIN dbo.B b ON a.id=b.id) ON t.id=a.id WHEN MATCHED THEN DELETE; MERGE dbo.U u USING((dbo.C c JOIN dbo.D d ON 1=1) JOIN dbo.E e ON 1=1) ON u.id=c.id WHEN MATCHED THEN DELETE;', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D', 'dbo.E'], t: ['dbo.T', 'dbo.U'] }],
    ['MERGE TOP (n) PERCENT and MERGE TOP (n) without INTO', 'MERGE TOP (5) PERCENT INTO dbo.T AS t USING dbo.S s ON t.id=s.id WHEN MATCHED THEN DELETE; MERGE TOP (10) dbo.U AS u USING dbo.S s ON u.id=s.id WHEN MATCHED THEN DELETE;', { s: ['dbo.S'], t: ['dbo.T', 'dbo.U'] }],
    ['MERGE with a target hint and a TVF source', 'MERGE dbo.T WITH (HOLDLOCK) AS t USING dbo.fnSrc(1) s ON t.id=s.id WHEN MATCHED THEN DELETE;', { s: ['dbo.fnSrc'], t: ['dbo.T'] }],
    ['MERGE TOP (n) INTO', 'MERGE TOP (10) INTO dbo.T AS t USING dbo.S s ON t.id=s.id WHEN MATCHED THEN DELETE;', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['MERGE TOP with a nested expression', 'MERGE TOP (ABS(@n)) INTO dbo.T AS t USING dbo.S s ON t.id=s.id WHEN MATCHED THEN DELETE;', { s: ['dbo.S'], t: ['dbo.T'] }],
  ],
  'EXEC and dynamic SQL': [
    ['EXEC and EXECUTE', 'EXEC dbo.uspA; EXECUTE dbo.uspB 1, 2', { x: ['dbo.uspA', 'dbo.uspB'] }],
    ['return code and bracketed names', 'EXEC @rc = [dbo].[usp A] @p = 1; EXECUTE @rc=[Sales].[uspB]', { x: ['dbo.usp A', 'Sales.uspB'] }],
    ['schema-less procedure is not resolved', 'EXEC uspA', {}],
    ['EXEC WITH RESULT SETS', 'EXEC dbo.uspA WITH RESULT SETS ((a int))', { x: ['dbo.uspA'] }],
    ['dynamic SQL invents no edge', "EXEC (@sql); EXEC ('SELECT * FROM dbo.Hidden'); EXEC sp_executesql @sql; EXEC ('SELECT 1') AT LinkSrv; INSERT INTO dbo.T EXEC ('SELECT * FROM dbo.Hidden2'); SET @s = N'EXEC dbo.uspHidden'", { t: ['dbo.T'] }],
    ['EXECUTE AS is a context switch, not a call', "CREATE PROCEDURE dbo.p WITH EXECUTE AS OWNER AS EXECUTE AS USER = 'u'; SELECT * FROM dbo.A; REVERT", { s: ['dbo.A'] }],
  ],
  'names, functions and cross-database references': [
    ['2-part synonym is an ordinary reference', 'SELECT * FROM dbo.SynA', { s: ['dbo.SynA'] }],
    ['3-part and 4-part names are cross-database', 'SELECT * FROM OtherDb.dbo.A JOIN LinkSrv.Db2.dbo.B ON 1=1; INSERT INTO OtherDb.dbo.T SELECT * FROM dbo.S', { s: ['dbo.S'], xs: ['otherdb.dbo.a', 'db2.dbo.b'], xt: ['otherdb.dbo.t'] }],
    ['a schema-qualified system type with a length is no function call', 'DECLARE @a sys.varchar(10), @b sys.decimal(10,2), @c [sys].[nvarchar](max); SELECT CAST(x AS sys.nvarchar(20)), CONVERT(sys.varchar(10), 1), TRY_CAST(1 AS SYS.DateTime2(3)) FROM dbo.A', { s: ['dbo.A'] }],
    ['a system type in parameters, RETURNS, a table variable and OPENJSON WITH is no function call', "CREATE PROCEDURE dbo.p @a sys.varchar(10), @b sys.varbinary(max) AS DECLARE @t TABLE (c sys.char(1)); SELECT * FROM dbo.A a CROSS APPLY OPENJSON(a.js) WITH (c sys.char(1) '$.x', d sys.decimal(5,2) '$.y') j; GO CREATE FUNCTION dbo.f (@a sys.nchar(3)) RETURNS sys.nvarchar(5) AS BEGIN RETURN 1 END", { s: ['dbo.A'] }],
    ['a function call in a JOIN condition after a GRANT without ON or a semicolon is still a read', 'GRANT CONNECT TO u SELECT 1 FROM t JOIN v ON dbo.fnKey(1)=1; GRANT EXECUTE TO u2\nSELECT 1\nFROM t2\nINNER JOIN v2 ON dbo.fnK2(v2.id)=1', { s: ['dbo.fnKey', 'dbo.fnK2'] }],
    ['the DEC synonym of DECIMAL as a sys type is no function call', 'DECLARE @a sys.dec(10,2); DECLARE @t2 TABLE (b [sys].[dec](5)); SELECT CAST(x AS sys.dec(10,2)), CONVERT(SYS.DEC(18,4), x) FROM dbo.A', { s: ['dbo.A'] }],
    ['sys functions and functions named like a type are still calls', 'SELECT sys.fn_varbintohexstr(x), sys.varchar_len(y), dbo.varchar(1), [sys].[fn_a](1) FROM dbo.A', { s: ['sys.fn_varbintohexstr', 'sys.varchar_len', 'dbo.varchar', 'sys.fn_a', 'dbo.A'] }],
    ['TVF in FROM and scalar UDF in the select list', 'SELECT dbo.fnScalar(a.x) y, OtherDb.dbo.fnRemote(1) z FROM dbo.fnRows(1) a', { s: ['dbo.fnScalar', 'dbo.fnRows'], xs: ['otherdb.dbo.fnremote'] }],
    ['dotted, spaced and quoted identifiers', 'SELECT * FROM [dbo].[a.b] JOIN "dbo"."x y" ON 1=1 JOIN [My Schema].[My Table] t ON 1=1', { s: ['dbo.a.b', 'dbo.x y', 'My Schema.My Table'] }],
    ['whitespace around the dot of a multipart name', 'SELECT * FROM dbo . A JOIN [dbo] . [B] ON 1=1 JOIN dbo .C ON 1=1 JOIN dbo.\n  D ON 1=1; INSERT INTO dbo . T SELECT 1; UPDATE dbo . U SET x=1; EXEC dbo . uspA; SELECT * FROM OtherDb . dbo . X', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D'], t: ['dbo.T', 'dbo.U'], x: ['dbo.uspA'], xs: ['otherdb.dbo.x'] }],
    ['tab and newline around the period, quoted identifiers and a spaced function call', 'SELECT * FROM dbo\t.\n[T]; SELECT * FROM "dbo" . "U"; SELECT dbo . fnA (1) FROM dbo.S', { s: ['dbo.T', 'dbo.U', 'dbo.fnA', 'dbo.S'] }],
    ['numbers and a variable method next to a period are not names', "SELECT 1.5 AS x, 2 . 5 FROM dbo.T t WHERE t.x > .5 AND t.n = 1e5 AND t.c = @v .value('.', 'int')", { s: ['dbo.T'] }],
    ['whitespace inside brackets and numbers before a dot are not name separators', 'SELECT 1. AS n, x FROM [dbo . A] JOIN [dbo].[b . c] ON 1=1 WHERE y > 2. AND z = 1', { s: ['dbo.b . c'] }],
    ['escaped ]] and "" inside identifiers', 'SELECT * FROM [dbo].[we]]ird] w JOIN "dbo"."q""t" q ON 1=1', { s: ['dbo.we]ird', 'dbo.q"t'] }],
    ['Unicode and $ in regular identifiers', 'SELECT * FROM dbo.Tabelle_Ä JOIN dbo.A$B ON 1=1', { s: ['dbo.Tabelle_Ä', 'dbo.A$B'] }],
    ['keywords as aliases and column names equal to table names', 'SELECT A.A, B FROM dbo.A A JOIN dbo.B [left] ON [left].B = A.A JOIN dbo.C source ON 1=1 JOIN dbo.D target ON 1=1', { s: ['dbo.A', 'dbo.B', 'dbo.C', 'dbo.D'] }],
    ['bracketed reserved words as table names', 'SELECT * FROM [dbo].[Order] o JOIN [dbo].[Select] s ON 1=1', { s: ['dbo.Order', 'dbo.Select'] }],
    ['mixed keyword and identifier case', 'select * From DBO.MyTable join Dbo.Other on 1=1', { s: ['dbo.mytable', 'dbo.other'] }],
    ['a keyword glued to a delimited name: EXEC and EXECUTE', 'EXEC[dbo].[uspA]; EXECUTE[dbo].[uspB] 1; EXEC @rc =[dbo].[uspC]; EXEC[dbo].[usp D] @p = 1', { x: ['dbo.uspA', 'dbo.uspB', 'dbo.uspC', 'dbo.usp D'] }],
    ['a keyword glued to a delimited name: FROM, JOIN and APPLY', 'SELECT * FROM[dbo].[A] a INNER JOIN[dbo].[B] b ON 1=1 LEFT JOIN[dbo].[L] l ON 1=1 CROSS JOIN[dbo].[K] CROSS APPLY[dbo].[fnC](1) f OUTER APPLY[dbo].[fnD](2) g; SELECT * FROM"dbo"."Q" q', { s: ['dbo.A', 'dbo.B', 'dbo.L', 'dbo.K', 'dbo.fnC', 'dbo.fnD', 'dbo.Q'] }],
    ['a keyword glued to a delimited name: INSERT, UPDATE, MERGE and USING', 'INSERT INTO[dbo].[W] SELECT 1; INSERT[dbo].[X] SELECT 1; UPDATE[dbo].[T] SET a=1; MERGE[dbo].[M] AS m USING[dbo].[S] s ON 1=1 WHEN MATCHED THEN DELETE; MERGE INTO[dbo].[N] AS n USING dbo.S2 s ON 1=1 WHEN MATCHED THEN DELETE;', { s: ['dbo.S', 'dbo.S2'], t: ['dbo.W', 'dbo.X', 'dbo.T', 'dbo.M', 'dbo.N'] }],
    ['a keyword glued to a delimited name: INTO, OUTPUT INTO, DELETE FROM, bulk loads, CTAS and an UPDATE alias', "SELECT 1 AS a INTO[dbo].[N] FROM[dbo].[S]; INSERT INTO dbo.T OUTPUT inserted.a INTO[dbo].[L] SELECT 1; DELETE FROM[dbo].[D] WHERE 1=0; BULK INSERT[dbo].[BI] FROM 'f'; COPY INTO[dbo].[CI] FROM 'f'; CREATE TABLE[dbo].[CT] WITH (DISTRIBUTION = ROUND_ROBIN) AS SELECT * FROM dbo.S3; CREATE EXTERNAL TABLE[ext].[CE] WITH (LOCATION='/x') AS SELECT 1; UPDATE[t] SET a=1 FROM[dbo].[U] t", { s: ['dbo.S', 'dbo.D', 'dbo.S3', 'dbo.U'], t: ['dbo.N', 'dbo.T', 'dbo.L', 'dbo.BI', 'dbo.CI', 'dbo.CT', 'ext.CE', 'dbo.U'] }],
    ['a keyword glued to a delimited function name is a call; glued DDL names are not', 'SELECT[dbo].[fnS] (1), (SELECT[dbo].[fnT](2)) FROM dbo.A; SELECT * FROM[dbo].[fnR](1); CREATE TABLE dbo.X (a int REFERENCES[dbo].[B](id)); CREATE INDEX ix ON[dbo].[Ix](c); CREATE FUNCTION[dbo].[fnDef](@a int) RETURNS int AS BEGIN RETURN 1 END', { s: ['dbo.fnS', 'dbo.fnT', 'dbo.A', 'dbo.fnR'] }],
    ['FROM, JOIN, APPLY and USING text inside a delimited identifier names no table', 'SELECT x AS [x FROM dbo.X ok], y AS [x JOIN dbo.J ok], z AS [x CROSS APPLY dbo.W ok], v AS [x USING dbo.U ok] FROM dbo.Real', { s: ['dbo.Real'] }],
    ['EXEC, INTO and UPDATE text inside a delimited identifier names no call or write', 'SELECT x AS [x EXEC dbo.p x], y AS [x INTO dbo.Y x], z AS [x UPDATE dbo.Z x], w AS [x MERGE dbo.M x] FROM dbo.Real', { s: ['dbo.Real'] }],
    ['a function call inside a delimited or double-quoted identifier is no call', 'SELECT a AS [Details: dbo.fnInLabel(i)], b AS "Call dbo.fnQ(1)", c AS [dbo.fnR(1)], d AS "x FROM dbo.Q ok" FROM dbo.Real', { s: ['dbo.Real'] }],
    ['a delimited procedure name that reads like SQL is no reference', 'CREATE PROCEDURE T.[test returns SqlVersion from tSQLt.Info after install] AS SELECT 1 FROM dbo.R', { s: ['dbo.R'] }],
    ['delimited object names that contain keywords, spaces and dots stay whole', 'SELECT * FROM [dbo].[From Orders] o JOIN [my schema].[t] ON 1=1 JOIN [dbo].[exec dbo.p x] ON 1=1; INSERT INTO [dbo].[Into Archive] SELECT 1; UPDATE [dbo].[update x.y] SET a=1; EXEC [dbo].[usp exec (x)]; SELECT [dbo].[fn (x)](1)', { s: ['dbo.From Orders', 'my schema.t', 'dbo.exec dbo.p x', 'dbo.fn (x)'], t: ['dbo.Into Archive', 'dbo.update x.y'], x: ['dbo.usp exec (x)'] }],
  ],
  'comments, strings and batches': [
    ['keyword text in N\'\' and \'\'-escaped strings', "SELECT N'FROM dbo.Fake JOIN dbo.Fake2', 'it''s FROM dbo.Fake3' FROM dbo.A", { s: ['dbo.A'] }],
    ['nested block comments', 'SELECT * /* outer /* inner FROM dbo.Fake */ still FROM dbo.Fake2 */ FROM dbo.A', { s: ['dbo.A'] }],
    ['-- inside a string, quote inside a comment', "SELECT '--not a comment' c FROM dbo.A -- FROM dbo.Fake\n/* it's */ JOIN dbo.B ON 1=1 -- don't\nJOIN dbo.C ON 1=1", { s: ['dbo.A', 'dbo.B', 'dbo.C'] }],
    ['comment openers inside strings and brackets', "SELECT '/*' FROM [dbo].[x--y] JOIN [dbo].[p/*q] ON 1=1; SELECT '*/' FROM dbo.B", { s: ['dbo.x--y', 'dbo.p/*q', 'dbo.B'] }],
    ['unterminated block comment hides the rest', 'SELECT * FROM dbo.A /* FROM dbo.Fake', { s: ['dbo.A'] }],
    ['GO separators', 'SELECT * FROM dbo.A\nGO\nINSERT INTO dbo.T SELECT 1\nGO 5', { s: ['dbo.A'], t: ['dbo.T'] }],
    ['CREATE OR ALTER header with control flow and transactions', 'CREATE OR ALTER PROCEDURE dbo.p AS BEGIN IF EXISTS (SELECT 1 FROM dbo.A) BEGIN TRY BEGIN TRAN; INSERT INTO dbo.T SELECT 1; COMMIT END TRY BEGIN CATCH ROLLBACK; EXEC dbo.uspLog END CATCH WHILE 1=1 BEGIN SET @x = (SELECT COUNT(*) FROM dbo.B); BREAK END END', { s: ['dbo.A', 'dbo.B'], t: ['dbo.T'], x: ['dbo.uspLog'] }],
  ],
  'Synapse, Fabric and bulk loading': [
    ['CTAS with a distribution clause', 'CREATE TABLE dbo.T WITH (DISTRIBUTION = HASH(id), CLUSTERED COLUMNSTORE INDEX) AS SELECT * FROM dbo.S', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['Fabric CTAS', 'CREATE TABLE dbo.T AS SELECT * FROM dbo.S', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['CTAS whose SELECT starts with a CTE', 'CREATE TABLE dbo.T WITH (DISTRIBUTION = ROUND_ROBIN) AS WITH c AS (SELECT * FROM dbo.S) SELECT * FROM c', { s: ['dbo.S'], t: ['dbo.T'] }],
    ['CETAS', "CREATE EXTERNAL TABLE ext.T WITH (LOCATION='/x', DATA_SOURCE=ds, FILE_FORMAT=ff) AS SELECT * FROM dbo.S", { s: ['dbo.S'], t: ['ext.T'] }],
    ['CETAS whose SELECT starts with a CTE', "CREATE EXTERNAL TABLE ext.T WITH (LOCATION='/x', DATA_SOURCE=ds, FILE_FORMAT=ff) AS WITH c AS (SELECT * FROM dbo.S) SELECT * FROM c", { s: ['dbo.S'], t: ['ext.T'] }],
    ['CETAS whose AS and WITH are on separate lines', "CREATE EXTERNAL TABLE ext.T WITH (LOCATION='/x', DATA_SOURCE=ds, FILE_FORMAT=ff) AS\nWITH c AS (SELECT * FROM dbo.S) SELECT * FROM c", { s: ['dbo.S'], t: ['ext.T'] }],
    ['a plain CREATE TABLE before a CTE statement is not CTAS', 'CREATE TABLE dbo.T (a int, b AS (a*2));\nWITH c AS (SELECT * FROM dbo.S) INSERT INTO dbo.U SELECT * FROM c', { s: ['dbo.S'], t: ['dbo.U'] }],
    ['CTAS and CETAS after an unterminated CREATE TABLE', "CREATE TABLE #stage (a int)\nCREATE TABLE dbo.T WITH (DISTRIBUTION = ROUND_ROBIN) AS SELECT * FROM dbo.S\nCREATE EXTERNAL TABLE ext.A (a int) WITH (LOCATION='/a', DATA_SOURCE=ds, FILE_FORMAT=ff)\nCREATE EXTERNAL TABLE ext.T WITH (LOCATION='/x', DATA_SOURCE=ds, FILE_FORMAT=ff) AS SELECT * FROM dbo.S", { s: ['dbo.S'], t: ['dbo.T', 'ext.T'] }],
    ['a CREATE TABLE with options before a view definition is not CTAS', "CREATE TABLE dbo.T (a int) WITH (DATA_COMPRESSION = PAGE)\nCREATE VIEW dbo.v AS WITH c AS (SELECT * FROM dbo.S) SELECT * FROM c\nCREATE EXTERNAL TABLE ext.A (a int) WITH (LOCATION='/a', DATA_SOURCE=ds, FILE_FORMAT=ff)\nCREATE VIEW dbo.w AS SELECT * FROM dbo.U", { s: ['dbo.S', 'dbo.U'] }],
    ['CTAS with a column list, nested options and options of any length', `CREATE TABLE dbo.T (a, b) WITH (DISTRIBUTION = HASH(a), PARTITION (b RANGE RIGHT FOR VALUES (${'1, '.repeat(300)}2)))\nAS\nSELECT a, b FROM dbo.S`, { s: ['dbo.S'], t: ['dbo.T'] }],
    ['COPY INTO and BULK INSERT', "COPY INTO dbo.T FROM 'https://acct/x/*.csv' WITH (FILE_TYPE='CSV'); BULK INSERT dbo.U FROM 'c:\\x.csv'", { t: ['dbo.T', 'dbo.U'] }],
    ['index and statistics DDL names its table without reading it', 'CREATE INDEX ix ON dbo.A (c); CREATE UNIQUE NONCLUSTERED INDEX [ix b] ON [dbo].[B]([c]) INCLUDE (d) WHERE d > 0; CREATE CLUSTERED COLUMNSTORE INDEX cci ON dbo.C; CREATE STATISTICS st ON dbo.D (c) WITH FULLSCAN; UPDATE STATISTICS dbo.E (ix); CREATE FULLTEXT INDEX ON dbo.F (c) KEY INDEX pk; CREATE PRIMARY XML INDEX px ON dbo.G(x)', {}],
    ['index and statistics DDL glued to its delimited names names its table without reading it', 'CREATE INDEX[ix]ON[dbo].[t]([a]); CREATE STATISTICS[st]ON[dbo].[u]([a]); CREATE INDEX [iy]ON [dbo].[v]([a])', {}],
    ['table, view and procedure DDL names its object and a referenced table without calling them', "CREATE EXTERNAL TABLE ext.T (a int) WITH (LOCATION='/x', DATA_SOURCE=ds, FILE_FORMAT=ff); ALTER TABLE dbo.A ADD CONSTRAINT fk FOREIGN KEY (b) REFERENCES dbo.B (id); CREATE TABLE #t (id int REFERENCES dbo.C(id)); CREATE VIEW dbo.v (a, b) AS SELECT a, b FROM dbo.S; CREATE PROC dbo.p (@a int) AS SELECT 1", { s: ['dbo.S'] }],
    ['function calls inside table and view DDL are still read', 'CREATE TABLE dbo.T (a int DEFAULT dbo.fnD(), b AS dbo.fnC(a), CONSTRAINT ck CHECK (dbo.fnK(a) = 1)); CREATE VIEW dbo.v (a) AS SELECT dbo.fnA(x) FROM dbo.S', { s: ['dbo.fnD', 'dbo.fnC', 'dbo.fnK', 'dbo.fnA', 'dbo.S'] }],
    ['columnstore, spatial, XML, three-part and multi-line index DDL', 'CREATE NONCLUSTERED COLUMNSTORE INDEX ix ON dbo.A (c); CREATE SPATIAL INDEX sx ON dbo.B(g) USING GEOGRAPHY_GRID; CREATE XML INDEX sx ON dbo.C(x) USING XML INDEX px FOR PATH; CREATE INDEX ix ON OtherDb.dbo.D (c); CREATE INDEX ix\n  ON\n  dbo.E\n  (c)', {}],
    ['UPDATE STATISTICS WITH FULLSCAN, ALTER INDEX and DROP INDEX', 'UPDATE STATISTICS dbo.A(ix) WITH FULLSCAN; UPDATE STATISTICS dbo.B; ALTER INDEX ix ON dbo.C REBUILD WITH (ONLINE = ON); ALTER INDEX ALL ON dbo.D REORGANIZE; DROP INDEX ix ON dbo.E', {}],
    ['an index hint, SET STATISTICS, a table named Statistics and a filtered-statistics predicate keep their function calls', 'SELECT * FROM dbo.A a JOIN dbo.B b WITH (INDEX(ix)) ON dbo.fnA(a.x) = b.x; SET STATISTICS IO ON\nSELECT dbo.fnB(1); SELECT * FROM dbo.C c JOIN dbo.[Statistics] s ON dbo.fnC(c.x) = s.x; CREATE STATISTICS st ON dbo.D(c) WHERE c > dbo.fnD(1)', { s: ['dbo.A', 'dbo.B', 'dbo.fnA', 'dbo.fnB', 'dbo.C', 'dbo.Statistics', 'dbo.fnC', 'dbo.fnD'] }],
    ['function calls next to index DDL are still read', 'CREATE INDEX ix ON #t (c); SELECT dbo.fnA(1) FROM dbo.S s JOIN dbo.U u ON dbo.fnB(s.x, u.x) = 1', { s: ['dbo.fnA', 'dbo.fnB', 'dbo.S', 'dbo.U'] }],
    ['RENAME OBJECT and ALTER TABLE SWITCH are DDL', 'RENAME OBJECT dbo.T_new TO T; ALTER TABLE dbo.Stage SWITCH PARTITION 1 TO dbo.Fact PARTITION 1', {}],
  ],
  'review-reported forms': [
    ['UPDATE and FROM glued to delimited names keep the alias target', 'UPDATE[t]SET c = 1 FROM[dbo].[tt][t]', { s: ['dbo.tt'], t: ['dbo.tt'] }],
    ['a FOR XML PATH subquery member keeps the rest of a comma list', "SELECT * FROM dbo.A a, (SELECT x FROM dbo.B FOR XML PATH('')) s(x), dbo.C c", { s: ['dbo.A', 'dbo.B', 'dbo.C'] }],
    ['a FOR JSON PATH subquery member keeps the rest of a comma list', 'SELECT * FROM dbo.A a, (SELECT x FROM dbo.B FOR JSON PATH) s(x), dbo.C c', { s: ['dbo.A', 'dbo.B', 'dbo.C'] }],
  ],
};

describe.each(Object.entries(MATRIX))('%s', (_group, rows) => {
  it.each(rows)('%s', (_name, sql, want) => expectParsed(sql, want));
});

describe('case-sensitive catalogs keep identifier case for the fixed constructs', () => {
  it.each([
    ['UPDATE TOP (5) Sales.Target SET x=1', ['[Sales].[Target]']],
    ['UPDATE TOP (5) t SET x=1 FROM Sales.Target t', ['[Sales].[Target]']],
    ['UPDATE t SET x=(SELECT 1 FROM Sales.Other) FROM Sales.Target t', ['[Sales].[Target]']],
    ['WITH c AS (SELECT * FROM Sales.Target) UPDATE c SET x=1', ['[Sales].[Target]']],
    ['CREATE TABLE Sales.Target WITH (DISTRIBUTION = ROUND_ROBIN) AS WITH c AS (SELECT 1 x) SELECT * FROM c', ['[Sales].[Target]']],
  ])('%s', (sql, targets) => {
    expect(parseSqlBody(sql, undefined, true).targets).toEqual(targets);
  });
});

describe('the ANSI-89 comma-list scan is linear in the size of the body', () => {
  const SIZES_KB = [25, 50, 100, 200];
  const MAX_RATIO_PER_DOUBLING = 3;
  const MAX_SECONDS = 20;
  const RUNS = 3;

  /** Fastest of a few runs, in seconds, so a scheduling pause does not decide the ratio. */
  const seconds = (sql: string): number => Math.min(...Array.from({ length: RUNS }, () => {
    const start = performance.now();
    parseSqlBody(sql);
    return (performance.now() - start) / 1000;
  }));

  const body = (unit: string, kb: number) => unit.repeat(Math.ceil(kb * 1024 / unit.length));
  const inputs: Array<[string, (kb: number) => string]> = [
    ['repeated FETCH NEXT FROM c', kb => body('FETCH NEXT FROM c INTO @x\n', kb)],
    ['repeated unbalanced [', kb => body('[ x ', kb)],
    ['repeated unbalanced [', kb => body('[ x ', kb)],
    ['one long comma list', kb => 'SELECT * FROM dbo.A a' + body(', dbo.B b WITH (NOLOCK), dbo.fn(1, 2) f, (SELECT 1 x) d', kb)],
  ];

  it.each(inputs)('%s', (_name, build) => {
    const times = SIZES_KB.map(kb => seconds(build(kb)));
    expect(Math.max(...times)).toBeLessThan(MAX_SECONDS);
    times.slice(1).forEach((time, i) => {
      // a floor keeps a sub-millisecond baseline from turning timer noise into a ratio
      expect(time / Math.max(times[i], 0.01)).toBeLessThan(MAX_RATIO_PER_DOUBLING);
    });
  });
});
