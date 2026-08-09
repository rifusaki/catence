import { describe, expect, it } from 'vitest';
import { importRecord } from '../../../src/elt/ingestion/importer.js';
import { setManualActivityLink, unlinkActivitySource } from '../../../src/elt/normalization/activities/linking.js';
import { temporaryDatabase } from '../../helpers.js';

const envelope = { kind: 'source_entity' as const, schemaVersion: 1 as const, entityType: 'activity', parentRemoteId: null, occurredOn: '2026-02-01', sourceUpdatedAt: null, rawObjectHash: null, extension: {} };

describe('activity linking', () => {
  it('uses an Intervals Garmin-origin external ID as a strong link to the Garmin source', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('intervals', '2026-02-01');
    try {
      await importRecord(database, runId, { ...envelope, provider: 'intervals', remoteId: 'i1', payload: { id: 'i1', external_id: 'g1', start_date: '2026-02-01T10:00:00Z', type: 'Ride', name: 'Intervals analysis', distance: 40_100, moving_time: 7_180, icu_training_load: 91 } });
      await importRecord(database, runId, { ...envelope, provider: 'garmin', remoteId: 'g1', payload: { activityId: 'g1', startTimeGMT: '2026-02-01T10:00:00Z', activityType: 'cycling', activityName: 'Original ride', distance: 40_000, duration: 7_200 } });
      const sources = await database.rows<{ activity_source_id: string; activity_id: string }>('SELECT activity_source_id, activity_id FROM activity_sources ORDER BY activity_source_id');
      const links = await database.rows<{ activity_source_id: string; method: string }>('SELECT activity_source_id, method FROM activity_links ORDER BY activity_source_id');
      const canonical = await database.rows<{ provider: string; intervals_training_load: number | null }>('SELECT provider, intervals_training_load FROM canonical_activity_training');
      expect(sources).toEqual([
        { activity_source_id: 'garmin:g1', activity_id: 'garmin:g1' },
        { activity_source_id: 'intervals:i1', activity_id: 'garmin:g1' },
      ]);
      expect(links).toEqual([
        { activity_source_id: 'garmin:g1', method: 'strong_external_id' },
        { activity_source_id: 'intervals:i1', method: 'strong_external_id' },
      ]);
      expect(canonical[0]).toMatchObject({ provider: 'garmin', intervals_training_load: 91 });
    } finally {
      await database.close();
    }
  });

  it('auto-links exactly one compatible fuzzy match and retains Garmin as canonical', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-02-01');
    try {
      await importRecord(database, runId, { ...envelope, provider: 'garmin', remoteId: 'g1', payload: { activityId: 'g1', startTimeGMT: '2026-02-01T10:00:00Z', activityType: 'cycling', activityName: 'Original ride', distance: 40_000, duration: 7_200 } });
      await importRecord(database, runId, { ...envelope, provider: 'intervals', remoteId: 'i1', payload: { id: 'i1', start_date: '2026-02-01T10:01:00Z', type: 'Ride', name: 'Intervals analysis', distance: 40_100, moving_time: 7_180, icu_training_load: 91 } });
      const links = await database.rows<{ activity_id: string; method: string; confidence: number }>(`SELECT activity_id, method, confidence FROM activity_links WHERE activity_source_id = 'intervals:i1'`);
      const canonical = await database.rows<{ provider: string; intervals_training_load: number | null }>('SELECT provider, intervals_training_load FROM canonical_activity_training');
      expect(links[0]).toMatchObject({ activity_id: 'garmin:g1', method: 'fuzzy_high_confidence' });
      expect(links[0]?.confidence).toBeGreaterThan(0.5);
      expect(canonical[0]).toMatchObject({ provider: 'garmin', intervals_training_load: 91 });
    } finally {
      await database.close();
    }
  });

  it('treats already-linked Garmin and Intervals sources as one Strava match candidate', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('strava', '2026-02-01');
    try {
      await importRecord(database, runId, { ...envelope, provider: 'garmin', remoteId: 'g1', payload: { activityId: 'g1', startTimeGMT: '2026-02-01T10:00:00Z', activityType: 'road_biking', distance: 40_000, duration: 7_200 } });
      await importRecord(database, runId, { ...envelope, provider: 'intervals', remoteId: 'i1', payload: { id: 'i1', external_id: 'g1', start_date: '2026-02-01T10:00:00Z', type: 'Ride', distance: 40_000, moving_time: 7_200 } });
      await importRecord(database, runId, { ...envelope, provider: 'strava', remoteId: 's1', payload: { id: 's1', start_date: '2026-02-01T10:00:06Z', start_date_local: '2026-02-01T05:00:06', type: 'Ride', distance: 40_010, moving_time: 7_195 } });
      const strava = await database.rows<{ activity_id: string }>(`SELECT activity_id FROM activity_sources WHERE activity_source_id = 'strava:s1'`);
      const link = await database.rows<{ method: string }>(`SELECT method FROM activity_links WHERE activity_source_id = 'strava:s1'`);
      expect(strava[0]).toEqual({ activity_id: 'garmin:g1' });
      expect(link[0]).toEqual({ method: 'fuzzy_high_confidence' });
    } finally {
      await database.close();
    }
  });

  it('does not link a near match with incompatible virtual or indoor status and supports a manual correction', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-02-01');
    try {
      await importRecord(database, runId, { ...envelope, provider: 'garmin', remoteId: 'g1', payload: { activityId: 'g1', startTimeGMT: '2026-02-01T10:00:00Z', activityType: 'cycling', distance: 40_000, duration: 7_200 } });
      await importRecord(database, runId, { ...envelope, provider: 'intervals', remoteId: 'i1', payload: { id: 'i1', start_date: '2026-02-01T10:00:30Z', type: 'VirtualRide', distance: 40_000, moving_time: 7_200 } });
      const initial = await database.rows<{ activity_id: string; method: string }>(`SELECT activity_id, method FROM activity_links WHERE activity_source_id = 'intervals:i1'`);
      expect(initial[0]).toEqual({ activity_id: 'intervals:i1', method: 'source' });
      await setManualActivityLink(database, 'intervals:i1', 'garmin:g1');
      const manual = await database.rows<{ activity_id: string; method: string }>(`SELECT activity_id, method FROM activity_links WHERE activity_source_id = 'intervals:i1'`);
      expect(manual[0]).toEqual({ activity_id: 'garmin:g1', method: 'manual' });
      await unlinkActivitySource(database, 'intervals:i1');
      const unlinked = await database.rows<{ activity_id: string; method: string }>(`SELECT activity_id, method FROM activity_links WHERE activity_source_id = 'intervals:i1'`);
      expect(unlinked[0]).toEqual({ activity_id: 'intervals:i1', method: 'source' });
    } finally {
      await database.close();
    }
  });

  it('preserves a fuzzy link when the provider activity is re-imported', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-02-01');
    try {
      await importRecord(database, runId, { ...envelope, provider: 'garmin', remoteId: 'g1', payload: { activityId: 'g1', startTimeGMT: '2026-02-01T10:00:00Z', activityType: 'cycling', distance: 40_000, duration: 7_200 } });
      const intervalsRecord = { ...envelope, provider: 'intervals' as const, remoteId: 'i1', payload: { id: 'i1', start_date: '2026-02-01T10:01:00Z', type: 'Ride', distance: 40_100, moving_time: 7_180 } };
      await importRecord(database, runId, intervalsRecord);
      await importRecord(database, runId, intervalsRecord);
      const source = await database.rows<{ activity_id: string }>(`SELECT activity_id FROM activity_sources WHERE activity_source_id = 'intervals:i1'`);
      expect(source[0]).toEqual({ activity_id: 'garmin:g1' });
    } finally {
      await database.close();
    }
  });
});
