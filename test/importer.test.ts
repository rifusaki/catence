import { describe, expect, it } from 'vitest';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { temporaryDatabase } from './helpers.js';

describe('normalization importer', () => {
  it('interprets Garmin offset-less GMT activity timestamps as UTC', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-02-01');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'gmt-activity', parentRemoteId: null,
        occurredOn: '2026-02-01', sourceUpdatedAt: null, rawObjectHash: 'gmt-raw', extension: {},
        payload: { activityId: 'gmt-activity', startTimeGMT: '2026-02-01 10:00:00', startTimeLocal: '2026-02-01 05:00:00', activityType: 'running', distance: 10_000, duration: 3_600 },
      });
      expect(await database.rows<{ epoch_s: string }>("SELECT CAST(CAST(epoch(started_at_utc) AS BIGINT) AS VARCHAR) AS epoch_s FROM activities WHERE activity_id = 'garmin:gmt-activity'"))
        .toEqual([{ epoch_s: String(Date.UTC(2026, 1, 1, 10, 0, 0) / 1_000) }]);
    } finally {
      await database.close();
    }
  });

  it('retains Garmin cycling FTP observations from activity summaries and the direct setting', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-02-01');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'g1', parentRemoteId: null,
        occurredOn: '2026-02-01', sourceUpdatedAt: null, rawObjectHash: 'activity-raw', extension: {},
        payload: { activityId: 'g1', startTimeGMT: '2026-02-01T10:00:00Z', activityType: 'indoor_cycling', distance: 40_000, duration: 7_200, maxFtp: 252 },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'training_metric', remoteId: '2026-02-02T09:00:00.0', parentRemoteId: null,
        occurredOn: '2026-02-02', sourceUpdatedAt: null, rawObjectHash: 'setting-raw', extension: {},
        payload: { sport: 'CYCLING', calendarDate: '2026-02-02T09:00:00.0', functionalThresholdPower: 255 },
      });
      const observations = await database.rows<{ source_type: string; source_remote_id: string; value_number: number; activity_source_id: string | null }>(`
        SELECT source_type, source_remote_id, value_number, activity_source_id
        FROM training_metric_observations
        WHERE metric_name = 'cycling_ftp_w'
        ORDER BY source_type
      `);
      expect(observations).toEqual([
        { source_type: 'activity_summary', source_remote_id: 'g1', value_number: 252, activity_source_id: 'garmin:g1' },
        { source_type: 'cycling_ftp', source_remote_id: '2026-02-02T09:00:00.0', value_number: 255, activity_source_id: null },
      ]);
    } finally {
      await database.close();
    }
  });

  it('upserts Garmin cycling FTP history by its observed date', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2025-06-01');
    try {
      const record = {
        kind: 'source_entity' as const, schemaVersion: 1 as const, provider: 'garmin' as const,
        entityType: 'functional_threshold_power', remoteId: 'cycling:2025-06-01', parentRemoteId: null,
        occurredOn: '2025-06-01', sourceUpdatedAt: null, rawObjectHash: 'history-raw', extension: {},
      };
      await importRecord(database, runId, {
        ...record,
        payload: { series: 'cycling', sport: 'CYCLING', until: '2025-06-01T23:59:59.999', value: 250, functionalThresholdPower: 250, calendarDate: '2025-06-01' },
      });
      await importRecord(database, runId, {
        ...record, rawObjectHash: 'history-refresh',
        payload: { series: 'cycling', sport: 'CYCLING', until: '2025-06-01T23:59:59.999', value: 255, functionalThresholdPower: 255, calendarDate: '2025-06-01' },
      });
      const observations = await database.rows<{ observation_id: string; source_type: string; source_remote_id: string; observed_on: string; value_number: number; raw_object_hash: string }>(`
        SELECT observation_id, source_type, source_remote_id,
          CAST(observed_at AT TIME ZONE 'UTC' AS DATE)::VARCHAR AS observed_on,
          value_number, raw_object_hash
        FROM training_metric_observations
        WHERE source_type = 'cycling_ftp_history'
      `);
      expect(observations).toEqual([{
        observation_id: 'garmin:cycling_ftp:history:cycling:2025-06-01', source_type: 'cycling_ftp_history',
        source_remote_id: 'cycling:2025-06-01', observed_on: '2025-06-01', value_number: 255, raw_object_hash: 'history-refresh',
      }]);
    } finally {
      await database.close();
    }
  });

  it('normalizes Garmin running lactate-threshold settings with their provenance', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-07-29');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'lactate_threshold', remoteId: 'lactate_threshold:latest', parentRemoteId: null,
        occurredOn: null, sourceUpdatedAt: null, rawObjectHash: 'threshold-raw', extension: {},
        payload: {
          speed_and_heart_rate: { calendarDate: '2026-07-29T15:23:20.706', speed: 0.42222104, heartRate: 179, heartRateCycling: 175 },
          power: {
            calendarDate: '2026-07-29T10:06:23.6', origin: 'weight', sport: 'RUNNING', functionalThresholdPower: 296,
            weight: 51.298, powerToWeight: 5.7702054661, ftpCreateTime: '2026-07-25T18:54:58.0', weightCreateTime: '2026-07-29T10:06:23.6', isStale: false,
          },
        },
      });
      const observations = await database.rows<{ metric_name: string; sport: string; value_number: number; unit: string; origin: string | null; stale: string | null }>(`
        SELECT metric_name, sport, value_number, unit,
          json_extract_string(dimensions_json, '$.origin') AS origin,
          json_extract_string(dimensions_json, '$.isStale') AS stale
        FROM training_metric_observations
        WHERE source_type = 'lactate_threshold'
        ORDER BY metric_name
      `);
      expect(observations).toEqual([
        { metric_name: 'cycling_lactate_threshold_hr_bpm', sport: 'cycling', value_number: 175, unit: 'bpm', origin: null, stale: null },
        { metric_name: 'running_lactate_threshold_hr_bpm', sport: 'running', value_number: 179, unit: 'bpm', origin: null, stale: null },
        { metric_name: 'running_lactate_threshold_pace_s_per_km', sport: 'running', value_number: expect.closeTo(253.332624), unit: 's/km', origin: null, stale: null },
        { metric_name: 'running_lactate_threshold_power_w', sport: 'running', value_number: 296, unit: 'W', origin: 'weight', stale: 'false' },
        { metric_name: 'running_lactate_threshold_power_w_kg', sport: 'running', value_number: 5.7702054661, unit: 'W/kg', origin: 'weight', stale: 'false' },
      ]);
    } finally {
      await database.close();
    }
  });

  it('keeps historical generic and cycling VO2 max observations queryable by date', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2025-06-01');
    try {
      const record = {
        kind: 'source_entity' as const, schemaVersion: 1 as const, provider: 'garmin' as const, entityType: 'max_metric',
        parentRemoteId: null, sourceUpdatedAt: null, rawObjectHash: 'max-raw', extension: {},
      };
      await importRecord(database, runId, {
        ...record, remoteId: 'max_metrics:2025-06-01', occurredOn: '2025-06-01',
        payload: { generic: { calendarDate: '2025-06-01', vo2MaxPreciseValue: 51.2 }, cycling: { calendarDate: '2025-06-01', vo2MaxValue: 54 } },
      });
      await importRecord(database, runId, {
        ...record, remoteId: 'max_metrics:2025-06-02', occurredOn: '2025-06-02', rawObjectHash: 'max-raw-2',
        payload: { generic: { calendarDate: '2025-06-02', vo2MaxPreciseValue: 51.7 } },
      });
      const rows = await database.rows<{ sport: string; observed_on: string; value_number: number }>(`
        SELECT sport, CAST(observed_at AT TIME ZONE 'UTC' AS DATE)::VARCHAR AS observed_on, value_number
        FROM training_metric_observations WHERE metric_name = 'vo2_max_ml_kg_min' ORDER BY observed_on, sport
      `);
      expect(rows).toEqual([
        { sport: 'cycling', observed_on: '2025-06-01', value_number: 54 },
        { sport: 'generic', observed_on: '2025-06-01', value_number: 51.2 },
        { sport: 'generic', observed_on: '2025-06-02', value_number: 51.7 },
      ]);
    } finally {
      await database.close();
    }
  });

  it('normalizes epoch-millisecond Garmin training-status timestamps', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2025-06-01');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'training_status', remoteId: 'training-status:1',
        parentRemoteId: null, occurredOn: '2025-06-01', sourceUpdatedAt: null, rawObjectHash: 'training-status-raw', extension: {},
        payload: {
          mostRecentTrainingStatus: { latestTrainingStatusData: { '3445722598': { timestamp: 1_748_736_000_000, fitnessTrendSport: 'CYCLING', trainingStatus: 'PRODUCTIVE' } } },
        },
      });
      expect(await database.rows<{ observed_ms: bigint; value_text: string }>(`
        SELECT epoch_ms(observed_at) AS observed_ms, value_text
        FROM training_metric_observations
        WHERE metric_name = 'training_status_training_status'
      `)).toEqual([{ observed_ms: 1_748_736_000_000n, value_text: 'PRODUCTIVE' }]);
    } finally {
      await database.close();
    }
  });

  it('normalizes detailed Garmin wellness facts without dropping their session payload', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2025-06-01');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'daily_health', remoteId: 'sleep:2025-06-01:0',
        parentRemoteId: null, occurredOn: '2025-06-01', sourceUpdatedAt: null, rawObjectHash: 'sleep-raw', extension: {},
        payload: {
          calendarDate: '2025-06-01', heartRateValues: [[1_748_736_000_000, 48]],
          hrvSummary: { lastNightAvg: 42, status: 'BALANCED' },
          // Garmin sleep payloads use epoch milliseconds for these fields.
          dailySleepDTO: { id: 44, sleepStartTimestampGMT: 1_748_736_000_000, sleepEndTimestampGMT: 1_748_761_200_000, deepSleepSeconds: 7200, napTimeSeconds: 1200 },
        },
      });
      const [metrics, samples, sessions] = await Promise.all([
        database.rows<{ metric_name: string; value_number: number | null; value_text: string | null }>("SELECT metric_name, value_number, value_text FROM daily_metrics WHERE metric_name IN ('hrv_ms', 'sleep_deep_seconds', 'nap_seconds', 'hrv_status') ORDER BY metric_name"),
        database.rows<{ metric_name: string; value_number: number }>('SELECT metric_name, value_number FROM wellness_samples'),
        database.rows<{ session_type: string; start_ms: bigint; end_ms: bigint; payload_json: unknown }>('SELECT session_type, epoch_ms(started_at) AS start_ms, epoch_ms(ended_at) AS end_ms, payload_json FROM health_sessions'),
      ]);
      expect(metrics).toContainEqual({ metric_name: 'hrv_ms', value_number: 42, value_text: null });
      expect(metrics).toContainEqual({ metric_name: 'sleep_deep_seconds', value_number: 7200, value_text: null });
      expect(metrics).toContainEqual({ metric_name: 'nap_seconds', value_number: 1200, value_text: null });
      expect(metrics).toContainEqual({ metric_name: 'hrv_status', value_number: null, value_text: 'BALANCED' });
      expect(samples).toEqual([{ metric_name: 'heart_rate_bpm', value_number: 48 }]);
      expect(sessions[0]).toMatchObject({ session_type: 'sleep', start_ms: 1_748_736_000_000n, end_ms: 1_748_761_200_000n });
    } finally {
      await database.close();
    }
  });

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
      await importRecord(database, runId, {
        ...base, provider: 'intervals', entityType: 'wellness', remoteId: 'intervals-2025-07-30',
        payload: { date: '2025-07-30', restingHR: 41, sleepSecs: 28800, steps: 14000 },
      });
      await importRecord(database, runId, { ...base, entityType: 'nutrition_log', payload: { calendarDate: '2025-07-30', totalCalories: 2400, totalCarbs: 315, totalProtein: 130, totalFat: 72, foodItems: [{ id: 'food-1', foodName: 'Oats', quantity: 100, calories: 380, carbs: 65, protein: 13, fat: 7 }] } });
      const health = await database.rows<{ provider: string; resting_hr_bpm: number; sleep_seconds: number; steps: number }>('SELECT provider, resting_hr_bpm, sleep_seconds, steps FROM daily_health');
      const healthSources = await database.rows<{ provider: string; resting_hr_bpm: number }>("SELECT provider, value_number AS resting_hr_bpm FROM daily_metrics WHERE metric_name = 'resting_hr_bpm' ORDER BY provider");
      const nutrition = await database.rows<{ energy_kcal: number; carbohydrates_g: number }>('SELECT energy_kcal, carbohydrates_g FROM nutrition_days');
      const items = await database.rows<{ food_name: string; energy_kcal: number; payload_json: unknown }>('SELECT food_name, energy_kcal, payload_json FROM nutrition_items');
      expect(health).toEqual([{ provider: 'garmin', resting_hr_bpm: 48, sleep_seconds: 27000, steps: 12000 }]);
      expect(healthSources).toEqual([{ provider: 'garmin', resting_hr_bpm: 48 }, { provider: 'intervals', resting_hr_bpm: 41 }]);
      expect(nutrition[0]).toMatchObject({ energy_kcal: 2400, carbohydrates_g: 315 });
      expect(items[0]).toMatchObject({ food_name: 'Oats', energy_kcal: 380 });
      expect(JSON.parse(String(items[0]?.payload_json))).toMatchObject({ foodName: 'Oats' });
    } finally {
      await database.close();
    }
  });

  it('normalizes Garmin split summaries and Intervals auto swim blocks without inventing lengths', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-08-04');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'swim-1', parentRemoteId: null,
        occurredOn: '2026-08-04', sourceUpdatedAt: null, rawObjectHash: 'swim-summary', extension: {},
        payload: {
          activityId: 'swim-1', startTimeGMT: '2026-08-04T10:00:00Z', activityType: 'lap_swimming', activityName: 'Pool set',
          distance: 100, duration: 120, poolLength: 2500, activeLengths: 4, averageSpeed: 0.8, averageSwimCadenceInStrokesPerMinute: 22,
        },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity_interval', remoteId: 'swim-1', parentRemoteId: 'swim-1',
        occurredOn: '2026-08-04', sourceUpdatedAt: null, rawObjectHash: 'swim-splits', extension: {},
        payload: { splitSummaries: [{ splitType: 'INTERVAL_ACTIVE', noOfSplits: 2, distance: 100, duration: 120, movingDuration: 110, averageHR: 160, maxHR: 170 }] },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType: 'activity', remoteId: 'intervals-swim-1', parentRemoteId: null,
        occurredOn: '2026-08-04', sourceUpdatedAt: null, rawObjectHash: 'intervals-swim', extension: {},
        payload: { id: 'intervals-swim-1', external_id: 'swim-1', start_date: '2026-08-04T10:00:00Z', type: 'Swimming', distance: 100, interval_summary: ['2x 25m 155bpm'] },
      });
      const [intervals, sets, lengths] = await Promise.all([
        database.rows<{ source_type: string; label: string; distance_m: number; duration_s: number; moving_s: number; avg_hr: number }>(`
          SELECT source_type, label, distance_m, duration_s, moving_s, avg_hr
          FROM activity_interval_facts WHERE activity_source_id = 'garmin:swim-1'
        `),
        database.rows<{ source_type: string; label: string; reps: number; rep_distance_m: number | null; total_distance_m: number; work_s: number | null; avg_hr: number | null }>(`
          SELECT source_type, label, reps, rep_distance_m, total_distance_m, work_s, avg_hr
          FROM swim_set_facts ORDER BY source_type
        `),
        database.rows<{ count: number }>("SELECT count(*)::INTEGER AS count FROM swim_lengths WHERE activity_source_id = 'garmin:swim-1'"),
      ]);
      expect(intervals).toEqual([{ source_type: 'garmin_detected', label: 'INTERVAL_ACTIVE', distance_m: 100, duration_s: 120, moving_s: 110, avg_hr: 160 }]);
      expect(sets).toEqual([
        { source_type: 'garmin_detected', label: 'INTERVAL_ACTIVE', reps: 2, rep_distance_m: null, total_distance_m: 100, work_s: 110, avg_hr: 160 },
        { source_type: 'intervals_auto', label: '2x 25m 155bpm', reps: 2, rep_distance_m: 25, total_distance_m: 50, work_s: null, avg_hr: 155 },
      ]);
      expect(lengths[0]?.count).toBe(0);
    } finally {
      await database.close();
    }
  });

  it('flags implausible pool data and exposes provider distance precedence without suppressing either source', async () => {
    const { database } = await temporaryDatabase();
    const runId = await database.beginRun('garmin', '2026-07-19');
    try {
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'bad-swim', parentRemoteId: null,
        occurredOn: '2026-07-19', sourceUpdatedAt: null, rawObjectHash: 'bad-garmin', extension: {},
        payload: {
          activityId: 'bad-swim', startTimeGMT: '2026-07-19T17:00:00Z', activityType: 'lap_swimming', distance: 266, duration: 3131,
          poolLength: 1400, activeLengths: 19, averageSpeed: 0, averageSwimCadenceInStrokesPerMinute: 0,
        },
      });
      await importRecord(database, runId, {
        kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType: 'activity', remoteId: 'bad-intervals', parentRemoteId: null,
        occurredOn: '2026-07-19', sourceUpdatedAt: null, rawObjectHash: 'bad-intervals', extension: {},
        payload: { id: 'bad-intervals', external_id: 'bad-swim', start_date: '2026-07-19T17:00:00Z', type: 'Swimming', distance: 180 },
      });
      const flags = await database.rows<{ activity_source_id: string; flag_code: string }>(`
        SELECT activity_source_id, flag_code FROM activity_quality_flag_facts ORDER BY activity_source_id, flag_code
      `);
      const canonical = await database.rows<{ garmin_distance_m: number; intervals_distance_m: number; resolved_distance_m: number; distance_source: string; provider_distance_difference_m: number; quality_flags: unknown }>(`
        SELECT garmin_distance_m, intervals_distance_m, resolved_distance_m, distance_source, provider_distance_difference_m, quality_flags
        FROM canonical_activity_facts WHERE activity_id = 'garmin:bad-swim'
      `);
      expect(flags).toEqual(expect.arrayContaining([
        { activity_source_id: 'garmin:bad-swim', flag_code: 'pool_length_implausible' },
        { activity_source_id: 'garmin:bad-swim', flag_code: 'zero_swim_speed_and_cadence' },
        { activity_source_id: 'garmin:bad-swim', flag_code: 'provider_distance_disagreement' },
        { activity_source_id: 'intervals:bad-intervals', flag_code: 'provider_distance_disagreement' },
      ]));
      expect(canonical).toEqual([expect.objectContaining({
        garmin_distance_m: 266, intervals_distance_m: 180, resolved_distance_m: 266, distance_source: 'garmin', provider_distance_difference_m: 86,
      })]);
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
