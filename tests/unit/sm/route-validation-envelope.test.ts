import { buildRouteValidationRejection } from '../../../src/ai/sm/smRouteValidation';
import type { InvalidRoute } from '../../../src/ai/sm/smTypes';
import { describe, expect, it } from 'vitest';

describe('buildRouteValidationRejection — envelope shape', () => {
  const required = ['[s].[a]', '[s].[b]', '[s].[c]'];
  function missingRoute(id: string, invalidlyPruned = false): InvalidRoute {
    return {
      kind: 'missing_required_route',
      id,
      invalidlyPruned,
      reason: `Required neighbor was not accounted for from focus [s].[f]: ${id}`,
      available_routes: required,
    };
  }

  it('states available_routes once — on the first missing_required_route entry only', () => {
    const rejection = buildRouteValidationRejection(required.map(id => missingRoute(id)));
    if (!('error' in rejection)) throw new Error('expected a rejection');
    const detail = rejection.detail as Array<Record<string, unknown>>;
    expect(detail).toHaveLength(3);
    expect(detail[0].available_routes).toEqual(required);
    expect(detail[1]).not.toHaveProperty('available_routes');
    expect(detail[2]).not.toHaveProperty('available_routes');
  });

  it('keeps error, hint, id, and reason unchanged by the dedupe', () => {
    const rejection = buildRouteValidationRejection(required.map(id => missingRoute(id)));
    if (!('error' in rejection)) throw new Error('expected a rejection');
    expect(rejection.error).toBe('missing_required_route');
    expect(rejection.hint).toContain('[s].[a], [s].[b], [s].[c]');
    expect(rejection.hint).toContain('route_requests');
    const detail = rejection.detail as Array<Record<string, unknown>>;
    expect(detail.map(e => e.id)).toEqual(required);
    for (const entry of detail) expect(typeof entry.reason).toBe('string');
  });

  it('leaves available_routes untouched on non-missing_required_route kinds', () => {
    const other: InvalidRoute = {
      kind: 'prune_origin_forbidden',
      id: '[s].[origin]',
      reason: 'Origin cannot be pruned: [s].[origin]',
      available_routes: required,
    };
    const rejection = buildRouteValidationRejection([other, missingRoute('[s].[a]'), missingRoute('[s].[b]')]);
    if (!('error' in rejection)) throw new Error('expected a rejection');
    const detail = rejection.detail as Array<Record<string, unknown>>;
    expect(detail[0].available_routes).toEqual(required);
    expect(detail[1].available_routes).toEqual(required);
    expect(detail[2]).not.toHaveProperty('available_routes');
  });
});

describe('buildRouteValidationRejection — the hold promise follows the engine hold', () => {
  const required = ['[s].[a]', '[s].[b]'];
  const missing: InvalidRoute = {
    kind: 'missing_required_route',
    id: '[s].[a]',
    reason: 'Required neighbor was not accounted for from focus [s].[f]: [s].[a]',
    available_routes: required,
  };
  const orphaning: InvalidRoute = {
    kind: 'prune_would_orphan',
    id: '[s].[k]',
    reason: 'Pruning would orphan a committed node: [s].[k]',
  };
  /** The engine holds the draft only for a pure set; the promise is the `sections: []` retry. */
  function promisesHeldRetry(hint: string): boolean {
    return /sections:\s*\[\]/.test(hint);
  }

  it('promises the held retry when neighbor incompleteness is the whole rejection', () => {
    const rejection = buildRouteValidationRejection([missing]);
    if (!('error' in rejection)) throw new Error('expected a rejection');
    expect(promisesHeldRetry(rejection.hint as string)).toBe(true);
    expect(rejection.hint).toContain('route_requests');
  });

  it('orders a full resubmission when a prune fault rides along', () => {
    const rejection = buildRouteValidationRejection([orphaning, missing]);
    if (!('error' in rejection)) throw new Error('expected a rejection');
    expect(promisesHeldRetry(rejection.hint as string)).toBe(false);
    expect(rejection.hint).toContain('route_requests');
    expect(rejection.hint).toContain('prune_neighbors');
  });
});
