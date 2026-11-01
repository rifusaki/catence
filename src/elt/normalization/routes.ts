import { createHash } from 'node:crypto';
import type { Provider, SourceEntity } from '../../contracts/staging.js';
import type { CatenceDatabase } from '../storage/database.js';
import { upsertStravaSegment } from './segments/strava-normalizer.js';

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

function firstString(payload: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = text(payload[key]);
    if (value) return value;
  }
  return null;
}

function firstNumber(payload: JsonObject, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = number(payload[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Deterministic canonical route identity. Routes synced Strava -> Garmin share
 * the friendly name the user sees, so the name (plus sport, when present) keys
 * the route: both provider occurrences land on one route_id with two
 * route_sources instead of duplicating. Unnamed routes fall back to a
 * provider-scoped id and never merge.
 */
export function canonicalRouteId(name: string | null, sport: string | null): string {
  if (!name) return '';
  const digest = createHash('sha256').update(`${name.trim().toLowerCase()}|${(sport ?? '').trim().toLowerCase()}`).digest('hex').slice(0, 24);
  return `route:${digest}`;
}

/**
 * Normalize one staged route entity into routes/route_sources/route_segments.
 * The upserts are hash-guarded: when the provider payload is unchanged the
 * rows keep their original timestamps instead of being rewritten.
 */
export async function importRouteEntity(database: CatenceDatabase, entity: SourceEntity): Promise<void> {
  const payload = object(entity.payload);
  const rawHash = entity.rawObjectHash;
  const provider = entity.provider as Provider;
  const remoteId = entity.remoteId;
  const name = firstString(payload, ['name', 'routeName', 'route_name']);
  const sport = firstString(payload, ['sport', 'sportType', 'activityType', 'type']);
  const distanceM = firstNumber(payload, ['distance', 'distanceInMeters', 'distance_in_meters', 'distanceM']);
  const elevationGainM = firstNumber(payload, ['elevationGain', 'totalElevationGain', 'total_elevation_gain', 'elevationGainInMeters']);
  const routeId = canonicalRouteId(name, sport) || `${provider}:${remoteId}`;
  const routeSourceId = `${provider}:${remoteId}`;

  await database.run(
    `INSERT INTO route_facts (route_id, name, sport, distance_m, total_elevation_gain_m)
     VALUES ($routeId, $name, $sport, $distanceM, $elevationGainM)
     ON CONFLICT (route_id) DO NOTHING`,
    { routeId, name, sport, distanceM, elevationGainM },
  );
  await database.run(
    `INSERT INTO route_sources (route_source_id, route_id, provider, remote_route_id, raw_object_hash)
     VALUES ($routeSourceId, $routeId, $provider, $remoteId, $rawHash)
     ON CONFLICT (route_source_id) DO UPDATE SET
       route_id = excluded.route_id, raw_object_hash = excluded.raw_object_hash, synced_at = now()
     WHERE route_sources.raw_object_hash IS DISTINCT FROM excluded.raw_object_hash`,
    { routeSourceId, routeId, provider, remoteId, rawHash },
  );
  // DuckDB forbids subqueries in ON CONFLICT clauses, so the hash-guarded
  // route update is a plain UPDATE joined to this provider's source row: an
  // unchanged payload leaves the row (and its updated_at) untouched.
  await database.run(
    `UPDATE route_facts SET
       name = COALESCE($name, route_facts.name),
       sport = COALESCE($sport, route_facts.sport),
       distance_m = COALESCE($distanceM, route_facts.distance_m),
       total_elevation_gain_m = COALESCE($elevationGainM, route_facts.total_elevation_gain_m),
       updated_at = now()
     FROM route_sources AS source
     WHERE route_facts.route_id = $routeId
       AND source.route_id = route_facts.route_id
       AND source.provider = $provider
       AND source.raw_object_hash IS DISTINCT FROM $rawHash`,
    { routeId, name, sport, distanceM, elevationGainM, provider, rawHash },
  );

  const segments = Array.isArray(payload.segments) ? payload.segments.map(object) : [];
  const segmentIds: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const segmentId = text(segment.id) ?? text(segment.segment_id);
    if (!segmentId) continue;
    segmentIds.push(segmentId);
    if (provider === 'strava') await upsertStravaSegment(database, segment, rawHash);
    await database.run(
      `INSERT INTO route_segments (route_id, segment_id, position, raw_object_hash)
       VALUES ($routeId, $segmentId, $position, $rawHash)
       ON CONFLICT (route_id, segment_id) DO UPDATE SET
         position = excluded.position, raw_object_hash = excluded.raw_object_hash
       WHERE route_segments.raw_object_hash IS DISTINCT FROM excluded.raw_object_hash`,
      { routeId, segmentId, position: index, rawHash },
    );
  }
  if (segmentIds.length) {
    const values: Record<string, unknown> = { routeId };
    const placeholders = segmentIds.map((id, index) => { values[`segment${index}`] = id; return `$segment${index}`; }).join(', ');
    await database.run(`DELETE FROM route_segments WHERE route_id = $routeId AND segment_id NOT IN (${placeholders})`, values);
  } else {
    await database.run('DELETE FROM route_segments WHERE route_id = $routeId', { routeId });
  }
}

/**
 * Mirror-sync sweep for one provider: drop route_sources absent from the
 * latest authoritative listing, then drop routes left with no sources and
 * their route_segments. Other providers' occurrences of a shared route are
 * untouched.
 */
export async function reconcileRouteSources(database: CatenceDatabase, provider: Provider, keepRemoteIds: readonly string[]): Promise<{ deletedSources: number; deletedRoutes: number }> {
  const values: Record<string, unknown> = { provider };
  let keepClause = '';
  if (keepRemoteIds.length) {
    keepClause = ` AND remote_route_id NOT IN (${keepRemoteIds.map((_, index) => `$keep${index}`).join(', ')})`;
    keepRemoteIds.forEach((id, index) => { values[`keep${index}`] = id; });
  }
  const deletedSources = await database.rows<{ route_source_id: string }>(
    `DELETE FROM route_sources WHERE provider = $provider${keepClause} RETURNING route_source_id`,
    values,
  );
  // Orphaned routes lose their segments first (FK), then the route itself.
  await database.run(
    `DELETE FROM route_segments WHERE NOT EXISTS (SELECT 1 FROM route_sources WHERE route_sources.route_id = route_segments.route_id)`,
  );
  const deletedRoutes = await database.rows<{ route_id: string }>(
    `DELETE FROM route_facts WHERE NOT EXISTS (SELECT 1 FROM route_sources WHERE route_sources.route_id = route_facts.route_id) RETURNING route_id`,
  );
  return { deletedSources: deletedSources.length, deletedRoutes: deletedRoutes.length };
}
