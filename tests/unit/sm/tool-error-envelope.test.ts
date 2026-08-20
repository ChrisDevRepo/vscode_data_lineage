import { assert, assertEq } from '../helpers/testUtils';
import { readToolError, isConsentGateRejection } from '../../../src/ai/support/toolErrorEnvelope';
import { describe, it } from 'vitest';

describe("tool-error-envelope", () => {
  it("readToolError: engine-rejection shape", () => {
    const r = readToolError({ error: 'focus_mismatch', hint: 'use the expected id' });
    assert(r !== null, 'engine rejection → non-null');
    assertEq(r!.code, 'focus_mismatch', 'code = error code');
    assertEq(r!.reason, 'focus_mismatch', 'reason falls back to the error code');
    assertEq(r!.hint, 'use the expected id', 'hint passed through');
  });

  it("readToolError: reason resolution order (errors[0] wins over message/detail)", () => {
    const r = readToolError({ error: 'validation_failed', errors: ['first line', 'second'], message: 'msg', detail: 'det' });
    assertEq(r!.code, 'validation_failed', 'code from error even when errors[] present');
    assertEq(r!.reason, 'first line', 'errors[0] takes precedence for reason');
  });

  it("message used when no errors[]", () => {
    const r = readToolError({ error: 'e', message: 'the message' });
    assertEq(r!.reason, 'the message', 'message used when no errors[]');
  });

  it("detail used when no errors[]/message", () => {
    const r = readToolError({ error: 'e', detail: 'the detail' });
    assertEq(r!.reason, 'the detail', 'detail used when no errors[]/message');
  });

  it("structured detail is preserved for bounded retry projection", () => {
    const detail = [{ id: 'vwraworders', path: 'column_flow.0.upstream_columns.0', reason: 'self loop' }];
    const r = readToolError({ error: 'column_self_loop', hint: 'Correct writes_to.', detail });
    assertEq(r!.detail, detail, 'structured detail is preserved for bounded retry projection');
  });

  it("readToolError: validation-failure shape (no error key) → code 'validation'", () => {
    const r = readToolError({ success: false, errors: ['No state-machine result available'], hint: 'run present_result' });
    assert(r !== null, 'success:false envelope → non-null');
    assertEq(r!.code, 'validation', "no error key → code 'validation'");
    assertEq(r!.reason, 'No state-machine result available', 'reason = first error line');
    assertEq(r!.hint, 'run present_result', 'hint passed through');
  });

  it("bare success:false is still a failure envelope", () => {
    const r = readToolError({ success: false });
    assert(r !== null, 'bare success:false is still a failure envelope');
    assertEq(r!.reason, 'tool returned failure envelope', 'default reason when nothing else resolves');
  });

  it("success payload → null", () => { assert(readToolError({ ok: true, nodes: [] }) === null, 'success payload → null'); });

  it("empty object → null", () => { assert(readToolError({}) === null, 'empty object → null'); });

  it("null → null", () => { assert(readToolError(null) === null, 'null → null'); });

  it("non-object → null", () => { assert(readToolError('a string') === null, 'non-object → null'); });

  // The gate reuses the rejection envelope but is never charged, so any surface that counts
  // rejections must be able to separate the two from the code alone.
  it("the consent gate is separable from a real rejection", () => {
    const gate = readToolError({ error: 'action_required', hint: 'awaiting user confirmation' });
    assert(gate !== null, 'gate envelope parses as a rejection shape');
    assert(isConsentGateRejection(gate!.code), 'action_required is the consent gate');
    const failure = readToolError({ success: false, errors: ['bad node id'] });
    assert(!isConsentGateRejection(failure!.code), 'a validation failure is not a gate');
  });

});
