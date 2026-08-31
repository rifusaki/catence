import type { QueryValues } from '../../contracts/storage.js';
import { QueryValidationError } from './catalog.js';
import { ReadOnlyRepository } from './repository.js';

export type SwimLapsRequest = {
  /** A source id (for example garmin:123) or a linked logical activity id. */
  activityId: string;
  provider?: 'garmin' | 'intervals';
};

export type SwimProgressRequest = {
  startDate?: string;
  endDate?: string;
  /** Restrict the comparable pool cohort. Values are metres, not Garmin centimetres. */
  poolLengthM?: number;
};

type SwimSource = {
  activity_id: string;
  activity_source_id: string;
  provider: string;
  remote_activity_id: string;
  started_at_utc: string | null;
  sport: string | null;
  name: string | null;
};

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function addDateRange(column: string, request: Pick<SwimProgressRequest, 'startDate' | 'endDate'>, values: QueryValues): string[] {
  const clauses: string[] = [];
  if (request.startDate) {
    values.startDate = request.startDate;
    clauses.push(`${column} >= cast($startDate AS TIMESTAMPTZ)`);
  }
  if (request.endDate) {
    values.endDate = `${request.endDate}T23:59:59.999Z`;
    clauses.push(`${column} <= cast($endDate AS TIMESTAMPTZ)`);
  }
  return clauses;
}

/** Read-only source-aware swim facts and a deliberately non-physiological progress report. */
export class SwimmingService {
  constructor(private readonly repository: ReadOnlyRepository) {}

  async swimLaps(request: SwimLapsRequest): Promise<Record<string, unknown>> {
    const values: QueryValues = { activityId: request.activityId };
    const providerClause = request.provider ? 'AND source.provider = $provider' : '';
    if (request.provider) values.provider = request.provider;
    // A source id can happen to equal its unlinked logical id (for example
    // garmin:123). Prefer the explicit source interpretation whenever it
    // exists, otherwise expand a logical id to all of its provider records.
    const exactSource = await this.repository.rows<{ activity_source_id: string }>(`
      SELECT activity_source_id FROM activity_sources
      WHERE activity_source_id = $activityId
      ${request.provider ? 'AND provider = $provider' : ''}
      LIMIT 1
    `, values);
    const identityClause = exactSource.length ? 'source.activity_source_id = $activityId' : 'source.activity_id = $activityId';
    const sources = await this.repository.rows<SwimSource>(`
      SELECT source.activity_id, source.activity_source_id, source.provider, source.remote_activity_id,
        cast(activity.started_at_utc AS VARCHAR) AS started_at_utc, activity.sport, activity.name
      FROM activity_sources AS source
      JOIN activities AS activity USING (activity_id)
      WHERE ${identityClause}
        AND lower(coalesce(activity.sport, '')) LIKE '%swim%'
        ${providerClause}
      ORDER BY CASE source.provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END, source.activity_source_id
    `, values);
    if (sources.length === 0) throw new QueryValidationError(`No swimming activity source matched ${request.activityId}.`);

    const data = await Promise.all(sources.map(async (source) => {
      const [lengths, sets, flags] = await Promise.all([
        this.repository.rows(`
          SELECT length_index, lap_index, pool_length_m, cast(start_time AS VARCHAR) AS start_time,
            duration_s, active_duration_s, distance_m, stroke_count, stroke_rate, swolf,
            avg_hr, max_hr, is_rest, source, confidence, raw_object_hash
          FROM swim_length_facts
          WHERE activity_source_id = $activitySourceId
          ORDER BY source, length_index
        `, { activitySourceId: source.activity_source_id }),
        this.repository.rows(`
          SELECT source_type, set_index, label, reps, rep_distance_m, total_distance_m,
            work_s, rest_s, avg_pace, avg_hr, max_hr, stroke_rate, raw_object_hash
          FROM swim_set_facts
          WHERE activity_source_id = $activitySourceId
          ORDER BY source_type, set_index
        `, { activitySourceId: source.activity_source_id }),
        this.repository.rows(`
          SELECT flag_code, severity, details_json, raw_object_hash
          FROM activity_quality_flag_facts
          WHERE activity_source_id = $activitySourceId
          ORDER BY severity DESC, flag_code
        `, { activitySourceId: source.activity_source_id }),
      ]);
      return {
        ...source,
        lengths,
        sets,
        qualityFlags: flags.map((flag) => ({ ...flag, details_json: parseJson(flag.details_json) })),
        availability: {
          explicitLengthFacts: lengths.length > 0,
          setFacts: sets.length > 0,
          perLengthPaceAvailable: lengths.some((length) => Number(length.duration_s) > 0),
        },
      };
    }));
    const noLengthSources = data.filter((source) => !source.availability.explicitLengthFacts).map((source) => source.activity_source_id);
    return {
      data,
      provenance: { relations: ['activities', 'activity_sources', 'swim_length_facts', 'swim_set_facts', 'activity_quality_flag_facts'], idInput: request.activityId },
      query: request,
      caveats: [
        ...(noLengthSources.length ? [`No explicit provider-supplied per-length records are available for: ${noLengthSources.join(', ')}. Catence does not manufacture laps or pace from sample points.`] : []),
        'Intervals.icu auto blocks and Garmin detected split summaries are returned as sets; neither is silently labelled as a manually pressed lap.',
      ],
    };
  }

  async swimProgressReport(request: SwimProgressRequest = {}): Promise<Record<string, unknown>> {
    if (request.poolLengthM !== undefined && (!Number.isFinite(request.poolLengthM) || request.poolLengthM <= 0 || request.poolLengthM > 200)) {
      throw new QueryValidationError('poolLengthM must be a positive value no greater than 200 metres.');
    }
    const values: QueryValues = {};
    const poolLengthSql = `CASE
      WHEN try_cast(json_extract_string(summary.metrics_json, '$.poolLength') AS DOUBLE) >= 100
        THEN try_cast(json_extract_string(summary.metrics_json, '$.poolLength') AS DOUBLE) / 100
      ELSE try_cast(json_extract_string(summary.metrics_json, '$.poolLength') AS DOUBLE)
    END`;
    const clauses = ["source.provider = 'garmin'", "lower(coalesce(activity.sport, '')) LIKE '%swim%'", ...addDateRange('activity.started_at_utc', request, values)];
    if (request.poolLengthM !== undefined) {
      values.poolLengthM = request.poolLengthM;
      clauses.push(`abs((${poolLengthSql}) - $poolLengthM) <= 0.01`);
    }
    const rows = await this.repository.rows<{
      activity_id: string;
      activity_source_id: string;
      started_at_utc: string | null;
      sport: string | null;
      name: string | null;
      distance_m: number | null;
      moving_s: number | null;
      elapsed_s: number | null;
      avg_hr: number | null;
      max_hr: number | null;
      pool_length_m: number | null;
      active_lengths: number | null;
      average_swolf: number | null;
      fastest_100_s: number | null;
      stroke_cadence_spm: number | null;
      length_fact_count: number | bigint;
      pace_length_fact_count: number | bigint;
      set_fact_count: number | bigint;
      quality_flags: unknown;
    }>(`
      WITH quality AS (
        SELECT activity_source_id,
          json_group_array(json_object('code', flag_code, 'severity', severity, 'details', details_json)) AS quality_flags
        FROM activity_quality_flags GROUP BY activity_source_id
      ), lengths AS (
        SELECT activity_source_id, count(*) AS length_fact_count,
          count(*) FILTER (WHERE duration_s > 0) AS pace_length_fact_count
        FROM swim_lengths GROUP BY activity_source_id
      ), sets AS (
        SELECT activity_source_id, count(*) AS set_fact_count FROM swim_sets GROUP BY activity_source_id
      )
      SELECT source.activity_id, source.activity_source_id, cast(activity.started_at_utc AS VARCHAR) AS started_at_utc,
        activity.sport, activity.name, summary.distance_m, summary.moving_s, summary.elapsed_s, summary.avg_hr, summary.max_hr,
        ${poolLengthSql} AS pool_length_m,
        try_cast(json_extract_string(summary.metrics_json, '$.activeLengths') AS DOUBLE) AS active_lengths,
        try_cast(json_extract_string(summary.metrics_json, '$.averageSwolf') AS DOUBLE) AS average_swolf,
        try_cast(json_extract_string(summary.metrics_json, '$.fastestSplit_100') AS DOUBLE) AS fastest_100_s,
        try_cast(json_extract_string(summary.metrics_json, '$.averageSwimCadenceInStrokesPerMinute') AS DOUBLE) AS stroke_cadence_spm,
        coalesce(lengths.length_fact_count, 0) AS length_fact_count,
        coalesce(lengths.pace_length_fact_count, 0) AS pace_length_fact_count,
        coalesce(sets.set_fact_count, 0) AS set_fact_count,
        coalesce(quality.quality_flags, cast('[]' AS JSON)) AS quality_flags
      FROM activity_sources AS source
      JOIN activities AS activity USING (activity_id)
      JOIN activity_summaries AS summary USING (activity_source_id)
      LEFT JOIN lengths USING (activity_source_id)
      LEFT JOIN sets USING (activity_source_id)
      LEFT JOIN quality USING (activity_source_id)
      WHERE ${clauses.join(' AND ')}
      ORDER BY activity.started_at_utc ASC, source.activity_source_id ASC
    `, values);
    const sessions = rows.map((row) => ({
      ...row,
      length_fact_count: Number(row.length_fact_count),
      pace_length_fact_count: Number(row.pace_length_fact_count),
      set_fact_count: Number(row.set_fact_count),
      quality_flags: parseJson(row.quality_flags),
      dataCompleteness: {
        explicitLengthFactsAvailable: Number(row.length_fact_count) > 0,
        setFactsAvailable: Number(row.set_fact_count) > 0,
        perLengthPaceAvailable: Number(row.pace_length_fact_count) > 0,
      },
    }));
    return {
      data: {
        sessions,
        coverage: {
          sessionCount: sessions.length,
          poolSessionCount: sessions.filter((session) => session.pool_length_m !== null).length,
          explicitLengthFactSessions: sessions.filter((session) => session.length_fact_count > 0).length,
          setFactSessions: sessions.filter((session) => session.set_fact_count > 0).length,
        },
      },
      provenance: { relations: ['activities', 'activity_sources', 'activity_summaries', 'swim_lengths', 'swim_sets', 'activity_quality_flags'], summaryProvider: 'garmin' },
      query: request,
      caveats: [
        'This report compares Garmin-native summary metrics. It does not infer a pool pace curve from moving time divided by distance.',
        'Per-length pace, rest, and HR drift are reported only when explicit swim-length records exist; activity samples never create synthetic lengths.',
        'Intervals.icu auto blocks are separately available through get_swim_laps and retain source_type: intervals_auto.',
        ...(sessions.length === 0 ? ['No Garmin swimming sessions matched the selected range and pool length.'] : []),
      ],
    };
  }
}
