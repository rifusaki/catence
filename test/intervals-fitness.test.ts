import { describe, expect, it } from 'vitest';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { temporaryDatabase } from './helpers.js';
import { getDataset } from '../src/core/query/catalog.js';

describe('Intervals fitness catalog exposure', () => {
  it('normalizes fitness_summary entities into provider-tagged daily PMC metrics', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('intervals', '2026-02-01');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType: 'fitness_summary', remoteId: '2026-02-01',
        parentRemoteId: null, occurredOn: '2026-02-01', sourceUpdatedAt: null, rawObjectHash: 'fitness-raw', extension: {},
        payload: { id: '2026-02-01', icu_ctl: 45.2, icu_atl: 38.1, icu_tsb: 7.1, icu_training_load: 120 },
      });
      const rows = await database.rows<{ ctl: number; atl: number; tsb: number; fitness_load: number; provider: string }>(
        'SELECT ctl, atl, tsb, fitness_load, provider FROM fitness_trend WHERE metric_date = DATE \'2026-02-01\'',
      );
      expect(rows).toEqual([{ ctl: 45.2, atl: 38.1, tsb: 7.1, fitness_load: 120, provider: 'intervals' }]);
    } finally {
      await database.close();
    }
  });

  it('is idempotent when the same fitness day syncs again', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('intervals', '2026-02-01');
    try {
      const record = {
        kind: 'source_entity' as const, schemaVersion: 1 as const, provider: 'intervals' as const,
        entityType: 'fitness_summary', remoteId: '2026-02-01', parentRemoteId: null, occurredOn: '2026-02-01',
        sourceUpdatedAt: null, rawObjectHash: 'fitness-raw', extension: {}, payload: { id: '2026-02-01', icu_ctl: 45.2, icu_atl: 38.1 },
      };
      await importRecord(database, runId, record);
      await importRecord(database, runId, { ...record, rawObjectHash: 'fitness-raw-2', payload: { id: '2026-02-01', icu_ctl: 46.0, icu_atl: 39.0 } });
      const rows = await database.rows<{ ctl: number }>("SELECT ctl FROM fitness_trend WHERE metric_date = DATE '2026-02-01'");
      expect(rows).toEqual([{ ctl: 46.0 }]);
    } finally {
      await database.close();
    }
  });

  it('catalogs the fitness_trend dataset with explicit Intervals-derived provenance', () => {
    const dataset = getDataset('fitness_trend');
    expect(dataset.relation).toBe('fitness_trend');
    expect(dataset.provenanceColumns).toContain('provider');
    expect(dataset.columns.map((column) => column.name)).toEqual(['provider', 'metric_date', 'ctl', 'atl', 'tsb', 'ramp_rate', 'fitness_load']);
    for (const name of ['ctl', 'atl', 'tsb', 'ramp_rate', 'fitness_load']) {
      const metricColumn = dataset.columns.find((column) => column.name === name);
      expect(metricColumn?.metric).toBe(true);
      expect(metricColumn?.unit).toBeTruthy();
    }
    expect(dataset.description).toContain('Intervals.icu');
    expect(dataset.description).toContain('never recomputed');
  });
});
