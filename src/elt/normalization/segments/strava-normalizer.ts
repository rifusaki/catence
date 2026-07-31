import type { CatenceDatabase } from '../../storage/database.js';
import type { SourceEntity } from '../../../contracts/staging.js';
import { json } from '../../storage/sql.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const dateOnly = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

async function storeGenericEntity(database: CatenceDatabase, entity: SourceEntity, payload: ObjectValue): Promise<void> {
  await database.run(`INSERT INTO source_entities (provider, entity_type, remote_id, parent_remote_id, occurred_on, source_updated_at, raw_object_hash, payload_json, extension_json)
    VALUES ('strava', $entityType, $remoteId, $parentRemoteId, $occurredOn, $sourceUpdatedAt, $rawHash, $payload, $extension)
    ON CONFLICT (provider, entity_type, remote_id) DO UPDATE SET parent_remote_id = excluded.parent_remote_id, occurred_on = excluded.occurred_on, source_updated_at = excluded.source_updated_at, raw_object_hash = excluded.raw_object_hash, payload_json = excluded.payload_json, extension_json = excluded.extension_json, normalized_at = now()`,
    { entityType: entity.entityType, remoteId: entity.remoteId, parentRemoteId: entity.parentRemoteId, occurredOn: entity.occurredOn, sourceUpdatedAt: entity.sourceUpdatedAt, rawHash: entity.rawObjectHash, payload: json(payload), extension: json(entity.extension) });
  await database.run(`INSERT INTO domain_entities (provider, entity_type, remote_id, parent_remote_id, occurred_on, payload_json, extension_json, raw_object_hash)
    VALUES ('strava', $entityType, $remoteId, $parentRemoteId, $occurredOn, $payload, $extension, $rawHash)
    ON CONFLICT (provider, entity_type, remote_id) DO UPDATE SET parent_remote_id = excluded.parent_remote_id, occurred_on = excluded.occurred_on, payload_json = excluded.payload_json, extension_json = excluded.extension_json, raw_object_hash = excluded.raw_object_hash`,
    { entityType: entity.entityType, remoteId: entity.remoteId, parentRemoteId: entity.parentRemoteId, occurredOn: entity.occurredOn, rawHash: entity.rawObjectHash, payload: json(payload), extension: json(entity.extension) });
}

/** Persist richer segment facts without letting a sparse embedded history effort erase them. */
async function upsertSegment(database: CatenceDatabase, source: ObjectValue, rawHash: string | null): Promise<void> {
  const segmentId = text(source.id);
  if (!segmentId) return;
  const hasDescriptiveFacts = text(source.name) !== null || typeof source.starred === 'boolean' || number(source.average_grade) !== null || number(source.distance) !== null;
  await database.run(`INSERT INTO strava_segments (segment_id, name, activity_type, distance_m, average_grade_pct, maximum_grade_pct, climb_category, elevation_high_m, elevation_low_m, total_elevation_gain_m, private, hazardous, starred, raw_object_hash, payload_json)
    VALUES ($segmentId, $name, $activityType, $distanceM, $averageGrade, $maximumGrade, $climbCategory, $elevationHigh, $elevationLow, $elevationGain, $private, $hazardous, $starred, $rawHash, $payload)
    ON CONFLICT (segment_id) DO UPDATE SET
      name = COALESCE(excluded.name, strava_segments.name),
      activity_type = COALESCE(excluded.activity_type, strava_segments.activity_type),
      distance_m = COALESCE(excluded.distance_m, strava_segments.distance_m),
      average_grade_pct = COALESCE(excluded.average_grade_pct, strava_segments.average_grade_pct),
      maximum_grade_pct = COALESCE(excluded.maximum_grade_pct, strava_segments.maximum_grade_pct),
      climb_category = COALESCE(excluded.climb_category, strava_segments.climb_category),
      elevation_high_m = COALESCE(excluded.elevation_high_m, strava_segments.elevation_high_m),
      elevation_low_m = COALESCE(excluded.elevation_low_m, strava_segments.elevation_low_m),
      total_elevation_gain_m = COALESCE(excluded.total_elevation_gain_m, strava_segments.total_elevation_gain_m),
      private = COALESCE(excluded.private, strava_segments.private),
      hazardous = COALESCE(excluded.hazardous, strava_segments.hazardous),
      starred = COALESCE(excluded.starred, strava_segments.starred),
      raw_object_hash = CASE WHEN $hasDescriptiveFacts THEN excluded.raw_object_hash ELSE strava_segments.raw_object_hash END,
      payload_json = CASE WHEN $hasDescriptiveFacts THEN excluded.payload_json ELSE strava_segments.payload_json END,
      updated_at = now()`,
    {
      segmentId, name: text(source.name), activityType: text(source.activity_type), distanceM: number(source.distance), averageGrade: number(source.average_grade), maximumGrade: number(source.maximum_grade), climbCategory: number(source.climb_category), elevationHigh: number(source.elevation_high), elevationLow: number(source.elevation_low), elevationGain: number(source.total_elevation_gain), private: typeof source.private === 'boolean' ? source.private : null, hazardous: typeof source.hazardous === 'boolean' ? source.hazardous : null, starred: typeof source.starred === 'boolean' ? source.starred : null, rawHash, payload: json(source), hasDescriptiveFacts,
    });
}

async function upsertEffort(database: CatenceDatabase, payload: ObjectValue, activitySourceId: string | null, rawHash: string | null, history: boolean): Promise<void> {
  const effortId = text(payload.id);
  const segment = object(payload.segment);
  const segmentId = text(segment.id) ?? text(payload.segment_id);
  if (!effortId || !segmentId) return;
  await upsertSegment(database, segment, rawHash);
  const values = {
    effortId, segmentId, elapsedS: number(payload.elapsed_time), movingS: number(payload.moving_time), distanceM: number(payload.distance), averageWatts: number(payload.average_watts), averageHr: number(payload.average_heartrate), maxHr: number(payload.max_heartrate), averageCadence: number(payload.average_cadence), deviceWatts: typeof payload.device_watts === 'boolean' ? payload.device_watts : null, prRank: number(payload.pr_rank), komRank: number(payload.kom_rank), startedAt: text(payload.start_date), rawHash, payload: json(payload),
  };
  if (activitySourceId) {
    await database.run(`INSERT INTO activity_segments VALUES ($activitySourceId, $effortId, $segmentId, $elapsedS, $movingS, $distanceM, $averageWatts, $averageHr, $maxHr, $averageCadence, $deviceWatts, $prRank, $komRank, $startedAt, $rawHash, $payload)
      ON CONFLICT (activity_source_id, effort_id) DO UPDATE SET segment_id = excluded.segment_id, elapsed_s = excluded.elapsed_s, moving_s = excluded.moving_s, distance_m = excluded.distance_m, average_watts = excluded.average_watts, average_hr = excluded.average_hr, max_hr = excluded.max_hr, average_cadence = excluded.average_cadence, device_watts = excluded.device_watts, pr_rank = excluded.pr_rank, kom_rank = excluded.kom_rank, started_at = excluded.started_at, raw_object_hash = excluded.raw_object_hash, payload_json = excluded.payload_json`, { activitySourceId, ...values });
  }
  if (history) {
    const activity = object(payload.activity);
    await database.run(`INSERT INTO strava_segment_efforts (effort_id, segment_id, strava_activity_id, elapsed_s, moving_s, distance_m, average_watts, average_hr, max_hr, average_cadence, device_watts, pr_rank, kom_rank, started_at, raw_object_hash, payload_json)
      VALUES ($effortId, $segmentId, $activityId, $elapsedS, $movingS, $distanceM, $averageWatts, $averageHr, $maxHr, $averageCadence, $deviceWatts, $prRank, $komRank, $startedAt, $rawHash, $payload)
      ON CONFLICT (effort_id) DO UPDATE SET segment_id = excluded.segment_id, strava_activity_id = excluded.strava_activity_id, elapsed_s = excluded.elapsed_s, moving_s = excluded.moving_s, distance_m = excluded.distance_m, average_watts = excluded.average_watts, average_hr = excluded.average_hr, max_hr = excluded.max_hr, average_cadence = excluded.average_cadence, device_watts = excluded.device_watts, pr_rank = excluded.pr_rank, kom_rank = excluded.kom_rank, started_at = excluded.started_at, raw_object_hash = excluded.raw_object_hash, payload_json = excluded.payload_json, updated_at = now()`, { activityId: text(activity.id) ?? text(payload.activity_id), ...values });
  }
}

export async function normalizeStravaEntity(database: CatenceDatabase, entity: SourceEntity): Promise<void> {
  const payload = object(entity.payload);
  await storeGenericEntity(database, entity, payload);
  if (entity.entityType === 'athlete') {
    const accountId = text(payload.id) ?? entity.remoteId;
    await database.insertSourceAccount('strava', accountId, [text(payload.firstname), text(payload.lastname)].filter(Boolean).join(' ') || null, payload);
    return;
  }
  if (entity.entityType === 'segment') return upsertSegment(database, payload, entity.rawObjectHash);
  if (entity.entityType === 'segment_effort') return upsertEffort(database, payload, null, entity.rawObjectHash, true);
  if (entity.entityType !== 'activity') return;
  const activitySourceId = `strava:${entity.remoteId}`;
  const sport = text(payload.sport_type) ?? text(payload.type);
  await database.run(`INSERT INTO activities (activity_id, started_at_utc, started_at_local, timezone, sport, name, link_state)
    VALUES ($activityId, $startedAt, $startedAtLocal, $timezone, $sport, $name, 'unlinked')
    ON CONFLICT (activity_id) DO UPDATE SET started_at_utc = excluded.started_at_utc, started_at_local = excluded.started_at_local, timezone = excluded.timezone, sport = excluded.sport, name = excluded.name`,
    { activityId: activitySourceId, startedAt: text(payload.start_date), startedAtLocal: text(payload.start_date_local), timezone: text(payload.timezone), sport, name: text(payload.name) });
  await database.run(`INSERT INTO activity_sources (activity_source_id, activity_id, provider, remote_activity_id, external_id, raw_object_hash)
    VALUES ($activitySourceId, $activityId, 'strava', $remoteId, NULL, $rawHash)
    ON CONFLICT (activity_source_id) DO UPDATE SET activity_id = excluded.activity_id, raw_object_hash = excluded.raw_object_hash`, { activitySourceId, activityId: activitySourceId, remoteId: entity.remoteId, rawHash: entity.rawObjectHash });
  await database.run(`INSERT INTO activity_summaries VALUES ($activitySourceId, $distanceM, $movingS, $elapsedS, $elevationGain, $calories, $avgHr, $maxHr, $avgPower, NULL, $avgCadence, NULL, NULL, NULL, $metrics)
    ON CONFLICT (activity_source_id) DO UPDATE SET distance_m = excluded.distance_m, moving_s = excluded.moving_s, elapsed_s = excluded.elapsed_s, elevation_gain_m = excluded.elevation_gain_m, calories = excluded.calories, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, avg_power = excluded.avg_power, avg_cadence = excluded.avg_cadence, metrics_json = excluded.metrics_json`,
    { activitySourceId, distanceM: number(payload.distance), movingS: number(payload.moving_time), elapsedS: number(payload.elapsed_time), elevationGain: number(payload.total_elevation_gain), calories: number(payload.calories), avgHr: number(payload.average_heartrate), maxHr: number(payload.max_heartrate), avgPower: number(payload.average_watts), avgCadence: number(payload.average_cadence), metrics: json(payload) });
  const efforts = Array.isArray(payload.segment_efforts) ? payload.segment_efforts : [];
  for (const effort of efforts) await upsertEffort(database, object(effort), activitySourceId, entity.rawObjectHash, false);
  const gearId = text(payload.gear_id);
  if (gearId) await database.run(`INSERT INTO domain_entities (provider, entity_type, remote_id, parent_remote_id, occurred_on, payload_json, extension_json, raw_object_hash) VALUES ('strava', 'activity_gear', $gearId, $activityId, $occurredOn, $payload, '{}', $rawHash) ON CONFLICT (provider, entity_type, remote_id) DO UPDATE SET parent_remote_id = excluded.parent_remote_id, payload_json = excluded.payload_json, raw_object_hash = excluded.raw_object_hash`, { gearId, activityId: entity.remoteId, occurredOn: dateOnly(payload.start_date), payload: json({ gear_id: gearId, activity_id: entity.remoteId }), rawHash: entity.rawObjectHash });
}
