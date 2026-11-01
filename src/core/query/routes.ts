import type { QueryValues } from '../../contracts/storage.js';
import { ReadOnlyRepository } from './repository.js';

export interface RouteMatch {
  route_id: string;
  name: string | null;
  sport: string | null;
  distance_m: number | null;
  total_elevation_gain_m: number | null;
  sources: Array<{ route_source_id: string; provider: string; remote_route_id: string }>;
  segment_count: number;
}

export interface FindRouteResult {
  query: string;
  matches: RouteMatch[];
  exact: RouteMatch | null;
  caveats: string[];
}

export interface RouteSegmentRow {
  segment_id: string;
  segment_name: string | null;
  activity_type: string | null;
  distance_m: number | null;
  average_grade_pct: number | null;
  climb_category: number | null;
  total_elevation_gain_m: number | null;
  starred: boolean | null;
  position: number;
}

export interface GetRouteSegmentsResult {
  routeId: string;
  route: RouteMatch | null;
  segments: RouteSegmentRow[];
  caveats: string[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function asNumberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

async function routeById(repository: ReadOnlyRepository, routeId: string): Promise<RouteMatch | null> {
  const rows = await repository.rows<{
    route_id: string; name: string | null; sport: string | null; distance_m: number | null; total_elevation_gain_m: number | null;
    segment_count: number | bigint;
  }>(
    `SELECT r.route_id, r.name, r.sport, r.distance_m, r.total_elevation_gain_m,
       (SELECT count(*) FROM route_segments WHERE route_id = r.route_id) AS segment_count
     FROM route_facts AS r WHERE r.route_id = $routeId`,
    { routeId } satisfies QueryValues,
  );
  if (!rows.length) return null;
  return { ...rows[0], segment_count: Number(rows[0].segment_count), sources: await routeSources(repository, routeId) };
}

async function routeSources(repository: ReadOnlyRepository, routeId: string): Promise<RouteMatch['sources']> {
  const rows = await repository.rows<{ route_source_id: string; provider: string; remote_route_id: string }>(
    `SELECT route_source_id, provider, remote_route_id FROM route_sources WHERE route_id = $routeId ORDER BY provider`,
    { routeId } satisfies QueryValues,
  );
  return rows;
}

export class RoutesService {
  constructor(private readonly repository: ReadOnlyRepository) {}

  /**
   * Find saved routes by their friendly (user-visible) name. An exact
   * case-insensitive match is reported separately from partial matches so the
   * agent can disambiguate without guessing; routes synced Strava -> Garmin
   * appear once with all their provider sources.
   */
  async findRoutes(query: string): Promise<FindRouteResult> {
    const term = query.trim();
    const caveats: string[] = [];
    if (!term) {
      return { query, matches: [], exact: null, caveats: ['An empty route name matches nothing; pass the route name as shown in Strava or Garmin.'] };
    }
    const rows = await this.repository.rows<{
      route_id: string; name: string | null; sport: string | null; distance_m: number | null; total_elevation_gain_m: number | null;
      segment_count: number | bigint;
    }>(
      `SELECT r.route_id, r.name, r.sport, r.distance_m, r.total_elevation_gain_m,
         (SELECT count(*) FROM route_segments WHERE route_id = r.route_id) AS segment_count
       FROM route_facts AS r
       WHERE lower(r.name) = lower($term)
          OR lower(r.name) LIKE '%' || lower($term) || '%'
       ORDER BY CASE WHEN lower(r.name) = lower($term) THEN 0 ELSE 1 END, r.name`,
      { term } satisfies QueryValues,
    );
    const matches: RouteMatch[] = [];
    for (const row of rows) {
      matches.push({ ...row, segment_count: Number(row.segment_count), sources: await routeSources(this.repository, row.route_id) });
    }
    const exact = matches.find((match) => asString(match.name)?.toLowerCase() === term.toLowerCase()) ?? null;
    if (!matches.length) caveats.push(`No saved route matches the name "${term}". Routes sync from Strava and Garmin during a data sync; run one if this route was created recently.`);
    return { query, matches, exact, caveats };
  }

  /** Resolve a route by id (canonical route_id or provider route source id). */
  async resolveRoute(routeId: string): Promise<RouteMatch | null> {
    const direct = await routeById(this.repository, routeId);
    if (direct) return direct;
    const source = await this.repository.rows<{ route_id: string }>(
      'SELECT route_id FROM route_sources WHERE route_source_id = $routeId',
      { routeId } satisfies QueryValues,
    );
    return source.length ? routeById(this.repository, source[0].route_id) : null;
  }

  /**
   * Hydrated segments present in a route, joined against the persisted
   * strava_segments facts (same hydration path as activities). Absent segment
   * facts are reported as null, never inferred.
   */
  async routeSegments(routeId: string, limit: number): Promise<GetRouteSegmentsResult> {
    const caveats: string[] = [];
    const route = await this.resolveRoute(routeId);
    if (!route) {
      return { routeId, route: null, segments: [], caveats: [`No saved route named ${routeId} exists. Use find_route with the route's friendly name first.`] };
    }
    const rows = await this.repository.rows<Record<string, unknown>>(
      `SELECT rs.position, rs.segment_id,
         segment.name AS segment_name, segment.activity_type, segment.distance_m,
         segment.average_grade_pct, segment.climb_category, segment.total_elevation_gain_m, segment.starred
       FROM route_segments AS rs
       LEFT JOIN strava_segments AS segment USING (segment_id)
       WHERE rs.route_id = $routeId
       ORDER BY rs.position ASC, rs.segment_id ASC
       LIMIT $limit`,
      { routeId: route.route_id, limit } satisfies QueryValues,
    );
    const segments: RouteSegmentRow[] = rows.map((row) => ({
      position: asInteger(row.position),
      segment_id: String(row.segment_id),
      segment_name: asString(row.segment_name),
      activity_type: asString(row.activity_type),
      distance_m: asNumberValue(row.distance_m),
      average_grade_pct: asNumberValue(row.average_grade_pct),
      climb_category: asNumberValue(row.climb_category) === null ? null : asInteger(row.climb_category),
      total_elevation_gain_m: asNumberValue(row.total_elevation_gain_m),
      starred: typeof row.starred === 'boolean' ? row.starred : null,
    }));
    if (!segments.length) caveats.push('This route has no hydrated segments yet; segment coverage arrives with the route sync from Strava.');
    return { routeId, route, segments, caveats };
  }
}
