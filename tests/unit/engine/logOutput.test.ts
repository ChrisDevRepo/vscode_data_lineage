/**
 * Pins the output-channel log contract: backslash text such as a Windows path survives, and the
 * Logger removes credential-shaped text for every caller at every level, so no call site has to.
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger, safeStringifyForLog, sanitizeForLog } from '../../../src/utils/log';

function channel() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
}

const SECRET = 'hunter2-Zk93';

describe('single-line log text', () => {
  it('keeps backslash sequences that are not a newline', () => {
    expect(sanitizeForLog('C:\\new\\temp\\run.dacpac')).toBe('C:\\new\\temp\\run.dacpac');
    expect(sanitizeForLog('a\\tb\\rc')).toBe('a\\tb\\rc');
  });

  it('still turns a real newline, return or tab into one space', () => {
    expect(sanitizeForLog('a\nb\r\nc\td')).toBe('a b c d');
  });

  it('keeps a backslash path inside a serialized value and joins a real newline', () => {
    const line = safeStringifyForLog({ path: 'C:\\new\\temp', text: 'one\ntwo' });
    expect(line).toBe('{"path":"C:\\\\new\\\\temp","text":"one two"}');
    expect(JSON.parse(line)).toEqual({ path: 'C:\\new\\temp', text: 'one two' });
  });
});

describe('Logger redaction', () => {
  it.each(['info', 'debug', 'warn'] as const)('removes a credential from a %s line', (level) => {
    const ch = channel();
    Logger.create(ch as never, 'DB')[level](`Connect failed: Server=x;Password=${SECRET};Database=y`);
    const line = String(ch[level].mock.calls[0][0]);
    expect(line).toContain('Server=x');
    expect(line).not.toContain(SECRET);
  });

  it('removes a credential from the error line and the stack line', () => {
    const ch = channel();
    const err = new Error(`login: Password=${SECRET}`);
    err.stack = `Error: login: Password=${SECRET}\n    at connect (db.js:1:1)`;
    Logger.create(ch as never, 'DB').error(`Open Pwd=${SECRET}`, err);
    const lines = ch.error.mock.calls.map(([l]) => String(l));
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines[1]).toContain('at connect (db.js:1:1)');
  });

  it('removes a credential from a thrown non-Error value', () => {
    const ch = channel();
    Logger.create(ch as never, 'DB').error('Open', `Password=${SECRET}`);
    expect(String(ch.error.mock.calls[0][0])).not.toContain(SECRET);
  });
});
