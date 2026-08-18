import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CatencePaths } from '../../contracts/runtime.js';
import { SYNC_STAGES, type SyncProgressSnapshot, type SyncProgressState } from '../../contracts/progress.js';
import type { QueryValues, ReadDataStore } from '../../contracts/storage.js';
import { sqlString } from './sql.js';
import { DATASET_CATALOG, getDataset, type DatasetDefinition } from './catalog.js';

export class ReadOnlyRepository {
  constructor(readonly database: ReadDataStore, readonly paths: CatencePaths) {}

  async close(): Promise<void> {
    await this.database.close();
  }

  async rows<T extends Record<string, unknown>>(sql: string, values?: QueryValues): Promise<T[]> {
    return this.database.rows<T>(sql, values);
  }

  async datasetRelation(datasetName: string): Promise<string> {
    const dataset = getDataset(datasetName);
    if (!dataset.samplesOnly) return dataset.relation!;
    return this.activitySampleRelation();
  }

  async activitySampleRelation(): Promise<string> {
    const manifests = await this.rows<{ relative_path: string }>(`
      SELECT relative_path
      FROM stream_manifest
      QUALIFY row_number() OVER (PARTITION BY provider, activity_source_id ORDER BY content_hash DESC) = 1
    `);
    const hasReadableRegisteredStream = manifests.some((manifest) => {
      const candidate = path.resolve(this.paths.root, manifest.relative_path);
      const expectedRoot = `${path.resolve(this.paths.lake)}${path.sep}`;
      return candidate.startsWith(expectedRoot) && candidate.endsWith('.parquet') && existsSync(candidate);
    });
    if (hasReadableRegisteredStream) {
      // A UNION ALL branch for every stream reaches DuckDB's expression-depth
      // limit around 1,000 activities. The glob is internal and rooted at the
      // configured lake; the manifest join remains the authoritative allowlist
      // and supplies stable provider/content-hash provenance.
      const lakeGlob = path.join(this.paths.lake, '**', '*.parquet');
      return `
        SELECT manifest.provider AS provider,
          manifest.content_hash AS content_hash,
          sample.activity_source_id,
          try_cast(sample.timestamp_utc AS TIMESTAMPTZ) AS timestamp_utc,
          try_cast(sample.elapsed_s AS DOUBLE) AS elapsed_s,
          try_cast(sample.distance_m AS DOUBLE) AS distance_m,
          try_cast(sample.latitude AS DOUBLE) AS latitude,
          try_cast(sample.longitude AS DOUBLE) AS longitude,
          try_cast(sample.altitude_m AS DOUBLE) AS altitude_m,
          try_cast(sample.heart_rate_bpm AS DOUBLE) AS heart_rate_bpm,
          try_cast(sample.power_w AS DOUBLE) AS power_w,
          try_cast(sample.cadence_rpm AS DOUBLE) AS cadence_rpm,
          try_cast(sample.speed_mps AS DOUBLE) AS speed_mps,
          try_cast(sample.temperature_c AS DOUBLE) AS temperature_c,
          try_cast(sample.grade_pct AS DOUBLE) AS grade_pct,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.leftRightBalance'), json_extract_string(sample.extras_json, '$.left_right_balance')) AS DOUBLE) AS left_right_balance_pct,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.leftTorqueEffectiveness'), json_extract_string(sample.extras_json, '$.left_torque_effectiveness')) AS DOUBLE) AS left_torque_effectiveness_pct,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.rightTorqueEffectiveness'), json_extract_string(sample.extras_json, '$.right_torque_effectiveness')) AS DOUBLE) AS right_torque_effectiveness_pct,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.leftPedalSmoothness'), json_extract_string(sample.extras_json, '$.left_pedal_smoothness')) AS DOUBLE) AS left_pedal_smoothness_pct,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.rightPedalSmoothness'), json_extract_string(sample.extras_json, '$.right_pedal_smoothness')) AS DOUBLE) AS right_pedal_smoothness_pct,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.leftPowerPhase[0]'), json_extract_string(sample.extras_json, '$.left_power_phase[0]')) AS DOUBLE) AS left_power_phase_start_deg,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.leftPowerPhase[1]'), json_extract_string(sample.extras_json, '$.left_power_phase[1]')) AS DOUBLE) AS left_power_phase_end_deg,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.rightPowerPhase[0]'), json_extract_string(sample.extras_json, '$.right_power_phase[0]')) AS DOUBLE) AS right_power_phase_start_deg,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.rightPowerPhase[1]'), json_extract_string(sample.extras_json, '$.right_power_phase[1]')) AS DOUBLE) AS right_power_phase_end_deg,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.leftPowerPhasePeak[0]'), json_extract_string(sample.extras_json, '$.left_power_phase_peak[0]')) AS DOUBLE) AS left_power_phase_peak_start_deg,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.leftPowerPhasePeak[1]'), json_extract_string(sample.extras_json, '$.left_power_phase_peak[1]')) AS DOUBLE) AS left_power_phase_peak_end_deg,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.rightPowerPhasePeak[0]'), json_extract_string(sample.extras_json, '$.right_power_phase_peak[0]')) AS DOUBLE) AS right_power_phase_peak_start_deg,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.rightPowerPhasePeak[1]'), json_extract_string(sample.extras_json, '$.right_power_phase_peak[1]')) AS DOUBLE) AS right_power_phase_peak_end_deg,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.leftPlatformCenterOffset'), json_extract_string(sample.extras_json, '$.left_pco')) AS DOUBLE) AS left_platform_center_offset_mm,
          try_cast(coalesce(json_extract_string(sample.extras_json, '$.rightPlatformCenterOffset'), json_extract_string(sample.extras_json, '$.right_pco')) AS DOUBLE) AS right_platform_center_offset_mm,
          try_cast(sample.extras_json AS JSON) AS extras_json
        FROM read_parquet(${sqlString(lakeGlob)}, union_by_name = true) AS sample
        JOIN (
          SELECT provider, activity_source_id, content_hash
          FROM stream_manifest
          QUALIFY row_number() OVER (PARTITION BY provider, activity_source_id ORDER BY content_hash DESC) = 1
        ) AS manifest USING (activity_source_id)
      `;
    }
    return `SELECT
      CAST(NULL AS VARCHAR) AS provider,
      CAST(NULL AS VARCHAR) AS content_hash,
      CAST(NULL AS VARCHAR) AS activity_source_id,
      CAST(NULL AS TIMESTAMPTZ) AS timestamp_utc,
      CAST(NULL AS DOUBLE) AS elapsed_s,
      CAST(NULL AS DOUBLE) AS distance_m,
      CAST(NULL AS DOUBLE) AS latitude,
      CAST(NULL AS DOUBLE) AS longitude,
      CAST(NULL AS DOUBLE) AS altitude_m,
      CAST(NULL AS DOUBLE) AS heart_rate_bpm,
      CAST(NULL AS DOUBLE) AS power_w,
      CAST(NULL AS DOUBLE) AS cadence_rpm,
      CAST(NULL AS DOUBLE) AS speed_mps,
      CAST(NULL AS DOUBLE) AS temperature_c,
      CAST(NULL AS DOUBLE) AS grade_pct,
      CAST(NULL AS DOUBLE) AS left_right_balance_pct,
      CAST(NULL AS DOUBLE) AS left_torque_effectiveness_pct,
      CAST(NULL AS DOUBLE) AS right_torque_effectiveness_pct,
      CAST(NULL AS DOUBLE) AS left_pedal_smoothness_pct,
      CAST(NULL AS DOUBLE) AS right_pedal_smoothness_pct,
      CAST(NULL AS DOUBLE) AS left_power_phase_start_deg,
      CAST(NULL AS DOUBLE) AS left_power_phase_end_deg,
      CAST(NULL AS DOUBLE) AS right_power_phase_start_deg,
      CAST(NULL AS DOUBLE) AS right_power_phase_end_deg,
      CAST(NULL AS DOUBLE) AS left_power_phase_peak_start_deg,
      CAST(NULL AS DOUBLE) AS left_power_phase_peak_end_deg,
      CAST(NULL AS DOUBLE) AS right_power_phase_peak_start_deg,
      CAST(NULL AS DOUBLE) AS right_power_phase_peak_end_deg,
      CAST(NULL AS DOUBLE) AS left_platform_center_offset_mm,
      CAST(NULL AS DOUBLE) AS right_platform_center_offset_mm,
      CAST(NULL AS JSON) AS extras_json
      WHERE FALSE`;
  }

  async status(): Promise<Record<string, unknown>> {
    // @duckdb/node-api shares native statement state on a connection. These
    // small status reads must remain sequential; concurrent calls can hang a
    // read-only dashboard request before it writes its response.
    const runs = await this.rows(`SELECT run_id, provider, cast(from_date AS VARCHAR) AS from_date, cast(started_at AS VARCHAR) AS started_at, cast(completed_at AS VARCHAR) AS completed_at, status, error_count FROM sync_runs ORDER BY started_at DESC LIMIT 20`);
    const counts = await this.rows(`SELECT
        (SELECT count(*)::INTEGER FROM activities) AS activities,
        (SELECT count(*)::INTEGER FROM activity_sources) AS activity_sources,
        (SELECT count(*)::INTEGER FROM daily_metrics) AS daily_metrics,
        (SELECT count(*)::INTEGER FROM nutrition_items) AS nutrition_items,
        (SELECT count(*)::INTEGER FROM source_entities) AS source_entities,
        (SELECT count(*)::INTEGER FROM retrieval_documents) AS retrieval_documents`);
    const errors = await this.rows(`SELECT count(*)::INTEGER AS unresolved FROM normalization_errors WHERE resolved_at IS NULL`);
    const streamCoverage = await this.rows(`SELECT count(*)::INTEGER AS streams, coalesce(sum(row_count), 0)::BIGINT AS sample_rows, min(start_at) AS starts_at, max(end_at) AS ends_at FROM stream_manifest`);
    const indexState = await this.rows(`SELECT status, mode, source_watermark, cast(built_at AS VARCHAR) AS built_at FROM retrieval_index_state WHERE index_name = 'context'`);
    const cursors = await this.rows(`SELECT provider, cursor_name, cast(covered_through_date AS VARCHAR) AS covered_through_date, cast(latest_source_date AS VARCHAR) AS latest_source_date, lookback_days, cast(last_completed_at AS VARCHAR) AS last_completed_at, status FROM sync_cursors ORDER BY provider, cursor_name`);
    return {
      syncRuns: runs,
      entityCounts: counts[0] ?? {},
      unresolvedExtractionErrors: errors[0]?.unresolved ?? 0,
      streams: streamCoverage[0] ?? { streams: 0, sample_rows: 0 },
      retrievalIndex: indexState[0] ?? { status: 'stale', mode: 'keyword' },
      incrementalCursors: cursors,
    };
  }

  async progress(): Promise<SyncProgressSnapshot> {
    // Same sequential-read discipline as status(): the shared native
    // connection must not run these small reads concurrently.
    const running = await this.rows<ProgressRow>(`
      SELECT runs.run_id, runs.provider, coalesce(progress.stage, 'starting') AS stage,
        progress.current_step,
        coalesce(progress.completed_units, 0) AS completed_units,
        progress.total_units,
        coalesce(progress.percent, 0) AS percent,
        coalesce(progress.elapsed_seconds, 0) AS elapsed_seconds,
        progress.estimated_remaining_seconds,
        cast(coalesce(progress.heartbeat_at, runs.started_at) AS VARCHAR) AS heartbeat_at
      FROM sync_runs AS runs
      LEFT JOIN sync_run_progress AS progress USING (run_id)
      WHERE runs.status = 'running'
      ORDER BY runs.started_at DESC
    `);
    const recent = await this.rows<ProgressRow>(`
      SELECT run_id, provider, stage, current_step, completed_units, total_units, percent,
        elapsed_seconds, estimated_remaining_seconds,
        cast(heartbeat_at AS VARCHAR) AS heartbeat_at
      FROM sync_run_progress
      ORDER BY heartbeat_at DESC
      LIMIT 10
    `);
    return { running: running.map(toSyncProgressState), recent: recent.map(toSyncProgressState) };
  }

  async coverage(): Promise<Record<string, unknown>> {
    const rows = await this.rows(`
      SELECT 'activities' AS dataset, min(cast(started_at_utc AS DATE)) AS start_date, max(cast(started_at_utc AS DATE)) AS end_date, count(*)::INTEGER AS row_count FROM activities
      UNION ALL SELECT 'daily_metrics', min(metric_date), max(metric_date), count(*)::INTEGER FROM daily_metrics
      UNION ALL SELECT 'training_metric_observations', min(cast(observed_at AS DATE)), max(cast(observed_at AS DATE)), count(*)::INTEGER FROM training_metric_observations
      UNION ALL SELECT 'nutrition_days', min(nutrition_date), max(nutrition_date), count(*)::INTEGER FROM nutrition_days
      UNION ALL SELECT 'source_entities', min(occurred_on), max(occurred_on), count(*)::INTEGER FROM source_entities
    `);
    return { coverage: rows, providers: await this.rows(`SELECT provider, count(*)::INTEGER AS activity_sources FROM activity_sources GROUP BY provider ORDER BY provider`) };
  }

  async activity(activityId: string): Promise<Record<string, unknown> | null> {
    const activity = await this.rows<Record<string, unknown>>(`SELECT * FROM activities WHERE activity_id = $activityId`, { activityId });
    if (!activity[0]) return null;
    const sources = await this.rows(`SELECT * FROM activity_sources WHERE activity_id = $activityId ORDER BY CASE provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END, provider`, { activityId });
    const summaries = await this.rows(`SELECT * FROM activity_summary_facts WHERE activity_id = $activityId ORDER BY CASE provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END, provider`, { activityId });
    const intervals = await this.rows(`SELECT * FROM activity_interval_facts WHERE activity_id = $activityId ORDER BY CASE provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END, provider, start_s`, { activityId });
    return { activity: activity[0], sources, summaries, intervals };
  }

  async summary(startDate: string, endDate: string): Promise<Record<string, unknown>> {
    const training = await this.rows(`SELECT cast(started_at_utc AS DATE) AS date, count(*)::INTEGER AS activities, sum(distance_m) AS distance_m, sum(moving_s) AS moving_s, sum(training_load) AS training_load FROM canonical_activity_training WHERE cast(started_at_utc AS DATE) BETWEEN cast($startDate AS DATE) AND cast($endDate AS DATE) GROUP BY 1 ORDER BY 1`, { startDate, endDate });
    const health = await this.rows(`SELECT * FROM daily_health WHERE metric_date BETWEEN cast($startDate AS DATE) AND cast($endDate AS DATE) ORDER BY metric_date, provider`, { startDate, endDate });
    const nutrition = await this.rows(`SELECT * FROM nutrition_days WHERE nutrition_date BETWEEN cast($startDate AS DATE) AND cast($endDate AS DATE) ORDER BY nutrition_date, provider`, { startDate, endDate });
    return { training, health, nutrition };
  }

  catalog(): DatasetDefinition[] {
    return Object.values(DATASET_CATALOG);
  }
}

interface ProgressRow extends Record<string, unknown> {
  run_id: string;
  provider: string;
  stage: string;
  current_step: string | null;
  completed_units: number;
  total_units: number | null;
  percent: number;
  elapsed_seconds: number;
  estimated_remaining_seconds: number | null;
  heartbeat_at: string;
}

function toSyncProgressState(row: ProgressRow): SyncProgressState {
  return {
    runId: row.run_id,
    provider: row.provider,
    stage: SYNC_STAGES.includes(row.stage as (typeof SYNC_STAGES)[number]) ? (row.stage as SyncProgressState['stage']) : 'starting',
    currentStep: row.current_step,
    completedUnits: Math.max(0, Number(row.completed_units) || 0),
    totalUnits: row.total_units === null || row.total_units === undefined ? null : Math.max(0, Number(row.total_units) || 0),
    percentComplete: Math.min(100, Math.max(0, Number(row.percent) || 0)),
    elapsedSeconds: Math.max(0, Number(row.elapsed_seconds) || 0),
    estimatedRemainingSeconds: row.estimated_remaining_seconds === null || row.estimated_remaining_seconds === undefined ? null : Math.max(0, Number(row.estimated_remaining_seconds) || 0),
    heartbeatAt: row.heartbeat_at,
  };
}

/** Converts DuckDB's Date/BigInt values into MCP-safe JSON values. */
export function jsonSafe<T>(value: T): T {
  if (typeof value === 'bigint') return String(value) as T;
  if (value instanceof Date) return value.toISOString() as T;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)])) as T;
  }
  return value;
}
