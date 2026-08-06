import { describe, expect, it } from 'vitest';
import { resolveStravaActivityId, stravaActivityIdFromExternalId, stravaActivityIdFromSourcePayload } from '../src/elt/ingestion/providers/strava/service.js';

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
});
