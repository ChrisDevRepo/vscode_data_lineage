/**
 * Pins the pure parts of the add-connection wizard: server input parsing.
 */

import { describe, it, expect } from 'vitest';
import { parseServerInput } from '../../../../src/engine/db/connectionCommands';

describe('parseServerInput', () => {
  it('accepts a bare host', () => {
    expect(parseServerInput('localhost')).toEqual({ server: 'localhost' });
  });

  it('splits host,port', () => {
    expect(parseServerInput(' sql.example.com,1444 ')).toEqual({ server: 'sql.example.com', port: 1444 });
  });

  it('drops the tcp: prefix the Azure portal connection strings carry', () => {
    expect(parseServerInput('tcp:x.database.windows.net,1433')).toEqual({ server: 'x.database.windows.net', port: 1433 });
  });

  it('rejects an empty host, a non-numeric port and an out-of-range port', () => {
    expect(parseServerInput('')).toBeUndefined();
    expect(parseServerInput(',1433')).toBeUndefined();
    expect(parseServerInput('host,abc')).toBeUndefined();
    expect(parseServerInput('host,70000')).toBeUndefined();
  });
});
