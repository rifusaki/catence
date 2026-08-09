import { describe, expect, it } from 'vitest';
import { migrations } from '../../src/elt/storage/migrations.js';
import { temporaryDatabase } from '../helpers.js';

describe('swim facts migration backfill', () => {
  it('backfills archived Garmin summaries and Intervals auto blocks for an existing activity', async () => {
    const { database } = await temporaryDatabase();
    try {
      await database.run(`INSERT INTO activities VALUES ('garmin:swim-1', '2026-08-04T10:00:00Z', NULL, NULL, 'lap_swimming', 'Pool', 'strong_external_id')`);
      await database.run(`INSERT INTO activity_sources VALUES
        ('garmin:swim-1', 'garmin:swim-1', 'garmin', 'swim-1', NULL, 'garmin-summary'),
        ('intervals:i-swim-1', 'garmin:swim-1', 'intervals', 'i-swim-1', 'swim-1', 'intervals-summary')`);
      await database.run(`INSERT INTO activity_summaries
        (activity_source_id, distance_m, moving_s, elapsed_s, elevation_gain_m, calories, avg_hr, max_hr, avg_power, weighted_power, avg_cadence, training_load, rpe, feel, metrics_json)
        VALUES
        ('garmin:swim-1', 100, 120, 160, NULL, NULL, 145, 170, NULL, NULL, NULL, NULL, NULL, NULL, '{}'),
        ('intervals:i-swim-1', 100, NULL, NULL, NULL, NULL, 145, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"interval_summary":["2x 25m 155bpm"]}')`);
      await database.run(`INSERT INTO source_entities
        (provider, entity_type, remote_id, parent_remote_id, occurred_on, source_updated_at, raw_object_hash, payload_json, extension_json)
        VALUES
          ('garmin', 'activity_interval', 'swim-1', 'swim-1', '2026-08-04', NULL, 'garmin-splits',
            '{"splitSummaries":[{"splitType":"INTERVAL_ACTIVE","noOfSplits":2,"distance":100,"duration":120,"movingDuration":110,"averageHR":160,"maxHR":170}]}', '{}'),
          ('intervals', 'activity', 'i-swim-1', NULL, '2026-08-04', NULL, 'intervals-summary',
            '{"interval_summary":["2x 25m 155bpm"]}', '{}')`);
      // Simulate the pre-v13 wrapper row that used to have null swim fields.
      await database.run(`INSERT INTO activity_intervals
        (activity_source_id, interval_key, label, start_s, end_s, distance_m, avg_power, avg_hr, avg_pace, intensity, metrics_json)
        VALUES ('garmin:swim-1', 'swim-1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"splitSummaries":[]}')`);

      const migration = migrations.find((item) => item.version === 13);
      if (!migration) throw new Error('swim migration is missing');
      await database.run(migration.sql);

      expect(await database.rows(`
        SELECT source_type, label, distance_m, duration_s, moving_s, avg_hr
        FROM activity_interval_facts WHERE activity_source_id = 'garmin:swim-1'
        ORDER BY interval_key
      `)).toEqual([{ source_type: 'garmin_detected', label: 'INTERVAL_ACTIVE', distance_m: 100, duration_s: 120, moving_s: 110, avg_hr: 160 }]);
      expect(await database.rows(`
        SELECT source_type, reps, rep_distance_m, total_distance_m, avg_hr
        FROM swim_set_facts ORDER BY source_type
      `)).toEqual([
        { source_type: 'garmin_detected', reps: 2, rep_distance_m: null, total_distance_m: 100, avg_hr: 160 },
        { source_type: 'intervals_auto', reps: 2, rep_distance_m: 25, total_distance_m: 50, avg_hr: 155 },
      ]);
    } finally {
      await database.close();
    }
  });
});
