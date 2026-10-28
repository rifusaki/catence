import { describe, expect, it } from 'vitest';
import { allReadOnlyEndpoints, assertReadOnlyRegistry, intervalsActivityReadEndpoints, intervalsSecondaryReadRegistry, trainingpeaksReadRegistry } from '../src/elt/ingestion/providers/registry.js';

describe('read-only endpoint registry', () => {
  it('covers the TrainingPeaks companion registry read-only', () => {
    expect(trainingpeaksReadRegistry.map((endpoint) => [endpoint.name, endpoint.scope, endpoint.entityType])).toEqual([
      ['planned_workouts', 'date_range', 'planned_workout'],
      ['zones', 'collection', 'zone_setting'],
      ['athlete_settings', 'singleton', 'profile'],
    ]);
  });

  it('contains only explicit read-only entries across both providers', () => {
    expect(() => assertReadOnlyRegistry()).not.toThrow();
    expect(allReadOnlyEndpoints.length).toBeGreaterThan(60);
    expect(intervalsActivityReadEndpoints).toContain('original_file');
    expect(intervalsActivityReadEndpoints).toContain('streams');
    expect(intervalsSecondaryReadRegistry.map((endpoint) => endpoint.name)).toEqual(['athlete', 'activities', 'events', 'fitness']);
  });
});
