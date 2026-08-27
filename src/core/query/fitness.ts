import type { QueryValues } from '../../contracts/storage.js';
import { QueryValidationError } from './catalog.js';
import { ReadOnlyRepository } from './repository.js';

const CYCLING_SPORTS = ['cycling', 'road_biking', 'indoor_cycling', 'virtual_ride'] as const;
const DEFAULT_POWER_DURATIONS = [5, 60, 300, 1_200, 1_800] as const;
const RUNNING_VO2MAX_ALIASES = new Set(['run', 'running']);

export type FitnessDateRange = {
  startDate?: string;
  endDate?: string;
};

export type FtpHistoryRequest = FitnessDateRange & {
  sport?: string;
  sourcePreference?: 'settings' | 'settings_then_activity' | 'all';
};

export type Vo2MaxHistoryRequest = FitnessDateRange & {
  sport?: string;
};

export type PowerSportFamily = 'cycling' | 'running';

type PowerSportSelection = {
  sport?: string;
  sportFamily?: PowerSportFamily;
};

export type PowerCurveTrendRequest = FitnessDateRange & PowerSportSelection & {
  durations?: number[];
  sourceQuality?: 'all' | 'garmin_fit_derived';
};

export type PowerCoverageReportRequest = FitnessDateRange & PowerSportSelection & {
  sourceQuality?: 'all' | 'garmin_fit_derived';
};

export type LatestCyclingActivitiesRequest = FitnessDateRange & {
  includeMultisport?: boolean;
  limit?: number;
};

export type ReadinessBaselineRequest = FitnessDateRange & {
  sport?: string;
};

type MetricRow = {
  observation_id: string;
  observed_at: string;
  value_number: number | null;
  value_text: string | null;
  unit: string | null;
  sport: string;
  source_type: string;
  source_remote_id: string;
  activity_source_id: string | null;
  raw_object_hash: string | null;
};

type PowerCurveRow = {
  month: string;
  duration_s: number;
  best_power_w: number;
  activity_id: string;
  activity_source_id: string;
  started_at_utc: string;
  sport: string;
  source_type: string;
  raw_object_hash: string | null;
};

type CyclingActivityRow = {
  activity_id: string;
  activity_source_id: string;
  remote_activity_id: string;
  started_at_utc: string;
  sport: string;
  name: string | null;
  link_state: string;
  parent_remote_id: string | null;
  distance_m: number | null;
  moving_s: number | null;
  elapsed_s: number | null;
  elevation_gain_m: number | null;
  avg_hr: number | null;
  avg_power: number | null;
  training_load: number | null;
  stream_rows: number | null;
  raw_object_hash: string | null;
};

function addDateRange(column: string, request: FitnessDateRange, values: QueryValues): string[] {
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

function cyclingSportClause(column: string, sport: string | undefined, values: QueryValues): string {
  if (!sport || sport.toLowerCase() === 'cycling') return `lower(${column}) IN (${CYCLING_SPORTS.map((item) => `'${item}'`).join(', ')})`;
  values.sport = sport;
  return `lower(${column}) = lower($sport)`;
}

function powerSportClause(column: string, selection: PowerSportSelection, values: QueryValues): string {
  if (selection.sport && selection.sportFamily) throw new QueryValidationError('Choose either sport or sportFamily, not both.');
  if (selection.sport) {
    values.sport = selection.sport;
    return `lower(${column}) = lower($sport)`;
  }
  if (selection.sportFamily === 'cycling') return `lower(${column}) IN (${CYCLING_SPORTS.map((item) => `'${item}'`).join(', ')})`;
  if (selection.sportFamily === 'running') return `lower(${column}) LIKE '%run%'`;
  throw new QueryValidationError('power queries require an explicit sport or sportFamily.');
}

function durationLabel(duration: number): string {
  if (duration < 60) return `${duration} s`;
  if (duration % 60 === 0) return `${duration / 60} min`;
  return `${Math.floor(duration / 60)} min ${duration % 60} s`;
}

function sourceRank(sourceType: string): number {
  if (sourceType === 'cycling_ftp_history') return 0;
  if (sourceType === 'cycling_ftp') return 1;
  if (sourceType === 'activity_summary') return 2;
  return 3;
}

function sourceTypeFilter(preference: NonNullable<FtpHistoryRequest['sourcePreference']>): string {
  if (preference === 'settings') return "AND source_type IN ('cycling_ftp_history', 'cycling_ftp')";
  if (preference === 'settings_then_activity') return "AND source_type IN ('cycling_ftp_history', 'cycling_ftp', 'activity_summary')";
  return '';
}

/** Read-only, source-aware fitness projections built on normalized facts. */
export class FitnessService {
  constructor(private readonly repository: ReadOnlyRepository) {}

  async ftpHistory(request: FtpHistoryRequest = {}): Promise<Record<string, unknown>> {
    const sourcePreference = request.sourcePreference ?? 'settings_then_activity';
    const values: QueryValues = {};
    const clauses = ["metric_name = 'cycling_ftp_w'", cyclingSportClause('sport', request.sport ?? 'cycling', values), ...addDateRange('observed_at', request, values)];
    const observations = await this.repository.rows<MetricRow>(`
      SELECT observation_id, cast(observed_at AS VARCHAR) AS observed_at, value_number, value_text, unit, sport,
        source_type, source_remote_id, activity_source_id, raw_object_hash
      FROM training_metric_observations
      WHERE ${clauses.join(' AND ')} ${sourceTypeFilter(sourcePreference)}
      ORDER BY observed_at ASC,
        CASE source_type WHEN 'cycling_ftp_history' THEN 0 WHEN 'cycling_ftp' THEN 1 WHEN 'activity_summary' THEN 2 ELSE 3 END,
        observation_id ASC
    `, values);
    const seriesByDate = new Map<string, MetricRow>();
    for (const observation of observations) {
      const date = observation.observed_at.slice(0, 10);
      const current = seriesByDate.get(date);
      if (!current || sourceRank(observation.source_type) < sourceRank(current.source_type)) seriesByDate.set(date, observation);
    }
    return {
      data: { observations, preferredSeries: [...seriesByDate.values()] },
      provenance: { dataset: 'training_metric_observations', metric: 'cycling_ftp_w', sourcePreference },
      query: { ...request, sport: request.sport ?? 'cycling', sourcePreference },
      caveats: [
        'FTP settings, the direct current-setting endpoint, and activity-summary FTP are retained as distinct source types.',
        ...(observations.length === 0 ? ['No matching normalized FTP observations are available for this range.'] : []),
      ],
    };
  }

  async vo2MaxHistory(request: Vo2MaxHistoryRequest = {}): Promise<Record<string, unknown>> {
    if (!request.sport) {
      const values: QueryValues = {};
      const clauses = ["metric_name = 'vo2_max_ml_kg_min'", ...addDateRange('observed_at', request, values)];
      const availableSports = await this.repository.rows<{ sport: string; count: number; latest: number | null; latest_observed_at: string | null }>(`
        WITH ranked AS (
          SELECT sport, value_number, observed_at,
            count(*) OVER (PARTITION BY sport)::INTEGER AS count,
            row_number() OVER (PARTITION BY sport ORDER BY observed_at DESC, observation_id DESC) AS latest_rank
          FROM training_metric_observations
          WHERE ${clauses.join(' AND ')}
        )
        SELECT sport, max(count)::INTEGER AS count,
          max(value_number) FILTER (WHERE latest_rank = 1) AS latest,
          cast(max(observed_at) FILTER (WHERE latest_rank = 1) AS VARCHAR) AS latest_observed_at
        FROM ranked GROUP BY sport ORDER BY sport ASC
      `, values);
      return {
        data: {
          availableSports,
          sportAliases: [{ requestedSport: 'running', sourceSport: 'generic', reason: 'Garmin labels its running VO₂max estimate as generic.' }],
          actionRequired: 'Choose a sport explicitly. Use running for Garmin running VO₂max.',
        },
        provenance: { dataset: 'training_metric_observations', metric: 'vo2_max_ml_kg_min' },
        query: { ...request, sport: null },
        caveats: [
          'No VO₂max observations are returned until sport is chosen explicitly; Catence never silently defaults to cycling.',
          'For a running request, Catence reads Garmin’s generic source-labelled VO₂max series and retains generic on each returned observation.',
        ],
      };
    }
    const requestedSport = request.sport;
    const sourceSport = RUNNING_VO2MAX_ALIASES.has(requestedSport.trim().toLowerCase()) ? 'generic' : requestedSport;
    const values: QueryValues = { sourceSport };
    const clauses = ["metric_name = 'vo2_max_ml_kg_min'", 'lower(sport) = lower($sourceSport)', ...addDateRange('observed_at', request, values)];
    const observations = await this.repository.rows<MetricRow>(`
      SELECT observation_id, cast(observed_at AS VARCHAR) AS observed_at, value_number, value_text, unit, sport,
        source_type, source_remote_id, activity_source_id, raw_object_hash
      FROM training_metric_observations
      WHERE ${clauses.join(' AND ')}
      ORDER BY observed_at ASC, observation_id ASC
    `, values);
    return {
      data: observations,
      provenance: { dataset: 'training_metric_observations', metric: 'vo2_max_ml_kg_min', requestedSport, sourceSport },
      query: { ...request, sport: requestedSport, sourceSport },
      caveats: [
        'Sport values on observations are reported exactly as Garmin supplied them; generic and cycling values are never combined.',
        ...(sourceSport === 'generic' && requestedSport !== 'generic' ? ['Garmin supplies running VO₂max under the generic source label; the returned rows preserve that raw label.'] : []),
        ...(observations.length === 0 ? [`No normalized ${requestedSport} VO₂max history is available for this range.`] : []),
      ],
    };
  }

  async powerCurveTrend(request: PowerCurveTrendRequest = {}): Promise<Record<string, unknown>> {
    const durations = [...new Set(request.durations ?? DEFAULT_POWER_DURATIONS)].sort((left, right) => left - right);
    if (durations.length === 0 || durations.length > 12 || durations.some((duration) => !Number.isInteger(duration) || duration < 1 || duration > 86_400)) {
      throw new QueryValidationError('durations must contain 1–12 whole-second values between 1 and 86,400.');
    }
    const sourceQuality = request.sourceQuality ?? 'all';
    const values: QueryValues = {};
    const durationPlaceholders = durations.map((duration, index) => {
      const key = `duration${index}`;
      values[key] = duration;
      return `$${key}`;
    });
    const clauses = [powerSportClause('sport', request, values), `duration_s IN (${durationPlaceholders.join(', ')})`, ...addDateRange('started_at_utc', request, values)];
    if (sourceQuality !== 'all') clauses.push("source_type = 'garmin_fit_derived'");
    const rows = await this.repository.rows<PowerCurveRow>(`
      WITH ranked AS (
        SELECT cast(date_trunc('month', started_at_utc) AS VARCHAR) AS month, duration_s, best_power_w,
          activity_id, activity_source_id, cast(started_at_utc AS VARCHAR) AS started_at_utc, sport, source_type, raw_object_hash,
          row_number() OVER (
            PARTITION BY date_trunc('month', started_at_utc), duration_s
            ORDER BY best_power_w DESC, started_at_utc ASC, activity_source_id ASC
          ) AS source_rank
        FROM power_best_facts
        WHERE ${clauses.join(' AND ')}
      )
      SELECT * EXCLUDE (source_rank) FROM ranked WHERE source_rank = 1
      ORDER BY month ASC, duration_s ASC
    `, values);
    return {
      data: rows.map((row) => ({ ...row, durationLabel: durationLabel(row.duration_s) })),
      provenance: { dataset: 'power_best_facts', sourceQuality },
      query: { ...request, durations, sourceQuality, aggregation: 'monthly maximum per duration' },
      caveats: [
        'Values are duration-labelled Garmin FIT-derived power bests; each month/duration row identifies its supporting activity.',
        ...(rows.length === 0 ? ['No normalized power-best observations matched the requested durations and range.'] : []),
      ],
    };
  }

  async powerCoverageReport(request: PowerCoverageReportRequest = {}): Promise<Record<string, unknown>> {
    const sourceQuality = request.sourceQuality ?? 'garmin_fit_derived';
    const values: QueryValues = {};
    const activityClauses = [powerSportClause('activity.sport', request, values), ...addDateRange('activity.started_at_utc', request, values)];
    const bestClause = sourceQuality === 'garmin_fit_derived' ? "WHERE best.source_type = 'garmin_fit_derived'" : '';
    const scoped = `
      WITH source_activities AS (
        SELECT source.activity_source_id, activity.started_at_utc, activity.sport
        FROM activity_sources AS source
        JOIN activities AS activity USING (activity_id)
        WHERE ${activityClauses.join(' AND ')}
      ), scoped_bests AS (
        SELECT best.activity_source_id, best.duration_s, best.best_power_w, best.source_type
        FROM activity_power_bests AS best
        JOIN source_activities USING (activity_source_id)
        ${bestClause}
      )
    `;
    const [activityCoverage, durationInventory] = await Promise.all([
      this.repository.rows<{
        sport: string;
        activities: number;
        powered_activities: number;
        datapoints: number;
        first_activity_at: string | null;
        last_activity_at: string | null;
      }>(`${scoped}
        SELECT sport, count(DISTINCT source_activities.activity_source_id)::INTEGER AS activities,
          count(DISTINCT scoped_bests.activity_source_id)::INTEGER AS powered_activities,
          count(scoped_bests.duration_s)::INTEGER AS datapoints,
          cast(min(started_at_utc) AS VARCHAR) AS first_activity_at,
          cast(max(started_at_utc) AS VARCHAR) AS last_activity_at
        FROM source_activities
        LEFT JOIN scoped_bests USING (activity_source_id)
        GROUP BY sport
        ORDER BY sport`, values),
      this.repository.rows<{
        duration_s: number;
        datapoints: number;
        activities: number;
        min_power_w: number;
        max_power_w: number;
      }>(`${scoped}
        SELECT duration_s, count(*)::INTEGER AS datapoints,
          count(DISTINCT activity_source_id)::INTEGER AS activities,
          min(best_power_w) AS min_power_w, max(best_power_w) AS max_power_w
        FROM scoped_bests
        GROUP BY duration_s
        ORDER BY duration_s`, values),
    ]);
    return {
      data: { activityCoverage, durationInventory: durationInventory.map((row) => ({ ...row, durationLabel: durationLabel(row.duration_s) })) },
      provenance: { activityDataset: 'activities', powerDataset: 'power_best_facts', sourceQuality },
      query: { ...request, sourceQuality },
      caveats: [
        'Coverage is based on FIT-derived per-activity duration bests, never sparse activity-summary average power.',
        'Short-duration maxima can include sensor spikes; inspect the supporting activity stream before treating an extreme as physiological.',
        'Raw activity samples remain scoped to one activity source at a time and may paginate.',
      ],
    };
  }

  async latestCyclingActivities(request: LatestCyclingActivitiesRequest = {}): Promise<Record<string, unknown>> {
    const limit = Math.min(Math.max(request.limit ?? 20, 1), 100);
    const values: QueryValues = { includeMultisport: request.includeMultisport ?? false, limit };
    const sportClause = cyclingSportClause('activity.sport', 'cycling', values);
    const clauses = [`(${sportClause} OR ($includeMultisport AND lower(activity.sport) = 'multi_sport'))`, ...addDateRange('activity.started_at_utc', request, values)];
    const rows = await this.repository.rows<CyclingActivityRow>(`
      SELECT source.activity_id, source.activity_source_id, source.remote_activity_id,
        cast(activity.started_at_utc AS VARCHAR) AS started_at_utc, activity.sport, activity.name, activity.link_state,
        raw.parent_remote_id, summary.distance_m, summary.moving_s, summary.elapsed_s, summary.elevation_gain_m,
        summary.avg_hr, summary.avg_power, summary.training_load, manifest.row_count AS stream_rows, source.raw_object_hash
      FROM activity_sources AS source
      JOIN activities AS activity USING (activity_id)
      LEFT JOIN activity_summaries AS summary USING (activity_source_id)
      LEFT JOIN source_entities AS raw ON raw.provider = source.provider AND raw.entity_type = 'activity' AND raw.remote_id = source.remote_activity_id
      LEFT JOIN stream_manifest AS manifest ON manifest.provider = source.provider AND manifest.activity_source_id = source.activity_source_id
      WHERE source.provider = 'garmin' AND ${clauses.join(' AND ')}
      ORDER BY activity.started_at_utc DESC, source.activity_source_id ASC
      LIMIT $limit
    `, values);
    return {
      data: rows.map((row) => ({
        ...row,
        isMultisportParent: row.sport.toLowerCase() === 'multi_sport',
        parentActivityRemoteId: row.parent_remote_id,
        streamAvailable: Number(row.stream_rows ?? 0) > 0,
      })),
      provenance: { relations: ['activities', 'activity_sources', 'activity_summaries', 'source_entities', 'stream_manifest'], provider: 'garmin' },
      query: { ...request, includeMultisport: request.includeMultisport ?? false, limit },
      caveats: [
        'The projection uses Garmin source records only, avoiding duplicate Intervals summaries for the same linked activity.',
        ...(request.includeMultisport ? ['Multisport parent summaries are flagged and are not represented as cycling-only component metrics.'] : []),
      ],
    };
  }

  async cyclingProgressReport(request: FitnessDateRange = {}): Promise<Record<string, unknown>> {
    const values: QueryValues = {};
    const clauses = [cyclingSportClause('sport', 'cycling', values), ...addDateRange('started_at_utc', request, values)];
    const [ftp, vo2max, powerCurve, monthlyVolume] = await Promise.all([
      this.ftpHistory({ ...request, sport: 'cycling' }),
      this.vo2MaxHistory({ ...request, sport: 'cycling' }),
      this.powerCurveTrend({ ...request, sport: 'cycling' }),
      this.repository.rows(`
        SELECT cast(date_trunc('month', started_at_utc) AS VARCHAR) AS month,
          count(*)::INTEGER AS activities, sum(distance_m) AS distance_m, sum(moving_s) AS moving_s,
          sum(training_load) AS training_load
        FROM canonical_activity_training
        WHERE ${clauses.join(' AND ')}
        GROUP BY date_trunc('month', started_at_utc)
        ORDER BY month ASC
      `, values),
    ]);
    return {
      data: { ftp, vo2max, powerCurve, monthlyVolume },
      provenance: { relations: ['training_metric_observations', 'power_best_facts', 'canonical_activity_training'] },
      query: request,
      caveats: [
        'This is a descriptive, source-aware report—not a physiological performance model.',
        'FTP settings, VO₂max snapshots, volume/load, and power bests retain their individual provenance in the nested results.',
      ],
    };
  }

  async readinessBaseline(request: ReadinessBaselineRequest = {}): Promise<Record<string, unknown>> {
    const sport = request.sport ?? 'running';
    const isRunning = /run/i.test(sport);
    const values: QueryValues = { sport };
    const metricClauses = [
      `metric_name IN ('running_lactate_threshold_pace_s_per_km','running_lactate_threshold_power_w','running_lactate_threshold_hr_bpm','running_lactate_threshold_power_w_kg','race_prediction_time5_k','race_prediction_time10_k','race_prediction_time_half_marathon','race_prediction_time_marathon','training_status_fitness_trend','endurance_score_overall_score')`,
      `(lower(sport) = lower($sport) OR lower(sport) = 'generic')`,
      ...addDateRange('observed_at', request, values),
    ];
    const observations = await this.repository.rows<MetricRow & { metric_name: string }>(`
      SELECT observation_id, cast(observed_at AS VARCHAR) AS observed_at, value_number, value_text, unit, sport,
        source_type, source_remote_id, activity_source_id, raw_object_hash, metric_name
      FROM training_metric_observations
      WHERE ${metricClauses.join(' AND ')}
      ORDER BY observed_at DESC, observation_id DESC
    `, values);
    const [vo2max, powerCurve, powerCoverage] = await Promise.all([
      this.vo2MaxHistory({ ...request, sport }),
      this.powerCurveTrend({ ...request, sportFamily: isRunning ? 'running' : 'cycling' }),
      this.powerCoverageReport({ ...request, sportFamily: isRunning ? 'running' : 'cycling' }),
    ]);
    const byMetric = new Map<string, Array<MetricRow & { metric_name: string }>>();
    for (const row of observations) {
      const arr = byMetric.get(row.metric_name) ?? [];
      arr.push(row);
      byMetric.set(row.metric_name, arr);
    }
    const latest = (name: string): (MetricRow & { metric_name: string }) | null => byMetric.get(name)?.[0] ?? null;
    const series = (name: string): Array<MetricRow & { metric_name: string }> => byMetric.get(name) ?? [];
    return {
      data: {
        sport,
        lactateThreshold: {
          pace_s_per_km: latest('running_lactate_threshold_pace_s_per_km'),
          power_w: latest('running_lactate_threshold_power_w'),
          hr_bpm: latest('running_lactate_threshold_hr_bpm'),
          power_w_kg: latest('running_lactate_threshold_power_w_kg'),
          powerSeries: series('running_lactate_threshold_power_w'),
        },
        vo2max,
        racePrediction: {
          time5_k: latest('race_prediction_time5_k'),
          time10_k: latest('race_prediction_time10_k'),
          timeHalfMarathon: latest('race_prediction_time_half_marathon'),
          timeMarathon: latest('race_prediction_time_marathon'),
        },
        fitnessTrend: latest('training_status_fitness_trend'),
        enduranceScore: latest('endurance_score_overall_score'),
        powerCurve,
        powerCoverage,
      },
      provenance: { dataset: 'training_metric_observations', powerDataset: 'power_best_facts' },
      query: request,
      caveats: [
        'Readiness baseline is descriptive, not a physiological performance model; it combines lactate threshold, VO₂max, race prediction, fitness trend, and FIT-derived power.',
        'Running power uses Garmin FIT-derived power bests (power_best_facts), not sparse activity-summary average power; a NULL summary avg_power does not mean no power.',
        'Course/elevation profile for a specific race is not included here; resolve the event courseId separately before reusing any prior course profile.',
      ],
    };
  }
}
