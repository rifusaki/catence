import { describe, expect, it } from 'vitest';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { temporaryDatabase } from './helpers.js';

describe('normalization importer', () => {
  it('links only matching external IDs and keeps provider facts', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('intervals', '2025-07-29');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType: 'activity', remoteId: 'i1', parentRemoteId: null,
        occurredOn: '2025-07-30', sourceUpdatedAt: null, rawObjectHash: null,
        payload: { id: 'i1', external_id: 'shared-activity', start_date: '2025-07-30T10:00:00Z', start_date_local: '2025-07-30T05:00:00', type: 'Ride', name: 'Intervals ride', distance: 40000, icu_training_load: 80 }, extension: {},
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'g1', parentRemoteId: null,
        occurredOn: '2025-07-30', sourceUpdatedAt: null, rawObjectHash: null,
        payload: { activityId: 'g1', externalId: 'shared-activity', startTimeGMT: '2025-07-30T10:00:00Z', startTimeLocal: '2025-07-30T05:00:00', activityName: 'Garmin ride', distance: 40000, duration: 7200 }, extension: {},
      });
      const activities = await database.rows<{ count: number; activity_id: string }>('SELECT count(*)::INTEGER AS count, max(activity_id) AS activity_id FROM activities');
      const sources = await database.rows<{ count: number }>('SELECT count(*)::INTEGER AS count FROM activity_sources');
      const canonical = await database.rows<{ provider: string; intervals_training_load: number | null }>('SELECT provider, intervals_training_load FROM canonical_activity_training');
      expect(activities[0]).toEqual({ count: 1, activity_id: 'external:shared-activity' });
      expect(sources[0]?.count).toBe(2);
      expect(canonical[0]).toMatchObject({ provider: 'garmin', intervals_training_load: 80 });
    } finally {
      await database.close();
    }
  });

  it('projects wellness and retains detailed nutrition items without dropping the payload', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2025-07-29');
    try {
      const base = { kind: 'source_entity' as const, schemaVersion: 1 as const, provider: 'garmin' as const, remoteId: '2025-07-30', parentRemoteId: null, occurredOn: '2025-07-30', sourceUpdatedAt: null, rawObjectHash: null, extension: {} };
      await importRecord(database, runId, { ...base, entityType: 'daily_health', payload: { calendarDate: '2025-07-30', restingHeartRate: 48, sleepTimeSeconds: 27000, totalSteps: 12000 } });
      await importRecord(database, runId, { ...base, entityType: 'nutrition_log', payload: { calendarDate: '2025-07-30', totalCalories: 2400, totalCarbs: 315, totalProtein: 130, totalFat: 72, foodItems: [{ id: 'food-1', foodName: 'Oats', quantity: 100, calories: 380, carbs: 65, protein: 13, fat: 7 }] } });
      const health = await database.rows<{ resting_hr_bpm: number; sleep_seconds: number; steps: number }>('SELECT resting_hr_bpm, sleep_seconds, steps FROM daily_health');
      const nutrition = await database.rows<{ energy_kcal: number; carbohydrates_g: number }>('SELECT energy_kcal, carbohydrates_g FROM nutrition_days');
      const items = await database.rows<{ food_name: string; energy_kcal: number; payload_json: unknown }>('SELECT food_name, energy_kcal, payload_json FROM nutrition_items');
      expect(health[0]).toMatchObject({ resting_hr_bpm: 48, sleep_seconds: 27000, steps: 12000 });
      expect(nutrition[0]).toMatchObject({ energy_kcal: 2400, carbohydrates_g: 315 });
      expect(items[0]).toMatchObject({ food_name: 'Oats', energy_kcal: 380 });
      expect(JSON.parse(String(items[0]?.payload_json))).toMatchObject({ foodName: 'Oats' });
    } finally {
      await database.close();
    }
  });

  it('records extraction errors without blocking independent records', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('intervals', '2025-07-29');
    try {
      await importRecord(database, runId, { kind: 'extraction_error', schemaVersion: 1, provider: 'intervals', endpoint: 'activity_streams', remoteId: 'i2', message: 'HTTP 429', retryable: true });
      await importRecord(database, runId, { kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType: 'activity', remoteId: 'i3', parentRemoteId: null, occurredOn: '2025-07-30', sourceUpdatedAt: null, rawObjectHash: null, payload: { id: 'i3', name: 'Still imported' }, extension: {} });
      const errors = await database.rows<{ count: number }>('SELECT count(*)::INTEGER AS count FROM normalization_errors');
      const activities = await database.rows<{ count: number }>('SELECT count(*)::INTEGER AS count FROM activities');
      expect(errors[0]?.count).toBe(1);
      expect(activities[0]?.count).toBe(1);
    } finally {
      await database.close();
    }
  });
});
