import { migrations as baseMigrations, type Migration } from './migrations.legacy.js';

const stravaAndIdentityMigration: Migration = {
  version: 6,
  name: 'strava_enrichment_and_activity_links',
  sql: `
    CREATE TABLE IF NOT EXISTS activity_links (
      activity_source_id VARCHAR PRIMARY KEY,
      activity_id VARCHAR NOT NULL,
      method VARCHAR NOT NULL,
      confidence DOUBLE,
      evidence_json JSON NOT NULL DEFAULT '{}',
      linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO activity_links (activity_source_id, activity_id, method, confidence, evidence_json)
    SELECT activity_source_id, activity_id,
      CASE WHEN external_id IS NOT NULL THEN 'strong_external_id' ELSE 'source' END,
      CASE WHEN external_id IS NOT NULL THEN 1.0 ELSE NULL END,
      '{}'
    FROM activity_sources
    ON CONFLICT (activity_source_id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS strava_enrichment_state (
      resource_type VARCHAR NOT NULL,
      remote_id VARCHAR NOT NULL,
      status VARCHAR NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      continuation_page INTEGER,
      detail_json JSON NOT NULL DEFAULT '{}',
      PRIMARY KEY (resource_type, remote_id)
    );
    CREATE TABLE IF NOT EXISTS strava_rate_state (
      account_id VARCHAR PRIMARY KEY,
      read_limit_15m INTEGER,
      read_usage_15m INTEGER,
      read_limit_day INTEGER,
      read_usage_day INTEGER,
      blocked_until TIMESTAMPTZ,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS strava_segments (
      segment_id VARCHAR PRIMARY KEY,
      name VARCHAR,
      activity_type VARCHAR,
      distance_m DOUBLE,
      average_grade_pct DOUBLE,
      maximum_grade_pct DOUBLE,
      climb_category INTEGER,
      elevation_high_m DOUBLE,
      elevation_low_m DOUBLE,
      total_elevation_gain_m DOUBLE,
      private BOOLEAN,
      hazardous BOOLEAN,
      starred BOOLEAN,
      raw_object_hash VARCHAR,
      payload_json JSON NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS activity_segments (
      activity_source_id VARCHAR NOT NULL,
      effort_id VARCHAR NOT NULL,
      segment_id VARCHAR NOT NULL,
      elapsed_s DOUBLE,
      moving_s DOUBLE,
      distance_m DOUBLE,
      average_watts DOUBLE,
      average_hr DOUBLE,
      max_hr DOUBLE,
      average_cadence DOUBLE,
      device_watts BOOLEAN,
      pr_rank INTEGER,
      kom_rank INTEGER,
      started_at TIMESTAMPTZ,
      raw_object_hash VARCHAR,
      payload_json JSON NOT NULL,
      PRIMARY KEY (activity_source_id, effort_id)
    );
    CREATE INDEX IF NOT EXISTS activity_segments_segment_idx ON activity_segments (segment_id);
    CREATE TABLE IF NOT EXISTS strava_segment_efforts (
      effort_id VARCHAR PRIMARY KEY,
      segment_id VARCHAR NOT NULL,
      strava_activity_id VARCHAR,
      elapsed_s DOUBLE,
      moving_s DOUBLE,
      distance_m DOUBLE,
      average_watts DOUBLE,
      average_hr DOUBLE,
      max_hr DOUBLE,
      average_cadence DOUBLE,
      device_watts BOOLEAN,
      pr_rank INTEGER,
      kom_rank INTEGER,
      started_at TIMESTAMPTZ,
      raw_object_hash VARCHAR,
      payload_json JSON NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS strava_segment_efforts_segment_idx ON strava_segment_efforts (segment_id, started_at);

    CREATE OR REPLACE VIEW canonical_activity_training AS
    WITH ranked AS (
      SELECT a.*, source.activity_source_id, source.provider, source.remote_activity_id, source.raw_object_hash,
        summary.*, row_number() OVER (
          PARTITION BY a.activity_id
          ORDER BY CASE source.provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END
        ) AS source_rank
      FROM activities a
      JOIN activity_sources source USING (activity_id)
      LEFT JOIN activity_summaries summary USING (activity_source_id)
    ), intervals_analysis AS (
      SELECT source.activity_id,
        max(summary.training_load) AS intervals_training_load,
        max(summary.rpe) AS intervals_rpe,
        max(summary.feel) AS intervals_feel,
        max(summary.weighted_power) AS intervals_weighted_power
      FROM activity_sources source
      JOIN activity_summaries summary USING (activity_source_id)
      WHERE source.provider = 'intervals'
      GROUP BY source.activity_id
    )
    SELECT ranked.* EXCLUDE (source_rank),
      intervals_analysis.intervals_training_load,
      intervals_analysis.intervals_rpe,
      intervals_analysis.intervals_feel,
      intervals_analysis.intervals_weighted_power
    FROM ranked
    LEFT JOIN intervals_analysis USING (activity_id)
    WHERE source_rank = 1;

    CREATE OR REPLACE VIEW segment_effort_history AS
    SELECT effort.*, segment.name AS segment_name, segment.average_grade_pct, segment.climb_category,
      CASE WHEN effort.elapsed_s > 0 AND effort.distance_m IS NOT NULL THEN effort.distance_m / effort.elapsed_s ELSE NULL END AS average_speed_mps,
      segment.raw_object_hash AS segment_raw_object_hash
    FROM strava_segment_efforts effort
    LEFT JOIN strava_segments segment USING (segment_id);
    CREATE OR REPLACE VIEW strava_gear AS
    SELECT provider, remote_id AS gear_id, payload_json, extension_json, raw_object_hash
    FROM domain_entities WHERE provider = 'strava' AND entity_type = 'gear';
  `,
};

const garminPrimaryAndTrainingMetricsMigration: Migration = {
  version: 7,
  name: 'garmin_primary_activity_links_and_training_metric_history',
  sql: `
    CREATE TABLE IF NOT EXISTS training_metric_observations (
      observation_id VARCHAR PRIMARY KEY,
      provider VARCHAR NOT NULL,
      metric_name VARCHAR NOT NULL,
      sport VARCHAR NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      value_number DOUBLE NOT NULL,
      source_type VARCHAR NOT NULL,
      source_remote_id VARCHAR NOT NULL,
      activity_source_id VARCHAR,
      raw_object_hash VARCHAR
    );
    CREATE INDEX IF NOT EXISTS training_metric_observations_metric_idx
      ON training_metric_observations (provider, metric_name, sport, observed_at);

    -- Intervals preserves the originating Garmin activity ID as external_id.
    -- Attach it to the actual Garmin source so the canonical view selects Garmin
    -- while retaining Intervals' separately named analysis values.
    UPDATE activity_sources AS intervals
    SET activity_id = garmin.activity_id
    FROM activity_sources AS garmin
    WHERE intervals.provider = 'intervals'
      AND garmin.provider = 'garmin'
      AND intervals.external_id = garmin.remote_activity_id
      AND NOT EXISTS (
        SELECT 1 FROM activity_links link
        WHERE link.activity_source_id = intervals.activity_source_id
          AND link.method = 'manual'
      );

    INSERT INTO activity_links (activity_source_id, activity_id, method, confidence, evidence_json)
    SELECT intervals.activity_source_id, garmin.activity_id, 'strong_external_id', 1.0,
      json_object('matchedActivitySourceId', garmin.activity_source_id, 'externalId', intervals.external_id)
    FROM activity_sources AS intervals
    JOIN activity_sources AS garmin
      ON garmin.provider = 'garmin'
      AND intervals.external_id = garmin.remote_activity_id
    WHERE intervals.provider = 'intervals'
    ON CONFLICT (activity_source_id) DO UPDATE SET
      activity_id = CASE WHEN activity_links.method = 'manual' THEN activity_links.activity_id ELSE excluded.activity_id END,
      method = CASE WHEN activity_links.method = 'manual' THEN activity_links.method ELSE excluded.method END,
      confidence = CASE WHEN activity_links.method = 'manual' THEN activity_links.confidence ELSE excluded.confidence END,
      evidence_json = CASE WHEN activity_links.method = 'manual' THEN activity_links.evidence_json ELSE excluded.evidence_json END,
      linked_at = CASE WHEN activity_links.method = 'manual' THEN activity_links.linked_at ELSE now() END;

    DELETE FROM activities AS activity
    WHERE NOT EXISTS (SELECT 1 FROM activity_sources AS source WHERE source.activity_id = activity.activity_id);

    -- Garmin's cycling activity summary retains the FTP active during that
    -- activity. These observations reconstruct history already present in an
    -- imported store without relying on Intervals' derived configuration.
    INSERT INTO training_metric_observations
      (observation_id, provider, metric_name, sport, observed_at, value_number, source_type, source_remote_id, activity_source_id, raw_object_hash)
    SELECT
      'garmin:cycling_ftp:activity:' || source.remote_activity_id,
      'garmin', 'cycling_ftp_w', coalesce(activity.sport, json_extract_string(summary.metrics_json, '$.activityType.typeKey'), 'cycling'), activity.started_at_utc,
      try_cast(json_extract_string(summary.metrics_json, '$.maxFtp') AS DOUBLE),
      'activity_summary', source.remote_activity_id, source.activity_source_id, source.raw_object_hash
    FROM activity_sources AS source
    JOIN activities AS activity USING (activity_id)
    JOIN activity_summaries AS summary USING (activity_source_id)
    WHERE source.provider = 'garmin'
      AND activity.started_at_utc IS NOT NULL
      AND (lower(coalesce(activity.sport, json_extract_string(summary.metrics_json, '$.activityType.typeKey'), '')) LIKE '%cycl%' OR lower(coalesce(activity.sport, json_extract_string(summary.metrics_json, '$.activityType.typeKey'), '')) LIKE '%ride%')
      AND try_cast(json_extract_string(summary.metrics_json, '$.maxFtp') AS DOUBLE) IS NOT NULL
    ON CONFLICT (observation_id) DO UPDATE SET
      observed_at = excluded.observed_at,
      value_number = excluded.value_number,
      sport = excluded.sport,
      raw_object_hash = excluded.raw_object_hash;

    INSERT INTO training_metric_observations
      (observation_id, provider, metric_name, sport, observed_at, value_number, source_type, source_remote_id, activity_source_id, raw_object_hash)
    SELECT
      'garmin:cycling_ftp:source:' || entity.remote_id,
      'garmin', 'cycling_ftp_w', 'cycling',
      cast(json_extract_string(entity.payload_json, '$.calendarDate') AS TIMESTAMPTZ),
      try_cast(json_extract_string(entity.payload_json, '$.functionalThresholdPower') AS DOUBLE),
      'cycling_ftp', entity.remote_id, NULL, entity.raw_object_hash
    FROM source_entities AS entity
    WHERE entity.provider = 'garmin'
      AND entity.entity_type = 'training_metric'
      AND upper(coalesce(json_extract_string(entity.payload_json, '$.sport'), '')) = 'CYCLING'
      AND json_extract_string(entity.payload_json, '$.calendarDate') IS NOT NULL
      AND try_cast(json_extract_string(entity.payload_json, '$.functionalThresholdPower') AS DOUBLE) IS NOT NULL
    ON CONFLICT (observation_id) DO UPDATE SET
      observed_at = excluded.observed_at,
      value_number = excluded.value_number,
      raw_object_hash = excluded.raw_object_hash;
  `,
};

const garminActivitySportAndFtpBackfillMigration: Migration = {
  version: 8,
  name: 'garmin_activity_sport_and_ftp_history_backfill',
  sql: `
    UPDATE activities AS activity
    SET sport = coalesce(
      json_extract_string(summary.metrics_json, '$.activityType.typeKey'),
      json_extract_string(summary.metrics_json, '$.activityTypeDTO.typeKey')
    )
    FROM activity_sources AS source
    JOIN activity_summaries AS summary USING (activity_source_id)
    WHERE source.provider = 'garmin'
      AND source.activity_id = activity.activity_id
      AND activity.sport IS NULL;

    INSERT INTO training_metric_observations
      (observation_id, provider, metric_name, sport, observed_at, value_number, source_type, source_remote_id, activity_source_id, raw_object_hash)
    SELECT
      'garmin:cycling_ftp:activity:' || source.remote_activity_id,
      'garmin', 'cycling_ftp_w', coalesce(activity.sport, 'cycling'), activity.started_at_utc,
      try_cast(json_extract_string(summary.metrics_json, '$.maxFtp') AS DOUBLE),
      'activity_summary', source.remote_activity_id, source.activity_source_id, source.raw_object_hash
    FROM activity_sources AS source
    JOIN activities AS activity USING (activity_id)
    JOIN activity_summaries AS summary USING (activity_source_id)
    WHERE source.provider = 'garmin'
      AND activity.started_at_utc IS NOT NULL
      AND (lower(coalesce(activity.sport, '')) LIKE '%cycl%' OR lower(coalesce(activity.sport, '')) LIKE '%ride%')
      AND try_cast(json_extract_string(summary.metrics_json, '$.maxFtp') AS DOUBLE) IS NOT NULL
    ON CONFLICT (observation_id) DO UPDATE SET
      observed_at = excluded.observed_at,
      value_number = excluded.value_number,
      sport = excluded.sport,
      raw_object_hash = excluded.raw_object_hash;

    UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context';
  `,
};

const garminPrimaryDailyHealthMigration: Migration = {
  version: 9,
  name: 'garmin_primary_daily_health',
  sql: `
    -- Keep all provider observations in daily_metrics. The user-facing health
    -- projection selects one coherent source per date so Garmin does not get
    -- silently mixed with values that Intervals derived from the same device.
    CREATE OR REPLACE VIEW daily_health AS
    WITH provider_health AS (
      SELECT provider, metric_date,
        max(value_number) FILTER (WHERE metric_name = 'resting_hr_bpm') AS resting_hr_bpm,
        max(value_number) FILTER (WHERE metric_name = 'hrv_ms') AS hrv_ms,
        max(value_number) FILTER (WHERE metric_name = 'sleep_seconds') AS sleep_seconds,
        max(value_number) FILTER (WHERE metric_name = 'sleep_score') AS sleep_score,
        max(value_number) FILTER (WHERE metric_name = 'stress') AS stress,
        max(value_number) FILTER (WHERE metric_name = 'body_battery') AS body_battery,
        max(value_number) FILTER (WHERE metric_name = 'readiness') AS readiness,
        max(value_number) FILTER (WHERE metric_name = 'spo2_pct') AS spo2_pct,
        max(value_number) FILTER (WHERE metric_name = 'weight_kg') AS weight_kg,
        max(value_number) FILTER (WHERE metric_name = 'steps') AS steps
      FROM daily_metrics
      GROUP BY provider, metric_date
    ), ranked AS (
      SELECT provider_health.*,
        row_number() OVER (
          PARTITION BY metric_date
          ORDER BY CASE provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END, provider
        ) AS source_rank
      FROM provider_health
    )
    SELECT * EXCLUDE (source_rank)
    FROM ranked
    WHERE source_rank = 1;
  `,
};

const garminHistoricalMetricsAndStreamsMigration: Migration = {
  version: 10,
  name: 'garmin_historical_metrics_and_detailed_streams',
  sql: `
    DROP INDEX IF EXISTS training_metric_observations_metric_idx;
    ALTER TABLE training_metric_observations ALTER COLUMN value_number DROP NOT NULL;
    ALTER TABLE training_metric_observations ADD COLUMN IF NOT EXISTS value_text VARCHAR;
    ALTER TABLE training_metric_observations ADD COLUMN IF NOT EXISTS unit VARCHAR;
    ALTER TABLE training_metric_observations ADD COLUMN IF NOT EXISTS device_id VARCHAR;
    ALTER TABLE training_metric_observations ADD COLUMN IF NOT EXISTS dimensions_json JSON;

    CREATE TABLE IF NOT EXISTS wellness_samples (
      sample_id VARCHAR PRIMARY KEY,
      provider VARCHAR NOT NULL,
      metric_name VARCHAR NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      value_number DOUBLE NOT NULL,
      unit VARCHAR,
      source_type VARCHAR NOT NULL,
      source_remote_id VARCHAR NOT NULL,
      raw_object_hash VARCHAR
    );
    CREATE INDEX IF NOT EXISTS wellness_samples_metric_idx
      ON wellness_samples (provider, metric_name, observed_at);

    CREATE TABLE IF NOT EXISTS health_sessions (
      session_id VARCHAR PRIMARY KEY,
      provider VARCHAR NOT NULL,
      session_type VARCHAR NOT NULL,
      occurred_on DATE,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      source_type VARCHAR NOT NULL,
      source_remote_id VARCHAR NOT NULL,
      payload_json JSON NOT NULL,
      raw_object_hash VARCHAR
    );
    CREATE INDEX IF NOT EXISTS health_sessions_date_idx
      ON health_sessions (provider, session_type, occurred_on);

    CREATE TABLE IF NOT EXISTS activity_power_bests (
      provider VARCHAR NOT NULL,
      activity_source_id VARCHAR NOT NULL,
      duration_s INTEGER NOT NULL,
      best_power_w DOUBLE NOT NULL,
      source_type VARCHAR NOT NULL,
      raw_object_hash VARCHAR,
      PRIMARY KEY (provider, activity_source_id, duration_s)
    );
    CREATE OR REPLACE VIEW power_best_facts AS
    SELECT best.*, source.activity_id, activity.started_at_utc, activity.sport
    FROM activity_power_bests AS best
    JOIN activity_sources AS source USING (activity_source_id)
    JOIN activities AS activity USING (activity_id);

    UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context';
  `,
  // DuckDB 1.4.4's Node binding can abort when this index rebuild shares the
  // commit transaction with the populated-table ALTERs above. Run it after
  // that durable migration transaction instead; IF NOT EXISTS makes retries
  // safe across subsequent opens.
  postCommitSql: `
    CREATE INDEX IF NOT EXISTS training_metric_observations_metric_idx
      ON training_metric_observations (provider, metric_name, sport, observed_at);
  `,
};

const garminUtcActivityTimestampMigration: Migration = {
  version: 11,
  name: 'garmin_gmt_activity_timestamps_are_utc',
  sql: `
    -- Garmin labels these fields GMT but commonly omits the offset. Without an
    -- explicit Z DuckDB treats them as the host's local time when binding them
    -- to TIMESTAMPTZ, shifting activity matching by the local UTC offset.
    UPDATE activities AS activity
    SET started_at_utc = try_cast(replace(gmt_value, ' ', 'T') || 'Z' AS TIMESTAMPTZ)
    FROM activity_sources AS source
    JOIN source_entities AS entity
      ON entity.provider = source.provider
      AND entity.entity_type = 'activity'
      AND entity.remote_id = source.remote_activity_id
    CROSS JOIN LATERAL (
      SELECT coalesce(
        json_extract_string(entity.payload_json, '$.startTimeGMT'),
        json_extract_string(entity.payload_json, '$.summaryDTO.startTimeGMT')
      ) AS gmt_value
    ) AS timestamp_source
    WHERE source.provider = 'garmin'
      AND source.activity_id = activity.activity_id
      AND gmt_value IS NOT NULL
      AND NOT regexp_matches(gmt_value, '(Z|[+-][0-9]{2}:?[0-9]{2})$');

    UPDATE training_metric_observations AS observation
    SET observed_at = try_cast(replace(gmt_value, ' ', 'T') || 'Z' AS TIMESTAMPTZ)
    FROM source_entities AS entity
    CROSS JOIN LATERAL (
      SELECT coalesce(
        json_extract_string(entity.payload_json, '$.startTimeGMT'),
        json_extract_string(entity.payload_json, '$.summaryDTO.startTimeGMT')
      ) AS gmt_value
    ) AS timestamp_source
    WHERE observation.provider = 'garmin'
      AND observation.source_type = 'activity_summary'
      AND observation.source_remote_id = entity.remote_id
      AND entity.provider = 'garmin'
      AND entity.entity_type = 'activity'
      AND gmt_value IS NOT NULL
      AND NOT regexp_matches(gmt_value, '(Z|[+-][0-9]{2}:?[0-9]{2})$');

    UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context';
  `,
};

export const migrations: Migration[] = [...baseMigrations, stravaAndIdentityMigration, garminPrimaryAndTrainingMetricsMigration, garminActivitySportAndFtpBackfillMigration, garminPrimaryDailyHealthMigration, garminHistoricalMetricsAndStreamsMigration, garminUtcActivityTimestampMigration];
export type { Migration };
