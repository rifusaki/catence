import { describe, expect, it } from 'vitest';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { SwimmingService } from '../src/core/query/swimming.js';
import { openReadOnlyRepository } from '../src/elt/storage/database.js';
import { temporaryDatabase } from './helpers.js';

describe('swimming query service', () => {
  it('returns only explicit lengths, exposes grouped sets, and reports completeness', async () => {
    const { paths, database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-08-04');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'swim-1', parentRemoteId: null,
        occurredOn: '2026-08-04', sourceUpdatedAt: null, rawObjectHash: 'summary', extension: {},
        payload: {
          activityId: 'swim-1', startTimeGMT: '2026-08-04T10:00:00Z', activityType: 'lap_swimming', activityName: 'Pool session',
          distance: 100, duration: 160, poolLength: 2500, activeLengths: 4, averageSwolf: 43, fastestSplit_100: 100,
          averageSpeed: 0.8, averageSwimCadenceInStrokesPerMinute: 22, averageHR: 145, maxHR: 170,
        },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity_detail', remoteId: 'swim-1:detail', parentRemoteId: 'swim-1',
        occurredOn: '2026-08-04', sourceUpdatedAt: null, rawObjectHash: 'detail', extension: {},
        payload: { lengths: [{ lengthIndex: 0, duration: 24, distance: 25, strokeCount: 18, averageHR: 145, maxHR: 150 }] },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity_interval', remoteId: 'swim-1', parentRemoteId: 'swim-1',
        occurredOn: '2026-08-04', sourceUpdatedAt: null, rawObjectHash: 'splits', extension: {},
        payload: { splitSummaries: [{ splitType: 'INTERVAL_ACTIVE', noOfSplits: 2, distance: 100, duration: 160, movingDuration: 120, averageHR: 155, maxHR: 170 }] },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType: 'activity', remoteId: 'i-swim-1', parentRemoteId: null,
        occurredOn: '2026-08-04', sourceUpdatedAt: null, rawObjectHash: 'intervals', extension: {},
        payload: { id: 'i-swim-1', external_id: 'swim-1', start_date: '2026-08-04T10:00:00Z', type: 'Swimming', distance: 100, interval_summary: ['2x 25m 155bpm'] },
      });
      await database.close();

      const repository = await openReadOnlyRepository(paths);
      try {
        const service = new SwimmingService(repository);
        const laps = await service.swimLaps({ activityId: 'garmin:swim-1' });
        const lapSources = laps.data as Array<{ lengths: unknown[]; sets: Array<{ source_type: string }>; availability: { explicitLengthFacts: boolean; perLengthPaceAvailable: boolean } }>;
        expect(lapSources).toHaveLength(1);
        expect(lapSources[0]).toMatchObject({
          lengths: [expect.objectContaining({ distance_m: 25, duration_s: 24, pool_length_m: 25 })],
          sets: [expect.objectContaining({ source_type: 'garmin_detected' })],
          availability: { explicitLengthFacts: true, perLengthPaceAvailable: true },
        });
        const report = await service.swimProgressReport({ startDate: '2026-08-01', endDate: '2026-08-05', poolLengthM: 25 });
        const reportData = report.data as { sessions: Array<{ distance_m: number; pool_length_m: number; dataCompleteness: { explicitLengthFactsAvailable: boolean; perLengthPaceAvailable: boolean } }>; coverage: { sessionCount: number } };
        expect(reportData.coverage.sessionCount).toBe(1);
        expect(reportData.sessions).toEqual([expect.objectContaining({
          distance_m: 100, pool_length_m: 25, dataCompleteness: { explicitLengthFactsAvailable: true, setFactsAvailable: true, perLengthPaceAvailable: true },
        })]);
      } finally {
        await repository.close();
      }
    } finally {
      await database.close();
    }
  });

  it('lists only swim activities that still lack per-length rows for the FIT backfill', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-08-04');
    try {
      // One swim with explicit lengths (already derived) and one without.
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'swim-done', parentRemoteId: null,
        occurredOn: '2026-08-04', sourceUpdatedAt: null, rawObjectHash: 'done-summary', extension: {},
        payload: { activityId: 'swim-done', startTimeGMT: '2026-08-04T10:00:00Z', activityType: 'lap_swimming', distance: 100, duration: 160, poolLength: 2500 },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity_detail', remoteId: 'swim-done:detail', parentRemoteId: 'swim-done',
        occurredOn: '2026-08-04', sourceUpdatedAt: null, rawObjectHash: 'done-detail', extension: {},
        payload: { lengths: [{ lengthIndex: 0, duration: 24, distance: 25, strokeCount: 18 }] },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'swim-pending', parentRemoteId: null,
        occurredOn: '2026-08-05', sourceUpdatedAt: null, rawObjectHash: 'pending-summary', extension: {},
        payload: { activityId: 'swim-pending', startTimeGMT: '2026-08-05T10:00:00Z', activityType: 'lap_swimming', distance: 200, duration: 320, poolLength: 2500 },
      });

      const pending = await database.garminSwimActivitySourcesWithoutLengths();
      expect(pending).toEqual([expect.objectContaining({ remote_activity_id: 'swim-pending' })]);
      expect(String(pending[0]?.started_on ?? '')).toMatch(/^2026-08-05/);
    } finally {
      await database.close();
    }
  });
});
