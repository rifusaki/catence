import type { CatenceDatabase } from '../storage/database.js';
import { json } from '../storage/sql.js';
import type { Provider, SourceEntity } from '../../contracts/staging.js';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function objectFromJson(value: unknown): JsonObject {
  if (typeof value !== 'string') return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((item) => Object.keys(item).length > 0) : [];
}

function firstString(payload: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function firstNumber(payload: JsonObject, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function firstBoolean(payload: JsonObject, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'boolean') return value;
    if (value === 0 || value === '0' || value === 'false') return false;
    if (value === 1 || value === '1' || value === 'true') return true;
  }
  return null;
}

function garminPoolLengthM(payload: JsonObject): number | null {
  const value = firstNumber(payload, ['poolLength', 'pool_length', 'poolLengthM']);
  if (value === null || value <= 0) return null;
  // Garmin's activity summary currently reports its pool length in centimetres
  // (for example 2500 for a 25 m pool). Keep support for a future metre-valued
  // endpoint without treating a 25 m setting as 0.25 m.
  return value >= 100 ? value / 100 : value;
}

function swimSourceLabel(payload: JsonObject): string | null {
  const direct = firstString(payload, ['lengthType', 'swimType', 'type', 'label', 'name']);
  return direct ? direct.toLowerCase() : null;
}

function datePart(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function providerActivityId(provider: Provider, remoteId: string): string {
  return `${provider}:${remoteId}`;
}

function activityIdentity(provider: Provider, remoteId: string, payload: JsonObject): string {
  const externalId = firstString(payload, provider === 'intervals' ? ['external_id'] : ['externalId']);
  return externalId ? `external:${externalId}` : providerActivityId(provider, remoteId);
}

/** Garmin's GMT strings often omit their offset; make their UTC meaning explicit for DuckDB. */
function garminUtcTimestamp(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(' ', 'T');
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
}

function activityFields(provider: Provider, payload: JsonObject): {
  startAtUtc: string | null;
  startAtLocal: string | null;
  timezone: string | null;
  sport: string | null;
  name: string | null;
  externalId: string | null;
  summary: Record<string, number | null>;
} {
  const summaryPayload = object(payload.summaryDTO);
  const source = { ...summaryPayload, ...payload };
  const intervals = provider === 'intervals';
  const garminStartAtGmt = firstString(source, ['startTimeGMT']);
  return {
    startAtUtc: intervals
      ? firstString(source, ['start_date'])
      : garminUtcTimestamp(garminStartAtGmt) ?? firstString(source, ['startTimeLocal']),
    startAtLocal: firstString(source, intervals ? ['start_date_local', 'start_date'] : ['startTimeLocal', 'startTimeGMT']),
    timezone: firstString(source, intervals ? ['timezone'] : ['timeZoneUnitDTO']),
    sport: intervals
      ? firstString(source, ['type'])
      : firstString(object(source.activityTypeDTO), ['typeKey']) ?? firstString(object(source.activityType), ['typeKey']) ?? firstString(source, ['activityType', 'activityTypeKey']),
    name: firstString(source, intervals ? ['name'] : ['activityName']),
    externalId: firstString(source, intervals ? ['external_id'] : ['externalId']),
    summary: {
      distanceM: firstNumber(source, ['distance']),
      movingS: firstNumber(source, intervals ? ['moving_time'] : ['movingDuration', 'duration']),
      elapsedS: firstNumber(source, intervals ? ['elapsed_time'] : ['elapsedDuration', 'duration']),
      elevationGainM: firstNumber(source, intervals ? ['total_elevation_gain'] : ['elevationGain']),
      calories: firstNumber(source, ['calories']),
      avgHr: firstNumber(source, intervals ? ['average_heartrate'] : ['averageHR']),
      maxHr: firstNumber(source, intervals ? ['max_heartrate'] : ['maxHR']),
      avgPower: firstNumber(source, intervals ? ['icu_average_watts', 'average_watts'] : ['averagePower']),
      weightedPower: firstNumber(source, intervals ? ['icu_weighted_avg_watts'] : ['normalizedPower']),
      avgCadence: firstNumber(source, ['average_cadence', 'averageRunningCadence']),
      trainingLoad: firstNumber(source, intervals ? ['icu_training_load', 'power_load', 'hr_load'] : ['activityTrainingLoad']),
      rpe: firstNumber(source, intervals ? ['icu_rpe', 'session_rpe', 'perceived_exertion'] : ['perceivedExertion']),
      feel: firstNumber(source, ['feel']),
    },
  };
}

const dailyMetricMap: Array<{ name: string; unit: string; keys: string[] }> = [
  { name: 'resting_hr_bpm', unit: 'bpm', keys: ['restingHR', 'restingHeartRate', 'restingHeartRateInBeatsPerMinute'] },
  { name: 'hrv_ms', unit: 'ms', keys: ['hrv', 'hrvSDNN', 'lastNightAvg'] },
  { name: 'sleep_seconds', unit: 's', keys: ['sleepSecs', 'sleepTimeSeconds', 'sleepTimeInSeconds'] },
  { name: 'sleep_score', unit: 'score', keys: ['sleepScore', 'overallSleepScore'] },
  { name: 'stress', unit: 'score', keys: ['stress', 'averageStressLevel'] },
  { name: 'body_battery', unit: 'score', keys: ['bodyBattery', 'charged', 'bodyBatteryMostRecentValue'] },
  { name: 'readiness', unit: 'score', keys: ['readiness', 'score', 'trainingReadinessScore'] },
  { name: 'spo2_pct', unit: '%', keys: ['spO2', 'spo2', 'averageSpO2'] },
  { name: 'weight_kg', unit: 'kg', keys: ['weight', 'weightInKg'] },
  { name: 'steps', unit: 'count', keys: ['steps', 'totalSteps'] },
  { name: 'respiration_bpm', unit: 'breaths/min', keys: ['respiration', 'avgWakingRespirationValue'] },
  { name: 'total_calories_kcal', unit: 'kcal', keys: ['totalKilocalories', 'totalCalories'] },
  { name: 'active_calories_kcal', unit: 'kcal', keys: ['activeKilocalories'] },
  { name: 'bmr_calories_kcal', unit: 'kcal', keys: ['bmrKilocalories'] },
  { name: 'floors_ascended', unit: 'count', keys: ['floorsAscended'] },
  { name: 'floors_descended', unit: 'count', keys: ['floorsDescended'] },
  { name: 'intensity_minutes_moderate', unit: 'min', keys: ['moderateIntensityMinutes'] },
  { name: 'intensity_minutes_vigorous', unit: 'min', keys: ['vigorousIntensityMinutes'] },
  { name: 'intensity_minutes_total', unit: 'min', keys: ['intensityMinutes', 'totalIntensityMinutes'] },
  { name: 'sleep_deep_seconds', unit: 's', keys: ['deepSleepSeconds'] },
  { name: 'sleep_light_seconds', unit: 's', keys: ['lightSleepSeconds'] },
  { name: 'sleep_rem_seconds', unit: 's', keys: ['remSleepSeconds'] },
  { name: 'sleep_awake_seconds', unit: 's', keys: ['awakeSleepSeconds'] },
  { name: 'nap_seconds', unit: 's', keys: ['napTimeSeconds'] },
];

function snake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.length >= 10) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
  return new Date(milliseconds).toISOString();
}

function firstTimestamp(payload: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = timestamp(payload[key]);
    if (value) return value;
  }
  return null;
}

async function upsertDailyMetric(database: CatenceDatabase, provider: Provider, metricDate: string, metricName: string, valueNumber: number | null, valueText: string | null, unit: string | null, rawHash: string | null): Promise<void> {
  await database.run(
    `INSERT INTO daily_metrics VALUES ($provider, $metricDate, $metricName, $valueNumber, $valueText, $unit, $rawHash)
     ON CONFLICT (provider, metric_date, metric_name) DO UPDATE SET value_number = excluded.value_number, value_text = excluded.value_text,
       unit = excluded.unit, raw_object_hash = excluded.raw_object_hash`,
    { provider, metricDate, metricName, valueNumber, valueText, unit, rawHash },
  );
}

function nutritionFields(payload: JsonObject): Record<string, number | null> {
  return {
    energyKcal: firstNumber(payload, ['kcalConsumed', 'calories', 'totalCalories', 'energyKcal']),
    carbohydratesG: firstNumber(payload, ['carbohydrates', 'carbs', 'totalCarbs', 'carbohydrateGrams']),
    proteinG: firstNumber(payload, ['protein', 'totalProtein', 'proteinGrams']),
    fatG: firstNumber(payload, ['fatTotal', 'fat', 'totalFat', 'fatGrams']),
    hydrationMl: firstNumber(payload, ['hydrationVolume', 'hydration', 'waterMl', 'totalWater']),
  };
}

function nutritionItems(payload: JsonObject): JsonObject[] {
  const candidates = ['foodItems', 'items', 'entries', 'foodLogEntries', 'meals'];
  for (const key of candidates) {
    const value = payload[key];
    if (Array.isArray(value)) return value.map(object).filter((item) => Object.keys(item).length > 0);
  }
  return [];
}

export async function importSourceEntity(database: CatenceDatabase, entity: SourceEntity): Promise<void> {
  const payload = object(entity.payload);
  const rawHash = entity.rawObjectHash;
  await database.run(
    `INSERT INTO source_entities
      (provider, entity_type, remote_id, parent_remote_id, occurred_on, source_updated_at, raw_object_hash, payload_json, extension_json)
      VALUES ($provider, $entityType, $remoteId, $parentRemoteId, $occurredOn, $sourceUpdatedAt, $rawHash, $payload, $extension)
      ON CONFLICT (provider, entity_type, remote_id) DO UPDATE SET
        parent_remote_id = excluded.parent_remote_id, occurred_on = excluded.occurred_on,
        source_updated_at = excluded.source_updated_at, raw_object_hash = excluded.raw_object_hash,
        payload_json = excluded.payload_json, extension_json = excluded.extension_json, normalized_at = now()`,
    {
      provider: entity.provider, entityType: entity.entityType, remoteId: entity.remoteId,
      parentRemoteId: entity.parentRemoteId, occurredOn: entity.occurredOn, sourceUpdatedAt: entity.sourceUpdatedAt,
      rawHash, payload: json(payload), extension: json(entity.extension),
    },
  );
  await database.run(
    `INSERT INTO domain_entities
      (provider, entity_type, remote_id, parent_remote_id, occurred_on, payload_json, extension_json, raw_object_hash)
      VALUES ($provider, $entityType, $remoteId, $parentRemoteId, $occurredOn, $payload, $extension, $rawHash)
      ON CONFLICT (provider, entity_type, remote_id) DO UPDATE SET
        parent_remote_id = excluded.parent_remote_id, occurred_on = excluded.occurred_on,
        payload_json = excluded.payload_json, extension_json = excluded.extension_json, raw_object_hash = excluded.raw_object_hash`,
    {
      provider: entity.provider, entityType: entity.entityType, remoteId: entity.remoteId,
      parentRemoteId: entity.parentRemoteId, occurredOn: entity.occurredOn,
      payload: json(payload), extension: json(entity.extension), rawHash,
    },
  );
  if (entity.entityType === 'profile' || entity.entityType === 'athlete') {
    const accountId = firstString(payload, ['id', 'userProfileNumber', 'profileId']) ?? entity.remoteId;
    await database.insertSourceAccount(entity.provider, accountId, firstString(payload, ['name', 'displayName', 'fullName']), payload);
  }

  if (entity.entityType === 'activity') {
    await importActivity(database, entity.provider, entity.remoteId, payload, rawHash);
    if (entity.provider === 'intervals') await importIntervalsAutoSwimSets(database, entity.remoteId, payload, rawHash);
    if (entity.provider === 'garmin') {
      await importGarminCyclingFtpFromActivity(database, entity.remoteId, payload, rawHash);
      await importGarminActivityPerformance(database, entity.remoteId, payload, rawHash);
    }
  }
  if (entity.entityType === 'activity_interval') await importActivityIntervals(database, entity.provider, entity.parentRemoteId, payload, rawHash);
  if (entity.provider === 'garmin' && ['activity_detail', 'activity_interval', 'activity_exercise_set'].includes(entity.entityType)) {
    await importGarminExplicitSwimLengths(database, entity.parentRemoteId, entity.entityType, payload, rawHash);
  }
  if (entity.entityType === 'wellness' || entity.entityType === 'daily_health') await importDailyMetrics(database, entity.provider, entity.remoteId, entity.occurredOn, payload, rawHash);
  if (entity.entityType === 'nutrition_day' || entity.entityType === 'nutrition_log') await importNutrition(database, entity.provider, entity.occurredOn, entity.remoteId, payload, rawHash);
  if (entity.provider === 'garmin' && entity.entityType === 'training_metric') await importGarminCyclingFtp(database, entity.remoteId, payload, rawHash);
  if (entity.provider === 'garmin' && entity.entityType === 'lactate_threshold') await importGarminLactateThreshold(database, entity.remoteId, payload, rawHash);
  if (entity.provider === 'garmin' && entity.entityType === 'functional_threshold_power') await importGarminCyclingFtpHistory(database, entity.remoteId, payload, rawHash);
  if (entity.provider === 'garmin' && entity.entityType === 'max_metric') await importGarminMaxMetrics(database, entity.remoteId, entity.occurredOn, payload, rawHash);
  if (entity.provider === 'garmin' && entity.entityType === 'fitness_age') await importGarminFitnessAge(database, entity.remoteId, entity.occurredOn, payload, rawHash);
  if (entity.provider === 'garmin' && entity.entityType === 'training_status') await importGarminTrainingStatus(database, entity.remoteId, entity.occurredOn, payload, rawHash);
  if (entity.provider === 'garmin' && ['endurance_score', 'hill_score', 'running_tolerance', 'race_prediction'].includes(entity.entityType)) await importGarminNumericSeries(database, entity.entityType, entity.remoteId, entity.occurredOn, payload, rawHash);
  if (entity.provider === 'garmin' && entity.entityType === 'health_event') await importHealthSession(database, entity.remoteId, entity.occurredOn, 'daily_event', payload, rawHash);
  if (entity.provider === 'garmin' && entity.entityType === 'activity_power_best') await importActivityPowerBest(database, entity.parentRemoteId, payload, rawHash);
}

async function importActivity(database: CatenceDatabase, provider: Provider, remoteId: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const fields = activityFields(provider, payload);
  const activityId = activityIdentity(provider, remoteId, payload);
  const activitySourceId = providerActivityId(provider, remoteId);
  await database.run(
    `INSERT INTO activities (activity_id, started_at_utc, started_at_local, timezone, sport, name, link_state)
      VALUES ($activityId, $startedAtUtc, $startedAtLocal, $timezone, $sport, $name, $linkState)
      ON CONFLICT (activity_id) DO UPDATE SET started_at_utc = excluded.started_at_utc, started_at_local = excluded.started_at_local,
        timezone = excluded.timezone, sport = excluded.sport, name = excluded.name, link_state = excluded.link_state`,
    { activityId, startedAtUtc: fields.startAtUtc, startedAtLocal: fields.startAtLocal, timezone: fields.timezone, sport: fields.sport, name: fields.name, linkState: fields.externalId ? 'strong_external_id' : 'unlinked' },
  );
  await database.run(
    `INSERT INTO activity_sources (activity_source_id, activity_id, provider, remote_activity_id, external_id, raw_object_hash)
      VALUES ($activitySourceId, $activityId, $provider, $remoteId, $externalId, $rawHash)
      ON CONFLICT (activity_source_id) DO UPDATE SET activity_id = excluded.activity_id, provider = excluded.provider,
        remote_activity_id = excluded.remote_activity_id, external_id = excluded.external_id, raw_object_hash = excluded.raw_object_hash`,
    { activitySourceId, activityId, provider, remoteId, externalId: fields.externalId, rawHash },
  );
  await database.run(
    `INSERT INTO activity_summaries
      (activity_source_id, distance_m, moving_s, elapsed_s, elevation_gain_m, calories, avg_hr, max_hr, avg_power, weighted_power, avg_cadence, training_load, rpe, feel, metrics_json)
      VALUES ($activitySourceId, $distanceM, $movingS, $elapsedS, $elevationGainM, $calories, $avgHr, $maxHr, $avgPower, $weightedPower, $avgCadence, $trainingLoad, $rpe, $feel, $metrics)
      ON CONFLICT (activity_source_id) DO UPDATE SET distance_m = excluded.distance_m, moving_s = excluded.moving_s,
        elapsed_s = excluded.elapsed_s, elevation_gain_m = excluded.elevation_gain_m, calories = excluded.calories,
        avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, avg_power = excluded.avg_power, weighted_power = excluded.weighted_power,
        avg_cadence = excluded.avg_cadence, training_load = excluded.training_load, rpe = excluded.rpe, feel = excluded.feel, metrics_json = excluded.metrics_json`,
    { activitySourceId, ...fields.summary, metrics: json(payload) },
  );
}

function isCyclingSport(sport: string | null): boolean {
  return Boolean(sport && /cycl|ride/i.test(sport));
}

async function upsertTrainingMetricObservation(
  database: CatenceDatabase,
  values: {
    observationId: string;
    metricName: string;
    sport: string;
    observedAt: string;
    value?: number | null;
    valueText?: string | null;
    unit?: string | null;
    deviceId?: string | null;
    dimensions?: JsonObject;
    sourceType: string;
    sourceRemoteId: string;
    activitySourceId: string | null;
    rawHash: string | null;
  },
): Promise<void> {
  await database.run(
    `INSERT INTO training_metric_observations
      (observation_id, provider, metric_name, sport, observed_at, value_number, value_text, unit, device_id, dimensions_json, source_type, source_remote_id, activity_source_id, raw_object_hash)
     VALUES ($observationId, 'garmin', $metricName, $sport, $observedAt, $value, $valueText, $unit, $deviceId, $dimensions, $sourceType, $sourceRemoteId, $activitySourceId, $rawHash)
     ON CONFLICT (observation_id) DO UPDATE SET
       sport = excluded.sport, observed_at = excluded.observed_at, value_number = excluded.value_number, value_text = excluded.value_text,
       unit = excluded.unit, device_id = excluded.device_id, dimensions_json = excluded.dimensions_json,
       source_type = excluded.source_type, source_remote_id = excluded.source_remote_id,
       activity_source_id = excluded.activity_source_id, raw_object_hash = excluded.raw_object_hash`,
    { ...values, value: values.value ?? null, valueText: values.valueText ?? null, unit: values.unit ?? null, deviceId: values.deviceId ?? null, dimensions: json(values.dimensions ?? {}) },
  );
}

async function importGarminCyclingFtpFromActivity(database: CatenceDatabase, remoteId: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const fields = activityFields('garmin', payload);
  const value = firstNumber(payload, ['maxFtp']);
  if (value === null || !fields.startAtUtc || !isCyclingSport(fields.sport)) return;
  await upsertTrainingMetricObservation(database, {
    observationId: `garmin:cycling_ftp:activity:${remoteId}`,
    metricName: 'cycling_ftp_w', sport: fields.sport ?? 'cycling', observedAt: fields.startAtUtc, value,
    sourceType: 'activity_summary', sourceRemoteId: remoteId, activitySourceId: providerActivityId('garmin', remoteId), rawHash,
  });
}

async function importGarminCyclingFtp(database: CatenceDatabase, remoteId: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const sport = firstString(payload, ['sport']);
  const observedAt = firstString(payload, ['calendarDate']);
  const value = firstNumber(payload, ['functionalThresholdPower']);
  if (sport?.toUpperCase() !== 'CYCLING' || !observedAt || value === null) return;
  await upsertTrainingMetricObservation(database, {
    observationId: `garmin:cycling_ftp:source:${remoteId}`,
    metricName: 'cycling_ftp_w', sport: 'cycling', observedAt, value,
    sourceType: 'cycling_ftp', sourceRemoteId: remoteId, activitySourceId: null, rawHash,
  });
}

async function importGarminCyclingFtpHistory(database: CatenceDatabase, remoteId: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const sport = firstString(payload, ['sport', 'series']);
  const observedAt = datePart(firstString(payload, ['calendarDate', 'until', 'date', 'updatedDate', 'from']));
  const value = firstNumber(payload, ['functionalThresholdPower', 'value']);
  if (sport?.toUpperCase() !== 'CYCLING' || !observedAt || value === null) return;
  await upsertTrainingMetricObservation(database, {
    observationId: `garmin:cycling_ftp:history:${remoteId}`,
    metricName: 'cycling_ftp_w', sport: 'cycling', observedAt: `${observedAt}T00:00:00Z`, value,
    sourceType: 'cycling_ftp_history', sourceRemoteId: remoteId, activitySourceId: null, rawHash,
  });
}

function thresholdObservedAt(payload: JsonObject): string | null {
  return garminUtcTimestamp(firstString(payload, ['calendarDate', 'ftpCreateTime', 'weightCreateTime']));
}

async function importGarminLactateThreshold(database: CatenceDatabase, remoteId: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const speedAndHeartRate = nested(payload, 'speed_and_heart_rate');
  const power = nested(payload, 'power');
  const runningObservedAt = thresholdObservedAt(power) ?? thresholdObservedAt(speedAndHeartRate);
  const heartRateObservedAt = thresholdObservedAt(speedAndHeartRate) ?? runningObservedAt;
  const powerDimensions: JsonObject = {
    origin: firstString(power, ['origin']),
    isStale: typeof power.isStale === 'boolean' ? power.isStale : null,
    weightKg: firstNumber(power, ['weight']),
    powerToWeight: firstNumber(power, ['powerToWeight']),
    ftpCreateTime: firstString(power, ['ftpCreateTime']),
    weightCreateTime: firstString(power, ['weightCreateTime']),
  };
  const sourceType = 'lactate_threshold';
  const runningPower = firstNumber(power, ['functionalThresholdPower', 'value']);
  if (runningObservedAt && runningPower !== null) await upsertTrainingMetricObservation(database, {
    observationId: `garmin:lactate_threshold:${remoteId}:running_power`, metricName: 'running_lactate_threshold_power_w', sport: 'running',
    observedAt: runningObservedAt, value: runningPower, unit: 'W', dimensions: powerDimensions,
    sourceType, sourceRemoteId: remoteId, activitySourceId: null, rawHash,
  });
  const powerToWeight = firstNumber(power, ['powerToWeight']);
  if (runningObservedAt && powerToWeight !== null) await upsertTrainingMetricObservation(database, {
    observationId: `garmin:lactate_threshold:${remoteId}:running_power_to_weight`, metricName: 'running_lactate_threshold_power_w_kg', sport: 'running',
    observedAt: runningObservedAt, value: powerToWeight, unit: 'W/kg', dimensions: powerDimensions,
    sourceType, sourceRemoteId: remoteId, activitySourceId: null, rawHash,
  });
  const paceEncoding = firstNumber(speedAndHeartRate, ['speed']);
  // Garmin's threshold endpoint names this field `speed`, but its value is
  // minutes per 100 m (for example 0.4222 represents 4:13/km).
  if (heartRateObservedAt && paceEncoding !== null && paceEncoding > 0) await upsertTrainingMetricObservation(database, {
    observationId: `garmin:lactate_threshold:${remoteId}:running_pace`, metricName: 'running_lactate_threshold_pace_s_per_km', sport: 'running',
    observedAt: heartRateObservedAt, value: paceEncoding * 600, unit: 's/km', dimensions: { rawPaceEncoding: paceEncoding },
    sourceType, sourceRemoteId: remoteId, activitySourceId: null, rawHash,
  });
  const runningHeartRate = firstNumber(speedAndHeartRate, ['heartRate', 'hearRate']);
  if (heartRateObservedAt && runningHeartRate !== null) await upsertTrainingMetricObservation(database, {
    observationId: `garmin:lactate_threshold:${remoteId}:running_heart_rate`, metricName: 'running_lactate_threshold_hr_bpm', sport: 'running',
    observedAt: heartRateObservedAt, value: runningHeartRate, unit: 'bpm', sourceType, sourceRemoteId: remoteId, activitySourceId: null, rawHash,
  });
  const cyclingHeartRate = firstNumber(speedAndHeartRate, ['heartRateCycling']);
  if (heartRateObservedAt && cyclingHeartRate !== null) await upsertTrainingMetricObservation(database, {
    observationId: `garmin:lactate_threshold:${remoteId}:cycling_heart_rate`, metricName: 'cycling_lactate_threshold_hr_bpm', sport: 'cycling',
    observedAt: heartRateObservedAt, value: cyclingHeartRate, unit: 'bpm', sourceType, sourceRemoteId: remoteId, activitySourceId: null, rawHash,
  });
}

const NON_METRIC_KEYS = new Set(['id', 'userid', 'userprofilepk', 'deviceid', 'calendardate', 'date', 'timestamp', 'timestamplocal', 'starttime', 'endtime']);

function nested(payload: JsonObject, key: string): JsonObject {
  return object(payload[key]);
}

function metricObservedAt(occurredOn: string | null, payload: JsonObject): string | null {
  return firstTimestamp(payload, ['timestamp', 'timestampLocal', 'calendarDate', 'date']) ?? (occurredOn ? `${occurredOn}T00:00:00Z` : null);
}

async function importGarminActivityPerformance(database: CatenceDatabase, remoteId: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const fields = activityFields('garmin', payload);
  if (!fields.startAtUtc) return;
  for (const [metricName, keys, unit] of [
    ['aerobic_training_effect', ['aerobicTrainingEffect'], 'score'],
    ['anaerobic_training_effect', ['anaerobicTrainingEffect'], 'score'],
    ['recovery_time_min', ['recoveryTime'], 'min'],
    ['performance_condition', ['performanceCondition'], 'score'],
  ] as const) {
    const value = firstNumber(payload, keys);
    if (value === null) continue;
    await upsertTrainingMetricObservation(database, {
      observationId: `garmin:activity:${remoteId}:${metricName}`, metricName, sport: fields.sport ?? 'unknown',
      observedAt: fields.startAtUtc, value, unit, sourceType: 'activity_summary', sourceRemoteId: remoteId,
      activitySourceId: providerActivityId('garmin', remoteId), rawHash,
    });
  }
}

async function importGarminMaxMetrics(database: CatenceDatabase, remoteId: string, occurredOn: string | null, payload: JsonObject, rawHash: string | null): Promise<void> {
  for (const sport of ['generic', 'cycling']) {
    const values = nested(payload, sport);
    const observedAt = metricObservedAt(occurredOn, values);
    if (!observedAt) continue;
    const vo2 = firstNumber(values, ['vo2MaxPreciseValue', 'vo2MaxValue']);
    if (vo2 !== null) await upsertTrainingMetricObservation(database, {
      observationId: `garmin:max_metrics:${remoteId}:${sport}:vo2_max`, metricName: 'vo2_max_ml_kg_min', sport,
      observedAt, value: vo2, unit: 'ml/kg/min', sourceType: 'max_metrics', sourceRemoteId: remoteId, activitySourceId: null, rawHash,
    });
    const age = firstNumber(values, ['fitnessAge']);
    if (age !== null) await upsertTrainingMetricObservation(database, {
      observationId: `garmin:max_metrics:${remoteId}:${sport}:fitness_age`, metricName: 'fitness_age_years', sport,
      observedAt, value: age, unit: 'years', sourceType: 'max_metrics', sourceRemoteId: remoteId, activitySourceId: null, rawHash,
    });
  }
  const acclimation = nested(payload, 'heatAltitudeAcclimation');
  const observedAt = metricObservedAt(occurredOn, acclimation);
  if (!observedAt) return;
  for (const [metricName, keys, unit] of [
    ['heat_acclimation_pct', ['heatAcclimationPercentage', 'acclimationPercentage'], '%'],
    ['altitude_acclimation_pct', ['altitudeAcclimation'], '%'],
    ['altitude_m', ['currentAltitude'], 'm'],
  ] as const) {
    const value = firstNumber(acclimation, keys);
    if (value !== null) await upsertTrainingMetricObservation(database, {
      observationId: `garmin:max_metrics:${remoteId}:acclimation:${metricName}`, metricName, sport: 'generic', observedAt,
      value, unit, sourceType: 'max_metrics', sourceRemoteId: remoteId, activitySourceId: null, rawHash,
    });
  }
}

async function importGarminFitnessAge(database: CatenceDatabase, remoteId: string, occurredOn: string | null, payload: JsonObject, rawHash: string | null): Promise<void> {
  const observedAt = metricObservedAt(occurredOn, payload);
  const value = firstNumber(payload, ['fitnessAge', 'fitnessAgeValue']);
  if (!observedAt || value === null) return;
  await upsertTrainingMetricObservation(database, {
    observationId: `garmin:fitness_age:${remoteId}`, metricName: 'fitness_age_years', sport: 'generic', observedAt,
    value, unit: 'years', sourceType: 'fitness_age', sourceRemoteId: remoteId, activitySourceId: null, rawHash,
  });
}

function leaves(value: unknown, prefix = '', depth = 0): Array<{ path: string; number?: number; text?: string }> {
  if (depth > 4) return [];
  if (typeof value === 'number' && Number.isFinite(value)) return [{ path: prefix, number: value }];
  if (typeof value === 'string' && value.length > 0) return [{ path: prefix, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, `${prefix}_${index}`, depth + 1));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as JsonObject).flatMap(([key, item]) => {
    const normalized = snake(key);
    if (NON_METRIC_KEYS.has(normalized)) return [];
    return leaves(item, prefix ? `${prefix}_${normalized}` : normalized, depth + 1);
  });
}

async function importGarminNumericSeries(database: CatenceDatabase, entityType: string, remoteId: string, occurredOn: string | null, payload: JsonObject, rawHash: string | null): Promise<void> {
  const observedAt = metricObservedAt(occurredOn, payload);
  if (!observedAt) return;
  const sport = firstString(payload, ['sport', 'fitnessTrendSport']) ?? 'generic';
  const deviceId = firstString(payload, ['deviceId']);
  for (const leaf of leaves(payload)) {
    if (leaf.number === undefined && leaf.text === undefined) continue;
    await upsertTrainingMetricObservation(database, {
      observationId: `garmin:${entityType}:${remoteId}:${leaf.path}`, metricName: `${entityType}_${leaf.path}`,
      sport, observedAt, value: leaf.number, valueText: leaf.text, unit: null, deviceId,
      sourceType: entityType, sourceRemoteId: remoteId, activitySourceId: null, rawHash,
    });
  }
}

async function importGarminTrainingStatus(database: CatenceDatabase, remoteId: string, occurredOn: string | null, payload: JsonObject, rawHash: string | null): Promise<void> {
  const statusMap = nested(nested(payload, 'mostRecentTrainingStatus'), 'latestTrainingStatusData');
  const balanceMap = nested(nested(payload, 'mostRecentTrainingLoadBalance'), 'metricsTrainingLoadBalanceDTOMap');
  for (const [deviceId, values] of Object.entries(statusMap)) {
    const item = object(values);
    await importGarminNumericSeries(database, 'training_status', `${remoteId}:${deviceId}`, occurredOn, { ...item, deviceId }, rawHash);
  }
  for (const [deviceId, values] of Object.entries(balanceMap)) {
    const item = object(values);
    await importGarminNumericSeries(database, 'training_load_balance', `${remoteId}:${deviceId}`, occurredOn, { ...item, deviceId }, rawHash);
  }
}

async function importHealthSession(database: CatenceDatabase, remoteId: string, occurredOn: string | null, sessionType: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const startedAt = firstTimestamp(payload, ['sleepStartTimestampGMT', 'startTimestampGMT', 'eventStartTimeGmt', 'startTimeGMT']);
  const endedAt = firstTimestamp(payload, ['sleepEndTimestampGMT', 'endTimestampGMT', 'endTimeGMT']);
  await database.run(
    `INSERT INTO health_sessions (session_id, provider, session_type, occurred_on, started_at, ended_at, source_type, source_remote_id, payload_json, raw_object_hash)
     VALUES ($id, 'garmin', $type, $date, $startedAt, $endedAt, $sourceType, $remoteId, $payload, $rawHash)
     ON CONFLICT (session_id) DO UPDATE SET occurred_on = excluded.occurred_on, started_at = excluded.started_at, ended_at = excluded.ended_at,
       payload_json = excluded.payload_json, raw_object_hash = excluded.raw_object_hash`,
    { id: `garmin:${sessionType}:${remoteId}`, type: sessionType, date: occurredOn, startedAt, endedAt, sourceType: sessionType, remoteId, payload: json(payload), rawHash },
  );
}

async function importActivityPowerBest(database: CatenceDatabase, activityRemoteId: string | null, payload: JsonObject, rawHash: string | null): Promise<void> {
  const duration = firstNumber(payload, ['durationSeconds']);
  const bestPower = firstNumber(payload, ['bestPowerWatts']);
  if (!activityRemoteId || duration === null || bestPower === null) return;
  await database.run(
    `INSERT INTO activity_power_bests VALUES ('garmin', $activitySourceId, $duration, $bestPower, 'garmin_fit_derived', $rawHash)
     ON CONFLICT (provider, activity_source_id, duration_s) DO UPDATE SET best_power_w = excluded.best_power_w,
       source_type = excluded.source_type, raw_object_hash = excluded.raw_object_hash`,
    { activitySourceId: providerActivityId('garmin', activityRemoteId), duration: Math.round(duration), bestPower, rawHash },
  );
}

async function importWellnessSamples(database: CatenceDatabase, remoteId: string, metricName: string, unit: string, values: unknown, rawHash: string | null): Promise<void> {
  if (!Array.isArray(values)) return;
  for (const [index, entry] of values.entries()) {
    const row = Array.isArray(entry) ? entry : [];
    const item = object(entry);
    const observedAt = timestamp(row[0] ?? item.timestamp ?? item.time ?? item.startTimestampGMT);
    const value = typeof row[1] === 'number' ? row[1] : firstNumber(item, ['value', 'heartRate', 'stress', 'bodyBattery']);
    if (!observedAt || value === null) continue;
    await database.run(
      `INSERT INTO wellness_samples VALUES ($id, 'garmin', $metricName, $observedAt, $value, $unit, $sourceType, $remoteId, $rawHash)
       ON CONFLICT (sample_id) DO UPDATE SET value_number = excluded.value_number, unit = excluded.unit, raw_object_hash = excluded.raw_object_hash`,
      { id: `garmin:${remoteId}:${metricName}:${observedAt}:${index}`, metricName, observedAt, value, unit, sourceType: metricName, remoteId, rawHash },
    );
  }
}

type SwimSetInput = {
  sourceType: 'garmin_detected' | 'intervals_auto';
  setIndex: number;
  label: string | null;
  reps: number | null;
  repDistanceM: number | null;
  totalDistanceM: number | null;
  workS: number | null;
  restS: number | null;
  avgPace: number | null;
  avgHr: number | null;
  maxHr: number | null;
  strokeRate: number | null;
  metrics: JsonObject;
};

async function upsertSwimSet(database: CatenceDatabase, activitySourceId: string, input: SwimSetInput, rawHash: string | null): Promise<void> {
  await database.run(
    `INSERT INTO swim_sets
      (activity_source_id, source_type, set_index, label, reps, rep_distance_m, total_distance_m, work_s, rest_s, avg_pace, avg_hr, max_hr, stroke_rate, metrics_json, raw_object_hash)
     VALUES ($activitySourceId, $sourceType, $setIndex, $label, $reps, $repDistanceM, $totalDistanceM, $workS, $restS, $avgPace, $avgHr, $maxHr, $strokeRate, $metrics, $rawHash)
     ON CONFLICT (activity_source_id, source_type, set_index) DO UPDATE SET
       label = excluded.label, reps = excluded.reps, rep_distance_m = excluded.rep_distance_m,
       total_distance_m = excluded.total_distance_m, work_s = excluded.work_s, rest_s = excluded.rest_s,
       avg_pace = excluded.avg_pace, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr,
       stroke_rate = excluded.stroke_rate, metrics_json = excluded.metrics_json, raw_object_hash = excluded.raw_object_hash`,
    { activitySourceId, ...input, metrics: json(input.metrics), rawHash },
  );
}

async function upsertActivityInterval(database: CatenceDatabase, activitySourceId: string, values: {
  key: string;
  label: string | null;
  startS: number | null;
  endS: number | null;
  distanceM: number | null;
  avgPower: number | null;
  avgHr: number | null;
  avgPace: number | null;
  intensity: number | null;
  durationS: number | null;
  movingS: number | null;
  sourceType: string;
  metrics: JsonObject;
}): Promise<void> {
  await database.run(
    `INSERT INTO activity_intervals
      (activity_source_id, interval_key, label, start_s, end_s, distance_m, avg_power, avg_hr, avg_pace, intensity, metrics_json, duration_s, moving_s, source_type)
     VALUES ($activitySourceId, $key, $label, $startS, $endS, $distanceM, $avgPower, $avgHr, $avgPace, $intensity, $metrics, $durationS, $movingS, $sourceType)
     ON CONFLICT (activity_source_id, interval_key) DO UPDATE SET
       label = excluded.label, start_s = excluded.start_s, end_s = excluded.end_s,
       distance_m = excluded.distance_m, avg_power = excluded.avg_power, avg_hr = excluded.avg_hr,
       avg_pace = excluded.avg_pace, intensity = excluded.intensity, metrics_json = excluded.metrics_json,
       duration_s = excluded.duration_s, moving_s = excluded.moving_s, source_type = excluded.source_type`,
    { activitySourceId, ...values, metrics: json(values.metrics) },
  );
}

function parseIntervalsAutoBlock(value: unknown): { rawLabel: string; reps: number; repDistanceM: number; avgHr: number | null } | null {
  if (typeof value !== 'string') return null;
  const rawLabel = value.trim();
  const match = rawLabel.replaceAll('×', 'x').match(/^(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*m(?:\s+(\d+(?:\.\d+)?)\s*bpm)?$/i);
  if (!match) return null;
  const reps = Number(match[1]);
  const repDistanceM = Number(match[2]);
  const avgHr = match[3] ? Number(match[3]) : null;
  if (!Number.isInteger(reps) || reps <= 0 || !Number.isFinite(repDistanceM) || repDistanceM <= 0 || (avgHr !== null && !Number.isFinite(avgHr))) return null;
  return { rawLabel, reps, repDistanceM, avgHr };
}

async function importIntervalsAutoSwimSets(database: CatenceDatabase, remoteId: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const blocks = Array.isArray(payload.interval_summary) ? payload.interval_summary : [];
  if (blocks.length === 0) return;
  const activitySourceId = providerActivityId('intervals', remoteId);
  await database.run("DELETE FROM swim_sets WHERE activity_source_id = $activitySourceId AND source_type = 'intervals_auto'", { activitySourceId });
  await database.run("DELETE FROM activity_intervals WHERE activity_source_id = $activitySourceId AND source_type = 'intervals_auto'", { activitySourceId });
  for (const [index, block] of blocks.entries()) {
    const parsed = parseIntervalsAutoBlock(block);
    if (!parsed) continue;
    const totalDistanceM = parsed.reps * parsed.repDistanceM;
    const metrics = { rawLabel: parsed.rawLabel, providerGrouping: 'intervals_auto' };
    await upsertSwimSet(database, activitySourceId, {
      sourceType: 'intervals_auto', setIndex: index, label: parsed.rawLabel,
      reps: parsed.reps, repDistanceM: parsed.repDistanceM, totalDistanceM,
      workS: null, restS: null, avgPace: null, avgHr: parsed.avgHr, maxHr: null, strokeRate: null, metrics,
    }, rawHash);
    await upsertActivityInterval(database, activitySourceId, {
      key: `intervals:auto:${index}`, label: parsed.rawLabel,
      startS: null, endS: null, distanceM: totalDistanceM, avgPower: null, avgHr: parsed.avgHr,
      avgPace: null, intensity: null, durationS: null, movingS: null, sourceType: 'intervals_auto', metrics,
    });
  }
}

async function importGarminSplitSummaries(database: CatenceDatabase, parentRemoteId: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const summaries = objectArray(payload.splitSummaries);
  const activitySourceId = providerActivityId('garmin', parentRemoteId);
  await database.run("DELETE FROM swim_sets WHERE activity_source_id = $activitySourceId AND source_type = 'garmin_detected'", { activitySourceId });
  await database.run("DELETE FROM activity_intervals WHERE activity_source_id = $activitySourceId AND source_type = 'garmin_detected'", { activitySourceId });
  await database.run(`DELETE FROM activity_intervals
    WHERE activity_source_id = $activitySourceId AND source_type IS NULL
      AND start_s IS NULL AND end_s IS NULL AND duration_s IS NULL AND moving_s IS NULL
      AND distance_m IS NULL AND avg_power IS NULL AND avg_hr IS NULL AND avg_pace IS NULL AND intensity IS NULL`, { activitySourceId });
  for (const [index, summary] of summaries.entries()) {
    const label = firstString(summary, ['splitType', 'label', 'name']);
    const durationS = firstNumber(summary, ['duration', 'durationSeconds']);
    const movingS = firstNumber(summary, ['movingDuration', 'movingDurationSeconds']);
    const distanceM = firstNumber(summary, ['distance']);
    const avgHr = firstNumber(summary, ['averageHR', 'averageHeartRate']);
    const maxHr = firstNumber(summary, ['maxHR', 'maxHeartRate']);
    const metrics = { splitSummary: summary, providerGrouping: 'garmin_detected' };
    await upsertActivityInterval(database, activitySourceId, {
      key: `garmin:split_summary:${index}`, label,
      startS: null, endS: null, distanceM, avgPower: null, avgHr, avgPace: null, intensity: null,
      durationS, movingS, sourceType: 'garmin_detected', metrics,
    });
    await upsertSwimSet(database, activitySourceId, {
      sourceType: 'garmin_detected', setIndex: index, label,
      reps: firstNumber(summary, ['noOfSplits', 'repetitions']), repDistanceM: null, totalDistanceM: distanceM,
      workS: movingS, restS: null, avgPace: null, avgHr, maxHr, strokeRate: null, metrics,
    }, rawHash);
  }
}

async function importActivityIntervals(database: CatenceDatabase, provider: Provider, parentRemoteId: string | null, payload: JsonObject, rawHash: string | null): Promise<void> {
  if (!parentRemoteId) return;
  if (provider === 'garmin' && Array.isArray(payload.splitSummaries)) {
    await importGarminSplitSummaries(database, parentRemoteId, payload, rawHash);
    return;
  }
  const activitySourceId = providerActivityId(provider, parentRemoteId);
  const key = firstString(payload, ['id', 'intervalId', 'start_index']) ?? crypto.randomUUID();
  await upsertActivityInterval(database, activitySourceId, {
    key, label: firstString(payload, ['label', 'name']),
    startS: firstNumber(payload, ['start_secs', 'start_time', 'start_index']), endS: firstNumber(payload, ['end_secs', 'end_time', 'end_index']),
    distanceM: firstNumber(payload, ['distance']), avgPower: firstNumber(payload, ['average_watts', 'averagePower']),
    avgHr: firstNumber(payload, ['average_heartrate', 'averageHR']), avgPace: firstNumber(payload, ['average_pace']),
    intensity: firstNumber(payload, ['intensity']), durationS: firstNumber(payload, ['duration', 'durationSeconds']),
    movingS: firstNumber(payload, ['movingDuration', 'moving_time']), sourceType: `${provider}_interval`, metrics: payload,
  });
}

async function activityPoolLengthM(database: CatenceDatabase, activitySourceId: string): Promise<number | null> {
  const rows = await database.rows<{ metrics_json: unknown }>('SELECT metrics_json FROM activity_summaries WHERE activity_source_id = $activitySourceId', { activitySourceId });
  return garminPoolLengthM(objectFromJson(rows[0]?.metrics_json));
}

async function importGarminExplicitSwimLengths(database: CatenceDatabase, parentRemoteId: string | null, entityType: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  if (!parentRemoteId) return;
  const activitySourceId = providerActivityId('garmin', parentRemoteId);
  const summaryPoolLengthM = await activityPoolLengthM(database, activitySourceId);
  for (const field of ['lengths', 'swimLengths', 'lengthSummaries'] as const) {
    const lengths = objectArray(payload[field]);
    if (lengths.length === 0) continue;
    const source = `garmin_provider_length:${entityType}:${field}`;
    await database.run('DELETE FROM swim_lengths WHERE activity_source_id = $activitySourceId AND source = $source', { activitySourceId, source });
    for (const [offset, length] of lengths.entries()) {
      const durationS = firstNumber(length, ['duration', 'durationSeconds', 'elapsedDuration']);
      const distanceM = firstNumber(length, ['distance', 'distanceM']);
      // The provider has to explicitly label this object as a length and give
      // at least duration or distance. We never derive lengths from samples.
      if (durationS === null && distanceM === null) continue;
      const sourceLabel = swimSourceLabel(length);
      const isRest = firstBoolean(length, ['isRest', 'rest']) ?? Boolean(sourceLabel && /rest|idle|pause/.test(sourceLabel));
      const lengthIndex = Math.round(firstNumber(length, ['lengthIndex', 'lengthNumber', 'index']) ?? offset);
      await database.run(
        `INSERT INTO swim_lengths
          (activity_source_id, source, length_index, lap_index, pool_length_m, start_time, duration_s, active_duration_s, distance_m, stroke_count, stroke_rate, swolf, avg_hr, max_hr, is_rest, confidence, metrics_json, raw_object_hash)
         VALUES ($activitySourceId, $source, $lengthIndex, $lapIndex, $poolLengthM, $startTime, $durationS, $activeDurationS, $distanceM, $strokeCount, $strokeRate, $swolf, $avgHr, $maxHr, $isRest, 'provider_supplied', $metrics, $rawHash)
         ON CONFLICT (activity_source_id, source, length_index) DO UPDATE SET
           lap_index = excluded.lap_index, pool_length_m = excluded.pool_length_m, start_time = excluded.start_time,
           duration_s = excluded.duration_s, active_duration_s = excluded.active_duration_s, distance_m = excluded.distance_m,
           stroke_count = excluded.stroke_count, stroke_rate = excluded.stroke_rate, swolf = excluded.swolf,
           avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, is_rest = excluded.is_rest,
           confidence = excluded.confidence, metrics_json = excluded.metrics_json, raw_object_hash = excluded.raw_object_hash`,
        {
          activitySourceId, source, lengthIndex,
          lapIndex: firstNumber(length, ['lapIndex', 'lapNumber']), poolLengthM: garminPoolLengthM(length) ?? summaryPoolLengthM,
          startTime: timestamp(length.startTime ?? length.startTimestamp ?? length.timestamp), durationS,
          activeDurationS: firstNumber(length, ['activeDuration', 'movingDuration']), distanceM,
          strokeCount: firstNumber(length, ['strokeCount', 'strokes']), strokeRate: firstNumber(length, ['strokeRate', 'averageStrokeRate', 'cadence']),
          swolf: firstNumber(length, ['swolf']), avgHr: firstNumber(length, ['averageHR', 'avgHr']), maxHr: firstNumber(length, ['maxHR', 'maxHr']),
          isRest, metrics: json(length), rawHash,
        },
      );
    }
  }
}

type ActivityQualityRow = {
  activity_source_id: string;
  provider: string;
  raw_object_hash: string | null;
  sport: string | null;
  distance_m: number | null;
  moving_s: number | null;
  elapsed_s: number | null;
  metrics_json: unknown;
};

async function addActivityQualityFlag(database: CatenceDatabase, activitySourceId: string, code: string, severity: 'info' | 'warning', details: JsonObject, rawHash: string | null): Promise<void> {
  await database.run(
    `INSERT INTO activity_quality_flags (activity_source_id, flag_code, severity, details_json, raw_object_hash)
     VALUES ($activitySourceId, $code, $severity, $details, $rawHash)
     ON CONFLICT (activity_source_id, flag_code) DO UPDATE SET
       severity = excluded.severity, details_json = excluded.details_json, raw_object_hash = excluded.raw_object_hash`,
    { activitySourceId, code, severity, details: json(details), rawHash },
  );
}

/** Re-evaluate source quality whenever an activity is imported or linked. */
export async function refreshActivityQuality(database: CatenceDatabase, activityId: string): Promise<void> {
  const sources = await database.rows<ActivityQualityRow>(`
    SELECT source.activity_source_id, source.provider, source.raw_object_hash, activity.sport,
      summary.distance_m, summary.moving_s, summary.elapsed_s, summary.metrics_json
    FROM activity_sources AS source
    JOIN activities AS activity USING (activity_id)
    LEFT JOIN activity_summaries AS summary USING (activity_source_id)
    WHERE source.activity_id = $activityId
  `, { activityId });
  if (sources.length === 0) return;
  await database.run('DELETE FROM activity_quality_flags WHERE activity_source_id IN (SELECT activity_source_id FROM activity_sources WHERE activity_id = $activityId)', { activityId });

  for (const source of sources) {
    if (source.provider !== 'garmin' || source.sport?.toLowerCase() !== 'lap_swimming') continue;
    const metrics = objectFromJson(source.metrics_json);
    const poolLengthM = garminPoolLengthM(metrics);
    if (poolLengthM !== null && (poolLengthM < 15 || poolLengthM > 100)) {
      await addActivityQualityFlag(database, source.activity_source_id, 'pool_length_implausible', 'warning', { poolLengthM }, source.raw_object_hash);
    }
    const averageSpeedMps = firstNumber(metrics, ['averageSpeed']);
    const strokeCadenceSpm = firstNumber(metrics, ['averageSwimCadenceInStrokesPerMinute']);
    const durationS = Math.max(source.moving_s ?? 0, source.elapsed_s ?? 0);
    if (durationS >= 900 && averageSpeedMps === 0 && strokeCadenceSpm === 0) {
      await addActivityQualityFlag(database, source.activity_source_id, 'zero_swim_speed_and_cadence', 'warning', {
        averageSpeedMps, strokeCadenceSpm, durationS,
      }, source.raw_object_hash);
    }
    const activeLengths = firstNumber(metrics, ['activeLengths']);
    if (poolLengthM !== null && activeLengths !== null && activeLengths > 0 && source.distance_m !== null && source.distance_m > 0) {
      const expectedDistanceM = activeLengths * poolLengthM;
      if (Math.abs(expectedDistanceM - source.distance_m) > Math.max(poolLengthM, expectedDistanceM * 0.02)) {
        await addActivityQualityFlag(database, source.activity_source_id, 'active_lengths_distance_mismatch', 'warning', {
          activeLengths, poolLengthM, expectedDistanceM, summaryDistanceM: source.distance_m,
        }, source.raw_object_hash);
      }
    }
    const lengths = await database.rows<{ count: number | bigint }>('SELECT count(*) AS count FROM swim_lengths WHERE activity_source_id = $activitySourceId', { activitySourceId: source.activity_source_id });
    if (Number(lengths[0]?.count ?? 0) === 0) {
      await addActivityQualityFlag(database, source.activity_source_id, 'swim_length_data_unavailable', 'info', {
        reason: 'No explicit provider-supplied per-length records were imported.',
      }, source.raw_object_hash);
    }
  }

  const garmin = sources.find((source) => source.provider === 'garmin' && source.distance_m !== null);
  const intervals = sources.find((source) => source.provider === 'intervals' && source.distance_m !== null);
  if (!garmin || !intervals || garmin.distance_m === null || intervals.distance_m === null) return;
  const differenceM = Math.abs(garmin.distance_m - intervals.distance_m);
  const toleranceM = Math.max(50, garmin.distance_m * 0.05);
  if (differenceM <= toleranceM) return;
  for (const source of [garmin, intervals]) {
    await addActivityQualityFlag(database, source.activity_source_id, 'provider_distance_disagreement', 'warning', {
      garminDistanceM: garmin.distance_m, intervalsDistanceM: intervals.distance_m, differenceM, toleranceM,
    }, source.raw_object_hash);
  }
}

async function importGarminDailyDetails(database: CatenceDatabase, remoteId: string, metricDate: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const hrv = nested(payload, 'hrvSummary');
  for (const [metricName, keys, unit] of [
    ['hrv_ms', ['lastNightAvg'], 'ms'], ['hrv_weekly_avg_ms', ['weeklyAvg'], 'ms'], ['hrv_last_night_high_ms', ['lastNight5MinHigh'], 'ms'],
  ] as const) {
    const value = firstNumber(hrv, keys);
    if (value !== null) await upsertDailyMetric(database, 'garmin', metricDate, metricName, value, null, unit, rawHash);
  }
  const hrvStatus = firstString(hrv, ['status', 'feedbackPhrase']);
  if (hrvStatus) await upsertDailyMetric(database, 'garmin', metricDate, 'hrv_status', null, hrvStatus, null, rawHash);
  await importWellnessSamples(database, remoteId, 'hrv_ms', 'ms', payload.hrvReadings, rawHash);
  await importWellnessSamples(database, remoteId, 'heart_rate_bpm', 'bpm', payload.heartRateValues, rawHash);
  await importWellnessSamples(database, remoteId, 'stress', 'score', payload.stressValuesArray, rawHash);
  await importWellnessSamples(database, remoteId, 'body_battery', 'score', payload.bodyBatteryValuesArray, rawHash);

  const sleep = nested(payload, 'dailySleepDTO');
  if (Object.keys(sleep).length) {
    for (const metric of dailyMetricMap) {
      const value = firstNumber(sleep, metric.keys);
      if (value !== null) await upsertDailyMetric(database, 'garmin', metricDate, metric.name, value, null, metric.unit, rawHash);
    }
    await importHealthSession(database, remoteId, metricDate, 'sleep', { ...payload, ...sleep }, rawHash);
  }

  if (payload.event && typeof payload.event === 'object') await importHealthSession(database, remoteId, metricDate, 'body_battery_event', payload, rawHash);
  if (payload.inputContext || payload.trainingReadinessScore !== undefined || (payload.score !== undefined && payload.recoveryTime !== undefined)) {
    const observedAt = metricObservedAt(metricDate, payload) ?? `${metricDate}T00:00:00Z`;
    const deviceId = firstString(payload, ['deviceId']);
    for (const leaf of leaves(payload)) {
      if (leaf.number === undefined && leaf.text === undefined) continue;
      await upsertTrainingMetricObservation(database, {
        observationId: `garmin:training_readiness:${remoteId}:${leaf.path}`, metricName: `training_readiness_${leaf.path}`,
        sport: 'generic', observedAt, value: leaf.number, valueText: leaf.text, unit: null, deviceId,
        sourceType: 'training_readiness', sourceRemoteId: remoteId, activitySourceId: null, rawHash,
      });
    }
  }
}

async function importDailyMetrics(database: CatenceDatabase, provider: Provider, remoteId: string, date: string | null, payload: JsonObject, rawHash: string | null): Promise<void> {
  const metricDate = datePart(date) ?? datePart(firstString(payload, ['id', 'date', 'calendarDate'])) ?? null;
  if (!metricDate) return;
  for (const metric of dailyMetricMap) {
    const value = firstNumber(payload, metric.keys);
    if (value === null) continue;
    await upsertDailyMetric(database, provider, metricDate, metric.name, value, null, metric.unit, rawHash);
  }
  if (provider === 'garmin') await importGarminDailyDetails(database, remoteId, metricDate, payload, rawHash);
}

async function importNutrition(database: CatenceDatabase, provider: Provider, date: string | null, remoteId: string, payload: JsonObject, rawHash: string | null): Promise<void> {
  const nutritionDate = datePart(date) ?? datePart(firstString(payload, ['id', 'date', 'calendarDate'])) ?? null;
  if (!nutritionDate) return;
  const fields = nutritionFields(payload);
  await database.run(
    `INSERT INTO nutrition_days
      (provider, nutrition_date, energy_kcal, carbohydrates_g, protein_g, fat_g, hydration_ml, metrics_json, raw_object_hash)
      VALUES ($provider, $nutritionDate, $energyKcal, $carbohydratesG, $proteinG, $fatG, $hydrationMl, $metrics, $rawHash)
      ON CONFLICT (provider, nutrition_date) DO UPDATE SET energy_kcal = excluded.energy_kcal, carbohydrates_g = excluded.carbohydrates_g,
       protein_g = excluded.protein_g, fat_g = excluded.fat_g, hydration_ml = excluded.hydration_ml, metrics_json = excluded.metrics_json, raw_object_hash = excluded.raw_object_hash`,
    { provider, nutritionDate, ...fields, metrics: json(payload), rawHash },
  );
  for (const [index, item] of nutritionItems(payload).entries()) {
    const itemFields = nutritionFields(item);
    const itemId = firstString(item, ['id', 'foodId', 'entryId']) ?? `${remoteId}:${index}`;
    await database.run(
      `INSERT INTO nutrition_items
       (provider, remote_item_id, nutrition_date, meal, consumed_at, food_name, quantity, energy_kcal, carbohydrates_g, protein_g, fat_g, payload_json, raw_object_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, remote_item_id) DO UPDATE SET nutrition_date = excluded.nutrition_date, meal = excluded.meal,
       consumed_at = excluded.consumed_at, food_name = excluded.food_name, quantity = excluded.quantity, energy_kcal = excluded.energy_kcal,
       carbohydrates_g = excluded.carbohydrates_g, protein_g = excluded.protein_g, fat_g = excluded.fat_g, payload_json = excluded.payload_json,
       raw_object_hash = excluded.raw_object_hash`,
      [
        provider, itemId, nutritionDate, firstString(item, ['meal', 'mealName']), firstString(item, ['consumedAt', 'dateTime']),
        firstString(item, ['foodName', 'name', 'description']), firstNumber(item, ['quantity', 'amount']),
        itemFields.energyKcal, itemFields.carbohydratesG, itemFields.proteinG, itemFields.fatG, json(item), rawHash,
      ],
    );
  }
}
