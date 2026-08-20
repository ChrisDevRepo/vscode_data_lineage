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
