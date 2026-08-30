import { readToolError, isConsentGateRejection } from '../../../src/ai/support/toolErrorEnvelope';
import { describe, expect, it } from 'vitest';

describe("tool-error-envelope", () => {
  it("readToolError: engine-rejection shape", () => {
    const r = readToolError({ error: 'focus_mismatch', hint: 'use the expected id' });
    expect(r !== null, 'engine rejection → non-null').toBe(true);
    expect(r!.code, 'code = error code').toBe('focus_mismatch');
    expect(r!.reason, 'reason falls back to the error code').toBe('focus_mismatch');
    expect(r!.hint, 'hint passed through').toBe('use the expected id');
  });

  it("readToolError: reason resolution order (errors[0] wins over message/detail)", () => {
    const r = readToolError({ error: 'validation_failed', errors: ['first line', 'second'], message: 'msg', detail: 'det' });
    expect(r!.code, 'code from error even when errors[] present').toBe('validation_failed');
    expect(r!.reason, 'errors[0] takes precedence for reason').toBe('first line');
  });

  it("message used when no errors[]", () => {
    const r = readToolError({ error: 'e', message: 'the message' });
    expect(r!.reason, 'message used when no errors[]').toBe('the message');
  });

  it("detail used when no errors[]/message", () => {
    const r = readToolError({ error: 'e', detail: 'the detail' });
    expect(r!.reason, 'detail used when no errors[]/message').toBe('the detail');
  });

  it("structured detail is preserved for bounded retry projection", () => {
    const detail = [{ id: 'vwraworders', path: 'column_flow.0.upstream_columns.0', reason: 'self loop' }];
    const r = readToolError({ error: 'column_self_loop', hint: 'Correct writes_to.', detail });
    expect(r!.detail, 'structured detail is preserved for bounded retry projection').toBe(detail);
  });

  it("readToolError: validation-failure shape (no error key) → code 'validation'", () => {
    const r = readToolError({ success: false, errors: ['No state-machine result available'], hint: 'run present_result' });
    expect(r !== null, 'success:false envelope → non-null').toBe(true);
    expect(r!.code, "no error key → code 'validation'").toBe('validation');
    expect(r!.reason, 'reason = first error line').toBe('No state-machine result available');
    expect(r!.hint, 'hint passed through').toBe('run present_result');
  });

  it("bare success:false is still a failure envelope", () => {
    const r = readToolError({ success: false });
    expect(r !== null, 'bare success:false is still a failure envelope').toBe(true);
    expect(r!.reason, 'default reason when nothing else resolves').toBe('tool returned failure envelope');
  });

  it("success payload → null", () => { expect(readToolError({ ok: true, nodes: [] }) === null, 'success payload → null').toBe(true); });

  it("empty object → null", () => { expect(readToolError({}) === null, 'empty object → null').toBe(true); });

  it("null → null", () => { expect(readToolError(null) === null, 'null → null').toBe(true); });

  it("non-object → null", () => { expect(readToolError('a string') === null, 'non-object → null').toBe(true); });

  // The gate reuses the rejection envelope but is never charged, so any surface that counts
  // rejections must be able to separate the two from the code alone.
  it("the consent gate is separable from a real rejection", () => {
    const gate = readToolError({ error: 'action_required', hint: 'awaiting user confirmation' });
    expect(gate !== null, 'gate envelope parses as a rejection shape').toBe(true);
    expect(isConsentGateRejection(gate!.code), 'action_required is the consent gate').toBe(true);
    const failure = readToolError({ success: false, errors: ['bad node id'] });
    expect(!isConsentGateRejection(failure!.code), 'a validation failure is not a gate').toBe(true);
  });

});
