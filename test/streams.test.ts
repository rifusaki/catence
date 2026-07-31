import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { intervalsStreamsToSamples, writeParquetSamples } from '../src/elt/streams.js';
import { temporaryDatabase } from './helpers.js';

describe('Intervals stream normalization', () => {
  it('creates stable nullable rows and preserves uncommon streams in extras', () => {
    const rows = intervalsStreamsToSamples('intervals:i1', [
      { type: 'time', data: [0, 1] }, { type: 'watts', data: [200, 210] }, { type: 'heartrate', data: [140, 142] }, { type: 'pedal_smoothness', data: [20, 21] },
    ], '2025-07-30T10:00:00Z');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ activity_source_id: 'intervals:i1', elapsed_s: 0, power_w: 200, heart_rate_bpm: 140 });
    expect(JSON.parse(rows[1]!.extras_json)).toEqual({ pedal_smoothness: 21 });
  });

  it('writes a queryable Parquet artifact with the stable sample schema', async () => {
    const { paths, database } = await temporaryDatabase();
    try {
      const samples = intervalsStreamsToSamples('intervals:i1', [{ type: 'time', data: [0, 1] }, { type: 'watts', data: [200, 210] }], '2025-07-30T10:00:00Z');
      const artifact = await writeParquetSamples(database, paths, 'intervals', 'i1', '2025-07-30', samples);
      const bytes = await readFile(`${paths.root}/${artifact.relativePath}`);
      const rows = await database.rows<{ count: number; max_power: number }>(`SELECT count(*)::INTEGER AS count, max(power_w) AS max_power FROM read_parquet('${`${paths.root}/${artifact.relativePath}`.replaceAll("'", "''")}')`);
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(artifact.columns).toContain('extras_json');
      expect(rows[0]).toMatchObject({ count: 2 });
      expect(Number(rows[0]?.max_power)).toBe(210);
    } finally {
      await database.close();
    }
  });
});
