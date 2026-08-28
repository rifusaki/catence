import { describe, expect, it } from 'vitest';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { openReadOnlyRepository } from '../src/elt/storage/database.js';
import { getDataset } from '../src/core/query/catalog.js';
import { temporaryDatabase } from './helpers.js';

type Db = Awaited<ReturnType<typeof temporaryDatabase>>['database'];

async function seedActivity(db: Db, remoteId: string, startedAt: string, sport: string, payload: Record<string, unknown>): Promise<void> {
  const runId = await db.beginRun('intervals', startedAt.slice(0, 10));
  await importRecord(db, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType: 'activity', remoteId,
    parentRemoteId: null, occurredOn: startedAt.slice(0, 10), sourceUpdatedAt: null, rawObjectHash: null,
    payload: { id: remoteId, start_date: startedAt, type: sport, ...payload }, extension: {},
  });
}

describe('activity_decoupling persistence (A3)', () => {
  it('persists provider-supplied decoupling and GAP as authoritative facts', async () => {
    const setup = await temporaryDatabase();
    await seedActivity(setup.database, 'run-steady', '2026-01-08T10:00:00Z', 'Run', {
      name: 'Steady run', distance: 15_000, moving_time: 5_400,
      decoupling: 4.5, gap: 275,
    });
    await seedActivity(setup.database, 'ride-tempo', '2026-01-10T10:00:00Z', 'Ride', {
      name: 'Tempo ride', distance: 40_000, moving_time: 6_000,
      analysis: { aerobicDecoupling: 6.1, gradeAdjustedPace: 263 },
    });
    const repository = await openReadOnlyRepository(setup.paths);
    try {
      const rows = await repository.rows<{ activity_source_id: string; metric: string; value_number: number | null; unit: string; source_type: string; sport: string | null; started_at_utc: string | null }>(
        `SELECT activity_source_id, metric, value_number, unit, source_type, sport, cast(started_at_utc AT TIME ZONE 'UTC' AS VARCHAR) AS started_at_utc
         FROM activity_decoupling_facts ORDER BY activity_source_id, metric`,
      );
      expect(rows).toEqual([
        {
          activity_source_id: 'intervals:ride-tempo', metric: 'aerobic_decoupling_pct', value_number: 6.1, unit: 'pct', source_type: 'provider', sport: 'Ride', started_at_utc: '2026-01-10 10:00:00',
        },
        {
          activity_source_id: 'intervals:ride-tempo', metric: 'grade_adjusted_pace_s_per_km', value_number: 263, unit: 's_per_km', source_type: 'provider', sport: 'Ride', started_at_utc: '2026-01-10 10:00:00',
        },
        {
          activity_source_id: 'intervals:run-steady', metric: 'aerobic_decoupling_pct', value_number: 4.5, unit: 'pct', source_type: 'provider', sport: 'Run', started_at_utc: '2026-01-08 10:00:00',
        },
        {
          activity_source_id: 'intervals:run-steady', metric: 'grade_adjusted_pace_s_per_km', value_number: 275, unit: 's_per_km', source_type: 'provider', sport: 'Run', started_at_utc: '2026-01-08 10:00:00',
        },
      ]);
    } finally {
      await repository.close();
    }
  });

  it('registers activity_decoupling as a queryable catalog dataset', () => {
    const dataset = getDataset('activity_decoupling');
    expect(dataset.relation).toBe('activity_decoupling_facts');
    expect(dataset.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['provider', 'activity_source_id', 'metric', 'value_number', 'source_type']),
    );
  });
});