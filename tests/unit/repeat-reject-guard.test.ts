/**
 * Belt-and-suspenders idempotency counter: aborts a session when the AI sends
 * three consecutive identical tool calls that all fail.
 */

import { suite, test } from 'node:test';
import * as assert from 'assert';
import { RepeatRejectGuard } from '../../src/ai/repeatRejectGuard';

suite('RepeatRejectGuard', () => {
  test('success resets the counter', () => {
    const g = new RepeatRejectGuard();
    g.observe('t1', { a: 1 }, true);
    g.observe('t1', { a: 1 }, true);
    g.observe('t1', { a: 1 }, false);       // success
    const obs = g.observe('t1', { a: 1 }, true);
    assert.strictEqual(obs.count, 1, 'counter restarts after a successful call');
    assert.strictEqual(obs.abort, false);
  });

  test('different inputs do not accumulate', () => {
    const g = new RepeatRejectGuard();
    g.observe('t1', { a: 1 }, true);
    g.observe('t1', { a: 2 }, true);
    const obs = g.observe('t1', { a: 3 }, true);
    assert.strictEqual(obs.count, 1, 'each distinct input restarts the counter');
    assert.strictEqual(obs.abort, false);
  });

  test('three identical failures triggers abort', () => {
    const g = new RepeatRejectGuard();
    const o1 = g.observe('t1', { a: 1 }, true);
    const o2 = g.observe('t1', { a: 1 }, true);
    const o3 = g.observe('t1', { a: 1 }, true);
    assert.deepStrictEqual([o1.count, o2.count, o3.count], [1, 2, 3]);
    assert.deepStrictEqual([o1.abort, o2.abort, o3.abort], [false, false, true]);
  });

  test('key-order-independent hash (deep objects)', () => {
    const g = new RepeatRejectGuard();
    const a = g.observe('t1', { a: 1, b: { x: 1, y: 2 } }, true);
    const b = g.observe('t1', { b: { y: 2, x: 1 }, a: 1 }, true);
    assert.strictEqual(a.hash, b.hash, 'stable hash ignores property order');
    assert.strictEqual(b.count, 2);
  });

  test('different tool names with identical inputs do not collide', () => {
    const g = new RepeatRejectGuard();
    g.observe('toolA', { x: 1 }, true);
    const obs = g.observe('toolB', { x: 1 }, true);
    assert.strictEqual(obs.count, 1, 'tool name is part of the hash');
  });
});
