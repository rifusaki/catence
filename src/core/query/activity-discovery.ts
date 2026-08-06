import { createHash } from 'node:crypto';
import type { QueryValues } from '../../contracts/storage.js';
import { QueryValidationError } from './catalog.js';
import { jsonSafe, ReadOnlyRepository } from './repository.js';

export type FindActivitiesRequest = {
  sports?: string[];
  distanceKm?: [number, number];
  nameContains?: string[];
  startDate?: string;
  endDate?: string;
  sort?: 'date_desc' | 'date_asc';
  limit?: number;
  cursor?: string;
};

type Cursor = { hash: string; offset: number };

type ActivityRow = {
  activity_id: string;
  activity_source_id: string;
  provider: string;
  started_at_utc: string;
  sport: string;
  name: string | null;
  distance_m: number | null;
  moving_s: number | null;
  elapsed_s: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  training_load: number | null;
  link_state: string;
};

function hash(request: Omit<FindActivitiesRequest, 'cursor' | 'limit'>): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('base64url');
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(cursor: string, expectedHash: string): Cursor {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (!Number.isInteger(decoded.offset) || decoded.offset < 0 || decoded.hash !== expectedHash) throw new Error();
    return decoded;
  } catch {
    throw new QueryValidationError('Invalid or mismatched cursor. Start the activity search again.');
  }
}

function raceSignals(row: ActivityRow, requestedDistance: [number, number] | undefined): Record<string, unknown> {
  const name = row.name?.toLowerCase() ?? '';
  const nameSuggestsRace = /\b(race|marathon|half[ -]?marathon|media(?:[ -]?marat[oó]n)?|corrida|competition|10k|5k|hm)\b/i.test(name);
  const distanceKm = row.distance_m === null ? null : row.distance_m / 1_000;
  const uninterrupted = row.moving_s !== null && row.elapsed_s !== null && row.moving_s > 0
    ? { ratio: row.moving_s / row.elapsed_s, likely: row.elapsed_s - row.moving_s <= 180 || row.moving_s / row.elapsed_s >= 0.97 }
    : { ratio: null, likely: false };
  const distanceMatchesRequestedRange = Boolean(distanceKm !== null && requestedDistance && distanceKm >= requestedDistance[0] && distanceKm <= requestedDistance[1]);
  const hasHeartRate = row.avg_hr !== null || row.max_hr !== null;
  const hasTrainingLoad = row.training_load !== null;
  const likelyRace = nameSuggestsRace || (distanceMatchesRequestedRange && uninterrupted.likely && hasHeartRate && hasTrainingLoad);
  return {
    likelyRace,
    nameSuggestsRace,
    distanceMatchesRequestedRange,
    uninterruptedMovingTime: uninterrupted,
    heartRateAvailable: hasHeartRate,
    trainingLoadAvailable: hasTrainingLoad,
  };
}

/**
 * Finds one canonical source-backed activity per logical activity. Race
 * classification is transparent heuristics, not a claim that a provider
 * recorded an event as a race.
 */
export class ActivityDiscoveryService {
  constructor(private readonly repository: ReadOnlyRepository) {}

  async findActivities(request: FindActivitiesRequest = {}): Promise<Record<string, unknown>> {
    const sports = [...new Set((request.sports ?? []).map((sport) => sport.trim()).filter(Boolean))];
    const names = [...new Set((request.nameContains ?? []).map((name) => name.trim()).filter(Boolean))];
    if (sports.length > 12 || names.length > 12) throw new QueryValidationError('sports and nameContains each permit at most 12 values.');
    if (request.distanceKm && (!Number.isFinite(request.distanceKm[0]) || !Number.isFinite(request.distanceKm[1]) || request.distanceKm[0] < 0 || request.distanceKm[0] > request.distanceKm[1])) {
      throw new QueryValidationError('distanceKm must contain an ascending, non-negative [minimum, maximum] range.');
    }
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 100);
    const { cursor: ignoredCursor, limit: ignoredLimit, ...fingerprintRequest } = request;
    void ignoredCursor;
    void ignoredLimit;
    const fingerprint = hash(fingerprintRequest);
    const offset = request.cursor ? decodeCursor(request.cursor, fingerprint).offset : 0;
    const values: QueryValues = {};
    const clauses: string[] = [];
    if (sports.length) {
      const placeholders = sports.map((sport, index) => {
        const key = `sport${index}`;
        values[key] = sport;
        return `lower(activity.sport) = lower($${key})`;
      });
      clauses.push(`(${placeholders.join(' OR ')})`);
    }
    if (request.distanceKm) {
      values.minDistanceM = request.distanceKm[0] * 1_000;
      values.maxDistanceM = request.distanceKm[1] * 1_000;
      clauses.push('summary.distance_m BETWEEN $minDistanceM AND $maxDistanceM');
    }
    if (names.length) {
      const placeholders = names.map((name, index) => {
        const key = `name${index}`;
        values[key] = name;
        return `activity.name ILIKE '%' || $${key} || '%'`;
      });
      clauses.push(`(${placeholders.join(' OR ')})`);
    }
    if (request.startDate) {
      values.startDate = request.startDate;
      clauses.push('activity.started_at_utc >= cast($startDate AS TIMESTAMPTZ)');
    }
    if (request.endDate) {
      values.endDate = `${request.endDate}T23:59:59.999Z`;
      clauses.push('activity.started_at_utc <= cast($endDate AS TIMESTAMPTZ)');
    }
    const direction = request.sort === 'date_asc' ? 'ASC' : 'DESC';
    const base = `
      SELECT activity.activity_id, source.activity_source_id, source.provider,
        cast(activity.started_at_utc AS VARCHAR) AS started_at_utc, activity.sport, activity.name,
        summary.distance_m, summary.moving_s, summary.elapsed_s, summary.avg_hr, summary.max_hr,
        coalesce(summary.training_load, canonical.intervals_training_load) AS training_load, activity.link_state
      FROM activities AS activity
      JOIN activity_sources AS source USING (activity_id)
      LEFT JOIN activity_summaries AS summary USING (activity_source_id)
      LEFT JOIN canonical_activity_training AS canonical ON canonical.activity_id = activity.activity_id
      WHERE source.activity_source_id = canonical.activity_source_id
        ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
    `;
    // canonical_activity_training supplies the same canonical-source rule used
    // by reports, so linked Garmin/Intervals duplicates appear once.
    const total = await this.repository.rows<{ total_rows: number | bigint }>(`SELECT count(*) AS total_rows FROM (${base}) AS matches`, values);
    const totalRows = Number(total[0]?.total_rows ?? 0);
    values.limit = limit;
    values.offset = offset;
    const rows = await this.repository.rows<ActivityRow>(`${base} ORDER BY started_at_utc ${direction}, activity_source_id ASC LIMIT $limit OFFSET $offset`, values);
    const returnedRows = rows.length;
    const truncated = offset + returnedRows < totalRows;
    return jsonSafe({
      returnedRows,
      totalRows,
      truncated,
      nextCursor: truncated ? encodeCursor({ hash: fingerprint, offset: offset + returnedRows }) : undefined,
      data: rows.map((row) => ({ ...row, raceSignals: raceSignals(row, request.distanceKm) })),
      provenance: { relations: ['activities', 'activity_sources', 'activity_summaries', 'canonical_activity_training'], canonicalSource: true },
      query: { sports, distanceKm: request.distanceKm, nameContains: names, startDate: request.startDate, endDate: request.endDate, sort: request.sort ?? 'date_desc', limit },
      caveats: [
        'likelyRace is a transparent heuristic based on name, distance, uninterrupted moving time, heart-rate availability, and training-load availability; it is not provider-confirmed race metadata.',
        ...(truncated ? ['Results are incomplete. Do not draw exhaustive conclusions; retrieve remaining pages with nextCursor or narrow the search.'] : []),
      ],
    });
  }
}
