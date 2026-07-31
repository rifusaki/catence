import { describe, expect, it } from 'vitest';
import { openReadOnlyRepository } from '../../src/elt/storage/database.js';
import { writeParquetSamples } from '../../src/elt/streams.js';
import { temporaryDatabase } from '../helpers.js';

describe('activity sample relation', () => {
  it('uses one internal parquet scan when more than 1,000 streams are registered', async () => {
    const { paths, database } = await temporaryDatabase();
    const stream = await writeParquetSamples(database, paths, 'intervals', 'ride-1', '2026-01-01', [{
      activity_source_id: 'intervals:ride-1', timestamp_utc: '2026-01-01T10:00:00Z', elapsed_s: 0, distance_m: 0,
      latitude: null, longitude: null, altitude_m: null, heart_rate_bpm: 140, power_w: 200, cadence_rpm: null,
      speed_mps: null, temperature_c: null, grade_pct: null, extras_json: '{}',
    }]);
    const values = Array.from({ length: 1_001 }, (_, index) => [
      'intervals', index === 0 ? 'intervals:ride-1' : `intervals:stream-${index}`, `${stream.contentHash}-${index}`, stream.relativePath, 1,
      '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z', JSON.stringify(stream.columns), null,
    ]);
    await database.run(`INSERT INTO stream_manifest VALUES ${values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, values.flat());
    await database.close();

    const repository = await openReadOnlyRepository(paths);
    try {
      const relation = await repository.activitySampleRelation();
      expect(relation).toContain('read_parquet');
      expect(relation).not.toContain('UNION ALL');
      const rows = await repository.rows<{ count: number }>(`SELECT count(*)::INTEGER AS count FROM (${relation})`);
      expect(rows[0]?.count).toBe(1);
    } finally {
      await repository.close();
    }
  });
});
