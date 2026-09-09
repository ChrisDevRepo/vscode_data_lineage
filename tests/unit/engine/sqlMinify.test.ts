/**
 * Minifier tests for the hop-exploration DDL path: what is stripped must vanish whole, and what
 * carries lineage semantics must survive untouched.
 */
import { describe, expect, it } from 'vitest';
import { minifyDdlForHop } from '../../../src/utils/sql';

describe('minifyDdlForHop', () => {
  it('strips a flat physical WITH(...) block', () => {
    const minified = minifyDdlForHop(
      'CREATE CLUSTERED INDEX ix ON dbo.T (Id) WITH (PAD_INDEX = OFF, FILLFACTOR = 90)',
      false,
    );
    expect(minified).not.toContain('FILLFACTOR');
    expect(minified).toBe('CREATE  INDEX ix ON dbo.T (Id)');
  });

  it('strips a WITH(...) block with a nested parenthesized option without leaving a dangling paren', () => {
    const minified = minifyDdlForHop(
      'CREATE CLUSTERED INDEX ix ON dbo.T (Id) WITH (PAD_INDEX = OFF, DATA_COMPRESSION = PAGE ON PARTITIONS (1 TO 3))',
      false,
    );
    expect(minified).not.toContain('PAD_INDEX');
    expect(minified).not.toContain('PARTITIONS');
    expect(minified, 'balanced strip must not leave the outer closing paren behind')
      .toBe('CREATE  INDEX ix ON dbo.T (Id)');
  });

  it('keeps WITH blocks that carry semantics rather than storage options', () => {
    const raw = [
      'CREATE PROCEDURE dbo.P',
      'WITH (EXECUTE AS OWNER)',
      'AS',
      'WITH src (Id) AS (SELECT Id FROM dbo.T)',
      'SELECT Id FROM src',
    ].join('\n');
    const minified = minifyDdlForHop(raw, false);
    expect(minified).toContain('EXECUTE AS OWNER');
    expect(minified).toContain('WITH src (Id) AS (SELECT Id FROM dbo.T)');
  });

  it('leaves an unbalanced WITH( fragment untouched instead of swallowing the rest of the script', () => {
    const raw = 'ALTER TABLE dbo.T REBUILD WITH (PAD_INDEX = OFF\nSELECT * FROM dbo.Next';
    expect(minifyDdlForHop(raw, false)).toContain('SELECT * FROM dbo.Next');
  });

  it('strips an unbracketed USE line without swallowing the DDL that follows it', () => {
    const raw = ['USE Sales', 'GO', 'CREATE TABLE Orders', '(', '  Id INT', ')'].join('\n');
    const minified = minifyDdlForHop(raw, false);
    expect(minified).not.toContain('USE Sales');
    expect(minified, 'the object header must survive the boilerplate strip')
      .toBe('CREATE TABLE Orders\n(\n  Id INT\n)');
  });

  it('strips a bracketed USE line containing spaces', () => {
    const raw = ['USE [My Sales DB];', 'CREATE VIEW dbo.V AS SELECT 1 AS Id'].join('\n');
    expect(minifyDdlForHop(raw, false)).toBe('CREATE VIEW dbo.V AS SELECT 1 AS Id');
  });

  it('retains physical tokens when tech context is preserved', () => {
    const raw = 'CREATE CLUSTERED INDEX ix ON dbo.T (Id) WITH (PAD_INDEX = OFF)';
    const minified = minifyDdlForHop(raw, true);
    expect(minified).toContain('CLUSTERED');
    expect(minified).toContain('PAD_INDEX');
  });

  // T8-DISCOUNT-NULL-VS-ZERO: the model reads a non-executing CATCH-block comment as if it
  // described behaviour. The Step-3 UPDATE fails and the column stays NULL — the comment
  // ("continue with Discount = 0") is dead text, never reached, and must arrive marked as such
  // rather than indistinguishable from the executing lines around it.
  it('marks a CATCH-block comment as dead text, leaving the executing line beside it unmarked', () => {
    const raw = [
      '    BEGIN TRY',
      '        UPDATE sb',
      '        SET sb.Discount = COALESCE(dc.Discount, 0)',
      '        FROM #SalesBase sb',
      '        LEFT JOIN ai.vwDiscountCalc dc',
      '            ON sb.StagingID = dc.StagingID;',
      '    END TRY',
      '    BEGIN CATCH',
      "        INSERT INTO ai.ErrorLog (ProcedureName, ErrorNumber, ErrorMessage, ErrorLine)",
      "        VALUES ('spBuildSalesReport.Step3', ERROR_NUMBER(), ERROR_MESSAGE(), ERROR_LINE());",
      '        -- Non-fatal: continue with Discount = 0',
      '        SET @WarningCount = @WarningCount + 1;',
      '    END CATCH;',
    ].join('\n');

    const minified = minifyDdlForHop(raw, false);
    const lines = minified.split('\n');
    const commentLine = lines.find(l => l.includes('Non-fatal'));
    const executingLine = lines.find(l => l.includes('WarningCount'));

    expect(commentLine, 'the dead comment line must survive minification').toBeDefined();
    expect(executingLine, 'the adjacent executing line must survive minification').toBeDefined();
    // The dead-line prefix lands at column 0, ahead of the line's own indentation and its own
    // (already-live) '--'; the executing line beside it carries no such prefix.
    expect(commentLine!.startsWith('--')).toBe(true);
    expect(executingLine!.startsWith('--')).toBe(false);
    // The fact itself is never lost — marking adds context, it does not delete or relocate text.
    expect(minified).toContain('Non-fatal: continue with Discount = 0');
  });
});
