import { describe, expect, it } from 'vitest';
import { importRecord } from '../../../src/elt/ingestion/importer.js';
import { temporaryDatabase } from '../../helpers.js';

const rawHash = 'a'.repeat(64);
const base = { kind: 'source_entity' as const, schemaVersion: 1 as const, provider: 'strava' as const, parentRemoteId: null, occurredOn: '2026-02-01', sourceUpdatedAt: null, rawObjectHash: rawHash, extension: {} };

describe('Strava normalization', () => {
  it('preserves raw starred segment facts, leaves verification unavailable, and derives history speed only when valid', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('strava', '2026-02-01');
    try {
      await importRecord(database, runId, {
        ...base, entityType: 'activity', remoteId: 's-activity',
        payload: {
          id: 's-activity', start_date: '2026-02-01T10:00:00Z', start_date_local: '2026-02-01T05:00:00', type: 'Ride', name: 'Segment ride', distance: 40_000, moving_time: 7_000, gear_id: 'b-1',
          segment_efforts: [{ id: 'e-1', elapsed_time: 300, moving_time: 290, distance: 5_000, average_watts: 270, average_heartrate: 160, average_cadence: 88, pr_rank: 2, segment: { id: 'segment-1', name: 'Climb', distance: 5_000, average_grade: 6.2, maximum_grade: 11.5, climb_category: 2, starred: true, hazardous: false, private: false } }],
        },
      });
      await importRecord(database, runId, { ...base, entityType: 'gear', remoteId: 'b-1', payload: { id: 'b-1', name: 'Road bike' } });
      await importRecord(database, runId, { ...base, entityType: 'segment_effort', remoteId: 'history-1', parentRemoteId: 'segment-1', payload: { id: 'history-1', segment: { id: 'segment-1' }, activity: { id: 's-activity' }, elapsed_time: 250, distance: 5_000, average_watts: 280, start_date: '2026-01-02T10:00:00Z' } });
      await importRecord(database, runId, { ...base, entityType: 'segment_effort', remoteId: 'history-2', parentRemoteId: 'segment-1', payload: { id: 'history-2', segment: { id: 'segment-1' }, activity: { id: 's-activity' }, elapsed_time: 0, distance: 5_000, start_date: '2026-01-01T10:00:00Z' } });
      const segment = await database.rows<{ starred: boolean; payload_json: string }>(`SELECT starred, payload_json FROM strava_segments WHERE segment_id = 'segment-1'`);
      const activityEfforts = await database.rows<{ average_watts: number; pr_rank: number }>(`SELECT average_watts, pr_rank FROM activity_segments WHERE activity_source_id = 'strava:s-activity'`);
      const history = await database.rows<{ effort_id: string; average_speed_mps: number | null }>('SELECT effort_id, average_speed_mps FROM segment_effort_history ORDER BY effort_id');
      const gear = await database.rows<{ gear_id: string }>('SELECT gear_id FROM strava_gear');
      expect(segment[0]?.starred).toBe(true);
      expect(JSON.parse(segment[0]?.payload_json ?? '{}')).not.toHaveProperty('verified');
      expect(activityEfforts[0]).toEqual({ average_watts: 270, pr_rank: 2 });
      expect(history).toEqual([{ effort_id: 'history-1', average_speed_mps: 20 }, { effort_id: 'history-2', average_speed_mps: null }]);
      expect(gear).toEqual([{ gear_id: 'b-1' }]);
    } finally {
      await database.close();
    }
  });
});
