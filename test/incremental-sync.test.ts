import { describe, expect, it } from 'vitest';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { temporaryDatabase } from './helpers.js';

describe('incremental sync state', () => {
  it('bootstraps from normalized source coverage and keeps a 30-day overlap', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2025-07-30');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'daily_health', remoteId: '2026-07-30', parentRemoteId: null,
        occurredOn: '2026-07-30', sourceUpdatedAt: null, rawObjectHash: null, payload: { calendarDate: '2026-07-30', hrvSDNN: 52 }, extension: {},
      });
      await database.finishRun(runId);
      const initial = await database.resolveIncrementalWindow('garmin', 'daily', '2026-07-31', '2025-07-31', 3);
      expect(initial).toEqual({ fromDate: '2026-07-27', toDate: '2026-07-31', source: 'bootstrap' });
      const repeated = await database.resolveIncrementalWindow('garmin', 'daily', '2026-08-01', '2025-08-01', 3);
      expect(repeated).toEqual({ fromDate: '2026-07-28', toDate: '2026-08-01', source: 'cursor' });
    } finally {
      await database.close();
    }
  });

  it('only requests expensive activity detail extraction for unseen or changed summaries', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('intervals', '2026-07-01');
    try {
      expect(await database.activityNeedsDetailSync('intervals', 'activity-1', 'a'.repeat(64))).toBe(true);
      await database.recordActivitySyncState('intervals', 'activity-1', 'a'.repeat(64), runId, true);
      expect(await database.activityNeedsDetailSync('intervals', 'activity-1', 'a'.repeat(64))).toBe(false);
      expect(await database.activityNeedsDetailSync('intervals', 'activity-1', 'b'.repeat(64))).toBe(true);
      expect(await database.knownActivitySummaryHashes('intervals')).toEqual({ 'activity-1': 'a'.repeat(64) });
    } finally {
      await database.close();
    }
  });
});
