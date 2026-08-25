import { describe, expect, it } from 'vitest';
import {
  EVENT_WINDOW_FUTURE_DAYS,
  EVENT_WINDOW_PAST_DAYS,
  intervalsEventSyncWindow,
  intervalsReadRegistry,
  intervalsSecondaryReadRegistry,
} from '../src/elt/ingestion/providers/registry.js';

describe('intervals planned-events sync', () => {
  it('builds a symmetric past/future window around today', () => {
    const window = intervalsEventSyncWindow(new Date('2026-08-25T12:00:00.000Z'));
    expect(window.fromDate).toBe('2025-08-25'); // 365 days back spans a non-leap year
    expect(window.toDate).toBe('2027-08-25');

    const lengthMs = Date.parse(window.toDate) - Date.parse(window.fromDate);
    const expectedMs = (EVENT_WINDOW_PAST_DAYS + EVENT_WINDOW_FUTURE_DAYS) * 86_400_000;
    expect(Math.abs(lengthMs - expectedMs)).toBeLessThanOrEqual(86_400_000);
  });

  it('keeps the window anchored to the passed instant, not wall-clock drift', () => {
    const jan = intervalsEventSyncWindow(new Date('2026-01-01T00:00:00.000Z'));
    expect(jan.fromDate).toBe('2025-01-01');
    expect(jan.toDate).toBe('2027-01-01');
  });

  it('syncs calendar events alongside athlete and activities, nothing else', () => {
    const names = intervalsSecondaryReadRegistry.map((endpoint) => endpoint.name).sort();
    expect(names).toEqual(['activities', 'athlete', 'events']);
    // The wide registry stays intact for manifest coverage.
    expect(intervalsReadRegistry.some((endpoint) => endpoint.name === 'wellness')).toBe(true);
  });
});
