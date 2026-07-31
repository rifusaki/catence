import type { CatenceDatabase } from '../storage/database.js';
import { json } from '../storage/sql.js';
import type { Provider, SourceEntity } from '../../contracts/staging.js';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function firstString(payload: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function firstNumber(payload: JsonObject, keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
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
  return {
    startAtUtc: firstString(source, intervals ? ['start_date'] : ['startTimeGMT', 'startTimeLocal']),
    startAtLocal: firstString(source, intervals ? ['start_date_local', 'start_date'] : ['startTimeLocal', 'startTimeGMT']),
    timezone: firstString(source, intervals ? ['timezone'] : ['timeZoneUnitDTO']),
    sport: intervals
      ? firstString(source, ['type'])
      : firstString(object(source.activityTypeDTO), ['typeKey']) ?? firstString(source, ['activityType', 'activityTypeKey']),
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
      trainingLoad: firstNumber(source, intervals ? ['icu_training_load', 'power_load', 'hr_load'] : ['trainingEffect']),
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
];

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

  if (entity.entityType === 'activity') await importActivity(database, entity.provider, entity.remoteId, payload, rawHash);
  if (entity.entityType === 'activity_interval') await importActivityIntervals(database, entity.provider, entity.parentRemoteId, payload, rawHash);
  if (entity.entityType === 'wellness' || entity.entityType === 'daily_health') await importDailyMetrics(database, entity.provider, entity.occurredOn, payload, rawHash);
  if (entity.entityType === 'nutrition_day' || entity.entityType === 'nutrition_log') await importNutrition(database, entity.provider, entity.occurredOn, entity.remoteId, payload, rawHash);
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

async function importActivityIntervals(database: CatenceDatabase, provider: Provider, parentRemoteId: string | null, payload: JsonObject, _rawHash: string | null): Promise<void> {
  if (!parentRemoteId) return;
  const activitySourceId = providerActivityId(provider, parentRemoteId);
  const key = firstString(payload, ['id', 'intervalId', 'start_index']) ?? crypto.randomUUID();
  await database.run(
    `INSERT INTO activity_intervals
      (activity_source_id, interval_key, label, start_s, end_s, distance_m, avg_power, avg_hr, avg_pace, intensity, metrics_json)
      VALUES ($activitySourceId, $key, $label, $startS, $endS, $distanceM, $avgPower, $avgHr, $avgPace, $intensity, $metrics)
      ON CONFLICT (activity_source_id, interval_key) DO UPDATE SET label = excluded.label, start_s = excluded.start_s,
        end_s = excluded.end_s, distance_m = excluded.distance_m, avg_power = excluded.avg_power, avg_hr = excluded.avg_hr,
        avg_pace = excluded.avg_pace, intensity = excluded.intensity, metrics_json = excluded.metrics_json`,
    {
      activitySourceId, key, label: firstString(payload, ['label', 'name']),
      startS: firstNumber(payload, ['start_secs', 'start_time', 'start_index']), endS: firstNumber(payload, ['end_secs', 'end_time', 'end_index']),
      distanceM: firstNumber(payload, ['distance']), avgPower: firstNumber(payload, ['average_watts', 'averagePower']),
      avgHr: firstNumber(payload, ['average_heartrate', 'averageHR']), avgPace: firstNumber(payload, ['average_pace']),
      intensity: firstNumber(payload, ['intensity']), metrics: json(payload),
    },
  );
}

async function importDailyMetrics(database: CatenceDatabase, provider: Provider, date: string | null, payload: JsonObject, rawHash: string | null): Promise<void> {
  const metricDate = datePart(date) ?? datePart(firstString(payload, ['id', 'date', 'calendarDate'])) ?? null;
  if (!metricDate) return;
  for (const metric of dailyMetricMap) {
    const value = firstNumber(payload, metric.keys);
    if (value === null) continue;
    await database.run(
      `INSERT INTO daily_metrics VALUES ($provider, $metricDate, $metricName, $valueNumber, NULL, $unit, $rawHash)
       ON CONFLICT (provider, metric_date, metric_name) DO UPDATE SET value_number = excluded.value_number, value_text = excluded.value_text,
       unit = excluded.unit, raw_object_hash = excluded.raw_object_hash`,
      { provider, metricDate, metricName: metric.name, valueNumber: value, unit: metric.unit, rawHash },
    );
  }
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
