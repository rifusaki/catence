import { describe, expect, it } from 'vitest';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { multisportChildActivitySourceIds, resolveStravaActivityId, stravaActivityIdFromExternalId, stravaActivityIdFromSourcePayload } from '../src/elt/ingestion/providers/strava/service.js';
import { temporaryDatabase } from './helpers.js';

describe('Strava activity IDs', () => {
  it('uses an explicitly-qualified Strava ID instead of timestamp matching', () => {
    expect(stravaActivityIdFromExternalId('strava:23408388054')).toBe('23408388054');
    expect(stravaActivityIdFromExternalId('https://www.strava.com/activities/23408388054')).toBe('23408388054');
  });

  it('does not mistake an arbitrary external identifier for a Strava activity', () => {
    expect(stravaActivityIdFromExternalId('23408388054')).toBeNull();
    expect(stravaActivityIdFromExternalId('external:23408388054')).toBeNull();
    expect(stravaActivityIdFromExternalId('garmin-activity-42')).toBeNull();
    expect(stravaActivityIdFromExternalId(null)).toBeNull();
  });

  it('prefers an existing linked Strava source over an Intervals external ID', () => {
    expect(resolveStravaActivityId('intervals:i151098464', [
      { provider: 'intervals', remote_activity_id: 'i151098464', external_id: '22995929424' },
      { provider: 'strava', remote_activity_id: '18635626846', external_id: null },
    ])).toBe('18635626846');
  });

  it('reads the source-level Strava ID that distinguishes multisport legs', () => {
    expect(stravaActivityIdFromSourcePayload('{"external_id":"22995929424","strava_id":"18635626894"}')).toBe('18635626894');
    expect(stravaActivityIdFromSourcePayload({ strava_id: 18635626894 })).toBe('18635626894');
    expect(stravaActivityIdFromSourcePayload('{"strava_id":"not-an-id"}')).toBeNull();
  });

  it('selects only the non-transition Garmin children of a multisport parent', async () => {
    const { paths, database } = await temporaryDatabase();
    let closed = false;
    const base = {
      kind: 'source_entity' as const, schemaVersion: 1 as const, provider: 'garmin' as const, entityType: 'activity' as const,
      occurredOn: '2026-08-02', sourceUpdatedAt: null, rawObjectHash: 'raw', extension: {},
    };
    const runId = await database.beginRun('garmin', '2026-08-02');
    try {
      await importRecord(database, runId, {
        ...base, remoteId: 'parent', parentRemoteId: null,
        payload: { activityId: 'parent', isParent: true, startTimeGMT: '2026-08-02T12:00:00Z', activityType: { typeKey: 'multi_sport' }, distance: 1, elapsedDuration: 1 },
      });
      await importRecord(database, runId, {
        ...base, remoteId: 'ride-leg', parentRemoteId: 'parent',
        payload: { activityId: 'ride-leg', startTimeGMT: '2026-08-02T12:01:00Z', activityType: { typeKey: 'cycling' }, distance: 1_000, elapsedDuration: 120 },
      });
      await importRecord(database, runId, {
        ...base, remoteId: 'transition-leg', parentRemoteId: 'parent',
        payload: { activityId: 'transition-leg', startTimeGMT: '2026-08-02T12:03:00Z', activityType: { typeKey: 'transition_v2' }, distance: 10, elapsedDuration: 20 },
      });
      await database.close();
      closed = true;
      await expect(multisportChildActivitySourceIds(paths, 'garmin:parent')).resolves.toEqual(['garmin:ride-leg']);
    } finally {
      if (!closed) await database.close();
    }
  });
});
