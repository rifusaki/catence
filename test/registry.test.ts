import { describe, expect, it } from 'vitest';
import { allReadOnlyEndpoints, assertReadOnlyRegistry, intervalsActivityReadEndpoints } from '../src/elt/ingestion/providers/registry.js';

describe('read-only endpoint registry', () => {
  it('contains only explicit read-only entries across both providers', () => {
    expect(() => assertReadOnlyRegistry()).not.toThrow();
    expect(allReadOnlyEndpoints.length).toBeGreaterThan(60);
    expect(intervalsActivityReadEndpoints).toContain('original_file');
    expect(intervalsActivityReadEndpoints).toContain('streams');
  });
});
